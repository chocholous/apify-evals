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
| `claude-code` | `claude -p "prompt"` | `--output-format stream-json --verbose --include-partial-messages --dangerously-skip-permissions --no-session-persistence` | NDJSON |
| `codex` | `codex exec "prompt"` | `--json --dangerously-bypass-approvals-and-sandbox --ephemeral` | NDJSON |
| `opencode` | `opencode run "prompt"` | `--format json --dangerously-skip-permissions` | NDJSON |

## Agent execution (`shared/src/agents/run.ts`)

Agenti se spouštějí jako subprocess přes `child_process.spawn()`. Výstup se parsuje per-agent:

- **Claude:** `assistant` events → text + tool_use, `result` event → metrics, `stream_event` → real-time delty (text_delta, thinking_delta) díky `--include-partial-messages`
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

### Judge (opus)
Deep analysis of code architecture.

### warn-Judge (haiku)
Optional: is error handling present?
```
Subsekce: `Check`/`Checks`, `Script`/`Scripts`, `Judge`/`warn-Judge` (case-insensitive). Více `### Judge` bloků v jednom checkpointu je povoleno — každý = samostatný LLM call.

**Judge modifikátory:**
- `### Judge` — default model (sonnet), fail severity
- `### Judge (opus)` — explicitní model (aliases: `haiku`, `sonnet`, `opus` nebo plné model ID)
- `### warn-Judge` — warning severity (fail verdikt = warning, ne fail)
- `### warn-Judge (haiku)` — kombinace

**Judge JSON schema:** `{verdict: "pass"|"fail"|"unclear", reasoning: "string"}`

### Typy kontrol

| Typ | Confidence | Jak funguje |
|-----|-----------|-------------|
| `contains:` | 1.0 | Case-insensitive substring match |
| `regex:` | 1.0 | Case-insensitive regex test |
| `json-schema:` | 1.0 | Ajv validace proti JSON Schema |
| `script:` | 1.0 | Bash script, agent output na stdin, exit 0 = pass, stdout = evidence |
| `jq:` | 1.0 | jq výraz nad conversation events (JSON array), `-e` flag, exit 0 = pass |
| LLM judge | 1.0 | `claude-sonnet-4-6` (default) s `--json-schema`, max 2 retry, per-block model override |

### Script checkpoint
- Agent output přijde na **stdin**
- Exit code 0 = pass, nenulový = fail
- stdout = evidence (max 1000 znaků)
- Timeout: 30s (konfigurovatelný přes `scriptTimeoutMs`)
- Má přístup k env vars a working directory (vidí soubory co agent vytvořil)

### jq checkpoint
- Conversation events (JSON array) přijdou na **stdin** do `jq -e`
- Výraz musí vrátit truthy hodnotu (exit 0 = pass, exit 1 = fail)
- stdout = evidence, stderr = error info
- Timeout: 30s (`JQ_TIMEOUT_MS`)
- Podporuje `warn-jq:` prefix pro warning severity
- Events mají strukturu: `[{type: "assistant", message: {content: [{type: "tool_use", name: "Bash", input: {command: "..."}}]}}]`

**Běžné vzory:**
```
# Agent použil konkrétní tool
jq: [.[] | select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and .name=="Bash")] | length > 0

# Agent zavolal apify actors call NEBO apify call (OR logika přes regex)
jq: [.[] | select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and .name=="Bash") | .input.command? // "" | select(test("apify (actors )?call"))] | length > 0

# Agent NEPOUŽIL zakázané tools
jq: [.[] | select(.type=="assistant") | .message.content[]? | select(.type=="tool_use") | .name | select(test("^Web(Search|Fetch)$"))] | length == 0

# Kontrola konkrétního parametru v tool callu
jq: [.[] | select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and .name=="Bash") | .input.command? // "" | select(test("--user-agent"))] | length > 0
```

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

### Plugin auto-detection

Runner automaticky detekuje Claude Code pluginy v workspace. Pokud init script (nebo custom bash) umístí `.claude-plugin/plugin.json` do workspace root, runner přidá `--plugin-dir <workspace>` k CLI příkazu. Tím se plugin (skills, hooks, commands) automaticky nahraje agentovi.

Typický init script pro plugin eval:
```bash
git clone --depth 1 https://github.com/user/my-plugin.git _plugin
cp -r _plugin/.claude-plugin .claude-plugin
cp -r _plugin/skills skills
rm -rf _plugin
```

Nic dalšího v inputu není potřeba — `pluginDirs` se nespecifikuje, detekce je automatická.

**Důležité:** `CLAUDE_CODE_OAUTH_TOKEN` vyžaduje `CLAUDE_CODE=0` v `envVariables` a nesmí být nastaven `ANTHROPIC_API_KEY` (ani prázdný string — přebíjí OAuth).

## LLM Judge

Jediný backend: CLI judge (`shared/src/agents/claude.ts`).

### CLI judge
- `claude -p --output-format stream-json --verbose --include-partial-messages --json-schema` subprocess
- Default model: `claude-sonnet-4-6` (konstanta `JUDGE_MODEL` v `constants.ts`)
- Per-judge model override přes `### Judge (model)` syntax (`haiku`/`sonnet`/`opus` alias nebo plné model ID)
- NDJSON readline-based parsing (stejný pattern jako agent)
- `structured_output` extrahován z `result` eventu: `{verdict: "pass"|"fail"|"unclear", reasoning: "string"}`
- `stream_event` eventy dostupné přes `onRawLine` callback pro real-time monitoring
- Žádný API klíč potřeba (OAuth/subscription stačí)

### Více judge bloků
- Checkpoint může mít N `### Judge` bloků — každý = samostatný LLM call → samostatný verdict
- `### warn-Judge` = warning severity (fail verdikt se mapuje na warning, ne fail)
- Agregace: jakýkoliv judge s fail severity a verdict=fail → celý checkpoint fail

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

Deploy z monorepo rootu (ne z `actors/runner` — `dockerContextDir` by ukazoval mimo upload):
```bash
touch actors/runner/.actor/actor.json   # aktualizovat mtime, jinak CLI hlásí "modified there since modified locally"
apify push --dir .
```
Pozn: `touch` je potřeba protože každý push aktualizuje `modifiedAt` na platformě, ale lokální mtime zůstává starší. Bez toho vyžaduje `--force`.

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
