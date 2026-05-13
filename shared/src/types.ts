export interface ExpectedTools {
    required: string[];
    forbidden: string[];
    optional: string[];
    requiredCommands: string[];
    forbiddenCommands: string[];
}

export interface ScenarioMeta {
    name: string;
    description: string;
    abortOnFailure: boolean;
    expectedTools?: ExpectedTools;
}

export interface ExpectedToolCall {
    tool: string;
    parameterHint: string;
}

export interface TestCase {
    test: string;
    checkpoint: string;
    monitor: string | null;
    expectedToolCalls: ExpectedToolCall[];
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
    totalContextTokens: number;     // input + cacheRead + cacheCreate (real context sent to model)
    tokensPerTurn: number;          // output / numTurns
    costPerTurn: number;            // cost / numTurns
    cacheHitRate: number;           // cacheRead / totalContextTokens (0-1)
    contextOutputRatio: number;     // totalContext / output (how much reading vs generating)
    apiDurationRatio: number;       // apiMs / wallMs (can be >1 if parallel calls)
    avgTurnDurationMs: number;      // wallMs / numTurns
    toolExecutionMs: number;        // durationMs - durationApiMs (time spent in tools, not LLM)
    planningTurns: number;          // turns with only text output (no tool calls)
    executionTurns: number;         // turns with at least one tool call
}

export interface ToolCallDetail {
    tool: string;
    turn: number;
    input: Record<string, unknown>;   // truncated arguments
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
    // Tier 2: detailed tool calls (for parameter correctness)
    toolCallDetails: ToolCallDetail[];
    // Tier 2: self-correction signals
    errorRecoveryCount: number;
    // Tier 2: side effects
    filesCreated: string[];
    filesModified: string[];
    commandsExecuted: string[];
    mcpToolsUsed: string[];
}

export interface DiscoverabilityMetrics {
    expectedRequired: string[];
    expectedForbidden: string[];
    expectedOptional: string[];
    actualTools: string[];
    missingTools: string[];
    extraTools: string[];
    forbiddenToolsUsed: string[];
    missingCommands: string[];
    forbiddenCommandsUsed: string[];
    discoverabilityScore: number;   // |required ∩ actual| / |required| (0-1)
    strictScore: number;            // 1.0 if no missing + no forbidden (tools + commands)
}

export interface ModelUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    costUSD: number;
}

export interface JudgeMetrics {
    judgeCostUsd: number;           // cost of LLM judge calls
    judgeLatencyMs: number;        // time spent in judge (all checks)
    judgeTurns: number;             // number of LLM judge calls made
}

export interface AgentResult {
    agent: string;
    model: string;
    scenarioName: string;
    testIndex: number;
    testPrompt: string;
    checkpoint: string;
    agentOutput: string;
    agentOutputLength: number;
    monitorOutput: string | null;
    verdicts: CheckVerdict[];
    overallVerdict: VerdictValue;
    metrics: RunMetrics;
    efficiency: EfficiencyMetrics;
    trajectory: TrajectoryMetrics;
    discoverability: DiscoverabilityMetrics | null;
    judge: JudgeMetrics;
    retryAttempts: number;
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
