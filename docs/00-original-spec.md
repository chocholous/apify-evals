# Original Specification: Evals for MCP, CLI, and in between

> Raw specification as received. Unedited.

## References

- https://www.notion.so/apify/AI-Engineer-The-MCP-haters-are-only-half-right-33ff39950a22808c89dbe163763b4083

## Inspiration

- https://github.com/garrytan/gbrain-evals
- https://axi.md/
- https://mcp-eval.ai/
- https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/1780#discussioncomment-16727576
- https://github.com/meta-engine/mcp-server/tree/main/benchmark

## Motivation

When developing Apify MCP server and Apify CLI, we need to understand the impact of the changes, so we need robust evals.

Additionally, to once and for all kill the MCP vs. CLI debate and show those two technologies are not exclusive but complementary, we'll present evals comparing performance of agents using naive MCP, modern MCP, native CLIs, other MCP CLIs, and mcpc, in various real-world scenarios, ie. including 3rd party tools like GitHub, Linear, …

## Use cases

- Testing mcpc vs. CLI vs. MCP — Jan Curn
- Testing Apify MCP server — Jiří Spilka, jakub.kopecky@apify.com
- Testing Actor development with AI agents (one-shot Actors) — Patrik Braborec, David Hanuš
- Testing Apify LLM chat — Honza Kuželík

## Actor #1 name (agentify/…): Agent Evals Runner

This Actor runs a single testing scenario (consisting of a sequence of one or more tests) with a single AI agent in a single environment.

Perhaps it could be implemented by metamorphing into https://apify.com/apify/ai-sandbox Actor, to take advantage of its persistency? For that we need to implement the env vars though.

### Input

- **Agent** (dropdown select): Claude Code, Codex CLI, OpenCode, AI SDK (to test Apify LLM chat), …later more
- **Model** (optional, textbox): Enables setting a specific LLM model. If empty, agent will use its default model
- **Max tokens** (optional, number): Maximum number of tokens for the test. If exceeded, the test is aborted. Use this to cap the spend.
- **System prompt** (textarea): General instructions for configuration. Used as a system prompt for the AI SDK agent, and for other agents, it's just sent to the agent at the start (after running the bash script).
- **Testing scenario** (Markdown file — fileupload input type): This Markdown file contains a full test scenario, which includes a sequence of one or more tests. See below for format.
- **Max retries on failure** (number): If LLM as judge check fails, the agent will be asked to retry this number of times. If 0, that means we'll fail right away if the scenario checkpoint failed.
- **Env variables** (JSON object with secure input): JSON object for API keys and secret stuff. The env vars will be available to the init bash script and then deleted.
- **MCP connectors**
- **Init bash script**: A shell script to set up e.g. native CLI like gh or linear, mcpc
  - mcp_native: MCP native (config.json)
  - cli_native: CLI native (install gh, playwright, …)
  - mcpc: MCP+CLI via mcpc (install mcpc+config.json)
  - mcp_cli_x: MCP+CLI other (install other CLIs, use config.json)
  - native_api: …

### Output

- Agent: Claude, OpenCode, version
- LLM model
- Track which tools were called
- How many tokens consumed how quickly (to draw charts)
- How many cache tokens were used?
- Success state of scenarios from LLM as judge (array of failed, passed, unclear)
- Agent log + full conversation — to help us tune our MCP, CLI etc. (we automatically remove the secret env var values from it, for safety)

## Actor #2 name: Agent Evals Orchestrator

- Agents (multiselect)
- Scenarios: more Markdown files
- Config presets: mcpc, …
- GitHub repo or Actor task …

## Evals Scenario Markdown format

This is the description of the format of the Markdown file.

```markdown
---
name: my-awesome-test
description: This is my testing scenario.
abortOnFailure: true
---

---

## Test
Test prompt — e.g. find GitHub issue referencing Fatal error,
and find the personal website of the author of the issue

## Checkpoint
Reference for a judge: expected output — the URL of home page is https://karel.com

## Monitor
Probe prompt — e.g. "Return a JSON array with list of Apify Actors
called to fulfill this task". Isn't this a trace?

---

## Test
(next test in sequence)

## Checkpoint
(next checkpoint)

## Monitor
(next monitor)
```

It's a Markdown file with well-defined format:
- Tests are separated by `---`
- Each scenario must contain: `## Test`, `## Checkpoint`, `## Monitor`
