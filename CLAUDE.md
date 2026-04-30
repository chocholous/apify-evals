@AGENTS.md

# Agent Evals

TypeScript monorepo se dvěma Apify Actory pro evaluaci AI agentů (Claude Code, Codex, OpenCode) napříč různými tool integration metodami (MCP, CLI, mcpc).

## Architektura

Monorepo s npm workspaces:
- `shared/` — sdílená knihovna (types, scenario-parser, agent adaptery, judge, metriky)
- `actors/runner/` — Actor #1: spustí jeden eval scénář s jedním agentem
- `actors/orchestrator/` — Actor #2: orchestruje více scénářů (Fáze 3)

## Konvence

- **Jazyk:** TypeScript, ES modules (`"type": "module"`)
- **Importy:** `.js` extension v relativních importech (ESM requirement)
- **Linting:** `@apify/eslint-config/ts.js` + Prettier (4 spaces, single quotes, 120 chars)
- **Testy:** Vitest
- **Build:** `tsc` → `dist/`

## Agent CLI execution

Agenti se spouštějí jako subprocess přes `child_process.spawn()`:

```
claude -p "prompt" --output-format stream-json --verbose --dangerously-skip-permissions --no-session-persistence
```

Povinné flagy:
- `--verbose` — vyžadováno pro stream-json output
- `--dangerously-skip-permissions` — eval agent musí mít plný přístup
- `--no-session-persistence` — izolované runs
- stdin musí být `'ignore'` (ne pipe)

## Event structure (claude stream-json)

Events jsou flat NDJSON (ne nested). Sekvence:
1. `system:init` — session info, tools, MCP servers
2. `assistant` — celá message (ne chunk-by-chunk), `message.content` + `message.usage`
3. `user` — tool results
4. `rate_limit_event`
5. `result:success` / `result:error` — finální metriky, `usage`, `modelUsage`, `structured_output`

Token usage je per-turn (ne per-token streaming).

## LLM Judge

Judge přes `claude -p --json-schema` (ne Anthropic SDK):
- Model: `claude-haiku-4-5-20251001`
- Vyžaduje `--max-turns 3` (interní tool call pro json-schema)
- Structured output v `result.structured_output` field
- Žádný API klíč potřeba (OAuth/subscription stačí)

## Monorepo deploy

Každý Actor má `dockerContextDir: "../.."` v `actor.json`, což umožňuje Dockerfile přistupovat k `shared/`.
Deploy: `apify push --dir actors/runner`

## Dokumentace

- `docs/01-plan.md` — implementační plán
- `docs/02-decisions.md` — architektonická rozhodnutí
- `docs/03-research.md` — research výsledky
- `spikes/` — feasibility testy (S1-S6)
