export interface AgentDef {
    command: string;
    subcommand: string | null;
    promptFlag: string | null;
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
    stdinMode: 'ignore' | 'pipe-eof';
}

export const AGENT_REGISTRY: Record<string, AgentDef> = {
    'claude-code': {
        command: 'claude',
        subcommand: null,
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
        stdinMode: 'ignore',
    },
    'codex': {
        command: 'codex',
        subcommand: 'exec',
        promptFlag: null,
        systemPromptFlag: null,
        outputFlags: ['--json'],
        permissionFlags: ['--dangerously-bypass-approvals-and-sandbox'],
        sessionFlags: ['--ephemeral', '--ignore-user-config', '--skip-git-repo-check'],
        modelFlag: '--model',
        maxTurnsFlag: null,
        budgetFlag: null,
        mcpConfigFlag: null,
        mcpStrictFlag: null,
        outputFormat: 'ndjson',
        stdinMode: 'pipe-eof',
    },
    'opencode': {
        command: 'opencode',
        subcommand: 'run',
        promptFlag: null,
        systemPromptFlag: null,
        outputFlags: ['--format', 'json'],
        permissionFlags: ['--dangerously-skip-permissions'],
        sessionFlags: [],
        modelFlag: '--model',
        maxTurnsFlag: null,
        budgetFlag: null,
        mcpConfigFlag: null,
        mcpStrictFlag: null,
        outputFormat: 'ndjson',
        stdinMode: 'ignore',
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

    if (def.subcommand) {
        args.push(def.subcommand);
    }

    if (def.promptFlag) {
        args.push(def.promptFlag, opts.prompt);
    } else {
        args.push(opts.prompt);
    }

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
