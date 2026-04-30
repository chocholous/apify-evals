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
Real-time tracking, kill při překročení limitu, výsledek s `aborted: true`.

---

## Technický stack

| Rozhodnutí | Volba |
|------------|-------|
| Runtime | Standalone Dockerfile (Node 24 + CLI tools) |
| Jazyk | TypeScript (`ts-empty` template) |
| Repo struktura | Monorepo s npm workspaces |
| Závislosti | `apify`, `gray-matter`, `@anthropic-ai/sdk` |
| Agent execution | `child_process.spawn()` + `readline` (NDJSON streaming) |
| Judge | Dual: deterministic (contains/regex/json-schema) + LLM (Anthropic tool_use) |
| Init scripts | Předdefinované presets (dropdown) + custom textarea |
| Storage | KV store (JSONL conversation log) + Dataset (structured results) |
| Metriky | Structured JSON logs. Eval framework (promptfoo) ve Fázi 4. |

### Agent CLI adaptery

| Agent | Command | Output | Fáze |
|-------|---------|--------|------|
| Claude Code | `claude -p "prompt" --output-format stream-json` | NDJSON | F1 |
| Codex CLI | `codex exec "prompt" --json` | JSONL | F2 |
| OpenCode | `opencode -p "prompt" -f json` | JSON | F2 |

### Custom metriky (postupně)

1. Předdefinované typy (contains, regex, json-schema, llm-judge) — Fáze 1
2. Custom v YAML frontmatter scénáře — Fáze 2
3. Custom JS/TS scorer funkce — Fáze 4

---

## Spike testy (Fáze 1)

| # | Spike | Priorita | Blokuje |
|---|-------|----------|---------|
| S1 | Claude Code subprocess streaming (NDJSON parsing) | KRITICKÝ | Celý Runner |
| S2 | Claude CLI v Apify Dockerfile (build + run na cloudu) | KRITICKÝ | Cloud deployment |
| S3 | Custom LLM judge (Anthropic tool_use structured verdict) | KRITICKÝ | Checkpoint validaci |
| S4 | Scenario Markdown parser (gray-matter + custom) | STŘEDNÍ | Scenario loading |
| S5 | Env var injection + masking v logu | STŘEDNÍ | US6 |
| S6 | Token budget abort (real-time tracking + kill) | STŘEDNÍ | US7 |

---

## Implementační plán

### Fáze 1: MVP — Runner + Claude Code
**US1, US5, US6, US7**

1. **F1.0: Projekt setup** — monorepo, `actors/runner/`, `shared/`, CLAUDE.md, AGENTS.md, ESLint, Prettier
2. **F1.1: Spike testy** — S1-S6, dokumentovat výsledky, upravit plán
3. **F1.2: Shared library** — types, scenario-parser, claude adapter, judge, metrics, log-masker, unit testy
4. **F1.3: Runner Actor** — input/output/dataset schema, Dockerfile, main loop, streaming tracking, env var handling, KV + dataset storage, graceful abort
5. **F1.4: Init script presets** — mcp_native, cli_native, mcpc + custom textarea

### Fáze 2: Multi-agent — Codex + OpenCode
**US1 rozšíření**

- Codex CLI adapter, OpenCode adapter, Dockerfile update, agent-specific token counting

### Fáze 3: Orchestrator Actor
**US2, US3, US4**

- Input schema (agents[], scenarios[], presets[], N, baselineDatasetId)
- `Actor.start()` pro paralelní Runner instance
- Agregace mean±stddev, regression detection

### Fáze 4: Advanced eval
- Promptfoo (nebo alternativa) integrace — vyžaduje hlubší research
- Custom metriky v YAML + JS/TS scorer funkce
- Tool call tracking, trajectory assertions, cache hit rate

### Fáze 5: Scénáře, dokumentace, CI/CD
- Vzorové scénáře, README pro Store, GitHub Actions, E2E testy

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
- [ ] Auth pro Claude Code v Dockerfile (`ANTHROPIC_API_KEY` vs `claude setup-token`)
