export interface ScenarioMeta {
    name: string;
    description: string;
    abortOnFailure: boolean;
}

export interface TestCase {
    test: string;
    checkpoint: string;
    monitor: string | null;
}

export interface ParsedScenario {
    meta: ScenarioMeta;
    tests: TestCase[];
}

export type VerdictValue = 'pass' | 'fail' | 'unclear';

export type CheckType = 'contains' | 'regex' | 'json-schema' | 'script' | 'llm-judge' | 'error';

export interface CheckVerdict {
    checkType: CheckType;
    checkValue: string;
    verdict: VerdictValue;
    evidence: string;
    confidence: number;
}

export interface RunMetrics {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    totalCostUsd: number;
    durationMs: number;
    durationApiMs: number;
    numTurns: number;
    modelUsage: Record<string, ModelUsage>;
}

export interface ModelUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    costUSD: number;
}

export interface AgentResult {
    agent: string;
    model: string;
    scenarioName: string;
    testIndex: number;
    testPrompt: string;
    checkpoint: string;
    agentOutput: string;
    monitorOutput: string | null;
    verdicts: CheckVerdict[];
    overallVerdict: VerdictValue;
    metrics: RunMetrics;
    aborted: boolean;
    abortReason: string | null;
    error: string | null;
}

export type AgentType = 'claude-code' | 'codex' | 'opencode';

export interface ClaudeStreamEvent {
    type: string;
    subtype?: string;
    message?: {
        model: string;
        content: Array<{ type: string; text?: string }>;
        usage: {
            input_tokens: number;
            output_tokens: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
        };
    };
    // result event fields (flat)
    is_error?: boolean;
    total_cost_usd?: number;
    num_turns?: number;
    duration_ms?: number;
    duration_api_ms?: number;
    stop_reason?: string;
    session_id?: string;
    structured_output?: Record<string, unknown>;
    usage?: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
    };
    modelUsage?: Record<string, ModelUsage>;
}
