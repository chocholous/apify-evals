/**
 * Integration tests for existing scenarios from scenarios/ root.
 * Verifies that core scenarios work end-to-end.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runAgent } from '../agents/run.js';
import { judgeAllChecks } from '../judge.js';
import { parseScenario } from '../scenario-parser.js';

const SCENARIOS_DIR = join(import.meta.dirname, '../../../scenarios');
const BUDGET = 0.50;

function logVerdicts(scenario: string, testIndex: number, text: string, judgeResult: { verdicts: Array<{ checkType: string; verdict: string; evidence: string; confidence: number }>; overallVerdict: string }, metrics: { numTurns: number; totalCostUsd: number; durationMs: number }): void {
    console.log(`\n--- ${scenario} test ${testIndex}: ${judgeResult.overallVerdict} ---`);
    console.log(`  turns=${metrics.numTurns} cost=$${metrics.totalCostUsd.toFixed(4)} duration=${(metrics.durationMs / 1000).toFixed(1)}s`);
    for (const v of judgeResult.verdicts) {
        console.log(`  ${v.checkType}: ${v.verdict} (${v.confidence}) — ${v.evidence.slice(0, 80)}`);
    }
}

describe('smoke-test scenario', () => {
    it('simple math question', async () => {
        const md = readFileSync(join(SCENARIOS_DIR, 'smoke-test.md'), 'utf-8');
        const { tests } = parseScenario(md);

        const result = await runAgent({
            agent: 'claude-code',
            prompt: tests[0].test,
            maxTurns: 1,
            maxBudgetUsd: BUDGET,
        });
        expect(result.error).toBeNull();

        const judgeResult = await judgeAllChecks(result.text, tests[0].checkpoint);
        logVerdicts('smoke-test', 0, result.text, judgeResult, result.metrics);
        expect(judgeResult.overallVerdict).toBe('pass');
    }, 30_000);
});

describe('us5-multi-step scenario', () => {
    it('2-step planet questions with abortOnFailure', async () => {
        const md = readFileSync(join(SCENARIOS_DIR, 'us5-multi-step.md'), 'utf-8');
        const { meta, tests } = parseScenario(md);
        expect(meta.abortOnFailure).toBe(true);

        for (let i = 0; i < tests.length; i++) {
            const result = await runAgent({
                agent: 'claude-code',
                prompt: tests[i].test,
                maxTurns: 1,
                maxBudgetUsd: BUDGET,
            });
            expect(result.error).toBeNull();

            const judgeResult = await judgeAllChecks(result.text, tests[i].checkpoint);
            logVerdicts('us5-multi-step', i, result.text, judgeResult, result.metrics);
            expect(judgeResult.overallVerdict).toBe('pass');
        }
    }, 60_000);
});

describe('us1-complex-tool-use scenario', () => {
    it('agent creates files and manipulates them', async () => {
        const md = readFileSync(join(SCENARIOS_DIR, 'us1-complex-tool-use.md'), 'utf-8');
        const { tests } = parseScenario(md);

        for (let i = 0; i < tests.length; i++) {
            const result = await runAgent({
                agent: 'claude-code',
                prompt: tests[i].test,
                maxTurns: 5,
                maxBudgetUsd: BUDGET,
            });
            expect(result.error).toBeNull();
            expect(result.trajectory.toolCallCount).toBeGreaterThan(0);

            const judgeResult = await judgeAllChecks(result.text, tests[i].checkpoint);
            logVerdicts('us1-complex-tool-use', i, result.text, judgeResult, result.metrics);
            expect(judgeResult.overallVerdict).toBe('pass');
        }
    }, 90_000);
});

describe('security-isolation scenario', () => {
    it('agent writes only in workspace, not runner dir', async () => {
        const md = readFileSync(join(SCENARIOS_DIR, 'security-isolation.md'), 'utf-8');
        const { tests } = parseScenario(md);

        for (let i = 0; i < tests.length; i++) {
            const result = await runAgent({
                agent: 'claude-code',
                prompt: tests[i].test,
                maxTurns: 5,
                maxBudgetUsd: BUDGET,
            });

            const judgeResult = await judgeAllChecks(result.text, tests[i].checkpoint);
            logVerdicts('security-isolation', i, result.text, judgeResult, result.metrics);

            // Script checkpoints must pass
            const scriptVerdicts = judgeResult.verdicts.filter((v) => v.checkType === 'script');
            for (const sv of scriptVerdicts) {
                expect(sv.verdict).toBe('pass');
            }
        }
    }, 60_000);
});

describe('multi-check-demo scenario', () => {
    it('combines multiple checkpoint types', async () => {
        const md = readFileSync(join(SCENARIOS_DIR, 'multi-check-demo.md'), 'utf-8');
        const { tests } = parseScenario(md);

        // Test 1: Jupiter question (contains + regex + llm-judge)
        const result1 = await runAgent({
            agent: 'claude-code',
            prompt: tests[0].test,
            maxTurns: 1,
            maxBudgetUsd: BUDGET,
        });

        const judge1 = await judgeAllChecks(result1.text, tests[0].checkpoint);
        logVerdicts('multi-check-demo', 0, result1.text, judge1, result1.metrics);

        // Deterministic checks should pass
        const detVerdicts = judge1.verdicts.filter((v) => v.checkType !== 'llm-judge');
        expect(detVerdicts.every((v) => v.verdict === 'pass')).toBe(true);
    }, 60_000);
});

describe('trajectory-test scenario', () => {
    it('captures rich trajectory data across multi-step', async () => {
        const md = readFileSync(join(SCENARIOS_DIR, 'trajectory-test.md'), 'utf-8');
        const { tests } = parseScenario(md);

        const result = await runAgent({
            agent: 'claude-code',
            prompt: tests[0].test,
            maxTurns: 5,
            maxBudgetUsd: BUDGET,
        });

        expect(result.error).toBeNull();
        expect(result.trajectory.toolCallCount).toBeGreaterThan(0);
        expect(result.trajectory.filesCreated.length + result.trajectory.filesModified.length).toBeGreaterThan(0);
        expect(result.trajectory.commandsExecuted.length).toBeGreaterThan(0);

        // Efficiency metrics populated
        expect(result.efficiency.totalContextTokens).toBeGreaterThan(0);
        expect(result.efficiency.cacheHitRate).toBeGreaterThanOrEqual(0);
        expect(result.efficiency.tokensPerTurn).toBeGreaterThan(0);

        // toolCallDetails should have entries
        expect(result.trajectory.toolCallDetails.length).toBeGreaterThan(0);
        expect(result.trajectory.toolCallDetails[0].tool).toBeTruthy();
        expect(result.trajectory.toolCallDetails[0].input).toBeDefined();

        const judgeResult = await judgeAllChecks(result.text, tests[0].checkpoint);
        logVerdicts('trajectory-test', 0, result.text, judgeResult, result.metrics);
    }, 60_000);
});
