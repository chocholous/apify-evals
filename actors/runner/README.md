## What does Agent Evals Runner do?

**Agent Evals Runner** runs a testing scenario against an AI coding agent (Claude Code, Codex, or OpenCode) and evaluates the results automatically. It tells you whether the agent passed or failed each test, how much it cost, and how long it took.

Use it to benchmark AI agents, compare tool integration methods (MCP vs CLI vs mcpc), and catch regressions.

## How to use

1. Write a **scenario** in Markdown (see format below)
2. Choose an **agent** (Claude Code, Codex, or OpenCode)
3. Optionally set a **budget limit** and **environment variables** (API keys)
4. Run the Actor — results appear in the dataset

## Scenario format

A scenario is a Markdown file with one or more tests. Each test has a prompt and evaluation criteria:

```markdown
---
name: my-test
description: What this scenario tests
abortOnFailure: false
---

## Test
Find the GitHub issue about "memory leak" in repo acme/app
and tell me who reported it.

## Checkpoint
contains: @alice
regex: (issue|bug)\s*#?\d+
The answer should identify the correct issue author with evidence.

---

## Test
What is the reporter's most recent public repository?

## Checkpoint
script: curl -s "https://api.github.com/users/alice/repos?sort=updated" | jq -e '.[0].name'
The answer should name a real, currently existing repository.
```

### Scenario rules

- Tests are separated by `---`
- Each test needs `## Test` (the prompt) and `## Checkpoint` (evaluation criteria)
- Optional: `## Monitor` — a follow-up question about the agent's work
- YAML frontmatter: `name` (required), `description`, `abortOnFailure` (stop on first failure)

## Checkpoint syntax

You can combine multiple checks in one checkpoint. The test passes only if **all** checks pass.

### Deterministic checks (instant, free)

Write one per line with a prefix:

| Prefix | What it does | Example |
|--------|-------------|---------|
| `contains:` | Case-insensitive substring match | `contains: Jupiter` |
| `regex:` | Regular expression test | `regex: \d{4}-\d{2}-\d{2}` |
| `json-schema:` | Validates JSON output against schema | `json-schema: {"type":"object","required":["name"]}` |
| `script:` | Bash script (agent output on stdin, exit 0 = pass) | `script: jq -e '.status == "ok"'` |

### LLM Judge (smart, costs ~$0.001)

Any text without a prefix becomes a prompt for the LLM judge. It evaluates whether the agent's answer meets the criteria:

```
The answer must correctly identify the capital city and provide
at least one historical fact about it.
```

### Combining checks

```markdown
## Checkpoint
contains: Paris
regex: \b(founded|established|history)\b
The answer should be factually accurate and mention at least one landmark.
```

All three run: two deterministic checks + one LLM judge. Overall pass requires all to pass.

### Multi-line scripts (use subsections)

For complex validation scripts, use the `###` subsection format:

```markdown
## Checkpoint

### Checks
contains: success
json-schema: {"type":"object","required":["result"]}

### Script
output=$(cat)
if echo "$output" | jq -e '.result > 0' > /dev/null 2>&1; then
  echo "Result is positive: $(echo "$output" | jq '.result')"
  exit 0
else
  echo "Expected positive result"
  exit 1
fi

### Judge
The response should clearly explain what was computed and why.
```

## Advanced frontmatter

Beyond `name`, `description`, and `abortOnFailure`, scenarios support additional YAML fields:

```yaml
---
name: tool-discovery-eval
description: Test agent's ability to find and use MCP tools
abortOnFailure: false
language: TypeScript
template: ts-empty
expectedTools:
  required: [mcp__apify__call-actor, Bash]
  forbidden: [mcp__github__search]
  optional: [Read, Write]
actorSpec:
  name: my-scraper
  crawler: CheerioCrawler
  expectedOutput:
    fields: [title, url, price]
---
```

| Field | Purpose |
|-------|---------|
| `language` | Injected into system prompt ("Use TypeScript as the programming language") |
| `template` | Injected into system prompt ("Use the ts-empty template") |
| `expectedTools` | Measures tool discoverability — `discoverabilityScore` in output |
| `actorSpec` | Actor development specs injected into system prompt |

## Judge mode

Control how the LLM judge runs via the `judgeMode` input:

| Mode | How it works | When to use |
|------|-------------|-------------|
| `auto` (default) | Uses Anthropic SDK if `ANTHROPIC_API_KEY` is in env variables, falls back to `claude -p` CLI | Recommended — fastest available option |
| `cli` | Always uses `claude -p --json-schema` | When you only have an OAuth token |
| `sdk` | Always uses `@anthropic-ai/sdk` directly | When you want consistent fast judging (~5x faster) |

The SDK judge uses `tool_use` with Claude Haiku for structured verdicts. Deterministic checks (contains, regex, json-schema, script) are unaffected by judge mode.

## Init presets

Presets configure what tools the agent has access to:

| Preset | What the agent gets |
|--------|-------------------|
| None | No special tools — agent uses only built-in capabilities |
| MCP Native | MCP servers defined in your config JSON (Apify, GitHub, etc.) |
| CLI Native | Command-line tools (gh, apify-cli) |
| mcpc | MCP servers accessed via mcpc CLI bridge |

Choose different presets to compare how the same agent performs with different tool setups.

### MCP Config JSON example

When using "MCP Native" or "mcpc" preset, provide the server configuration:

```json
{
    "mcpServers": {
        "apify": {
            "command": "npx",
            "args": ["-y", "@apify/mcp-server"],
            "env": { "APIFY_TOKEN": "${APIFY_TOKEN}" }
        },
        "github": {
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-github"],
            "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
        }
    }
}
```

Token values like `${APIFY_TOKEN}` are resolved from your Environment Variables input.

## Output

Each test produces one dataset item with full results, metrics, and trajectory:

```json
{
    "agent": "claude-code",
    "model": "claude-sonnet-4-6",
    "scenarioName": "my-test",
    "testIndex": 0,
    "testPrompt": "Find the GitHub issue...",
    "checkpoint": "contains: @alice\n...",
    "agentOutput": "I found issue #42 reported by @alice...",
    "monitorOutput": null,
    "verdicts": [
        { "checkType": "contains", "checkValue": "@alice", "verdict": "pass", "evidence": "Output contains \"@alice\"", "confidence": 1.0 },
        { "checkType": "llm-judge", "checkValue": "The answer should...", "verdict": "pass", "evidence": "Agent correctly identified...", "confidence": 0.95 }
    ],
    "overallVerdict": "pass",
    "metrics": {
        "inputTokens": 4200,
        "outputTokens": 890,
        "cacheReadTokens": 3800,
        "cacheCreationTokens": 0,
        "totalCostUsd": 0.023,
        "durationMs": 12400,
        "durationApiMs": 8200,
        "numTurns": 3,
        "modelUsage": {}
    },
    "efficiency": {
        "totalContextTokens": 47100,
        "tokensPerTurn": 297,
        "costPerTurn": 0.0077,
        "cacheHitRate": 0.95,
        "contextOutputRatio": 53.0,
        "apiDurationRatio": 1.07,
        "avgTurnDurationMs": 4133
    },
    "trajectory": {
        "toolCallCount": 5,
        "toolCallSequence": ["Bash", "Read", "Bash", "Read", "Bash"],
        "uniqueToolsUsed": ["Bash", "Read"],
        "toolCallsPerTurn": 1.67,
        "perTurnTokens": [{"turn": 1, "input": 1200, "output": 300}, ...],
        "perTurnToolCalls": [{"turn": 1, "tools": ["Bash", "Read"]}, ...],
        "errorRecoveryCount": 0,
        "filesCreated": [],
        "filesModified": [],
        "commandsExecuted": ["gh issue list --repo acme/app", "gh issue view 42"],
        "mcpToolsUsed": []
    },
    "stopReason": "end_turn",
    "exitCode": 0,
    "aborted": false,
    "abortReason": null,
    "error": null
}
```

Full conversation logs are stored in the Key-Value Store:

| Key | Content | Format |
|-----|---------|--------|
| `CONVERSATION-LOG` | Agent's raw event stream (secrets masked) | NDJSON |
| `JUDGE-LOG` | Checkpoint evaluation details | NDJSON |
| `OTEL-TRACE` | OpenTelemetry trace with GenAI semantic conventions | OTLP JSON |

The OTel trace uses standard `gen_ai.*` attributes (tokens, tool calls, evaluations) and can be loaded into [AgentPrism](https://github.com/evilmartians/agent-prism), Jaeger, Langfuse, or any OTLP-compatible viewer.

## Cost estimation

| Model | Typical cost per test |
|-------|---------------------|
| claude-sonnet-4-6 | $0.01 – $0.05 |
| claude-opus-4-6 | $0.05 – $0.30 |

Use `maxBudgetUsd` to cap spending. The budget is a soft limit — checked between agent turns.

## Tips

- Start with simple `contains:` checks to verify basic functionality, then add LLM judge for quality
- Use `maxTurns: 3` for simple questions, `maxTurns: 10+` for complex multi-step tasks
- Set `abortOnFailure: true` when tests build on each other (test 2 depends on test 1)
- Use `script:` checkpoints to verify side effects (files created, API state changed)
- The Custom Init Script can install tools, download validators, or set up test fixtures

## Scenario cookbook

The repo includes 21 ready-to-use scenarios in the [`scenarios/`](../../scenarios/) directory:

| Scenario | What it tests |
|----------|--------------|
| `smoke-test.md` | Simplest possible test — one question, one checkpoint |
| `multi-check-demo.md` | All checkpoint types combined (contains, regex, json-schema, script, judge) |
| `script-validation.md` | Complex bash script validation with subsection format |
| `us1-ai-judge.md` | LLM judge with nuanced evaluation criteria |
| `us5-multi-step.md` | Multi-test scenario with `abortOnFailure` |
| `us6-env-vars.md` | Environment variable injection and secret handling |
| `us7-budget-abort.md` | Budget limits and graceful abort |
| `trajectory-test.md` | Rich trajectory data (tool calls, file operations) |
| `skill-injection.md` | Injecting CLAUDE.md/skills into agent workspace |
| `actor-dev/cheerio-scraper.md` | Full Apify Actor development evaluation |

Copy any scenario's content into the "Testing Scenario" input field to get started quickly.
