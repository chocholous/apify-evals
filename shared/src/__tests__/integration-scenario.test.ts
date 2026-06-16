import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runAgent } from '../agents/run.js';
import { judgeAllChecks } from '../judge.js';
import { parseScenario } from '../scenario-parser.js';
import { claudeAvailable } from './_claude-available.js';
import type { AgentResult } from '../types.js';

// Tests that spawn the real `claude` binary (billable, live API) are guarded
// with `it.skipIf` so they skip when the binary isn't on PATH (e.g. CI). The
// parse-only tests in each suite still run everywhere.
const HAS_CLAUDE = claudeAvailable();

const SCENARIOS_DIR = join(import.meta.dirname, '../../../scenarios');

describe('integration: multi-check-demo scenario', () => {
    const scenarioMd = readFileSync(join(SCENARIOS_DIR, 'multi-check-demo.md'), 'utf-8');
    const { meta, tests } = parseScenario(scenarioMd);

    it('parses correctly', () => {
        expect(meta.name).toBe('multi-check-demo');
        expect(tests).toHaveLength(2);
    });

    it.skipIf(!HAS_CLAUDE)('test 1: Jupiter question with multi-check', async () => {
        const result = await runAgent({
            agent: 'claude-code',
            prompt: tests[0].test,
            maxTurns: 1,
            maxBudgetUsd: 0.50,
        });

        expect(result.error).toBeNull();
        expect(result.text.toLowerCase()).toContain('jupiter');

        const judgeResult = await judgeAllChecks(result.text, tests[0].checkpoint);

        // Should have: contains + regex + llm-judge
        expect(judgeResult.verdicts.length).toBeGreaterThanOrEqual(2);

        const containsVerdict = judgeResult.verdicts.find((v) => v.checkType === 'contains');
        expect(containsVerdict?.verdict).toBe('pass');

        const regexVerdict = judgeResult.verdicts.find((v) => v.checkType === 'regex');
        expect(regexVerdict?.verdict).toBe('pass');

        // LLM judge is non-deterministic — only check deterministic checks pass
        const deterministicVerdicts = judgeResult.verdicts.filter((v) => v.checkType !== 'llm-judge');
        expect(deterministicVerdicts.every((v) => v.verdict === 'pass')).toBe(true);
    }, 60_000);

    it.skipIf(!HAS_CLAUDE)('test 2: file creation with script + json-schema + llm-judge', async () => {
        const result = await runAgent({
            agent: 'claude-code',
            prompt: tests[1].test,
            maxTurns: 5,
            maxBudgetUsd: 0.50,
        });

        expect(result.error).toBeNull();

        // Should have used tools
        expect(result.trajectory.toolCallCount).toBeGreaterThan(0);

        const judgeResult = await judgeAllChecks(result.text, tests[1].checkpoint);

        // Should have: contains + json-schema + script + llm-judge
        expect(judgeResult.verdicts.length).toBeGreaterThanOrEqual(3);

        const schemaVerdict = judgeResult.verdicts.find((v) => v.checkType === 'json-schema');
        const scriptVerdict = judgeResult.verdicts.find((v) => v.checkType === 'script');
        const llmVerdict = judgeResult.verdicts.find((v) => v.checkType === 'llm-judge');

        // Log for debugging (won't fail test)
        console.log('Schema:', schemaVerdict?.verdict, schemaVerdict?.evidence.slice(0, 80));
        console.log('Script:', scriptVerdict?.verdict, scriptVerdict?.evidence.slice(0, 80));
        console.log('LLM:', llmVerdict?.verdict, llmVerdict?.evidence?.slice(0, 80));

        // Script should pass if agent created file correctly
        expect(scriptVerdict).toBeDefined();
    }, 90_000);
});

describe('integration: trajectory-test scenario', () => {
    const scenarioMd = readFileSync(join(SCENARIOS_DIR, 'trajectory-test.md'), 'utf-8');
    const { meta, tests } = parseScenario(scenarioMd);

    it('parses correctly', () => {
        expect(meta.name).toBe('trajectory-test');
        expect(meta.abortOnFailure).toBe(true);
        expect(tests).toHaveLength(2);
    });

    it.skipIf(!HAS_CLAUDE)('captures rich trajectory data', async () => {
        const result = await runAgent({
            agent: 'claude-code',
            prompt: tests[0].test,
            maxTurns: 5,
            maxBudgetUsd: 0.50,
        });

        expect(result.error).toBeNull();

        // Must have used tools
        expect(result.trajectory.toolCallCount).toBeGreaterThan(0);
        expect(result.trajectory.uniqueToolsUsed.length).toBeGreaterThan(0);

        // Should have created files
        const createdOrModified = [...result.trajectory.filesCreated, ...result.trajectory.filesModified];
        expect(createdOrModified.length).toBeGreaterThan(0);

        // Should have executed commands
        expect(result.trajectory.commandsExecuted.length).toBeGreaterThan(0);

        // Per-turn data populated
        expect(result.trajectory.perTurnTokens.length).toBeGreaterThan(0);
        expect(result.trajectory.perTurnToolCalls.length).toBeGreaterThan(0);

        // Efficiency metrics computed
        expect(result.efficiency.tokensPerTurn).toBeGreaterThan(0);
        expect(result.efficiency.avgTurnDurationMs).toBeGreaterThan(0);

        // Script checkpoint passes
        const judgeResult = await judgeAllChecks(result.text, tests[0].checkpoint);
        const scriptVerdict = judgeResult.verdicts.find((v) => v.checkType === 'script');
        expect(scriptVerdict?.verdict).toBe('pass');
    }, 90_000);
});
