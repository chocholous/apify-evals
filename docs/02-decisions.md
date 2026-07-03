# Agent Evals — Rozhodnutí a zdůvodnění

Tento dokument zachycuje všechna architektonická rozhodnutí, včetně zamítnutých alternativ a důvodů.

---

## D1: Standalone Dockerfile vs. Metamorph do ai-sandbox

### Rozhodnutí: Standalone Dockerfile

### Zamítnuto: Metamorph do `apify/ai-sandbox`

Původní spec navrhovalo metamorph do ai-sandbox pro využití jeho persistence a předinstalovaných CLI.

**Důvody pro zamítnutí:**

| Kritérium | Metamorph | Standalone | Vítěz |
|-----------|-----------|------------|-------|
| Subprocess control | `exec()` buffered, 1MB limit, žádné streaming | `spawn()` streaming NDJSON, pty support | Standalone |
| Error handling | Po metamorphu žádný catch — run prostě failne | try/catch, retry, graceful degradation | Standalone |
| Codex CLI | Není předinstalovaný (initShellScript workaround, 5min timeout) | V Dockerfile od začátku | Standalone |
| Cold start | Stop + start + install + initScript = 30-90s | Jeden start = 15-30s | Standalone |
| Version pinning | Závisí na ai-sandbox releasu | Plná kontrola v Dockerfile | Standalone |
| Eval orchestrace | Logika přes REST API (nepohodlné) | Přirozený control flow | Standalone |
| Token counting | Buffered exec nedává streaming metrics | Streaming NDJSON z CLI | Standalone |
| Maintenance | Apify udržuje sandbox (nižší zátěž) | Vlastní Dockerfile (vyšší zátěž) | Metamorph |
| Debugging | Zabudovaný ttyd shell | Musíme řešit sami | Metamorph |

**Skóre:** 8:2 pro standalone.

**Co z ai-sandbox převezmeme:**
- Dockerfile patterny pro CLI instalaci (`curl -fsSL https://claude.ai/install.sh | bash`)
- Health probe s inicializačním stavem (`initializationComplete` flag)
- Build-time version capture pro rychlý shell startup
- Activity-based idle timeout pattern

---

## D2: TypeScript vs. JavaScript vs. Python

### Rozhodnutí: TypeScript (`ts-empty` template)

### Zamítnuto: JavaScript, Python

**Důvody:**

| Kritérium | TypeScript | JavaScript | Python |
|-----------|-----------|------------|--------|
| Type safety pro eval schémata | 14+ interfaces (gbrain-evals vzor) | Žádná compile-time kontrola | Type hints, runtime-only |
| Apify SDK | Primární, Node-first | Stejný SDK | Sekundární, tenčí docs |
| LLM-as-judge | `claude -p --json-schema` (ověřeno spike S3) | Stejné | Funguje, méně příkladů |
| Subprocess streaming | `spawn()` + `readline` — nativní | Stejné | `asyncio.subprocess` — edge cases |
| YAML parsing | `gray-matter` — battle-tested (6K stars) | Stejné | `python-frontmatter` — menší komunita |
| Reference projekty | gbrain-evals (TS), ai-sandbox (TS) | meta-engine (bash+Python mix) | — |

**Klíčový argument:** Eval systém má komplexní datové struktury (scenario frontmatter, subprocess events, judge evidence, result records). Type safety zabraňuje runtime chybám po 30 minutách běhu agenta.

**Závislosti (minimální):**
- `apify` — SDK (included v template)
- `gray-matter` — YAML frontmatter parsing
- Vše ostatní built-in Node.js: `child_process.spawn`, `readline`, `AbortController`
- ~~`@anthropic-ai/sdk`~~ — **nepotřebujeme** (spike S3 ukázal, že LLM judge funguje přes `claude -p --json-schema`)

---

## D3: Monorepo vs. Separate repos

### Rozhodnutí: Monorepo s npm workspaces

### Zamítnuto: Samostatné repozitáře

**Důvody:**
- Runner a Orchestrator sdílejí scenario parser, metriky, typy, agent adaptery
- Atomické změny: nová metrika = 1 PR (runner + orchestrator + shared)
- Apify oficiálně podporuje monorepo (`dockerContextDir` + `ACTOR_PATH_IN_DOCKER_CONTEXT`)
- ai-sandbox repo je monorepo se 4 actory (ověřený pattern)
- Deploy zůstává nezávislý: `apify push --dir actors/runner`

**Kdy by separate repos byly lepší:** Různé týmy, žádný sdílený kód, nezávislé release cadence — nic z toho neplatí.

---

## D4: AI SDK agent — vyřazen z MVP

### Rozhodnutí: Jen Claude Code, Codex, OpenCode

### Zamítnuto: AI SDK (Vercel)

**Důvod:** AI SDK je TypeScript knihovna, ne CLI nástroj. Nemá non-interactive CLI mode jako ostatní agenty. Integrace by vyžadovala programmatic wrapper (spawn Node.js skriptu), což je zásadně odlišný pattern od CLI adaptérů.

**Výhled:** Může být přidán v pozdější fázi jako speciální adapter type.

---

## D5: MVP scope — Runner first

### Rozhodnutí: Fáze 1 = jen Runner + Claude Code

### Zamítnuto: Všechny agenty od začátku, Orchestrator od začátku

**Důvody:**
- Většina user stories (US1, US5, US6, US7) se týká jen Runneru
- Runner musí být spolehlivý než ho Orchestrator začne volat
- Claude Code má nejlepší CLI support (`--output-format stream-json`, `--strict-mcp-config`)
- Codex a OpenCode přidáme ve Fázi 2 — jen nové adapter soubory
- Orchestrator ve Fázi 3 — využije ověřený Runner

---

## D6: Structured logs vs. OpenTelemetry

### Rozhodnutí: Structured JSON logs

### Zamítnuto: OpenTelemetry

**Důvody:**
- OTel SDK přidává značnou složitost (spans, exporters, collectors)
- Pro MVP stačí structured JSON events z CLI streaming output
- Dual storage: JSONL do KV store (debugging) + structured JSON do datasetu (reporting)
- Kompatibilní s pozdějším OTel: structured logs se dají transformovat na spans

**Výhled:** Pokud se ukáže potřeba, OTel se dá přidat v pozdější fázi nad structured logs.

---

## D7: Eval framework — custom judge pro MVP

### Rozhodnutí: LLM judge přes `claude -p --json-schema` pro MVP, promptfoo ve Fázi 4

**Aktualizováno po spike testech:** Původně jsme plánovali `@anthropic-ai/sdk` s tool_use. Spike S3 ukázal, že `claude -p --json-schema` funguje — structured output v `result.structured_output` fieldu, žádný API klíč potřeba (OAuth/subscription stačí). Vyžaduje `--max-turns 3` (interní tool call).

### Zamítnuto: @anthropic-ai/sdk (přímé API volání), DeepEvals (Python), promptfoo od začátku

**Důvody pro CLI judge:**
- Žádná extra závislost (claude CLI je už v Dockerfile)
- Žádný API klíč potřeba — funguje se stejným auth jako agent run
- `--json-schema` vynutí structured output (verdict/evidence/confidence)
- Stejný mechanismus jako agent run = méně pohyblivých částí

**Proč ne DeepEvals:**
- Python framework, náš Actor je TypeScript
- Vyžadovalo by Python subprocess nebo samostatný Actor

**Proč promptfoo až Fáze 4:**
- Přidává dependency a abstrakční vrstvu
- Pro MVP stačí jednoduchý judge
- Promptfoo má built-in agent trajectory eval — cenné, ale ne pro MVP
- Vyžaduje hlubší research (library API vs CLI, integrace s naším Runner loop)

**TS alternativy k DeepEvals (research):**

| Framework | Stars | Agent eval | Tool call eval | Licence |
|-----------|-------|-----------|---------------|---------|
| **Promptfoo** | 20,700 | Ano (trajectory) | Ano (tool-used, tool-sequence, goal-success) | MIT |
| **Autoevals** (Braintrust) | 876 | Ne | Ne | MIT |
| **Evalite** | 1,500 | Ne | Ne | Proprietary |
| **Custom Judge** | N/A | DIY | DIY | — |

---

## D8: Init scripts — presets + custom

### Rozhodnutí: Dropdown s předdefinovanými presets + textarea pro custom script

### Zamítnuté alternativy:
- **Jen hardcoded presets:** Příliš rigidní, uživatelé potřebují flexibilitu
- **Jen custom script:** Špatný UX pro začátečníky
- **Preset v Markdown scénáři:** Scénář by nebyl portabilní mezi různými prostředími

---

## D9: Scénáře — input schema file upload

### Rozhodnutí: File upload přes Apify Console input schema

### Zamítnuté alternativy:
- **Git repo URL + path:** Lepší verzovatelnost, ale složitější UX pro quick testy
- **Obojí:** Zbytečná komplexita pro MVP — file upload stačí

**Výhled:** Git repo source může být přidán v Orchestratoru (Fáze 3) pro CI/CD pipeline.

---

## D10: Run repetitions — jednoduché N

### Rozhodnutí: Orchestrator přijme počet opakování jako číslo

### Zamítnuto: Tier systém (smoke/full/published)

**Důvod:** Zbytečná abstrakce. Uživatel si nastaví N=1 pro smoke, N=5 pro full, N=10 pro published sám. Tier systém přidává koncepty bez hodnoty.

---

## D11: Custom metriky — 3 úrovně postupně

### Rozhodnutí: Postupná expanze

1. **Fáze 1:** Předdefinované typy (contains, regex, json-schema, llm-judge)
2. **Fáze 2:** Custom metriky v YAML frontmatter scénáře
3. **Fáze 4:** Custom JS/TS scorer funkce jako soubor

### Důvod: Inkrementální složitost. Předdefinované typy pokryjí 80% use cases. Custom YAML pokryje dalších 15%. JS/TS funkce pro edge cases.

---

## D12: Agent permissions — dangerously-skip-permissions

### Rozhodnutí: Eval agent běží s `--dangerously-skip-permissions`

**Ověřeno spike S5.** Bez tohoto flagu agent odmítá spouštět Bash příkazy (permission prompty). V eval kontextu agent musí mít plný přístup — testujeme jeho schopnost splnit úkol, ne bezpečnostní restrikce.

**Riziko:** Agent může provést destruktivní operace. Mitigace: běží v izolovaném Docker kontejneru na Apify platformě.

---

## D13: Token budget — nativní --max-budget-usd + SIGTERM

### Rozhodnutí: Dvojitá ochrana

**Ověřeno spike S6.**

1. **`--max-budget-usd N`** — claude CLI nativně zastaví agenta po překročení budget limitu (exit code 1)
2. **Mezi-turnový SIGTERM** — fallback pro případ, kdy chceme killnout na základě jiného kritéria (např. počet turnů, wallclock timeout)

### Zamítnuto: Real-time per-token budget tracking

**Důvod:** Spike S6 ukázal, že token usage v assistant message events je per-turn snapshot (ne inkrementální streaming). Real-time per-token tracking není možný přes current CLI interface. `--max-budget-usd` je dostatečný a přesnější.

---

## D14: Auth — OAuth token, žádný API klíč

### Rozhodnutí: Claude Code OAuth token / subscription pro vše

**Ověřeno spike S1, S3, S5.** Claude CLI funguje s OAuth autentizací. LLM judge přes `claude -p --json-schema` nevyžaduje samostatný `ANTHROPIC_API_KEY`.

V Apify Docker kontejneru bude auth řešený přes env var `CLAUDE_CODE_OAUTH_TOKEN` (secure input od uživatele).

---

## D15: Fat Docker image vs. per-agent images

### Rozhodnutí: Jeden fat Dockerfile se všemi agent CLI

Jeden `Dockerfile` v `actors/runner/` instaluje všechny CLI nástroje (Claude Code, Codex, OpenCode, Apify CLI). Agent se vybírá za běhu přes input parametr `agent`.

### Zamítnuto: Separate Dockerfiles per agent, Actor.metamorph()

**Důvody pro fat image:**

| Kritérium | Fat image | Per-agent images | Metamorph |
|-----------|-----------|-----------------|-----------|
| Jednoduchost | Jeden Dockerfile, jeden deploy | 3+ Dockerfile, manuální přepínání actor.json | Dispatcher Actor + N target Actors |
| Testovatelnost | Jeden build test | N build testů | Nelze testovat lokálně (`metamorph()` je no-op) |
| Deploy | `apify push` | `apify push` + přepnout dockerfile | Deploy N Actors |
| Image size | ~200 MB (všechny CLI) | ~100 MB (jen jedno CLI) | Optimální per-agent |
| Apify podpora | 1 Actor = 1 Dockerfile (nativní) | actor.json nemá multi-dockerfile | Max 10 metamorphs/run, env vars se nepřenesou |

**Proč ne metamorph:**
- `Actor.metamorph()` nepřenáší env vars z původního Actoru — runner potřebuje `OPENAI_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` atd.
- Nefunguje lokálně (SDK jen loguje warning) — dual code path pro testování
- Runner orchestruje celý eval flow (parse → run → judge → log) — metamorph nahradí celý kontejner, nelze se vrátit

**Výhled:** Metamorph by se hodil pro Orchestrator (Fáze 3) jako dispatcher do per-agent Runner Actors, pokud by velikost fat image byla problém. Zatím není potřeba.

**Verzování CLI:** Image instaluje latest verze. Pokud uživatel potřebuje specifickou verzi agenta, řeší to v `initBashScript` (odinstalace + instalace verzované verze).

---

## D16: LLM Judge — SDK vs CLI (judgeMode)

### Rozhodnutí: Tři režimy s auto-detekcí

- `auto` (default): Pokud `ANTHROPIC_API_KEY` v env → SDK (`@anthropic-ai/sdk` s `tool_use`), jinak CLI (`claude -p --json-schema`)
- `cli`: Vždy CLI (funguje s OAuth tokenem)
- `sdk`: Vždy SDK (vyžaduje API klíč)

### Zamítnuto: Pouze CLI, pouze SDK

**Proč oba:**

| Kritérium | CLI judge | SDK judge |
|-----------|----------|-----------|
| Latence | ~3-5s (CLI startup + internal tool call) | ~0.5-1s (přímé API volání) |
| Auth | OAuth token NEBO API key | Jen API key |
| Cost tracking | Nelze (CLI nereportuje) | Ano (`response.usage`) |
| Závislost | Žádná (claude CLI v Dockerfile) | `@anthropic-ai/sdk` (~1.5MB) |
| Retry | Manuální (spawn → parse → retry) | SDK built-in retry |

**Klíčový argument:** Eval Runner na Apify platformě typicky má API klíč (uživatel ho předá v `envVariables`). SDK je 5× rychlejší a umožňuje měřit judge cost. CLI režim zůstává jako fallback pro lokální vývoj s OAuth.

**Spike reference:** S3 (`spikes/s3-llm-judge.ts`) ověřil SDK `tool_use` pattern. Produkční implementace v `shared/src/agents/judge-sdk.ts`.

---

## D17: OTel jako datový formát (ne platforma)

### Rozhodnutí: OTel GenAI semantic conventions jako standardizovaný formát v KV store

### Zamítnuto: Langfuse, Promptfoo, vlastní formát, žádný tracing

**Research kontext:** Vyhodnotili jsme 10+ frameworků/platforem:

| Alternativa | Proč zamítnuto |
|-------------|---------------|
| **Promptfoo** | 1179 deps, nahrazuje náš runner, OpenAI acquisition (březen 2026) |
| **Langfuse** | Vyžaduje server (self-hosted: 6 kontejnerů), duplikuje data z Apify datasetu |
| **Langfuse Cloud** | Vendor dependency, data outside Apify |
| **autoevals** (Braintrust) | Náš checkpoint systém je silnější (filesystem access, bash scripts) |
| **Vlastní JSON formát** | Žádná interoperabilita s existujícími viewery |

**Proč OTel:**

1. **Minimální deps:** `@opentelemetry/api` (0 deps) + `sdk-trace-base` + `sdk-trace-node` = ~1.7MB, žádné native binaries
2. **Žádný server:** `BufferSpanExporter` → OTLP JSON do Apify KV store
3. **Standardní formát:** ~80% `AgentResult` polí má přímý mapping na `gen_ai.*` atributy
4. **Future-proof interop:** OTLP JSON lze nahrát do AgentPrism, Langfuse OTLP endpoint, Jaeger, Grafana Tempo — bez změny kódu
5. **Žádný lock-in:** Open standard, remove = smazat 30 řádků instrumentace

**GenAI Semantic Conventions stav:** Development (ne stable), ale shipping u Vercel AI SDK, Datadog, LangChain. Pinujeme na konkrétní verzi `@opentelemetry/semantic-conventions`.

**Trace struktura:**
```
scenario_run → test_N → invoke_agent (gen_ai.usage.*, tool events) → judge_evaluation (gen_ai.evaluation.*)
```

**Implementace:** `shared/src/otel.ts` (setup + helpers), `shared/src/otel-exporter.ts` (BufferSpanExporter + OTLP JSON serialization). Runner wrappuje existující loop do spanů, výstup do `OTEL-TRACE` KV klíč.
