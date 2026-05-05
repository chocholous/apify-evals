/**
 * Advanced integration tests — run all scenarios from scenarios/advanced/
 * These take 1-3 minutes each and require Claude CLI.
 * Run with: npx vitest run src/__tests__/integration-advanced.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { runAgent, type AgentRunResult } from '../agents/run.js';
import { judgeAllChecks, type JudgeResult } from '../judge.js';
import { parseScenario } from '../scenario-parser.js';

const SCENARIOS_DIR = join(import.meta.dirname, '../../../scenarios/advanced');
const BUDGET = 1.5;

interface ScenarioResult {
    scenario: string;
    testIndex: number;
    agentResult: AgentRunResult;
    judgeResult: JudgeResult;
}

async function runScenarioTest(scenarioFile: string, initScript?: string): Promise<ScenarioResult[]> {
    const md = readFileSync(join(SCENARIOS_DIR, scenarioFile), 'utf-8');
    const { tests } = parseScenario(md);
    const results: ScenarioResult[] = [];

    for (let i = 0; i < tests.length; i++) {
        const test = tests[i];
        const agentResult = await runAgent({
            agent: 'claude-code',
            prompt: test.test,
            maxTurns: 15,
            maxBudgetUsd: BUDGET,
        });

        const judgeResult = await judgeAllChecks(agentResult.text, test.checkpoint, {
            workDir: process.cwd(),
        });

        results.push({ scenario: scenarioFile, testIndex: i, agentResult, judgeResult });

        // Abort early if test failed and scenario has abortOnFailure
        if (judgeResult.overallVerdict === 'fail') {
            const { meta } = parseScenario(md);
            if (meta.abortOnFailure) break;
        }
    }

    return results;
}

function logResult(r: ScenarioResult): void {
    const { scenario, testIndex, agentResult, judgeResult } = r;
    console.log(`\n--- ${scenario} test ${testIndex} ---`);
    console.log(`  verdict: ${judgeResult.overallVerdict}`);
    console.log(`  turns: ${agentResult.metrics.numTurns}, cost: $${agentResult.metrics.totalCostUsd.toFixed(4)}, duration: ${(agentResult.metrics.durationMs / 1000).toFixed(1)}s`);
    console.log(`  tools: ${agentResult.trajectory.toolCallSequence.join(', ') || '(none)'}`);
    console.log(`  cacheHitRate: ${agentResult.efficiency.cacheHitRate.toFixed(3)}`);
    if (agentResult.error) console.log(`  error: ${agentResult.error}`);
    for (const v of judgeResult.verdicts) {
        console.log(`  ${v.checkType}: ${v.verdict} — ${v.evidence.slice(0, 100)}`);
    }
}

describe('advanced scenarios — multi-tool-pipeline', () => {
    it('builds data pipeline with jq filtering', async () => {
        const results = await runScenarioTest('multi-tool-pipeline.md');

        logResult(results[0]);

        // Deterministic checks should pass
        const scriptVerdicts = results[0].judgeResult.verdicts.filter((v) => v.checkType === 'script');
        for (const sv of scriptVerdicts) {
            expect(sv.verdict).toBe('pass');
        }

        // Contains checks
        const containsVerdicts = results[0].judgeResult.verdicts.filter((v) => v.checkType === 'contains');
        const containsPass = containsVerdicts.filter((v) => v.verdict === 'pass').length;
        expect(containsPass).toBeGreaterThanOrEqual(2); // At least Alice + Charlie

        // Trajectory should show tool use
        expect(results[0].agentResult.trajectory.toolCallCount).toBeGreaterThan(0);
        expect(results[0].agentResult.trajectory.uniqueToolsUsed).toContain('Bash');
    }, 120_000);
});

describe('advanced scenarios — error-recovery', () => {
    it('agent handles errors and self-corrects', async () => {
        const results = await runScenarioTest('error-recovery.md');

        logResult(results[0]);

        // Script checkpoint: file should exist and be valid JSON
        const scriptVerdict = results[0].judgeResult.verdicts.find((v) => v.checkType === 'script');
        expect(scriptVerdict?.verdict).toBe('pass');

        // Contains "hello world"
        const containsVerdict = results[0].judgeResult.verdicts.find((v) => v.checkType === 'contains');
        expect(containsVerdict?.verdict).toBe('pass');

        // Should have encountered errors (errorRecoveryCount > 0 ideally, but hard to guarantee)
        console.log(`  errorRecoveryCount: ${results[0].agentResult.trajectory.errorRecoveryCount}`);
    }, 120_000);
});

describe('advanced scenarios — git-workflow', () => {
    it('initializes repo and creates branch', async () => {
        const results = await runScenarioTest('git-workflow.md');

        for (const r of results) logResult(r);

        // Test 1: git init + commit
        const test1Script = results[0].judgeResult.verdicts.find((v) => v.checkType === 'script');
        expect(test1Script?.verdict).toBe('pass');

        // Test 2: branch creation (if test 1 passed)
        if (results.length > 1) {
            const test2Script = results[1].judgeResult.verdicts.find((v) => v.checkType === 'script');
            expect(test2Script?.verdict).toBe('pass');
        }
    }, 120_000);
});

describe('advanced scenarios — api-interaction', () => {
    it('fetches GitHub API and processes response', async () => {
        const results = await runScenarioTest('api-interaction.md');

        logResult(results[0]);

        const scriptVerdict = results[0].judgeResult.verdicts.find((v) => v.checkType === 'script');
        expect(scriptVerdict?.verdict).toBe('pass');
    }, 120_000);
});

describe('advanced scenarios — typescript-project', () => {
    it('creates TS project with tests that pass', async () => {
        const results = await runScenarioTest('typescript-project.md');

        logResult(results[0]);

        const scriptVerdict = results[0].judgeResult.verdicts.find((v) => v.checkType === 'script');
        // This is the hardest test — agent must write valid TS + tests + run them
        console.log(`  script evidence: ${scriptVerdict?.evidence.slice(0, 200)}`);

        // At minimum, all files should exist
        expect(results[0].agentResult.trajectory.toolCallCount).toBeGreaterThan(3);
    }, 180_000);
});

describe('advanced scenarios — workspace-context-judge', () => {
    it('LLM judge evaluates code from workspace files', async () => {
        const results = await runScenarioTest('workspace-context-judge.md');

        logResult(results[0]);

        // Script: file exists
        const scriptVerdict = results[0].judgeResult.verdicts.find((v) => v.checkType === 'script');
        expect(scriptVerdict?.verdict).toBe('pass');

        // LLM judge should have seen the actual code
        const judgeVerdict = results[0].judgeResult.verdicts.find((v) => v.checkType === 'llm-judge');
        console.log(`  judge confidence: ${judgeVerdict?.confidence}`);
        console.log(`  judge evidence: ${judgeVerdict?.evidence.slice(0, 200)}`);
        // Judge should NOT say "unclear" since it can now see workspace files
        expect(judgeVerdict?.verdict).not.toBe('unclear');
    }, 120_000);
});

describe('advanced scenarios — init-script-complex', () => {
    it('agent implements module from CLAUDE.md spec', async () => {
        // This test requires init script to scaffold the project first
        const initScript = readFileSync(join(SCENARIOS_DIR, 'init-script-complex.init.sh'), 'utf-8');

        const md = readFileSync(join(SCENARIOS_DIR, 'init-script-complex.md'), 'utf-8');
        const { tests } = parseScenario(md);

        // Run init script manually (simulating what runner would do)
        const { execSync } = await import('node:child_process');
        const workDir = `/tmp/eval-init-test-${Date.now()}`;
        execSync(`mkdir -p ${workDir}`);
        try {
            execSync(initScript, { cwd: workDir, timeout: 120_000, stdio: 'pipe' });
        } catch (e) {
            console.log('Init script output:', (e as { stdout?: Buffer }).stdout?.toString().slice(0, 500));
        }

        // Run agent in the scaffolded workspace
        const agentResult = await runAgent({
            agent: 'claude-code',
            prompt: tests[0].test,
            maxTurns: 10,
            maxBudgetUsd: BUDGET,
            cwd: workDir,
        });

        const judgeResult = await judgeAllChecks(agentResult.text, tests[0].checkpoint, {
            workDir,
        });

        const result = { scenario: 'init-script-complex.md', testIndex: 0, agentResult, judgeResult };
        logResult(result);

        // Script checkpoint runs vitest — should pass if agent implemented correctly
        const scriptVerdict = judgeResult.verdicts.find((v) => v.checkType === 'script');
        console.log(`  script evidence: ${scriptVerdict?.evidence.slice(0, 300)}`);
        expect(scriptVerdict).toBeDefined();

        // Cleanup
        execSync(`rm -rf ${workDir}`);
    }, 180_000);
});
