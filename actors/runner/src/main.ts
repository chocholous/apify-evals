import { setTimeout } from 'node:timers/promises';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { Actor, log } from 'apify';
import { parseScenario, runAgent, judgeAllChecks, maskSecrets, formatCost, formatDuration, runInitPreset, initOtel, flushOtel, startScenarioSpan, startTestSpan, startAgentSpan, endAgentSpan, startJudgeSpan, endJudgeSpan, endTestSpan, endScenarioSpan, EMPTY_METRICS, EMPTY_EFFICIENCY, EMPTY_TRAJECTORY } from '@apify-evals/shared';
import type { AgentResult, PresetName, AgentRunResult, JudgeResult, ExpectedTools, TrajectoryMetrics, DiscoverabilityMetrics, JudgeMode } from '@apify-evals/shared';

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
    judgeMode?: JudgeMode;
}

function computeDiscoverability(expected: ExpectedTools | undefined, trajectory: TrajectoryMetrics): DiscoverabilityMetrics | null {
    if (!expected) return null;

    const actual = trajectory.uniqueToolsUsed;
    const actualSet = new Set(actual);
    const allowedSet = new Set([...expected.required, ...expected.optional]);

    const missingTools = expected.required.filter((t) => !actualSet.has(t));
    const extraTools = actual.filter((t) => !allowedSet.has(t) && !expected.forbidden.includes(t));
    const forbiddenToolsUsed = expected.forbidden.filter((t) => actualSet.has(t));

    const foundRequired = expected.required.filter((t) => actualSet.has(t));
    const discoverabilityScore = expected.required.length > 0
        ? foundRequired.length / expected.required.length
        : 1.0;
    const strictScore = (missingTools.length === 0 && forbiddenToolsUsed.length === 0) ? 1.0 : 0.0;

    return {
        expectedRequired: expected.required,
        expectedForbidden: expected.forbidden,
        expectedOptional: expected.optional,
        actualTools: actual,
        missingTools,
        extraTools,
        forbiddenToolsUsed,
        discoverabilityScore,
        strictScore,
    };
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
const judgeMode = input.judgeMode ?? 'auto';

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

    while (attempt <= maxRetries) {
        if (attempt > 0) log.info(`  Retry ${attempt}/${maxRetries}`);
        monitorOutput = null;

        const systemPrompt = input.systemPrompt
            ?? 'You are an AI agent being evaluated. Always respond in English. Follow the instructions precisely.';

        let turnCount = 0;
        const agentSpan = startAgentSpan(tracer, agent);
        const result = await runAgent({
            agent,
            prompt: test.test,
            systemPrompt,
            model: input.model,
            maxTurns,
            maxBudgetUsd: input.maxBudgetUsd,
            env: secrets,
            cwd: workspaceDir,
            mcpConfigPath: initResult.mcpConfigPath ?? undefined,
            strictMcpConfig: initResult.strictMcpConfig,
            pluginDirs: pluginDirs.length > 0 ? pluginDirs : undefined,
            abortSignal: abortController.signal,
            onEvent: (event) => {
                if (event.type === 'assistant' && event.message?.content) {
                    turnCount++;
                    const tools = event.message.content
                        .filter((c) => c.type === 'tool_use' && c.name)
                        .map((c) => c.name);
                    if (tools.length > 0) {
                        log.info(`    [turn ${turnCount}] ${tools.join(', ')}`);
                    }
                }
            },
        });
        endAgentSpan(agentSpan, result);

        lastRunResult = result;

        for (const event of result.events) {
            allEventLines.push(JSON.stringify(event));
        }

        if (result.aborted) {
            log.warning(`  Test ${i + 1} aborted: budget exceeded`);
            judgeResult = {
                verdicts: [{ checkType: 'error', checkValue: '', verdict: 'fail', evidence: 'Run aborted due to budget limit', confidence: 1 }],
                overallVerdict: 'fail',
            };
            break;
        }

        if (result.error) {
            log.warning(`  Test ${i + 1} error: ${result.error}`);
            judgeResult = {
                verdicts: [{ checkType: 'error', checkValue: '', verdict: 'fail', evidence: `Agent error: ${result.error}`, confidence: 1 }],
                overallVerdict: 'fail',
            };
            break;
        }

        log.info(`  Agent responded (${result.metrics.numTurns} turns, ${formatCost(result.metrics.totalCostUsd)}, ${formatDuration(result.metrics.durationMs)})`);

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
        const judgeSpan = startJudgeSpan(tracer);
        const judgeStart = Date.now();
        judgeResult = await judgeAllChecks(result.text, test.checkpoint, { env: secrets, workDir: workspaceDir, judgeMode, events: result.events });
        judgeMs = Date.now() - judgeStart;
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
            log.info(`    ${v.checkType}: ${v.verdict} — ${v.evidence.slice(0, 80)}`);
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
        discoverability: computeDiscoverability(meta.expectedTools, lastRunResult?.trajectory ?? EMPTY_TRAJECTORY),
        judge: { judgeCostUsd: 0, judgeLatencyMs: judgeMs, judgeTurns: judgeResult.verdicts.filter((v) => v.checkType === 'llm-judge').length },
        retryAttempts: attempt,
        stopReason: lastRunResult?.stopReason ?? 'unknown',
        exitCode: lastRunResult?.exitCode ?? null,
        aborted: lastRunResult?.aborted ?? false,
        abortReason: lastRunResult?.aborted ? 'budget_exceeded' : null,
        error: lastRunResult?.error ?? null,
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
