import { execSync } from 'node:child_process';

import _Ajv, { type ErrorObject } from 'ajv';
const Ajv = _Ajv as unknown as typeof _Ajv.default;

import type { Verdict, VerdictValue } from './types.js';
import { judgeLlm } from './agents/claude.js';

export interface CheckpointSpec {
    type: 'contains' | 'regex' | 'json-schema' | 'script' | 'llm-judge';
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
    if (checkpoint.startsWith('script:')) {
        return { type: 'script', value: checkpoint.slice('script:'.length).trim() };
    }
    return { type: 'llm-judge', value: checkpoint };
}

export interface ScriptJudgeOptions {
    workDir?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
}

function judgeScript(agentOutput: string, script: string, options?: ScriptJudgeOptions): Verdict {
    const timeoutMs = options?.timeoutMs ?? 30_000;
    try {
        const stdout = execSync(script, {
            input: agentOutput,
            cwd: options?.workDir ?? process.cwd(),
            timeout: timeoutMs,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: '/bin/bash',
            env: options?.env ? { ...process.env, ...options.env } : process.env,
        });
        const evidence = stdout.toString().trim().slice(0, 1000) || 'Script exited with code 0';
        return { verdict: 'pass', evidence, confidence: 1.0 };
    } catch (err: unknown) {
        const error = err as { status?: number; stdout?: Buffer; stderr?: Buffer; message?: string };
        if (error.status !== undefined && error.status !== null) {
            const stdout = error.stdout?.toString().trim().slice(0, 500) ?? '';
            const stderr = error.stderr?.toString().trim().slice(0, 500) ?? '';
            const evidence = stdout || stderr || `Script exited with code ${error.status}`;
            return { verdict: 'fail', evidence, confidence: 1.0 };
        }
        const msg = error.message ?? String(err);
        if (msg.includes('ETIMEDOUT') || msg.includes('timed out')) {
            return { verdict: 'fail', evidence: `Script timed out after ${timeoutMs}ms`, confidence: 1.0 };
        }
        return { verdict: 'fail', evidence: `Script error: ${msg.slice(0, 500)}`, confidence: 1.0 };
    }
}

function judgeJsonSchema(agentOutput: string, schemaStr: string): Verdict {
    let data: unknown;
    try {
        data = JSON.parse(agentOutput);
    } catch {
        return { verdict: 'fail', evidence: 'Output is not valid JSON', confidence: 1.0 };
    }

    let schema: Record<string, unknown>;
    try {
        schema = JSON.parse(schemaStr);
    } catch {
        return { verdict: 'fail', evidence: `Invalid JSON schema definition: ${schemaStr.slice(0, 200)}`, confidence: 1.0 };
    }

    if (Object.keys(schema).length === 0) {
        return { verdict: 'pass', evidence: 'Output is valid JSON (empty schema = any JSON accepted)', confidence: 1.0 };
    }

    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(schema);
    const valid = validate(data);

    if (valid) {
        return { verdict: 'pass', evidence: 'Output validates against JSON schema', confidence: 1.0 };
    }

    const errors = validate.errors?.map((e: ErrorObject) => `${e.instancePath || '/'} ${e.message}`).join('; ') ?? 'unknown';
    return { verdict: 'fail', evidence: `JSON schema validation failed: ${errors}`, confidence: 1.0 };
}

function judgeDeterministic(agentOutput: string, spec: CheckpointSpec, options?: ScriptJudgeOptions): Verdict | null {
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
            return judgeJsonSchema(agentOutput, spec.value);
        }
        case 'script': {
            return judgeScript(agentOutput, spec.value, options);
        }
        default:
            return null;
    }
}

export interface JudgeOptions {
    env?: Record<string, string>;
    judgeModel?: string;
    workDir?: string;
    scriptTimeoutMs?: number;
}

export async function judgeCheckpoint(
    agentOutput: string,
    checkpoint: string,
    options?: JudgeOptions,
): Promise<Verdict> {
    const spec = parseCheckpoint(checkpoint);

    if (spec.type !== 'llm-judge') {
        const scriptOptions: ScriptJudgeOptions = {
            workDir: options?.workDir,
            timeoutMs: options?.scriptTimeoutMs,
            env: options?.env,
        };
        const result = judgeDeterministic(agentOutput, spec, scriptOptions);
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
