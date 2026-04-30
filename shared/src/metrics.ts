import type { ClaudeStreamEvent, RunMetrics } from './types.js';

export function extractMetrics(events: ClaudeStreamEvent[]): RunMetrics {
    const resultEvent = events.find((e) => e.type === 'result');

    return {
        inputTokens: resultEvent?.usage?.input_tokens ?? 0,
        outputTokens: resultEvent?.usage?.output_tokens ?? 0,
        cacheReadTokens: resultEvent?.usage?.cache_read_input_tokens ?? 0,
        cacheCreationTokens: resultEvent?.usage?.cache_creation_input_tokens ?? 0,
        totalCostUsd: resultEvent?.total_cost_usd ?? 0,
        durationMs: resultEvent?.duration_ms ?? 0,
        durationApiMs: resultEvent?.duration_api_ms ?? 0,
        numTurns: resultEvent?.num_turns ?? 0,
        modelUsage: resultEvent?.modelUsage ?? {},
    };
}

export function extractToolCalls(events: ClaudeStreamEvent[]): string[] {
    const tools: string[] = [];
    for (const event of events) {
        if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
                if (block.type === 'tool_use' && 'name' in block) {
                    tools.push(block.name as string);
                }
            }
        }
    }
    return tools;
}

export function formatCost(usd: number): string {
    if (usd < 0.01) return `$${usd.toFixed(6)}`;
    if (usd < 1) return `$${usd.toFixed(4)}`;
    return `$${usd.toFixed(2)}`;
}

export function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60_000).toFixed(1)}m`;
}
