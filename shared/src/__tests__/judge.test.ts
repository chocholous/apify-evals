import { describe, it, expect } from 'vitest';

import { parseCheckpoint } from '../judge.js';

describe('parseCheckpoint', () => {
    it('detects contains: prefix', () => {
        const spec = parseCheckpoint('contains: Paris');
        expect(spec.type).toBe('contains');
        expect(spec.value).toBe('Paris');
    });

    it('detects regex: prefix', () => {
        const spec = parseCheckpoint('regex: \\d{4}');
        expect(spec.type).toBe('regex');
        expect(spec.value).toBe('\\d{4}');
    });

    it('detects json-schema: prefix', () => {
        const spec = parseCheckpoint('json-schema: {}');
        expect(spec.type).toBe('json-schema');
        expect(spec.value).toBe('{}');
    });

    it('defaults to llm-judge for plain text', () => {
        const spec = parseCheckpoint('The answer mentions Paris as the capital.');
        expect(spec.type).toBe('llm-judge');
        expect(spec.value).toBe('The answer mentions Paris as the capital.');
    });
});

// Deterministic judge tests via judgeCheckpoint with non-LLM types
// LLM judge tests require live claude CLI — covered by integration/E2E tests
import { judgeCheckpoint } from '../judge.js';

describe('judgeCheckpoint — deterministic', () => {
    it('contains: pass', async () => {
        const v = await judgeCheckpoint('The capital of France is Paris.', 'contains: Paris');
        expect(v.verdict).toBe('pass');
        expect(v.confidence).toBe(1.0);
    });

    it('contains: fail', async () => {
        const v = await judgeCheckpoint('The capital of France is Lyon.', 'contains: Paris');
        expect(v.verdict).toBe('fail');
    });

    it('contains: case insensitive', async () => {
        const v = await judgeCheckpoint('PARIS is the capital.', 'contains: paris');
        expect(v.verdict).toBe('pass');
    });

    it('regex: pass', async () => {
        const v = await judgeCheckpoint('Issue #1234 found.', 'regex: #\\d{4}');
        expect(v.verdict).toBe('pass');
    });

    it('regex: fail', async () => {
        const v = await judgeCheckpoint('No issues found.', 'regex: #\\d{4}');
        expect(v.verdict).toBe('fail');
    });

    it('regex: invalid regex', async () => {
        const v = await judgeCheckpoint('test', 'regex: [invalid');
        expect(v.verdict).toBe('fail');
        expect(v.evidence).toContain('Invalid regex');
    });

    it('json-schema: valid json pass', async () => {
        const v = await judgeCheckpoint('{"name": "test"}', 'json-schema: {}');
        expect(v.verdict).toBe('pass');
    });

    it('json-schema: invalid json fail', async () => {
        const v = await judgeCheckpoint('not json at all', 'json-schema: {}');
        expect(v.verdict).toBe('fail');
    });
});
