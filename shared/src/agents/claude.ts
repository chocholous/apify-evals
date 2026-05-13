import { spawn } from 'node:child_process';

import { JUDGE_MODEL } from '../constants.js';

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
            '--model', options.model ?? JUDGE_MODEL,
            '--max-turns', '15',
            '--dangerously-skip-permissions',
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
