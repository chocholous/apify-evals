import { describe, it, expect } from 'vitest';

import { parseScenario, ScenarioParseError } from '../scenario-parser.js';

describe('parseScenario', () => {
    it('parses single test with all sections', () => {
        const md = `---
name: simple
description: A simple test
abortOnFailure: false
---

## Test
What is 2+2?

## Checkpoint
The answer is 4.

## Monitor
Return tool call count.
`;
        const result = parseScenario(md);

        expect(result.meta.name).toBe('simple');
        expect(result.meta.description).toBe('A simple test');
        expect(result.meta.abortOnFailure).toBe(false);
        expect(result.tests).toHaveLength(1);
        expect(result.tests[0].test).toBe('What is 2+2?');
        expect(result.tests[0].checkpoint).toBe('The answer is 4.');
        expect(result.tests[0].monitor).toBe('Return tool call count.');
    });

    it('parses multi-step scenario with mixed monitors', () => {
        const md = `---
name: multi-step
description: Three steps
abortOnFailure: true
---

## Test
Step 1: Do something.

## Checkpoint
Something was done.

## Monitor
Return JSON.

---

## Test
Step 2: Do another thing.

## Checkpoint
Another thing was done.

---

## Test
Step 3: Final step.

## Checkpoint
Final check.

## Monitor
Return final JSON.
`;
        const result = parseScenario(md);

        expect(result.meta.name).toBe('multi-step');
        expect(result.meta.abortOnFailure).toBe(true);
        expect(result.tests).toHaveLength(3);

        expect(result.tests[0].monitor).toBe('Return JSON.');
        expect(result.tests[1].monitor).toBeNull();
        expect(result.tests[2].monitor).toBe('Return final JSON.');
    });

    it('handles minimal scenario without optional fields', () => {
        const md = `---
name: minimal
---

## Test
Do something.

## Checkpoint
It was done.
`;
        const result = parseScenario(md);

        expect(result.meta.description).toBe('');
        expect(result.meta.abortOnFailure).toBe(false);
        expect(result.tests).toHaveLength(1);
        expect(result.tests[0].monitor).toBeNull();
    });

    it('handles multiline test and checkpoint content', () => {
        const md = `---
name: multiline
description: Multiline content
abortOnFailure: false
---

## Test
Find the GitHub issue in repo apify/crawlee that references
"Fatal error in Playwright" and find the personal website
of the author of that issue.

## Checkpoint
- The issue number is #1234
- The author's personal website URL is https://karel.com
`;
        const result = parseScenario(md);

        expect(result.tests).toHaveLength(1);
        expect(result.tests[0].test).toContain('Fatal error in Playwright');
        expect(result.tests[0].test).toContain('personal website');
        expect(result.tests[0].checkpoint).toContain('#1234');
        expect(result.tests[0].checkpoint).toContain('https://karel.com');
    });

    it('ignores blocks without ## Test or ## Checkpoint', () => {
        const md = `---
name: partial
description: Has an incomplete block
abortOnFailure: false
---

## Test
Valid test.

## Checkpoint
Valid checkpoint.

---

Some random text without proper headers.

---

## Test
Another valid test.

## Checkpoint
Another valid checkpoint.
`;
        const result = parseScenario(md);

        expect(result.tests).toHaveLength(2);
        expect(result.parseWarnings).toBeUndefined();
    });
});

describe('parseScenario — validation', () => {
    it('throws on empty input', () => {
        expect(() => parseScenario('')).toThrow(ScenarioParseError);
        expect(() => parseScenario('   ')).toThrow(ScenarioParseError);
    });

    it('throws if name is missing', () => {
        const md = `---
description: no name
---

## Test
Do something.

## Checkpoint
It was done.
`;
        expect(() => parseScenario(md)).toThrow('must have a "name"');
    });

    it('throws if no valid tests found', () => {
        const md = `---
name: empty-scenario
---

Just some text without any test headers.
`;
        expect(() => parseScenario(md)).toThrow('has no valid tests');
    });

    it('throws with details if ## Test exists but ## Checkpoint missing', () => {
        const md = `---
name: broken
---

## Test
Do something.
`;
        expect(() => parseScenario(md)).toThrow('missing the other');
    });

    it('does not split on --- inside test content', () => {
        const md = `---
name: hr-in-content
---

## Test
Here is some markdown:
---
This is still part of the test prompt.

## Checkpoint
contains: part of the test
`;
        const result = parseScenario(md);
        expect(result.tests).toHaveLength(1);
        expect(result.tests[0].test).toContain('---');
        expect(result.tests[0].test).toContain('still part of the test');
    });

    it('returns parseWarnings for partially invalid blocks', () => {
        const md = `---
name: mixed
---

## Test
Valid test.

## Checkpoint
Valid checkpoint.

---

## Test
Orphan test without checkpoint.
`;
        const result = parseScenario(md);
        expect(result.tests).toHaveLength(1);
        expect(result.parseWarnings).toHaveLength(1);
        expect(result.parseWarnings![0]).toContain('missing the other');
    });
});
