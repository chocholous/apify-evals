# Agent Evals — Plan

## Overview

TypeScript monorepo se dvěma Apify Actory pro evaluaci AI agentů napříč různými tool integration metodami (MCP, CLI, mcpc).

- **Actor #1: Agent Evals Runner** — spustí jeden testovací scénář s jedním AI agentem
- **Actor #2: Agent Evals Orchestrator** — orchestruje více scénářů přes více agentů (Fáze 3)

---

## Cíle

| # | Cíl | Definition of Done |
|---|-----|---------------------|
| C1 | Reproducibilní eval pipeline | Runner přijme Markdown scénář, spustí agenta, vrátí structured JSON s pass/fail/unclear pro každý checkpoint. Funguje pro ≥3 agenty. |
| C2 | Multi-agent porovnání | Orchestrator agreguje výsledky do porovnávací tabulky s mean±stddev. |
| C3 | MCP vs CLI vs hybrid benchmarking | ≥3 init script presets. Side-by-side run ukáže metrické rozdíly. |
| C4 | Regression detection | Orchestrator porovná nové výsledky s baseline a flaguje regresi. |
| C5 | LLM-as-judge validace | Structured verdict (pass/fail/unclear) s evidence a confidence score. |

---

## User Stories

### US1: Vývojář spustí jednoduchý eval
Nahraju Markdown scénář, vyberu agenta (Claude Code / Codex / OpenCode), volitelně nastavím model, max tokens, env vars. V datasetu vidím pass/fail per checkpoint, token count, cost, duration. V KV store najdu plný conversation log.

### US2: Vývojář porovná MCP vs CLI
Orchestrator přijme scénář + presets (mcp_native, cli_native, mcpc), spustí Runner paralelně, vrátí porovnávací tabulku.

### US3: Vývojář testuje více agentů
Orchestrator přijme scénář + agenty + opakování N, vrátí matici agent × metrika s mean±stddev.

### US4: Vývojář detekuje regresi
Orchestrator přijme baseline dataset ID, porovná, flaguje zhoršení o >X%.

### US5: Multi-step testy
Markdown s `---` separátory, `## Test` / `## Checkpoint` / `## Monitor`. `abortOnFailure: true` zastaví po prvním failu.

### US6: Bezpečné env vars
Secure input, dostupné v init scriptu, po použití smazané, v logu maskovány.

### US7: Token budget a abort
Budget control přes `--max-budget-usd` (nativní) + mezi-turnový SIGTERM jako fallback. Výsledek s `aborted: true`.

### US8: Tool Discoverability Scoring
Scénář deklaruje expected tools (`expectedTools` ve frontmatter). Runner porovná s trajectory a vrátí discoverability metriky — které tools agent našel/nenašel, extra/forbidden tools, skóre. Měří schopnost agenta objevit správné nástroje.

### US9: Tool Parameter Correctness
Scénář deklaruje expected tool parametry (`## Expected Tools` sekce). Runner zachytí tool call inputs a vyhodnotí shodu — měří kvalitu dokumentace tools (agent je našel, ale volal správně?).

### US10: Actor Spec Validation
Agent vytvoří Apify Actor dle specifikace. Checkpoint ověří: soubory existují, input schema odpovídá, Actor se buildí a produkuje output, output matchuje expected strukturu. Měří end-to-end kvalitu vygenerovaného kódu.

### US11: Custom Agent Configuration per Scenario
Scénář specifikuje `language`, `template`, `actorSpec` ve frontmatter. Runner inject do system promptu a init scriptu. Agent pracuje v kontextu předkonfigurovaného prostředí.

---

## Technický stack

| Rozhodnutí | Volba |
|------------|-------|
| Runtime | Standalone Dockerfile (Node 24 + CLI tools) |
| Jazyk | TypeScript (`ts-empty` template) |
| Repo struktura | Monorepo s npm workspaces |
| Závislosti | `apify`, `gray-matter` (vše ostatní built-in Node.js) |
| Agent execution | `child_process.spawn()` + `readline` (NDJSON streaming) |
| Judge | Dual: deterministic (contains/regex/json-schema) + LLM (`claude -p --json-schema`) |
| Init scripts | Předdefinované presets (dropdown) + custom textarea |
| Storage | KV store (JSONL conversation log) + Dataset (structured results) |
| Metriky | Structured JSON logs. Eval framework (promptfoo) ve Fázi 4. |

### Agent CLI adaptery

| Agent | Command | Output | Fáze |
|-------|---------|--------|------|
| Claude Code | `claude -p "prompt" --output-format stream-json --verbose --dangerously-skip-permissions --no-session-persistence` | NDJSON (flat events) | F1 |
| Codex CLI | `codex exec "prompt" --json --full-auto` | JSONL | F2 |
| OpenCode | `opencode -p "prompt" -f json` | JSON | F2 |

### Custom metriky (postupně)

1. Předdefinované typy (contains, regex, json-schema, llm-judge) — Fáze 1
2. Custom v YAML frontmatter scénáře — Fáze 2
3. Custom JS/TS scorer funkce — Fáze 4

---

## Spike testy — výsledky

Všechny spiky proběhly úspěšně. Kód v `spikes/`.

| # | Spike | Status | Klíčové zjištění |
|---|-------|--------|-----------------|
| S1 | Claude subprocess streaming | **PASS** | `--verbose` povinný. Event structure flat (ne nested). `modelUsage` per model. stdin musí být `ignore`. |
| S2 | Claude CLI v Apify Dockerfile | **Přeskočen** | Triviální — ai-sandbox pattern ověřený, `curl install` funguje. |
| S3 | LLM judge via CLI | **PASS** | `claude -p --json-schema` funguje (žádný API klíč potřeba). Output v `structured_output` field. Vyžaduje `--max-turns 3`. |
| S4 | Scenario Markdown parser | **PASS** | gray-matter + regex parser funguje. 1-3 testy, optional monitor, YAML frontmatter. |
| S5 | Env var injection + masking | **PASS** | `spawn` env injection funguje. `replaceAll` masking spolehlivý. Potřeba `--dangerously-skip-permissions`. |
| S6 | Token budget abort | **PASS** | `--max-budget-usd` nativní control funguje. SIGTERM between-turn funguje. Usage per-turn, ne per-token. |

---

## Implementační plán

### ~~Fáze 1: MVP — Runner + Claude Code~~ ✅ HOTOVO
**US1, US5, US6, US7**

1. ~~**F1.0: Projekt setup**~~ ✅
2. ~~**F1.1: Spike testy**~~ ✅
3. ~~**F1.2: Shared library**~~ ✅ — types, scenario-parser, agent adaptery (Claude/Codex/OpenCode), judge (5 checkpoint typů), metrics, log-masker
4. ~~**F1.3: Runner Actor**~~ ✅ — input/output/dataset schema, Dockerfile (fat image), main loop, streaming, env vars, KV + dataset, graceful abort
5. ~~**F1.4: Init script presets**~~ ✅ — mcp_native, cli_native, mcpc + custom textarea

### ~~Fáze 2: Multi-agent + Tool Discovery~~ ✅ HOTOVO
**US1 rozšíření, US8, US9**

- ~~Codex CLI adapter, OpenCode adapter~~ ✅ — registry + per-agent parsery (pipeline ověřen, credentials TBD)
- ~~Token metriky opraveny~~ ✅ — cacheHitRate (0-1), perTurnTokens deduplikace, totalContextTokens
- ~~expectedTools + discoverability scoring~~ ✅
- ~~toolCallDetails~~ ✅ — tool call inputs (truncated) v trajectory
- ~~## Expected Tools sekce~~ ✅
- ~~Graceful abort~~ ✅

### ~~Fáze 2.5: Actor Development Evals~~ ✅ HOTOVO
**US10, US11**

- ~~`actorSpec`, `language`, `template` v scenario frontmatter~~ ✅ — parser + system prompt injection
- Init script: scaffold Actor z template — řešitelné přes `initBashScript`
- ~~Script checkpointy pro Actor validation~~ ✅ — `apify run` + output check v script checkpoint
- ~~LLM judge pro fuzzy schema comparison~~ ✅ — přes `### Judge` subsekci
- ~~Vzorový scénář: CheerioCrawler scraper~~ ✅ — `scenarios/actor-dev/cheerio-scraper.md`

### Fáze 3: Orchestrator Actor
**US2, US3, US4**

- Input schema (agents[], scenarios[], presets[], N, baselineDatasetId)
- `Actor.start()` pro paralelní Runner instance
- Agregace mean±stddev, regression detection
- Porovnání discoverability score across agents/presets

### Fáze 4: Advanced eval
- Promptfoo (nebo alternativa) integrace — vyžaduje hlubší research
- Custom metriky v YAML + JS/TS scorer funkce
- OTel export (optional, pro vizualizaci v Langfuse/Phoenix)
- Per-tool-call latency tracking

### Fáze 5: Scénáře, dokumentace, CI/CD
- Vzorové scénáře (Actor dev, MCP discovery, CLI proficiency)
- README pro Store, GitHub Actions, E2E testy
- Benchmark suite: 10+ scénářů pro Actor development across templates

---

## Monorepo struktura

```
apify-evals/
├── package.json                    # root, workspaces config
├── tsconfig.base.json
├── shared/
│   ├── package.json
│   └── src/
│       ├── types.ts
│       ├── scenario-parser.ts
│       ├── judge.ts
│       ├── metrics.ts
│       ├── log-masker.ts
│       └── agents/
│           ├── claude.ts
│           ├── codex.ts            # Fáze 2
│           └── opencode.ts         # Fáze 2
├── actors/
│   ├── runner/
│   │   ├── .actor/
│   │   │   ├── actor.json          # dockerContextDir: "../.."
│   │   │   ├── input_schema.json
│   │   │   └── output_schema.json
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   └── src/main.ts
│   └── orchestrator/               # Fáze 3
│       ├── .actor/
│       ├── Dockerfile
│       ├── package.json
│       └── src/main.ts
├── scenarios/                      # vzorové scénáře
├── docs/
├── CLAUDE.md
└── AGENTS.md
```

---

## Otevřené otázky

- [ ] Org name na Apify Store (`agentify/agent-evals-runner`?)
- [ ] Codex CLI API klíč pro Fázi 2
- [ ] Apify platform credits budget
- [ ] GitHub repo přístup pro cílový org
- [ ] Standby mode (Fáze 5?)
- [x] ~~Auth pro Claude Code v Dockerfile~~ — OAuth token nebo subscription stačí, žádný API klíč potřeba (ověřeno S1, S3, S5)
