import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { buildChildEnv } from './apify-env.js';
import type { AgentEvent, RunMetrics, EfficiencyMetrics, TrajectoryMetrics, HungWarning } from '../types.js';
import {
    SILENCE_NOTICE_MS,
    SILENCE_WARN1_MS,
    SILENCE_WARN2_MS,
    SILENCE_SIGTERM_MS,
    SILENCE_SIGKILL_GRACE_MS,
    SILENCE_FORCE_RESOLVE_GRACE_MS,
    SILENCE_CHECK_INTERVAL_MS,
} from '../constants.js';
import { getAgentDef, buildAgentArgs } from './registry.js';

export interface AgentRunOptions {
    agent: string;
    prompt: string;
    systemPrompt?: string;
    model?: string;
    maxTurns?: number;
    maxBudgetUsd?: number;
    mcpConfigPath?: string;
    strictMcpConfig?: boolean;
    pluginDirs?: string[];
    env?: Record<string, string>;
    cwd?: string;
    onEvent?: (event: AgentEvent) => void;
    onRawLine?: (line: string) => void;
    abortSignal?: AbortSignal;
}

export interface AgentRunResult {
    text: string;
    metrics: RunMetrics;
    efficiency: EfficiencyMetrics;
    trajectory: TrajectoryMetrics;
    events: AgentEvent[];
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    aborted: boolean;
    error: string | null;
    stopReason: string;
    stderr: string;
    hungWarnings: HungWarning[];
    // Set when the silence-escalation ladder fires (SIGTERM/SIGKILL/force-resolve).
    // null when the subprocess exited on its own or was aborted via abortSignal.
    shutdownReason: string | null;
}

export const EMPTY_METRICS: RunMetrics = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    totalCostUsd: 0, durationMs: 0, durationApiMs: 0, numTurns: 0, modelUsage: {},
};

export const EMPTY_EFFICIENCY: EfficiencyMetrics = {
    totalContextTokens: 0, tokensPerTurn: 0, costPerTurn: 0, cacheHitRate: 0,
    contextOutputRatio: 0, apiDurationRatio: 0, avgTurnDurationMs: 0,
    toolExecutionMs: 0, planningTurns: 0, executionTurns: 0,
};

export const EMPTY_TRAJECTORY: TrajectoryMetrics = {
    toolCallCount: 0, toolCallSequence: [], uniqueToolsUsed: [], toolCallsPerTurn: 0,
    perTurnTokens: [], perTurnToolCalls: [], toolCallDetails: [],
    errorRecoveryCount: 0,
    filesCreated: [], filesModified: [], commandsExecuted: [], mcpToolsUsed: [],
};

// --- Bash command file-op detection ---

const TEE_PATTERN = /\btee\s+(?:-a\s+)?(\S+)/g;
const CP_MV_PATTERN = /\b(?:cp|mv)\s+.*?\s+(\S+)\s*$/gm;

/**
 * Compose the agent's effective user prompt by prepending `systemPrompt` (if
 * non-empty) to `userPrompt`, separated by a clear markdown boundary.
 *
 * Used by `runAgent` instead of passing systemPrompt as a `--system-prompt` /
 * `--append-system-prompt` CLI flag. Rationale (see runAgent body for full
 * comment): cross-agent uniformity is more valuable than native-mechanism
 * placement when the eval is non-adversarial and we want comparable inputs
 * across claude-code, codex, and opencode.
 *
 * Falsy `systemPrompt` (undefined, null, empty string, whitespace-only) is
 * passed through unchanged — the agent CLI then uses its own built-in
 * identity prompt, which is the realistic baseline for "user opens this CLI
 * with no customisation."
 */
export function applyPromptPrefix(systemPrompt: string | undefined | null, userPrompt: string): string {
    if (!systemPrompt || !systemPrompt.trim()) return userPrompt;
    return `${systemPrompt}\n\n---\n\nUser task:\n\n${userPrompt}`;
}

export function extractFileOpsFromCommand(cmd: string): { created: string[]; modified: string[] } {
    const created: string[] = [];
    const modified: string[] = [];

    // echo/printf/cat > file (create), >> file (modify)
    for (const match of cmd.matchAll(/(?:>\s*>)\s*(\S+)/g)) {
        modified.push(match[1]);
    }
    for (const match of cmd.matchAll(/(?<![>])\s*>\s*(\S+)/g)) {
        if (!match[1].startsWith('&') && !match[1].startsWith('/dev/')) {
            created.push(match[1]);
        }
    }

    // tee file
    for (const match of cmd.matchAll(TEE_PATTERN)) {
        created.push(match[1]);
    }

    // cp/mv ... dest
    for (const match of cmd.matchAll(CP_MV_PATTERN)) {
        if (!match[1].startsWith('-')) {
            created.push(match[1]);
        }
    }

    return { created, modified };
}

// --- Filesystem-level file change detection ---

function scanFilesystemChanges(markerPath: string, scanDirs: string[]): { created: string[] } {
    const files: string[] = [];
    for (const dir of scanDirs) {
        try {
            const output = execFileSync(
                'find', [dir, '-newer', markerPath, '-type', 'f'],
                { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
            );
            for (const line of output.split('\n')) {
                const trimmed = line.trim();
                if (trimmed && trimmed !== markerPath) files.push(trimmed);
            }
        } catch { /* ignore scan errors */ }
    }
    return { created: files };
}

// --- Per-agent event interpreters ---

interface ParsedStream {
    getText: () => string;
    getMetrics: () => RunMetrics;
    getError: () => string | null;
    getStopReason: () => string;
    getTrajectoryData: () => {
        toolCalls: string[];
        toolCallDetails: Array<{ tool: string; turn: number; input: Record<string, unknown> }>;
        perTurnTokens: Array<{ turn: number; input: number; output: number }>;
        perTurnToolCalls: Array<{ turn: number; tools: string[] }>;
        errorRecoveries: number;
        files: { created: string[]; modified: string[] };
        commands: string[];
        mcpTools: string[];
    };
}

export function parseClaudeStream(events: AgentEvent[]): ParsedStream {
    let text = '';
    let resultEvent: AgentEvent | null = null;
    // claude-code can emit multiple `result` events per session (e.g. task-notification
    // synthetic turns trigger new result events). `duration_ms` and `num_turns` reset
    // per-turn rather than accumulating, so we sum them ourselves. `total_cost_usd` and
    // token usage are cumulative on the stream — keep the last value.
    let accumDurationMs = 0;
    let accumDurationApiMs = 0;
    let accumNumTurns = 0;
    const toolCalls: string[] = [];
    const toolCallDetails: Array<{ tool: string; turn: number; input: Record<string, unknown> }> = [];
    const perTurnTokens: Array<{ turn: number; input: number; output: number }> = [];
    const perTurnToolCalls: Array<{ turn: number; tools: string[] }> = [];
    const files = { created: [] as string[], modified: [] as string[] };
    const commands: string[] = [];
    const mcpTools: string[] = [];
    let errorRecoveries = 0;
    let apiCallNum = 0;
    let lastWasError = false;
    let currentCallTools: string[] = [];
    // Track usage to detect new API calls (Claude emits multiple assistant events per call with same usage)
    let prevUsageKey = '';

    for (const event of events) {
        if (event.type === 'assistant' && event.message?.content) {
            // Detect new API call by comparing usage fingerprint
            const usage = event.message.usage;
            const usageKey = usage
                ? `${usage.input_tokens}:${usage.output_tokens}:${usage.cache_creation_input_tokens ?? 0}:${usage.cache_read_input_tokens ?? 0}`
                : '';
            const isNewApiCall = usageKey !== prevUsageKey;

            if (isNewApiCall) {
                // Save previous API call's tool list
                if (apiCallNum > 0) {
                    perTurnToolCalls.push({ turn: apiCallNum, tools: currentCallTools });
                }
                apiCallNum++;
                currentCallTools = [];
                prevUsageKey = usageKey;

                if (usage) {
                    perTurnTokens.push({
                        turn: apiCallNum,
                        input: usage.input_tokens,
                        output: usage.output_tokens,
                    });
                }
            }

            for (const block of event.message.content) {
                if (block.type === 'text' && block.text) {
                    text += block.text;
                }
                if (block.type === 'tool_use' && 'name' in block) {
                    const name = block.name as string;
                    const rawInput = block.input as Record<string, unknown> | undefined;
                    toolCalls.push(name);
                    currentCallTools.push(name);

                    toolCallDetails.push({ tool: name, turn: apiCallNum, input: rawInput ?? {} });

                    if (name.startsWith('mcp__')) mcpTools.push(name);
                    if (name === 'Write') {
                        const input = block.input as Record<string, unknown> | undefined;
                        if (input?.file_path) files.created.push(input.file_path as string);
                    }
                    if (name === 'Edit') {
                        const input = block.input as Record<string, unknown> | undefined;
                        if (input?.file_path) files.modified.push(input.file_path as string);
                    }
                    if (name === 'Bash') {
                        const input = block.input as Record<string, unknown> | undefined;
                        if (input?.command) {
                            const cmd = input.command as string;
                            commands.push(cmd);
                            const bashFileOps = extractFileOpsFromCommand(cmd);
                            files.created.push(...bashFileOps.created);
                            files.modified.push(...bashFileOps.modified);
                        }
                    }

                    if (lastWasError) {
                        errorRecoveries++;
                        lastWasError = false;
                    }
                }
            }
        }

        if (event.type === 'user') {
            const content = (event as unknown as Record<string, unknown>).content;
            if (Array.isArray(content)) {
                for (const block of content) {
                    if ((block as Record<string, unknown>).type === 'tool_result' &&
                        (block as Record<string, unknown>).is_error) {
                        lastWasError = true;
                    }
                }
            }
        }

        if (event.type === 'result') {
            resultEvent = event;
            accumDurationMs += event.duration_ms ?? 0;
            accumDurationApiMs += event.duration_api_ms ?? 0;
            accumNumTurns += event.num_turns ?? 0;
        }
    }

    // Push the last API call's tools
    if (apiCallNum > 0) {
        perTurnToolCalls.push({ turn: apiCallNum, tools: currentCallTools });
    }

    return {
        getText: () => text,
        getMetrics: () => ({
            inputTokens: resultEvent?.usage?.input_tokens ?? 0,
            outputTokens: resultEvent?.usage?.output_tokens ?? 0,
            cacheReadTokens: resultEvent?.usage?.cache_read_input_tokens ?? 0,
            cacheCreationTokens: resultEvent?.usage?.cache_creation_input_tokens ?? 0,
            totalCostUsd: resultEvent?.total_cost_usd ?? 0,
            durationMs: accumDurationMs,
            durationApiMs: accumDurationApiMs,
            numTurns: accumNumTurns || apiCallNum,
            modelUsage: resultEvent?.modelUsage ?? {},
        }),
        getError: () => {
            if (!resultEvent?.is_error) return null;
            // Budget exceeded is not a fatal error — agent still produced output
            if (resultEvent.subtype === 'error_max_budget_usd') return null;
            // tool_use stop = agent hit maxTurns mid-tool-call, not a fatal error
            if (resultEvent.stop_reason === 'tool_use') return null;
            return resultEvent.stop_reason ?? 'unknown error';
        },
        getStopReason: () => {
            if (resultEvent?.subtype === 'error_max_budget_usd') return 'budget_exceeded';
            if (resultEvent?.stop_reason === 'tool_use') return 'max_turns';
            return resultEvent?.stop_reason ?? 'unknown';
        },
        getTrajectoryData: () => ({
            toolCalls, toolCallDetails, perTurnTokens, perTurnToolCalls, errorRecoveries,
            files, commands, mcpTools,
        }),
    };
}

export function parseCodexStream(events: AgentEvent[]): ParsedStream {
    let text = '';
    let lastUsage: Record<string, number> | null = null;
    let error: string | null = null;
    let stopReason = 'end_turn';
    const toolCalls: string[] = [];
    const toolCallDetails: Array<{ tool: string; turn: number; input: Record<string, unknown> }> = [];
    const commands: string[] = [];
    const files = { created: [] as string[], modified: [] as string[] };
    const mcpTools: string[] = [];
    let turnNum = 0;
    let currentTurnTools: string[] = [];
    const perTurnTokens: Array<{ turn: number; input: number; output: number }> = [];
    const perTurnToolCalls: Array<{ turn: number; tools: string[] }> = [];

    for (const event of events) {
        if (event.type === 'turn.started') {
            turnNum++;
            currentTurnTools = [];
        }

        if (event.type === 'item.completed' && event.item) {
            if (event.item.type === 'agent_message' && event.item.text) {
                text += event.item.text;
            }
            if (event.item.type === 'command_execution') {
                toolCalls.push('command_execution');
                currentTurnTools.push('command_execution');
                toolCallDetails.push({
                    tool: 'command_execution',
                    turn: turnNum,
                    input: event.item.command ? { command: event.item.command } : {},
                });
                if (event.item.command) {
                    commands.push(event.item.command);
                    const bashFileOps = extractFileOpsFromCommand(event.item.command);
                    files.created.push(...bashFileOps.created);
                    files.modified.push(...bashFileOps.modified);
                }
            }
            if (event.item.type === 'file_change' && event.item.changes) {
                toolCalls.push('file_change');
                currentTurnTools.push('file_change');
                toolCallDetails.push({
                    tool: 'file_change',
                    turn: turnNum,
                    input: { changes: event.item.changes as unknown as Record<string, unknown> },
                });
                for (const change of event.item.changes) {
                    if (change.kind === 'add') files.created.push(change.path);
                    else files.modified.push(change.path);
                }
            }
            if (event.item.type === 'mcp_tool_call') {
                const toolName = event.item.tool ?? 'mcp_unknown';
                toolCalls.push(toolName);
                currentTurnTools.push(toolName);
                mcpTools.push(toolName);
                toolCallDetails.push({
                    tool: toolName,
                    turn: turnNum,
                    input: (event.item as unknown as { input?: Record<string, unknown> }).input ?? {},
                });
            }
        }

        if (event.type === 'turn.completed') {
            const usage = event.usage as Record<string, number> | undefined;
            if (usage) {
                lastUsage = usage;
                perTurnTokens.push({
                    turn: turnNum,
                    input: usage.input_tokens ?? 0,
                    output: usage.output_tokens ?? 0,
                });
            }
            perTurnToolCalls.push({ turn: turnNum, tools: currentTurnTools });
        }

        if (event.type === 'turn.failed') {
            error = event.error?.message ?? 'Turn failed';
            stopReason = 'error';
        }

        if (event.type === 'error') {
            error = error ?? (event.error?.message ?? 'Unknown error');
            stopReason = 'error';
        }
    }

    return {
        getText: () => text,
        getMetrics: () => ({
            inputTokens: lastUsage?.['input_tokens'] ?? 0,
            outputTokens: lastUsage?.['output_tokens'] ?? 0,
            cacheReadTokens: lastUsage?.['cached_input_tokens'] ?? 0,
            cacheCreationTokens: 0,
            totalCostUsd: 0,
            durationMs: 0,
            durationApiMs: 0,
            numTurns: turnNum,
            modelUsage: {},
        }),
        getError: () => error,
        getStopReason: () => stopReason,
        getTrajectoryData: () => ({
            toolCalls, toolCallDetails, perTurnTokens, perTurnToolCalls, errorRecoveries: 0,
            files, commands, mcpTools,
        }),
    };
}

export function parseOpenCodeStream(events: AgentEvent[]): ParsedStream {
    let text = '';
    let totalCost = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let error: string | null = null;
    let stopReason = 'end_turn';
    const toolCalls: string[] = [];
    const toolCallDetails: Array<{ tool: string; turn: number; input: Record<string, unknown> }> = [];
    const commands: string[] = [];
    const files = { created: [] as string[], modified: [] as string[] };
    const mcpTools: string[] = [];
    let turnNum = 0;
    const perTurnTokens: Array<{ turn: number; input: number; output: number }> = [];
    const perTurnToolCalls: Array<{ turn: number; tools: string[] }> = [];
    let currentTurnTools: string[] = [];

    for (const event of events) {
        if (event.type === 'step_start') {
            turnNum++;
            currentTurnTools = [];
        }

        if (event.type === 'text' && event.part?.text && event.part.time?.end) {
            text += event.part.text;
        }

        if (event.type === 'tool_use' && event.part) {
            const toolName = event.part.tool ?? 'unknown';
            toolCalls.push(toolName);
            currentTurnTools.push(toolName);

            // Populate toolCallDetails uniformly so the runner's host-aware
            // trajectory predicates (e.g. no-rest-surface-via-builtin-tools)
            // can inspect .input.url for webfetch/websearch calls the same
            // way they do for claude-code (parseClaudeStream at :225).
            const input = (event.part.state?.input as Record<string, unknown> | undefined) ?? {};
            toolCallDetails.push({ tool: toolName, turn: turnNum, input });

            if (toolName === 'edit' || toolName === 'write') {
                const path = input?.file_path as string | undefined ?? input?.path as string | undefined;
                if (path) {
                    if (toolName === 'write') files.created.push(path);
                    else files.modified.push(path);
                }
            }
            if (toolName === 'bash' || toolName === 'command') {
                const cmd = input?.command as string | undefined;
                if (cmd) commands.push(cmd);
            }
            if (toolName.includes('mcp') || toolName.includes(':')) {
                mcpTools.push(toolName);
            }
        }

        if (event.type === 'step_finish' && event.part) {
            if (event.part.tokens) {
                totalInput += event.part.tokens.input;
                totalOutput += event.part.tokens.output;
                totalCacheRead += event.part.tokens.cache?.read ?? 0;
                totalCacheWrite += event.part.tokens.cache?.write ?? 0;
                perTurnTokens.push({
                    turn: turnNum,
                    input: event.part.tokens.input,
                    output: event.part.tokens.output,
                });
            }
            if (event.part.cost) {
                totalCost += event.part.cost;
            }
            if (event.part.reason) {
                stopReason = event.part.reason;
            }
            perTurnToolCalls.push({ turn: turnNum, tools: currentTurnTools });
        }

        if (event.type === 'error') {
            error = event.errorData?.data?.message ?? event.error?.message ?? 'Unknown error';
            stopReason = 'error';
        }
    }

    return {
        getText: () => text,
        getMetrics: () => ({
            inputTokens: totalInput,
            outputTokens: totalOutput,
            cacheReadTokens: totalCacheRead,
            cacheCreationTokens: totalCacheWrite,
            totalCostUsd: totalCost,
            durationMs: 0, // Calculated from wall clock
            durationApiMs: 0,
            numTurns: turnNum,
            modelUsage: {},
        }),
        getError: () => error,
        getStopReason: () => stopReason,
        getTrajectoryData: () => ({
            toolCalls, toolCallDetails, perTurnTokens, perTurnToolCalls, errorRecoveries: 0,
            files, commands, mcpTools,
        }),
    };
}

// --- Metrics derivation ---

function deriveEfficiency(metrics: RunMetrics, perTurnToolCalls: Array<{ turn: number; tools: string[] }>): EfficiencyMetrics {
    const turns = metrics.numTurns || 1;
    const totalContext = metrics.inputTokens + metrics.cacheReadTokens + metrics.cacheCreationTokens;
    const executionTurns = perTurnToolCalls.filter((t) => t.tools.length > 0).length;
    const planningTurns = perTurnToolCalls.length - executionTurns;
    return {
        totalContextTokens: totalContext,
        tokensPerTurn: metrics.outputTokens / turns,
        costPerTurn: metrics.totalCostUsd / turns,
        cacheHitRate: totalContext > 0 ? metrics.cacheReadTokens / totalContext : 0,
        contextOutputRatio: metrics.outputTokens > 0 ? totalContext / metrics.outputTokens : 0,
        apiDurationRatio: metrics.durationMs > 0 ? metrics.durationApiMs / metrics.durationMs : 0,
        avgTurnDurationMs: metrics.durationMs / turns,
        toolExecutionMs: Math.max(0, metrics.durationMs - metrics.durationApiMs),
        planningTurns,
        executionTurns,
    };
}

function deriveTrajectory(data: ReturnType<ParsedStream['getTrajectoryData']>, numTurns: number): TrajectoryMetrics {
    return {
        toolCallCount: data.toolCalls.length,
        toolCallSequence: data.toolCalls,
        uniqueToolsUsed: [...new Set(data.toolCalls)],
        toolCallsPerTurn: numTurns > 0 ? data.toolCalls.length / numTurns : 0,
        perTurnTokens: data.perTurnTokens,
        perTurnToolCalls: data.perTurnToolCalls,
        toolCallDetails: data.toolCallDetails,
        errorRecoveryCount: data.errorRecoveries,
        filesCreated: data.files.created,
        filesModified: data.files.modified,
        commandsExecuted: data.commands,
        mcpToolsUsed: [...new Set(data.mcpTools)],
    };
}

// --- Main entry point ---

export function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
    const def = getAgentDef(options.agent);
    if (!def) {
        return Promise.resolve({
            text: '',
            metrics: EMPTY_METRICS,
            efficiency: EMPTY_EFFICIENCY,
            trajectory: EMPTY_TRAJECTORY,
            events: [],
            exitCode: 1,
            signal: null,
            aborted: false,
            error: `Unknown agent: ${options.agent}. Available: claude-code, codex, opencode`,
            stopReason: 'error',
            stderr: '',
            hungWarnings: [],
            shutdownReason: null,
        });
    }

    return new Promise((resolve) => {
        const effectivePrompt = applyPromptPrefix(options.systemPrompt, options.prompt);

        const args = buildAgentArgs(def, {
            prompt: effectivePrompt,
            // Deliberately NOT passing systemPrompt — the content is in
            // `prompt` above (via applyPromptPrefix). buildAgentArgs' existing
            // `if (opts.systemPrompt && def.systemPromptFlag)` gate becomes
            // dormant: nothing falsy or undefined ever reaches it. The
            // `systemPromptFlag` field in registry.ts is kept as
            // backwards-compat / documentation; if a future caller bypasses
            // runAgent and uses buildAgentArgs directly with a systemPrompt,
            // the old flag-based behaviour still works.
            model: options.model,
            maxTurns: options.maxTurns,
            maxBudgetUsd: options.maxBudgetUsd,
            mcpConfigPath: options.mcpConfigPath,
            strictMcpConfig: options.strictMcpConfig,
            pluginDirs: options.pluginDirs,
        });

        // Strip Apify runtime env vars that would otherwise bleed into the agent
        // subprocess (and any Actor it runs locally), causing the agent's locally-run
        // Actor to push its output into the runner's OWN cloud dataset / KV store /
        // request queue. The decisive var is APIFY_IS_AT_HOME (and the canonical
        // ACTOR_* storage IDs) — see buildChildEnv / APIFY_RUNTIME_KEYS_TO_STRIP in
        // ./apify-env.ts. Observed in eval-pack Run 7: an agent's locally-run scraper
        // wrote 879 product rows into the runner's default dataset, burying verdicts.
        const childEnv = buildChildEnv(options.env, options.cwd);

        const startTime = Date.now();
        const workDir = process.cwd();

        // Filesystem change marker — used after agent exits to detect file ops via find -newer
        const markerPath = join(workDir, `.eval-marker-${Date.now()}`);
        try { writeFileSync(markerPath, ''); } catch { /* ignore */ }

        const stdinOption = def.stdinMode === 'ignore' ? 'ignore' as const : 'pipe' as const;
        const child = spawn(def.command, args, {
            stdio: [stdinOption, 'pipe', 'pipe'],
            env: childEnv,
            cwd: options.cwd,
        });

        if (def.stdinMode === 'pipe-eof') {
            child.stdin!.write('\n');
            child.stdin!.end();
        }

        let aborted = false;
        let resolved = false;
        // Set when the silence-escalation ladder fires SIGTERM/SIGKILL/force-resolve.
        // Surfaced to the caller for analytics (e.g. "forced_teardown") without blocking
        // judge evaluation — agentOutput may still be complete even if subprocess hung.
        let shutdownReason: string | null = null;
        let sigkillTimer: NodeJS.Timeout | null = null;
        let forceResolveTimer: NodeJS.Timeout | null = null;

        if (options.abortSignal) {
            options.abortSignal.addEventListener('abort', () => {
                aborted = true;
                shutdownReason = 'aborted';
                child.kill('SIGTERM');
                setTimeout(() => {
                    if (!child.killed) child.kill('SIGKILL');
                }, 3000);
            }, { once: true });
        }

        const events: AgentEvent[] = [];
        const hungWarnings: HungWarning[] = [];
        let lastEventTime = Date.now();
        // Tool-call-aware silence detection. We do NOT count silence while a tool is
        // running on the agent's behalf (apify run, npm install, etc. can legitimately
        // take minutes). Multiple tool calls can be in flight concurrently (e.g.
        // background bash + foreground Read) — track them by tool_use id so the count
        // is reliable across interleaved events.
        const inFlightTools = new Set<string>();
        // Silence-escalation ladder. Drives subprocess teardown when the stream goes
        // quiet AND no tool is in flight. Replaces the per-result SIGTERM timer that
        // misfired on task-notification heartbeats (see GH#1).
        // Cascade: 30s notice → 40s warn → 50s warn → 60s SIGTERM → 70s SIGKILL → 75s force-resolve.
        let escalationLevel = 0; // 0 → 30 → 40 → 50 → 60
        let hangEpisodeActive = false;

        const logShutdown = (msg: string) => {
            // eslint-disable-next-line no-console
            console.warn(`[runAgent shutdown] ${msg} (pid=${child.pid}, killed=${child.killed})`);
        };

        const hungTimer = setInterval(() => {
            if (resolved) return;
            // Once SIGTERM has fired, downstream timers (SIGKILL, force-resolve) run
            // on their own schedule — do not re-evaluate or re-arm them even if a
            // late event arrives and resets silence below the notice threshold.
            if (escalationLevel >= 60) return;
            // Suppress silence detection while any tool is executing — apify nested
            // actor calls, long builds, etc. can legitimately take many minutes.
            if (inFlightTools.size > 0) {
                hangEpisodeActive = false;
                escalationLevel = 0;
                return;
            }
            const silence = Date.now() - lastEventTime;
            if (silence < SILENCE_NOTICE_MS) {
                hangEpisodeActive = false;
                escalationLevel = 0;
                return;
            }
            // Record/refresh hang episode in hungWarnings for downstream analytics.
            if (!hangEpisodeActive) {
                hungWarnings.push({
                    elapsedMs: Date.now() - startTime,
                    silenceSecs: Math.round(silence / 1000),
                });
                hangEpisodeActive = true;
            } else {
                hungWarnings[hungWarnings.length - 1].silenceSecs = Math.round(silence / 1000);
            }
            // Escalate one rung at a time so each step logs exactly once.
            if (silence >= SILENCE_SIGTERM_MS && escalationLevel < 60) {
                escalationLevel = 60;
                shutdownReason = 'silence_sigterm';
                logShutdown(`SIGTERM at ${Math.round(silence / 1000)}s sustained idle (no in-flight tools)`);
                child.kill('SIGTERM');
                sigkillTimer = setTimeout(() => {
                    if (resolved || child.killed) return;
                    shutdownReason = 'silence_sigkill';
                    logShutdown('SIGKILL — SIGTERM did not take effect');
                    child.kill('SIGKILL');
                }, SILENCE_SIGKILL_GRACE_MS);
                forceResolveTimer = setTimeout(() => {
                    if (resolved) return;
                    shutdownReason = 'silence_force_resolve';
                    logShutdown('force-resolve — subprocess still alive after SIGKILL');
                    finalize(null, 'SIGKILL');
                }, SILENCE_SIGKILL_GRACE_MS + SILENCE_FORCE_RESOLVE_GRACE_MS);
            } else if (silence >= SILENCE_WARN2_MS && escalationLevel < 50) {
                escalationLevel = 50;
                logShutdown(`silence ${Math.round(silence / 1000)}s — preparing to shutdown`);
            } else if (silence >= SILENCE_WARN1_MS && escalationLevel < 40) {
                escalationLevel = 40;
                logShutdown(`silence ${Math.round(silence / 1000)}s — warning`);
            } else if (silence >= SILENCE_NOTICE_MS && escalationLevel < 30) {
                escalationLevel = 30;
                logShutdown(`silence ${Math.round(silence / 1000)}s — idle (no in-flight tools)`);
            }
        }, SILENCE_CHECK_INTERVAL_MS);

        const rl = createInterface({ input: child.stdout! });

        rl.on('line', (line) => {
            if (!line.trim()) return;
            lastEventTime = Date.now();
            options.onRawLine?.(line);
            try {
                const event = JSON.parse(line) as AgentEvent;
                // Track in-flight tool_use ids. Add on assistant tool_use blocks,
                // drain on user tool_result blocks. claude-code attaches a unique
                // tool_use id to each block; tool_result events reference it via id.
                if (event.type === 'assistant' && event.message?.content) {
                    for (const block of event.message.content) {
                        if (block.type === 'tool_use') {
                            const id = (block as Record<string, unknown>).id as string | undefined;
                            if (id) inFlightTools.add(id);
                        }
                    }
                }
                if (event.type === 'user') {
                    const content = (event as unknown as Record<string, unknown>).content;
                    const contentArr = Array.isArray(content) ? content : (event.message?.content ?? []);
                    for (const block of contentArr as Array<Record<string, unknown>>) {
                        if (block.type === 'tool_result') {
                            const id = (block.tool_use_id ?? block.id) as string | undefined;
                            if (id) inFlightTools.delete(id);
                        }
                    }
                }
                events.push(event);
                options.onEvent?.(event);
            } catch { /* skip non-JSON */ }
        });

        let stderrOutput = '';
        child.stderr?.on('data', (d: Buffer) => { stderrOutput += d.toString(); });

        function finalize(code: number | null, signal: NodeJS.Signals | null) {
            if (resolved) return;
            resolved = true;
            clearInterval(hungTimer);
            if (sigkillTimer) clearTimeout(sigkillTimer);
            if (forceResolveTimer) clearTimeout(forceResolveTimer);
            doResolve(code, signal);
        }

        child.on('close', (code, signal) => {
            finalize(code, signal);
        });

        function doResolve(code: number | null, signal: NodeJS.Signals | null) {
            const wallDurationMs = Date.now() - startTime;

            // Select parser based on agent
            let parsed: ParsedStream;
            switch (options.agent) {
                case 'codex':
                    parsed = parseCodexStream(events);
                    break;
                case 'opencode':
                    parsed = parseOpenCodeStream(events);
                    break;
                default:
                    parsed = parseClaudeStream(events);
            }

            const metrics = parsed.getMetrics();

            // Fill wall-clock duration if agent doesn't report it
            if (metrics.durationMs === 0) {
                metrics.durationMs = wallDurationMs;
            }

            // Error detection: stream error OR non-zero exit without stream error
            let error = parsed.getError();
            if (!error && code !== 0 && code !== null) {
                error = stderrOutput.trim() || `Agent exited with code ${code}`;
            }

            const stopReason = error ? 'error' : parsed.getStopReason();
            const trajectoryData = parsed.getTrajectoryData();

            // Filesystem scan: detect files created/modified by agent (ground truth)
            const fsChanges = scanFilesystemChanges(markerPath, [workDir, '/tmp']);
            const eventFiles = new Set([...trajectoryData.files.created, ...trajectoryData.files.modified]);
            for (const f of fsChanges.created) {
                if (!eventFiles.has(f)) trajectoryData.files.created.push(f);
            }
            try { unlinkSync(markerPath); } catch { /* ignore */ }

            const trajectory = deriveTrajectory(trajectoryData, metrics.numTurns);

            // If the silence-escalation ladder fired (forced_teardown / etc.), prefer
            // that as the stopReason so analytics can distinguish "agent finished" vs
            // "we killed it". Do NOT promote it to `error` — the agentOutput may still
            // be complete; main.ts decides judge gating based on text.length.
            const finalStopReason = shutdownReason && !error ? 'forced_teardown' : stopReason;

            resolve({
                text: parsed.getText(),
                metrics,
                trajectory,
                efficiency: deriveEfficiency(metrics, trajectory.perTurnToolCalls),
                events,
                exitCode: code,
                signal,
                aborted,
                error,
                stopReason: finalStopReason,
                stderr: stderrOutput,
                hungWarnings,
                shutdownReason,
            });
        }

        child.on('error', (err) => {
            if (resolved) return;
            resolved = true;
            clearInterval(hungTimer);
            if (sigkillTimer) clearTimeout(sigkillTimer);
            if (forceResolveTimer) clearTimeout(forceResolveTimer);
            resolve({
                text: '',
                metrics: { ...EMPTY_METRICS, durationMs: Date.now() - startTime },
                efficiency: EMPTY_EFFICIENCY,
                trajectory: EMPTY_TRAJECTORY,
                events: [],
                exitCode: null,
                signal: null,
                aborted: false,
                error: `Failed to spawn ${def.command}: ${err.message}`,
                stopReason: 'error',
                stderr: '',
                hungWarnings,
                shutdownReason,
            });
        });
    });
}
