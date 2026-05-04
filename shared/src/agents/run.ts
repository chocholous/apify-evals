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

function parseNdjsonEvents(child: ReturnType<typeof spawn>, onEvent?: (e: ClaudeStreamEvent) => void): {
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
            const event: ClaudeStreamEvent = JSON.parse(line);
            events.push(event);
            onEvent?.(event);

            if (event.type === 'assistant' && event.message?.content) {
                for (const block of event.message.content) {
                    if (block.type === 'text' && block.text) {
                        text += block.text;
                    }
                }
            }
            if (event.type === 'result') {
                resultEvent = event;
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
            stdio: ['ignore', 'pipe', 'pipe'],
            env: childEnv,
        });

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
            const parser = parseNdjsonEvents(child, options.onEvent);
            events = parser.events;
            getText = parser.getText;
            getResult = parser.getResult;
        } else {
            const collector = collectPlainOutput(child);
            getText = collector.getText;
        }

        child.on('close', (code, signal) => {
            const resultEvent = getResult?.() ?? null;

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
