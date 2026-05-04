import { describe, it, expect } from 'vitest';

import { parseCheckpoint, parseCheckpointSection, judgeAllChecks } from '../judge.js';

describe('parseCheckpoint (legacy single-line)', () => {
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

describe('parseCheckpointSection — flat format', () => {
    it('parses single deterministic check', () => {
        const result = parseCheckpointSection('contains: Jupiter');
        expect(result.checks).toHaveLength(1);
        expect(result.checks[0].type).toBe('contains');
        expect(result.checks[0].value).toBe('Jupiter');
        expect(result.judgePrompt).toBeNull();
    });

    it('parses multiple deterministic checks', () => {
        const result = parseCheckpointSection('contains: Jupiter\nregex: \\blargest\\b');
        expect(result.checks).toHaveLength(2);
        expect(result.checks[0].type).toBe('contains');
        expect(result.checks[1].type).toBe('regex');
        expect(result.judgePrompt).toBeNull();
    });

    it('extracts LLM judge prompt from plain text', () => {
        const result = parseCheckpointSection('contains: Jupiter\n\nThe answer must be scientifically accurate.');
        expect(result.checks).toHaveLength(1);
        expect(result.checks[0].type).toBe('contains');
        expect(result.judgePrompt).toBe('The answer must be scientifically accurate.');
    });

    it('pure plain text = only LLM judge', () => {
        const result = parseCheckpointSection('The answer must mention Rayleigh scattering.');
        expect(result.checks).toHaveLength(0);
        expect(result.judgePrompt).toBe('The answer must mention Rayleigh scattering.');
    });

    it('"contains:" in plain text is NOT parsed as a check', () => {
        const result = parseCheckpointSection('The output contains: at least 3 items and a summary.');
        expect(result.checks).toHaveLength(0);
        expect(result.judgePrompt).toBe('The output contains: at least 3 items and a summary.');
    });

    it('checks stop at first non-prefixed line', () => {
        const result = parseCheckpointSection('contains: Jupiter\nThe answer also contains: scientific facts.');
        expect(result.checks).toHaveLength(1);
        expect(result.checks[0].value).toBe('Jupiter');
        expect(result.judgePrompt).toBe('The answer also contains: scientific facts.');
    });

    it('script: in flat format', () => {
        const result = parseCheckpointSection('contains: ok\nscript: jq -e .status');
        expect(result.checks).toHaveLength(2);
        expect(result.checks[0].type).toBe('contains');
        expect(result.checks[1].type).toBe('script');
        expect(result.checks[1].value).toBe('jq -e .status');
    });
});

describe('parseCheckpointSection — subsection format', () => {
    it('parses ### Checks, ### Script, ### Judge', () => {
        const checkpoint = `### Checks
contains: Jupiter
regex: \\blargest\\b

### Script
./validators/check.sh

### Judge
The answer must be scientifically accurate.`;

        const result = parseCheckpointSection(checkpoint);
        expect(result.checks).toHaveLength(3);
        expect(result.checks[0]).toEqual({ type: 'contains', value: 'Jupiter' });
        expect(result.checks[1]).toEqual({ type: 'regex', value: '\\blargest\\b' });
        expect(result.checks[2]).toEqual({ type: 'script', value: './validators/check.sh' });
        expect(result.judgePrompt).toBe('The answer must be scientifically accurate.');
    });

    it('works with only ### Checks', () => {
        const checkpoint = `### Checks
contains: Mercury
regex: smallest`;

        const result = parseCheckpointSection(checkpoint);
        expect(result.checks).toHaveLength(2);
        expect(result.judgePrompt).toBeNull();
    });

    it('works with only ### Judge', () => {
        const checkpoint = `### Judge
Evaluate the quality of the response.`;

        const result = parseCheckpointSection(checkpoint);
        expect(result.checks).toHaveLength(0);
        expect(result.judgePrompt).toBe('Evaluate the quality of the response.');
    });

    it('accepts singular ### Check', () => {
        const checkpoint = `### Check
contains: Jupiter`;

        const result = parseCheckpointSection(checkpoint);
        expect(result.checks).toHaveLength(1);
        expect(result.checks[0].type).toBe('contains');
    });

    it('accepts ### Scripts (plural)', () => {
        const checkpoint = `### Scripts
echo "ok"`;

        const result = parseCheckpointSection(checkpoint);
        expect(result.checks).toHaveLength(1);
        expect(result.checks[0].type).toBe('script');
    });

    it('case-insensitive subsection headers', () => {
        const checkpoint = `### CHECKS
contains: test

### JUDGE
Evaluate quality.`;

        const result = parseCheckpointSection(checkpoint);
        expect(result.checks).toHaveLength(1);
        expect(result.judgePrompt).toBe('Evaluate quality.');
    });
});

describe('judgeAllChecks — deterministic', () => {
    it('contains: pass', async () => {
        const r = await judgeAllChecks('The capital of France is Paris.', 'contains: Paris');
        expect(r.overallVerdict).toBe('pass');
        expect(r.verdicts).toHaveLength(1);
        expect(r.verdicts[0].checkType).toBe('contains');
        expect(r.verdicts[0].verdict).toBe('pass');
    });

    it('contains: fail', async () => {
        const r = await judgeAllChecks('The capital of France is Lyon.', 'contains: Paris');
        expect(r.overallVerdict).toBe('fail');
    });

    it('contains: case insensitive', async () => {
        const r = await judgeAllChecks('PARIS is the capital.', 'contains: paris');
        expect(r.overallVerdict).toBe('pass');
    });

    it('regex: pass', async () => {
        const r = await judgeAllChecks('Issue #1234 found.', 'regex: #\\d{4}');
        expect(r.overallVerdict).toBe('pass');
    });

    it('regex: fail', async () => {
        const r = await judgeAllChecks('No issues found.', 'regex: #\\d{4}');
        expect(r.overallVerdict).toBe('fail');
    });

    it('regex: invalid regex', async () => {
        const r = await judgeAllChecks('test', 'regex: [invalid');
        expect(r.overallVerdict).toBe('fail');
        expect(r.verdicts[0].evidence).toContain('Invalid regex');
    });

    it('json-schema: valid json pass (empty schema)', async () => {
        const r = await judgeAllChecks('{"name": "test"}', 'json-schema: {}');
        expect(r.overallVerdict).toBe('pass');
    });

    it('json-schema: invalid json fail', async () => {
        const r = await judgeAllChecks('not json at all', 'json-schema: {}');
        expect(r.overallVerdict).toBe('fail');
    });

    it('json-schema: validates against schema — pass', async () => {
        const schema = JSON.stringify({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'] });
        const r = await judgeAllChecks('{"name": "test"}', `json-schema: ${schema}`);
        expect(r.overallVerdict).toBe('pass');
        expect(r.verdicts[0].confidence).toBe(1.0);
    });

    it('json-schema: validates against schema — fail', async () => {
        const schema = JSON.stringify({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'] });
        const r = await judgeAllChecks('{"age": 30}', `json-schema: ${schema}`);
        expect(r.overallVerdict).toBe('fail');
        expect(r.verdicts[0].evidence).toContain('required');
    });

    it('json-schema: invalid schema definition', async () => {
        const r = await judgeAllChecks('{"a":1}', 'json-schema: not-valid-json');
        expect(r.overallVerdict).toBe('fail');
        expect(r.verdicts[0].evidence).toContain('Invalid JSON schema definition');
    });
});

describe('judgeAllChecks — script', () => {
    it('script: pass on exit 0', async () => {
        const r = await judgeAllChecks('hello world', 'script: grep -q "hello"');
        expect(r.overallVerdict).toBe('pass');
        expect(r.verdicts[0].checkType).toBe('script');
        expect(r.verdicts[0].confidence).toBe(1.0);
    });

    it('script: fail on exit non-zero', async () => {
        const r = await judgeAllChecks('hello world', 'script: grep -q "missing"');
        expect(r.overallVerdict).toBe('fail');
    });

    it('script: stdout as evidence on pass', async () => {
        const r = await judgeAllChecks('42', 'script: echo "value is $(cat)"');
        expect(r.overallVerdict).toBe('pass');
        expect(r.verdicts[0].evidence).toBe('value is 42');
    });

    it('script: multi-line script via subsections', async () => {
        const checkpoint = `### Script
value=$(cat)
if [ "$value" = "expected" ]; then
  echo "correct"
  exit 0
else
  echo "got: $value"
  exit 1
fi`;
        const r = await judgeAllChecks('expected', checkpoint);
        expect(r.overallVerdict).toBe('pass');
        expect(r.verdicts[0].checkType).toBe('script');
        expect(r.verdicts[0].evidence).toBe('correct');
    });

    it('script: fail with stderr as evidence', async () => {
        const r = await judgeAllChecks('data', 'script: echo "wrong" >&2; exit 1');
        expect(r.overallVerdict).toBe('fail');
        expect(r.verdicts[0].evidence).toContain('wrong');
    });

    it('script: timeout produces fail', async () => {
        const r = await judgeAllChecks('data', 'script: sleep 10', { scriptTimeoutMs: 100 });
        expect(r.overallVerdict).toBe('fail');
        expect(r.verdicts[0].evidence).toContain('timed out');
    });
});

describe('judgeAllChecks — multiple checks', () => {
    it('all pass → overall pass', async () => {
        const checkpoint = 'contains: Jupiter\nregex: largest';
        const r = await judgeAllChecks('Jupiter is the largest planet.', checkpoint);
        expect(r.overallVerdict).toBe('pass');
        expect(r.verdicts).toHaveLength(2);
        expect(r.verdicts[0].verdict).toBe('pass');
        expect(r.verdicts[1].verdict).toBe('pass');
    });

    it('one fails → overall fail', async () => {
        const checkpoint = 'contains: Jupiter\nregex: smallest';
        const r = await judgeAllChecks('Jupiter is the largest planet.', checkpoint);
        expect(r.overallVerdict).toBe('fail');
        expect(r.verdicts[0].verdict).toBe('pass');
        expect(r.verdicts[1].verdict).toBe('fail');
    });

    it('mixed checks with script', async () => {
        const checkpoint = 'contains: hello\nscript: grep -q "hello"';
        const r = await judgeAllChecks('hello world', checkpoint);
        expect(r.overallVerdict).toBe('pass');
        expect(r.verdicts).toHaveLength(2);
    });

    it('empty checkpoint → unclear overall', async () => {
        const r = await judgeAllChecks('some output', '');
        expect(r.overallVerdict).toBe('unclear');
        expect(r.verdicts).toHaveLength(0);
    });
});
