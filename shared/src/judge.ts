import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import _Ajv, { type ErrorObject } from 'ajv';
const Ajv = _Ajv as unknown as typeof _Ajv.default;

import type { CheckVerdict, CheckType, VerdictValue } from './types.js';
import { SCRIPT_TIMEOUT_MS, EVIDENCE_MAX_CHARS, MAX_WORKSPACE_FILES, MAX_WORKSPACE_FILE_SIZE, TOOL_INPUT_MAX_CHARS } from './constants.js';
import { judgeLlm as judgeLlmCli } from './agents/claude.js';
import { judgeLlmSdk, hasSdkCredentials } from './agents/judge-sdk.js';
import type { JudgeLlmResult } from './agents/claude.js';

export type JudgeMode = 'auto' | 'cli' | 'sdk';

type JudgeFn = (options: { agentOutput: string; checkpoint: string; model?: string; maxRetries?: number; env?: Record<string, string> }) => Promise<JudgeLlmResult | null>;

function resolveJudgeFn(mode: JudgeMode | undefined, env?: Record<string, string>): JudgeFn {
    const effectiveMode = mode ?? 'auto';
    if (effectiveMode === 'sdk') return judgeLlmSdk;
    if (effectiveMode === 'cli') return judgeLlmCli;
    return hasSdkCredentials(env) ? judgeLlmSdk : judgeLlmCli;
}

export interface CheckpointSpec {
    type: CheckType;
    value: string;
    severity: 'fail' | 'warning';
}

export interface ParsedCheckpoint {
    checks: CheckpointSpec[];
    judgePrompt: string | null;
}

export function parseCheckpointSection(checkpoint: string): ParsedCheckpoint {
    const hasSubsections = /^###\s+(Checks?|Scripts?|Judge)/im.test(checkpoint);

    if (hasSubsections) {
        return parseSubsections(checkpoint);
    }

    return parseFlatCheckpoint(checkpoint);
}

function parseSubsections(checkpoint: string): ParsedCheckpoint {
    const checks: CheckpointSpec[] = [];
    let judgePrompt: string | null = null;

    const checksMatch = checkpoint.match(/###\s+Checks?\s*\n([\s\S]*?)(?=###|$)/i);
    if (checksMatch) {
        const lines = checksMatch[1].trim().split('\n').filter((l) => l.trim());
        for (const line of lines) {
            const spec = parseCheckpointLine(line.trim());
            if (spec) checks.push(spec);
        }
    }

    const scriptMatch = checkpoint.match(/###\s+Scripts?\s*\n([\s\S]*?)(?=###|$)/i);
    if (scriptMatch) {
        const scriptValue = scriptMatch[1].trim();
        if (scriptValue) {
            checks.push({ type: 'script', value: scriptValue, severity: 'fail' });
        }
    }

    const judgeMatch = checkpoint.match(/###\s+Judge\s*\n([\s\S]*?)(?=###|$)/i);
    if (judgeMatch) {
        const text = judgeMatch[1].trim();
        if (text) judgePrompt = text;
    }

    return { checks, judgePrompt };
}

function parseFlatCheckpoint(checkpoint: string): ParsedCheckpoint {
    const checks: CheckpointSpec[] = [];
    const lines = checkpoint.split('\n');
    let i = 0;

    // Deterministic checks must come first (before any plain text)
    for (; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed) continue;

        const spec = parseCheckpointLine(trimmed);
        if (spec) {
            checks.push(spec);
        } else {
            break;
        }
    }

    // Everything from first non-prefixed line onwards = LLM judge prompt
    const judgePrompt = lines.slice(i).join('\n').trim() || null;
    return { checks, judgePrompt };
}

function parseCheckpointLine(line: string): CheckpointSpec | null {
    const warn = line.startsWith('warn-');
    const severity = warn ? 'warning' as const : 'fail' as const;
    const stripped = warn ? line.slice(5) : line;

    if (stripped.startsWith('contains:')) {
        return { type: 'contains', value: stripped.slice('contains:'.length).trim(), severity };
    }
    if (stripped.startsWith('regex:')) {
        return { type: 'regex', value: stripped.slice('regex:'.length).trim(), severity };
    }
    if (stripped.startsWith('json-schema:')) {
        return { type: 'json-schema', value: stripped.slice('json-schema:'.length).trim(), severity };
    }
    if (stripped.startsWith('script:')) {
        return { type: 'script', value: stripped.slice('script:'.length).trim(), severity };
    }
    return null;
}

export interface ScriptJudgeOptions {
    workDir?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
}

function judgeScript(agentOutput: string, script: string, options?: ScriptJudgeOptions, failVerdict: VerdictValue = 'fail'): CheckVerdict {
    const timeoutMs = options?.timeoutMs ?? SCRIPT_TIMEOUT_MS;
    try {
        const stdout = execSync(script, {
            input: agentOutput,
            cwd: options?.workDir ?? process.cwd(),
            timeout: timeoutMs,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: '/bin/bash',
            env: options?.env ? { ...process.env, ...options.env } : process.env,
        });
        const evidence = stdout.toString().trim().slice(0, EVIDENCE_MAX_CHARS) || 'Script exited with code 0';
        return { checkType: 'script', checkValue: script, verdict: 'pass', evidence, confidence: 1.0 };
    } catch (err: unknown) {
        const error = err as { status?: number; stdout?: Buffer; stderr?: Buffer; message?: string };
        if (error.status !== undefined && error.status !== null) {
            const stdout = error.stdout?.toString().trim().slice(0, 500) ?? '';
            const stderr = error.stderr?.toString().trim().slice(0, 500) ?? '';
            const evidence = stdout || stderr || `Script exited with code ${error.status}`;
            return { checkType: 'script', checkValue: script, verdict: failVerdict, evidence, confidence: 1.0 };
        }
        const msg = error.message ?? String(err);
        if (msg.includes('ETIMEDOUT') || msg.includes('timed out')) {
            return { checkType: 'script', checkValue: script, verdict: failVerdict, evidence: `Script timed out after ${timeoutMs}ms`, confidence: 1.0 };
        }
        return { checkType: 'script', checkValue: script, verdict: failVerdict, evidence: `Script error: ${msg.slice(0, 500)}`, confidence: 1.0 };
    }
}

function extractJson(text: string): string {
    // Try raw text first
    try { JSON.parse(text); return text; } catch { /* continue */ }

    // Extract from ```json ... ``` or ``` ... ``` code blocks
    const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (codeBlockMatch) {
        try { JSON.parse(codeBlockMatch[1].trim()); return codeBlockMatch[1].trim(); } catch { /* continue */ }
    }

    // Try to find first { or [ and last } or ]
    const firstBrace = text.search(/[\[{]/);
    const lastBrace = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        const candidate = text.slice(firstBrace, lastBrace + 1);
        try { JSON.parse(candidate); return candidate; } catch { /* continue */ }
    }

    return text;
}

function judgeJsonSchema(agentOutput: string, schemaStr: string): CheckVerdict {
    let data: unknown;
    try {
        data = JSON.parse(extractJson(agentOutput));
    } catch {
        return { checkType: 'json-schema', checkValue: schemaStr, verdict: 'fail', evidence: 'Output is not valid JSON (even after extracting from code blocks)', confidence: 1.0 };
    }

    let schema: Record<string, unknown>;
    try {
        schema = JSON.parse(schemaStr);
    } catch {
        return { checkType: 'json-schema', checkValue: schemaStr, verdict: 'fail', evidence: `Invalid JSON schema definition: ${schemaStr.slice(0, 200)}`, confidence: 1.0 };
    }

    if (Object.keys(schema).length === 0) {
        return { checkType: 'json-schema', checkValue: schemaStr, verdict: 'pass', evidence: 'Output is valid JSON (empty schema = any JSON accepted)', confidence: 1.0 };
    }

    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(schema);
    const valid = validate(data);

    if (valid) {
        return { checkType: 'json-schema', checkValue: schemaStr, verdict: 'pass', evidence: 'Output validates against JSON schema', confidence: 1.0 };
    }

    const errors = validate.errors?.map((e: ErrorObject) => `${e.instancePath || '/'} ${e.message}`).join('; ') ?? 'unknown';
    return { checkType: 'json-schema', checkValue: schemaStr, verdict: 'fail', evidence: `JSON schema validation failed: ${errors}`, confidence: 1.0 };
}

function judgeDeterministicCheck(agentOutput: string, spec: CheckpointSpec, options?: ScriptJudgeOptions): CheckVerdict {
    const failVerdict = spec.severity === 'warning' ? 'warning' as const : 'fail' as const;

    switch (spec.type) {
        case 'contains': {
            const found = agentOutput.toLowerCase().includes(spec.value.toLowerCase());
            return {
                checkType: 'contains',
                checkValue: spec.value,
                verdict: found ? 'pass' : failVerdict,
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
                    checkType: 'regex',
                    checkValue: spec.value,
                    verdict: match ? 'pass' : failVerdict,
                    evidence: match
                        ? `Output matches regex /${spec.value}/i`
                        : `Output does not match regex /${spec.value}/i`,
                    confidence: 1.0,
                };
            } catch {
                return {
                    checkType: 'regex',
                    checkValue: spec.value,
                    verdict: failVerdict,
                    evidence: `Invalid regex: ${spec.value}`,
                    confidence: 1.0,
                };
            }
        }
        case 'json-schema':
            return judgeJsonSchema(agentOutput, spec.value);
        case 'script':
            return judgeScript(agentOutput, spec.value, options, failVerdict);
        default:
            return { checkType: spec.type, checkValue: spec.value, verdict: failVerdict, evidence: `Unknown check type: ${spec.type}`, confidence: 1.0 };
    }
}

export interface JudgeOptions {
    env?: Record<string, string>;
    judgeModel?: string;
    judgeMode?: JudgeMode;
    workDir?: string;
    scriptTimeoutMs?: number;
    events?: Array<{ type: string; message?: { content: Array<{ type: string; text?: string; name?: string; input?: unknown }> } }>;
}

const DEFAULT_MAX_FILES = MAX_WORKSPACE_FILES;
const DEFAULT_MAX_FILE_SIZE = MAX_WORKSPACE_FILE_SIZE;

function collectWorkspaceFiles(dir: string, maxFiles: number, maxFileSize: number): string {
    const files: Array<{ path: string; content: string }> = [];

    function walk(currentDir: string): void {
        if (files.length >= maxFiles) return;
        try {
            const entries = readdirSync(currentDir, { withFileTypes: true });
            for (const entry of entries) {
                if (files.length >= maxFiles) return;
                const fullPath = join(currentDir, entry.name);

                // Skip node_modules, .git, dist, storage
                if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'storage') continue;

                if (entry.isDirectory()) {
                    walk(fullPath);
                } else if (entry.isFile()) {
                    try {
                        const stat = statSync(fullPath);
                        if (stat.size > maxFileSize * 2) {
                            files.push({ path: relative(dir, fullPath), content: `[file too large: ${stat.size} bytes]` });
                        } else {
                            const content = readFileSync(fullPath, 'utf-8').slice(0, maxFileSize);
                            files.push({ path: relative(dir, fullPath), content });
                        }
                    } catch { /* skip unreadable files */ }
                }
            }
        } catch { /* skip unreadable dirs */ }
    }

    walk(dir);

    if (files.length === 0) return '';

    return '\n\n## Files in Workspace\n\n' + files.map((f) =>
        `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``,
    ).join('\n\n');
}

function formatConversationLog(events: JudgeOptions['events'], maxChars = 8000): string {
    if (!events || events.length === 0) return '';

    const lines: string[] = [];
    let totalChars = 0;

    for (const event of events) {
        if (event.type !== 'assistant' || !event.message?.content) continue;
        for (const block of event.message.content) {
            if (block.type === 'tool_use' && block.name) {
                const inputStr = block.input ? JSON.stringify(block.input).slice(0, TOOL_INPUT_MAX_CHARS) : '';
                const line = `→ ${block.name}(${inputStr})`;
                totalChars += line.length;
                if (totalChars > maxChars) return '\n\n## Agent Conversation Log (tool calls)\n\n```\n' + lines.join('\n') + '\n[truncated]\n```';
                lines.push(line);
            } else if (block.type === 'text' && block.text) {
                const preview = block.text.slice(0, 200).replace(/\n/g, ' ');
                const line = `  "${preview}"`;
                totalChars += line.length;
                if (totalChars > maxChars) return '\n\n## Agent Conversation Log (tool calls)\n\n```\n' + lines.join('\n') + '\n[truncated]\n```';
                lines.push(line);
            }
        }
    }

    if (lines.length === 0) return '';
    return '\n\n## Agent Conversation Log (tool calls)\n\n```\n' + lines.join('\n') + '\n```';
}

export interface JudgeResult {
    verdicts: CheckVerdict[];
    overallVerdict: VerdictValue;
}

export async function judgeAllChecks(
    agentOutput: string,
    checkpoint: string,
    options?: JudgeOptions,
): Promise<JudgeResult> {
    const parsed = parseCheckpointSection(checkpoint);
    const verdicts: CheckVerdict[] = [];

    const scriptOptions: ScriptJudgeOptions = {
        workDir: options?.workDir,
        timeoutMs: options?.scriptTimeoutMs,
        env: options?.env,
    };

    for (const spec of parsed.checks) {
        const result = judgeDeterministicCheck(agentOutput, spec, scriptOptions);
        verdicts.push(result);
    }

    if (parsed.judgePrompt) {
        let enrichedOutput = agentOutput;
        enrichedOutput += '\n\n## Verification context\n';
        enrichedOutput += '- .eval-trajectory.json: agent tool calls, commands executed, files created\n';
        enrichedOutput += '- You have full tool access (Read, Bash) to inspect workspace files and /tmp/ if needed\n';
        if (options?.events) {
            enrichedOutput += formatConversationLog(options.events);
        }

        const judgeFn = resolveJudgeFn(options?.judgeMode, options?.env);
        const llmResult = await judgeFn({
            agentOutput: enrichedOutput,
            checkpoint: parsed.judgePrompt,
            model: options?.judgeModel,
            env: options?.env,
        });

        if (llmResult) {
            verdicts.push({
                checkType: 'llm-judge',
                checkValue: parsed.judgePrompt,
                verdict: llmResult.verdict as VerdictValue,
                evidence: llmResult.evidence,
                confidence: llmResult.confidence,
            });
        } else {
            verdicts.push({
                checkType: 'llm-judge',
                checkValue: parsed.judgePrompt,
                verdict: 'unclear',
                evidence: 'LLM judge returned no result after retries',
                confidence: 0,
            });
        }
    }

    const overallVerdict = computeOverall(verdicts);
    return { verdicts, overallVerdict };
}

function computeOverall(verdicts: CheckVerdict[]): VerdictValue {
    if (verdicts.length === 0) return 'unclear';
    if (verdicts.some((v) => v.verdict === 'fail')) return 'fail';
    if (verdicts.some((v) => v.verdict === 'warning')) return 'warning';
    if (verdicts.some((v) => v.verdict === 'unclear')) return 'unclear';
    return 'pass';
}
