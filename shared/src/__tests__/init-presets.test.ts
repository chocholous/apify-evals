import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runInitPreset } from '../init-presets.js';

describe('runInitPreset', () => {
    let workDir: string;

    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), 'eval-preset-test-'));
    });

    afterEach(() => {
        rmSync(workDir, { recursive: true, force: true });
    });

    it('none preset does nothing', () => {
        const result = runInitPreset({ preset: 'none', workDir });
        expect(result.mcpConfigPath).toBeNull();
        expect(result.strictMcpConfig).toBe(false);
        expect(result.presetLog).toHaveLength(0);
    });

    it('mcp_native writes config and enables strict mode', () => {
        const mcpConfig = { mcpServers: { test: { command: 'echo', args: ['hi'] } } };
        const result = runInitPreset({ preset: 'mcp_native', mcpConfigJson: mcpConfig, workDir });

        expect(result.mcpConfigPath).toBeTruthy();
        expect(result.strictMcpConfig).toBe(true);
        expect(existsSync(result.mcpConfigPath!)).toBe(true);

        const written = JSON.parse(readFileSync(result.mcpConfigPath!, 'utf-8'));
        expect(written.mcpServers.test.command).toBe('echo');
    });

    it('mcp_native without config logs warning', () => {
        const result = runInitPreset({ preset: 'mcp_native', workDir });
        expect(result.mcpConfigPath).toBeNull();
        expect(result.presetLog[0]).toContain('no mcpConfigJson');
    });

    it('cli_native checks for available CLIs', () => {
        const result = runInitPreset({ preset: 'cli_native', workDir });
        expect(result.presetLog).toHaveLength(1);
        expect(result.presetLog[0]).toContain('cli_native:');
    });

    it('mcpc without config skips MCP setup', () => {
        const result = runInitPreset({ preset: 'mcpc', workDir });
        expect(result.presetLog.length).toBeGreaterThanOrEqual(1);
        expect(result.mcpConfigPath).toBeNull();
        // mcpc install may fail in clean environments — that's expected and logged
    });

    it('mcpc with config writes config', () => {
        const mcpConfig = { mcpServers: {} };
        const result = runInitPreset({ preset: 'mcpc', mcpConfigJson: mcpConfig, workDir });
        expect(result.mcpConfigPath).toBeTruthy();
        expect(result.strictMcpConfig).toBe(true);
    });

    it('custom script runs after preset', () => {
        const result = runInitPreset({
            preset: 'none',
            customScript: 'echo "custom-init-ok"',
            workDir,
        });
        expect(result.presetLog).toHaveLength(1);
        expect(result.presetLog[0]).toContain('custom: OK');
    });

    it('custom script failure is logged', () => {
        const result = runInitPreset({
            preset: 'none',
            customScript: 'exit 1',
            workDir,
        });
        expect(result.presetLog[0]).toContain('custom:');
        expect(result.presetLog[0]).toContain('failed');
    });

    it('preset + custom script both run', () => {
        const result = runInitPreset({
            preset: 'cli_native',
            customScript: 'echo "extra-setup"',
            workDir,
        });
        expect(result.presetLog.length).toBe(2);
        expect(result.presetLog[0]).toContain('cli_native:');
        expect(result.presetLog[1]).toContain('custom: OK');
    });
});
