import { Actor, log } from 'apify';
import { parseScenario, runClaude, judgeCheckpoint, maskSecrets, formatCost, formatDuration, runInitPreset } from '@apify-evals/shared';
import type { AgentResult, Verdict, PresetName, ClaudeRunResult } from '@apify-evals/shared';

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

await Actor.init();

const input = await Actor.getInput<RunnerInput>();
if (!input?.scenario) {
    throw new Error('Missing required input: scenario');
}

const { meta, tests } = parseScenario(input.scenario);
const secrets = input.envVariables ?? {};
const agent = input.agent ?? 'claude-code';
const maxRetries = input.maxRetries ?? 0;
const maxTurns = input.maxTurns ?? 10;

log.info(`Scenario "${meta.name}": ${tests.length} test(s), abortOnFailure=${meta.abortOnFailure}`);

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

    let verdict: Verdict = { verdict: 'fail', evidence: 'Not executed', confidence: 0 };
    let lastRunResult: ClaudeRunResult | null = null;
    let monitorOutput: string | null = null;
    let attempt = 0;

    while (attempt <= maxRetries) {
        if (attempt > 0) log.info(`  Retry ${attempt}/${maxRetries}`);

        const defaultSystemPrompt = 'You are an AI agent being evaluated. Always respond in English. Follow the instructions precisely.';
        const systemPrompt = input.systemPrompt ?? defaultSystemPrompt;

        const result = await runClaude({
            prompt: test.test,
            systemPrompt,
            model: input.model,
            maxTurns,
            maxBudgetUsd: input.maxBudgetUsd,
            env: secrets,
            mcpConfigPath: initResult.mcpConfigPath ?? undefined,
            strictMcpConfig: initResult.strictMcpConfig,
        });

        lastRunResult = result;

        for (const event of result.events) {
            allEventLines.push(JSON.stringify(event));
        }

        if (result.aborted) {
            log.warning(`  Test ${i + 1} aborted: budget exceeded`);
            verdict = { verdict: 'fail', evidence: 'Run aborted due to budget limit', confidence: 1 };
            break;
        }

        if (result.error) {
            log.warning(`  Test ${i + 1} error: ${result.error}`);
            verdict = { verdict: 'fail', evidence: `Agent error: ${result.error}`, confidence: 1 };
            break;
        }

        log.info(`  Agent responded (${result.metrics.numTurns} turns, ${formatCost(result.metrics.totalCostUsd)}, ${formatDuration(result.metrics.durationMs)})`);

        // Monitor extraction
        if (test.monitor) {
            const monitorResult = await runClaude({
                prompt: test.monitor,
                systemPrompt: `You were just asked to do a task. Here is what you produced:\n\n${result.text}\n\nNow answer the following monitoring question based on your work above.`,
                model: input.model,
                maxTurns: 3,
                env: secrets,
            });
            monitorOutput = monitorResult.text;
            log.info(`  Monitor: ${monitorOutput.slice(0, 100)}`);
        }

        // Judge checkpoint
        const judgeStart = Date.now();
        verdict = await judgeCheckpoint(result.text, test.checkpoint);
        const judgeMs = Date.now() - judgeStart;
        allJudgeLines.push(JSON.stringify({
            testIndex: i,
            checkpoint: test.checkpoint,
            verdict,
            durationMs: judgeMs,
            timestamp: new Date().toISOString(),
        }));
        log.info(`  Verdict: ${verdict.verdict} (confidence: ${verdict.confidence}, judge: ${judgeMs}ms)`);

        if (verdict.verdict === 'pass') break;
        attempt++;
    }

    const agentResult: AgentResult = {
        agent,
        model: input.model ?? 'default',
        scenarioName: meta.name,
        testIndex: i,
        testPrompt: test.test,
        verdict,
        metrics: lastRunResult?.metrics ?? {
            inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
            totalCostUsd: 0, durationMs: 0, durationApiMs: 0, numTurns: 0, modelUsage: {},
        },
        aborted: lastRunResult?.aborted ?? false,
        abortReason: lastRunResult?.aborted ? 'budget_exceeded' : null,
        error: lastRunResult?.error ?? null,
    };

    await Actor.pushData(agentResult);
    allResults.push(agentResult);

    if (verdict.verdict !== 'pass' && meta.abortOnFailure) {
        log.warning(`abortOnFailure=true, stopping after test ${i + 1}`);
        break;
    }
}

// Store logs
const maskedAgentLog = maskSecrets(allEventLines.join('\n'), secrets);
await Actor.setValue('CONVERSATION-LOG', maskedAgentLog, { contentType: 'text/plain' });

const maskedJudgeLog = maskSecrets(allJudgeLines.join('\n'), secrets);
await Actor.setValue('JUDGE-LOG', maskedJudgeLog, { contentType: 'text/plain' });

const passed = allResults.filter((r) => r.verdict.verdict === 'pass').length;
const failed = allResults.filter((r) => r.verdict.verdict === 'fail').length;
const unclear = allResults.filter((r) => r.verdict.verdict === 'unclear').length;
const totalCost = allResults.reduce((sum, r) => sum + r.metrics.totalCostUsd, 0);

log.info(`\n=== Results: ${passed} passed, ${failed} failed, ${unclear} unclear | Cost: ${formatCost(totalCost)} ===`);

await Actor.exit();
