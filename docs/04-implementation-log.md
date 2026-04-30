# Implementation Log

## F1.0: Projekt setup — 2026-04-30

### Co jsme udělali
- Monorepo s npm workspaces (`shared/`, `actors/runner/`, `actors/orchestrator/` placeholder)
- Scaffold Runner z `ts_empty` template
- `shared/` package: types, scenario-parser, index
- `Dockerfile.runner` — multi-stage build s Claude CLI (pattern z ai-sandbox)
- CLAUDE.md s konvencemi, CLI flagy, event structure
- AGENTS.md z Apify template
- ESLint, Prettier, editorconfig, tsconfig.base.json

### Jak jsme ověřili
- `tsc` build shared: PASS
- `tsc` build runner: PASS
- Unit testy scenario parser (5/5): PASS
- Shared import z runneru (runtime): PASS
- `apify run` lokálně s INPUT.json: PASS — parsuje scénář, loguje testy

### Commit
`4923866` F1.0: Monorepo setup with Runner actor and shared library
`3005002` F1.0 verification: unit tests, smoke scenario, apify run

---

## F1.1: Spike testy — 2026-04-30

### Co jsme udělali
6 spike testů ověřujících feasibilitu klíčových komponent.

### Výsledky

| Spike | Status | Zjištění |
|-------|--------|----------|
| S1: Claude subprocess streaming | PASS | `--verbose` povinný pro stream-json. Event structure flat (ne nested). `modelUsage` per model. stdin=`ignore`. |
| S2: Dockerfile na Apify Cloud | Přeskočen | ai-sandbox pattern ověřený, triviální. |
| S3: LLM judge via CLI | PASS | `claude -p --json-schema` funguje. Output v `structured_output`. `--max-turns 3`. Žádný API klíč potřeba. |
| S4: Scenario parser | PASS | gray-matter + regex. 1-3 testy, optional monitor, YAML frontmatter. |
| S5: Env var injection + masking | PASS | spawn env injection funguje. `replaceAll` masking spolehlivý. `--dangerously-skip-permissions` nutný. |
| S6: Token budget abort | PASS | `--max-budget-usd` nativní. SIGTERM between-turn funguje. Usage per-turn, ne per-token. |

### Dopady na plán
- Odstraněna závislost `@anthropic-ai/sdk` — judge jde přes CLI
- Přidány flagy: `--verbose`, `--dangerously-skip-permissions`, `--no-session-persistence`
- US7 přeformulována: budget přes `--max-budget-usd` + SIGTERM
- Auth vyřešen: OAuth token stačí, žádný API klíč
- Nová rozhodnutí D12-D14 v decisions.md

### Commit
`21d0fc7` Complete spike tests (S1-S6) and update plan with findings

---

## F1.2: Shared library — 2026-04-30

### Co jsme udělali
- `shared/src/agents/claude.ts` — `runClaude()` spawn + NDJSON streaming, `judgeLlm()` přes --json-schema
- `shared/src/judge.ts` — dual judge: deterministic (contains/regex/json-schema) + LLM fallback
- `shared/src/metrics.ts` — extractMetrics, extractToolCalls, formatCost, formatDuration
- `shared/src/log-masker.ts` — maskSecrets, maskEventsJsonl, stripEnvFromProcess
- `shared/src/index.ts` — všechny exporty
- vitest.config.ts — exclude dist/

### Jak jsme ověřili
- `tsc` build shared: PASS
- `tsc` build runner: PASS
- Unit testy (33/33): PASS
  - scenario-parser: 5
  - judge (deterministic): 13
  - metrics: 10
  - log-masker: 5

### Čeká na ověření
- `runClaude()` a `judgeLlm()` — E2E testy v F1.3 (vyžadují live claude CLI)

### Commit
`0556a56` F1.2: Shared library — claude adapter, judge, metrics, log-masker

---

## F1.3: Runner Actor — DALŠÍ

### Plán kroků

| Krok | Co | Ověření | Naplní US |
|------|----|---------|----|
| F1.3a | Input schema | `apify run` přijme input | — |
| F1.3b | Main loop: parse → run claude → collect | E2E: smoke-test.md → agent odpověď | — |
| F1.3c | Judge integration | E2E: verdict v datasetu | US1 partial |
| F1.3d | Dataset output + KV log | E2E: structured results + JSONL log | **US1 complete** |
| F1.3e | Env var injection + masking | E2E: secrets maskovány v KV | **US6** |
| F1.3f | Budget abort | E2E: nízký budget → aborted | **US7** |
| F1.3g | Multi-step + abortOnFailure | E2E: 2-step scénář | **US5** |

---

## User Stories tracker

| US | Popis | Status | Ověřeno v |
|----|-------|--------|-----------|
| US1 | Spustit eval s jedním agentem | Čeká na F1.3d | — |
| US2 | Porovnat MCP vs CLI | Čeká na F3 | — |
| US3 | Multi-agent test | Čeká na F2+F3 | — |
| US4 | Regression detection | Čeká na F3 | — |
| US5 | Multi-step testy | Čeká na F1.3g | — |
| US6 | Bezpečné env vars | Čeká na F1.3e | — |
| US7 | Token budget abort | Čeká na F1.3f | — |
