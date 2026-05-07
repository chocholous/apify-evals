# Agent Evals

Evaluation framework for AI coding agents (Claude Code, Codex, OpenCode). Runs test scenarios, judges results automatically, compares tool integration methods (MCP vs CLI vs mcpc).

Built on [Apify](https://apify.com) platform — runs as a serverless Actor in Docker.

## Quick start

### 1. Write a scenario

```markdown
---
name: smoke-test
---

## Test
What is the capital of France? Answer in one sentence.

## Checkpoint
contains: Paris
The answer should be factually correct.
```

### 2. Run it

**On Apify Cloud** — paste the scenario into the [Runner Actor](https://console.apify.com/actors) input, pick an agent, hit Start.

**Locally:**
```bash
git clone https://github.com/chocholous/apify-evals.git
cd apify-evals
npm install
cd actors/runner
echo '{"agent":"claude-code","scenario":"---\nname: smoke-test\n---\n\n## Test\nWhat is 2+2? Answer with just the number.\n\n## Checkpoint\ncontains: 4\n","maxTurns":3}' > storage/key_value_stores/default/INPUT.json
apify run
```

### 3. Read results

Each test produces a dataset item with verdict, metrics, and full trajectory:

```json
{
  "overallVerdict": "pass",
  "metrics": { "totalCostUsd": 0.02, "durationMs": 8400, "numTurns": 2 },
  "trajectory": { "toolCallCount": 3, "uniqueToolsUsed": ["Bash", "Read"] }
}
```

Full conversation logs, judge details, and OTel traces are in the Key-Value Store.

## Checkpoint types

| Prefix | What it does | Cost |
|--------|-------------|------|
| `contains:` | Case-insensitive substring match | Free |
| `regex:` | Regular expression test | Free |
| `json-schema:` | Validates JSON output against schema | Free |
| `script:` | Bash script (agent output on stdin, exit 0 = pass) | Free |
| Plain text | LLM judge evaluates quality | ~$0.001 |

All checks in a checkpoint must pass for overall pass.

## Agents

| Agent | Status |
|-------|--------|
| Claude Code | Fully supported (streaming metrics, trajectory, cache) |
| Codex | Supported (cumulative usage, command/file tracking) |
| OpenCode | Supported (per-step tokens, cost aggregation) |

## Project structure

```
shared/src/          Shared library (types, parsers, judge, agent adapters, OTel)
actors/runner/src/   Apify Actor — runs one scenario with one agent
scenarios/           21 ready-to-use test scenarios
examples/            9 example input JSON files
docs/                Architecture decisions, research, build log
```

## Tests

```bash
cd shared
npx vitest run              # 194 unit + validation tests (~2s)
npx vitest run src/__tests__/integration*   # integration tests with live agent (~2min)
```

## Docs

- [How we built it](docs/06-how-we-built-it.md) — 7-day build timeline
- [Architecture decisions](docs/02-decisions.md) — why standalone Docker, TypeScript, markdown scenarios
- [Runner README](actors/runner/README.md) — full input/output reference, scenario cookbook
- [Implementation plan](docs/01-plan.md) — original phased plan with user stories
