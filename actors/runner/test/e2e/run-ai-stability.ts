/**
 * Non-deterministic AI stability test.
 *
 * Runs the same scenario N times and measures:
 * - Pass rate (should be ≥80% for a well-formed scenario)
 * - Verdict consistency
 * - Cost variance
 * - Duration variance
 *
 * Usage: npx tsx test/e2e/run-ai-stability.ts [N] [scenario]
 *   Default: N=3, scenario=ai-nondeterministic.md
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = resolve(__dirname, '../..');
const SCENARIOS_DIR = resolve(RUNNER_DIR, '../../scenarios');
const STORAGE_DIR = resolve(RUNNER_DIR, 'storage');

function readDatasetItems(): Record<string, unknown>[] {
    const datasetDir = resolve(STORAGE_DIR, 'datasets/default');
    if (!existsSync(datasetDir)) return [];
    return readdirSync(datasetDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => JSON.parse(readFileSync(resolve(datasetDir, f), 'utf-8')));
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
        child.on('close', (code) => res({ code: code ?? 1, output }));
    });
}

interface RunResult {
    runIndex: number;
    verdicts: string[];
    totalCost: number;
    durationMs: number;
    testDetails: Array<{ test: string; verdict: string; confidence: number; evidence: string }>;
}

async function main() {
    const N = parseInt(process.argv[2] ?? '3', 10);
    const scenarioFile = process.argv[3] ?? 'ai-nondeterministic.md';
    const scenario = readFileSync(resolve(SCENARIOS_DIR, scenarioFile), 'utf-8');

    console.log(`=== AI Stability Test: ${scenarioFile} × ${N} runs ===\n`);
    console.log('WARNING: This test calls real claude CLI N times and costs real money.\n');

    const runs: RunResult[] = [];

    for (let i = 0; i < N; i++) {
        console.log(`--- Run ${i + 1}/${N} ---`);
        const start = Date.now();

        await runActor({
            scenario,
            maxTurns: 10,
            maxBudgetUsd: 0.50,
        });

        const elapsed = Date.now() - start;
        const items = readDatasetItems();

        const verdicts = items.map((r: any) => r.verdict?.verdict ?? 'error');
        const totalCost = items.reduce((sum: number, r: any) => sum + (r.metrics?.totalCostUsd ?? 0), 0);
        const testDetails = items.map((r: any) => ({
            test: (r.testPrompt ?? '').slice(0, 60),
            verdict: r.verdict?.verdict ?? 'error',
            confidence: r.verdict?.confidence ?? 0,
            evidence: (r.verdict?.evidence ?? '').slice(0, 100),
        }));

        console.log(`  Verdicts: ${verdicts.join(', ')} | Cost: $${totalCost.toFixed(4)} | Duration: ${(elapsed / 1000).toFixed(1)}s`);
        for (const d of testDetails) {
            console.log(`    "${d.test}..." → ${d.verdict} (${d.confidence}) — ${d.evidence}...`);
        }

        runs.push({ runIndex: i, verdicts, totalCost, durationMs: elapsed, testDetails });
        console.log();
    }

    // Analysis
    console.log('=== Stability Analysis ===\n');

    const allVerdicts = runs.flatMap((r) => r.verdicts);
    const passCount = allVerdicts.filter((v) => v === 'pass').length;
    const totalVerdicts = allVerdicts.length;
    const passRate = passCount / totalVerdicts;

    const costs = runs.map((r) => r.totalCost);
    const durations = runs.map((r) => r.durationMs);

    const avgCost = costs.reduce((a, b) => a + b, 0) / costs.length;
    const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;

    const costStdDev = Math.sqrt(costs.reduce((sum, c) => sum + (c - avgCost) ** 2, 0) / costs.length);
    const durationStdDev = Math.sqrt(durations.reduce((sum, d) => sum + (d - avgDuration) ** 2, 0) / durations.length);

    // Per-test stability
    const testCount = runs[0]?.verdicts.length ?? 0;
    console.log('Per-test pass rate:');
    for (let t = 0; t < testCount; t++) {
        const testVerdicts = runs.map((r) => r.verdicts[t] ?? 'error');
        const testPass = testVerdicts.filter((v) => v === 'pass').length;
        const testPrompt = runs[0]?.testDetails[t]?.test ?? '?';
        console.log(`  Test ${t}: ${testPass}/${N} (${((testPass / N) * 100).toFixed(0)}%) — "${testPrompt}..."`);
    }

    console.log(`\nOverall pass rate: ${passCount}/${totalVerdicts} (${(passRate * 100).toFixed(0)}%)`);
    console.log(`Cost: $${avgCost.toFixed(4)} ± $${costStdDev.toFixed(4)}`);
    console.log(`Duration: ${(avgDuration / 1000).toFixed(1)}s ± ${(durationStdDev / 1000).toFixed(1)}s`);

    const stable = passRate >= 0.8;
    console.log(`\n=== ${stable ? 'STABLE' : 'UNSTABLE'} (threshold: ≥80% pass rate) ===`);

    if (!stable) {
        console.log('\nFailing tests:');
        for (const run of runs) {
            for (let t = 0; t < run.verdicts.length; t++) {
                if (run.verdicts[t] !== 'pass') {
                    console.log(`  Run ${run.runIndex}, Test ${t}: ${run.verdicts[t]} — ${run.testDetails[t]?.evidence}`);
                }
            }
        }
    }

    process.exit(stable ? 0 : 1);
}

main();
