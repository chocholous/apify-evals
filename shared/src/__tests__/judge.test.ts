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

    it('detects script: prefix', () => {
        const spec = parseCheckpoint('script: ./check.sh');
        expect(spec.type).toBe('script');
        expect(spec.value).toBe('./check.sh');
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

    it('json-schema: validates against schema — pass', async () => {
        const schema = JSON.stringify({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'] });
        const v = await judgeCheckpoint('{"name": "test"}', `json-schema: ${schema}`);
        expect(v.verdict).toBe('pass');
        expect(v.confidence).toBe(1.0);
    });

    it('json-schema: validates against schema — fail', async () => {
        const schema = JSON.stringify({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'] });
        const v = await judgeCheckpoint('{"age": 30}', `json-schema: ${schema}`);
        expect(v.verdict).toBe('fail');
        expect(v.evidence).toContain('required');
    });

    it('json-schema: invalid schema definition', async () => {
        const v = await judgeCheckpoint('{"a":1}', 'json-schema: not-valid-json');
        expect(v.verdict).toBe('fail');
        expect(v.evidence).toContain('Invalid JSON schema definition');
    });
});

describe('judgeCheckpoint — script', () => {
    it('script: pass on exit 0', async () => {
        const v = await judgeCheckpoint('hello world', 'script: grep -q "hello"');
        expect(v.verdict).toBe('pass');
        expect(v.confidence).toBe(1.0);
    });

    it('script: fail on exit non-zero', async () => {
        const v = await judgeCheckpoint('hello world', 'script: grep -q "missing"');
        expect(v.verdict).toBe('fail');
        expect(v.confidence).toBe(1.0);
    });

    it('script: stdout as evidence on pass', async () => {
        const v = await judgeCheckpoint('42', 'script: echo "value is $(cat)"');
        expect(v.verdict).toBe('pass');
        expect(v.evidence).toBe('value is 42');
    });

    it('script: multi-line script', async () => {
        const script = `
value=$(cat)
if [ "$value" = "expected" ]; then
  echo "correct"
  exit 0
else
  echo "got: $value"
  exit 1
fi`;
        const v = await judgeCheckpoint('expected', `script: ${script}`);
        expect(v.verdict).toBe('pass');
        expect(v.evidence).toBe('correct');
    });

    it('script: fail with stderr as evidence', async () => {
        const v = await judgeCheckpoint('data', 'script: echo "wrong" >&2; exit 1');
        expect(v.verdict).toBe('fail');
        expect(v.evidence).toContain('wrong');
    });

    it('script: timeout produces fail', async () => {
        const v = await judgeCheckpoint('data', 'script: sleep 10', { scriptTimeoutMs: 100 });
        expect(v.verdict).toBe('fail');
        expect(v.evidence).toContain('timed out');
    });
});
