import { trace, SpanKind, SpanStatusCode, type Tracer, type Span } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

import { BufferSpanExporter, type OtlpJsonData } from './otel-exporter.js';
import type { AgentRunResult } from './agents/run.js';
import type { JudgeResult } from './judge.js';
import type { CheckVerdict } from './types.js';

const TRACER_NAME = 'apify-evals';
const TRACER_VERSION = '0.0.1';

let globalProvider: NodeTracerProvider | null = null;
let globalExporter: BufferSpanExporter | null = null;

export function initOtel(): Tracer {
    globalExporter = new BufferSpanExporter();
    globalProvider = new NodeTracerProvider({
        resource: resourceFromAttributes({
            [ATTR_SERVICE_NAME]: 'apify-evals-runner',
            [ATTR_SERVICE_VERSION]: TRACER_VERSION,
        }),
        spanProcessors: [new SimpleSpanProcessor(globalExporter)],
    });
    globalProvider.register();
    return trace.getTracer(TRACER_NAME, TRACER_VERSION);
}

export async function flushOtel(): Promise<OtlpJsonData | null> {
    if (!globalProvider || !globalExporter) return null;
    await globalProvider.forceFlush();
    const data = globalExporter.getOtlpJson();
    await globalProvider.shutdown();
    globalProvider = null;
    globalExporter = null;
    return data;
}

export function startScenarioSpan(tracer: Tracer, opts: {
    scenarioName: string;
    agent: string;
    model: string;
    testsTotal: number;
}): Span {
    return tracer.startSpan('scenario_run', {
        kind: SpanKind.INTERNAL,
        attributes: {
            'gen_ai.workflow.name': opts.scenarioName,
            'gen_ai.provider.name': opts.agent,
            'gen_ai.request.model': opts.model,
            'eval.tests_total': opts.testsTotal,
        },
    });
}

export function startTestSpan(tracer: Tracer, opts: {
    testIndex: number;
    prompt: string;
}): Span {
    return tracer.startSpan(`test_${opts.testIndex}`, {
        kind: SpanKind.INTERNAL,
        attributes: {
            'eval.test_index': opts.testIndex,
            'eval.prompt_length': opts.prompt.length,
        },
    });
}

export function startAgentSpan(tracer: Tracer, agent: string): Span {
    return tracer.startSpan('invoke_agent', {
        kind: SpanKind.INTERNAL,
        attributes: {
            'gen_ai.operation.name': 'invoke_agent',
            'gen_ai.agent.name': agent,
        },
    });
}

export function endAgentSpan(span: Span, result: AgentRunResult): void {
    span.setAttributes({
        'gen_ai.usage.input_tokens': result.metrics.inputTokens,
        'gen_ai.usage.output_tokens': result.metrics.outputTokens,
        'gen_ai.usage.cache_read.input_tokens': result.metrics.cacheReadTokens,
        'gen_ai.usage.cache_creation.input_tokens': result.metrics.cacheCreationTokens,
        'gen_ai.response.finish_reasons': result.stopReason,
        'eval.num_turns': result.metrics.numTurns,
        'eval.total_cost_usd': result.metrics.totalCostUsd,
        'eval.duration_ms': result.metrics.durationMs,
        'eval.tool_call_count': result.trajectory.toolCallCount,
        'eval.error_recovery_count': result.trajectory.errorRecoveryCount,
        'eval.planning_turns': result.efficiency.planningTurns,
        'eval.execution_turns': result.efficiency.executionTurns,
        'eval.cache_hit_rate': result.efficiency.cacheHitRate,
    });

    for (const tc of result.trajectory.toolCallDetails) {
        span.addEvent('tool_call', {
            'gen_ai.tool.name': tc.tool,
            'eval.turn': tc.turn,
        });
    }

    if (result.error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: result.error });
    }
    span.end();
}

export function startJudgeSpan(tracer: Tracer): Span {
    return tracer.startSpan('judge_evaluation', {
        kind: SpanKind.INTERNAL,
        attributes: {
            'gen_ai.operation.name': 'evaluate',
        },
    });
}

export function endJudgeSpan(span: Span, result: JudgeResult, durationMs: number): void {
    span.setAttributes({
        'eval.check_count': result.verdicts.length,
        'eval.overall_verdict': result.overallVerdict,
        'eval.judge_latency_ms': durationMs,
    });

    for (const v of result.verdicts) {
        addVerdictEvent(span, v);
    }

    if (result.overallVerdict === 'fail') {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'evaluation failed' });
    }
    span.end();
}

function addVerdictEvent(span: Span, verdict: CheckVerdict): void {
    span.addEvent('check_verdict', {
        'gen_ai.evaluation.name': verdict.checkType,
        'gen_ai.evaluation.score.value': verdict.confidence,
        'gen_ai.evaluation.score.label': verdict.verdict,
        'gen_ai.evaluation.explanation': verdict.evidence.slice(0, 500),
    });
}

export function endTestSpan(span: Span, verdict: string): void {
    span.setAttribute('eval.overall_verdict', verdict);
    if (verdict === 'fail') {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'test failed' });
    }
    span.end();
}

export function endScenarioSpan(span: Span, passed: number, failed: number, totalCost: number): void {
    span.setAttributes({
        'eval.tests_passed': passed,
        'eval.tests_failed': failed,
        'eval.total_cost_usd': totalCost,
    });
    span.end();
}
