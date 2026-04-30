# Agent Evals — Deep Research

Výsledky researche, které formovaly architektonická rozhodnutí.

---

## 1. gbrain-evals (garrytan/gbrain-evals)

Evaluační framework pro personal knowledge agent stacks (RAG, knowledge graph, hybrid retrieval).

### Klíčové patterny

- **Adapter interface** pro pluggable system-under-test: `init(pages, config) -> BrainState`, `query(q, state) -> RankedDoc[]`. Jakýkoli stack implementující interface dostane skóre.
- **Sealed gold data boundary**: Adaptery dostávají `PublicPage` (sanitized, bez `_facts`). Scorery operují na goldu separátně. Anti-gaming.
- **LLM-as-judge** přes Claude Haiku tool_use: Dostává pre-digested `JudgeEvidence` (nikdy raw tool output), skóruje per-criterion 0-5, produkuje structured verdikty.
- **Flight recorder**: 6 artefaktů per run — transcript, brain export, entity graph, citations, scorecard JSON, judge notes.
- **Tiered runs**: N=1 smoke, N=5 iteration, N=10 published baseline.
- **12 "Cat" kategorií**: retrieval, identity resolution, temporal queries, source attribution, adversarial robustness, MCP contract compliance, latency, atd.
- **JSON Schema contracts** pro scorecard, evidence, transcript, probes, corpus manifest.
- **Master runner** s `p-limit(2)` subprocess isolation per Cat.

### Co jsme převzali
- Adapter interface → naše Agent CLI adaptery
- LLM judge s tool_use → náš custom judge
- Flight recorder → JSONL log + structured results
- Tiered runs → jednoduché opakování (N)

---

## 2. meta-engine/mcp-server benchmark

Měří, zda batched MCP code generation je levnější/rychlejší než file-by-file Write-tool loops.

### Klíčové patterny

- **`claude -p` jako subprocess** s `--output-format stream-json` — hlavní execution pattern
- **`--strict-mcp-config`** pro kontrolu MCP dostupnosti per arm — izoluje MCP under test
- **Grid**: 3 jazyky × 2 modely × 2 spec shapes × 3 invocation arms, N=5 per cell
- **Orchestrator**: `run.sh` bash script, `PARALLEL=N` concurrent runs
- **Authoritative metrics** z claude CLI `result` event (ne manuální parsování)
- **Structural judge** (`judge.py`): kontroluje každou spec entitu (file exists, correct declaration shape, compile gate)
- **Deterministic spec generation** (`generate-spec.py`) pro reprodukovatelnost
- **Aggregator** (`aggregate.py`): `summary.md` s tabulkami mean±stdev per metrika

### Co jsme převzali
- `claude -p --output-format stream-json` jako subprocess → hlavní execution pattern
- `--strict-mcp-config` → klíčové pro MCP vs CLI benchmarking
- Authoritative metrics z result event → token counting
- Structural judge → deterministická část našeho dual judge

---

## 3. AXI (axi.md) — Agent eXperience Interface

Řeší neefektivitu interakce AI agentů s externími nástroji. 10 design principů ve 3 kategoriích (Efficiency, Robustness, Discoverability).

### Klíčové metriky

- **Task success** — binary pass/fail via LLM judge
- **Cost (USD)** — z token counts
- **Duration (seconds)** — wall-clock
- **Turns** — počet tool invocations

### Klíčová zjištění

- **MCP schema inflation**: tool schemas spotřebují 185K tokenů per task vs. 79K pro AXI
- **12x cost rozdíl** na komplexních úlohách: AXI $0.065 vs. MCP $0.758 (CI failure investigation)
- **Browser benchmark**: 490 runs, 14 tasks, 7 conditions
- **GitHub benchmark**: 425 runs, 17 tasks, 5 conditions
- **TOON format**: Token-Optimized Object Notation — ~40% token savings vs JSON

### Co jsme převzali
- 4 core metriky (success, cost, duration, turns) → naše baseline metriky
- MCP schema inflation jako měřitelný problém → motivace pro projekt

---

## 4. mcp-eval.ai

Testovací framework pro MCP servery. "Flight simulator for MCP servers and agents."

### Přístupy
- Decorator-based tasks
- pytest-style assertions
- Dataset-driven evaluations

### Klíčové features
- **Expect API**: structural checks, tool invocation verification, performance validators, LLM-based judges
- **OpenTelemetry-backed observability**: JSON/HTML reports, regression detection
- **CI/CD integration**: GitHub Actions support
- **Language-agnostic**: testuje MCP protocol, ne implementaci

### Co jsme převzali
- LLM-as-judge s Expect API → inspirace pro assertion types
- CI/CD regression detection → Fáze 3 (Orchestrator)

---

## 5. MCP Discussion #1780 — Code Execution with MCP

### Klíčový insight
Agenti **píší kód** který volá MCP tools místo přímého volání tools. Data teče mezi tools v execution environment bez re-vstupu do model context window (98.7% token savings).

### Patterny
- **Filesystem-based tool discovery**: agents navigují `./servers/<name>/<tool>.ts` on demand
- **Two-channel data**: `structuredContent` pro program, `content` pro LLM
- **Privacy preservation**: sensitive data tokenized v execution environment

---

## 6. apify/actor-ai-sandbox — Monorepo deep dive

### Architektura
- 4 actors v 1 repo: `sandbox/` (fat), `claude-code/`, `opencode/`, `openclaw/` (thin metamorph wrappers)
- **Žádné npm workspaces**, žádný sdílený kód — thin actors jsou zcela nezávislé
- **Žádné CI/CD** (`.github/` absent)

### Sandbox runtime (~1800 LOC)
- **Express 5** HTTP server s WebSocket support
- **8 source souborů**: main.ts, operations.ts, mcp.ts, environment.ts, persistence.ts, proxy-config.ts, consts.ts, types.ts
- **Předinstalované CLI**: Claude Code, OpenCode, apify-cli, mcpc, tsx
- **MCP server** na `/mcp` endpoint (StreamableHTTP, stateless — nový server per request)
- **Filesystem API**: `GET/PUT/POST/DELETE /fs/*` s 500MB limit
- **Exec endpoint**: `POST /exec` — `child_process.exec()` (buffered, 1MB maxBuffer default)

### Dockerfile pattern
```dockerfile
# Multi-stage: builder → runtime
FROM node:24-trixie-slim AS builder
# ... build TypeScript ...

FROM node:24-trixie-slim AS runtime
RUN apt-get update && apt-get install -y python3 python3-venv python3-pip git curl wget jq
RUN curl -fsSL https://claude.ai/install.sh | bash
RUN curl -fsSL https://opencode.ai/install | bash
RUN npm install -g apify-cli @apify/mcpc@beta tsx
```

### Metamorph pattern
```typescript
// claude-code/src/main.ts (~20 lines)
await Actor.init();
const sandboxActorName = process.env.SANDBOX_ACTOR_NAME;
const input = await Actor.getInput();
await Actor.metamorph(sandboxActorName, input);
```

### Persistence
- **Pouze intra-run migration** (platform moves container), NE cross-run
- Marker file + `find -newer` pro identifikaci změněných souborů
- Tarball do KV store, restore po resurrect

### Patterny k převzetí
- Dockerfile CLI instalace (curl install scripts)
- Health probe s inicializačním stavem
- Build-time version capture
- Path validation se symlink resolution (`fs.realpath()`)
- Activity-based idle timeout (`lastActivityAt`)

### Patterny k vyhnutí
- `exec()` pro code execution (buffered, shell injection risk) → použít `spawn()`/`execFile()`
- Nový MCP server per request (wasteful)
- Hardcoded path constants (`/sandbox`, porty)
- Žádné npm workspaces pro sdílený kód
- Žádné unit testy (jen e2e vyžadující live platform)

---

## 7. Promptfoo — TS eval framework

20K+ stars, MIT, nejsilnější framework pro agent evaluation v TypeScriptu.

### Agent trajectory assertions (unikátní)
- `trajectory:tool-used` — ověří že agent použil specifický tool
- `trajectory:tool-sequence` — ověří pořadí tool calls
- `trajectory:tool-args-match` — ověří argumenty tool calls
- `trajectory:step-count` — ověří počet kroků
- `trajectory:goal-success` — ověří splnění cíle
- `tool-call-f1` — F1 skóre pro tool selection

### Programmatic API
```typescript
import promptfoo from 'promptfoo';
const results = await promptfoo.evaluate({...});
```

### Built-in metriky
`context-faithfulness`, `context-recall`, `context-relevance`, `answer-relevance`, `factuality`, `llm-rubric`, `g-eval`, `similar`, `levenshtein`, `rouge-n`, `bleu`, `moderation`

### Rozhodnutí
Fáze 4 — vyžaduje hlubší research integrace s naším Runner loop.

---

## 8. Apify ekosystém — dostupné nástroje

### Oficiální skills (`apify/agent-skills` v2.0.0)
- `apify-actor-development` — kompletní vývoj od nuly + 8 referenčních docs
- `apify-actorization` — konverze existujícího kódu na Actor
- `apify-generate-output-schema` — generuje schémata z kódu
- `apify-ultimate-scraper` — univerzální scraper, ~100 Actorů
- `/create-actor` command — řízená 10-fázová tvorba

### CLI & SDK
- `apify-cli` v1.5.0 (nainstalováno)
- Apify SDK Node.js v3.7.3
- Crawlee v3.16.2
- `mcpc` v0.2.4 (nainstalováno)
- Apify MCP server (8 tools, aktivní)

### Templates
- 43+ šablon (JS/TS/Python + AI frameworks + MCP servery)
- AGENTS.md automaticky v každém template (~500 řádků)
- `apify create my-actor --template ts-empty`

### Docker base images
| Image | Obsah |
|-------|-------|
| `apify/actor-node:24` | Jen Node.js |
| `apify/actor-node-playwright-chrome:24` | Node + Playwright + Chromium |
| `apify/actor-python:3.14` | Python |

---

## 9. Agent CLI rozhraní

### Claude Code
- `claude -p "prompt"` — non-interactive mode
- `--output-format stream-json` — NDJSON streaming
- `--strict-mcp-config ./mcp.json` — izolace MCP
- `--max-turns N`, `--max-budget-usd N`
- `--system-prompt "..."`, `--system-prompt-file path`
- `--bare` — skip auto-discovery
- `--allowedTools tool1,tool2`
- Auth: `ANTHROPIC_API_KEY` env var

### Codex CLI (OpenAI)
- `codex exec "prompt"` — non-interactive
- `--json` — JSONL streaming events
- `--full-auto`, `--sandbox danger-full-access`
- Auth: `OPENAI_API_KEY` env var

### OpenCode
- `opencode -p "prompt"` — non-interactive
- `-f json` — JSON output
- `-q` — quiet mode (no spinner)
- Auth: provider config JSON nebo env vars
