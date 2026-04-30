# Agent Evals — Projektový dokument

## Context

Apify vyvíjí MCP server a CLI nástroje. Potřebujeme:
1. Měřit dopad změn v MCP serveru a CLI na výkon AI agentů
2. Ukončit debatu "MCP vs CLI" daty — ukázat, že jsou komplementární
3. Testovat Actor development s AI agenty (one-shot Actors)
4. Testovat Apify LLM chat

Dva Apify Actory v TypeScript monorepu:
- **Actor #1: Agent Evals Runner** — spustí jeden testovací scénář s jedním AI agentem
- **Actor #2: Agent Evals Orchestrator** — orchestruje více scénářů přes více agentů

---

## 1. Cíle

### C1: Reproducibilní eval pipeline
Spustit libovolný Markdown scénář s libovolným AI agentem (Claude Code, Codex, OpenCode, AI SDK) a dostat strukturované, porovnatelné výsledky.

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
- Nahraju Markdown soubor se scénářem
- Vyberu agenta (dropdown: Claude Code, Codex, OpenCode, AI SDK)
- Volitelně nastavím model, max tokens, env vars
- Po doběhnutí vidím v datasetu: pass/fail per checkpoint, token count, cost, duration
- V KV store najdu plný conversation log

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
- Orchestrator přijme scénář + seznam agentů
- Spustí Runner pro každého agenta (volitelně s N opakováními)
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
- Runner sleduje token consumption ze streaming output
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

### TC4: Agent CLI adapter pattern
**Proč:** Každý agent (Claude, Codex, OpenCode) má jiné CLI rozhraní. Adapter abstrahuje: `spawn()` s správnými flagy, parsování output formátu, token counting.

| Agent | Non-interactive command | Output format |
|-------|------------------------|---------------|
| Claude Code | `claude -p "prompt" --output-format stream-json` | NDJSON stream |
| Codex CLI | `codex exec "prompt" --json` | JSONL events |
| OpenCode | `opencode -p "prompt" -f json` | JSON |
| AI SDK | Programmatic (Vercel AI SDK) | Structured |

### TC5: Dual judge system
**Proč:** Deterministické checkpointy (regex, JSON schema, compile) jsou rychlé a levné. LLM judge (Anthropic tool_use) pro open-ended validaci. Kombinace maximalizuje spolehlivost a minimalizuje cost.

---

## 5. Spike testy (feasibility ověření)

### Spike 1: Claude Code subprocess streaming
**Cíl:** Ověřit, že `claude -p` stream-json output jde parsovat v reálném čase přes `spawn` + `readline`.
**Jak:** Jednoduchý TS skript — spawn claude, parsovat NDJSON, extrahovat token counts.
**Pass kritérium:** Token counts matchují finální `result` event.

### Spike 2: Codex CLI subprocess
**Cíl:** Ověřit, že `codex exec --json` funguje headless s `OPENAI_API_KEY`.
**Jak:** Spawn codex v Docker containeru, zachytit output.
**Pass kritérium:** Structured output se exit code 0.

### Spike 3: LLM-as-judge s tool_use
**Cíl:** Ověřit, že Anthropic SDK tool_use vrací structured verdict.
**Jak:** Poslat judge prompt s evidence + checkpoint, vynutit structured output přes tool definition.
**Pass kritérium:** Vrátí `{verdict: "pass"|"fail"|"unclear", evidence: string, confidence: number}`.

### Spike 4: Markdown scenario parser
**Cíl:** Ověřit, že `gray-matter` + vlastní parser zvládne YAML frontmatter + `---` separátory + `## Test`/`## Checkpoint`/`## Monitor` sekce.
**Jak:** Napsat parser, otestovat na 3 vzorových scénářích.
**Pass kritérium:** Parsuje korektně frontmatter, N testů, každý s test/checkpoint/monitor.

### Spike 5: Apify Actor s CLI v Dockerfile
**Cíl:** Ověřit, že Dockerfile s `claude` CLI buildí a běží na Apify platformě.
**Jak:** Minimální Actor — nainstaluje claude, spustí `claude --version`, pushne výsledek do datasetu.
**Pass kritérium:** Úspěšný build + run na Apify Cloud.

### Spike 6: Monorepo deploy
**Cíl:** Ověřit, že `apify push` funguje s `dockerContextDir` pro dva Actory v jednom repo.
**Jak:** Dva minimální Actory sdílející jeden modul ze `shared/`.
**Pass kritérium:** Oba Actory se buildí a běží nezávisle na Apify Cloud.

---

## 6. Implementační plán

### Fáze 0: Projekt setup (den 1)
- [ ] Inicializovat monorepo s npm workspaces
- [ ] Scaffold `actors/runner/` a `actors/orchestrator/` z `ts-empty`
- [ ] Vytvořit `shared/` package s základní strukturou
- [ ] Vytvořit CLAUDE.md a AGENTS.md
- [ ] Nastavit ESLint, Prettier, tsconfig
- [ ] Git init + push na GitHub (agentify/agent-evals)
- [ ] Nainstalovat `apify/agent-skills` plugin globálně

### Fáze 1: Spike testy (den 2-3)
- [ ] Spike 1: Claude Code streaming
- [ ] Spike 2: Codex CLI headless
- [ ] Spike 3: LLM judge tool_use
- [ ] Spike 4: Scenario parser
- [ ] Spike 5: Actor + CLI Dockerfile
- [ ] Spike 6: Monorepo deploy
- [ ] Dokumentovat výsledky spikes, upravit plán dle nálezů

### Fáze 2: Shared library (den 4-5)
- [ ] `shared/src/types.ts` — TypeScript interfaces pro scenario, test, checkpoint, result, metrics
- [ ] `shared/src/scenario-parser.ts` — Markdown + YAML frontmatter parser
- [ ] `shared/src/agents/` — Agent CLI adaptery (claude, codex, opencode)
- [ ] `shared/src/judge.ts` — Dual judge (deterministic + LLM)
- [ ] `shared/src/metrics.ts` — Token counting, timing, cost calculation
- [ ] Unit testy pro parser a judge

### Fáze 3: Runner Actor (den 6-8)
- [ ] Input schema (agent, model, scenario, envVars, mcpConfig, initScript, maxTokens, maxRetries)
- [ ] Output schema + dataset schema s views
- [ ] Dockerfile s Claude/Codex/OpenCode CLI
- [ ] Main orchestration loop: parse scenario -> per test: run agent -> judge checkpoint -> collect metrics
- [ ] Streaming token tracking + budget abort
- [ ] Env var injection + cleanup + log masking
- [ ] Conversation log do KV store
- [ ] Health probe + graceful abort handling
- [ ] Lokální testy s `apify run`
- [ ] Cloud deploy + test

### Fáze 4: Orchestrator Actor (den 9-10)
- [ ] Input schema (agents[], scenarios[], presets[], repetitions, baselineDatasetId)
- [ ] Output schema + dataset views (comparison matrix)
- [ ] Actor.start() pro paralelní Runner instance
- [ ] Agregace výsledků: mean+-stddev per agent x preset x metrika
- [ ] Regression detection vs baseline
- [ ] Cloud deploy + test

### Fáze 5: Scénáře a dokumentace (den 11-12)
- [ ] Vzorové scénáře: GitHub issue lookup, Apify Actor creation, MCP tool call
- [ ] Init script presets: mcp_native, cli_native, mcpc, mcp_cli_x
- [ ] README pro Apify Store
- [ ] CI/CD (GitHub Actions: lint + test + deploy)
- [ ] E2E test na Apify Cloud

---

## 7. Otevřené otázky

- [ ] Jaký org name na Apify Store? (`agentify/agent-evals-runner`?)
- [ ] Máme přístup k Codex CLI API klíči pro spiky?
- [ ] AI SDK agent — jak přesně se spouští? (Vercel AI SDK je library, ne CLI)
- [ ] Chceme standby mode? (Pro API-like přístup k eval runner)
- [ ] Budget: kolik Apify platform credits máme pro development a testing?
- [ ] Přístup k GitHub repo pro agentify org?
