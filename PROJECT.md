# Agent Evals — Projektový dokument v2

## Context

Apify vyvíjí MCP server a CLI nástroje. Potřebujeme:
1. Měřit dopad změn v MCP serveru a CLI na výkon AI agentů
2. Ukončit debatu "MCP vs CLI" daty — ukázat, že jsou komplementární
3. Testovat Actor development s AI agenty (one-shot Actors)
4. Testovat Apify LLM chat

Dva Apify Actory v TypeScript monorepu:
- **Actor #1: Agent Evals Runner** — spustí jeden testovací scénář s jedním AI agentem
- **Actor #2: Agent Evals Orchestrator** — orchestruje více scénářů přes více agentů (Fáze 3)

---

## 1. Cíle

### C1: Reproducibilní eval pipeline
Spustit libovolný Markdown scénář s libovolným AI agentem (Claude Code, Codex, OpenCode) a dostat strukturované, porovnatelné výsledky.

### C2: Multi-agent porovnání
Porovnat výkon agentů na stejných scénářích side-by-side: success rate, cost, token count, latency, turn count.

### C3: MCP vs CLI vs hybrid benchmarking
Izolovat vliv MCP konfigurace (naive MCP, modern MCP, native CLI, mcpc) na výkon agenta pomocí `--strict-mcp-config` a init scriptů.

### C4: Regression detection
Při změně Apify MCP serveru nebo CLI automaticky detekovat regresi ve výkonu.

### C5: LLM-as-judge validace
Checkpoint-based validace výsledků — deterministická (structural checks) + LLM judge pro open-ended úlohy.

---

## 2. Jak poznáme, že jsme cílů dosáhli

| Cíl | Definition of Done |
|-----|---------------------|
| C1 | Runner Actor přijme Markdown scénář, spustí agenta, vrátí structured JSON s pass/fail/unclear pro každý checkpoint. Funguje pro ≥3 agenty (Claude, Codex, OpenCode). |
| C2 | Orchestrator spustí N runnerů paralelně, agreguje výsledky do porovnávací tabulky s mean±stddev pro každou metriku. |
| C3 | Existují ≥3 init script presets (mcp_native, cli_native, mcpc) a Runner je umí aplikovat. Side-by-side run na jednom scénáři ukáže metrické rozdíly. |
| C4 | Orchestrator Actor Task s uloženou konfigurací — spustitelný manuálně nebo přes webhook po deployi MCP serveru. Výsledky porovnatelné s baseline. |
| C5 | LLM judge vrací structured verdict (pass/fail/unclear) s evidence a confidence score. Deterministický judge (regex, JSON schema, compile check) funguje pro checkpointy bez LLM. |

---

## 3. User Stories

### US1: Vývojář spustí jednoduchý eval
**Jako** Apify vývojář
**chci** spustit eval scénář s jedním agentem přes Apify Console
**abych** ověřil, že můj MCP server funguje pro daný use case

**Acceptance criteria:**
- Nahraju Markdown soubor se scénářem (input schema file upload)
- Vyberu agenta (dropdown: Claude Code, Codex, OpenCode)
- Volitelně nastavím model, max tokens, env vars
- Po doběhnutí vidím v datasetu: pass/fail per checkpoint, token count, cost, duration
- V KV store najdu plný conversation log (JSONL)

### US2: Vývojář porovná MCP vs CLI
**Jako** Apify vývojář
**chci** spustit stejný scénář s různými MCP/CLI konfiguracemi
**abych** viděl, která integrace je efektivnější

**Acceptance criteria:**
- Orchestrator přijme scénář + seznam presetů (mcp_native, cli_native, mcpc)
- Spustí Runner pro každý preset paralelně
- Vrátí porovnávací tabulku: success rate, avg cost, avg tokens, avg turns per preset
- Můžu vizuálně porovnat v Apify dataset views

### US3: Vývojář testuje více agentů na stejném scénáři
**Jako** Apify vývojář
**chci** spustit stejný scénář na Claude Code, Codex i OpenCode
**abych** porovnal kvalitu agentů

**Acceptance criteria:**
- Orchestrator přijme scénář + seznam agentů + počet opakování (N)
- Spustí Runner pro každého agenta N×
- Vrátí matici: agent × metrika s mean±stddev

### US4: Vývojář detekuje regresi
**Jako** Apify vývojář
**chci** mít baseline výsledky a porovnat je s novým runem
**abych** detekoval regresi po změně MCP serveru

**Acceptance criteria:**
- Orchestrator přijme baseline dataset ID
- Po doběhnutí porovná nové výsledky s baseline
- Flaguje metriky, které se zhoršily o >X%
- Vrátí regression report

### US5: Scénář s multi-step testy
**Jako** test autor
**chci** psát scénáře s více kroky (testy), kde každý má svůj checkpoint
**abych** testoval komplexní workflow

**Acceptance criteria:**
- Markdown soubor s `---` separátory mezi testy
- Každý test má `## Test`, `## Checkpoint`, volitelně `## Monitor`
- `abortOnFailure: true` v YAML frontmatter zastaví scénář po prvním failu
- Výsledek obsahuje per-test breakdown

### US6: Bezpečné env vars
**Jako** vývojář
**chci** předat API klíče (GITHUB_TOKEN, ANTHROPIC_API_KEY) bezpečně
**abych** mohl testovat scénáře vyžadující autentizaci

**Acceptance criteria:**
- Env vars se předají jako secure input (Apify redacts v UI)
- Jsou dostupné v init scriptu a pro agenta
- Po použití se smažou z prostředí
- V conversation logu jsou automaticky maskovány

### US7: Token budget a abort
**Jako** vývojář
**chci** nastavit max token budget
**abych** omezil náklady na eval run

**Acceptance criteria:**
- Runner sleduje token consumption z real-time streaming output
- Po překročení limitu agent subprocess killne
- Výsledek obsahuje `aborted: true` s reason a spotřebovanými tokeny

---

## 4. Technické cesty a zdůvodnění

### TC1: Standalone Dockerfile (ne metamorph do ai-sandbox)
**Proč:** Eval orchestrace vyžaduje streaming subprocess control (`spawn` + NDJSON), error handling (try/catch kolem agent runs), a přímý `Actor.pushData()`. Metamorph to neumožňuje — `exec()` v sandboxu je buffered (1MB limit), po metamorphu žádný error handler, a Codex CLI není předinstalovaný.

**Inspirace z ai-sandbox:** Převezmeme Dockerfile patterny (CLI instalace), health probe, build-time version capture.

### TC2: TypeScript (`ts-empty` template)
**Proč:** Type safety pro komplexní eval schémata (14+ interfaces v gbrain-evals), Node-first Apify SDK, `@anthropic-ai/sdk` pro LLM judge s tool_use (ověřený pattern), nativní `spawn()` + `readline` pro streaming NDJSON.

**Závislosti:** `apify`, `gray-matter`, `@anthropic-ai/sdk` — vše ostatní built-in Node.js.

### TC3: Monorepo s npm workspaces
**Proč:** Runner a Orchestrator sdílejí scenario parser, metriky, typy, agent adaptery. Monorepo = atomické změny, přímé importy, jeden CI pipeline. Apify to oficiálně podporuje (`dockerContextDir`).

**Pozn.:** Monorepo se plně využije až ve Fázi 3 (Orchestrator). Ve Fázi 1-2 stačí jeden Actor, ale strukturu připravíme od začátku.

### TC4: Agent CLI adapter pattern
**Proč:** Každý agent (Claude, Codex, OpenCode) má jiné CLI rozhraní. Adapter abstrahuje: `spawn()` s správnými flagy, parsování output formátu, token counting.

| Agent | Non-interactive command | Output format | Fáze |
|-------|------------------------|---------------|------|
| Claude Code | `claude -p "prompt" --output-format stream-json` | NDJSON stream | F1 (MVP) |
| Codex CLI | `codex exec "prompt" --json` | JSONL events | F2 |
| OpenCode | `opencode -p "prompt" -f json` | JSON | F2 |

### TC5: Dual judge system
**Proč:** Deterministické checkpointy (regex, JSON schema, compile) jsou rychlé a levné. LLM judge (Anthropic tool_use) pro open-ended validaci. Kombinace maximalizuje spolehlivost a minimalizuje cost.

**Výhled custom metrik (3 úrovně, postupně):**
1. Předdefinované typy checkpointů (contains, regex, json-schema, llm-judge) — Fáze 1
2. Custom metriky v YAML frontmatter scénáře — Fáze 2
3. Custom JS/TS scorer funkce jako soubor — Fáze 4

### TC6: Eval framework integrace (Fáze 4)
**Kandidát:** Promptfoo (20K+ stars, MIT, built-in agent trajectory eval: tool-used, tool-sequence, goal-success). Alternativně custom judge + autoevals.

**Pozn.:** Vyžaduje hlubší research v Fázi 4. Pro MVP stačí custom judge přes @anthropic-ai/sdk.

### TC7: Init script presets + custom
**Proč:** Presets pro rychlý start (dropdown v Apify Console), custom script pro plnou flexibilitu. Preset se použije jako základ, custom script se přidá za něj.

Předdefinované presets:
- `mcp_native` — nakonfiguruje MCP server (mcp.json)
- `cli_native` — nainstaluje nativní CLI (gh, linear, apify-cli)
- `mcpc` — nainstaluje mcpc + nakonfiguruje MCP přes mcpc

### TC8: Dual storage — logs + výsledky
- **KV store:** Surový JSONL conversation log (pro debugging, plný kontext)
- **Dataset:** Agregované strukturované výsledky per test step (pro reporting, Apify Console views, filtrování)

---

## 5. Spike testy (Fáze 1)

### Spike 1: Claude Code subprocess streaming (KRITICKÝ)
**Cíl:** Ověřit, že `claude -p` stream-json output jde parsovat v reálném čase přes `spawn` + `readline`.
**Jak:** TS skript — spawn claude, parsovat NDJSON, extrahovat token counts.
**Pass kritérium:** Token counts matchují finální `result` event.
**Blokuje:** Celý Runner.

### Spike 2: Claude CLI v Apify Dockerfile (KRITICKÝ)
**Cíl:** Ověřit, že Dockerfile s `claude` CLI buildí a běží na Apify platformě.
**Jak:** Minimální Actor — nainstaluje claude, spustí `claude --version`, pushne výsledek do datasetu.
**Pass kritérium:** Úspěšný build + run na Apify Cloud.
**Blokuje:** Cloud deployment.

### Spike 3: Custom LLM judge (KRITICKÝ)
**Cíl:** Ověřit, že Anthropic SDK tool_use vrací structured verdict.
**Jak:** Poslat judge prompt s evidence + checkpoint, vynutit structured output přes tool definition.
**Pass kritérium:** Vrátí `{verdict: "pass"|"fail"|"unclear", evidence: string, confidence: number}`.
**Blokuje:** Checkpoint validaci.

### Spike 4: Scenario Markdown parser (STŘEDNÍ)
**Cíl:** Ověřit, že `gray-matter` + vlastní parser zvládne YAML frontmatter + `---` separátory + `## Test`/`## Checkpoint`/`## Monitor` sekce.
**Jak:** Napsat parser, otestovat na 3 vzorových scénářích.
**Pass kritérium:** Parsuje korektně frontmatter, N testů, každý s test/checkpoint/monitor.
**Riziko:** Nízké — gray-matter je ověřená knihovna.

### Spike 5: Env var injection + masking (STŘEDNÍ)
**Cíl:** Ověřit bezpečné předání env vars do claude subprocess + maskování v logu.
**Jak:** Spawn claude s custom env, zachytit output, ověřit že secrets nejsou v logu.
**Pass kritérium:** Agent má přístup k env vars, ale v JSONL logu jsou maskovány.
**Blokuje:** US6.

### Spike 6: Token budget abort (STŘEDNÍ)
**Cíl:** Ověřit real-time token tracking ze streaming output + kill subprocess při překročení limitu.
**Jak:** Spawn claude s malým budgetem, parsovat streaming tokeny, killnout po limitu.
**Pass kritérium:** Subprocess se korektně ukončí, výsledek obsahuje spotřebované tokeny.
**Blokuje:** US7.

---

## 6. Implementační plán (fázovaný)

### Fáze 1: MVP — Runner + Claude Code
**Scope:** Fungující Runner Actor s Claude Code agentem, custom LLM judge, scenario parser.
**User stories:** US1, US5, US6, US7

- [ ] **F1.0: Projekt setup**
  - Inicializovat monorepo s npm workspaces (připravit strukturu pro Orchestrator)
  - Scaffold `actors/runner/` z `ts-empty`
  - Vytvořit `shared/` package s základní strukturou
  - CLAUDE.md + AGENTS.md
  - ESLint, Prettier, tsconfig
  - Git push na GitHub

- [ ] **F1.1: Spike testy**
  - Spike 1: Claude subprocess streaming (KRITICKÝ)
  - Spike 2: Actor + CLI Dockerfile (KRITICKÝ)
  - Spike 3: LLM judge tool_use (KRITICKÝ)
  - Spike 4: Scenario parser
  - Spike 5: Env var injection + masking
  - Spike 6: Token budget abort
  - Dokumentovat výsledky, upravit plán dle nálezů

- [ ] **F1.2: Shared library (core)**
  - `shared/src/types.ts` — TypeScript interfaces (scenario, test, checkpoint, result, metrics)
  - `shared/src/scenario-parser.ts` — Markdown + YAML frontmatter parser
  - `shared/src/agents/claude.ts` — Claude Code CLI adapter (spawn + NDJSON streaming)
  - `shared/src/judge.ts` — Dual judge (deterministic: contains/regex/json-schema + LLM: Anthropic tool_use)
  - `shared/src/metrics.ts` — Token counting, timing, cost calculation
  - `shared/src/log-masker.ts` — Env var masking v conversation logs
  - Unit testy pro parser, judge, masker

- [ ] **F1.3: Runner Actor**
  - Input schema (agent, model, scenario file, envVars, mcpConfig, initScript, maxTokens, maxRetries)
  - Output schema + dataset schema s views
  - Dockerfile (Node 24 + Claude CLI, inspirace z ai-sandbox)
  - Main loop: parse scenario -> per test: run agent -> judge checkpoint -> collect metrics
  - Streaming token tracking + budget abort
  - Env var injection + cleanup + log masking
  - Conversation log -> KV store (JSONL), results -> dataset (structured JSON)
  - Graceful abort handling (`Actor.on('aborting')`)
  - Lokální testy s `apify run`
  - Cloud deploy + test

- [ ] **F1.4: Init script presets**
  - Preset: `mcp_native` (MCP config.json)
  - Preset: `cli_native` (gh, apify-cli)
  - Preset: `mcpc` (mcpc + config)
  - Dropdown v input schema + custom textarea

### Fáze 2: Multi-agent — Codex + OpenCode adaptéry
**Scope:** Rozšířit Runner o Codex CLI a OpenCode adaptéry.
**User stories:** US1 (rozšíření na 3 agenty)

- [ ] `shared/src/agents/codex.ts` — Codex CLI adapter
- [ ] `shared/src/agents/opencode.ts` — OpenCode CLI adapter
- [ ] Dockerfile update (+ Codex CLI + OpenCode CLI)
- [ ] Testy s reálnými scénáři pro všechny 3 agenty
- [ ] Agent-specific token counting a cost normalizace

### Fáze 3: Orchestrator Actor
**Scope:** Actor #2 pro multi-agent, multi-scenario orchestraci.
**User stories:** US2, US3, US4

- [ ] Input schema (agents[], scenarios[], presets[], repetitions N, baselineDatasetId)
- [ ] Output schema + dataset views (comparison matrix)
- [ ] `Actor.start()` pro paralelní Runner instance
- [ ] Agregace výsledků: mean±stddev per agent × preset × metrika
- [ ] Regression detection vs baseline
- [ ] Cloud deploy + test

### Fáze 4: Advanced eval — Promptfoo + custom metriky
**Scope:** Integrace eval frameworku, rozšířené metriky.
**Prerekvizita:** Hlubší research promptfoo vs alternativy.

- [ ] Promptfoo (nebo alternativa) integrace pro trajectory eval
- [ ] Custom metriky v YAML frontmatter scénáře
- [ ] Custom JS/TS scorer funkce (file upload)
- [ ] Tool call tracking a trajectory assertions
- [ ] Cache hit rate metriky

### Fáze 5: Scénáře, dokumentace, CI/CD
- [ ] Vzorové scénáře: GitHub issue lookup, Apify Actor creation, MCP tool call
- [ ] README pro Apify Store (oba Actory)
- [ ] CI/CD (GitHub Actions: lint + test + deploy)
- [ ] E2E testy na Apify Cloud

---

## 7. Otevřené otázky

- [ ] Jaký org name na Apify Store? (`agentify/agent-evals-runner`?)
- [ ] Máme přístup k Codex CLI API klíči pro Fázi 2?
- [ ] Budget: kolik Apify platform credits máme pro development a testing?
- [ ] Přístup k GitHub repo pro cílový org?
- [ ] Chceme standby mode? (Pro API-like přístup k eval runner — Fáze 5?)
- [ ] Jak řešit auth pro Claude Code v Dockerfile? (`ANTHROPIC_API_KEY` env var vs `claude setup-token`)

---

## 8. Poučení z researche

### Z gbrain-evals
- Adapter interface pro pluggable system-under-test -> naše Agent CLI adaptery
- LLM judge s tool_use pro structured verdicts -> náš custom judge
- Tiered runs (N=1 smoke, N=5 full) -> jednoduché opakování v Orchestratoru
- Flight recorder (artifact bundle) -> JSONL log + structured results

### Z meta-engine benchmark
- `claude -p --output-format stream-json` jako subprocess -> hlavní execution pattern
- `--strict-mcp-config` pro izolaci MCP -> klíčové pro MCP vs CLI benchmarking
- Authoritative metrics z CLI result event -> token counting
- Bash orchestrator s PARALLEL=N -> inspirace pro Orchestrator

### Z AXI
- 4 core metriky: success, cost, duration, turns -> naše baseline metriky
- MCP schema inflation je měřitelný problém (12x cost rozdíl) -> motivace pro projekt
- TOON format pro token úsporu -> zajímavé pro budoucí optimalizaci

### Z mcp-eval.ai
- LLM-as-judge s Expect API -> inspirace pro assertion types
- CI/CD regression detection -> Fáze 3 (Orchestrator)

### Z ai-sandbox monorepa
- Dockerfile pattern pro CLI instalaci (curl install scripts) -> převezmeme
- Health probe s inicializačním stavem -> převezmeme
- Build-time version capture -> převezmeme
- `exec()` je buffered (1MB limit) -> proto standalone, ne metamorph
- Žádné npm workspaces -> my potřebujeme workspaces pro shared kód

### Z promptfoo
- Built-in agent trajectory eval (tool-used, tool-sequence, goal-success) -> Fáze 4
- Programmatic `evaluate()` API -> použitelné jako library v našem Actoru
- Custom JavaScript assertion functions -> naše custom metriky
