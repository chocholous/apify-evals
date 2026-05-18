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
- **Retries (experimental):** `maxRetries` input re-runs a failed test. ⚠️ Retries create a fresh workspace but may produce inconsistent results due to agent caching, auth state, and non-determinism. Recommended: `maxRetries: 0` (default) — one run per actor call

## Checkpoint syntax

You can combine multiple checks in one checkpoint. The test passes only if **all** checks pass.

### Deterministic checks (instant, free)

Write one per line with a prefix:

| Prefix | What it does | Example |
|--------|-------------|---------|
| `contains:` | Case-insensitive substring match | `contains: Jupiter` |
| `regex:` | Regular expression test | `regex: \d{4}-\d{2}-\d{2}` |
| `json-schema:` | Validates JSON output against schema | `json-schema: {"type":"object","required":["name"]}` |
| `script:` | Bash script — agent **output** on stdin, exit 0 = pass | `script: jq -e '.status == "ok"'` |
| `jq:` | `jq -e` expression over the conversation **event stream** (tool calls, not output text) | `jq: [.[] \| select(.type=="assistant") \| .message.content[]? \| select(.name=="Bash")] \| length > 0` |

**`script:` vs `jq:`** — `script:` evaluates the agent's final text output. `jq:` evaluates the trajectory (every tool call, every event). Use `jq:` when you need to assert *what the agent did*, not just *what it said*.

**Warning severity (`warn-` prefix):** every check type accepts a `warn-` prefix (`warn-contains:`, `warn-regex:`, `warn-jq:`, `warn-script:`, `warn-json-schema:`). A failed warn-check produces a `warning` verdict that does **not** fail the overall checkpoint — useful for nice-to-have asserts you don't want to gate the test on yet.

### LLM Judge (smart, costs ~$0.001–$0.05)

Any text without a prefix becomes a prompt for the LLM judge. It evaluates whether the agent's answer meets the criteria:

```
The answer must correctly identify the capital city and provide
at least one historical fact about it.
```

The judge is a full Claude agent with **Read/Bash/Glob tool access** to the workspace — not just a text classifier. It automatically receives the agent's output, the conversation log (every tool call), and a listing of all files the agent created. You can write prompts like *"verify by reading `output.json`"* or *"run `apify run` and check the dataset"* and the judge will actually do it. Soft 5-minute budget per judge call, no turn limit.

### Combining checks

```markdown
## Checkpoint
contains: Paris
regex: \b(founded|established|history)\b
The answer should be factually accurate and mention at least one landmark.
```

All three run: two deterministic checks + one LLM judge. Overall pass requires all to pass.

### Multi-line scripts and multiple judges (use subsections)

For complex validation, use the `###` subsection format. You can have **multiple `### Judge` blocks** — each runs as a separate LLM evaluation:

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

### Judge (opus)
Evaluate the code quality and architecture decisions in detail.

### warn-Judge (haiku)
Does the response include helpful comments or documentation?
```

**Judge modifiers:**

| Syntax | Severity | Model |
|--------|----------|-------|
| `### Judge` | fail | sonnet (default) |
| `### Judge (opus)` | fail | opus |
| `### Judge (haiku)` | fail | haiku |
| `### warn-Judge` | warning | sonnet (default) |
| `### warn-Judge (opus)` | warning | opus |

- **fail severity** (default): if the judge returns `fail`, the overall checkpoint fails
- **warning severity** (`warn-`): if the judge returns `fail`, it's recorded as a warning — it won't fail the checkpoint
- **Model**: `haiku`, `sonnet`, `opus` (aliases) or a full model ID like `claude-opus-4-6`

Each judge returns `{verdict, reasoning}` — verdict is `pass`, `fail`, or `unclear`.

## Tool usage assertions (use `jq:`)

To check whether an agent used the right tools, or NOT used the wrong ones, write `jq:` checkpoints over the conversation event stream. The agent's tool calls are in `assistant` events as `tool_use` content blocks:

```markdown
## Checkpoint

### Checks
# Agent MUST use Bash
jq: [.[] | select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and .name=="Bash")] | length > 0

# Agent MUST NOT use WebSearch / WebFetch
jq: [.[] | select(.type=="assistant") | .message.content[]? | select(.type=="tool_use") | .name | select(test("^Web(Search|Fetch)$"))] | length == 0

# Ideally calls apify CLI with `actors call` (warning, not fail)
warn-jq: [.[] | select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and .name=="Bash") | .input.command? // "" | select(test("apify (actors )?call"))] | length > 0
```

Same mechanism covers **parameter correctness** — drill into `.input.command`, `.input.file_path`, etc. and `test("regex")` against the value.

The `jq:` approach replaced an earlier design with `expectedTools` frontmatter (`required`/`forbidden`/`optional` lists) and a baked-in `discoverabilityScore` output field. The new approach is more expressive (any jq query, severity per check, integrated into the same verdict aggregation) and required no special types or output fields.

> **Deprecation note:** older scenarios sometimes contain an `## Expected Tools` section or `expectedTools:` YAML frontmatter. Both are silently ignored by the runner today — the parser accepts them for backwards compatibility, but they don't affect verdicts or output. Convert them to `jq:` checks.

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

### Claude Code plugin auto-detection

If your init script places a `.claude-plugin/plugin.json` file at the workspace root, the runner automatically passes `--plugin-dir <workspace>` to Claude Code. The plugin's skills, hooks, and slash commands are then loaded for the agent — no extra input field needed. Typical setup:

```bash
git clone --depth 1 https://github.com/user/my-plugin.git _plugin
cp -r _plugin/.claude-plugin .claude-plugin
cp -r _plugin/skills skills
rm -rf _plugin
```

Note: Claude Code OAuth requires `CLAUDE_CODE=0` in `envVariables` and `ANTHROPIC_API_KEY` must not be set (even empty — it overrides OAuth).

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
    "agentOutputLength": 387,
    "monitorOutput": null,
    "verdicts": [
        { "checkType": "contains", "checkValue": "@alice", "verdict": "pass", "evidence": "Output contains \"@alice\"" },
        { "checkType": "llm-judge", "checkValue": "The answer should...", "verdict": "pass", "evidence": "Agent correctly identified the issue reporter @alice.", "evalCritique": "The check would also pass if the agent guessed a random @-handle — consider asserting the issue number too." }
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
        "avgTurnDurationMs": 4133,
        "toolExecutionMs": 4200,
        "planningTurns": 1,
        "executionTurns": 2
    },
    "trajectory": {
        "toolCallCount": 5,
        "toolCallSequence": ["Bash", "Read", "Bash", "Read", "Bash"],
        "uniqueToolsUsed": ["Bash", "Read"],
        "toolCallsPerTurn": 1.67,
        "perTurnTokens": [{"turn": 1, "input": 1200, "output": 300}],
        "perTurnToolCalls": [{"turn": 1, "tools": ["Bash", "Read"]}],
        "toolCallDetails": [{"tool": "Bash", "turn": 1, "input": {"command": "gh issue list --repo acme/app"}}],
        "errorRecoveryCount": 0,
        "filesCreated": [],
        "filesModified": [],
        "commandsExecuted": ["gh issue list --repo acme/app", "gh issue view 42"],
        "mcpToolsUsed": []
    },
    "judge": {
        "judgeCostUsd": 0,
        "judgeLatencyMs": 3200,
        "judgeTurns": 1
    },
    "retryAttempts": 0,
    "stopReason": "end_turn",
    "exitCode": 0,
    "aborted": false,
    "abortReason": null,
    "error": null,
    "hungWarnings": []
}
```

Notes on selected fields:
- `verdicts[].evalCritique` — present only on `llm-judge` checks where the judge flagged a weakness in the eval criteria itself (see `### Judge` / `### eval-Judge` in CLAUDE.md).
- `verdicts[].evalGapSeverity` — present only on `eval-review` verdicts (from `### eval-Judge`); value is `critical | noncritical | ok`.
- `judge.judgeCostUsd` is always `0` — the CLI judge runs as a `claude -p` subprocess that does not report token cost back. Use `judgeLatencyMs` and `judgeTurns` for judge cost estimation.
- `retryAttempts` is typically `0` (the default); see runner Tips on why retries are marked experimental.
- `hungWarnings` reports periods where the agent was silent for too long (`elapsedMs`, `silenceSecs`) — useful for diagnosing stuck runs.

Full conversation logs are stored in the Key-Value Store:

| Key | Content | Format | When |
|-----|---------|--------|------|
| `LIVE-AGENT-LOG` | Agent's raw event stream, streamed **token-by-token** as Claude generates output (`text_delta` / `thinking_delta`) | NDJSON | During run |
| `LIVE-JUDGE-LOG` | Judge's raw event stream, also token-by-token during each LLM judge call | NDJSON | During run |
| `CONVERSATION-LOG` | Final agent event stream (secrets masked) | NDJSON | After run |
| `JUDGE-LOG` | Final checkpoint evaluation details | NDJSON | After run |
| `OTEL-TRACE` | OpenTelemetry trace with GenAI semantic conventions | OTLP JSON | After run |

The two `LIVE-*` keys are written continuously as the agent (or judge) produces output. **Open them in Apify Console while a run is still going** — this is the fastest way to debug a new scenario, see what tools the agent is calling, and catch issues before the run finishes.

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
- If the agent runs an Apify Actor, its dataset is automatically downloaded into `eval-datasets/<datasetId>.json` in the workspace — your script checks and the LLM judge can read it directly

## Scenario cookbook

The repo includes 22 ready-to-use scenarios in the [`scenarios/`](../../scenarios/) directory:

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
