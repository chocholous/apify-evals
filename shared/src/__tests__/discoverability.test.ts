import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { parseScenario } from '../scenario-parser.js';
import { judgeAllChecks } from '../judge.js';

// Re-implement computeDiscoverability here for unit testing
// (it lives in main.ts but the logic is simple enough to test directly)
import type { ExpectedTools, TrajectoryMetrics, DiscoverabilityMetrics } from '../types.js';

function computeDiscoverability(expected: ExpectedTools | undefined, trajectory: TrajectoryMetrics): DiscoverabilityMetrics | null {
    if (!expected) return null;
    const actual = trajectory.uniqueToolsUsed;
    const actualSet = new Set(actual);
    const allowedSet = new Set([...expected.required, ...expected.optional]);
    const missingTools = expected.required.filter((t) => !actualSet.has(t));
    const extraTools = actual.filter((t) => !allowedSet.has(t) && !expected.forbidden.includes(t));
    const forbiddenToolsUsed = expected.forbidden.filter((t) => actualSet.has(t));
    const commands = trajectory.commandsExecuted;
    const missingCommands = expected.requiredCommands.filter(
        (pattern) => !commands.some((cmd) => cmd.includes(pattern)),
    );
    const forbiddenCommandsUsed = expected.forbiddenCommands.filter(
        (pattern) => commands.some((cmd) => cmd.includes(pattern)),
    );
    const foundRequired = expected.required.filter((t) => actualSet.has(t));
    const foundRequiredCommands = expected.requiredCommands.length - missingCommands.length;
    const totalRequired = expected.required.length + expected.requiredCommands.length;
    const totalFound = foundRequired.length + foundRequiredCommands;
    const discoverabilityScore = totalRequired > 0 ? totalFound / totalRequired : 1.0;
    const strictScore = (missingTools.length === 0 && forbiddenToolsUsed.length === 0
        && missingCommands.length === 0 && forbiddenCommandsUsed.length === 0) ? 1.0 : 0.0;
    return {
        expectedRequired: expected.required,
        expectedForbidden: expected.forbidden,
        expectedOptional: expected.optional,
        actualTools: actual,
        missingTools, extraTools, forbiddenToolsUsed,
        missingCommands, forbiddenCommandsUsed,
        discoverabilityScore, strictScore,
    };
}

const et = (overrides: Partial<ExpectedTools> = {}): ExpectedTools => ({
    required: [], forbidden: [], optional: [],
    requiredCommands: [], forbiddenCommands: [],
    ...overrides,
});

const mockTrajectory = (tools: string[]): TrajectoryMetrics => ({
    toolCallCount: tools.length,
    toolCallSequence: tools,
    uniqueToolsUsed: [...new Set(tools)],
    toolCallsPerTurn: tools.length,
    perTurnTokens: [],
    perTurnToolCalls: [],
    toolCallDetails: [],
    errorRecoveryCount: 0,
    filesCreated: [],
    filesModified: [],
    commandsExecuted: [],
    mcpToolsUsed: [],
});

describe('computeDiscoverability', () => {
    it('returns null when no expectedTools', () => {
        expect(computeDiscoverability(undefined, mockTrajectory(['Bash']))).toBeNull();
    });

    it('perfect score when all required tools used', () => {
        const result = computeDiscoverability(
            et({ required: ['Bash', 'Write'] }),
            mockTrajectory(['Bash', 'Write', 'Read']),
        )!;
        expect(result.discoverabilityScore).toBe(1.0);
        expect(result.missingTools).toEqual([]);
        expect(result.extraTools).toEqual(['Read']);
        expect(result.strictScore).toBe(1.0);
    });

    it('partial score when some required tools missing', () => {
        const result = computeDiscoverability(
            et({ required: ['Bash', 'Write', 'Read'] }),
            mockTrajectory(['Bash']),
        )!;
        expect(result.discoverabilityScore).toBeCloseTo(1 / 3);
        expect(result.missingTools).toEqual(['Write', 'Read']);
        expect(result.strictScore).toBe(0.0);
    });

    it('detects forbidden tool usage', () => {
        const result = computeDiscoverability(
            et({ required: ['Bash'], forbidden: ['WebSearch'] }),
            mockTrajectory(['Bash', 'WebSearch']),
        )!;
        expect(result.forbiddenToolsUsed).toEqual(['WebSearch']);
        expect(result.strictScore).toBe(0.0);
        expect(result.discoverabilityScore).toBe(1.0); // required still found
    });

    it('optional tools not counted as extra', () => {
        const result = computeDiscoverability(
            et({ required: ['Bash'], optional: ['Read', 'Edit'] }),
            mockTrajectory(['Bash', 'Read']),
        )!;
        expect(result.extraTools).toEqual([]);
        expect(result.strictScore).toBe(1.0);
    });

    it('requiredCommands checked in commandsExecuted', () => {
        const traj = mockTrajectory(['Bash']);
        traj.commandsExecuted = ['apify actors call apify/google-search-scraper -i ...', 'jq .items /tmp/serp.json'];
        const result = computeDiscoverability(
            et({ required: ['Bash'], requiredCommands: ['apify actors call'] }),
            traj,
        )!;
        expect(result.missingCommands).toEqual([]);
        expect(result.discoverabilityScore).toBe(1.0);
        expect(result.strictScore).toBe(1.0);
    });

    it('missing requiredCommand lowers score', () => {
        const traj = mockTrajectory(['Bash']);
        traj.commandsExecuted = ['curl https://example.com'];
        const result = computeDiscoverability(
            et({ required: ['Bash'], requiredCommands: ['apify actors call'] }),
            traj,
        )!;
        expect(result.missingCommands).toEqual(['apify actors call']);
        expect(result.discoverabilityScore).toBe(0.5);
        expect(result.strictScore).toBe(0.0);
    });

    it('forbiddenCommands detected', () => {
        const traj = mockTrajectory(['Bash']);
        traj.commandsExecuted = ['curl https://example.com', 'wget https://evil.com'];
        const result = computeDiscoverability(
            et({ required: ['Bash'], forbiddenCommands: ['wget'] }),
            traj,
        )!;
        expect(result.forbiddenCommandsUsed).toEqual(['wget']);
        expect(result.strictScore).toBe(0.0);
    });

    it('zero required = score 1.0', () => {
        const result = computeDiscoverability(
            et({ forbidden: ['WebSearch'], optional: ['Bash'] }),
            mockTrajectory(['Bash']),
        )!;
        expect(result.discoverabilityScore).toBe(1.0);
    });
});

describe('parseScenario — expectedTools', () => {
    it('parses expectedTools from frontmatter', () => {
        const md = `---
name: tools-test
expectedTools:
  required: [Bash, Write]
  forbidden: [WebSearch]
  optional: [Read]
---

## Test
Do something.

## Checkpoint
contains: done
`;
        const result = parseScenario(md);
        expect(result.meta.expectedTools).toBeDefined();
        expect(result.meta.expectedTools!.required).toEqual(['Bash', 'Write']);
        expect(result.meta.expectedTools!.forbidden).toEqual(['WebSearch']);
        expect(result.meta.expectedTools!.optional).toEqual(['Read']);
    });

    it('scenario without expectedTools = undefined', () => {
        const md = `---
name: plain
---

## Test
Hi.

## Checkpoint
contains: hi
`;
        const result = parseScenario(md);
        expect(result.meta.expectedTools).toBeUndefined();
    });
});

describe('parseScenario — ## Expected Tools section', () => {
    it('parses per-test expected tool calls', () => {
        const md = `---
name: tool-calls-test
---

## Test
Create files.

## Expected Tools
Bash: npm init -y, npm install crawlee
Write: src/main.ts (CheerioCrawler), .actor/actor.json

## Checkpoint
contains: done
`;
        const result = parseScenario(md);
        expect(result.tests[0].expectedToolCalls).toHaveLength(2);
        expect(result.tests[0].expectedToolCalls[0]).toEqual({
            tool: 'Bash',
            parameterHint: 'npm init -y, npm install crawlee',
        });
        expect(result.tests[0].expectedToolCalls[1]).toEqual({
            tool: 'Write',
            parameterHint: 'src/main.ts (CheerioCrawler), .actor/actor.json',
        });
    });

    it('empty when no ## Expected Tools section', () => {
        const md = `---
name: no-expected
---

## Test
Do something.

## Checkpoint
contains: done
`;
        const result = parseScenario(md);
        expect(result.tests[0].expectedToolCalls).toEqual([]);
    });
});

describe('secret masking order', () => {
    it('longer secrets masked before shorter overlapping ones', async () => {
        const { maskSecrets } = await import('../log-masker.js');
        const secrets = {
            SHORT: 'abc123',
            LONG: 'abc123def456',
        };
        const text = 'token is abc123def456 here';
        const masked = maskSecrets(text, secrets);
        // LONG should be masked first, not broken by SHORT
        expect(masked).toBe('token is ***LONG*** here');
        expect(masked).not.toContain('abc123');
    });

    it('non-overlapping secrets both masked', async () => {
        const { maskSecrets } = await import('../log-masker.js');
        const secrets = {
            A: 'alpha-key',
            B: 'beta-key',
        };
        const text = 'keys: alpha-key and beta-key';
        const masked = maskSecrets(text, secrets);
        expect(masked).toBe('keys: ***A*** and ***B***');
    });
});

describe('judge — workspace files in LLM context', () => {
    const tmpDir = join(import.meta.dirname, '../../.tmp-test-workspace');

    it('collectWorkspaceFiles reads files from workspace', async () => {
        // Create temp workspace with files
        mkdirSync(join(tmpDir, 'src'), { recursive: true });
        writeFileSync(join(tmpDir, 'package.json'), '{"name":"test"}');
        writeFileSync(join(tmpDir, 'src/main.ts'), 'console.log("hello")');

        try {
            // judgeAllChecks with workDir should include workspace files
            // We test this indirectly: script checkpoint can access the files
            const result = await judgeAllChecks(
                'I created the project',
                'script: test -f package.json && test -f src/main.ts && echo "workspace files accessible"',
                { workDir: tmpDir },
            );
            expect(result.verdicts[0].verdict).toBe('pass');
            expect(result.verdicts[0].evidence).toContain('workspace files accessible');
        } finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
