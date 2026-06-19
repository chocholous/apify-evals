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

**Judge severity (3 úrovně):**
- `### Judge` — default model (sonnet), **fail** severity, schema `{verdict: pass|fail|unclear, reasoning, eval_critique?}`
- `### warn-Judge` — **warn** severity (fail verdikt = warning, neblokuje overall)
- `### eval-Judge` — **eval** severity, jiné schéma (`{eval_gap_severity: critical|noncritical|ok, reasoning}`). Vrací `checkType: 'eval-review'`, **je vyloučen z `computeOverall`** (`judge.ts:480`) — hodnotí kvalitu eval frameworku, ne agenta. Pro autora scénáře = "judge řekne, jestli mé checky vůbec měří správnou věc".

**Model override:** `### Judge (opus)`, `### warn-Judge (haiku)`, `### eval-Judge (opus)` — alias z `JUDGE_MODEL_MAP` nebo plné model ID.

**`warn-` prefix funguje i na všech deterministic check typech** (`judge.ts:113-115`), ne jen na Judge: `warn-contains:`, `warn-regex:`, `warn-json-schema:`, `warn-script:`, `warn-jq:`. Fail verdikt se mapuje na 4. verdict `warning` (`types.ts:25`), který v agregaci neblokuje overall pass.

**Judge JSON schema:** `{verdict: "pass"|"fail"|"unclear", reasoning: "string"}`

### Typy kontrol (`CheckType` v `types.ts:29`)

| `checkType` | Z jakého syntaxu vznikne | Co dělá |
|-------------|--------------------------|---------|
| `contains` | `contains:` / `warn-contains:` | Case-insensitive substring match nad agent output stringem |
| `regex` | `regex:` / `warn-regex:` | Case-insensitive regex test nad agent output stringem |
| `json-schema` | `json-schema:` / `warn-json-schema:` | Ajv validace JSON output (extrahovaný z code blocku) proti schématu |
| `script` | `script:` / `warn-script:` nebo `### Script` | Bash script, agent output na **stdin**, exit 0 = pass, stdout = evidence |
| `jq` | `jq:` / `warn-jq:` | `jq -e` výraz nad conversation events (JSON array) na stdin, exit 0 = pass |
| `llm-judge` | `### Judge` / `### warn-Judge` (+ plain text dole pod prefix řádky) | Full Claude judge agent s tool accessem, schema `{verdict, reasoning, eval_critique?}` |
| `eval-review` | `### eval-Judge` | Full Claude agent, jiné schema `{eval_gap_severity, reasoning}`, **vyloučen z `computeOverall`** |
| `error` | runner sám (ne autor scénáře) | `platform_failure` verdict z `detectPlatformFailures` (Apify memory limit kill) |

### Script checkpoint
- Agent output přijde na **stdin**
- Exit code 0 = pass, nenulový = fail
- stdout = evidence (max 1000 znaků)
- Timeout: 30s (konfigurovatelný přes `scriptTimeoutMs`)
- Má přístup k env vars a working directory (vidí soubory co agent vytvořil)

### Workspace konvence
- Working directory pro agenta i script checkpointy: `/tmp/eval-workspace-<uuid8>/` (`main.ts:188`). Workspace obsahuje POUZE to, co tam zapíše agent + případně stažené Apify datasety (`eval-datasets/<id>.json`).
- Runner ukládá své interní bookkeeping soubory (`trajectory.json`, `checkpoint.json`, `check-results.json`) do SIBLING dir `/tmp/eval-meta-<uuid8>/` — NIKDY do workspace. Důvody: (a) `apify push` bundluje jen obsah workspace, takže runner soubory nemohou leakovat do deployed Actoru; (b) workspace zůstává čistý pro měření (např. zda agent sám vytvořil `.actorignore`) — žádné framework artefakty se nemísí s agentovými.
- Checkpoint subprocessy (script + jq checks) dostanou cestu k meta dir přes `$EVAL_META_DIR` env var, kterou runner injektuje **jen do checkpoint subprocessu**, ne do agentova. Agent meta dir nevidí ani v env ani ve workspace — runner je pro něj neviditelný.
- Každý retry dostane fresh workspace + fresh meta dir (oba sdílí UUID).
- Scénáře typu `security-isolation.md` testují, že agent nemůže psát mimo workspace (runner files vlastní root)

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
    agentOutputLength: number;  // outputText.length (rychlý filtr v Apify Console)
    monitorOutput: string | null;
    verdicts: CheckVerdict[];   // per-check results
    overallVerdict: VerdictValue; // 'pass' only if ALL agent-verdicts pass; eval-review je vyloučen
    metrics: RunMetrics;        // tokens, cost, duration
    efficiency: EfficiencyMetrics; // derived ratios
    trajectory: TrajectoryMetrics; // tool calls, files, commands
    judge: JudgeMetrics;        // per-run judge cost/latency/turns
    retryAttempts: number;      // typicky 0 (retry je experimental, viz README)
    stopReason: string;         // 'end_turn' | 'budget_exceeded' | 'error' | ...
    exitCode: number | null;
    aborted: boolean;
    abortReason: string | null;
    error: string | null;
    hungWarnings: HungWarning[]; // periody, kdy byl agent dlouho zticha
}

interface CheckVerdict {
    checkType: CheckType;       // 'contains' | 'regex' | 'json-schema' | 'script' | 'jq' | 'llm-judge' | 'eval-review' | 'error'
    checkValue: string;
    verdict: VerdictValue;      // 'pass' | 'fail' | 'warning' | 'unclear' | 'platform_failure'
    evidence: string;
    evalCritique?: string;      // jen na llm-judge: judge kritizuje slabost eval kritéria
    evalGapSeverity?: EvalGapSeverity;  // jen na eval-review (### eval-Judge): 'critical' | 'noncritical' | 'ok'
}
```

> Pozn.: `confidence` field byl odstraněn (commit `60b6271` "Multi-judge blocks, jq checks, remove discoverability residuals" a okolí). Pokud někde v docs ještě je, je to zastaralé.

### RunMetrics
```typescript
{ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
  totalCostUsd, durationMs, durationApiMs, numTurns, modelUsage }
```

### EfficiencyMetrics (Tier 1 — derivované)
```typescript
{ totalContextTokens, tokensPerTurn, costPerTurn, cacheHitRate, contextOutputRatio, apiDurationRatio, avgTurnDurationMs,
  toolExecutionMs, planningTurns, executionTurns }
```
- `totalContextTokens` = inputTokens + cacheReadTokens + cacheCreationTokens (reálný kontext poslaný modelu)
- `cacheHitRate` = cacheRead / totalContext (0-1, ne per-turn sum)
- `contextOutputRatio` = totalContext / output (kolik agent čte vs generuje)
- `apiDurationRatio` > 1 je normální (Claude CLI sčítá paralelní API calls)
- `toolExecutionMs` = durationMs − durationApiMs (čas strávený v tools, ne v LLM)
- `planningTurns` = počet turnů jen s textovým výstupem (žádný tool call)
- `executionTurns` = počet turnů s ≥1 tool callem

### TrajectoryMetrics (Tier 1+2 — z event streamu)
```typescript
{ toolCallCount, toolCallSequence, uniqueToolsUsed, toolCallsPerTurn,
  perTurnTokens, perTurnToolCalls,
  toolCallDetails,        // Array<{tool, turn, input}>, truncated parametry — pro parameter correctness analýzy
  errorRecoveryCount,
  filesCreated, filesModified, commandsExecuted, mcpToolsUsed }
```

### JudgeMetrics
```typescript
{ judgeCostUsd, judgeLatencyMs, judgeTurns }
```
- `judgeCostUsd` je **vždy 0** (`main.ts:301` hardcoded) — CLI judge je `claude -p` subprocess a nereportuje token cost zpět. Pro odhad ceny použij `judgeLatencyMs` × tarif modelu z `judge.judgeTurns` calls.
- `judgeLatencyMs` = wall-clock čas strávený ve všech LLM judge callech pro daný run
- `judgeTurns` = počet `llm-judge` verdicts v `verdicts[]` (= počet `### Judge`/`### warn-Judge`/`### eval-Judge` bloků v checkpointu)

### HungWarning
```typescript
{ elapsedMs, silenceSecs }
```
- `elapsedMs` — kolik ms uplynulo od startu agenta, když se detekovalo dlouhé ticho
- `silenceSecs` — jak dlouho byl agent zticha
- Slouží k diagnostice zaseknutých runů (commit `c3c263e`)

## Init presets (`shared/src/init-presets.ts`)

Presets konfigurují **prostředí agenta** (ne vyhodnocení):
**`*_native` presety (signal-only — surface dostupný, ostatní NEJSOU omezeny):**
- `mcp_native` — zapíše MCP config JSON do `.eval-config/mcp-config.json`, předá `--mcp-config` + `--strict-mcp-config`
- `cli_native` — ověří dostupnost CLI nástrojů (gh, apify-cli)
- `mcpc` — zkontroluje mcpc, volitelně zapíše MCP config
- `api_native` — ověří `curl`/`jq` pro raw HTTPS volání proti `api.apify.com`

**`*_only` presety (vynucená exkluzivita pomocí PATH shim + MCP gating + trajectory hard-reject):**
- `mcp_only` — agent může používat POUZE MCP. `apify`/`curl`/`wget` shimnuté na PATH; built-in `WebFetch`/`WebSearch` zamítnuty v trajectory; vyžaduje `mcpConfigJson` (jinak agent nemá žádnou surface a selže záměrně).
- `cli_only` — agent může používat POUZE apify-cli. `curl`/`wget` shimnuté; MCP config se nezapisuje (žádné MCP servery); `WebFetch`/`WebSearch` a jakékoli MCP volání zamítnuto.
- `api_only` — agent může používat POUZE REST API přes `curl` / built-in fetch. `apify` shimnuté; MCP config se nezapisuje; jakékoli volání apify-cli nebo MCP nástroje zamítnuto.

Enforcement běží ve třech vrstvách (defense in depth, viz `actors/runner/README.md`):
1. **PATH shim** — runner zapíše shim binárky do per-run adresáře v OS tmpdir (záměrně mimo zapisovatelný workspace agenta, aby ho nešlo `rm -rf`) a tuto cestu přidá na začátek PATH agentova subprocessu. Přímé volání disallowed nástroje vrátí exit 127.
2. **MCP config gating** — pro `cli_only`/`api_only` se `--mcp-config` agentu vůbec nepředá (žádné MCP servery se nenačtou).
3. **Trajectory hard-reject** — runner po doběhnutí agenta inspekuje znormalizovanou trajectory (`commandsExecuted`, `uniqueToolsUsed`, `mcpToolsUsed`) proti preset-specific rejection rules a přidá `preset-trajectory` verdicty. Agent-agnostic — funguje pro všechny podporované agenty, ne jen pro claude-code.

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

### CLI judge — full Claude agent s tool accessem
- `claude -p --output-format stream-json --verbose --include-partial-messages --json-schema --dangerously-skip-permissions --no-session-persistence` subprocess
- Default model: `claude-sonnet-4-6` (konstanta `JUDGE_MODEL` v `constants.ts`)
- Per-judge model override přes `### Judge (model)` syntax (`haiku`/`sonnet`/`opus` alias nebo plné model ID)
- **Judge má plný Claude toolset** — Read, Bash, Glob, atd. Není to text classifier; je to standardní Claude agent, který může sám browsovat workspace a verifikovat artefakty (commit `d0740f4` to drží jako klíčový důvod, proč máme CLI judge a ne SDK judge).
- Timeout: 5 min soft budget (`JUDGE_TIMEOUT_MS`), žádný max-turns limit (commit `e34297f`).
- Plná data v promptu, žádné truncation (commit `fa1a4e4`).
- NDJSON readline-based parsing (stejný pattern jako agent)
- `stream_event` eventy dostupné přes `onRawLine` callback pro real-time monitoring (+ teče do `LIVE-JUDGE-LOG` KV)
- Žádný API klíč potřeba (OAuth/subscription stačí)

### Co judge dostane v promptu

`judgeAllChecks` postaví `enrichedOutput` ze tří částí (`judge.ts:418-432`) a předá ho do prompt template (`claude.ts:63-72`):

```
You are an evaluation judge. You have a soft budget of 5 minutes for this evaluation.
Determine whether the agent's output satisfies the checkpoint criteria.

## Agent Output
{raw agent text — full, no truncation}

## Workspace (use Read/Bash to inspect)         ← jen pokud workDir má soubory
Working directory: /tmp/eval-workspace-xxx
Files:
- file1
- subdir/file2
- eval-datasets/<datasetId>.json
(Runner bookkeeping — trajectory.json / checkpoint.json / check-results.json — žije v sibling /tmp/eval-meta-<uuid>/. Checkpoint scripty k němu přistupují přes $EVAL_META_DIR; agent ho nevidí.)

## Agent Conversation Log (tool calls)           ← jen pokud máme events
\`\`\`
→ Bash({"command":"..."})
  "agent text"
→ Read({"file_path":"..."})
\`\`\`

## Checkpoint Criteria
{judge.prompt z ### Judge bloku}

Evaluate carefully. Return your verdict (pass/fail/unclear) with reasoning that references specific evidence from the output.
```

Workspace file listing je dynamický a rekurzivní (`listWorkspaceFiles`), s `SKIP_DIRS = {node_modules, .git, dist, storage}`. Conversation log (`formatConversationLog`) renderuje jen `assistant` eventy — `tool_use` jako `→ Name(jsonInput)`, text bloky jako `  "..."`.

### Judge schemas (dva)
- **Běžný Judge** (`VERDICT_SCHEMA`): `{verdict: "pass"|"fail"|"unclear", reasoning: string, eval_critique?: string}`
- **`### eval-Judge`** (`EVAL_REVIEW_SCHEMA`): `{eval_gap_severity: "critical"|"noncritical"|"ok", reasoning: string}` — hodnotí kvalitu **eval frameworku**, ne agent výstupu. Produkuje `checkType: 'eval-review'` a `evalGapSeverity` v `CheckVerdict`. **Je vyloučen z `computeOverall`** (`judge.ts:480`).

### Více judge bloků + tři severity
- Checkpoint může mít N `### Judge` / `### warn-Judge` / `### eval-Judge` bloků — každý = samostatný LLM call → samostatný verdict
- `fail` (default) — fail verdict shodí overall
- `warn` — fail verdict se mapuje na `warning`, neshodí overall
- `eval` — nikdy nešodí overall (meta-eval frameworku, není o agentovi)
- Agregace `computeOverall`: `platform_failure` > `fail` > `warning` > `unclear` > `pass` (eval-review se ignoruje)

Retry: max 2 pokusy s exponential delay (1s, 2s). Po vyčerpání → `unclear` (bez confidence).

### platform_failure verdict

Pátá hodnota `VerdictValue` (`types.ts:25`). Pokud runner detekuje v `tool_use_result` eventech Apify memory limit chybu (regex `/exceed the memory limit|memory limit.*exceeded|cannot allocate memory/i`, `judge.ts:357-372`), checkpoint dostane verdict `platform_failure` místo `fail`. V agregaci má přednost nad `fail` — odlišuje "agent selhal" vs. "platforma zabila proces". Pro autora scénáře = signál, že je potřeba zvýšit memory limit, ne fixovat agenta.

### Apify dataset auto-download

Pokud agent v eventech zmíní Apify `defaultDatasetId` (17-znakové ID), runner ho automaticky stáhne přes API do `<workdir>/eval-datasets/<id>.json`. Judge i script checkpointy ho pak vidí jako workspace soubor — můžeš nad ním pouštět `jq`, validovat schéma, nebo nechat LLM judge zkontrolovat obsah. Implementace: `shared/src/apify-datasets.ts`.

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
