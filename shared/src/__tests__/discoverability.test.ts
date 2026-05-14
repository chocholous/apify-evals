import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { judgeAllChecks } from '../judge.js';

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
