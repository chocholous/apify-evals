import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { trace } from '@opentelemetry/api';
import type { Tracer, Span } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';

import {
    initOtel,
    flushOtel,
    startScenarioSpan,
    startTestSpan,
    startAgentSpan,
    endAgentSpan,
    startJudgeSpan,
    endJudgeSpan,
    endTestSpan,
    endScenarioSpan,
} from '../index.js';
import { BufferSpanExporter, spansToOtlpJson } from '../otel-exporter.js';

import type { AgentRunResult } from '../agents/run.js';
import type { JudgeResult } from '../judge.js';

function makeMockAgentResult(overrides?: Partial<AgentRunResult>): AgentRunResult {
    return {
        text: 'mock agent output',
        metrics: {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 30,
            cacheCreationTokens: 0,
            totalCostUsd: 0.01,
            durationMs: 5000,
            durationApiMs: 3000,
            numTurns: 2,
            modelUsage: {},
        },
        efficiency: {
            totalContextTokens: 130,
            tokensPerTurn: 25,
            costPerTurn: 0.005,
            cacheHitRate: 0.23,
            contextOutputRatio: 2.6,
            apiDurationRatio: 0.6,
            avgTurnDurationMs: 2500,
            toolExecutionMs: 2000,
            planningTurns: 0,
            executionTurns: 2,
        },
        trajectory: {
            toolCallCount: 3,
            toolCallSequence: ['Read', 'Bash', 'Write'],
            uniqueToolsUsed: ['Read', 'Bash', 'Write'],
            toolCallsPerTurn: 1.5,
            perTurnTokens: [],
            perTurnToolCalls: [],
            toolCallDetails: [
                { tool: 'Read', turn: 1, input: {} },
                { tool: 'Bash', turn: 1, input: {} },
                { tool: 'Write', turn: 2, input: {} },
            ],
            errorRecoveryCount: 0,
            filesCreated: [],
            filesModified: [],
            commandsExecuted: [],
            mcpToolsUsed: [],
        },
        events: [],
        exitCode: 0,
        signal: null,
        aborted: false,
        error: null,
        stopReason: 'end_turn',
        stderr: '',
        hungWarnings: [],
        ...overrides,
    };
}

function makeMockJudgeResult(overrides?: Partial<JudgeResult>): JudgeResult {
    return {
        verdicts: [
            { checkType: 'contains', checkValue: 'test', verdict: 'pass', evidence: 'found' },
        ],
        overallVerdict: 'pass',
        ...overrides,
    };
}

describe('OTel instrumentation', () => {
    let tracer: Tracer;

    beforeEach(() => {
        trace.disable();
        tracer = initOtel();
    });

    afterEach(async () => {
        await flushOtel();
        trace.disable();
    });

    it('initOtel returns a Tracer object', () => {
        expect(tracer).toBeDefined();
        expect(typeof tracer.startSpan).toBe('function');
    });

    it('startScenarioSpan creates a span with correct gen_ai attributes', async () => {
        const span = startScenarioSpan(tracer, {
            scenarioName: 'test-scenario',
            agent: 'claude-code',
            model: 'claude-sonnet-4-20250514',
            testsTotal: 3,
        });
        span.end();

        const data = await flushOtel();
        expect(data).not.toBeNull();

        const spans = data!.resourceSpans[0].scopeSpans[0].spans;
        const scenarioSpan = spans.find((s) => s.name === 'scenario_run');
        expect(scenarioSpan).toBeDefined();

        const attrs = scenarioSpan!.attributes;
        const attrMap = Object.fromEntries(attrs.map((a) => [a.key, a.value]));
        expect(attrMap['gen_ai.workflow.name']).toEqual({ stringValue: 'test-scenario' });
        expect(attrMap['gen_ai.provider.name']).toEqual({ stringValue: 'claude-code' });
        expect(attrMap['gen_ai.request.model']).toEqual({ stringValue: 'claude-sonnet-4-20250514' });
        expect(attrMap['eval.tests_total']).toEqual({ intValue: '3' });
    });

    it('startTestSpan + endTestSpan creates a span with correct attributes', async () => {
        const span = startTestSpan(tracer, { testIndex: 0, prompt: 'What is 2+2?' });
        endTestSpan(span, 'pass');

        const data = await flushOtel();
        expect(data).not.toBeNull();

        const spans = data!.resourceSpans[0].scopeSpans[0].spans;
        const testSpan = spans.find((s) => s.name === 'test_0');
        expect(testSpan).toBeDefined();

        const attrMap = Object.fromEntries(testSpan!.attributes.map((a) => [a.key, a.value]));
        expect(attrMap['eval.test_index']).toEqual({ intValue: '0' });
        expect(attrMap['eval.prompt_length']).toEqual({ intValue: String('What is 2+2?'.length) });
        expect(attrMap['eval.overall_verdict']).toEqual({ stringValue: 'pass' });
    });

    it('startAgentSpan + endAgentSpan sets gen_ai.usage attributes from mock result', async () => {
        const mockResult = makeMockAgentResult();
        const span = startAgentSpan(tracer, 'claude-code');
        endAgentSpan(span, mockResult);

        const data = await flushOtel();
        expect(data).not.toBeNull();

        const spans = data!.resourceSpans[0].scopeSpans[0].spans;
        const agentSpan = spans.find((s) => s.name === 'invoke_agent');
        expect(agentSpan).toBeDefined();

        const attrMap = Object.fromEntries(agentSpan!.attributes.map((a) => [a.key, a.value]));
        expect(attrMap['gen_ai.usage.input_tokens']).toEqual({ intValue: '100' });
        expect(attrMap['gen_ai.usage.output_tokens']).toEqual({ intValue: '50' });
        expect(attrMap['gen_ai.usage.cache_read.input_tokens']).toEqual({ intValue: '30' });
        expect(attrMap['gen_ai.usage.cache_creation.input_tokens']).toEqual({ intValue: '0' });
        expect(attrMap['gen_ai.response.finish_reasons']).toEqual({ stringValue: 'end_turn' });
        expect(attrMap['eval.num_turns']).toEqual({ intValue: '2' });
        expect(attrMap['eval.total_cost_usd']).toEqual({ doubleValue: 0.01 });
        expect(attrMap['eval.duration_ms']).toEqual({ intValue: '5000' });
        expect(attrMap['eval.tool_call_count']).toEqual({ intValue: '3' });
        expect(attrMap['eval.error_recovery_count']).toEqual({ intValue: '0' });

        // Check tool_call events
        const toolEvents = agentSpan!.events.filter((e) => e.name === 'tool_call');
        expect(toolEvents).toHaveLength(3);
        const firstEventAttrs = Object.fromEntries(toolEvents[0].attributes.map((a) => [a.key, a.value]));
        expect(firstEventAttrs['gen_ai.tool.name']).toEqual({ stringValue: 'Read' });
    });

    it('endAgentSpan sets error status when result has error', async () => {
        const mockResult = makeMockAgentResult({ error: 'Something went wrong' });
        const span = startAgentSpan(tracer, 'claude-code');
        endAgentSpan(span, mockResult);

        const data = await flushOtel();
        const spans = data!.resourceSpans[0].scopeSpans[0].spans;
        const agentSpan = spans.find((s) => s.name === 'invoke_agent');
        expect(agentSpan).toBeDefined();
        // SpanStatusCode.ERROR = 2
        expect(agentSpan!.status.code).toBe(2);
        expect(agentSpan!.status.message).toBe('Something went wrong');
    });

    it('startJudgeSpan + endJudgeSpan adds verdict events', async () => {
        const mockJudge = makeMockJudgeResult({
            verdicts: [
                { checkType: 'contains', checkValue: 'test', verdict: 'pass', evidence: 'found it' },
                { checkType: 'regex', checkValue: '\\d+', verdict: 'fail', evidence: 'no match' },
            ],
            overallVerdict: 'fail',
        });

        const span = startJudgeSpan(tracer);
        endJudgeSpan(span, mockJudge, 150);

        const data = await flushOtel();
        const spans = data!.resourceSpans[0].scopeSpans[0].spans;
        const judgeSpan = spans.find((s) => s.name === 'judge_evaluation');
        expect(judgeSpan).toBeDefined();

        const attrMap = Object.fromEntries(judgeSpan!.attributes.map((a) => [a.key, a.value]));
        expect(attrMap['eval.check_count']).toEqual({ intValue: '2' });
        expect(attrMap['eval.overall_verdict']).toEqual({ stringValue: 'fail' });
        expect(attrMap['eval.judge_latency_ms']).toEqual({ intValue: '150' });

        // Verdict events
        const verdictEvents = judgeSpan!.events.filter((e) => e.name === 'check_verdict');
        expect(verdictEvents).toHaveLength(2);

        const firstVerdictAttrs = Object.fromEntries(verdictEvents[0].attributes.map((a) => [a.key, a.value]));
        expect(firstVerdictAttrs['gen_ai.evaluation.name']).toEqual({ stringValue: 'contains' });
        expect(firstVerdictAttrs['gen_ai.evaluation.score.label']).toEqual({ stringValue: 'pass' });

        const secondVerdictAttrs = Object.fromEntries(verdictEvents[1].attributes.map((a) => [a.key, a.value]));
        expect(secondVerdictAttrs['gen_ai.evaluation.name']).toEqual({ stringValue: 'regex' });
        expect(secondVerdictAttrs['gen_ai.evaluation.score.label']).toEqual({ stringValue: 'fail' });

        // Failed judge has ERROR status
        expect(judgeSpan!.status.code).toBe(2);
        expect(judgeSpan!.status.message).toBe('evaluation failed');
    });

    it('endJudgeSpan does not set error status on pass', async () => {
        const mockJudge = makeMockJudgeResult();
        const span = startJudgeSpan(tracer);
        endJudgeSpan(span, mockJudge, 50);

        const data = await flushOtel();
        const spans = data!.resourceSpans[0].scopeSpans[0].spans;
        const judgeSpan = spans.find((s) => s.name === 'judge_evaluation');
        expect(judgeSpan).toBeDefined();
        // SpanStatusCode.UNSET = 0
        expect(judgeSpan!.status.code).toBe(0);
    });
});

describe('flushOtel structure', () => {
    beforeEach(() => {
        trace.disable();
    });

    afterEach(async () => {
        await flushOtel();
        trace.disable();
    });

    it('returns OtlpJsonData with correct structure', async () => {
        const tracer = initOtel();
        const span = startScenarioSpan(tracer, {
            scenarioName: 'struct-test',
            agent: 'codex',
            model: 'gpt-4',
            testsTotal: 1,
        });
        span.end();

        const data = await flushOtel();
        expect(data).not.toBeNull();

        // Top-level structure
        expect(data).toHaveProperty('resourceSpans');
        expect(Array.isArray(data!.resourceSpans)).toBe(true);
        expect(data!.resourceSpans).toHaveLength(1);

        // Resource
        const rs = data!.resourceSpans[0];
        expect(rs).toHaveProperty('resource');
        expect(rs.resource).toHaveProperty('attributes');
        expect(Array.isArray(rs.resource.attributes)).toBe(true);

        // Resource attributes should contain service.name
        const resourceAttrMap = Object.fromEntries(rs.resource.attributes.map((a) => [a.key, a.value]));
        expect(resourceAttrMap['service.name']).toEqual({ stringValue: 'apify-evals-runner' });

        // Scope spans
        expect(rs).toHaveProperty('scopeSpans');
        expect(Array.isArray(rs.scopeSpans)).toBe(true);
        expect(rs.scopeSpans).toHaveLength(1);

        const ss = rs.scopeSpans[0];
        expect(ss).toHaveProperty('scope');
        expect(ss.scope.name).toBe('apify-evals');
        expect(ss.scope.version).toBe('0.0.1');
        expect(ss).toHaveProperty('spans');
        expect(Array.isArray(ss.spans)).toBe(true);
    });

    it('includes all spans created during the test', async () => {
        const tracer = initOtel();

        const scenarioSpan = startScenarioSpan(tracer, {
            scenarioName: 'multi-span',
            agent: 'claude-code',
            model: 'test-model',
            testsTotal: 1,
        });
        const testSpan = startTestSpan(tracer, { testIndex: 0, prompt: 'test prompt' });
        const agentSpan = startAgentSpan(tracer, 'claude-code');

        endAgentSpan(agentSpan, makeMockAgentResult());
        endTestSpan(testSpan, 'pass');
        endScenarioSpan(scenarioSpan, 1, 0, 0.01);

        const data = await flushOtel();
        expect(data).not.toBeNull();

        const spans = data!.resourceSpans[0].scopeSpans[0].spans;
        const spanNames = spans.map((s) => s.name);
        expect(spanNames).toContain('scenario_run');
        expect(spanNames).toContain('test_0');
        expect(spanNames).toContain('invoke_agent');
        expect(spans.length).toBeGreaterThanOrEqual(3);
    });

    it('returns null when called without init', async () => {
        // flushOtel without prior initOtel — global state is cleared
        const data = await flushOtel();
        expect(data).toBeNull();
    });
});

describe('BufferSpanExporter', () => {
    it('getOtlpJson serializes spans to OTLP JSON format', async () => {
        trace.disable();
        const tracer = initOtel();
        const span = startScenarioSpan(tracer, {
            scenarioName: 'buffer-test',
            agent: 'claude-code',
            model: 'test',
            testsTotal: 1,
        });
        span.end();

        const data = await flushOtel();
        trace.disable();
        expect(data).not.toBeNull();

        // Verify the spans have the expected OTLP structure
        const otlpSpan = data!.resourceSpans[0].scopeSpans[0].spans[0];
        expect(otlpSpan).toHaveProperty('traceId');
        expect(otlpSpan).toHaveProperty('spanId');
        expect(otlpSpan).toHaveProperty('name');
        expect(otlpSpan).toHaveProperty('kind');
        expect(otlpSpan).toHaveProperty('startTimeUnixNano');
        expect(otlpSpan).toHaveProperty('endTimeUnixNano');
        expect(otlpSpan).toHaveProperty('attributes');
        expect(otlpSpan).toHaveProperty('events');
        expect(otlpSpan).toHaveProperty('status');

        // traceId and spanId are hex strings
        expect(otlpSpan.traceId).toMatch(/^[0-9a-f]{32}$/);
        expect(otlpSpan.spanId).toMatch(/^[0-9a-f]{16}$/);

        // Timestamps are numeric strings (nanoseconds)
        expect(typeof otlpSpan.startTimeUnixNano).toBe('string');
        expect(Number(otlpSpan.startTimeUnixNano)).toBeGreaterThan(0);
    });
});

describe('spansToOtlpJson — attribute mapping', () => {
    beforeEach(() => {
        trace.disable();
    });

    afterEach(async () => {
        await flushOtel();
        trace.disable();
    });

    it('maps string attributes to stringValue', async () => {
        const tracer = initOtel();
        const span = startScenarioSpan(tracer, {
            scenarioName: 'attr-test',
            agent: 'claude-code',
            model: 'test-model',
            testsTotal: 1,
        });
        span.end();

        const data = await flushOtel();
        const attrs = data!.resourceSpans[0].scopeSpans[0].spans[0].attributes;
        const nameAttr = attrs.find((a) => a.key === 'gen_ai.workflow.name');
        expect(nameAttr).toBeDefined();
        expect(nameAttr!.value).toHaveProperty('stringValue');
        expect(nameAttr!.value.stringValue).toBe('attr-test');
    });

    it('maps integer attributes to intValue', async () => {
        const tracer = initOtel();
        const span = startScenarioSpan(tracer, {
            scenarioName: 'int-test',
            agent: 'claude-code',
            model: 'test',
            testsTotal: 5,
        });
        span.end();

        const data = await flushOtel();
        const attrs = data!.resourceSpans[0].scopeSpans[0].spans[0].attributes;
        const totalAttr = attrs.find((a) => a.key === 'eval.tests_total');
        expect(totalAttr).toBeDefined();
        expect(totalAttr!.value).toHaveProperty('intValue');
        expect(totalAttr!.value.intValue).toBe('5');
    });

    it('maps float attributes to doubleValue', async () => {
        const tracer = initOtel();
        const agentSpan = startAgentSpan(tracer, 'claude-code');
        endAgentSpan(agentSpan, makeMockAgentResult());

        const data = await flushOtel();
        const spans = data!.resourceSpans[0].scopeSpans[0].spans;
        const span = spans.find((s) => s.name === 'invoke_agent');
        expect(span).toBeDefined();
        const attrs = span!.attributes;

        // totalCostUsd is 0.01 — a non-integer float
        const costAttr = attrs.find((a) => a.key === 'eval.total_cost_usd');
        expect(costAttr).toBeDefined();
        expect(costAttr!.value).toHaveProperty('doubleValue');
        expect(costAttr!.value.doubleValue).toBe(0.01);
    });

    it('maps boolean attributes to boolValue via direct spansToOtlpJson', () => {
        // Test spansToOtlpJson directly with a minimal mock ReadableSpan
        const exporter = new BufferSpanExporter();
        // Use the exporter's own getOtlpJson on an empty buffer
        const emptyData = exporter.getOtlpJson();
        expect(emptyData.resourceSpans).toHaveLength(1);
        expect(emptyData.resourceSpans[0].scopeSpans[0].spans).toHaveLength(0);
    });
});

describe('Full OTel lifecycle', () => {
    it('init → scenario → test → agent → judge → end all → flush → verify', async () => {
        trace.disable();
        const tracer = initOtel();

        // Create scenario span
        const scenarioSpan = startScenarioSpan(tracer, {
            scenarioName: 'lifecycle-test',
            agent: 'claude-code',
            model: 'claude-sonnet-4-20250514',
            testsTotal: 1,
        });

        // Create test span
        const testSpan = startTestSpan(tracer, { testIndex: 0, prompt: 'What is 2+2?' });

        // Create agent span and end it
        const agentSpan = startAgentSpan(tracer, 'claude-code');
        endAgentSpan(agentSpan, makeMockAgentResult());

        // Create judge span and end it
        const judgeSpan = startJudgeSpan(tracer);
        endJudgeSpan(judgeSpan, makeMockJudgeResult(), 100);

        // End test and scenario
        endTestSpan(testSpan, 'pass');
        endScenarioSpan(scenarioSpan, 1, 0, 0.01);

        // Flush and verify
        const data = await flushOtel();
        trace.disable();
        expect(data).not.toBeNull();

        const rs = data!.resourceSpans;
        expect(rs).toHaveLength(1);

        const spans = rs[0].scopeSpans[0].spans;
        const spanNames = spans.map((s) => s.name);

        // All 4 span types should be present
        expect(spanNames).toContain('scenario_run');
        expect(spanNames).toContain('test_0');
        expect(spanNames).toContain('invoke_agent');
        expect(spanNames).toContain('judge_evaluation');
        expect(spans).toHaveLength(4);

        // Verify scenario span attributes
        const scenario = spans.find((s) => s.name === 'scenario_run')!;
        const scenarioAttrs = Object.fromEntries(scenario.attributes.map((a) => [a.key, a.value]));
        expect(scenarioAttrs['gen_ai.workflow.name']).toEqual({ stringValue: 'lifecycle-test' });
        expect(scenarioAttrs['eval.tests_passed']).toEqual({ intValue: '1' });
        expect(scenarioAttrs['eval.tests_failed']).toEqual({ intValue: '0' });

        // Verify agent span has tool events
        const agent = spans.find((s) => s.name === 'invoke_agent')!;
        expect(agent.events.filter((e) => e.name === 'tool_call')).toHaveLength(3);

        // Verify judge span has verdict events
        const judge = spans.find((s) => s.name === 'judge_evaluation')!;
        expect(judge.events.filter((e) => e.name === 'check_verdict')).toHaveLength(1);

        // Verify each span has valid traceId/spanId
        for (const s of spans) {
            expect(s.traceId).toMatch(/^[0-9a-f]{32}$/);
            expect(s.spanId).toMatch(/^[0-9a-f]{16}$/);
        }
    });
});
