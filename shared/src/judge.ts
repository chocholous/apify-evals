import type { Verdict, VerdictValue } from './types.js';
import { judgeLlm } from './agents/claude.js';

export interface CheckpointSpec {
    type: 'contains' | 'regex' | 'json-schema' | 'llm-judge';
    value: string;
}

export function parseCheckpoint(checkpoint: string): CheckpointSpec {
    if (checkpoint.startsWith('contains:')) {
        return { type: 'contains', value: checkpoint.slice('contains:'.length).trim() };
    }
    if (checkpoint.startsWith('regex:')) {
        return { type: 'regex', value: checkpoint.slice('regex:'.length).trim() };
    }
    if (checkpoint.startsWith('json-schema:')) {
        return { type: 'json-schema', value: checkpoint.slice('json-schema:'.length).trim() };
    }
    return { type: 'llm-judge', value: checkpoint };
}

function judgeDeterministic(agentOutput: string, spec: CheckpointSpec): Verdict | null {
    switch (spec.type) {
        case 'contains': {
            const found = agentOutput.toLowerCase().includes(spec.value.toLowerCase());
            return {
                verdict: found ? 'pass' : 'fail',
                evidence: found
                    ? `Output contains "${spec.value}"`
                    : `Output does not contain "${spec.value}"`,
                confidence: 1.0,
            };
        }
        case 'regex': {
            try {
                const re = new RegExp(spec.value, 'i');
                const match = re.test(agentOutput);
                return {
                    verdict: match ? 'pass' : 'fail',
                    evidence: match
                        ? `Output matches regex /${spec.value}/i`
                        : `Output does not match regex /${spec.value}/i`,
                    confidence: 1.0,
                };
            } catch {
                return {
                    verdict: 'fail',
                    evidence: `Invalid regex: ${spec.value}`,
                    confidence: 1.0,
                };
            }
        }
        case 'json-schema': {
            try {
                JSON.parse(agentOutput);
                return {
                    verdict: 'pass',
                    evidence: 'Output is valid JSON',
                    confidence: 0.8,
                };
            } catch {
                return {
                    verdict: 'fail',
                    evidence: 'Output is not valid JSON',
                    confidence: 1.0,
                };
            }
        }
        default:
            return null;
    }
}

export interface JudgeOptions {
    env?: Record<string, string>;
    judgeModel?: string;
}

export async function judgeCheckpoint(
    agentOutput: string,
    checkpoint: string,
    options?: JudgeOptions,
): Promise<Verdict> {
    const spec = parseCheckpoint(checkpoint);

    if (spec.type !== 'llm-judge') {
        const result = judgeDeterministic(agentOutput, spec);
        if (result) return result;
    }

    const llmResult = await judgeLlm({
        agentOutput,
        checkpoint: spec.value,
        model: options?.judgeModel,
        env: options?.env,
    });

    if (llmResult) {
        return {
            verdict: llmResult.verdict as VerdictValue,
            evidence: llmResult.evidence,
            confidence: llmResult.confidence,
        };
    }

    return {
        verdict: 'unclear',
        evidence: 'LLM judge returned no result',
        confidence: 0,
    };
}
