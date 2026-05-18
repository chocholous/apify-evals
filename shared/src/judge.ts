import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

import _Ajv, { type ErrorObject } from 'ajv';
const Ajv = _Ajv as unknown as typeof _Ajv.default;

import type { CheckVerdict, CheckType, VerdictValue } from './types.js';
import { SCRIPT_TIMEOUT_MS, JQ_TIMEOUT_MS, MAX_WORKSPACE_FILES, JUDGE_MODEL_MAP } from './constants.js';
import { judgeLlm } from './agents/claude.js';
import type { JudgeLlmResult } from './agents/claude.js';

export interface CheckpointSpec {
    type: CheckType;
    value: string;
    severity: 'fail' | 'warning';
}

export interface JudgeSpec {
    prompt: string;
    severity: 'fail' | 'warning';
    model?: string;
}

export interface ParsedCheckpoint {
    checks: CheckpointSpec[];
    judges: JudgeSpec[];
}

export function parseCheckpointSection(checkpoint: string): ParsedCheckpoint {
    const hasSubsections = /^###\s+(?:warn-)?(?:Checks?|Scripts?|Judge)/im.test(checkpoint);

    if (hasSubsections) {
        return parseSubsections(checkpoint);
    }

    return parseFlatCheckpoint(checkpoint);
}

function resolveJudgeModel(alias?: string): string | undefined {
    if (!alias) return undefined;
    const lower = alias.toLowerCase().trim();
    return JUDGE_MODEL_MAP[lower] ?? alias;
}

// Recognized top-level checkpoint section headers. Only these break section boundaries;
// any other `### X` inside a section body (e.g. markdown sub-headers in a Judge prompt)
// is treated as content, not as a new section.
const SECTION_HEADER_REGEX = /^###\s+(Checks?|Scripts?|(?:warn-)?Judge(?:\s*\([^)]*\))?)\s*$/gim;

function parseSubsections(checkpoint: string): ParsedCheckpoint {
    const checks: CheckpointSpec[] = [];
    const judges: JudgeSpec[] = [];

    const headers: Array<{ label: string; bodyStart: number; headerStart: number }> = [];
    let m: RegExpExecArray | null;
    SECTION_HEADER_REGEX.lastIndex = 0;
    while ((m = SECTION_HEADER_REGEX.exec(checkpoint)) !== null) {
        headers.push({ label: m[1].trim(), bodyStart: m.index + m[0].length, headerStart: m.index });
    }

    for (let h = 0; h < headers.length; h++) {
        const end = h + 1 < headers.length ? headers[h + 1].headerStart : checkpoint.length;
        const body = checkpoint.slice(headers[h].bodyStart, end).trim();
        if (!body) continue;

        const label = headers[h].label;

        if (/^Checks?$/i.test(label)) {
            const lines = body.split('\n').filter((l) => l.trim());
            for (const line of lines) {
                const spec = parseCheckpointLine(line.trim());
                if (spec) checks.push(spec);
            }
        } else if (/^Scripts?$/i.test(label)) {
            checks.push({ type: 'script', value: body, severity: 'fail' });
        } else {
            const judgeMatch = label.match(/^(?:(warn)-)?Judge(?:\s*\(([^)]*)\))?$/i);
            if (!judgeMatch) continue;
            const severity = judgeMatch[1] ? 'warning' as const : 'fail' as const;
            const model = resolveJudgeModel(judgeMatch[2]);
            judges.push({ prompt: body, severity, model });
        }
    }

    return { checks, judges };
}

function parseFlatCheckpoint(checkpoint: string): ParsedCheckpoint {
    const checks: CheckpointSpec[] = [];
    const lines = checkpoint.split('\n');
    let i = 0;

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

    const judgeText = lines.slice(i).join('\n').trim() || null;
    const judges: JudgeSpec[] = judgeText ? [{ prompt: judgeText, severity: 'fail' }] : [];
    return { checks, judges };
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
    if (stripped.startsWith('jq:')) {
        return { type: 'jq', value: stripped.slice('jq:'.length).trim(), severity };
    }
    return null;
}

export interface ScriptJudgeOptions {
    workDir?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    events?: unknown[];
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
        const evidence = stdout.toString().trim() || 'Script exited with code 0';
        return { checkType: 'script', checkValue: script, verdict: 'pass', evidence };
    } catch (err: unknown) {
        const error = err as { status?: number; stdout?: Buffer; stderr?: Buffer; message?: string };
        if (error.status !== undefined && error.status !== null) {
            const stdout = error.stdout?.toString().trim() ?? '';
            const stderr = error.stderr?.toString().trim() ?? '';
            const evidence = stdout || stderr || `Script exited with code ${error.status}`;
            return { checkType: 'script', checkValue: script, verdict: failVerdict, evidence };
        }
        const msg = error.message ?? String(err);
        if (msg.includes('ETIMEDOUT') || msg.includes('timed out')) {
            return { checkType: 'script', checkValue: script, verdict: failVerdict, evidence: `Script timed out after ${timeoutMs}ms` };
        }
        return { checkType: 'script', checkValue: script, verdict: failVerdict, evidence: `Script error: ${msg}` };
    }
}

function judgeJq(expression: string, events: unknown[], options?: ScriptJudgeOptions, failVerdict: VerdictValue = 'fail'): CheckVerdict {
    const timeoutMs = options?.timeoutMs ?? JQ_TIMEOUT_MS;
    const input = JSON.stringify(events);
    const tmpFile = join(tmpdir(), `jq-check-${Date.now()}-${Math.random().toString(36).slice(2)}.jq`);
    writeFileSync(tmpFile, expression);
    try {
        const stdout = execSync(`jq -e -f ${tmpFile}`, {
            input,
            cwd: options?.workDir ?? process.cwd(),
            timeout: timeoutMs,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: '/bin/bash',
            env: options?.env ? { ...process.env, ...options.env } : process.env,
        });
        const evidence = stdout.toString().trim() || 'jq expression returned truthy';
        return { checkType: 'jq', checkValue: expression, verdict: 'pass', evidence };
    } catch (err: unknown) {
        const error = err as { status?: number; stdout?: Buffer; stderr?: Buffer; message?: string };
        if (error.status !== undefined && error.status !== null) {
            const stdout = error.stdout?.toString().trim() ?? '';
            const stderr = error.stderr?.toString().trim() ?? '';
            const evidence = stderr || stdout || `jq exited with code ${error.status}`;
            return { checkType: 'jq', checkValue: expression, verdict: failVerdict, evidence };
        }
        const msg = error.message ?? String(err);
        if (msg.includes('ETIMEDOUT') || msg.includes('timed out')) {
            return { checkType: 'jq', checkValue: expression, verdict: failVerdict, evidence: `jq timed out after ${timeoutMs}ms` };
        }
        return { checkType: 'jq', checkValue: expression, verdict: failVerdict, evidence: `jq error: ${msg}` };
    } finally {
        try { unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
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
        return { checkType: 'json-schema', checkValue: schemaStr, verdict: 'fail', evidence: 'Output is not valid JSON (even after extracting from code blocks)' };
    }

    let schema: Record<string, unknown>;
    try {
        schema = JSON.parse(schemaStr);
    } catch {
        return { checkType: 'json-schema', checkValue: schemaStr, verdict: 'fail', evidence: `Invalid JSON schema definition: ${schemaStr}` };
    }

    if (Object.keys(schema).length === 0) {
        return { checkType: 'json-schema', checkValue: schemaStr, verdict: 'pass', evidence: 'Output is valid JSON (empty schema = any JSON accepted)' };
    }

    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(schema);
    const valid = validate(data);

    if (valid) {
        return { checkType: 'json-schema', checkValue: schemaStr, verdict: 'pass', evidence: 'Output validates against JSON schema' };
    }

    const errors = validate.errors?.map((e: ErrorObject) => `${e.instancePath || '/'} ${e.message}`).join('; ') ?? 'unknown';
    return { checkType: 'json-schema', checkValue: schemaStr, verdict: 'fail', evidence: `JSON schema validation failed: ${errors}` };
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
                    };
            } catch {
                return {
                    checkType: 'regex',
                    checkValue: spec.value,
                    verdict: failVerdict,
                    evidence: `Invalid regex: ${spec.value}`,
                    };
            }
        }
        case 'json-schema':
            return judgeJsonSchema(agentOutput, spec.value);
        case 'script':
            return judgeScript(agentOutput, spec.value, options, failVerdict);
        case 'jq':
            return judgeJq(spec.value, options?.events ?? [], options, failVerdict);
        default:
            return { checkType: spec.type, checkValue: spec.value, verdict: failVerdict, evidence: `Unknown check type: ${spec.type}` };
    }
}

export interface JudgeOptions {
    env?: Record<string, string>;
    judgeModel?: string;
    workDir?: string;
    scriptTimeoutMs?: number;
    events?: Array<{ type: string; message?: { content: Array<{ type: string; text?: string; name?: string; input?: unknown }> } }>;
    onJudgeRawLine?: (line: string) => void;
}

const DEFAULT_MAX_FILES = MAX_WORKSPACE_FILES;

const MAX_TOTAL_WORKSPACE_CHARS = 200_000;

function collectWorkspaceFiles(dir: string, maxFiles: number): string {
    const files: Array<{ path: string; content: string }> = [];
    let totalChars = 0;

    function walk(currentDir: string): void {
        if (files.length >= maxFiles || totalChars >= MAX_TOTAL_WORKSPACE_CHARS) return;
        try {
            const entries = readdirSync(currentDir, { withFileTypes: true });
            for (const entry of entries) {
                if (files.length >= maxFiles || totalChars >= MAX_TOTAL_WORKSPACE_CHARS) return;
                const fullPath = join(currentDir, entry.name);

                if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'storage') continue;

                if (entry.isDirectory()) {
                    walk(fullPath);
                } else if (entry.isFile()) {
                    try {
                        const content = readFileSync(fullPath, 'utf-8');
                        files.push({ path: relative(dir, fullPath), content });
                        totalChars += content.length;
                    } catch { /* skip unreadable files */ }
                }
            }
        } catch { /* skip unreadable dirs */ }
    }

    walk(dir);

    if (files.length === 0) return '';

    let result = '\n\n## Files in Workspace\n\n' + files.map((f) =>
        `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``,
    ).join('\n\n');

    if (totalChars >= MAX_TOTAL_WORKSPACE_CHARS) {
        result += `\n\n_Note: workspace collection stopped at ${MAX_TOTAL_WORKSPACE_CHARS} chars total (${files.length} files). Some files may not be shown._`;
    }

    return result;
}

function formatConversationLog(events: JudgeOptions['events']): string {
    if (!events || events.length === 0) return '';

    const lines: string[] = [];

    for (const event of events) {
        if (event.type !== 'assistant' || !event.message?.content) continue;
        for (const block of event.message.content) {
            if (block.type === 'tool_use' && block.name) {
                const inputStr = block.input ? JSON.stringify(block.input) : '';
                lines.push(`→ ${block.name}(${inputStr})`);
            } else if (block.type === 'text' && block.text) {
                lines.push(`  "${block.text.replace(/\n/g, ' ')}"`);
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

function detectPlatformFailures(events?: JudgeOptions['events']): CheckVerdict | null {
    if (!events) return null;
    const memoryPattern = /exceed the memory limit|memory limit.*exceeded|cannot allocate memory/i;
    for (const event of events) {
        const result = (event as Record<string, unknown>).tool_use_result as Record<string, unknown> | undefined;
        if (result?.stdout && memoryPattern.test(result.stdout as string)) {
            return {
                checkType: 'error',
                checkValue: 'platform_failure:memory',
                verdict: 'platform_failure',
                evidence: result.stdout as string,
            };
        }
    }
    return null;
}

export async function judgeAllChecks(
    agentOutput: string,
    checkpoint: string,
    options?: JudgeOptions,
): Promise<JudgeResult> {
    const parsed = parseCheckpointSection(checkpoint);
    const verdicts: CheckVerdict[] = [];

    const platformFailure = detectPlatformFailures(options?.events);
    if (platformFailure) {
        verdicts.push(platformFailure);
    }

    const scriptOptions: ScriptJudgeOptions = {
        workDir: options?.workDir,
        timeoutMs: options?.scriptTimeoutMs,
        env: options?.env,
        events: options?.events,
    };

    for (const spec of parsed.checks) {
        const result = judgeDeterministicCheck(agentOutput, spec, scriptOptions);
        verdicts.push(result);
    }

    if (options?.workDir) {
        try {
            writeFileSync(join(options.workDir, 'eval-checkpoint.json'), JSON.stringify(
                parsed.checks.map(c => ({ type: c.type, value: c.value, severity: c.severity })),
                null, 2,
            ));
            writeFileSync(join(options.workDir, 'eval-check-results.json'), JSON.stringify(
                verdicts.map(v => ({ checkType: v.checkType, verdict: v.verdict, evidence: v.evidence, checkValue: v.checkValue })),
                null, 2,
            ));
        } catch { /* ignore write errors */ }
    }

    for (const judge of parsed.judges) {
        let enrichedOutput = agentOutput;
        if (options?.workDir) {
            enrichedOutput += collectWorkspaceFiles(options.workDir, DEFAULT_MAX_FILES);
        }
        if (options?.events) {
            enrichedOutput += formatConversationLog(options.events);
        }

        const llmResult = await judgeLlm({
            agentOutput: enrichedOutput,
            checkpoint: judge.prompt,
            model: judge.model ?? options?.judgeModel,
            env: options?.env,
            onRawLine: options?.onJudgeRawLine,
        });

        const failVerdict = judge.severity === 'warning' ? 'warning' as const : 'fail' as const;

        if (llmResult) {
            const verdict = llmResult.verdict === 'fail' ? failVerdict : llmResult.verdict as VerdictValue;
            verdicts.push({
                checkType: 'llm-judge',
                checkValue: judge.prompt,
                verdict,
                evidence: llmResult.reasoning,
                evalCritique: llmResult.eval_critique || undefined,
            });
        } else {
            verdicts.push({
                checkType: 'llm-judge',
                checkValue: judge.prompt,
                verdict: 'unclear',
                evidence: 'LLM judge returned no result after retries',
            });
        }
    }

    const overallVerdict = computeOverall(verdicts);
    return { verdicts, overallVerdict };
}

function computeOverall(verdicts: CheckVerdict[]): VerdictValue {
    if (verdicts.length === 0) return 'unclear';
    if (verdicts.some((v) => v.verdict === 'platform_failure')) return 'platform_failure';
    if (verdicts.some((v) => v.verdict === 'fail')) return 'fail';
    if (verdicts.some((v) => v.verdict === 'warning')) return 'warning';
    if (verdicts.some((v) => v.verdict === 'unclear')) return 'unclear';
    return 'pass';
}
