import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { ClaudeStreamEvent, RunMetrics } from '../types.js';
import { getAgentDef, buildAgentArgs, type AgentDef } from './registry.js';

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
    onEvent?: (event: ClaudeStreamEvent) => void;
    abortSignal?: AbortSignal;
}

export interface AgentRunResult {
    text: string;
    metrics: RunMetrics;
    events: ClaudeStreamEvent[];
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    aborted: boolean;
    error: string | null;
}

const EMPTY_METRICS: RunMetrics = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    totalCostUsd: 0, durationMs: 0, durationApiMs: 0, numTurns: 0, modelUsage: {},
};

function parseNdjsonEvents(child: ReturnType<typeof spawn>, agent: string, onEvent?: (e: ClaudeStreamEvent) => void): {
    events: ClaudeStreamEvent[];
    getText: () => string;
    getResult: () => ClaudeStreamEvent | null;
} {
    const events: ClaudeStreamEvent[] = [];
    let text = '';
    let resultEvent: ClaudeStreamEvent | null = null;

    const rl = createInterface({ input: child.stdout! });

    rl.on('line', (line) => {
        if (!line.trim()) return;
        try {
            const event = JSON.parse(line) as Record<string, unknown>;
            events.push(event as unknown as ClaudeStreamEvent);
            onEvent?.(event as unknown as ClaudeStreamEvent);

            if (agent === 'claude-code') {
                // Claude: assistant.message.content[].text
                if (event.type === 'assistant' && (event.message as Record<string, unknown>)?.content) {
                    for (const block of (event.message as Record<string, unknown>).content as Array<Record<string, unknown>>) {
                        if (block.type === 'text' && block.text) {
                            text += block.text as string;
                        }
                    }
                }
                if (event.type === 'result') {
                    resultEvent = event as unknown as ClaudeStreamEvent;
                }
            } else if (agent === 'codex') {
                // Codex: item.completed.item.text + turn.completed.usage
                console.log(`[codex event] type="${event.type}" keys=${Object.keys(event as Record<string, unknown>).join(',')}`);
                if (event.type === 'item.completed') {
                    const raw = event as Record<string, unknown>;
                    const item = raw.item as Record<string, unknown> | undefined;
                    if (item?.text) text += item.text as string;
                }
                if (event.type === 'turn.completed') {
                    const raw = event as Record<string, unknown>;
                    const usage = raw.usage as Record<string, number> | undefined;
                    resultEvent = {
                        type: 'result',
                        subtype: 'success',
                        is_error: false,
                        num_turns: 1,
                        usage: usage ? {
                            input_tokens: usage.input_tokens ?? 0,
                            output_tokens: usage.output_tokens ?? 0,
                            cache_read_input_tokens: usage.cached_input_tokens ?? 0,
                        } : undefined,
                    } as unknown as ClaudeStreamEvent;
                }
            } else {
                // Generic: try to extract text from common fields
                if (typeof event.text === 'string') text += event.text;
                if (typeof event.result === 'string') text += event.result;
            }
        } catch { /* skip non-JSON */ }
    });

    return {
        events,
        getText: () => text,
        getResult: () => resultEvent,
    };
}

function extractMetricsFromResult(resultEvent: ClaudeStreamEvent | null): RunMetrics {
    if (!resultEvent) return EMPTY_METRICS;
    return {
        inputTokens: resultEvent.usage?.input_tokens ?? 0,
        outputTokens: resultEvent.usage?.output_tokens ?? 0,
        cacheReadTokens: resultEvent.usage?.cache_read_input_tokens ?? 0,
        cacheCreationTokens: resultEvent.usage?.cache_creation_input_tokens ?? 0,
        totalCostUsd: resultEvent.total_cost_usd ?? 0,
        durationMs: resultEvent.duration_ms ?? 0,
        durationApiMs: resultEvent.duration_api_ms ?? 0,
        numTurns: resultEvent.num_turns ?? 0,
        modelUsage: resultEvent.modelUsage ?? {},
    };
}

function collectPlainOutput(child: ReturnType<typeof spawn>): { getText: () => string } {
    let text = '';
    child.stdout?.on('data', (d: Buffer) => { text += d.toString(); });
    return { getText: () => text };
}

export function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
    const def = getAgentDef(options.agent);
    if (!def) {
        return Promise.resolve({
            text: '',
            metrics: EMPTY_METRICS,
            events: [],
            exitCode: 1,
            signal: null,
            aborted: false,
            error: `Unknown agent: ${options.agent}. Available: claude-code, codex, opencode`,
        });
    }

    return runWithDef(def, options);
}

function runWithDef(def: AgentDef, options: AgentRunOptions): Promise<AgentRunResult> {
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

        const child = spawn(def.command, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: childEnv,
        });

        // Close stdin immediately — some CLIs (codex) wait for EOF
        child.stdin?.end();

        // Debug: log spawned command
        console.log(`[runAgent] ${def.command} ${args.join(' ').slice(0, 100)}...`);

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

        let getText: () => string;
        let getResult: (() => ClaudeStreamEvent | null) | null = null;
        let events: ClaudeStreamEvent[] = [];

        if (def.outputFormat === 'ndjson') {
            const parser = parseNdjsonEvents(child, options.agent, options.onEvent);
            events = parser.events;
            getText = parser.getText;
            getResult = parser.getResult;
        } else {
            const collector = collectPlainOutput(child);
            getText = collector.getText;
        }

        let stderrOutput = '';
        child.stderr?.on('data', (d: Buffer) => { stderrOutput += d.toString(); });

        child.on('close', (code, signal) => {
            const resultEvent = getResult?.() ?? null;
            console.log(`[runAgent] close: code=${code} text="${getText().slice(0, 50)}" events=${events.length} stderr="${stderrOutput.slice(0, 100)}"`);

            resolve({
                text: getText(),
                metrics: extractMetricsFromResult(resultEvent),
                events,
                exitCode: code,
                signal,
                aborted,
                error: resultEvent?.is_error ? (resultEvent.stop_reason ?? 'unknown error') : null,
            });
        });
    });
}
