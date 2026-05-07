import type { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';

interface OtlpAttribute {
    key: string;
    value: { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean };
}

function toOtlpAttribute(key: string, val: unknown): OtlpAttribute {
    if (typeof val === 'boolean') return { key, value: { boolValue: val } };
    if (typeof val === 'number') {
        return Number.isInteger(val)
            ? { key, value: { intValue: String(val) } }
            : { key, value: { doubleValue: val } };
    }
    return { key, value: { stringValue: String(val) } };
}

function hrtimeToNano(hrtime: [number, number]): string {
    return String(hrtime[0] * 1_000_000_000 + hrtime[1]);
}

function spanToOtlp(span: ReadableSpan) {
    const attrs: OtlpAttribute[] = [];
    for (const [k, v] of Object.entries(span.attributes)) {
        if (v !== undefined) attrs.push(toOtlpAttribute(k, v));
    }

    const events = span.events.map((e) => {
        const eventAttrs: OtlpAttribute[] = [];
        if (e.attributes) {
            for (const [k, v] of Object.entries(e.attributes)) {
                if (v !== undefined) eventAttrs.push(toOtlpAttribute(k, v));
            }
        }
        return {
            name: e.name,
            timeUnixNano: hrtimeToNano(e.time as [number, number]),
            attributes: eventAttrs,
        };
    });

    const parentCtx = span.parentSpanContext;
    return {
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        parentSpanId: parentCtx?.spanId || undefined,
        name: span.name,
        kind: span.kind,
        startTimeUnixNano: hrtimeToNano(span.startTime),
        endTimeUnixNano: hrtimeToNano(span.endTime),
        attributes: attrs,
        events,
        status: { code: span.status.code, message: span.status.message },
    };
}

export interface OtlpJsonData {
    resourceSpans: Array<{
        resource: { attributes: OtlpAttribute[] };
        scopeSpans: Array<{
            scope: { name: string; version?: string };
            spans: ReturnType<typeof spanToOtlp>[];
        }>;
    }>;
}

export function spansToOtlpJson(spans: ReadableSpan[]): OtlpJsonData {
    const resourceAttrs: OtlpAttribute[] = [];
    const firstResource = spans[0]?.resource;
    if (firstResource) {
        for (const [k, v] of Object.entries(firstResource.attributes)) {
            if (v !== undefined) resourceAttrs.push(toOtlpAttribute(k, v));
        }
    }

    return {
        resourceSpans: [{
            resource: { attributes: resourceAttrs },
            scopeSpans: [{
                scope: { name: 'apify-evals', version: '0.0.1' },
                spans: spans.map(spanToOtlp),
            }],
        }],
    };
}

export class BufferSpanExporter implements SpanExporter {
    private spans: ReadableSpan[] = [];

    export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
        this.spans.push(...spans);
        resultCallback({ code: ExportResultCode.SUCCESS });
    }

    getOtlpJson(): OtlpJsonData {
        return spansToOtlpJson(this.spans);
    }

    shutdown(): Promise<void> {
        return Promise.resolve();
    }
}
