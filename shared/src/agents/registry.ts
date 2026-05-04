export interface AgentDef {
    command: string;
    promptFlag: string;
    systemPromptFlag: string | null;
    outputFlags: string[];
    permissionFlags: string[];
    sessionFlags: string[];
    modelFlag: string | null;
    maxTurnsFlag: string | null;
    budgetFlag: string | null;
    mcpConfigFlag: string | null;
    mcpStrictFlag: string | null;
    outputFormat: 'ndjson' | 'json' | 'text';
}

export const AGENT_REGISTRY: Record<string, AgentDef> = {
    'claude-code': {
        command: 'claude',
        promptFlag: '-p',
        systemPromptFlag: '--system-prompt',
        outputFlags: ['--output-format', 'stream-json', '--verbose'],
        permissionFlags: ['--dangerously-skip-permissions'],
        sessionFlags: ['--no-session-persistence'],
        modelFlag: '--model',
        maxTurnsFlag: '--max-turns',
        budgetFlag: '--max-budget-usd',
        mcpConfigFlag: '--mcp-config',
        mcpStrictFlag: '--strict-mcp-config',
        outputFormat: 'ndjson',
    },
    'codex': {
        command: 'codex',
        promptFlag: 'exec',
        systemPromptFlag: null,
        outputFlags: ['--json'],
        permissionFlags: ['--full-auto'],
        sessionFlags: [],
        modelFlag: '--model',
        maxTurnsFlag: null,
        budgetFlag: null,
        mcpConfigFlag: null,
        mcpStrictFlag: null,
        outputFormat: 'json',
    },
    'opencode': {
        command: 'opencode',
        promptFlag: '-p',
        systemPromptFlag: null,
        outputFlags: ['-f', 'json'],
        permissionFlags: [],
        sessionFlags: [],
        modelFlag: null,
        maxTurnsFlag: null,
        budgetFlag: null,
        mcpConfigFlag: null,
        mcpStrictFlag: null,
        outputFormat: 'json',
    },
};

export function getAgentDef(agent: string): AgentDef | null {
    return AGENT_REGISTRY[agent] ?? null;
}

export function buildAgentArgs(def: AgentDef, opts: {
    prompt: string;
    systemPrompt?: string;
    model?: string;
    maxTurns?: number;
    maxBudgetUsd?: number;
    mcpConfigPath?: string;
    strictMcpConfig?: boolean;
}): string[] {
    const args: string[] = [];

    args.push(def.promptFlag, opts.prompt);
    args.push(...def.outputFlags);
    args.push(...def.permissionFlags);
    args.push(...def.sessionFlags);

    if (opts.systemPrompt && def.systemPromptFlag) {
        args.push(def.systemPromptFlag, opts.systemPrompt);
    }
    if (opts.model && def.modelFlag) {
        args.push(def.modelFlag, opts.model);
    }
    if (opts.maxTurns && def.maxTurnsFlag) {
        args.push(def.maxTurnsFlag, String(opts.maxTurns));
    }
    if (opts.maxBudgetUsd && def.budgetFlag) {
        args.push(def.budgetFlag, String(opts.maxBudgetUsd));
    }
    if (opts.mcpConfigPath && def.mcpConfigFlag) {
        args.push(def.mcpConfigFlag, opts.mcpConfigPath);
        if (opts.strictMcpConfig && def.mcpStrictFlag) {
            args.push(def.mcpStrictFlag);
        }
    }

    return args;
}
