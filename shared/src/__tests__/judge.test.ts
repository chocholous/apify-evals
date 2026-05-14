import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

import { parseCheckpointSection, judgeAllChecks } from '../judge.js';
import { parseScenario } from '../index.js';

describe('parseCheckpointSection — flat format', () => {
    it('parses single deterministic check', () => {
        const result = parseCheckpointSection('contains: Jupiter');
        expect(result.checks).toHaveLength(1);
        expect(result.checks[0].type).toBe('contains');
        expect(result.checks[0].value).toBe('Jupiter');
        expect(result.judges).toHaveLength(0);
    });

    it('parses multiple deterministic checks', () => {
        const result = parseCheckpointSection('contains: Jupiter\nregex: \\blargest\\b');
        expect(result.checks).toHaveLength(2);
        expect(result.checks[0].type).toBe('contains');
        expect(result.checks[1].type).toBe('regex');
        expect(result.judges).toHaveLength(0);
    });

    it('extracts LLM judge prompt from plain text', () => {
        const result = parseCheckpointSection('contains: Jupiter\n\nThe answer must be scientifically accurate.');
        expect(result.checks).toHaveLength(1);
        expect(result.checks[0].type).toBe('contains');
        expect(result.judges).toHaveLength(1);
        expect(result.judges[0].prompt).toBe('The answer must be scientifically accurate.');
        expect(result.judges[0].severity).toBe('fail');
    });

    it('pure plain text = only LLM judge', () => {
        const result = parseCheckpointSection('The answer must mention Rayleigh scattering.');
        expect(result.checks).toHaveLength(0);
        expect(result.judges).toHaveLength(1);
        expect(result.judges[0].prompt).toBe('The answer must mention Rayleigh scattering.');
    });

    it('"contains:" in plain text is NOT parsed as a check', () => {
        const result = parseCheckpointSection('The output contains: at least 3 items and a summary.');
        expect(result.checks).toHaveLength(0);
        expect(result.judges).toHaveLength(1);
        expect(result.judges[0].prompt).toBe('The output contains: at least 3 items and a summary.');
    });

    it('checks stop at first non-prefixed line', () => {
        const result = parseCheckpointSection('contains: Jupiter\nThe answer also contains: scientific facts.');
        expect(result.checks).toHaveLength(1);
        expect(result.checks[0].value).toBe('Jupiter');
        expect(result.judges).toHaveLength(1);
        expect(result.judges[0].prompt).toBe('The answer also contains: scientific facts.');
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
        expect(result.checks[0]).toEqual({ type: 'contains', value: 'Jupiter', severity: 'fail' });
        expect(result.checks[1]).toEqual({ type: 'regex', value: '\\blargest\\b', severity: 'fail' });
        expect(result.checks[2]).toEqual({ type: 'script', value: './validators/check.sh', severity: 'fail' });
        expect(result.judges).toHaveLength(1);
        expect(result.judges[0].prompt).toBe('The answer must be scientifically accurate.');
        expect(result.judges[0].severity).toBe('fail');
        expect(result.judges[0].model).toBeUndefined();
    });

    it('works with only ### Checks', () => {
        const checkpoint = `### Checks
contains: Mercury
regex: smallest`;

        const result = parseCheckpointSection(checkpoint);
        expect(result.checks).toHaveLength(2);
        expect(result.judges).toHaveLength(0);
    });

    it('works with only ### Judge', () => {
        const checkpoint = `### Judge
Evaluate the quality of the response.`;

        const result = parseCheckpointSection(checkpoint);
        expect(result.checks).toHaveLength(0);
        expect(result.judges).toHaveLength(1);
        expect(result.judges[0].prompt).toBe('Evaluate the quality of the response.');
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
        expect(result.judges).toHaveLength(1);
        expect(result.judges[0].prompt).toBe('Evaluate quality.');
    });

    it('parses multiple ### Judge blocks', () => {
        const checkpoint = `### Judge
Check code correctness.

### Judge
Verify error handling.`;

        const result = parseCheckpointSection(checkpoint);
        expect(result.judges).toHaveLength(2);
        expect(result.judges[0].prompt).toBe('Check code correctness.');
        expect(result.judges[1].prompt).toBe('Verify error handling.');
        expect(result.judges[0].severity).toBe('fail');
        expect(result.judges[1].severity).toBe('fail');
    });

    it('parses ### warn-Judge with warning severity', () => {
        const checkpoint = `### Judge
Must pass this.

### warn-Judge
Nice to have quality.`;

        const result = parseCheckpointSection(checkpoint);
        expect(result.judges).toHaveLength(2);
        expect(result.judges[0].severity).toBe('fail');
        expect(result.judges[1].severity).toBe('warning');
    });

    it('parses ### Judge (model) with explicit model', () => {
        const checkpoint = `### Judge (opus)
Deep analysis needed.

### Judge (haiku)
Quick binary check.`;

        const result = parseCheckpointSection(checkpoint);
        expect(result.judges).toHaveLength(2);
        expect(result.judges[0].model).toBe('claude-opus-4-6');
        expect(result.judges[0].prompt).toBe('Deep analysis needed.');
        expect(result.judges[1].model).toBe('claude-haiku-4-5-20251001');
        expect(result.judges[1].prompt).toBe('Quick binary check.');
    });

    it('parses ### warn-Judge (opus) combining severity and model', () => {
        const checkpoint = `### warn-Judge (opus)
Optional deep check.`;

        const result = parseCheckpointSection(checkpoint);
        expect(result.judges).toHaveLength(1);
        expect(result.judges[0].severity).toBe('warning');
        expect(result.judges[0].model).toBe('claude-opus-4-6');
        expect(result.judges[0].prompt).toBe('Optional deep check.');
    });

    it('passes through full model IDs', () => {
        const checkpoint = `### Judge (claude-sonnet-4-6)
Custom model check.`;

        const result = parseCheckpointSection(checkpoint);
        expect(result.judges).toHaveLength(1);
        expect(result.judges[0].model).toBe('claude-sonnet-4-6');
    });

    it('mixed checks, scripts, and multiple judges', () => {
        const checkpoint = `### Checks
contains: Jupiter

### Script
echo ok

### Judge
Check correctness.

### warn-Judge (haiku)
Check style.`;

        const result = parseCheckpointSection(checkpoint);
        expect(result.checks).toHaveLength(2);
        expect(result.judges).toHaveLength(2);
        expect(result.judges[0]).toEqual({ prompt: 'Check correctness.', severity: 'fail', model: undefined });
        expect(result.judges[1]).toEqual({ prompt: 'Check style.', severity: 'warning', model: 'claude-haiku-4-5-20251001' });
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
    });

    it('json-schema: extracts JSON from markdown code block', async () => {
        const schema = JSON.stringify({ type: 'object', required: ['name'] });
        const output = 'Here is the result:\n\n```json\n{"name": "extracted"}\n```\n\nDone!';
        const r = await judgeAllChecks(output, `json-schema: ${schema}`);
        expect(r.overallVerdict).toBe('pass');
    });

    it('json-schema: extracts JSON from surrounding text', async () => {
        const schema = JSON.stringify({ type: 'array', minItems: 2 });
        const output = 'The array is: [1, 2, 3] as you can see.';
        const r = await judgeAllChecks(output, `json-schema: ${schema}`);
        expect(r.overallVerdict).toBe('pass');
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

describe('checkpoint-syntax-demo.md — full syntax coverage', () => {
    const scenarioPath = join(import.meta.dirname, '../../../scenarios/checkpoint-syntax-demo.md');
    const scenario = parseScenario(readFileSync(scenarioPath, 'utf-8'));

    it('parses 3 tests', () => {
        expect(scenario.tests).toHaveLength(3);
    });

    it('test 1: flat format — deterministic checks + plain text judge', () => {
        const parsed = parseCheckpointSection(scenario.tests[0].checkpoint);
        expect(parsed.checks).toHaveLength(2);
        expect(parsed.checks[0]).toEqual({ type: 'contains', value: 'Jupiter', severity: 'fail' });
        expect(parsed.checks[1]).toEqual({ type: 'regex', value: '\\b(largest|biggest)\\b', severity: 'fail' });
        expect(parsed.judges).toHaveLength(1);
        expect(parsed.judges[0].severity).toBe('fail');
        expect(parsed.judges[0].model).toBeUndefined();
        expect(parsed.judges[0].prompt).toContain('gas giant');
    });

    it('test 2: subsections — all check types, script, 3 judge blocks with severity+model', () => {
        const parsed = parseCheckpointSection(scenario.tests[1].checkpoint);

        // ### Checks: contains, warn-contains, regex, warn-regex, json-schema
        expect(parsed.checks).toHaveLength(6); // 5 check lines + 1 script
        expect(parsed.checks[0]).toEqual({ type: 'contains', value: 'ok', severity: 'fail' });
        expect(parsed.checks[1]).toEqual({ type: 'contains', value: 'syntax-demo', severity: 'warning' });
        expect(parsed.checks[2]).toEqual({ type: 'regex', value: '"status"', severity: 'fail' });
        expect(parsed.checks[3]).toEqual({ type: 'regex', value: 'created|wrote', severity: 'warning' });
        expect(parsed.checks[4].type).toBe('json-schema');
        expect(parsed.checks[4].severity).toBe('fail');

        // ### Script
        expect(parsed.checks[5].type).toBe('script');
        expect(parsed.checks[5].value).toContain('jq -e');

        // 3 judge blocks
        expect(parsed.judges).toHaveLength(3);

        // ### Judge (default model, fail severity)
        expect(parsed.judges[0].severity).toBe('fail');
        expect(parsed.judges[0].model).toBeUndefined();

        // ### Judge (opus)
        expect(parsed.judges[1].severity).toBe('fail');
        expect(parsed.judges[1].model).toBe('claude-opus-4-6');

        // ### warn-Judge (haiku)
        expect(parsed.judges[2].severity).toBe('warning');
        expect(parsed.judges[2].model).toBe('claude-haiku-4-5-20251001');
    });

    it('test 3: subsections — jq checks with warn- prefix + warn-Judge without model', () => {
        const parsed = parseCheckpointSection(scenario.tests[2].checkpoint);

        expect(parsed.checks).toHaveLength(2);
        expect(parsed.checks[0]).toEqual(expect.objectContaining({ type: 'jq', severity: 'fail' }));
        expect(parsed.checks[1]).toEqual(expect.objectContaining({ type: 'jq', severity: 'warning' }));

        expect(parsed.judges).toHaveLength(1);
        expect(parsed.judges[0].severity).toBe('warning');
        expect(parsed.judges[0].model).toBeUndefined();
    });
});

describe('judgeAllChecks — jq', () => {
    const sampleEvents = [
        { type: 'assistant', message: { content: [
            { type: 'tool_use', name: 'Bash', input: { command: 'apify actors call apify/google-search-scraper -i {}' } },
            { type: 'text', text: 'Running scraper...' },
        ] } },
        { type: 'assistant', message: { content: [
            { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/results.json' } },
        ] } },
    ];

    it('jq: pass when expression returns truthy', async () => {
        const r = await judgeAllChecks('output', 'jq: . | length > 0', { events: sampleEvents });
        expect(r.overallVerdict).toBe('pass');
        expect(r.verdicts[0].checkType).toBe('jq');
    });

    it('jq: fail when expression returns false', async () => {
        const r = await judgeAllChecks('output', 'jq: . | length > 100', { events: sampleEvents });
        expect(r.overallVerdict).toBe('fail');
        expect(r.verdicts[0].checkType).toBe('jq');
    });

    it('jq: fail on invalid syntax', async () => {
        const r = await judgeAllChecks('output', 'jq: [invalid syntax!!!', { events: sampleEvents });
        expect(r.overallVerdict).toBe('fail');
    });

    it('jq: works with empty events', async () => {
        const r = await judgeAllChecks('output', 'jq: . | length == 0', { events: [] });
        expect(r.overallVerdict).toBe('pass');
    });

    it('warn-jq: produces warning not fail', async () => {
        const r = await judgeAllChecks('output', 'warn-jq: . | length > 100', { events: sampleEvents });
        expect(r.overallVerdict).toBe('warning');
        expect(r.verdicts[0].verdict).toBe('warning');
    });

    it('jq: matches tool calls by name', async () => {
        const r = await judgeAllChecks('output',
            'jq: [.[] | select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and .name=="Bash")] | length > 0',
            { events: sampleEvents },
        );
        expect(r.overallVerdict).toBe('pass');
    });

    it('jq: matches command patterns with regex', async () => {
        const r = await judgeAllChecks('output',
            'jq: [.[] | select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and .name=="Bash") | .input.command? // "" | select(test("apify (actors )?call"))] | length > 0',
            { events: sampleEvents },
        );
        expect(r.overallVerdict).toBe('pass');
    });

    it('jq: detects forbidden tool not used', async () => {
        const r = await judgeAllChecks('output',
            'jq: [.[] | select(.type=="assistant") | .message.content[]? | select(.type=="tool_use") | .name | select(test("^Web(Search|Fetch)$"))] | length == 0',
            { events: sampleEvents },
        );
        expect(r.overallVerdict).toBe('pass');
    });

    it('jq: detects forbidden tool used', async () => {
        const eventsWithWeb = [
            ...sampleEvents,
            { type: 'assistant', message: { content: [
                { type: 'tool_use', name: 'WebSearch', input: { query: 'test' } },
            ] } },
        ];
        const r = await judgeAllChecks('output',
            'jq: [.[] | select(.type=="assistant") | .message.content[]? | select(.type=="tool_use") | .name | select(test("^Web(Search|Fetch)$"))] | length == 0',
            { events: eventsWithWeb },
        );
        expect(r.overallVerdict).toBe('fail');
    });
});
