import { describe, it, expect } from 'vitest';

import { runAgent } from '../agents/run.js';
import { judgeAllChecks } from '../judge.js';
import { parseScenario } from '../scenario-parser.js';
import { claudeAvailable } from './_claude-available.js';

// Live agent suite: spawns the real `claude` binary and makes billable API
// calls. Skips when the binary isn't on PATH (e.g. CI) instead of failing.
describe.skipIf(!claudeAvailable())('integration: full pipeline with claude-code', () => {
    it('runs a simple prompt and extracts metrics + trajectory', async () => {
        const result = await runAgent({
            agent: 'claude-code',
            prompt: 'What is 2+2? Answer with just the number, nothing else.',
            maxTurns: 1,
            maxBudgetUsd: 0.50,
        });

        expect(result.error).toBeNull();
        expect(result.exitCode).toBe(0);
        expect(result.text).toContain('4');
        expect(result.stopReason).not.toBe('error');

        // RunMetrics populated
        expect(result.metrics.inputTokens).toBeGreaterThan(0);
        expect(result.metrics.outputTokens).toBeGreaterThan(0);
        expect(result.metrics.durationMs).toBeGreaterThan(0);
        expect(result.metrics.numTurns).toBeGreaterThanOrEqual(1);

        // EfficiencyMetrics derived
        expect(result.efficiency.tokensPerTurn).toBeGreaterThan(0);
        expect(result.efficiency.cacheHitRate).toBeGreaterThanOrEqual(0);
        expect(result.efficiency.avgTurnDurationMs).toBeGreaterThan(0);

        // Events captured
        expect(result.events.length).toBeGreaterThan(0);
    }, 30_000);

    it('runs prompt with tool use and captures trajectory', async () => {
        const result = await runAgent({
            agent: 'claude-code',
            prompt: 'Run: echo "hello integration test" — then report what the output was.',
            maxTurns: 3,
            maxBudgetUsd: 0.50,
        });

        expect(result.error).toBeNull();
        expect(result.text.toLowerCase()).toContain('hello integration test');

        // Trajectory captured
        expect(result.trajectory.toolCallCount).toBeGreaterThan(0);
        expect(result.trajectory.toolCallSequence.length).toBeGreaterThan(0);
        expect(result.trajectory.uniqueToolsUsed).toContain('Bash');
        expect(result.trajectory.commandsExecuted.length).toBeGreaterThan(0);
        expect(result.trajectory.commandsExecuted[0]).toContain('echo');

        // Per-turn breakdown
        expect(result.trajectory.perTurnTokens.length).toBeGreaterThan(0);
    }, 30_000);

    it('judge evaluates agent output with multiple checks', async () => {
        const result = await runAgent({
            agent: 'claude-code',
            prompt: 'What is the largest planet in our solar system? Answer in one sentence in English.',
            maxTurns: 1,
            maxBudgetUsd: 0.50,
        });

        expect(result.error).toBeNull();

        const checkpoint = 'contains: Jupiter\nregex: \\b(largest|biggest)\\b';
        const judgeResult = await judgeAllChecks(result.text, checkpoint);

        expect(judgeResult.verdicts).toHaveLength(2);
        expect(judgeResult.verdicts[0].checkType).toBe('contains');
        expect(judgeResult.verdicts[0].verdict).toBe('pass');
        expect(judgeResult.verdicts[1].checkType).toBe('regex');
        expect(judgeResult.verdicts[1].verdict).toBe('pass');
        expect(judgeResult.overallVerdict).toBe('pass');
    }, 30_000);

    it('judge script checkpoint receives agent output on stdin', async () => {
        const result = await runAgent({
            agent: 'claude-code',
            prompt: 'Output exactly this JSON: {"status":"ok","count":42}',
            maxTurns: 1,
            maxBudgetUsd: 0.50,
        });

        expect(result.error).toBeNull();

        const checkpoint = 'script: grep -q "ok"';
        const judgeResult = await judgeAllChecks(result.text, checkpoint);

        expect(judgeResult.verdicts).toHaveLength(1);
        expect(judgeResult.verdicts[0].checkType).toBe('script');
        expect(judgeResult.verdicts[0].verdict).toBe('pass');
    }, 30_000);

    it('full scenario parsing + execution + judging', async () => {
        const scenarioMd = `---
name: integration-test
description: End-to-end integration test
abortOnFailure: false
---

## Test
What is 7 * 8? Answer with just the number.

## Checkpoint
contains: 56
`;
        const { meta, tests } = parseScenario(scenarioMd);
        expect(meta.name).toBe('integration-test');
        expect(tests).toHaveLength(1);

        const result = await runAgent({
            agent: 'claude-code',
            prompt: tests[0].test,
            maxTurns: 1,
            maxBudgetUsd: 0.50,
        });

        expect(result.error).toBeNull();

        const judgeResult = await judgeAllChecks(result.text, tests[0].checkpoint);
        expect(judgeResult.overallVerdict).toBe('pass');
    }, 30_000);
});
