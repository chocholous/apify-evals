# Additional Features (Beyond Original Scope)

Features implementované nad rámec původního plánu (`docs/01-plan.md`) a původního spec (`docs/00-original-spec.md`). Tento dokument je živý — přidávají se sem věci, které vznikly během implementace, ale plán je nezachycuje.

## Detection & telemetry

### OpenTelemetry instrumentace

Runner produkuje plný OTLP JSON trace v KV klíči `OTEL-TRACE`. Implementace: `shared/src/otel.ts` (setup, span helpers, GenAI semantic conventions) + `shared/src/otel-exporter.ts` (custom `BufferSpanExporter` bez serveru).

Trace struktura:
```
scenario_run
├── test_N
│   ├── invoke_agent (gen_ai.usage.*, tool_call eventy)
│   └── judge_evaluation (gen_ai.evaluation.* per checkpoint)
```

~80 % `AgentResult` polí má přímé mapping na `gen_ai.*` atributy, zbytek je custom `eval.*`. Kompatibilní s AgentPrism, Langfuse OTLP endpoint, Jaeger, Grafana Tempo — bez změny kódu. Detail: D17 v `docs/02-decisions.md`.

Plán to drží jako F4 "optional"; ve skutečnosti je hotové od Day 5.

### Apify dataset auto-download

Runner skenuje agentový event stream na Apify `defaultDatasetId` (17-znakové ID, regex `/defaultDatasetId.{1,10}?(\w{17})/g`) a stáhne každý dataset přes `https://api.apify.com/v2/datasets/<id>/items` do `<workspace>/eval-datasets/<id>.json`. Implementace: `shared/src/apify-datasets.ts`, volání v `actors/runner/src/main.ts:211-220`.

Důsledek: LLM judge i `script:` / `jq:` checkpointy můžou validovat reálný output Apify Actoru, který agent během testu spustil — nemusí se to řešit manuálně v init scriptu.

Plán to nezmiňuje vůbec; přibylo při psaní Actor-dev scénářů.

### Filesystem file change detection (dual-track)

`trajectory.filesCreated` a `filesModified` se neopírají jen o event stream. Detekce běží paralelně dvěma způsoby:

1. **Bash regex z `tool_use` eventů** — `extractFileOpsFromCommand` (`shared/src/agents/run.ts:60-90`) parsuje `Bash` tool calls a hledá `>` (create), `>>` (modify), `tee`, `cp`, `mv`.
2. **Filesystem ground truth** — runner před spawnem agenta vytvoří marker `<workdir>/.eval-marker-<ts>`, po skončení použije `find -newer` na workdir + `/tmp` (`run.ts:540-621`). Chytá soubory vytvořené mimo `Write` tool nebo bash redirect (např. přes `python -c`, `apify run` interní zápisy, atd.).

Výsledky se mergují. Bez ground truth by trajectory u některých scénářů byla výrazně poddetekovaná.

## Judge enhancements

### `platform_failure` verdict

Původní plán definuje 3 verdikty: `pass | fail | unclear`. Implementace má pátý — `platform_failure` (`shared/src/types.ts:25`). Vrací ho `detectPlatformFailures` (`shared/src/judge.ts:357-372`), který skenuje `tool_use_result` eventy regexem `/exceed the memory limit|memory limit.*exceeded|cannot allocate memory/i`.

Důvod: bez tohoto rozlišení by Apify memory kill vypadal jako agent fail a kontaminoval by metriky. V agregaci má `platform_failure` přednost nad `fail`. Pro autora scénáře = "zvyš memory limit", ne "fixuj agenta".

(Čtvrtý verdict `warning` přidává `warn-` severity prefix — viz dále.)

### `jq:` checkpoint — evaluace nad trajectory

Plán definuje jen 3 deterministické typy nad agent output stringem (`contains`, `regex`, `json-schema`). Implementace přidává **`jq:`** (`shared/src/judge.ts:171-203`, `JQ_TIMEOUT_MS`), který rozšiřuje scope evaluace o úroveň níž: pracuje nad **conversation event streamem** (JSON array) místo nad finálním textem.

Rozdíl není kosmetický — odpovídá na úplně jinou třídu otázek:

| Otázka | Vhodný typ |
|--------|-----------|
| "Řekl agent správnou odpověď?" | `contains:`, `regex:`, `json-schema:`, LLM judge |
| "Použil agent správný tool?" | `jq:` |
| "Zavolal `apify call` s parametrem X?" | `jq:` |
| "NEPOUŽIL zakázané `WebSearch`/`WebFetch`?" | `jq:` (negativní assert) |
| "Vznikl soubor / dataset s obsahem Y?" | `script:` (workspace) |

`jq:` výraz dostane na stdin pole eventů `[{type: "assistant", message: {content: [{type: "tool_use", name: "Bash", input: {command: "..."}}]}}, ...]` a musí vrátit truthy hodnotu (`jq -e`). Podporuje `warn-jq:` prefix (warning severity).

Nahrazování: **nenahrazuje** `contains:`/`regex:`/`json-schema:`. Doplňuje je. Output-string checky zůstávají rovnocenné pro answer-quality assertions. `jq:` je nutný kdykoli chceš verifikovat **chování** agenta, ne jen výstup.

CLAUDE.md má 4 hotové vzory (tool-usage, OR logika, negative assert, parameter check).

### Subsection formát checkpointů

Plán definuje `## Checkpoint` jako flat blok s prefixovanými řádky:
```
## Checkpoint
contains: Jupiter
regex: \blargest\b
The answer must be scientifically accurate.
```

Implementace přidává **subsection formát** (`shared/src/judge.ts:31-88`) pro případy, kdy flat nestačí — multi-line bash skripty a víc samostatných LLM judge bloků v jednom checkpointu:

```
## Checkpoint

### Checks
contains: Jupiter
regex: \blargest\b

### Script
value=$(cat)
jq -e '.count > 0' /tmp/result.json

### Judge
Evaluate quality of the response.

### Judge (opus)
Deep analysis of code architecture.
```

Whitelisted subsection názvy: `Check`/`Checks`, `Script`/`Scripts`, `Judge`/`warn-Judge` (case-insensitive). Jiné `###` headery v promptu nelámou parsing — udělají z něj jen obsah aktivní subsekce.

Bez subsekcí by:
- multi-line bash script musel být na jednom řádku (nečitelné),
- multi-judge nešel zapsat (nebylo by kde dát samostatný prompt pro každý judge).

Plán mluví jen o flat formátu — subsection vznikl, jakmile začaly přibývat scénáře s netriviální validací.

### Multi-judge bloky + per-judge model override

Plán mluví o "LLM judge" jako o jednom checkpointu (jeden verdict). Implementace povoluje N samostatných `### Judge` bloků v jednom checkpointu (`shared/src/judge.ts:52-88, 412-456`) — každý je samostatný LLM call s vlastním verdiktem. Agregace: jakýkoli judge s fail severity a `verdict=fail` → celý checkpoint fail.

Per-judge model override skrz syntaxi v hlavičce bloku:
- `### Judge` — default (`JUDGE_MODEL` z `constants.ts`, dnes `claude-sonnet-4-6`)
- `### Judge (opus)` / `(haiku)` / `(sonnet)` — alias z `JUDGE_MODEL_MAP` (`constants.ts:2-6`)
- `### Judge (claude-opus-4-6)` — plné model ID
- `### warn-Judge` / `### warn-Judge (haiku)` — warning severity (fail verdikt → `warning`, ne `fail`)

Typický pattern: levný haiku pre-check (musí projít vždy) + drahý opus deep-dive (jen na komplexních scénářích) + jeden warn-Judge na "nice to have" kritéria, která zatím nechceme blokovat. Bez multi-judge by se to muselo skládat z víc checkpointů, což zhoršuje agregaci a čitelnost dataset výstupu.

CLAUDE.md "LLM Judge" má kompletní syntaxi, runner README ukazuje příklad scénáře.

### `warn-` severity prefix napříč všemi check typy

Plán definuje 3 verdikty (`pass | fail | unclear`); implementace má 5 (`pass | fail | warning | unclear | platform_failure`). `warning` se přidává přes prefix `warn-`, který funguje na **všech** check typech (`shared/src/judge.ts:113-115`):

- `warn-contains:`, `warn-regex:`, `warn-json-schema:`
- `warn-script:`, `warn-jq:`
- `### warn-Judge`, `### warn-Judge (haiku)` (kombinace s model override)

Fail výsledek u `warn-`-prefixed checku se mapuje na verdict `warning` místo `fail`. V agregaci `warning` **neblokuje overall pass**.

Motivace: gradual rollout nových kritérií (uvidím v datasetu, kolikrát to selhalo, než to povýším na hard fail), nice-to-have asserts ("ideálně použij X, ale nepadej").

CLAUDE.md a runner README mají syntaxi.

### Judge jako full Claude agent s workspace accessem

Plán mluví o LLM judgi jako o text classifieru ("LLM judge via CLI subprocess … structured output"). Realita je výrazně silnější: judge je standardní `claude -p` subprocess s `--dangerously-skip-permissions`, takže má **plný toolset** (Read, Bash, Glob, …) a může sám prohledávat workspace.

Commit `d0740f4` ("Remove SDK judge — CLI judge is strictly better") to drží jako vědomé rozhodnutí — SDK judge byl smazán, protože by ztratil tool access.

Důsledky pro autora scénáře:
- LLM judge prompt může říct "verify by reading `output.json`" nebo "run `apify run` and check the dataset" a judge to skutečně udělá.
- Workspace soubory se ale **nemusí** ručně cpát do promptu — runner sám sestaví listing a předá ho judgovi spolu s instrukcí "use Read/Bash to inspect them" (`judge.ts:418-432`).
- Stejně tak conversation log s tool calls (`formatConversationLog`) — judge vidí celou trajectory, ne jen finální agent text.

Plný shape promptu, který judge dostane, je zdokumentovaný v CLAUDE.md "Co judge dostane v promptu".

Související commits:
- `e34297f` "Add 5-min timeout on judge, remove max-turns limit, soft budget in prompt" — judge má jen soft 5-min budget, žádný max-turns. Může turnů použít, kolik potřebuje na inspekci.
- `fa1a4e4` "Remove all data truncation — full content everywhere" — judge dostává **plný** agent output, **plný** conversation log, **plný** seznam workspace souborů.
- `f777097` "Restore workspace files in judge prompt, no file truncation" — workspace listing zpět v promptu po experimentu s pointers.

### `### eval-Judge` — třetí judge severity (meta-eval frameworku)

Plán definuje LLM judge jako evaluator agent výstupu. Implementace přidává **třetí severity** `eval` (`### eval-Judge`, `judge.ts:79-86`), která **hodnotí kvalitu eval frameworku, ne agent výstupu**:

- Používá `EVAL_REVIEW_SCHEMA` místo `VERDICT_SCHEMA` (`claude.ts:43-57`).
- Výstup: `{eval_gap_severity: "critical" | "noncritical" | "ok", reasoning}`.
  - `critical` — eval framework míjí klíčové cíle nebo má chyby, které by propustily evidentně špatný output
  - `noncritical` — drobné mezery, ale agentova kvalita se odhalí
  - `ok` — eval framework je solidní
- `CheckVerdict.checkType = 'eval-review'`, `verdict = 'pass'` (vždy), `evalGapSeverity` field nese skutečnou informaci.
- **`computeOverall` ho vylučuje** (`judge.ts:480`) — eval-Judge nikdy neshodí pass/fail celkového checkpointu.

Použití: na konec checkpointu připojit `### eval-Judge` s promptem typu "Are these checks rigorous enough to catch a subtly wrong answer?". V datasetu pak filtrovat na `evalGapSeverity = critical` → seznam scénářů, které je třeba opravit.

Rozdíl proti `eval_critique`: ten je side-field na **běžném** Judge (volitelná kritika, mimochodem). `eval-Judge` je **dedikovaný** check s vlastním schematem a explicitní severity. Doplňují se.

## Design decisions: shipped smaller than planned

### US8/US9 (Tool Discoverability + Parameter Correctness) — `jq:` místo dedikovaného subsystému

Plán a `docs/05-tool-discovery-eval.md` (now superseded) navrhovaly:
- nový YAML frontmatter blok `expectedTools: { required: [...], forbidden: [...], optional: [...] }`,
- nový `tool-params:` checkpoint typ pro parameter assertions,
- nový output field `discoverability: { discoverabilityScore, missingTools, extraTools, forbiddenToolsUsed }`,
- vlastní agregační logika nad tím vším.

Realizace: nic z toho. Místo toho **autor scénáře píše `jq:` checkpointy nad event streamem**:

```
jq: [.[] | select(.name=="Bash")] | length > 0          # musí použít Bash
jq: [.[] | select(.name=="WebSearch")] | length == 0    # nesmí WebSearch
warn-jq: [.[] | ... | select(test("apify call"))] | length > 0   # ideálně apify call
jq: [.[] | ... | .input.command? // "" | select(test("--user-agent"))] | length > 0  # parameter check
```

Důvody pro tenhle posun:
1. `jq:` checkpoint typ už existuje pro jiné účely (`60b6271`) — žádný nový kód.
2. `warn-` prefix už existuje — okamžitě dostaneme dvě úrovně severity (fail/warning) zdarma.
3. Agregace už existuje — `jq:` verdikty tečou do stejného `computeOverall`.
4. Expressivita: `jq` umí libovolnou booleovskou logiku, regex, drill-down do `input` parametrů. Stejně silné jako parameter check, bez nového check typu.
5. Output schema zůstává čistý — žádný `discoverability` blok navíc, jen `verdicts[]` s explicit důvody.

Trade-off: scénáře jsou trochu **verbose** (delší jq výrazy v checkpointu vs. krátký `required: [Bash]` list). To se ale platí jen jednou — `jq` patterny jsou copy-paste a runner README/CLAUDE.md je má jako template.

**Legacy syntax (deprecated, stále parsuje):** `## Expected Tools` sekce + `expectedTools` YAML frontmatter. Parser je z důvodů zpětné kompatibility čte, ale runner je nikam nepředává. Pole `TestCase.expectedToolCalls` má `@deprecated` JSDoc — odstranit při příštím dead-code sweepu (`shared/src/types.ts`, `scenario-parser.ts:43, 59-68`).

### US11 (Custom Agent Configuration per Scenario) — runner input fields místo scenario frontmatter

Plán navrhoval `language`, `template`, `actorSpec` frontmatter pole, jejichž obsah by parser injektoval do system promptu a init scriptu. Realizace: nepostaveno, konfigurace agenta žije **na úrovni runner inputu**, ne scénáře:

| Plánováno (frontmatter) | Realizováno (runner input) |
|--|--|
| `language: typescript` | `systemPrompt: "...use TypeScript..."` |
| `template: cheerio-crawler` | `initBashScript: "apify create --template cheerio-crawler ..."` |
| `actorSpec: { ... }` | `systemPrompt` plus `initBashScript` zapíše spec do workspace souboru |

Důvody:
1. Stejný scénář lze pustit s různými konfiguracemi (`systemPrompt` per run, ne per scenario), bez kopírování souboru.
2. Žádný nový parsing — scenario formát zůstává minimální.
3. Nepotřebujeme rozumět doménově specifickým polím (`language`/`template`) v parseru.

Trade-off: per-scenario konfigurace musí žít mimo scenario soubor (typicky v eval inputu nebo wrapper skriptu). Pro většinu eval workflows to vyhovuje — orchestrátor Fáze 3 stejně bude generovat runner inputy programaticky.

## Workspace conventions

### Per-run workspace isolation

Každý agent (a každý retry) běží v izolovaném `/tmp/eval-workspace-<uuid8>/` (`actors/runner/src/main.ts:61`). Runner image patří rootovi; agent může psát jen do `/tmp`. Scénář `security-isolation.md` toto explicitně testuje.

Důsledky:
- Script checkpointy dědí ten samý cwd → vidí soubory, které agent vytvořil.
- Stažené Apify datasety jdou do `<workspace>/eval-datasets/<id>.json` (viz Judge enhancements).
- Runner zapisuje vlastní bookkeeping soubory do SIBLING dir `/tmp/eval-meta-<uuid8>/`, NIKDY do workspace:
    - `trajectory.json` — raw trajectory data po agentově běhu (psáno z `main.ts`)
    - `checkpoint.json` + `check-results.json` — parsed checkpoint spec + judged verdicts (psáno z `judge.ts`)
    Proč mimo workspace: (a) `apify push` bundluje jen workspace, takže runner soubory nemohou leakovat do deployed Actoru; (b) workspace zůstává čistý — žádné framework artefakty se nemísí s agentovými, takže měření (např. "vytvořil agent `.actorignore`?") nejsou kontaminována.
- Script + jq checkpointy dostanou cestu k meta dir přes `$EVAL_META_DIR` environment variable, kterou runner injektuje JEN do checkpoint subprocessu (ne do agentova). Agent meta dir nevidí — runner je pro něj neviditelný. Příklad použití v checkpoint skriptu: `cat "$EVAL_META_DIR/check-results.json"`.
- Retry s `maxRetries > 0` vytvoří nový workspace **a nový meta dir** (oba sdílí UUID) — init script i plugin detection se spustí znovu.

Tahle konvence není v původním plánu — vznikla při Day 4 cleanup, ale autoři script checkpointů ji potřebují znát, aby věděli kde co hledat.

### Retry s fresh workspace (experimental)

Plán nezmiňuje retry mechanismus. Implementace ho měla a má (`actors/runner/src/main.ts:104-123`, `maxRetries` input, max 5), ale **status feature se posunul**:

| Commit | Datum | Stav |
|--------|-------|------|
| `19b76ce` | 2026-05-05 | Retry implementován jako plnohodnotná feature, přidána `retryAttempts` metrika. |
| `a427938` | 2026-05-13 ráno | Hardening — každý retry pokus dostane **fresh workspace** (nový uuid) a znovu projde init scriptem i plugin detekcí. |
| `48a7b53` | 2026-05-13 odpoledne | **Downgrade na experimental** v runner README. Doporučená hodnota `maxRetries: 0` (jeden run per actor call). |

Důvod downgradu: retry sice eliminoval kontaminaci workspace mezi pokusy, ale **non-determinismus zůstává** v agent caching, auth state, modelu samém. Retry tedy nezachrání flaky test reliable způsobem — jen maskuje, že scénář není deterministický. Lepší je škálovat počty runs orchestrátorem (Fáze 3, mimo scope tohoto auditu) a počítat success rate, ne retry-až-prošlo.

Mechanismus je stále v kódu a funguje, jen ho aktivně nedoporučujeme:
- Runner README má `⚠️` warning u `maxRetries`.
- Input schema má v titulku i description `(experimental)`.
- `retryAttempts` se stále loguje, ale typicky bude 0.

Připomínka: pokud Fáze 3 (orchestrator) přijde s mean±stddev agregací, retry by mohl být úplně odstraněn — orchestrator přirozeně řeší non-determinismus N opakováními.

## Output schema extensions

### `LIVE-AGENT-LOG` / `LIVE-JUDGE-LOG` — real-time KV streaming

Plán postuluje finální logy v KV store (`CONVERSATION-LOG`, `JUDGE-LOG`) zapsané po skončení runu. Implementace přidává **dva live klíče**, které runner zapisuje **průběžně** během běhu:

- `LIVE-AGENT-LOG` (`actors/runner/src/main.ts:148`) — každý raw NDJSON řádek z agentova stdout se v reálném čase appenduje do KV. Díky `--include-partial-messages` (commit `7e86d99`) jsou v streamu `stream_event` eventy s `text_delta` / `thinking_delta` → log roste **token po tokenu**, ne až per turn nebo per tool call.
- `LIVE-JUDGE-LOG` (`main.ts:252`, commit `cf24163`) — totéž pro každý LLM judge call, taky token-by-token.

Hodnota pro vývojáře scénářů: při psaní nového scénáře nemusíš čekat na konec runu, abys viděl, co agent dělá. V Apify Console otevři KV store, klikni na `LIVE-AGENT-LOG`, refreshuj — vidíš živý event stream, který tools agent volá, jak interpretuje prompt. **Drasticky zrychluje first-run debugging** — místo "spusť, počkej 5 minut, podívej se na finální log, fixni, opakuj" je to "spusť, otevři live log, zruš run jakmile vidíš problém, fixni".

Po skončení runu zůstávají oba `LIVE-*` klíče v KV vedle finálních logů — duplicita je úmyslná, finální `CONVERSATION-LOG` má secrets masked, `LIVE-*` jsou raw.

Související commity: `48a7b53` (LIVE-AGENT-LOG), `cf24163` (LIVE-JUDGE-LOG), `7e86d99` (stream partial messages přes `--include-partial-messages`, aby live log dával smysl i v rámci jednoho turnu).
