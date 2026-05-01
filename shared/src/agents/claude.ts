import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { ClaudeStreamEvent, RunMetrics } from '../types.js';

export interface ClaudeRunOptions {
    prompt: string;
    systemPrompt?: string;
    model?: string;
    maxTurns?: number;
    maxBudgetUsd?: number;
    mcpConfigPath?: string;
    strictMcpConfig?: boolean;
    env?: Record<string, string>;
    allowedTools?: string[];
    onEvent?: (event: ClaudeStreamEvent) => void;
    abortSignal?: AbortSignal;
}

export interface ClaudeRunResult {
    text: string;
    metrics: RunMetrics;
    events: ClaudeStreamEvent[];
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    aborted: boolean;
    error: string | null;
}

export function runClaude(options: ClaudeRunOptions): Promise<ClaudeRunResult> {
    return new Promise((resolve) => {
        const args = [
            '-p', options.prompt,
            '--output-format', 'stream-json',
            '--verbose',
            '--dangerously-skip-permissions',
            '--no-session-persistence',
        ];

        if (options.systemPrompt) {
            args.push('--system-prompt', options.systemPrompt);
        }
        if (options.model) {
            args.push('--model', options.model);
        }
        if (options.maxTurns) {
            args.push('--max-turns', String(options.maxTurns));
        }
        if (options.maxBudgetUsd) {
            args.push('--max-budget-usd', String(options.maxBudgetUsd));
        }
        if (options.mcpConfigPath) {
            args.push('--mcp-config', options.mcpConfigPath);
            if (options.strictMcpConfig) {
                args.push('--strict-mcp-config');
            }
        }
        if (options.allowedTools?.length) {
            args.push('--allowedTools', options.allowedTools.join(','));
        }

        const childEnv = options.env ? { ...process.env, ...options.env } : process.env;

        const child: ChildProcess = spawn('claude', args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: childEnv,
        });

        const rl = createInterface({ input: child.stdout! });

        const events: ClaudeStreamEvent[] = [];
        let assistantText = '';
        let resultEvent: ClaudeStreamEvent | null = null;
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

        rl.on('line', (line) => {
            if (!line.trim()) return;

            try {
                const event: ClaudeStreamEvent = JSON.parse(line);
                events.push(event);
                options.onEvent?.(event);

                if (event.type === 'assistant' && event.message?.content) {
                    for (const block of event.message.content) {
                        if (block.type === 'text' && block.text) {
                            assistantText += block.text;
                        }
                    }
                }

                if (event.type === 'result') {
                    resultEvent = event;
                }
            } catch {
                // non-JSON line, skip
            }
        });

        child.on('close', (code, signal) => {
            const metrics: RunMetrics = {
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

            resolve({
                text: assistantText,
                metrics,
                events,
                exitCode: code,
                signal,
                aborted,
                error: resultEvent?.is_error ? (resultEvent.stop_reason ?? 'unknown error') : null,
            });
        });
    });
}

export interface ClaudeJudgeOptions {
    agentOutput: string;
    checkpoint: string;
    model?: string;
    maxRetries?: number;
    env?: Record<string, string>;
}

export interface JudgeLlmResult {
    verdict: string;
    evidence: string;
    confidence: number;
}

const VERDICT_SCHEMA = JSON.stringify({
    type: 'object',
    properties: {
        verdict: {
            type: 'string',
            enum: ['pass', 'fail', 'unclear'],
            description: 'pass = checkpoint fully satisfied, fail = clearly not satisfied, unclear = cannot determine',
        },
        evidence: {
            type: 'string',
            description: 'Specific evidence from the agent output that supports your verdict. Quote relevant parts.',
        },
        confidence: {
            type: 'number',
            description: 'Confidence in your verdict (0.0 to 1.0)',
        },
    },
    required: ['verdict', 'evidence', 'confidence'],
});

function judgeLlmOnce(options: ClaudeJudgeOptions): Promise<{ result: JudgeLlmResult | null; error: string | null }> {
    return new Promise((resolve) => {
        const prompt = `You are an evaluation judge. Determine whether the agent's output satisfies the checkpoint criteria.

## Agent Output
${options.agentOutput}

## Checkpoint Criteria
${options.checkpoint}

Evaluate carefully and return your verdict.`;

        const child = spawn('claude', [
            '-p', prompt,
            '--output-format', 'json',
            '--json-schema', VERDICT_SCHEMA,
            '--model', options.model ?? 'claude-haiku-4-5-20251001',
            '--max-turns', '3',
            '--no-session-persistence',
        ], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: options.env ? { ...process.env, ...options.env } : process.env,
        });

        let stdout = '';
        let stderr = '';
        child.stdout!.on('data', (data: Buffer) => { stdout += data.toString(); });
        child.stderr!.on('data', (data: Buffer) => { stderr += data.toString(); });

        child.on('close', (code) => {
            try {
                const parsed = JSON.parse(stdout);
                if (parsed.structured_output) {
                    resolve({ result: parsed.structured_output, error: null });
                } else {
                    resolve({ result: null, error: `No structured_output (code=${code}, errors=${parsed.errors?.join(', ') ?? 'none'})` });
                }
            } catch {
                resolve({ result: null, error: `JSON parse failed (code=${code}, stderr=${stderr.slice(0, 200)})` });
            }
        });

        child.on('error', (err) => {
            resolve({ result: null, error: `spawn error: ${err.message}` });
        });
    });
}

export async function judgeLlm(options: ClaudeJudgeOptions): Promise<JudgeLlmResult | null> {
    const maxRetries = options.maxRetries ?? 2;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const { result, error } = await judgeLlmOnce(options);
        if (result) return result;

        if (attempt < maxRetries) {
            const delay = 1000 * (attempt + 1);
            await new Promise((r) => setTimeout(r, delay));
        }
    }

    return null;
}
