import { setTimeout } from 'node:timers/promises';

import { Actor, log } from 'apify';
import { parseScenario, runAgent, judgeAllChecks, maskSecrets, formatCost, formatDuration, runInitPreset } from '@apify-evals/shared';
import type { AgentResult, PresetName, AgentRunResult, JudgeResult, ExpectedTools, TrajectoryMetrics, DiscoverabilityMetrics } from '@apify-evals/shared';

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

log.info(`Scenario "${meta.name}": ${tests.length} test(s), abortOnFailure=${meta.abortOnFailure}`);
if (parseWarnings) {
    for (const w of parseWarnings) log.warning(`[parse] ${w}`);
}

const preset = (input.initPreset ?? 'none') as PresetName;
const initResult = runInitPreset({
    preset,
    customScript: input.initBashScript,
    mcpConfigJson: input.mcpConfigJson as Record<string, unknown>,
    workDir: process.cwd(),
});

for (const msg of initResult.presetLog) {
    log.info(`[init] ${msg}`);
}

const allResults: AgentResult[] = [];
const allEventLines: string[] = [];
const allJudgeLines: string[] = [];

for (let i = 0; i < tests.length; i++) {
    const test = tests[i];
    log.info(`--- Test ${i + 1}/${tests.length}: "${test.test.slice(0, 80)}" ---`);

    let judgeResult: JudgeResult = { verdicts: [], overallVerdict: 'fail' };
    let lastRunResult: AgentRunResult | null = null;
    let monitorOutput: string | null = null;
    let attempt = 0;

    while (attempt <= maxRetries) {
        if (attempt > 0) log.info(`  Retry ${attempt}/${maxRetries}`);

        const defaultSystemPrompt = 'You are an AI agent being evaluated. Always respond in English. Follow the instructions precisely.';
        const systemPrompt = input.systemPrompt ?? defaultSystemPrompt;

        const result = await runAgent({
            agent,
            prompt: test.test,
            systemPrompt,
            model: input.model,
            maxTurns,
            maxBudgetUsd: input.maxBudgetUsd,
            env: secrets,
            mcpConfigPath: initResult.mcpConfigPath ?? undefined,
            strictMcpConfig: initResult.strictMcpConfig,
            abortSignal: abortController.signal,
        });

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
            const monitorResult = await runAgent({
                agent,
                prompt: test.monitor,
                systemPrompt: `You were just asked to do a task. Here is what you produced:\n\n${result.text}\n\nNow answer the following monitoring question based on your work above.`,
                model: input.model,
                maxTurns: 3,
                env: secrets,
            });
            monitorOutput = monitorResult.text;
            log.info(`  Monitor: ${monitorOutput.slice(0, 100)}`);
        }

        // Judge all checks
        const judgeStart = Date.now();
        judgeResult = await judgeAllChecks(result.text, test.checkpoint, { env: secrets, workDir: process.cwd() });
        const judgeMs = Date.now() - judgeStart;
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

    const emptyMetrics = {
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        totalCostUsd: 0, durationMs: 0, durationApiMs: 0, numTurns: 0, modelUsage: {},
    };
    const emptyEfficiency = {
        totalContextTokens: 0, tokensPerTurn: 0, costPerTurn: 0, cacheHitRate: 0,
        contextOutputRatio: 0, apiDurationRatio: 0, avgTurnDurationMs: 0,
    };
    const emptyTrajectory = {
        toolCallCount: 0, toolCallSequence: [] as string[], uniqueToolsUsed: [] as string[],
        toolCallsPerTurn: 0, perTurnTokens: [] as Array<{ turn: number; input: number; output: number }>,
        perTurnToolCalls: [] as Array<{ turn: number; tools: string[] }>,
        toolCallDetails: [] as Array<{ tool: string; turn: number; input: Record<string, unknown> }>,
        errorRecoveryCount: 0, filesCreated: [] as string[], filesModified: [] as string[],
        commandsExecuted: [] as string[], mcpToolsUsed: [] as string[],
    };

    const agentResult: AgentResult = {
        agent,
        model: input.model ?? 'default',
        scenarioName: meta.name,
        testIndex: i,
        testPrompt: test.test,
        checkpoint: test.checkpoint,
        agentOutput: lastRunResult?.text ?? '',
        monitorOutput,
        verdicts: judgeResult.verdicts,
        overallVerdict: judgeResult.overallVerdict,
        metrics: lastRunResult?.metrics ?? emptyMetrics,
        efficiency: lastRunResult?.efficiency ?? emptyEfficiency,
        trajectory: lastRunResult?.trajectory ?? emptyTrajectory,
        discoverability: computeDiscoverability(meta.expectedTools, lastRunResult?.trajectory ?? emptyTrajectory),
        stopReason: lastRunResult?.stopReason ?? 'unknown',
        exitCode: lastRunResult?.exitCode ?? null,
        aborted: lastRunResult?.aborted ?? false,
        abortReason: lastRunResult?.aborted ? 'budget_exceeded' : null,
        error: lastRunResult?.error ?? null,
    };

    await Actor.pushData(agentResult);
    allResults.push(agentResult);

    if (judgeResult.overallVerdict !== 'pass' && meta.abortOnFailure) {
        log.warning(`abortOnFailure=true, stopping after test ${i + 1}`);
        break;
    }
}

// Store logs
const maskedAgentLog = maskSecrets(allEventLines.join('\n'), secrets);
await Actor.setValue('CONVERSATION-LOG', maskedAgentLog, { contentType: 'text/plain' });

const maskedJudgeLog = maskSecrets(allJudgeLines.join('\n'), secrets);
await Actor.setValue('JUDGE-LOG', maskedJudgeLog, { contentType: 'text/plain' });

const passed = allResults.filter((r) => r.overallVerdict === 'pass').length;
const failed = allResults.filter((r) => r.overallVerdict === 'fail').length;
const unclear = allResults.filter((r) => r.overallVerdict === 'unclear').length;
const totalCost = allResults.reduce((sum, r) => sum + r.metrics.totalCostUsd, 0);

log.info(`\n=== Results: ${passed} passed, ${failed} failed, ${unclear} unclear | Cost: ${formatCost(totalCost)} ===`);

await Actor.exit();
