import { describe, it, expect } from 'vitest';

import { extractMetrics, extractToolCalls, formatCost, formatDuration } from '../metrics.js';
import type { ClaudeStreamEvent } from '../types.js';

describe('extractMetrics', () => {
    it('extracts from result event', () => {
        const events: ClaudeStreamEvent[] = [
            { type: 'system', subtype: 'init' },
            { type: 'assistant', message: { model: 'claude-opus-4-6', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 10, output_tokens: 5 } } },
            {
                type: 'result',
                subtype: 'success',
                is_error: false,
                total_cost_usd: 0.05,
                duration_ms: 2000,
                duration_api_ms: 1800,
                num_turns: 1,
                usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 300 },
                modelUsage: { 'claude-opus-4-6': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 200, cacheCreationInputTokens: 300, costUSD: 0.05 } },
            },
        ];

        const m = extractMetrics(events);
        expect(m.inputTokens).toBe(100);
        expect(m.outputTokens).toBe(50);
        expect(m.cacheReadTokens).toBe(200);
        expect(m.cacheCreationTokens).toBe(300);
        expect(m.totalCostUsd).toBe(0.05);
        expect(m.durationMs).toBe(2000);
        expect(m.numTurns).toBe(1);
        expect(m.modelUsage['claude-opus-4-6'].costUSD).toBe(0.05);
    });

    it('returns zeros when no result event', () => {
        const m = extractMetrics([{ type: 'system', subtype: 'init' }]);
        expect(m.inputTokens).toBe(0);
        expect(m.totalCostUsd).toBe(0);
    });
});

describe('extractToolCalls', () => {
    it('extracts tool names from assistant messages', () => {
        const events: ClaudeStreamEvent[] = [
            {
                type: 'assistant',
                message: {
                    model: 'test',
                    content: [
                        { type: 'tool_use', name: 'Bash' } as never,
                        { type: 'text', text: 'some text' },
                        { type: 'tool_use', name: 'Read' } as never,
                    ],
                    usage: { input_tokens: 0, output_tokens: 0 },
                },
            },
        ];

        const tools = extractToolCalls(events);
        expect(tools).toEqual(['Bash', 'Read']);
    });

    it('returns empty for no tool calls', () => {
        const events: ClaudeStreamEvent[] = [
            { type: 'assistant', message: { model: 'test', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 0, output_tokens: 0 } } },
        ];
        expect(extractToolCalls(events)).toEqual([]);
    });
});

describe('formatCost', () => {
    it('formats tiny costs', () => expect(formatCost(0.000123)).toBe('$0.000123'));
    it('formats small costs', () => expect(formatCost(0.0567)).toBe('$0.0567'));
    it('formats normal costs', () => expect(formatCost(1.23)).toBe('$1.23'));
});

describe('formatDuration', () => {
    it('formats ms', () => expect(formatDuration(500)).toBe('500ms'));
    it('formats seconds', () => expect(formatDuration(5000)).toBe('5.0s'));
    it('formats minutes', () => expect(formatDuration(120000)).toBe('2.0m'));
});
