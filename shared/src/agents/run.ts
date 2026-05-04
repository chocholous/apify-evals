import { spawn, execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentEvent, RunMetrics, EfficiencyMetrics, TrajectoryMetrics } from '../types.js';
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
    env?: Record<string, string>;
    onEvent?: (event: AgentEvent) => void;
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
}

const EMPTY_METRICS: RunMetrics = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    totalCostUsd: 0, durationMs: 0, durationApiMs: 0, numTurns: 0, modelUsage: {},
};

const EMPTY_EFFICIENCY: EfficiencyMetrics = {
    tokensPerTurn: 0, costPerTurn: 0, cacheHitRate: 0,
    inputOutputRatio: 0, apiDurationRatio: 0, avgTurnDurationMs: 0,
};

const EMPTY_TRAJECTORY: TrajectoryMetrics = {
    toolCallCount: 0, toolCallSequence: [], uniqueToolsUsed: [], toolCallsPerTurn: 0,
    perTurnTokens: [], perTurnToolCalls: [],
    errorRecoveryCount: 0,
    filesCreated: [], filesModified: [], commandsExecuted: [], mcpToolsUsed: [],
};

// --- Bash command file-op detection ---

const REDIRECT_PATTERN = /(?:^|[;&|]\s*)(?:echo|printf|cat)\s+.*?>\s*(\S+)/g;
const TEE_PATTERN = /\btee\s+(?:-a\s+)?(\S+)/g;
const CP_MV_PATTERN = /\b(?:cp|mv)\s+.*?\s+(\S+)\s*$/gm;

function extractFileOpsFromCommand(cmd: string): { created: string[]; modified: string[] } {
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
            const output = execSync(
                `find ${dir} -newer ${markerPath} -type f 2>/dev/null || true`,
                { encoding: 'utf-8', timeout: 5000 },
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
        perTurnTokens: Array<{ turn: number; input: number; output: number }>;
        perTurnToolCalls: Array<{ turn: number; tools: string[] }>;
        errorRecoveries: number;
        files: { created: string[]; modified: string[] };
        commands: string[];
        mcpTools: string[];
    };
}

function parseClaudeStream(events: AgentEvent[]): ParsedStream {
    let text = '';
    let resultEvent: AgentEvent | null = null;
    const toolCalls: string[] = [];
    const perTurnTokens: Array<{ turn: number; input: number; output: number }> = [];
    const perTurnToolCalls: Array<{ turn: number; tools: string[] }> = [];
    const files = { created: [] as string[], modified: [] as string[] };
    const commands: string[] = [];
    const mcpTools: string[] = [];
    let errorRecoveries = 0;
    let turnNum = 0;
    let lastWasError = false;
    let currentTurnTools: string[] = [];

    for (const event of events) {
        if (event.type === 'assistant' && event.message?.content) {
            turnNum++;
            currentTurnTools = [];
            for (const block of event.message.content) {
                if (block.type === 'text' && block.text) {
                    text += block.text;
                }
                if (block.type === 'tool_use' && 'name' in block) {
                    const name = block.name as string;
                    toolCalls.push(name);
                    currentTurnTools.push(name);

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
                            commands.push(cmd.slice(0, 200));
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
            if (event.message.usage) {
                perTurnTokens.push({
                    turn: turnNum,
                    input: event.message.usage.input_tokens,
                    output: event.message.usage.output_tokens,
                });
            }
            perTurnToolCalls.push({ turn: turnNum, tools: currentTurnTools });
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
        }
    }

    return {
        getText: () => text,
        getMetrics: () => ({
            inputTokens: resultEvent?.usage?.input_tokens ?? 0,
            outputTokens: resultEvent?.usage?.output_tokens ?? 0,
            cacheReadTokens: resultEvent?.usage?.cache_read_input_tokens ?? 0,
            cacheCreationTokens: resultEvent?.usage?.cache_creation_input_tokens ?? 0,
            totalCostUsd: resultEvent?.total_cost_usd ?? 0,
            durationMs: resultEvent?.duration_ms ?? 0,
            durationApiMs: resultEvent?.duration_api_ms ?? 0,
            numTurns: resultEvent?.num_turns ?? turnNum,
            modelUsage: resultEvent?.modelUsage ?? {},
        }),
        getError: () => {
            if (!resultEvent?.is_error) return null;
            // Budget exceeded is not a fatal error — agent still produced output
            if (resultEvent.subtype === 'error_max_budget_usd') return null;
            return resultEvent.stop_reason ?? 'unknown error';
        },
        getStopReason: () => {
            if (resultEvent?.subtype === 'error_max_budget_usd') return 'budget_exceeded';
            return resultEvent?.stop_reason ?? 'unknown';
        },
        getTrajectoryData: () => ({
            toolCalls, perTurnTokens, perTurnToolCalls, errorRecoveries,
            files, commands, mcpTools,
        }),
    };
}

function parseCodexStream(events: AgentEvent[]): ParsedStream {
    let text = '';
    let lastUsage: Record<string, number> | null = null;
    let error: string | null = null;
    let stopReason = 'end_turn';
    const toolCalls: string[] = [];
    const commands: string[] = [];
    const files = { created: [] as string[], modified: [] as string[] };
    const mcpTools: string[] = [];
    let turnNum = 0;
    const perTurnTokens: Array<{ turn: number; input: number; output: number }> = [];
    const perTurnToolCalls: Array<{ turn: number; tools: string[] }> = [];

    for (const event of events) {
        if (event.type === 'turn.started') {
            turnNum++;
        }

        if (event.type === 'item.completed' && event.item) {
            if (event.item.type === 'agent_message' && event.item.text) {
                text += event.item.text;
            }
            if (event.item.type === 'command_execution') {
                toolCalls.push('command_execution');
                if (event.item.command) {
                    commands.push(event.item.command.slice(0, 200));
                    const bashFileOps = extractFileOpsFromCommand(event.item.command);
                    files.created.push(...bashFileOps.created);
                    files.modified.push(...bashFileOps.modified);
                }
            }
            if (event.item.type === 'file_change' && event.item.changes) {
                toolCalls.push('file_change');
                for (const change of event.item.changes) {
                    if (change.kind === 'add') files.created.push(change.path);
                    else files.modified.push(change.path);
                }
            }
            if (event.item.type === 'mcp_tool_call') {
                const toolName = event.item.tool ?? 'mcp_unknown';
                toolCalls.push(toolName);
                mcpTools.push(toolName);
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
            perTurnToolCalls.push({ turn: turnNum, tools: [...toolCalls.slice(-10)] });
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
            toolCalls, perTurnTokens, perTurnToolCalls, errorRecoveries: 0,
            files, commands, mcpTools,
        }),
    };
}

function parseOpenCodeStream(events: AgentEvent[]): ParsedStream {
    let text = '';
    let totalCost = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let error: string | null = null;
    let stopReason = 'end_turn';
    const toolCalls: string[] = [];
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

            if (toolName === 'edit' || toolName === 'write') {
                const input = event.part.state?.input as Record<string, unknown> | undefined;
                const path = input?.file_path as string | undefined ?? input?.path as string | undefined;
                if (path) {
                    if (toolName === 'write') files.created.push(path);
                    else files.modified.push(path);
                }
            }
            if (toolName === 'bash' || toolName === 'command') {
                const input = event.part.state?.input as Record<string, unknown> | undefined;
                const cmd = input?.command as string | undefined;
                if (cmd) commands.push(cmd.slice(0, 200));
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
            toolCalls, perTurnTokens, perTurnToolCalls, errorRecoveries: 0,
            files, commands, mcpTools,
        }),
    };
}

// --- Metrics derivation ---

function deriveEfficiency(metrics: RunMetrics): EfficiencyMetrics {
    const turns = metrics.numTurns || 1;
    return {
        tokensPerTurn: metrics.outputTokens / turns,
        costPerTurn: metrics.totalCostUsd / turns,
        cacheHitRate: metrics.inputTokens > 0 ? metrics.cacheReadTokens / metrics.inputTokens : 0,
        inputOutputRatio: metrics.outputTokens > 0 ? metrics.inputTokens / metrics.outputTokens : 0,
        apiDurationRatio: metrics.durationMs > 0 ? metrics.durationApiMs / metrics.durationMs : 0,
        avgTurnDurationMs: metrics.durationMs / turns,
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
        });
    }

    return new Promise((resolve) => {
        const args = buildAgentArgs(def, {
            prompt: options.prompt,
            systemPrompt: options.systemPrompt,
            model: options.model,
            maxTurns: options.maxTurns,
            maxBudgetUsd: options.maxBudgetUsd,
            mcpConfigPath: options.mcpConfigPath,
            strictMcpConfig: options.strictMcpConfig,
        });

        const childEnv = options.env ? { ...process.env, ...options.env } : process.env;
        const startTime = Date.now();
        const workDir = process.cwd();

        // Filesystem change marker — used after agent exits to detect file ops via find -newer
        const markerPath = join(workDir, `.eval-marker-${Date.now()}`);
        try { writeFileSync(markerPath, ''); } catch { /* ignore */ }

        const stdinOption = def.stdinMode === 'ignore' ? 'ignore' as const : 'pipe' as const;
        const child = spawn(def.command, args, {
            stdio: [stdinOption, 'pipe', 'pipe'],
            env: childEnv,
        });

        if (def.stdinMode === 'pipe-eof') {
            child.stdin!.write('\n');
            child.stdin!.end();
        }

        let aborted = false;

        if (options.abortSignal) {
            options.abortSignal.addEventListener('abort', () => {
                aborted = true;
                child.kill('SIGTERM');
                setTimeout(() => {
                    if (!child.killed) child.kill('SIGKILL');
                }, 3000);
            }, { once: true });
        }

        const events: AgentEvent[] = [];
        const rl = createInterface({ input: child.stdout! });

        rl.on('line', (line) => {
            if (!line.trim()) return;
            try {
                const event = JSON.parse(line) as AgentEvent;
                events.push(event);
                options.onEvent?.(event);
            } catch { /* skip non-JSON */ }
        });

        let stderrOutput = '';
        child.stderr?.on('data', (d: Buffer) => { stderrOutput += d.toString(); });

        child.on('close', (code, signal) => {
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
                error = stderrOutput.trim().slice(0, 500) || `Agent exited with code ${code}`;
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

            resolve({
                text: parsed.getText(),
                metrics,
                efficiency: deriveEfficiency(metrics),
                trajectory: deriveTrajectory(trajectoryData, metrics.numTurns),
                events,
                exitCode: code,
                signal,
                aborted,
                error,
                stopReason,
                stderr: stderrOutput.slice(0, 2000),
            });
        });

        child.on('error', (err) => {
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
            });
        });
    });
}
