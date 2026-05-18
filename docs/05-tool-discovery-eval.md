# Tool Discovery & Actor Development Evals — Design Doc

> ⚠️ **SUPERSEDED.** Tento dokument byl design proposal pro US8/US9/US11. Realizace nakonec šla jinou (jednodušší) cestou:
>
> - **US8 Discoverability + US9 Parameter Correctness** → vyjádřené jako `jq:` checkpointy nad event streamem, ne jako dedikovaný subsystém s `expectedTools` frontmatter a `discoverabilityScore` outputem.
> - **US11 Custom Agent Config** → vyjádřené přes **runner input fields** (`systemPrompt`, `initBashScript`, `mcpConfigJson`), ne přes per-scenario frontmatter (`language`/`template`/`actorSpec`).
>
> Aktuální stav viz `docs/07-additional-features.md` (sekce "Judge enhancements" → jq checkpoint) a `actors/runner/README.md` ("Tool usage assertions"). Cíle US8/US9/US11 v `docs/01-plan.md` jsou aktualizované.
>
> Tento dokument je zachován jako historická stopa — design, který jsme nakonec nepostavili, protože existující primitivy (`jq:`, severity prefix, input fields) ten use case pokryly bez nové komplexity. Pozor: konkrétní syntaxe a outputy popsané dále (zejména `expectedTools` YAML pole, `## Expected Tools` sekce, `discoverability.discoverabilityScore` field, `tool-params:` check) v kódu **nejsou implementované** nebo jsou implementované jako no-op (parsované, ale ignorované).

## Motivace

Stávající US1-US7 hodnotí agenta na úrovni "splnil task? pass/fail". Nový use case (evaluace Apify Actor development) potřebuje hlubší metriky:

1. **Discoverability** — našel agent správné nástroje?
2. **Correctness** — volal je se správnými parametry?
3. **Output quality** — vytvořil fungující artefakt (Actor)?

Toto rozšiřuje eval z "co agent řekl" na "jak agent pracoval a co vytvořil".

---

## Nové User Stories

### US8: Tool Discoverability Scoring

Vývojář definuje v scénáři očekávané nástroje (`expectedTools`). Runner porovná s trajectory a vrátí discoverability metriky:
- Které expected tools agent použil / nepoužil
- Které extra/zakázané tools agent použil
- Skóre: |found ∩ expected| / |expected|

**Acceptance criteria:**
- Scenario frontmatter podporuje `expectedTools: { required: [...], forbidden: [...], optional: [...] }`
- Dataset output obsahuje `discoverability: { score, missingTools, extraTools, forbiddenToolsUsed }`
- Script checkpoint může validovat tool sequence (pořadí)

### US9: Tool Parameter Correctness

Vývojář definuje v scénáři novou sekci `## Expected Tools` s popisem jakých parametrů by tool calls měly obsahovat. Runner zachytí tool call inputs a vyhodnotí shodu.

**Acceptance criteria:**
- Trajectory obsahuje `toolCallInputs` (argumenty každého tool callu)
- Nový checkpoint typ `tool-params:` nebo LLM judge porovná actual vs expected parametry
- Metric: kolik tool calls mělo správné parametry

### US10: Actor Spec Validation

Vývojář testuje, zda agent vytvořil Apify Actor dle specifikace. Checkpoint ověří:
- Soubory existují (script checkpoint: `test -f src/main.ts`)
- Input schema odpovídá expectation (json-schema checkpoint na obsah souboru)
- Actor se buildí a produkuje output (script: `apify run`)
- Output matchuje expected strukturu (fuzzy match přes LLM judge)

**Acceptance criteria:**
- Script checkpoint může spouštět `apify run` a validovat output
- LLM judge porovná expected vs actual input schema
- Dataset output obsahuje Actor run result (items count, schema match)

### US11: Custom Agent Configuration per Scenario

Vývojář specifikuje v scénáři preferovaný jazyk, template, a init konfiguraci pro agenta:
- `language: typescript` → systémový prompt obsahuje "use TypeScript"
- `template: ts-empty` → init script provede `npx apify create --template ts-empty`
- `actorSpec: { ... }` → zadání předané agentovi v promptu

**Acceptance criteria:**
- Frontmatter podporuje `language`, `template`, `actorSpec`
- Runner inject do system promptu
- Init script může scaffold Actor z template

---

## Rozšíření Scenario formátu

### YAML Frontmatter — nová pole

```yaml
---
name: actor-dev-eval
description: Test Actor development with CheerioCrawler

# Stávající
abortOnFailure: true

# Nové: tool expectations
expectedTools:
  required: [Bash, Write, Read]
  forbidden: [WebSearch]
  optional: [Edit, Glob, Grep]

# Nové: agent configuration  
language: typescript
template: ts-empty
actorSpec:
  name: product-scraper
  description: Scrapes product names and prices
  expectedOutput:
    fields: [name, price, url]
    minItems: 5
---
```

### Nová sekce: `## Expected Tools`

Per-test deklarace tool expectations s parametry:

```markdown
## Expected Tools
Bash: npm init -y, npm install crawlee apify cheerio
Write: src/main.ts (must contain "CheerioCrawler"), .actor/actor.json, .actor/input_schema.json
Read: package.json
```

Parser extrahuje do:
```typescript
interface ExpectedToolCall {
    tool: string;
    parameterHint: string;  // "npm init -y, npm install crawlee..."
}
```

Vyhodnocení: porovnání s `trajectory.toolCallSequence` + LLM judge na parameter shodu.

---

## Nové metriky v output

### DiscoverabilityMetrics (per-test)

```typescript
interface DiscoverabilityMetrics {
    // From scenario frontmatter
    expectedRequired: string[];
    expectedForbidden: string[];
    expectedOptional: string[];
    // From trajectory
    actualTools: string[];
    // Computed
    missingTools: string[];        // required - actual
    extraTools: string[];          // actual - (required ∪ optional)
    forbiddenToolsUsed: string[]; // forbidden ∩ actual
    discoverabilityScore: number;  // |required ∩ actual| / |required|
    strictScore: number;           // 1.0 pokud zero missing + zero forbidden
}
```

### Rozšířená TrajectoryMetrics

```typescript
interface ToolCallDetail {
    tool: string;
    turn: number;
    input: Record<string, unknown>;  // actual arguments (truncated)
    output?: string;                 // tool result (truncated)
    durationMs?: number;             // if measurable
}

interface TrajectoryMetrics {
    // Stávající
    toolCallCount: number;
    toolCallSequence: string[];
    uniqueToolsUsed: string[];
    // ...
    
    // Nové: detailed tool calls (pro US9)
    toolCallDetails: ToolCallDetail[];
}
```

---

## Dopady na existující systém

### Co se mění

| Komponenta | Změna | Effort |
|-----------|-------|--------|
| `types.ts` | + `DiscoverabilityMetrics`, + `ToolCallDetail`, rozšířit `AgentResult` | S |
| `scenario-parser.ts` | Parsovat `expectedTools` z frontmatter, `## Expected Tools` sekci | M |
| `agents/run.ts` | Ukládat tool call inputs do `toolCallDetails` | M |
| `judge.ts` | Nový typ `tool-expectation` v checkpointu, vyhodnocení discoverability | M |
| `main.ts` | Compute discoverability score, přidat do AgentResult | S |
| `input_schema.json` | Dokumentovat nová pole | S |
| `CLAUDE.md` | Dokumentovat nový formát | S |

### Co se NEMĚNÍ

- Checkpoint systém (contains, regex, script, json-schema, llm-judge) — stávající typy stačí pro validaci Actor output
- Init presets — Actor development eval používá `customScript` pro scaffold
- Agent registry/run — parsery zůstávají stejné
- LLM judge — fuzzy matching schemas/output se dělá přes existující `### Judge` sekci

### Nové závislosti

Žádné — vše řešitelné stávajícími nástroji:
- Discoverability = set operace v TypeScriptu
- Parameter correctness = LLM judge
- Actor validation = script checkpoint (`apify run` + `jq`)
- Schema match = json-schema checkpoint na soubor (čtený v scriptu)

---

## Implementační fáze

### Fáze 2.1: Tool call details + discoverability (US8)
1. Rozšířit `run.ts` — sbírat tool call inputs (truncated na 500 chars)
2. Rozšířit `scenario-parser.ts` — parsovat `expectedTools` z frontmatter
3. Přidat `DiscoverabilityMetrics` do `AgentResult`
4. Compute score v `main.ts`

### Fáze 2.2: Parameter correctness (US9)
1. Parsovat `## Expected Tools` sekci
2. Přidat LLM judge porovnání expected vs actual params
3. Per-tool-call verdict

### Fáze 2.3: Actor spec validation (US10, US11)
1. Parsovat `actorSpec`, `language`, `template` z frontmatter
2. Inject do system prompt
3. Init script scaffold z template
4. Script checkpointy pro Actor validation (`apify run`)

---

## Příklad kompletního scénáře

```markdown
---
name: cheerio-scraper-eval
description: Agent creates a CheerioCrawler-based scraper
abortOnFailure: true
language: typescript
template: ts-empty
expectedTools:
  required: [Bash, Write]
  optional: [Read, Edit, Glob, Grep]
  forbidden: [WebSearch]
actorSpec:
  name: product-scraper  
  crawler: CheerioCrawler
  expectedOutput:
    fields: [name, price, url]
    minItems: 3
---

## Test
Create an Apify Actor that scrapes product listings from https://demo-shop.apify.org/products.
Use CheerioCrawler. Extract: product name, price, and URL for each product.
The Actor must have proper input_schema.json with startUrls field.

## Expected Tools
Bash: npm install crawlee apify cheerio
Write: src/main.ts (CheerioCrawler, requestHandler), .actor/actor.json, .actor/input_schema.json (startUrls)

## Checkpoint

### Checks
script: test -f src/main.ts && test -f .actor/actor.json && test -f .actor/input_schema.json

### Script
cd /usr/src/app/actors/runner
cat .actor/input_schema.json | jq -e '.properties.startUrls'
cat src/main.ts | grep -q "CheerioCrawler" || { echo "Missing CheerioCrawler"; exit 1; }
echo "Structure OK"

### Judge
The Actor should:
- Use CheerioCrawler (not PlaywrightCrawler) for performance
- Have a proper requestHandler that extracts name, price, and url
- Include error handling for missing elements
- Have input_schema.json with startUrls as requestListSources editor

---

## Test
Run the Actor locally and verify it produces output.

## Checkpoint

### Script
cd /usr/src/app/actors/runner
timeout 60 npx apify-cli run --purge 2>&1 || true
ITEMS=$(find storage/datasets -name "*.json" | head -20 | xargs cat 2>/dev/null | jq -s 'length')
if [ "$ITEMS" -gt 0 ]; then
  echo "Actor produced $ITEMS items"
  # Verify schema
  find storage/datasets -name "*.json" | head -1 | xargs cat | jq -e '.name and .price and .url'
else
  echo "No output produced"
  exit 1
fi

### Judge
The output items should have realistic product data with non-empty name, 
numeric price > 0, and valid URL format.
```

---

## Vztah k tokenovým metrikám

Pro US8-US11 jsou token metriky klíčové v kontextu **efektivity**:
- Agent A najde správné tools za 3 turny / $0.02
- Agent B najde správné tools za 8 turnů / $0.08
- Oba pass checkpoint, ale A je 4× efektivnější

Proto potřebujeme opravit:
1. `cacheHitRate` vzorec (potvrzeno na 3 runech)
2. `perTurnTokens` deduplikace (potvrzeno analýzou eventů)
3. `totalContextTokens` jako nové pole (reálný kontext poslaný modelu)

Tyto opravy jsou prerequisite pro smysluplné porovnání efektivity agentů (US3, US8).
