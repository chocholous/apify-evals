import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { judgeAllChecks, hasSdkApiKey } from '../index.js';

describe('hasSdkApiKey', () => {
    const originalEnv = process.env.ANTHROPIC_API_KEY;

    afterEach(() => {
        // Restore original env
        if (originalEnv !== undefined) {
            process.env.ANTHROPIC_API_KEY = originalEnv;
        } else {
            delete process.env.ANTHROPIC_API_KEY;
        }
    });

    it('returns true when key is in env param', () => {
        delete process.env.ANTHROPIC_API_KEY;
        expect(hasSdkApiKey({ ANTHROPIC_API_KEY: 'sk-test-123' })).toBe(true);
    });

    it('returns true when key is in process.env', () => {
        process.env.ANTHROPIC_API_KEY = 'sk-test-456';
        expect(hasSdkApiKey()).toBe(true);
    });

    it('returns true when key is in process.env and env param is empty', () => {
        process.env.ANTHROPIC_API_KEY = 'sk-test-789';
        expect(hasSdkApiKey({})).toBe(true);
    });

    it('returns false when no key anywhere', () => {
        delete process.env.ANTHROPIC_API_KEY;
        expect(hasSdkApiKey()).toBe(false);
    });

    it('returns false when env param is empty and process.env has no key', () => {
        delete process.env.ANTHROPIC_API_KEY;
        expect(hasSdkApiKey({})).toBe(false);
    });

    it('env param takes priority over process.env', () => {
        process.env.ANTHROPIC_API_KEY = 'sk-process';
        expect(hasSdkApiKey({ ANTHROPIC_API_KEY: 'sk-param' })).toBe(true);
    });

    it('returns false for empty string key in env param', () => {
        delete process.env.ANTHROPIC_API_KEY;
        expect(hasSdkApiKey({ ANTHROPIC_API_KEY: '' })).toBe(false);
    });
});

describe('judgeAllChecks with judgeMode — deterministic checks', () => {
    it('judgeMode=cli works for contains check', async () => {
        const r = await judgeAllChecks('The capital of France is Paris.', 'contains: Paris', { judgeMode: 'cli' });
        expect(r.overallVerdict).toBe('pass');
        expect(r.verdicts).toHaveLength(1);
        expect(r.verdicts[0].checkType).toBe('contains');
        expect(r.verdicts[0].verdict).toBe('pass');
        expect(r.verdicts[0].confidence).toBe(1.0);
    });

    it('judgeMode=sdk works for contains check', async () => {
        const r = await judgeAllChecks('The capital of France is Paris.', 'contains: Paris', { judgeMode: 'sdk' });
        expect(r.overallVerdict).toBe('pass');
        expect(r.verdicts).toHaveLength(1);
        expect(r.verdicts[0].checkType).toBe('contains');
    });

    it('judgeMode=auto works for contains check', async () => {
        const r = await judgeAllChecks('The capital of France is Paris.', 'contains: Paris', { judgeMode: 'auto' });
        expect(r.overallVerdict).toBe('pass');
        expect(r.verdicts).toHaveLength(1);
        expect(r.verdicts[0].checkType).toBe('contains');
    });

    it('judgeMode=cli works for regex check', async () => {
        const r = await judgeAllChecks('Issue #1234 found.', 'regex: #\\d{4}', { judgeMode: 'cli' });
        expect(r.overallVerdict).toBe('pass');
        expect(r.verdicts[0].checkType).toBe('regex');
    });

    it('judgeMode=sdk works for regex check', async () => {
        const r = await judgeAllChecks('Issue #1234 found.', 'regex: #\\d{4}', { judgeMode: 'sdk' });
        expect(r.overallVerdict).toBe('pass');
        expect(r.verdicts[0].checkType).toBe('regex');
    });

    it('only deterministic checks — no LLM judge called regardless of mode', async () => {
        const checkpoint = 'contains: Jupiter\nregex: largest';
        const r = await judgeAllChecks('Jupiter is the largest planet.', checkpoint, { judgeMode: 'cli' });
        expect(r.overallVerdict).toBe('pass');
        expect(r.verdicts).toHaveLength(2);
        // All verdicts are deterministic, no llm-judge verdict present
        expect(r.verdicts.every((v) => v.checkType !== 'llm-judge')).toBe(true);
    });

    it('only deterministic checks with sdk mode — still no LLM judge', async () => {
        const checkpoint = 'contains: Jupiter\nregex: largest';
        const r = await judgeAllChecks('Jupiter is the largest planet.', checkpoint, { judgeMode: 'sdk' });
        expect(r.overallVerdict).toBe('pass');
        expect(r.verdicts).toHaveLength(2);
        expect(r.verdicts.every((v) => v.checkType !== 'llm-judge')).toBe(true);
    });

    it('mixed deterministic checks all pass — overall pass', async () => {
        const checkpoint = 'contains: hello\nregex: \\bworld\\b';
        const r = await judgeAllChecks('hello world', checkpoint, { judgeMode: 'auto' });
        expect(r.overallVerdict).toBe('pass');
        expect(r.verdicts).toHaveLength(2);
        expect(r.verdicts[0].verdict).toBe('pass');
        expect(r.verdicts[1].verdict).toBe('pass');
    });

    it('deterministic check fails — overall fail regardless of mode', async () => {
        const r = await judgeAllChecks('no match here', 'contains: Jupiter', { judgeMode: 'sdk' });
        expect(r.overallVerdict).toBe('fail');
        expect(r.verdicts[0].verdict).toBe('fail');
    });

    it('json-schema check works with any judgeMode', async () => {
        const schema = JSON.stringify({ type: 'object', required: ['name'] });
        const r = await judgeAllChecks('{"name": "test"}', `json-schema: ${schema}`, { judgeMode: 'cli' });
        expect(r.overallVerdict).toBe('pass');
    });
});
