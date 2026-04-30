/**
 * E2E test runner for Agent Evals Runner Actor.
 *
 * Runs the actor with each test scenario and verifies results.
 * These tests call real claude CLI — they cost real money.
 *
 * Usage: npx tsx test/e2e/run-e2e.ts [test-name]
 *   No args = run all tests
 *   test-name = run only that test (e.g., "us5" or "us7")
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = resolve(__dirname, '../..');
const SCENARIOS_DIR = resolve(RUNNER_DIR, '../../scenarios');
const STORAGE_DIR = resolve(RUNNER_DIR, 'storage');

interface TestDef {
    name: string;
    scenarioFile: string;
    input: Record<string, unknown>;
    checks: (results: Record<string, unknown>[], kvFiles: string[]) => CheckResult;
}

interface CheckResult {
    pass: boolean;
    details: string;
}

function readScenario(name: string): string {
    return readFileSync(resolve(SCENARIOS_DIR, name), 'utf-8');
}

function readDatasetItems(): Record<string, unknown>[] {
    const datasetDir = resolve(STORAGE_DIR, 'datasets/default');
    if (!existsSync(datasetDir)) return [];
    return readdirSync(datasetDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => JSON.parse(readFileSync(resolve(datasetDir, f), 'utf-8')));
}

function readKvKeys(): string[] {
    const kvDir = resolve(STORAGE_DIR, 'key_value_stores/default');
    if (!existsSync(kvDir)) return [];
    return readdirSync(kvDir).filter((f) => f !== 'INPUT.json');
}

function readKvValue(key: string): string {
    const kvDir = resolve(STORAGE_DIR, 'key_value_stores/default');
    const file = readdirSync(kvDir).find((f) => f.startsWith(key));
    if (!file) return '';
    return readFileSync(resolve(kvDir, file), 'utf-8');
}

function runActor(input: Record<string, unknown>): Promise<{ code: number; output: string }> {
    return new Promise((res) => {
        const inputDir = `${STORAGE_DIR}/key_value_stores/default`;
        mkdirSync(inputDir, { recursive: true });
        writeFileSync(`${inputDir}/INPUT.json`, JSON.stringify(input));

        const child = spawn('npx', ['apify', 'run'], {
            cwd: RUNNER_DIR,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let output = '';
        child.stdout.on('data', (d) => { output += d.toString(); });
        child.stderr.on('data', (d) => { output += d.toString(); });

        child.on('close', (code) => {
            res({ code: code ?? 1, output });
        });
    });
}

// --- Test definitions ---

const tests: TestDef[] = [
    {
        name: 'us1-smoke',
        scenarioFile: 'smoke-test.md',
        input: {
            scenario: readScenario('smoke-test.md'),
            maxTurns: 3,
            maxBudgetUsd: 0.50,
        },
        checks: (results) => {
            if (results.length !== 1) return { pass: false, details: `Expected 1 result, got ${results.length}` };
            const r = results[0] as Record<string, Record<string, unknown>>;
            if (r.verdict?.verdict !== 'pass') return { pass: false, details: `Expected pass, got ${r.verdict?.verdict}` };
            return { pass: true, details: `Verdict: pass, confidence: ${r.verdict?.confidence}` };
        },
    },
    {
        name: 'us1-ai-judge',
        scenarioFile: 'us1-ai-judge.md',
        input: {
            scenario: readScenario('us1-ai-judge.md'),
            maxTurns: 3,
            maxBudgetUsd: 1.00,
        },
        checks: (results) => {
            if (results.length !== 2) return { pass: false, details: `Expected 2 results, got ${results.length}` };
            const verdicts = results.map((r: any) => r.verdict?.verdict);
            const allPass = verdicts.every((v: string) => v === 'pass');
            return {
                pass: allPass,
                details: `Verdicts: ${verdicts.join(', ')} (non-deterministic — both should be 'pass' for factual questions)`,
            };
        },
    },
    {
        name: 'us5-multi-step',
        scenarioFile: 'us5-multi-step.md',
        input: {
            scenario: readScenario('us5-multi-step.md'),
            maxTurns: 3,
            maxBudgetUsd: 1.00,
        },
        checks: (results) => {
            if (results.length !== 2) return { pass: false, details: `Expected 2 results, got ${results.length}` };
            const v0 = (results[0] as any).verdict?.verdict;
            const v1 = (results[1] as any).verdict?.verdict;
            const idx0 = (results[0] as any).testIndex;
            const idx1 = (results[1] as any).testIndex;
            if (idx0 !== 0 || idx1 !== 1) return { pass: false, details: `Wrong testIndex: ${idx0}, ${idx1}` };
            return {
                pass: v0 === 'pass' && v1 === 'pass',
                details: `Test 0: ${v0} (Jupiter), Test 1: ${v1} (Mercury)`,
            };
        },
    },
    {
        name: 'us6-env-vars',
        scenarioFile: 'us6-env-vars.md',
        input: {
            scenario: readScenario('us6-env-vars.md'),
            maxTurns: 5,
            maxBudgetUsd: 0.50,
            envVariables: { TEST_SECRET_KEY: 'secret-value-for-eval-test' },
        },
        checks: (results, kvFiles) => {
            if (results.length !== 1) return { pass: false, details: `Expected 1 result, got ${results.length}` };
            const v = (results[0] as any).verdict?.verdict;

            const logFile = kvFiles.find((f) => f.includes('CONVERSATION-LOG'));
            if (!logFile) return { pass: false, details: 'No CONVERSATION-LOG in KV store' };
            const logContent = readKvValue('CONVERSATION-LOG');
            const secretLeaked = logContent.includes('secret-value-for-eval-test');
            const masked = logContent.includes('***TEST_SECRET_KEY***');

            return {
                pass: v === 'pass' && !secretLeaked,
                details: `Verdict: ${v}, Secret in log: ${secretLeaked}, Masked: ${masked}`,
            };
        },
    },
    {
        name: 'us7-budget-abort',
        scenarioFile: 'us7-budget-abort.md',
        input: {
            scenario: readScenario('us7-budget-abort.md'),
            maxTurns: 20,
            maxBudgetUsd: 0.01,
        },
        checks: (results) => {
            if (results.length !== 1) return { pass: false, details: `Expected 1 result, got ${results.length}` };
            const r = results[0] as any;
            const abortedOrFailed = r.aborted === true || r.error != null || r.verdict?.verdict === 'fail';
            return {
                pass: abortedOrFailed,
                details: `Aborted: ${r.aborted}, Error: ${r.error}, Verdict: ${r.verdict?.verdict}, Cost: $${r.metrics?.totalCostUsd}`,
            };
        },
    },
];

// --- Runner ---

async function main() {
    const filter = process.argv[2];
    const toRun = filter
        ? tests.filter((t) => t.name.includes(filter))
        : tests;

    if (toRun.length === 0) {
        console.log(`No tests matching "${filter}". Available: ${tests.map((t) => t.name).join(', ')}`);
        process.exit(1);
    }

    console.log(`=== E2E Tests: ${toRun.length} test(s) ===\n`);
    console.log('WARNING: These tests call real claude CLI and cost real money.\n');

    const results: Array<{ name: string; pass: boolean; details: string; durationMs: number; cost: number }> = [];

    for (const test of toRun) {
        console.log(`--- ${test.name} ---`);
        const start = Date.now();

        const { code, output } = await runActor(test.input);
        const elapsed = Date.now() - start;

        const datasetItems = readDatasetItems();
        const kvFiles = readKvKeys();
        const totalCost = datasetItems.reduce((sum, r: any) => sum + (r.metrics?.totalCostUsd ?? 0), 0);

        if (code !== 0 && test.name !== 'us7-budget-abort') {
            console.log(`  FAIL (exit code ${code})`);
            console.log(`  Output: ${output.slice(-300)}\n`);
            results.push({ name: test.name, pass: false, details: `Exit code ${code}`, durationMs: elapsed, cost: 0 });
            continue;
        }

        const check = test.checks(datasetItems, kvFiles);
        console.log(`  ${check.pass ? 'PASS' : 'FAIL'}: ${check.details}`);
        console.log(`  Duration: ${(elapsed / 1000).toFixed(1)}s, Cost: $${totalCost.toFixed(4)}\n`);

        results.push({ name: test.name, pass: check.pass, details: check.details, durationMs: elapsed, cost: totalCost });
    }

    // Summary
    console.log('=== Summary ===');
    const passed = results.filter((r) => r.pass).length;
    const totalCost = results.reduce((sum, r) => sum + r.cost, 0);
    const totalDuration = results.reduce((sum, r) => sum + r.durationMs, 0);

    for (const r of results) {
        console.log(`  ${r.pass ? 'PASS' : 'FAIL'} ${r.name} (${(r.durationMs / 1000).toFixed(1)}s, $${r.cost.toFixed(4)})`);
    }

    console.log(`\n  Total: ${passed}/${results.length} passed, $${totalCost.toFixed(4)}, ${(totalDuration / 1000).toFixed(1)}s`);
    process.exit(passed === results.length ? 0 : 1);
}

main();
