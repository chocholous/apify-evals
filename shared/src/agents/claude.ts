import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import { JUDGE_MODEL } from '../constants.js';

export interface ClaudeJudgeOptions {
    agentOutput: string;
    checkpoint: string;
    model?: string;
    maxRetries?: number;
    env?: Record<string, string>;
    onRawLine?: (line: string) => void;
}

export interface JudgeLlmResult {
    verdict: string;
    reasoning: string;
    eval_critique?: string;
}

const VERDICT_SCHEMA = JSON.stringify({
    type: 'object',
    properties: {
        verdict: {
            type: 'string',
            enum: ['pass', 'fail', 'unclear'],
            description: 'pass = checkpoint fully satisfied, fail = clearly not satisfied, unclear = cannot determine',
        },
        reasoning: {
            type: 'string',
            description: 'Your reasoning for the verdict. Reference specific evidence from the agent output.',
        },
        eval_critique: {
            type: 'string',
            description: 'Optional critique of the evaluation criteria themselves. Flag assertions that would pass even for bad output, important outcomes not tested, or assertions that cannot be verified from available data. Omit or leave empty if the eval criteria are solid.',
        },
    },
    required: ['verdict', 'reasoning'],
});

function judgeLlmOnce(options: ClaudeJudgeOptions): Promise<{ result: JudgeLlmResult | null; error: string | null }> {
    const JUDGE_TIMEOUT_MS = 5 * 60 * 1000;

    return new Promise((resolve) => {
        const prompt = `You are an evaluation judge. You have a soft budget of 5 minutes for this evaluation.
Determine whether the agent's output satisfies the checkpoint criteria.

## Agent Output
${options.agentOutput}

## Checkpoint Criteria
${options.checkpoint}

Evaluate carefully. Return your verdict (pass/fail/unclear) with reasoning that references specific evidence from the output.`;

        const child = spawn('claude', [
            '-p', prompt,
            '--output-format', 'stream-json',
            '--verbose',
            '--include-partial-messages',
            '--json-schema', VERDICT_SCHEMA,
            '--model', options.model ?? JUDGE_MODEL,
            '--dangerously-skip-permissions',
            '--no-session-persistence',
        ], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: options.env ? { ...process.env, ...options.env } : process.env,
        });

        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 3000);
            resolve({ result: null, error: `Judge timed out after ${JUDGE_TIMEOUT_MS / 1000}s` });
        }, JUDGE_TIMEOUT_MS);

        let resultEvent: Record<string, unknown> | null = null;
        let stderr = '';

        const rl = createInterface({ input: child.stdout! });
        rl.on('line', (line) => {
            if (!line.trim()) return;
            options.onRawLine?.(line);
            try {
                const event = JSON.parse(line) as Record<string, unknown>;
                if (event.type === 'result') {
                    resultEvent = event;
                }
            } catch { /* skip non-JSON */ }
        });

        child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

        child.on('close', (code) => {
            clearTimeout(timer);
            if (resultEvent?.structured_output) {
                resolve({ result: resultEvent.structured_output as JudgeLlmResult, error: null });
            } else {
                const errors = resultEvent
                    ? `is_error=${resultEvent.is_error}, stop=${resultEvent.stop_reason}`
                    : 'no result event';
                resolve({ result: null, error: `No structured_output (code=${code}, ${errors}, stderr=${stderr.slice(0, 200)})` });
            }
        });

        child.on('error', (err) => {
            clearTimeout(timer);
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
