import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

export type PresetName = 'none' | 'mcp_native' | 'cli_native' | 'mcpc';

export interface InitContext {
    preset: PresetName;
    customScript?: string;
    mcpConfigJson?: Record<string, unknown>;
    workDir: string;
}

export interface InitResult {
    mcpConfigPath: string | null;
    strictMcpConfig: boolean;
    presetLog: string[];
}

function writeMcpConfig(workDir: string, config: Record<string, unknown>): string {
    const configDir = join(workDir, '.eval-config');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'mcp-config.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    return configPath;
}

function runScript(script: string, workDir: string, label: string): { success: boolean; output: string } {
    try {
        const output = execSync(script, {
            cwd: workDir,
            timeout: 300_000,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: '/bin/bash',
        });
        return { success: true, output: output.toString().slice(0, 1000) };
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, output: `${label} failed: ${msg.slice(0, 500)}` };
    }
}

export function runInitPreset(ctx: InitContext): InitResult {
    const log: string[] = [];
    let mcpConfigPath: string | null = null;
    let strictMcpConfig = false;

    switch (ctx.preset) {
        case 'mcp_native': {
            if (!ctx.mcpConfigJson) {
                log.push('mcp_native: no mcpConfigJson provided, skipping');
                break;
            }
            mcpConfigPath = writeMcpConfig(ctx.workDir, ctx.mcpConfigJson);
            strictMcpConfig = true;
            log.push(`mcp_native: wrote MCP config to ${mcpConfigPath}`);
            break;
        }

        case 'cli_native': {
            const script = `
                which gh >/dev/null 2>&1 || echo "gh not found (install with: brew install gh)"
                which apify >/dev/null 2>&1 || echo "apify not found (install with: npm i -g apify-cli)"
            `;
            const result = runScript(script, ctx.workDir, 'cli_native');
            log.push(`cli_native: ${result.output}`);
            break;
        }

        case 'mcpc': {
            const script = `which mcpc >/dev/null 2>&1 && echo "mcpc already installed" || echo "mcpc not found — install with: npm i -g @apify/mcpc@beta"`;
            const result = runScript(script, ctx.workDir, 'mcpc check');
            log.push(`mcpc: ${result.output}`);

            if (ctx.mcpConfigJson) {
                mcpConfigPath = writeMcpConfig(ctx.workDir, ctx.mcpConfigJson);
                strictMcpConfig = true;
                log.push(`mcpc: wrote MCP config to ${mcpConfigPath}`);
            }
            break;
        }

        case 'none':
        default:
            break;
    }

    if (ctx.customScript) {
        const result = runScript(ctx.customScript, ctx.workDir, 'custom init script');
        log.push(`custom: ${result.success ? 'OK' : result.output}`);
    }

    return { mcpConfigPath, strictMcpConfig, presetLog: log };
}
