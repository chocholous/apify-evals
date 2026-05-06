import Anthropic from '@anthropic-ai/sdk';

import { JUDGE_MODEL, JUDGE_MAX_TOKENS } from '../constants.js';
import type { JudgeLlmResult } from './claude.js';

const JUDGE_TOOL: Anthropic.Messages.Tool = {
    name: 'submit_verdict',
    description: 'Submit your evaluation verdict.',
    input_schema: {
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
    },
};

export interface SdkJudgeOptions {
    agentOutput: string;
    checkpoint: string;
    model?: string;
    maxRetries?: number;
    env?: Record<string, string>;
}

function buildPrompt(agentOutput: string, checkpoint: string): string {
    return `You are an evaluation judge. Determine whether the agent's output satisfies the checkpoint criteria.

## Agent Output
${agentOutput}

## Checkpoint Criteria
${checkpoint}

Evaluate carefully and submit your verdict using the submit_verdict tool.`;
}

function getApiKey(env?: Record<string, string>): string | undefined {
    return env?.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
}

async function judgeLlmSdkOnce(client: Anthropic, options: SdkJudgeOptions): Promise<{ result: JudgeLlmResult | null; error: string | null }> {
    try {
        const response = await client.messages.create({
            model: options.model ?? JUDGE_MODEL,
            max_tokens: JUDGE_MAX_TOKENS,
            tools: [JUDGE_TOOL],
            tool_choice: { type: 'tool', name: 'submit_verdict' },
            messages: [{ role: 'user', content: buildPrompt(options.agentOutput, options.checkpoint) }],
        });

        const toolUse = response.content.find((block) => block.type === 'tool_use');
        if (!toolUse || toolUse.type !== 'tool_use') {
            return { result: null, error: `No tool_use in response. Stop reason: ${response.stop_reason}` };
        }

        const input = toolUse.input as Record<string, unknown>;
        return {
            result: {
                verdict: input.verdict as string,
                evidence: input.evidence as string,
                confidence: input.confidence as number,
            },
            error: null,
        };
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: null, error: `SDK error: ${msg}` };
    }
}

export async function judgeLlmSdk(options: SdkJudgeOptions): Promise<JudgeLlmResult | null> {
    const apiKey = getApiKey(options.env);
    if (!apiKey) {
        return null;
    }

    const client = new Anthropic({ apiKey });
    const maxRetries = options.maxRetries ?? 2;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const { result, error } = await judgeLlmSdkOnce(client, options);
        if (result) return result;

        if (attempt < maxRetries) {
            const delay = 1000 * (attempt + 1);
            await new Promise((r) => setTimeout(r, delay));
        }
    }

    return null;
}

export function hasSdkApiKey(env?: Record<string, string>): boolean {
    return !!getApiKey(env);
}
