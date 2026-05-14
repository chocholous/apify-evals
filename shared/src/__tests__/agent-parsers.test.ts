/**
 * Tests for per-agent event stream parsing.
 * Tests the actual exported parser functions from run.ts using synthetic events.
 */
import { describe, it, expect } from 'vitest';

import { runAgent, parseClaudeStream, parseCodexStream, parseOpenCodeStream, extractFileOpsFromCommand } from '../agents/run.js';
import type { AgentEvent } from '../types.js';

describe('runAgent — error handling', () => {
    it('returns error for unknown agent', async () => {
        const result = await runAgent({
            agent: 'nonexistent',
            prompt: 'test',
        });
        expect(result.error).toContain('Unknown agent');
        expect(result.exitCode).toBe(1);
        expect(result.stopReason).toBe('error');
    });

    it('returns error when command not found (fake agent)', async () => {
        const result = await runAgent({
            agent: 'nonexistent-agent-xyz',
            prompt: 'test',
        });
        expect(result.error).toContain('Unknown agent');
        expect(result.stopReason).toBe('error');
        expect(result.metrics.inputTokens).toBe(0);
    });
});

describe('parseClaudeStream', () => {
    it('extracts text from assistant events', () => {
        const events: AgentEvent[] = [
            {
                type: 'assistant',
                message: {
                    model: 'claude-sonnet-4-6',
                    content: [
                        { type: 'text', text: 'Hello ' },
                        { type: 'text', text: 'world' },
                    ],
                    usage: { input_tokens: 100, output_tokens: 10 },
                },
            },
            {
                type: 'result',
                is_error: false,
                stop_reason: 'end_turn',
                total_cost_usd: 0.001,
                num_turns: 1,
                duration_ms: 1000,
                duration_api_ms: 800,
                usage: { input_tokens: 100, output_tokens: 10 },
            },
        ];

        const parsed = parseClaudeStream(events);
        expect(parsed.getText()).toBe('Hello world');
        expect(parsed.getMetrics().totalCostUsd).toBe(0.001);
        expect(parsed.getMetrics().durationMs).toBe(1000);
        expect(parsed.getMetrics().durationApiMs).toBe(800);
        expect(parsed.getError()).toBeNull();
        expect(parsed.getStopReason()).toBe('end_turn');
    });

    it('extracts tool calls and commands from assistant events', () => {
        const events: AgentEvent[] = [
            {
                type: 'assistant',
                message: {
                    model: 'claude-sonnet-4-6',
                    content: [
                        { type: 'text', text: 'Let me check.' },
                        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } } as unknown as { type: string; text?: string },
                    ],
                    usage: { input_tokens: 200, output_tokens: 50 },
                },
            },
            {
                type: 'assistant',
                message: {
                    model: 'claude-sonnet-4-6',
                    content: [
                        { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/x' } } as unknown as { type: string; text?: string },
                        { type: 'text', text: 'Done.' },
                    ],
                    usage: { input_tokens: 300, output_tokens: 30 },
                },
            },
        ];

        const parsed = parseClaudeStream(events);
        const traj = parsed.getTrajectoryData();
        expect(traj.toolCalls).toEqual(['Bash', 'Read']);
        expect(traj.commands).toEqual(['ls']);
    });

    it('detects budget_exceeded as non-error with correct stopReason', () => {
        const events: AgentEvent[] = [
            {
                type: 'assistant',
                message: {
                    model: 'claude-sonnet-4-6',
                    content: [{ type: 'text', text: 'Answer' }],
                    usage: { input_tokens: 500, output_tokens: 100 },
                },
            },
            {
                type: 'result',
                subtype: 'error_max_budget_usd',
                is_error: true,
                stop_reason: 'end_turn',
                total_cost_usd: 0.07,
                num_turns: 1,
                duration_ms: 5000,
                usage: { input_tokens: 500, output_tokens: 100 },
            },
        ];

        const parsed = parseClaudeStream(events);
        expect(parsed.getError()).toBeNull();
        expect(parsed.getStopReason()).toBe('budget_exceeded');
    });

    it('detects tool_use stop_reason as max_turns', () => {
        const events: AgentEvent[] = [
            {
                type: 'result',
                is_error: true,
                stop_reason: 'tool_use',
                total_cost_usd: 0.03,
                num_turns: 10,
                duration_ms: 3000,
                usage: { input_tokens: 500, output_tokens: 100 },
            },
        ];

        const parsed = parseClaudeStream(events);
        expect(parsed.getError()).toBeNull();
        expect(parsed.getStopReason()).toBe('max_turns');
    });

    it('detects Write tool as file creation', () => {
        const events: AgentEvent[] = [
            {
                type: 'assistant',
                message: {
                    model: 'claude-sonnet-4-6',
                    content: [
                        { type: 'tool_use', name: 'Write', input: { file_path: '/tmp/test.ts' } } as unknown as { type: string; text?: string },
                    ],
                    usage: { input_tokens: 100, output_tokens: 10 },
                },
            },
        ];

        const parsed = parseClaudeStream(events);
        expect(parsed.getTrajectoryData().files.created).toContain('/tmp/test.ts');
    });

    it('detects Edit tool as file modification', () => {
        const events: AgentEvent[] = [
            {
                type: 'assistant',
                message: {
                    model: 'claude-sonnet-4-6',
                    content: [
                        { type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/test.ts' } } as unknown as { type: string; text?: string },
                    ],
                    usage: { input_tokens: 100, output_tokens: 10 },
                },
            },
        ];

        const parsed = parseClaudeStream(events);
        expect(parsed.getTrajectoryData().files.modified).toContain('/tmp/test.ts');
    });

    it('detects MCP tools', () => {
        const events: AgentEvent[] = [
            {
                type: 'assistant',
                message: {
                    model: 'claude-sonnet-4-6',
                    content: [
                        { type: 'tool_use', name: 'mcp__github__search', input: {} } as unknown as { type: string; text?: string },
                    ],
                    usage: { input_tokens: 100, output_tokens: 10 },
                },
            },
        ];

        const parsed = parseClaudeStream(events);
        expect(parsed.getTrajectoryData().mcpTools).toContain('mcp__github__search');
    });

    it('tracks error recovery when tool call follows tool error', () => {
        const events: AgentEvent[] = [
            {
                type: 'assistant',
                message: {
                    model: 'claude-sonnet-4-6',
                    content: [
                        { type: 'tool_use', name: 'Bash', input: { command: 'bad-cmd' } } as unknown as { type: string; text?: string },
                    ],
                    usage: { input_tokens: 100, output_tokens: 10 },
                },
            },
            {
                type: 'user',
                content: [{ type: 'tool_result', is_error: true }],
            } as unknown as AgentEvent,
            {
                type: 'assistant',
                message: {
                    model: 'claude-sonnet-4-6',
                    content: [
                        { type: 'tool_use', name: 'Bash', input: { command: 'good-cmd' } } as unknown as { type: string; text?: string },
                    ],
                    usage: { input_tokens: 200, output_tokens: 20 },
                },
            },
        ];

        const parsed = parseClaudeStream(events);
        expect(parsed.getTrajectoryData().errorRecoveries).toBe(1);
    });

    it('tracks per-turn tokens and tool calls across API calls', () => {
        const events: AgentEvent[] = [
            {
                type: 'assistant',
                message: {
                    model: 'claude-sonnet-4-6',
                    content: [
                        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } } as unknown as { type: string; text?: string },
                    ],
                    usage: { input_tokens: 100, output_tokens: 10 },
                },
            },
            {
                type: 'assistant',
                message: {
                    model: 'claude-sonnet-4-6',
                    content: [{ type: 'text', text: 'Done.' }],
                    usage: { input_tokens: 200, output_tokens: 20 },
                },
            },
        ];

        const parsed = parseClaudeStream(events);
        const traj = parsed.getTrajectoryData();
        expect(traj.perTurnTokens).toHaveLength(2);
        expect(traj.perTurnTokens[0].input).toBe(100);
        expect(traj.perTurnTokens[1].input).toBe(200);
        expect(traj.perTurnToolCalls).toHaveLength(2);
        expect(traj.perTurnToolCalls[0].tools).toEqual(['Bash']);
        expect(traj.perTurnToolCalls[1].tools).toEqual([]);
    });

    it('truncates large tool inputs to TOOL_INPUT_MAX_CHARS', () => {
        const longInput = 'x'.repeat(1000);
        const events: AgentEvent[] = [
            {
                type: 'assistant',
                message: {
                    model: 'claude-sonnet-4-6',
                    content: [
                        { type: 'tool_use', name: 'Write', input: { file_path: '/tmp/test', content: longInput } } as unknown as { type: string; text?: string },
                    ],
                    usage: { input_tokens: 100, output_tokens: 10 },
                },
            },
        ];

        const parsed = parseClaudeStream(events);
        const detail = parsed.getTrajectoryData().toolCallDetails[0];
        expect((detail.input.content as string).length).toBe(500);
    });

    it('ignores stream_event events from --include-partial-messages', () => {
        const events: AgentEvent[] = [
            { type: 'stream_event', event: { type: 'message_start' } } as unknown as AgentEvent,
            { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } } as unknown as AgentEvent,
            { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } } } as unknown as AgentEvent,
            { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } } } as unknown as AgentEvent,
            { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } } as unknown as AgentEvent,
            {
                type: 'assistant',
                message: {
                    model: 'claude-sonnet-4-6',
                    content: [{ type: 'text', text: 'Hello world' }],
                    usage: { input_tokens: 100, output_tokens: 10 },
                },
            },
            { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } } as unknown as AgentEvent,
            { type: 'stream_event', event: { type: 'message_stop' } } as unknown as AgentEvent,
            {
                type: 'result',
                is_error: false,
                stop_reason: 'end_turn',
                total_cost_usd: 0.001,
                num_turns: 1,
                duration_ms: 1000,
                duration_api_ms: 800,
                usage: { input_tokens: 100, output_tokens: 10 },
            },
        ];

        const parsed = parseClaudeStream(events);
        expect(parsed.getText()).toBe('Hello world');
        expect(parsed.getMetrics().totalCostUsd).toBe(0.001);
        expect(parsed.getError()).toBeNull();
        expect(parsed.getStopReason()).toBe('end_turn');
        expect(parsed.getTrajectoryData().toolCalls).toEqual([]);
    });

    it('extracts file ops from Bash commands', () => {
        const events: AgentEvent[] = [
            {
                type: 'assistant',
                message: {
                    model: 'claude-sonnet-4-6',
                    content: [
                        { type: 'tool_use', name: 'Bash', input: { command: 'echo "test" > output.txt' } } as unknown as { type: string; text?: string },
                    ],
                    usage: { input_tokens: 100, output_tokens: 10 },
                },
            },
        ];

        const parsed = parseClaudeStream(events);
        const traj = parsed.getTrajectoryData();
        expect(traj.files.created).toContain('output.txt');
        expect(traj.commands).toHaveLength(1);
    });
});

describe('parseCodexStream', () => {
    it('extracts text from item.completed (agent_message)', () => {
        const events: AgentEvent[] = [
            { type: 'turn.started' },
            { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'The answer is 42.' } },
            { type: 'turn.completed', usage: { input_tokens: 500, output_tokens: 50, cached_input_tokens: 400 } } as unknown as AgentEvent,
        ];

        const parsed = parseCodexStream(events);
        expect(parsed.getText()).toBe('The answer is 42.');
        const metrics = parsed.getMetrics();
        expect(metrics.inputTokens).toBe(500);
        expect(metrics.cacheReadTokens).toBe(400);
        expect(metrics.numTurns).toBe(1);
    });

    it('detects errors from turn.failed', () => {
        const events: AgentEvent[] = [
            { type: 'turn.started' },
            { type: 'turn.failed', error: { message: 'Rate limit exceeded' } },
        ];

        const parsed = parseCodexStream(events);
        expect(parsed.getError()).toBe('Rate limit exceeded');
        expect(parsed.getStopReason()).toBe('error');
    });

    it('detects errors from error event', () => {
        const events: AgentEvent[] = [
            { type: 'error', error: { message: 'Connection reset' } },
        ];

        const parsed = parseCodexStream(events);
        expect(parsed.getError()).toBe('Connection reset');
        expect(parsed.getStopReason()).toBe('error');
    });

    it('extracts tool usage from item events', () => {
        const events: AgentEvent[] = [
            { type: 'turn.started' },
            { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'npm test', exit_code: 0 } },
            { type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: 'src/app.ts', kind: 'update' }] } },
            { type: 'item.completed', item: { id: 'i3', type: 'mcp_tool_call', tool: 'github_search' } },
            { type: 'item.completed', item: { id: 'i4', type: 'agent_message', text: 'Done.' } },
            { type: 'turn.completed', usage: { input_tokens: 1000, output_tokens: 200 } } as unknown as AgentEvent,
        ];

        const parsed = parseCodexStream(events);
        const traj = parsed.getTrajectoryData();
        expect(traj.toolCalls).toEqual(['command_execution', 'file_change', 'github_search']);
        expect(traj.commands).toEqual(['npm test']);
        expect(traj.files.modified).toEqual(['src/app.ts']);
        expect(traj.mcpTools).toEqual(['github_search']);
    });

    it('detects file_change with add kind as created', () => {
        const events: AgentEvent[] = [
            { type: 'turn.started' },
            { type: 'item.completed', item: { id: 'i1', type: 'file_change', changes: [{ path: 'new-file.ts', kind: 'add' }] } },
            { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 10 } } as unknown as AgentEvent,
        ];

        const parsed = parseCodexStream(events);
        expect(parsed.getTrajectoryData().files.created).toEqual(['new-file.ts']);
    });

    it('tracks per-turn tokens and tool calls', () => {
        const events: AgentEvent[] = [
            { type: 'turn.started' },
            { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'ls' } },
            { type: 'turn.completed', usage: { input_tokens: 500, output_tokens: 50 } } as unknown as AgentEvent,
            { type: 'turn.started' },
            { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'Done.' } },
            { type: 'turn.completed', usage: { input_tokens: 800, output_tokens: 30 } } as unknown as AgentEvent,
        ];

        const parsed = parseCodexStream(events);
        const traj = parsed.getTrajectoryData();
        expect(traj.perTurnTokens).toHaveLength(2);
        expect(traj.perTurnTokens[0]).toEqual({ turn: 1, input: 500, output: 50 });
        expect(traj.perTurnTokens[1]).toEqual({ turn: 2, input: 800, output: 30 });
        expect(traj.perTurnToolCalls[0].tools).toEqual(['command_execution']);
        expect(traj.perTurnToolCalls[1].tools).toEqual([]);
    });
});

describe('parseOpenCodeStream', () => {
    it('extracts text only from events with time.end', () => {
        const events: AgentEvent[] = [
            { type: 'step_start', part: { id: 'p1', type: 'step-start' } },
            { type: 'text', part: { id: 'p2', type: 'text', text: 'Intermediate...', time: { start: 100 } } },
            { type: 'text', part: { id: 'p3', type: 'text', text: 'The answer is 42.', time: { start: 100, end: 200 } } },
            {
                type: 'step_finish', part: {
                    id: 'p4', type: 'step-finish', reason: 'end_turn',
                    cost: 0.004, tokens: { input: 1000, output: 50, reasoning: 0, cache: { read: 800, write: 0 } },
                },
            },
        ];

        const parsed = parseOpenCodeStream(events);
        expect(parsed.getText()).toBe('The answer is 42.');
        const metrics = parsed.getMetrics();
        expect(metrics.totalCostUsd).toBe(0.004);
        expect(metrics.inputTokens).toBe(1000);
        expect(metrics.outputTokens).toBe(50);
        expect(metrics.cacheReadTokens).toBe(800);
        expect(parsed.getStopReason()).toBe('end_turn');
    });

    it('detects errors from error events', () => {
        const events: AgentEvent[] = [
            { type: 'step_start', part: { id: 'p1', type: 'step-start' } },
            { type: 'error', error: { message: 'API rate limit' } },
        ];

        const parsed = parseOpenCodeStream(events);
        expect(parsed.getError()).toBe('API rate limit');
        expect(parsed.getStopReason()).toBe('error');
    });

    it('prefers errorData.data.message for error extraction', () => {
        const events: AgentEvent[] = [
            { type: 'error', errorData: { name: 'APIError', data: { message: 'Detailed error' } }, error: { message: 'Generic' } },
        ];

        const parsed = parseOpenCodeStream(events);
        expect(parsed.getError()).toBe('Detailed error');
    });

    it('extracts tool usage from tool_use events', () => {
        const events: AgentEvent[] = [
            { type: 'step_start', part: { id: 'p1', type: 'step-start' } },
            { type: 'tool_use', part: { id: 'p2', type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'ls -la' } } } },
            { type: 'tool_use', part: { id: 'p3', type: 'tool', tool: 'edit', state: { status: 'completed', input: { file_path: '/tmp/x.ts' } } } },
            {
                type: 'step_finish', part: {
                    id: 'p4', type: 'step-finish', reason: 'end_turn',
                    cost: 0.01, tokens: { input: 2000, output: 100, reasoning: 0 },
                },
            },
        ];

        const parsed = parseOpenCodeStream(events);
        const traj = parsed.getTrajectoryData();
        expect(traj.toolCalls).toEqual(['bash', 'edit']);
        expect(traj.commands).toEqual(['ls -la']);
        expect(traj.files.modified).toContain('/tmp/x.ts');
    });

    it('detects write tool as file creation', () => {
        const events: AgentEvent[] = [
            { type: 'step_start', part: { id: 'p1', type: 'step-start' } },
            { type: 'tool_use', part: { id: 'p2', type: 'tool', tool: 'write', state: { status: 'completed', input: { file_path: '/tmp/new.ts' } } } },
            { type: 'step_finish', part: { id: 'p3', type: 'step-finish', reason: 'end_turn', tokens: { input: 100, output: 10, reasoning: 0 } } },
        ];

        const parsed = parseOpenCodeStream(events);
        expect(parsed.getTrajectoryData().files.created).toContain('/tmp/new.ts');
    });

    it('detects MCP tools by name containing colon or mcp', () => {
        const events: AgentEvent[] = [
            { type: 'step_start', part: { id: 'p1', type: 'step-start' } },
            { type: 'tool_use', part: { id: 'p2', type: 'tool', tool: 'github:search' } },
            { type: 'step_finish', part: { id: 'p3', type: 'step-finish', reason: 'end_turn', tokens: { input: 100, output: 10, reasoning: 0 } } },
        ];

        const parsed = parseOpenCodeStream(events);
        expect(parsed.getTrajectoryData().mcpTools).toContain('github:search');
    });

    it('aggregates multi-step tokens and cost', () => {
        const events: AgentEvent[] = [
            { type: 'step_start', part: { id: 'p1', type: 'step-start' } },
            { type: 'step_finish', part: { id: 'p2', type: 'step-finish', reason: 'tool_use', cost: 0.003, tokens: { input: 500, output: 30, reasoning: 0 } } },
            { type: 'step_start', part: { id: 'p3', type: 'step-start' } },
            { type: 'step_finish', part: { id: 'p4', type: 'step-finish', reason: 'end_turn', cost: 0.005, tokens: { input: 800, output: 50, reasoning: 0 } } },
        ];

        const parsed = parseOpenCodeStream(events);
        const metrics = parsed.getMetrics();
        expect(metrics.numTurns).toBe(2);
        expect(metrics.inputTokens).toBe(1300);
        expect(metrics.outputTokens).toBe(80);
        expect(metrics.totalCostUsd).toBeCloseTo(0.008);
    });
});

describe('extractFileOpsFromCommand', () => {
    it('detects redirect to file (create)', () => {
        const result = extractFileOpsFromCommand('echo "test" > output.txt');
        expect(result.created).toContain('output.txt');
    });

    it('detects append redirect as modify', () => {
        const result = extractFileOpsFromCommand('echo "more" >> log.txt');
        expect(result.modified).toContain('log.txt');
    });

    it('ignores redirects to /dev/null', () => {
        const result = extractFileOpsFromCommand('command 2>/dev/null');
        expect(result.created).toHaveLength(0);
    });

    it('ignores fd redirects (>&)', () => {
        const result = extractFileOpsFromCommand('echo error >&2');
        expect(result.created.filter((f) => f !== '2')).toEqual(result.created.filter((f) => !f.startsWith('&')));
    });

    it('detects tee output', () => {
        const result = extractFileOpsFromCommand('echo test | tee output.log');
        expect(result.created).toContain('output.log');
    });

    it('detects tee -a output', () => {
        const result = extractFileOpsFromCommand('echo test | tee -a output.log');
        expect(result.created).toContain('output.log');
    });

    it('detects cp destination', () => {
        const result = extractFileOpsFromCommand('cp source.txt dest.txt');
        expect(result.created).toContain('dest.txt');
    });

    it('detects mv destination', () => {
        const result = extractFileOpsFromCommand('mv old.txt new.txt');
        expect(result.created).toContain('new.txt');
    });

    it('ignores cp/mv flags as destination', () => {
        const result = extractFileOpsFromCommand('cp -r src/ -verbose');
        expect(result.created.filter((f) => f.startsWith('-'))).toHaveLength(0);
    });

    it('handles empty command', () => {
        const result = extractFileOpsFromCommand('');
        expect(result.created).toEqual([]);
        expect(result.modified).toEqual([]);
    });

    it('handles command without file ops', () => {
        const result = extractFileOpsFromCommand('ls -la');
        expect(result.created).toEqual([]);
        expect(result.modified).toEqual([]);
    });
});
