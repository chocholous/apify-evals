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

## F1.3: Runner Actor — IN PROGRESS

### Co jsme udělali (F1.3a-d) — 2026-04-30
- Input schema (`input_schema.json`) — agent, model, scenario, systemPrompt, maxBudgetUsd, maxRetries, maxTurns, envVariables, initPreset, initBashScript, mcpConfigJson
- Main loop: parse scenario → per test: `runClaude()` → `judgeCheckpoint()` → `Actor.pushData()`
- Conversation log (masked) → KV store `CONVERSATION-LOG`
- Retry loop s `maxRetries` + `abortOnFailure` break

### Jak jsme ověřili
- `tsc` build: PASS
- E2E `apify run` se smoke-test.md:
  - Agent odpověděl (1 turn, $0.15, 2.2s)
  - Judge vyhodnotil checkpoint jako pass (confidence: 0.99)
  - Dataset obsahuje structured AgentResult s metrikami
  - KV store obsahuje CONVERSATION-LOG (JSONL)

### Commit
`8ca8528` F1.3a-d: Runner Actor — full pipeline, US1 complete

### Zjištěné problémy z E2E a stability testů

1. **`--bare` flag nefunguje** s `--dangerously-skip-permissions` — vrací `stop_sequence` error s 0 tokeny. Odstraněn, nahrazen default system promptem. **Workaround, ne fix — agent stále dědí uživatelský CLAUDE.md.**
2. **Default model je Opus ($0.15 za triviální otázku)** — v produkci defaultovat na levnější model nebo vyžadovat explicitní volbu.
3. **Judge events se nelogují** — conversation log obsahuje jen agent run events. Judge run by měl být logován zvlášť (např. `JUDGE-LOG` v KV store).
4. **Monitor sekce se neimplementuje** — scénář má `## Monitor`, ale runner ji ignoruje.
5. **Judge občas vrátí null** — stability test Run 3: `unclear` s confidence 0, "LLM judge returned no result". Chybí retry logika v judge, nebo fallback když judge subprocess selže.
6. **Checkpoint design chyby se projeví až v stability testu** — "CPU between 0 and 100" failuje na macOS multi-core (>100%). Stability test je cenný nástroj pro validaci scénářů.

### Co jsme udělali (F1.3e-g) — 2026-04-30
- E2E test suite (`test/e2e/run-e2e.ts`) — 5 testů, všechny PASS
- AI stability test (`test/e2e/run-ai-stability.ts`) — 3 runy, 83% pass rate (STABLE)
- Oprava `--bare` bug → default system prompt
- 5 testovacích scénářů v `scenarios/`

### Jak jsme ověřili
- E2E testy 5/5 PASS (cost: $0.53)
- AI stability 83% pass rate (cost: $0.45)
- us1-smoke: checkpoint pass, confidence 1.0
- us1-ai-judge: LLM judge na 2 netriviálních odpovědích, oba pass
- us5-multi-step: 2 kroky (Jupiter, Mercury), per-test breakdown
- us6-env-vars: secret v logu false, masked true
- us7-budget-abort: agent dokončil ale verdict fail

### Commit
`f32934a` F1.3e-g: E2E tests for all MVP user stories — 5/5 pass
`cc8d0bc` Add non-deterministic AI stability test

### Zbývající kroky

| Krok | Co | Ověření | Priorita | Status |
|------|----|---------|----|--------|
| F1.3a-d | Input + main loop + judge + output | E2E smoke-test | — | **DONE** |
| F1.3e-g | E2E testy US5/US6/US7 | 5/5 pass | — | **DONE** |
| F1.3h | Agent izolace (--bare nefunguje) | Agent nečte CLAUDE.md | HIGH | TODO — `--bare` bug, zatím workaround přes system prompt |
| F1.3i | Judge retry + error handling | Judge nikdy nevrátí null | HIGH | TODO — stability test odhalil selhání |
| F1.3j | Judge log do KV store | `JUDGE-LOG` key | MEDIUM | TODO |
| F1.3k | Default model konfigurace | Ne Opus jako default | MEDIUM | TODO |
| F1.3l | Monitor sekce | ## Monitor extraction | LOW | TODO (scope TBD) |

---

## User Stories tracker

| US | Popis | Status | Ověřeno v |
|----|-------|--------|-----------|
| US1 | Spustit eval s jedním agentem | **DONE** | E2E 5/5, AI stability 83% |
| US2 | Porovnat MCP vs CLI | Čeká na F3 | — |
| US3 | Multi-agent test | Čeká na F2+F3 | — |
| US4 | Regression detection | Čeká na F3 | — |
| US5 | Multi-step testy | **DONE** | E2E us5-multi-step PASS |
| US6 | Bezpečné env vars | **DONE** | E2E us6-env-vars PASS |
| US7 | Token budget abort | **DONE** | E2E us7-budget-abort PASS |
