import { setTimeout } from 'node:timers/promises';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { Actor, log } from 'apify';
import { parseScenario, runAgent, judgeAllChecks, maskSecrets, formatCost, formatDuration, runInitPreset, downloadApifyDatasets, initOtel, flushOtel, startScenarioSpan, startTestSpan, startAgentSpan, endAgentSpan, startJudgeSpan, endJudgeSpan, endTestSpan, endScenarioSpan, EMPTY_METRICS, EMPTY_EFFICIENCY, EMPTY_TRAJECTORY } from '@apify-evals/shared';
import type { AgentResult, PresetName, AgentRunResult, JudgeResult } from '@apify-evals/shared';

interface RunnerInput {
    agent?: string;
    model?: string;
    scenario: string;
    systemPrompt?: string;
    maxBudgetUsd?: number;
    maxRetries?: number;
    maxTurns?: number;
    envVariables?: Record<string, string>;
    initPreset?: string;
    initBashScript?: string;
    mcpConfigJson?: Record<string, unknown>;
    judgeModel?: string;
}

await Actor.init();

// Graceful abort: kill running agent subprocess when Actor is stopped
const abortController = new AbortController();
Actor.on('aborting', async () => {
    log.warning('Actor aborting — killing agent subprocess');
    abortController.abort();
    await setTimeout(1000);
    await Actor.exit();
});

const input = await Actor.getInput<RunnerInput>();
if (!input?.scenario) {
    throw new Error('Missing required input: scenario');
}

const { meta, tests, parseWarnings } = parseScenario(input.scenario);
const secrets = input.envVariables ?? {};
const agent = input.agent ?? 'claude-code';
const maxRetries = input.maxRetries ?? 0;
const maxTurns = input.maxTurns ?? 10;

const tracer = initOtel();
const scenarioSpan = startScenarioSpan(tracer, {
    scenarioName: meta.name,
    agent,
    model: input.model ?? 'default',
    testsTotal: tests.length,
});

log.info(`Scenario "${meta.name}": ${tests.length} test(s), abortOnFailure=${meta.abortOnFailure}`);
if (parseWarnings) {
    for (const w of parseWarnings) log.warning(`[parse] ${w}`);
}

// Create isolated workspace so agent cannot modify runner's own files
const workspaceDir = `/tmp/eval-workspace-${randomUUID().slice(0, 8)}`;
mkdirSync(workspaceDir, { recursive: true });
log.info(`Workspace: ${workspaceDir}`);

const preset = (input.initPreset ?? 'none') as PresetName;
const initResult = runInitPreset({
    preset,
    customScript: input.initBashScript,
    mcpConfigJson: input.mcpConfigJson as Record<string, unknown>,
    workDir: workspaceDir,
});

for (const msg of initResult.presetLog) {
    log.info(`[init] ${msg}`);
}

// Auto-detect plugins: if init script placed a .claude-plugin/ in workspace, load it via --plugin-dir
const pluginDirs: string[] = [];
if (existsSync(join(workspaceDir, '.claude-plugin', 'plugin.json'))) {
    pluginDirs.push(workspaceDir);
    log.info(`[init] Plugin detected in workspace: ${workspaceDir}/.claude-plugin/`);
}

const allResults: AgentResult[] = [];
const allEventLines: string[] = [];
const allJudgeLines: string[] = [];

for (let i = 0; i < tests.length; i++) {
    const test = tests[i];
    log.info(`--- Test ${i + 1}/${tests.length}: "${test.test.slice(0, 80)}" ---`);
    const testSpan = startTestSpan(tracer, { testIndex: i, prompt: test.test });

    let judgeResult: JudgeResult = { verdicts: [], overallVerdict: 'fail' };
    let lastRunResult: AgentRunResult | null = null;
    let monitorOutput: string | null = null;
    let attempt = 0;
    let judgeMs = 0;

    let currentWorkDir = workspaceDir;
    let currentPluginDirs = [...pluginDirs];
    let currentMcpConfigPath = initResult.mcpConfigPath;
    let currentStrictMcp = initResult.strictMcpConfig;

    while (attempt <= maxRetries) {
        if (attempt > 0) {
            log.info(`  Retry ${attempt}/${maxRetries} — fresh workspace`);
            currentWorkDir = `/tmp/eval-workspace-${randomUUID().slice(0, 8)}`;
            mkdirSync(currentWorkDir, { recursive: true });
            const retryInit = runInitPreset({
                preset,
                customScript: input.initBashScript,
                mcpConfigJson: input.mcpConfigJson as Record<string, unknown>,
                workDir: currentWorkDir,
            });
            for (const msg of retryInit.presetLog) log.info(`  [retry-init] ${msg}`);
            currentMcpConfigPath = retryInit.mcpConfigPath;
            currentStrictMcp = retryInit.strictMcpConfig;
            currentPluginDirs = [];
            if (existsSync(join(currentWorkDir, '.claude-plugin', 'plugin.json'))) {
                currentPluginDirs.push(currentWorkDir);
                log.info(`  [retry-init] Plugin detected`);
            }
        }
        monitorOutput = null;

        const systemPrompt = input.systemPrompt
            ?? 'You are an AI agent being evaluated. Always respond in English. Follow the instructions precisely.';

        let turnCount = 0;
        let rawLineCount = 0;
        const rawLines: string[] = [];
        const agentSpan = startAgentSpan(tracer, agent);
        const agentPhaseStart = Date.now();
        log.info(`  [phase=agent] start`);
        let resultEventLogged = false;
        const result = await runAgent({
            agent,
            prompt: test.test,
            systemPrompt,
            model: input.model,
            maxTurns,
            maxBudgetUsd: input.maxBudgetUsd,
            env: secrets,
            cwd: currentWorkDir,
            mcpConfigPath: currentMcpConfigPath ?? undefined,
            strictMcpConfig: currentStrictMcp,
            pluginDirs: currentPluginDirs.length > 0 ? currentPluginDirs : undefined,
            abortSignal: abortController.signal,
            onRawLine: (line) => {
                rawLines.push(line);
                Actor.setValue('LIVE-AGENT-LOG', rawLines.join('\n'), { contentType: 'text/plain' }).catch(() => {});
            },
            onEvent: (event) => {
                if (event.type === 'assistant' && event.message?.content) {
                    turnCount++;
                    const tools = event.message.content
                        .filter((c) => c.type === 'tool_use' && c.name)
                        .map((c) => c.name);
                    const hasText = event.message.content.some((c) => c.type === 'text' && c.text?.trim());
                    if (tools.length > 0) {
                        log.info(`    [turn ${turnCount}] ${tools.join(', ')}`);
                    } else if (hasText) {
                        const textLen = event.message.content
                            .filter((c) => c.type === 'text')
                            .reduce((sum, c) => sum + (c.text?.length ?? 0), 0);
                        log.info(`    [turn ${turnCount}] writing (${textLen} chars)`);
                    }
                }
                if (event.type === 'result' && !resultEventLogged) {
                    resultEventLogged = true;
                    const elapsed = Math.round((Date.now() - agentPhaseStart) / 1000);
                    log.info(`  [phase=agent] result event after ${elapsed}s (subtype=${event.subtype ?? '?'}, stop_reason=${event.stop_reason ?? '?'}); waiting for subprocess exit`);
                }
            },
        });
        const agentDur = Math.round((Date.now() - agentPhaseStart) / 1000);
        log.info(`  [phase=agent] end after ${agentDur}s (stopReason=${result.stopReason}, exitCode=${result.exitCode}, signal=${result.signal ?? 'none'})`);
        endAgentSpan(agentSpan, result);
        Actor.setValue('LIVE-AGENT-LOG', rawLines.join('\n'), { contentType: 'text/plain' }).catch(() => {});

        lastRunResult = result;

        for (const event of result.events) {
            allEventLines.push(JSON.stringify(event));
        }

        if (result.aborted) {
            log.warning(`  Test ${i + 1} aborted: budget exceeded`);
            judgeResult = {
                verdicts: [{ checkType: 'error', checkValue: '', verdict: 'fail', evidence: 'Run aborted due to budget limit' }],
                overallVerdict: 'fail',
            };
            break;
        }

        // Only short-circuit Judge when the agent produced no output at all. An exit
        // code error with non-empty agentOutput (e.g. SIGTERM from silence escalation
        // after the report was already written, or budget_exceeded mid-render) is
        // still evaluable — let Judge run and report verdicts. The error is surfaced
        // to the dataset row via `error`/`stopReason` for analytics. See GH#1.
        if (result.error && !result.text.length) {
            log.warning(`  Test ${i + 1} error (no output): ${result.error}`);
            judgeResult = {
                verdicts: [{ checkType: 'error', checkValue: '', verdict: 'fail', evidence: `Agent error: ${result.error}` }],
                overallVerdict: 'fail',
            };
            break;
        }

        if (result.error) {
            log.warning(`  Test ${i + 1} agent error (will still judge ${result.text.length} chars of output): ${result.error}`);
        }
        if (result.shutdownReason) {
            log.warning(`  Test ${i + 1} subprocess shutdownReason=${result.shutdownReason} (judge will still run on captured output)`);
        }

        log.info(`  Agent responded (${result.metrics.numTurns} turns, ${formatCost(result.metrics.totalCostUsd)}, ${formatDuration(result.metrics.durationMs)})`);
        if (result.hungWarnings.length > 0) {
            for (const hw of result.hungWarnings) {
                log.warning(`  ⚠ Hung turn detected: ${hw.silenceSecs}s silence at ${formatDuration(hw.elapsedMs)}`);
            }
        }

        // Write trajectory to workspace so script checkpoints can verify agent behavior
        try {
            const trajectoryData = {
                toolCallSequence: result.trajectory.toolCallSequence,
                commandsExecuted: result.trajectory.commandsExecuted,
                filesCreated: result.trajectory.filesCreated,
                mcpToolsUsed: result.trajectory.mcpToolsUsed,
                toolCallCount: result.trajectory.toolCallCount,
                uniqueToolsUsed: result.trajectory.uniqueToolsUsed,
            };
            writeFileSync(join(currentWorkDir, '.eval-trajectory.json'), JSON.stringify(trajectoryData, null, 2));
        } catch { /* non-critical */ }

        // Download Apify datasets created during agent run so judge can verify data
        const dlStart = Date.now();
        log.info(`  [phase=downloads] start`);
        try {
            const dsResult = downloadApifyDatasets(
                result.events as unknown as Array<Record<string, unknown>>,
                currentWorkDir,
                secrets,
            );
            if (dsResult.downloadedCount > 0) {
                log.info(`  Downloaded ${dsResult.downloadedCount}/${dsResult.datasetIds.length} dataset(s) to eval-datasets/`);
            }
        } catch (err) { log.warning(`  Downloads failed: ${err instanceof Error ? err.message : String(err)}`); }
        log.info(`  [phase=downloads] end after ${Math.round((Date.now() - dlStart) / 1000)}s`);

        // Monitor extraction
        if (test.monitor) {
            try {
                const monitorResult = await runAgent({
                    agent,
                    prompt: test.monitor,
                    systemPrompt: `You were just asked to do a task. Here is what you produced:\n\n${result.text}\n\nNow answer the following monitoring question based on your work above.`,
                    model: input.model,
                    maxTurns: 3,
                    env: secrets,
                });
                if (monitorResult.error) {
                    log.warning(`  Monitor failed: ${monitorResult.error}`);
                } else {
                    monitorOutput = monitorResult.text;
                    log.info(`  Monitor: ${monitorOutput.slice(0, 100)}`);
                }
            } catch (err: unknown) {
                log.warning(`  Monitor error: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        // Judge all checks
        log.info(`  [phase=judge] start`);
        const judgeSpan = startJudgeSpan(tracer);
        const judgeStart = Date.now();
        const judgeLines: string[] = [];
        judgeResult = await judgeAllChecks(result.text, test.checkpoint, {
            env: secrets, workDir: currentWorkDir, judgeModel: input.judgeModel, events: result.events,
            onJudgeRawLine: (line) => {
                judgeLines.push(line);
                Actor.setValue('LIVE-JUDGE-LOG', judgeLines.join('\n'), { contentType: 'text/plain' }).catch(() => {});
            },
        });
        judgeMs = Date.now() - judgeStart;
        log.info(`  [phase=judge] end after ${Math.round(judgeMs / 1000)}s (verdict=${judgeResult.overallVerdict})`);
        endJudgeSpan(judgeSpan, judgeResult, judgeMs);
        allJudgeLines.push(JSON.stringify({
            testIndex: i,
            checkpoint: test.checkpoint,
            judgeResult,
            durationMs: judgeMs,
            timestamp: new Date().toISOString(),
        }));
        log.info(`  Overall: ${judgeResult.overallVerdict} (${judgeResult.verdicts.length} checks, ${judgeMs}ms)`);
        for (const v of judgeResult.verdicts) {
            if (v.checkType === 'eval-review') {
                const gap = v.evalGapSeverity ?? 'noncritical';
                const icon = gap === 'ok' ? '✓' : gap === 'critical' ? '✗' : '⚠';
                log.info(`    ${icon} eval-review: ${gap} — ${v.evidence.slice(0, 80)}`);
            } else {
                const icon = v.verdict === 'pass' ? '✓' : v.verdict === 'fail' ? '✗' : '⚠';
                log.info(`    ${icon} ${v.checkType}: ${v.verdict} — ${v.evidence.slice(0, 80)}`);
            }
        }

        if (judgeResult.overallVerdict === 'pass') break;
        attempt++;
    }

    const outputText = lastRunResult?.text ?? '';
    const agentResult: AgentResult = {
        agent,
        model: input.model ?? 'default',
        scenarioName: meta.name,
        testIndex: i,
        testPrompt: test.test,
        checkpoint: test.checkpoint,
        agentOutput: outputText,
        agentOutputLength: outputText.length,
        monitorOutput,
        verdicts: judgeResult.verdicts,
        overallVerdict: judgeResult.overallVerdict,
        metrics: lastRunResult?.metrics ?? EMPTY_METRICS,
        efficiency: lastRunResult?.efficiency ?? EMPTY_EFFICIENCY,
        trajectory: lastRunResult?.trajectory ?? EMPTY_TRAJECTORY,
        judge: { judgeCostUsd: 0, judgeLatencyMs: judgeMs, judgeTurns: judgeResult.verdicts.filter((v) => v.checkType === 'llm-judge').length },
        retryAttempts: attempt,
        stopReason: lastRunResult?.stopReason ?? 'unknown',
        exitCode: lastRunResult?.exitCode ?? null,
        aborted: lastRunResult?.aborted ?? false,
        abortReason: lastRunResult?.aborted ? 'budget_exceeded' : null,
        error: lastRunResult?.error ?? null,
        hungWarnings: lastRunResult?.hungWarnings ?? [],
        shutdownReason: lastRunResult?.shutdownReason ?? null,
    };

    endTestSpan(testSpan, agentResult.overallVerdict);
    await Actor.pushData(agentResult);
    allResults.push(agentResult);

    if (judgeResult.overallVerdict === 'fail' && meta.abortOnFailure) {
        log.warning(`abortOnFailure=true, stopping after test ${i + 1} (verdict: fail)`);
        break;
    }
}

// Store logs
const maskedAgentLog = maskSecrets(allEventLines.join('\n'), secrets);
if (maskedAgentLog) {
    await Actor.setValue('CONVERSATION-LOG', maskedAgentLog, { contentType: 'text/plain' });
}

const maskedJudgeLog = maskSecrets(allJudgeLines.join('\n'), secrets);
if (maskedJudgeLog) {
    await Actor.setValue('JUDGE-LOG', maskedJudgeLog, { contentType: 'text/plain' });
}

const passed = allResults.filter((r) => r.overallVerdict === 'pass').length;
const failed = allResults.filter((r) => r.overallVerdict === 'fail').length;
const unclear = allResults.filter((r) => r.overallVerdict === 'unclear').length;
const totalCost = allResults.reduce((sum, r) => sum + r.metrics.totalCostUsd, 0);

log.info(`\n=== Results: ${passed} passed, ${failed} failed, ${unclear} unclear | Cost: ${formatCost(totalCost)} ===`);

endScenarioSpan(scenarioSpan, passed, failed, totalCost);
const otelTrace = await flushOtel();
if (otelTrace && typeof otelTrace === 'object') {
    await Actor.setValue('OTEL-TRACE', JSON.stringify(otelTrace), { contentType: 'application/json' });
    log.info(`OTel trace saved (${otelTrace.resourceSpans[0]?.scopeSpans[0]?.spans.length ?? 0} spans)`);
}

await Actor.exit();
