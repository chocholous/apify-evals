import { writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

import type { TrajectoryMetrics } from './types.js';

export type PresetName =
    | 'none'
    // "Available" presets — surface is reachable but agent is NOT prevented from using others.
    | 'mcp_native'
    | 'cli_native'
    | 'mcpc'
    | 'api_native'
    // "Only" presets — surface is reachable AND other surfaces are enforced-off via
    // a layered combination of PATH shimming (subprocess tools) + MCP-config gating
    // + trajectory hard-reject (in-agent tools like WebFetch). See runInitPreset
    // implementations for the exact per-preset enforcement matrix.
    | 'mcp_only'
    | 'cli_only'
    | 'api_only';

export interface InitContext {
    preset: PresetName;
    customScript?: string;
    mcpConfigJson?: Record<string, unknown>;
    workDir: string;
}

/**
 * A trajectory-level rejection rule. After the agent finishes, the runner
 * evaluates each preset's rules against the normalized trajectory. Any rule
 * whose `predicate` returns true produces a verdict on the test:
 *   - severity `fail`    → test fails
 *   - severity `warning` → test passes with a warning
 *
 * Predicates operate on `TrajectoryMetrics`, which is normalized across all
 * supported agents (claude-code, codex, opencode), so these rules are
 * agent-agnostic — unlike claude-code's `--disallowed-tools` flag, which is
 * a single-agent feature.
 */
export interface TrajectoryReject {
    /** Stable identifier — surfaces in the verdict's `checkValue`. */
    name: string;
    /** Human-readable description shown in the verdict's `evidence`. */
    reason: string;
    /** `fail` fails the test; `warning` records a warning verdict. */
    severity: 'warning' | 'fail';
    /** Returns true when the leak is detected in the trajectory. */
    predicate: (trajectory: TrajectoryMetrics) => boolean;
}

export interface InitResult {
    mcpConfigPath: string | null;
    strictMcpConfig: boolean;
    presetLog: string[];
    /**
     * Absolute path to prepend to the agent subprocess's PATH (for PATH shimming
     * of disallowed tools). Null when no shimming is needed.
     */
    pathPrefix: string | null;
    /**
     * Trajectory rules the runner must evaluate after the agent completes.
     * Empty for presets that don't enforce exclusivity.
     */
    trajectoryRejects: TrajectoryReject[];
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
        return { success: true, output: output.toString() };
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, output: `${label} failed: ${msg}` };
    }
}

/**
 * Create a PATH-shim directory with no-op shims for each given tool. Each shim
 * prints an error to stderr and exits 127, mimicking "command not found"
 * semantics. Returns the absolute directory path; the caller must prepend this
 * to the agent subprocess's PATH for it to take effect — exporting PATH inside
 * an init script doesn't propagate to the agent's subprocess, since each
 * `runScript` runs in its own subshell.
 *
 * Shim lives outside the agent's writable workspace (under the OS tmpdir with
 * a per-call random UUID suffix) so the agent can't `rm -rf .eval-shim` to
 * disarm it. The `workDir` parameter is retained for backward-compatible
 * signature but is intentionally unused for the shim path itself.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function setupPathShim(workDir: string, tools: string[], preset: PresetName, allowedSurface: string): string {
    const shimDir = join(tmpdir(), `eval-shim-${randomUUID()}`);
    mkdirSync(shimDir, { recursive: true });
    for (const tool of tools) {
        const shimPath = join(shimDir, tool);
        // Use the literal tool name in the error message rather than $0 so the
        // message is identical regardless of how the agent invoked the binary.
        const body = `#!/bin/sh
echo "'${tool}' is disabled for the '${preset}' eval preset. Use the ${allowedSurface} surface instead." >&2
exit 127
`;
        writeFileSync(shimPath, body);
        chmodSync(shimPath, 0o755);
    }
    return shimDir;
}

// ---------------------------------------------------------------------------
// Trajectory rejection rules
// ---------------------------------------------------------------------------
//
// These rules are evaluated against the normalized TrajectoryMetrics emitted
// by every agent runner — they're not specific to claude-code. The runner
// applies them after the agent finishes; any matched rule contributes a
// verdict (warning or fail) to the test's verdict list.
//
// The rules are deliberately conservative: they look for command substrings
// or tool names that are unambiguously the "wrong surface". They won't catch
// every clever workaround (e.g. agent writes a Python script that does HTTP
// to a stored URL), but they reliably catch the obvious leak patterns.
// ---------------------------------------------------------------------------

// Catches absolute (`/usr/local/bin/apify`), relative (`./bin/apify`), and bare
// (`apify`) invocations. The `(?:[\w./-]*\/)?` segment allows an optional
// path-with-slashes prefix or nothing at all.
const REGEX_APIFY_CLI = /(?:^|[\s;|&(])(?:[\w./-]*\/)?apify(?:-cli)?(?:\s|$)/;
const REGEX_CURL_OR_WGET = /(?:^|[\s;|&(])(?:[\w./-]*\/)?(?:curl|wget)(?:\s|$)/;
const REGEX_APIFY_HOST = /api\.apify\.com/i;
// Catches inline -e/-c invocations and `<runtime> <file>` only when the
// HTTP-library substring appears in the bash command. File-execution where the
// HTTP library is INSIDE the script file (not in the bash command) is not
// detected by pattern-matching — that would require content scanning.
// Documented as a known gap; an egress firewall is the complete solution.
const REGEX_NODE_HTTP_EVAL = /\b(?:node|bun|deno|tsx|ts-node)\b.*(?:fetch\(|http\.|https\.)/;
const REGEX_PYTHON_HTTP_EVAL = /\b(?:python|python3|python3\.\d+|pypy)\b.*(?:requests\.|http\.client|urllib|httpx)/;

const REJECT_APIFY_CLI_VIA_BASH: TrajectoryReject = {
    name: 'no-cli-surface',
    reason: 'Agent invoked the Apify CLI (`apify` / `apify-cli`) via Bash — the active preset disallows the CLI surface.',
    severity: 'fail',
    predicate: (t) => t.commandsExecuted.some((cmd) => REGEX_APIFY_CLI.test(cmd)),
};

const REJECT_REST_VIA_SHELL: TrajectoryReject = {
    name: 'no-rest-surface-via-shell',
    reason: 'Agent invoked `curl`/`wget` or referenced `api.apify.com` from a shell command — the active preset disallows the REST API surface.',
    severity: 'fail',
    predicate: (t) =>
        t.commandsExecuted.some(
            (cmd) => REGEX_CURL_OR_WGET.test(cmd) || REGEX_APIFY_HOST.test(cmd) || REGEX_NODE_HTTP_EVAL.test(cmd) || REGEX_PYTHON_HTTP_EVAL.test(cmd),
        ),
};

const REJECT_REST_VIA_INAGENT_TOOLS: TrajectoryReject = {
    name: 'no-rest-surface-via-builtin-tools',
    reason: 'Agent used the built-in `WebFetch` or `WebSearch` tool — the active preset disallows the REST API surface (these tools make direct HTTPS calls).',
    severity: 'fail',
    // Case-insensitive: claude-code emits `WebFetch`/`WebSearch`, opencode emits
    // lowercase (`webfetch`/`websearch`). Matching exact-case would silently miss
    // opencode and break the "agent-agnostic" guarantee.
    predicate: (t) => t.uniqueToolsUsed.some((n) => {
        const tool = n.toLowerCase();
        return tool === 'webfetch' || tool === 'websearch';
    }),
};

const REJECT_MCP_VIA_TOOL: TrajectoryReject = {
    name: 'no-mcp-surface',
    reason: 'Agent invoked an MCP tool — the active preset disallows the MCP surface. (If you see this with no MCP config provided, the agent likely had a user-level MCP server configured; check `mcpToolsUsed`.)',
    severity: 'fail',
    predicate: (t) => t.mcpToolsUsed.length > 0,
};

// ---------------------------------------------------------------------------

export function runInitPreset(ctx: InitContext): InitResult {
    const log: string[] = [];
    let mcpConfigPath: string | null = null;
    let strictMcpConfig = false;
    let pathPrefix: string | null = null;
    const trajectoryRejects: TrajectoryReject[] = [];

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

        case 'api_native': {
            const script = `
                which curl >/dev/null 2>&1 || echo "curl not found (required for direct REST API calls)"
                which jq >/dev/null 2>&1 || echo "jq not found (recommended for parsing API responses)"
            `;
            const result = runScript(script, ctx.workDir, 'api_native');
            log.push(`api_native: ${result.output}`);
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

        case 'mcp_only': {
            // Exclusive MCP surface. Three enforcement layers:
            //   (A) PATH shim: block `apify`/`curl`/`wget` so direct subprocess
            //       calls fail with exit 127.
            //   (B) MCP config gating: only available because mcpConfigJson is
            //       provided — without it, the agent has NO surface (intentional
            //       hard failure rather than silent fallback).
            //   (C) Trajectory hard-reject: catches in-agent built-in tools
            //       (WebFetch/WebSearch), bypass attempts via node/python eval,
            //       and shell mentions of `api.apify.com`.
            if (!ctx.mcpConfigJson) {
                log.push(
                    'mcp_only: NO mcpConfigJson provided — agent will have no usable surface. ' +
                    'Provide mcpConfigJson with an MCP server configuration, or pick a different preset.',
                );
            } else {
                mcpConfigPath = writeMcpConfig(ctx.workDir, ctx.mcpConfigJson);
                strictMcpConfig = true;
                log.push(`mcp_only: wrote MCP config to ${mcpConfigPath} (strict)`);
            }

            pathPrefix = setupPathShim(ctx.workDir, ['apify', 'curl', 'wget'], 'mcp_only', 'MCP');
            log.push(`mcp_only: PATH-shimmed apify/curl/wget under ${pathPrefix}`);

            trajectoryRejects.push(
                REJECT_APIFY_CLI_VIA_BASH,
                REJECT_REST_VIA_SHELL,
                REJECT_REST_VIA_INAGENT_TOOLS,
            );
            break;
        }

        case 'cli_only': {
            // Exclusive CLI surface. Enforcement:
            //   (A) PATH shim: block `curl`/`wget` so direct REST calls fail.
            //       apify-cli is intentionally NOT shimmed — it IS the surface.
            //   (B) MCP config gating: do NOT write the MCP config; with no
            //       --mcp-config passed, the agent CLI has no MCP servers to call.
            //   (C) Trajectory hard-reject: catches in-agent WebFetch/WebSearch,
            //       direct HTTPS from node/python, and any mention of api.apify.com
            //       (which would imply the agent bypassed the CLI).
            const script = `
                which apify >/dev/null 2>&1 || echo "apify not found (install with: npm i -g apify-cli)"
                which gh >/dev/null 2>&1 || echo "gh not found (install with: brew install gh)"
            `;
            const result = runScript(script, ctx.workDir, 'cli_only');
            log.push(`cli_only: ${result.output}`);

            pathPrefix = setupPathShim(ctx.workDir, ['curl', 'wget'], 'cli_only', 'apify-cli');
            log.push(`cli_only: PATH-shimmed curl/wget under ${pathPrefix}`);

            if (ctx.mcpConfigJson) {
                log.push(
                    'cli_only: mcpConfigJson provided but IGNORED — cli_only does not load MCP servers. ' +
                    'Use mcp_only or mcp_native if you want MCP available.',
                );
            }

            trajectoryRejects.push(
                REJECT_REST_VIA_SHELL,
                REJECT_REST_VIA_INAGENT_TOOLS,
                REJECT_MCP_VIA_TOOL,
            );
            break;
        }

        case 'api_only': {
            // Exclusive REST API surface. Enforcement:
            //   (A) PATH shim: block `apify` so the agent can't fall back to the CLI.
            //   (B) MCP config gating: do NOT write the MCP config.
            //   (C) Trajectory hard-reject: any apify-cli invocation, any MCP
            //       tool call. WebFetch and curl are ALLOWED — they ARE the
            //       REST API surface.
            const script = `
                which curl >/dev/null 2>&1 || echo "curl not found (required for REST API calls)"
                which jq >/dev/null 2>&1 || echo "jq not found (recommended for parsing API responses)"
            `;
            const result = runScript(script, ctx.workDir, 'api_only');
            log.push(`api_only: ${result.output}`);

            pathPrefix = setupPathShim(ctx.workDir, ['apify'], 'api_only', 'REST API (curl / built-in fetch)');
            log.push(`api_only: PATH-shimmed apify under ${pathPrefix}`);

            if (ctx.mcpConfigJson) {
                log.push(
                    'api_only: mcpConfigJson provided but IGNORED — api_only does not load MCP servers.',
                );
            }

            trajectoryRejects.push(
                REJECT_APIFY_CLI_VIA_BASH,
                REJECT_MCP_VIA_TOOL,
            );
            break;
        }

        case 'none':
        default: {
            // The loose default: emits PATH diagnostics for the common tools
            // (apify, gh, curl, jq) and — if mcpConfigJson is provided — wires
            // it up alongside. Always safe to use; gives the agent everything
            // it would normally have, with visibility into what's available.
            const script = `
                which apify >/dev/null 2>&1 || echo "apify CLI not found (install with: npm i -g apify-cli)"
                which gh >/dev/null 2>&1 || echo "gh not found (install with: brew install gh)"
                which curl >/dev/null 2>&1 || echo "curl not found (required for REST API calls)"
                which jq >/dev/null 2>&1 || echo "jq not found (recommended for parsing API responses)"
            `;
            const result = runScript(script, ctx.workDir, 'none');
            log.push(`none: ${result.output}`);

            if (ctx.mcpConfigJson) {
                mcpConfigPath = writeMcpConfig(ctx.workDir, ctx.mcpConfigJson);
                strictMcpConfig = true;
                log.push(`none: wrote MCP config to ${mcpConfigPath}`);
            }
            break;
        }
    }

    if (ctx.customScript) {
        const result = runScript(ctx.customScript, ctx.workDir, 'custom init script');
        log.push(`custom: ${result.success ? 'OK' : result.output}`);
    }

    return { mcpConfigPath, strictMcpConfig, presetLog: log, pathPrefix, trajectoryRejects };
}
