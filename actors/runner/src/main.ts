import { setTimeout } from 'node:timers/promises';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { Actor, log } from 'apify';
import { parseScenario, runAgent, judgeAllChecks, maskSecrets, formatCost, formatDuration, runInitPreset, downloadApifyDatasets, initOtel, flushOtel, startScenarioSpan, startTestSpan, startAgentSpan, endAgentSpan, startJudgeSpan, endJudgeSpan, endTestSpan, endScenarioSpan, EMPTY_METRICS, EMPTY_EFFICIENCY, EMPTY_TRAJECTORY, computeOverall, allocateMetaDir, trajectoryPath } from '@apify-evals/shared';
import type { AgentResult, PresetName, AgentRunResult, JudgeResult, CheckVerdict, VerdictValue, TrajectoryReject } from '@apify-evals/shared';

/**
 * List files in workspace up to 3 levels deep, skipping noisy dirs.
 * Used for post-mortem visibility into the scaffold layout at judge time.
 * Bounded output: at most ~500 entries to keep KVS records small.
 */
function buildWorkspaceTree(workDir: string): string[] {
    try {
        const out = execFileSync('find', [
            workDir,
            '-maxdepth', '3',
            '-not', '-path', '*/node_modules/*',
            '-not', '-path', '*/.git/*',
            '-not', '-path', '*/dist/*',
            '-not', '-path', '*/storage/*',
        ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
        const lines = out.split('\n').filter((l) => l.length > 0);
        // Strip the workDir prefix to keep entries compact and portable.
        const rel = lines.map((p) => (p === workDir ? '.' : p.startsWith(workDir + '/') ? p.slice(workDir.length + 1) : p));
        return rel.slice(0, 500);
    } catch (err) {
        return [`<workspace-tree unavailable: ${err instanceof Error ? err.message : String(err)}>`];
    }
}

/**
 * Persist a per-(test, attempt) record to the Actor's key-value store so post-mortems
 * don't depend on stdout log truncation. One KVS entry per attempt — survives retries
 * (unlike the overwritten LIVE-* keys).
 */
async function persistAttemptResult(args: {
    i: number;
    attempt: number;
    test: { test: string; checkpoint: string };
    meta: { name: string };
    agent: string;
    model: string;
    judgeResult: JudgeResult;
    judgeMs: number;
    lastRunResult: AgentRunResult | null;
    currentWorkDir: string;
    secrets: Record<string, string>;
}): Promise<void> {
    const { i, attempt, test, meta, agent, model, judgeResult, judgeMs, lastRunResult, currentWorkDir, secrets } = args;
    const agentOutput = lastRunResult?.text ?? '';
    const agentOutputTail = agentOutput.length > 4096 ? agentOutput.slice(-4096) : agentOutput;
    const record = {
        scenarioName: meta.name,
        agent,
        model,
        testIndex: i,
        testNumber: i + 1,
        attemptNumber: attempt + 1,
        isRetry: attempt > 0,
        timestamp: new Date().toISOString(),

        testPrompt: test.test,
        checkpoint: test.checkpoint,

        overallVerdict: judgeResult.overallVerdict,
        verdicts: judgeResult.verdicts,
        judgeDurationMs: judgeMs,

        agentMetrics: lastRunResult?.metrics ?? EMPTY_METRICS,
        stopReason: lastRunResult?.stopReason ?? 'unknown',
        exitCode: lastRunResult?.exitCode ?? null,
        signal: lastRunResult?.signal ?? null,
        aborted: lastRunResult?.aborted ?? false,
        error: lastRunResult?.error ?? null,
        shutdownReason: lastRunResult?.shutdownReason ?? null,
        hungWarnings: lastRunResult?.hungWarnings ?? [],

        workspace: {
            workDir: currentWorkDir,
            files: buildWorkspaceTree(currentWorkDir),
        },
        workspaceTree: buildWorkspaceTree(currentWorkDir),

        agentOutputLength: agentOutput.length,
        agentOutputTail,
    };
    const key = `TEST-${i + 1}-ATTEMPT-${attempt + 1}-RESULT`;
    try {
        const masked = maskSecrets(JSON.stringify(record), secrets);
        await Actor.setValue(key, masked, { contentType: 'application/json' });
    } catch (err) {
        log.warning(`  Failed to persist ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
}

interface RunnerInput {
    agent?: string;
    model?: string;
    scenario: string;
    systemPrompt?: string;
    maxBudgetUsd?: number;
    maxRetries?: number;
    maxTurns?: number;
    envVariables?: Record<string, string>;
    preAuthenticate?: boolean;
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

const preset = (input.initPreset ?? 'none') as PresetName;

const tracer = initOtel();
const scenarioSpan = startScenarioSpan(tracer, {
    scenarioName: meta.name,
    agent,
    model: input.model ?? 'default',
    testsTotal: tests.length,
    initPreset: preset,
});

log.info(`Scenario "${meta.name}": ${tests.length} test(s), abortOnFailure=${meta.abortOnFailure}`);
if (parseWarnings) {
    for (const w of parseWarnings) log.warning(`[parse] ${w}`);
}

// Pre-authenticate the Apify CLI by populating ~/.apify/auth.json with APIFY_TOKEN.
// This mirrors the state of every real Apify developer who has run 'apify login'
// once on their machine. Without this, agents have to discover the apify-cli auth
// flow themselves (which surfaces F11 in the eval pack's FINDINGS.md — agents often
// ask the user for a token instead of using APIFY_TOKEN from env).
//
// Set input.preAuthenticate = false on a per-run/per-scenario basis to deliberately
// measure the raw-unauthed signal (gap analytics).
//
// auth.json lives at ~/.apify/auth.json (see apify-cli consts.ts GLOBAL_CONFIGS_FOLDER).
// The runner shares its home directory with the agent subprocess, so writing here
// makes auth.json visible to whatever apify-cli the agent invokes.
const apifyToken = secrets.APIFY_TOKEN ?? process.env.APIFY_TOKEN;
if (input.preAuthenticate !== false && apifyToken) {
    try {
        execFileSync('apify', ['login', '--token', apifyToken], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, APIFY_TOKEN: apifyToken },
        });
        log.info('Pre-authenticated apify-cli via APIFY_TOKEN.');
    } catch (err) {
        // Do NOT interpolate err.message — execFileSync embeds the full argv
        // (including --token <APIFY_TOKEN>) in "Command failed: ...", which would
        // leak the token into the run log. Prefer the CLI's own stderr (captured
        // via pipe); fall back to the spawn error code (e.g. ENOENT). Neither
        // contains the argv.
        const e = err as { stderr?: Buffer | string; code?: string };
        const detail = e.stderr ? String(e.stderr).trim() : (e.code ?? 'unknown error');
        log.warning(`Pre-authentication failed (continuing — agent will see unauthed state): ${detail}`);
    }
}

// Create isolated workspace so the agent cannot modify the runner's own files.
// Runner bookkeeping (trajectory dumps, judge checkpoint records) goes into a
// SIBLING `metaDir` outside the workspace — so it never leaks into `apify push`
// archives, and the agent's workspace stays pristine for measurement integrity
// (we observe what the agent writes, with no framework artefacts mixed in).
// Checkpoint scripts that need to read runner artefacts receive the path via
// the `EVAL_META_DIR` env var, injected into checkpoint subprocesses only.
const workspaceDir = `/tmp/eval-workspace-${randomUUID().slice(0, 8)}`;
mkdirSync(workspaceDir, { recursive: true });
const workspaceMetaDir = allocateMetaDir();
log.info(`Workspace: ${workspaceDir}`);
log.info(`Meta dir:  ${workspaceMetaDir}`);

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
    let currentMetaDir = workspaceMetaDir;
    let currentPluginDirs = [...pluginDirs];
    let currentMcpConfigPath = initResult.mcpConfigPath;
    let currentStrictMcp = initResult.strictMcpConfig;
    let currentPathPrefix = initResult.pathPrefix;
    let currentTrajectoryRejects: TrajectoryReject[] = initResult.trajectoryRejects;

    while (attempt <= maxRetries) {
        if (attempt > 0) {
            log.info(`  Retry ${attempt}/${maxRetries} — fresh workspace`);
            currentWorkDir = `/tmp/eval-workspace-${randomUUID().slice(0, 8)}`;
            mkdirSync(currentWorkDir, { recursive: true });
            currentMetaDir = allocateMetaDir();
            const retryInit = runInitPreset({
                preset,
                customScript: input.initBashScript,
                mcpConfigJson: input.mcpConfigJson as Record<string, unknown>,
                workDir: currentWorkDir,
            });
            for (const msg of retryInit.presetLog) log.info(`  [retry-init] ${msg}`);
            currentMcpConfigPath = retryInit.mcpConfigPath;
            currentStrictMcp = retryInit.strictMcpConfig;
            currentPathPrefix = retryInit.pathPrefix;
            currentTrajectoryRejects = retryInit.trajectoryRejects;
            currentPluginDirs = [];
            if (existsSync(join(currentWorkDir, '.claude-plugin', 'plugin.json'))) {
                currentPluginDirs.push(currentWorkDir);
                log.info(`  [retry-init] Plugin detected`);
            }
        }
        monitorOutput = null;

        // Pass input.systemPrompt through as-is. Previously this line injected
        // an eval-flavoured default ("You are an AI agent being evaluated…")
        // when the input was undefined/null, which leaked evaluation context
        // into every run that didn't explicitly override systemPrompt.
        //
        // With the new prompt-prefix design (see runAgent in shared/src/agents/run.ts),
        // systemPrompt is no longer passed to the agent CLI as a --system-prompt
        // flag. Instead, runAgent prepends it to the user prompt with a clear
        // separator. An undefined / empty systemPrompt means "no prepend" —
        // the agent CLI receives only the user task and uses its own built-in
        // identity prompt (which is the realistic baseline for "real user
        // opens Claude Code / Codex / OpenCode without customisation").
        const systemPrompt = input.systemPrompt;

        let turnCount = 0;
        let rawLineCount = 0;
        const rawLines: string[] = [];
        const agentSpan = startAgentSpan(tracer, agent);
        const agentPhaseStart = Date.now();
        log.info(`  [phase=agent] start`);
        let resultEventLogged = false;
        // PATH shim: when a `*_only` preset has written disallowed-tool shims under
        // an OS-tmpdir shim dir (outside the agent's writable cwd), prepend that dir
        // to the agent subprocess's PATH so the shims take precedence over the
        // image-installed binaries. Exporting
        // PATH inside an init script doesn't propagate (each runScript is its own
        // subshell); this is the only place where it reaches the agent.
        const agentEnv: Record<string, string> = currentPathPrefix
            ? { ...secrets, PATH: `${currentPathPrefix}:${process.env.PATH ?? ''}` }
            : secrets;

        const result = await runAgent({
            agent,
            prompt: test.test,
            systemPrompt,
            model: input.model,
            maxTurns,
            maxBudgetUsd: input.maxBudgetUsd,
            env: agentEnv,
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
            await persistAttemptResult({
                i, attempt, test, meta, agent, model: input.model ?? 'default',
                judgeResult, judgeMs, lastRunResult, currentWorkDir, secrets,
            });
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
            await persistAttemptResult({
                i, attempt, test, meta, agent, model: input.model ?? 'default',
                judgeResult, judgeMs, lastRunResult, currentWorkDir, secrets,
            });
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

        // Persist the agent's trajectory to the runner's private metaDir
        // (outside the agent's workspace). Checkpoint scripts that need
        // trajectory data can find it at $EVAL_META_DIR/trajectory.json.
        try {
            const trajectoryData = {
                toolCallSequence: result.trajectory.toolCallSequence,
                commandsExecuted: result.trajectory.commandsExecuted,
                filesCreated: result.trajectory.filesCreated,
                mcpToolsUsed: result.trajectory.mcpToolsUsed,
                toolCallCount: result.trajectory.toolCallCount,
                uniqueToolsUsed: result.trajectory.uniqueToolsUsed,
            };
            writeFileSync(trajectoryPath(currentMetaDir), JSON.stringify(trajectoryData, null, 2));
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
            env: secrets, workDir: currentWorkDir, metaDir: currentMetaDir, judgeModel: input.judgeModel, events: result.events,
            onJudgeRawLine: (line) => {
                judgeLines.push(line);
                Actor.setValue('LIVE-JUDGE-LOG', judgeLines.join('\n'), { contentType: 'text/plain' }).catch(() => {});
            },
        });
        judgeMs = Date.now() - judgeStart;
        log.info(`  [phase=judge] end after ${Math.round(judgeMs / 1000)}s (verdict=${judgeResult.overallVerdict})`);
        endJudgeSpan(judgeSpan, judgeResult, judgeMs);

        // Preset-injected trajectory enforcement (cross-surface leak detection).
        // For `*_only` presets, the runInitPreset call returned a set of
        // TrajectoryReject rules. Evaluate them against the normalized trajectory
        // and append the matches as additional verdicts. A single 'fail' verdict
        // here flips the overall to fail — that's how exclusivity is enforced.
        if (currentTrajectoryRejects.length > 0) {
            const trajectoryRejectVerdicts: CheckVerdict[] = [];
            for (const reject of currentTrajectoryRejects) {
                if (reject.predicate(result.trajectory)) {
                    const verdict: VerdictValue = reject.severity === 'warning' ? 'warning' : 'fail';
                    trajectoryRejectVerdicts.push({
                        checkType: 'preset-trajectory',
                        checkValue: reject.name,
                        verdict,
                        evidence: reject.reason,
                    });
                    log.warning(`  [preset-trajectory] ${verdict.toUpperCase()} ${reject.name}: ${reject.reason}`);
                }
            }
            if (trajectoryRejectVerdicts.length > 0) {
                judgeResult = {
                    ...judgeResult,
                    verdicts: [...judgeResult.verdicts, ...trajectoryRejectVerdicts],
                    overallVerdict: computeOverall([...judgeResult.verdicts, ...trajectoryRejectVerdicts]),
                };
                log.info(`  Overall after preset-trajectory rejects: ${judgeResult.overallVerdict}`);
            }
        }

        allJudgeLines.push(JSON.stringify({
            testIndex: i,
            checkpoint: test.checkpoint,
            judgeResult,
            durationMs: judgeMs,
            timestamp: new Date().toISOString(),
        }));
        log.info(`  Overall: ${judgeResult.overallVerdict} (${judgeResult.verdicts.length} checks, ${judgeMs}ms)`);
        for (const v of judgeResult.verdicts) {
            let header: string;
            if (v.checkType === 'eval-review') {
                const gap = v.evalGapSeverity ?? 'noncritical';
                const icon = gap === 'ok' ? '✓' : gap === 'critical' ? '✗' : '⚠';
                header = `    ${icon} eval-review: ${gap}`;
            } else {
                const icon = v.verdict === 'pass' ? '✓' : v.verdict === 'fail' ? '✗' : '⚠';
                header = `    ${icon} ${v.checkType}: ${v.verdict}`;
            }
            log.info(header);
            const evidence = (v.evidence ?? '').trim();
            if (evidence) {
                for (const line of evidence.split('\n')) {
                    log.info(`        ${line}`);
                }
            }
        }

        await persistAttemptResult({
            i, attempt, test, meta, agent, model: input.model ?? 'default',
            judgeResult, judgeMs, lastRunResult, currentWorkDir, secrets,
        });

        if (judgeResult.overallVerdict === 'pass') break;
        attempt++;
    }

    const outputText = lastRunResult?.text ?? '';
    const agentResult: AgentResult = {
        agent,
        model: input.model ?? 'default',
        initPreset: preset,
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
