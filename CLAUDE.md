@AGENTS.md

# Agent Evals

TypeScript monorepo se dvěma Apify Actory pro evaluaci AI agentů (Claude Code, Codex, OpenCode) napříč různými tool integration metodami (MCP, CLI, mcpc).

## Architektura

Monorepo s npm workspaces:
- `shared/` — sdílená knihovna (types, scenario-parser, agent adaptery, judge, metriky, OTel instrumentace)
- `actors/runner/` — Actor #1: spustí jeden eval scénář s jedním agentem
- `actors/orchestrator/` — Actor #2: orchestruje více scénářů (Fáze 3)

## Konvence

- **Jazyk:** TypeScript, ES modules (`"type": "module"`)
- **Importy:** `.js` extension v relativních importech (ESM requirement)
- **Linting:** `@apify/eslint-config/ts.js` + Prettier (4 spaces, single quotes, 120 chars)
- **Testy:** Vitest (unit + integration)
- **Build:** `tsc` → `dist/`

## Agent registry

Agenti jsou definovaní v `shared/src/agents/registry.ts`. Každý agent má command, flagy, output format:

| Agent | Command | Key flags | Output |
|-------|---------|-----------|--------|
| `claude-code` | `claude -p "prompt"` | `--output-format stream-json --verbose --dangerously-skip-permissions --no-session-persistence` | NDJSON |
| `codex` | `codex exec "prompt"` | `--json --dangerously-bypass-approvals-and-sandbox --ephemeral` | NDJSON |
| `opencode` | `opencode run "prompt"` | `--format json --dangerously-skip-permissions` | NDJSON |

## Agent execution (`shared/src/agents/run.ts`)

Agenti se spouštějí jako subprocess přes `child_process.spawn()`. Výstup se parsuje per-agent:

- **Claude:** `assistant` events → text + tool_use, `result` event → metrics
- **Codex:** `item.completed` (type=agent_message) → text, `turn.completed` → usage (kumulativní)
- **OpenCode:** `text` event (s `time.end`) → text, `step_finish` → per-step tokens + cost

Error detection:
- Claude: `result.is_error` (kromě `subtype: "error_max_budget_usd"` — to jen nastaví `stopReason: 'budget_exceeded'`)
- Codex: `turn.failed` / `error` event + non-zero exit code
- OpenCode: `error` event (exit code je nespolehlivý — known bug, vždy 0)
- Fallback: non-zero exit code + stderr pro všechny agenty

## Scenario format

Markdown s YAML frontmatter. Validace při startu (throwne `ScenarioParseError` pokud chybí `name`, 0 testů, prázdný input).

```markdown
---
name: scenario-name (required)
description: "Description"
abortOnFailure: false
---

## Test
Prompt pro agenta

## Checkpoint
contains: expected text
regex: \d{4}
script: jq -e '.status == "ok"'
Plain text = LLM judge prompt

## Monitor
(Optional) Follow-up question
```

Multi-test: bloky oddělené `---`.

## Checkpoint systém (`shared/src/judge.ts`)

Checkpoint sekce se parsuje na N kontrol. **Všechny musí projít** pro overall pass.

### Flat formát (prefixované řádky nahoře, plain text dole)
```
contains: Jupiter
regex: \blargest\b
The answer must be scientifically accurate.
```
Pravidlo: prefix řádky se parsují dokud nenarazí na první non-prefix řádek → zbytek = LLM judge.

### Subsection formát (pro multi-line skripty)
```
### Checks
contains: Jupiter

### Script
value=$(cat)
jq -e '.count > 0' /tmp/result.json

### Judge
Evaluate quality of the response.
```
Subsekce: `Check`/`Checks`, `Script`/`Scripts`, `Judge` (case-insensitive).

### Typy kontrol

| Typ | Confidence | Jak funguje |
|-----|-----------|-------------|
| `contains:` | 1.0 | Case-insensitive substring match |
| `regex:` | 1.0 | Case-insensitive regex test |
| `json-schema:` | 1.0 | Ajv validace proti JSON Schema |
| `script:` | 1.0 | Bash script, agent output na stdin, exit 0 = pass, stdout = evidence |
| LLM judge | 0-1 | `claude-haiku-4-5-20251001` s `--json-schema`, max 2 retry |

### Script checkpoint
- Agent output přijde na **stdin**
- Exit code 0 = pass, nenulový = fail
- stdout = evidence (max 1000 znaků)
- Timeout: 30s (konfigurovatelný přes `scriptTimeoutMs`)
- Má přístup k env vars a working directory (vidí soubory co agent vytvořil)

## Output data model (`AgentResult`)

```typescript
interface AgentResult {
    agent: string;              // 'claude-code' | 'codex' | 'opencode'
    model: string;
    scenarioName: string;
    testIndex: number;
    testPrompt: string;
    checkpoint: string;         // raw checkpoint markdown
    agentOutput: string;        // raw agent text response
    monitorOutput: string | null;
    verdicts: CheckVerdict[];   // per-check results
    overallVerdict: VerdictValue; // 'pass' only if ALL pass
    metrics: RunMetrics;        // tokens, cost, duration
    efficiency: EfficiencyMetrics; // derived ratios
    trajectory: TrajectoryMetrics; // tool calls, files, commands
    stopReason: string;         // 'end_turn' | 'budget_exceeded' | 'error' | ...
    exitCode: number | null;
    aborted: boolean;
    abortReason: string | null;
    error: string | null;
}
```

### RunMetrics
```typescript
{ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
  totalCostUsd, durationMs, durationApiMs, numTurns, modelUsage }
```

### EfficiencyMetrics (Tier 1 — derivované)
```typescript
{ totalContextTokens, tokensPerTurn, costPerTurn, cacheHitRate, contextOutputRatio, apiDurationRatio, avgTurnDurationMs }
```
- `totalContextTokens` = inputTokens + cacheReadTokens + cacheCreationTokens (reálný kontext poslaný modelu)
- `cacheHitRate` = cacheRead / totalContext (0-1, ne per-turn sum)
- `contextOutputRatio` = totalContext / output (kolik agent čte vs generuje)
- `apiDurationRatio` > 1 je normální (Claude CLI sčítá paralelní API calls)

### TrajectoryMetrics (Tier 1+2 — z event streamu)
```typescript
{ toolCallCount, toolCallSequence, uniqueToolsUsed, toolCallsPerTurn,
  perTurnTokens, perTurnToolCalls,
  errorRecoveryCount,
  filesCreated, filesModified, commandsExecuted, mcpToolsUsed }
```

## Init presets (`shared/src/init-presets.ts`)

Presets konfigurují **prostředí agenta** (ne vyhodnocení):
- `mcp_native` — zapíše MCP config JSON do `.eval-config/mcp-config.json`, předá `--mcp-config` + `--strict-mcp-config`
- `cli_native` — ověří dostupnost CLI nástrojů (gh, apify-cli)
- `mcpc` — zkontroluje mcpc, volitelně zapíše MCP config
- Custom script běží PO presetu (bash, timeout 5 min)

## LLM Judge

Judge má dva backendy, vybraný přes `judgeMode` input (`auto` | `cli` | `sdk`):

### CLI judge (výchozí fallback)
- `claude -p --json-schema` subprocess
- Model: `claude-haiku-4-5-20251001`
- Vyžaduje `--max-turns 3` (interní tool call pro json-schema)
- Structured output v `result.structured_output` field
- Žádný API klíč potřeba (OAuth/subscription stačí)
- Latence: ~3-5s

### SDK judge (preferovaný pokud API key dostupný)
- `@anthropic-ai/sdk` s `tool_use` pattern (`submit_verdict` tool)
- Model: `claude-haiku-4-5-20251001`
- Vyžaduje `ANTHROPIC_API_KEY` v `envVariables`
- Latence: ~0.5-1s (~5× rychlejší)
- Implementace: `shared/src/agents/judge-sdk.ts`

### Auto-detekce (`judgeMode: 'auto'`)
Funkce `resolveJudgeFn()` v `judge.ts`: pokud `ANTHROPIC_API_KEY` existuje v env → SDK, jinak → CLI.

Retry: max 2 pokusy s exponential delay (1s, 2s). Po vyčerpání → `unclear` s confidence 0.

## OTel instrumentace

Runner produkuje OpenTelemetry trace v `OTEL-TRACE` KV klíč (OTLP JSON formát):

```
scenario_run
├── gen_ai.workflow.name, gen_ai.provider.name, gen_ai.request.model
├── test_0
│   ├── invoke_agent (gen_ai.usage.*, tool_call events)
│   └── judge_evaluation (gen_ai.evaluation.* events per checkpoint)
└── test_1 ...
```

- GenAI Semantic Conventions (`gen_ai.*`) pro ~80% atributů, custom `eval.*` pro zbytek
- `BufferSpanExporter` → žádný server, OTLP JSON do KV store
- Kompatibilní s AgentPrism, Langfuse OTLP endpoint, Jaeger
- Implementace: `shared/src/otel.ts`, `shared/src/otel-exporter.ts`

## Budget (--max-budget-usd)

DŮLEŽITÉ: `--max-budget-usd` je **soft limit**. Claude CLI kontroluje budget mezi turny. Pokud agent v prvním turnu vygeneruje odpověď za $0.07 s limitem $0.05, CLI to zjistí až po turnu a vrátí `subtype: "error_max_budget_usd"`. Runner to NEHLÁSÍ jako error — agent odpověděl, jen nastaví `stopReason: 'budget_exceeded'`.

## Monorepo deploy

Jeden fat `Dockerfile` v rootu instaluje všechny agent CLI (Claude, Codex, OpenCode, Apify CLI). Agent se vybírá za běhu přes input `agent`.
`actor.json` má `dockerContextDir: "../../.."`, což umožňuje Dockerfile přistupovat k `shared/`.
Deploy: `apify push --dir actors/runner`

## Testy

- **Unit testy** (`shared/src/__tests__/*.test.ts`): scenario-parser, judge, judge-mode, metrics, log-masker, init-presets, OTel
- **Validation testy**: scenario-files (parsuje všech 21 scénářů z `scenarios/`), example-inputs (validuje 9 example JSON proti schema)
- **Integrační testy** (`shared/src/__tests__/integration*.ts`): spustí reálného agenta, ověří metrics + trajectory + judging
- Spuštění: `cd shared && npx vitest run` (unit) nebo `npx vitest run src/__tests__/integration*` (integration, pomalé ~2min)

## Dokumentace

- `docs/01-plan.md` — implementační plán
- `docs/02-decisions.md` — architektonická rozhodnutí
- `docs/03-research.md` — research výsledky
- `actors/runner/README.md` — user-facing Store page
- `spikes/` — feasibility testy (S1-S6)
