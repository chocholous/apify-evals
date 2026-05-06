import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

import { parseScenario } from '../index.js';

const EXAMPLES_DIR = join(import.meta.dirname, '../../../examples');
const INPUT_SCHEMA_PATH = join(import.meta.dirname, '../../../actors/runner/.actor/input_schema.json');

const VALID_AGENTS = ['claude-code', 'codex', 'opencode'];
const VALID_PRESETS = ['none', 'mcp_native', 'cli_native', 'mcpc'];

const exampleFiles = readdirSync(EXAMPLES_DIR)
    .filter((f) => f.endsWith('.json'));

describe('example input files', () => {
    it('found at least one example file', () => {
        expect(exampleFiles.length).toBeGreaterThan(0);
    });

    it.each(exampleFiles)('%s is valid JSON with parseable scenario', (filename) => {
        const fullPath = join(EXAMPLES_DIR, filename);
        const raw = readFileSync(fullPath, 'utf-8');

        // Must be valid JSON
        const data = JSON.parse(raw);

        // Must have a scenario string
        expect(typeof data.scenario).toBe('string');
        expect(data.scenario.length).toBeGreaterThan(0);

        // Scenario must parse without errors
        const result = parseScenario(data.scenario);
        expect(result.meta.name).toBeTruthy();
        expect(result.tests.length).toBeGreaterThanOrEqual(1);

        // agent (if present) must be a known value
        if (data.agent !== undefined) {
            expect(VALID_AGENTS).toContain(data.agent);
        }

        // maxTurns (if present) must be a positive integer
        if (data.maxTurns !== undefined) {
            expect(Number.isInteger(data.maxTurns)).toBe(true);
            expect(data.maxTurns).toBeGreaterThan(0);
        }

        // maxBudgetUsd (if present) must be a positive number
        if (data.maxBudgetUsd !== undefined) {
            expect(typeof data.maxBudgetUsd).toBe('number');
            expect(data.maxBudgetUsd).toBeGreaterThan(0);
        }

        // initPreset (if present) must be a known value
        if (data.initPreset !== undefined) {
            expect(VALID_PRESETS).toContain(data.initPreset);
        }
    });
});

describe('input schema prefill scenario', () => {
    it('prefill scenario from input_schema.json parses correctly', () => {
        const raw = readFileSync(INPUT_SCHEMA_PATH, 'utf-8');
        const schema = JSON.parse(raw);

        const prefill = schema.properties?.scenario?.prefill;
        expect(typeof prefill).toBe('string');
        expect(prefill.length).toBeGreaterThan(0);

        const result = parseScenario(prefill);
        expect(result.meta.name).toBeTruthy();
        expect(result.tests.length).toBeGreaterThanOrEqual(1);

        for (const tc of result.tests) {
            expect(tc.test.trim().length).toBeGreaterThan(0);
            expect(tc.checkpoint.trim().length).toBeGreaterThan(0);
        }
    });
});
