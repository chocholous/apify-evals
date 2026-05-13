import matter from 'gray-matter';

import type { ParsedScenario, ScenarioMeta, TestCase, ExpectedTools, ExpectedToolCall } from './types.js';

export class ScenarioParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ScenarioParseError';
    }
}

export function parseScenario(markdown: string): ParsedScenario {
    if (!markdown.trim()) {
        throw new ScenarioParseError('Scenario is empty');
    }

    const { data, content } = matter(markdown);

    let expectedTools: ExpectedTools | undefined;
    if (data.expectedTools) {
        const et = data.expectedTools;
        expectedTools = {
            required: Array.isArray(et.required) ? et.required : [],
            forbidden: Array.isArray(et.forbidden) ? et.forbidden : [],
            optional: Array.isArray(et.optional) ? et.optional : [],
            requiredCommands: Array.isArray(et.requiredCommands) ? et.requiredCommands : [],
            forbiddenCommands: Array.isArray(et.forbiddenCommands) ? et.forbiddenCommands : [],
            requiredFiles: Array.isArray(et.requiredFiles) ? et.requiredFiles : [],
            severity: et.severity === 'fail' ? 'fail' : 'warning',
        };
    }

    const meta: ScenarioMeta = {
        name: data.name ?? 'unnamed',
        description: data.description ?? '',
        abortOnFailure: data.abortOnFailure ?? false,
        expectedTools,
    };

    if (!meta.name || meta.name === 'unnamed') {
        throw new ScenarioParseError('Scenario must have a "name" in YAML frontmatter');
    }

    // Split on --- only when it separates test blocks (followed by ## Test or end of content).
    // This avoids splitting on --- used as horizontal rules inside test/checkpoint content.
    const rawBlocks = content
        .split(/^---$(?=\s*\n(?:## Test|\s*$))/m)
        .map((b) => b.trim())
        .filter((b) => b.length > 0);

    const tests: TestCase[] = [];
    const parseErrors: string[] = [];

    for (let idx = 0; idx < rawBlocks.length; idx++) {
        const block = rawBlocks[idx];
        const testMatch = block.match(/## Test\s*\n([\s\S]*?)(?=## Checkpoint|## Expected Tools|## Monitor|$)/i);
        const checkpointMatch = block.match(/## Checkpoint\s*\n([\s\S]*?)(?=## Expected Tools|## Monitor|$)/i);
        const expectedToolsMatch = block.match(/## Expected Tools\s*\n([\s\S]*?)(?=## Checkpoint|## Monitor|$)/i);
        const monitorMatch = block.match(/## Monitor\s*\n([\s\S]*?)$/i);

        if (testMatch && checkpointMatch) {
            const test = testMatch[1].trim();
            const checkpoint = checkpointMatch[1].trim();

            if (!test) {
                parseErrors.push(`Block ${idx + 1}: ## Test section is empty`);
                continue;
            }
            if (!checkpoint) {
                parseErrors.push(`Block ${idx + 1}: ## Checkpoint section is empty`);
                continue;
            }

            const expectedToolCalls: ExpectedToolCall[] = [];
            if (expectedToolsMatch) {
                const lines = expectedToolsMatch[1].trim().split('\n');
                for (const line of lines) {
                    const match = line.match(/^(\w+):\s*(.+)$/);
                    if (match) {
                        expectedToolCalls.push({ tool: match[1], parameterHint: match[2].trim() });
                    }
                }
            }

            tests.push({
                test,
                checkpoint,
                monitor: monitorMatch ? monitorMatch[1].trim() || null : null,
                expectedToolCalls,
            });
        } else if (block.includes('## Test') || block.includes('## Checkpoint')) {
            parseErrors.push(`Block ${idx + 1}: has ## Test or ## Checkpoint header but missing the other`);
        }
    }

    if (tests.length === 0) {
        const reason = parseErrors.length > 0
            ? `Parse errors:\n${parseErrors.join('\n')}`
            : 'No blocks with both ## Test and ## Checkpoint found';
        throw new ScenarioParseError(`Scenario "${meta.name}" has no valid tests. ${reason}`);
    }

    return { meta, tests, parseWarnings: parseErrors.length > 0 ? parseErrors : undefined };
}
