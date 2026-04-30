import matter from 'gray-matter';

import type { ParsedScenario, ScenarioMeta, TestCase } from './types.js';

export function parseScenario(markdown: string): ParsedScenario {
    const { data, content } = matter(markdown);

    const meta: ScenarioMeta = {
        name: data.name ?? 'unnamed',
        description: data.description ?? '',
        abortOnFailure: data.abortOnFailure ?? false,
    };

    const rawBlocks = content
        .split(/^---$/m)
        .map((b) => b.trim())
        .filter((b) => b.length > 0);

    const tests: TestCase[] = [];

    for (const block of rawBlocks) {
        const testMatch = block.match(/## Test\s*\n([\s\S]*?)(?=## Checkpoint|## Monitor|$)/i);
        const checkpointMatch = block.match(/## Checkpoint\s*\n([\s\S]*?)(?=## Monitor|$)/i);
        const monitorMatch = block.match(/## Monitor\s*\n([\s\S]*?)$/i);

        if (testMatch && checkpointMatch) {
            tests.push({
                test: testMatch[1].trim(),
                checkpoint: checkpointMatch[1].trim(),
                monitor: monitorMatch ? monitorMatch[1].trim() : null,
            });
        }
    }

    return { meta, tests };
}
