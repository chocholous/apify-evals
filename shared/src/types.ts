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
    parseWarnings?: string[];
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

// Base token/cost metrics (raw from agent)
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

// Derived efficiency metrics (Tier 1)
export interface EfficiencyMetrics {
    tokensPerTurn: number;
    costPerTurn: number;
    cacheHitRate: number;
    inputOutputRatio: number;
    apiDurationRatio: number;
    avgTurnDurationMs: number;
}

// Tool/trajectory metrics (Tier 1 + 2)
export interface TrajectoryMetrics {
    toolCallCount: number;
    toolCallSequence: string[];
    uniqueToolsUsed: string[];
    toolCallsPerTurn: number;
    // Tier 2: per-turn breakdown
    perTurnTokens: Array<{ turn: number; input: number; output: number }>;
    perTurnToolCalls: Array<{ turn: number; tools: string[] }>;
    // Tier 2: self-correction signals
    errorRecoveryCount: number;
    // Tier 2: side effects
    filesCreated: string[];
    filesModified: string[];
    commandsExecuted: string[];
    mcpToolsUsed: string[];
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
    efficiency: EfficiencyMetrics;
    trajectory: TrajectoryMetrics;
    stopReason: string;
    exitCode: number | null;
    aborted: boolean;
    abortReason: string | null;
    error: string | null;
}

export type AgentType = 'claude-code' | 'codex' | 'opencode';

// Generic agent event — superset of fields across all agents
export interface AgentEvent {
    type: string;
    subtype?: string;
    // Claude: assistant event
    message?: {
        model: string;
        content: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
        usage: {
            input_tokens: number;
            output_tokens: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
        };
    };
    // Claude: result event fields (flat)
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
    // Codex: item events
    item?: {
        id?: string;
        type?: string;
        text?: string;
        command?: string;
        exit_code?: number;
        status?: string;
        tool?: string;
        changes?: Array<{ path: string; kind: string }>;
    };
    // Codex: error
    error?: { message?: string };
    // OpenCode: part events
    part?: {
        id?: string;
        messageID?: string;
        sessionID?: string;
        type?: string;
        text?: string;
        callID?: string;
        tool?: string;
        cost?: number;
        reason?: string;
        tokens?: {
            input: number;
            output: number;
            reasoning: number;
            cache?: { read: number; write: number };
        };
        state?: { status?: string; input?: unknown; output?: unknown };
        time?: { start?: number; end?: number };
    };
    // OpenCode: session-level error
    errorData?: { name?: string; data?: { message?: string } };
    // Generic timestamp
    timestamp?: number;
}

// Keep old name as alias for backward compat in imports
export type ClaudeStreamEvent = AgentEvent;
