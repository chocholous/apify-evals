import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runInitPreset } from '../init-presets.js';
import type { TrajectoryMetrics } from '../types.js';

function makeTrajectory(overrides: Partial<TrajectoryMetrics> = {}): TrajectoryMetrics {
    return {
        toolCallCount: 0,
        toolCallSequence: [],
        uniqueToolsUsed: [],
        toolCallsPerTurn: 0,
        perTurnTokens: [],
        perTurnToolCalls: [],
        toolCallDetails: [],
        errorRecoveryCount: 0,
        filesCreated: [],
        filesModified: [],
        commandsExecuted: [],
        mcpToolsUsed: [],
        ...overrides,
    };
}

describe('runInitPreset', () => {
    let workDir: string;

    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), 'eval-preset-test-'));
    });

    afterEach(() => {
        rmSync(workDir, { recursive: true, force: true });
    });

    it('none preset runs diagnostic probes without writing MCP config', () => {
        const result = runInitPreset({ preset: 'none', workDir });
        expect(result.mcpConfigPath).toBeNull();
        expect(result.strictMcpConfig).toBe(false);
        // Emits one diagnostic log line — `which apify/gh/curl/jq` probes.
        expect(result.presetLog).toHaveLength(1);
        expect(result.presetLog[0]).toContain('none:');
        // Non-*_only presets must NOT enable PATH shimming or trajectory enforcement.
        expect(result.pathPrefix).toBeNull();
        expect(result.trajectoryRejects).toEqual([]);
    });

    it('none preset with mcpConfigJson writes MCP config', () => {
        const mcpConfig = { mcpServers: { test: { command: 'echo', args: ['hi'] } } };
        const result = runInitPreset({ preset: 'none', mcpConfigJson: mcpConfig, workDir });
        expect(result.mcpConfigPath).toBeTruthy();
        expect(result.strictMcpConfig).toBe(true);
        expect(existsSync(result.mcpConfigPath!)).toBe(true);
        const written = JSON.parse(readFileSync(result.mcpConfigPath!, 'utf-8'));
        expect(written.mcpServers.test.command).toBe('echo');
        // Diagnostic line + "wrote MCP config" line
        expect(result.presetLog.some((m) => m.includes('wrote MCP config'))).toBe(true);
    });

    it.each(['mcp_native', 'cli_native', 'mcpc', 'api_native'] as const)(
        '%s preset does not enable trajectory enforcement (no pathPrefix, no rejects)',
        (preset) => {
            const result = runInitPreset({ preset, mcpConfigJson: { mcpServers: {} }, workDir });
            expect(result.pathPrefix).toBeNull();
            expect(result.trajectoryRejects).toEqual([]);
        },
    );

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

    it('api_native checks for REST API tooling', () => {
        const result = runInitPreset({ preset: 'api_native', workDir });
        expect(result.presetLog).toHaveLength(1);
        expect(result.presetLog[0]).toContain('api_native:');
        expect(result.mcpConfigPath).toBeNull();
        expect(result.strictMcpConfig).toBe(false);
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
        // none now emits a diagnostic line before the custom script log.
        expect(result.presetLog).toHaveLength(2);
        expect(result.presetLog[result.presetLog.length - 1]).toContain('custom: OK');
    });

    it('custom script failure is logged', () => {
        const result = runInitPreset({
            preset: 'none',
            customScript: 'exit 1',
            workDir,
        });
        const customLog = result.presetLog[result.presetLog.length - 1];
        expect(customLog).toContain('custom:');
        expect(customLog).toContain('failed');
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

    // ------------------------------------------------------------------
    // *_only presets — exclusive surfaces with shim + trajectory enforcement
    // ------------------------------------------------------------------

    describe('mcp_only', () => {
        it('with config: writes MCP config, shims CLI + REST binaries, registers full reject set', () => {
            const result = runInitPreset({
                preset: 'mcp_only',
                mcpConfigJson: { mcpServers: { test: { command: 'echo' } } },
                workDir,
            });
            expect(result.mcpConfigPath).toBeTruthy();
            expect(result.strictMcpConfig).toBe(true);
            expect(result.pathPrefix).toBeTruthy();
            // Shim binaries exist and are executable
            for (const tool of ['apify', 'curl', 'wget']) {
                const shim = join(result.pathPrefix!, tool);
                expect(existsSync(shim)).toBe(true);
                // chmod 755 means owner has execute bit
                expect((statSync(shim).mode & 0o100) !== 0).toBe(true);
                // Shim body errors out to stderr
                expect(readFileSync(shim, 'utf-8')).toContain("'mcp_only'");
            }
            // Three trajectory rejects: CLI-via-bash, REST-via-shell, REST-via-builtin
            expect(result.trajectoryRejects).toHaveLength(3);
            expect(result.trajectoryRejects.every((r) => r.severity === 'fail')).toBe(true);
        });

        it('without config: warns loudly that the agent has no usable surface', () => {
            const result = runInitPreset({ preset: 'mcp_only', workDir });
            expect(result.mcpConfigPath).toBeNull();
            expect(result.presetLog.some((m) => m.includes('NO mcpConfigJson'))).toBe(true);
            // PATH shim still applied + rejects still registered — the agent has no
            // legitimate surface and will fail correctly rather than silently fall back.
            expect(result.pathPrefix).toBeTruthy();
            expect(result.trajectoryRejects.length).toBe(3);
        });

        it('trajectory rejects detect: apify-cli via Bash', () => {
            const result = runInitPreset({ preset: 'mcp_only', mcpConfigJson: { mcpServers: {} }, workDir });
            const cliReject = result.trajectoryRejects.find((r) => r.name === 'no-cli-surface');
            expect(cliReject).toBeDefined();
            // Hits — agent ran an apify-cli command in some form
            expect(cliReject!.predicate(makeTrajectory({ commandsExecuted: ['apify push --no-prompt'] }))).toBe(true);
            expect(cliReject!.predicate(makeTrajectory({ commandsExecuted: ['cd /tmp && apify info'] }))).toBe(true);
            // Misses — no apify invocation
            expect(cliReject!.predicate(makeTrajectory({ commandsExecuted: ['ls -la', 'npm install'] }))).toBe(false);
            // No false positive on words that merely contain "apify" as a substring
            expect(cliReject!.predicate(makeTrajectory({ commandsExecuted: ['cat /tmp/apifyrc'] }))).toBe(false);
        });

        it('trajectory rejects detect: REST API via shell tools', () => {
            const result = runInitPreset({ preset: 'mcp_only', mcpConfigJson: { mcpServers: {} }, workDir });
            const restReject = result.trajectoryRejects.find((r) => r.name === 'no-rest-surface-via-shell');
            expect(restReject).toBeDefined();
            expect(restReject!.predicate(makeTrajectory({ commandsExecuted: ['curl https://api.apify.com/v2/users/me'] }))).toBe(true);
            expect(restReject!.predicate(makeTrajectory({ commandsExecuted: ['wget some-url'] }))).toBe(true);
            // Indirect HTTP via inline node/python is also caught
            expect(restReject!.predicate(makeTrajectory({ commandsExecuted: ['node -e "fetch(\'https://...\')"'] }))).toBe(true);
            expect(restReject!.predicate(makeTrajectory({ commandsExecuted: ['python -c "import requests; requests.get(\'...\')"'] }))).toBe(true);
            // Any mention of api.apify.com in a command, even in another tool
            expect(restReject!.predicate(makeTrajectory({ commandsExecuted: ['echo "see https://api.apify.com" > note'] }))).toBe(true);
            // Misses — no REST shell signals
            expect(restReject!.predicate(makeTrajectory({ commandsExecuted: ['npm install', 'mkdir src'] }))).toBe(false);
        });

        it('trajectory rejects detect: in-agent WebFetch / WebSearch', () => {
            const result = runInitPreset({ preset: 'mcp_only', mcpConfigJson: { mcpServers: {} }, workDir });
            const builtinReject = result.trajectoryRejects.find((r) => r.name === 'no-rest-surface-via-builtin-tools');
            expect(builtinReject).toBeDefined();
            expect(builtinReject!.predicate(makeTrajectory({ uniqueToolsUsed: ['WebFetch'] }))).toBe(true);
            expect(builtinReject!.predicate(makeTrajectory({ uniqueToolsUsed: ['WebSearch'] }))).toBe(true);
            expect(builtinReject!.predicate(makeTrajectory({ uniqueToolsUsed: ['Bash', 'Read'] }))).toBe(false);
        });
    });

    describe('cli_only', () => {
        it('shims curl/wget (but NOT apify — CLI is the allowed surface), does not write MCP config', () => {
            const result = runInitPreset({ preset: 'cli_only', workDir });
            expect(result.mcpConfigPath).toBeNull();
            expect(result.pathPrefix).toBeTruthy();
            // curl + wget shimmed
            expect(existsSync(join(result.pathPrefix!, 'curl'))).toBe(true);
            expect(existsSync(join(result.pathPrefix!, 'wget'))).toBe(true);
            // apify must NOT be shimmed (it's the allowed surface)
            expect(existsSync(join(result.pathPrefix!, 'apify'))).toBe(false);
            // Three rejects: REST-via-shell, REST-via-builtin, MCP-tool-use
            expect(result.trajectoryRejects).toHaveLength(3);
            expect(result.trajectoryRejects.map((r) => r.name)).toEqual(
                expect.arrayContaining(['no-rest-surface-via-shell', 'no-rest-surface-via-builtin-tools', 'no-mcp-surface']),
            );
        });

        it('ignores mcpConfigJson if provided, logs explicit warning', () => {
            const result = runInitPreset({
                preset: 'cli_only',
                mcpConfigJson: { mcpServers: { x: {} } },
                workDir,
            });
            expect(result.mcpConfigPath).toBeNull();
            expect(result.presetLog.some((m) => m.includes('IGNORED'))).toBe(true);
        });

        it('detects MCP tool use in trajectory', () => {
            const result = runInitPreset({ preset: 'cli_only', workDir });
            const mcpReject = result.trajectoryRejects.find((r) => r.name === 'no-mcp-surface');
            expect(mcpReject!.predicate(makeTrajectory({ mcpToolsUsed: ['apify_call_actor'] }))).toBe(true);
            expect(mcpReject!.predicate(makeTrajectory({ mcpToolsUsed: [] }))).toBe(false);
        });
    });

    describe('api_only', () => {
        it('shims apify (but NOT curl — REST is the allowed surface), does not write MCP config', () => {
            const result = runInitPreset({ preset: 'api_only', workDir });
            expect(result.mcpConfigPath).toBeNull();
            expect(result.pathPrefix).toBeTruthy();
            expect(existsSync(join(result.pathPrefix!, 'apify'))).toBe(true);
            // curl + wget must NOT be shimmed
            expect(existsSync(join(result.pathPrefix!, 'curl'))).toBe(false);
            expect(existsSync(join(result.pathPrefix!, 'wget'))).toBe(false);
            // Two rejects: no-cli-surface, no-mcp-surface. WebFetch is ALLOWED (it IS the REST surface).
            expect(result.trajectoryRejects).toHaveLength(2);
            expect(result.trajectoryRejects.map((r) => r.name)).toEqual(
                expect.arrayContaining(['no-cli-surface', 'no-mcp-surface']),
            );
            // No reject for in-agent WebFetch — REST is the allowed surface
            expect(result.trajectoryRejects.find((r) => r.name === 'no-rest-surface-via-builtin-tools')).toBeUndefined();
        });

        it('ignores mcpConfigJson if provided, logs explicit warning', () => {
            const result = runInitPreset({
                preset: 'api_only',
                mcpConfigJson: { mcpServers: { x: {} } },
                workDir,
            });
            expect(result.mcpConfigPath).toBeNull();
            expect(result.presetLog.some((m) => m.includes('IGNORED'))).toBe(true);
        });
    });

    it('*_only preset + custom script: custom still runs after preset', () => {
        const result = runInitPreset({
            preset: 'cli_only',
            customScript: 'echo "extra-setup"',
            workDir,
        });
        expect(result.presetLog[result.presetLog.length - 1]).toContain('custom: OK');
    });
});
