# Agent Evals

Evaluation framework for AI coding agents (Claude Code, Codex, OpenCode). Runs Markdown test scenarios, judges results automatically, compares tool integration methods (MCP vs CLI vs mcpc).

Built on [Apify](https://apify.com) — runs as a serverless Actor in Docker.

## Actors

- **[Agent Evals Runner](actors/runner/)** — runs one scenario with one agent, returns structured verdicts + metrics + trajectory. See its [README](actors/runner/README.md) for quickstart, scenario format, checkpoint syntax, and output reference.

## Project structure

```
shared/src/          Shared library (types, parsers, judge, agent adapters, OTel)
actors/runner/       Apify Actor — the eval runner
scenarios/           21 ready-to-use test scenarios
examples/            9 example input JSON files
docs/                Architecture decisions, research, build log
```

## Docs

- **[Runner README](actors/runner/README.md)** — quickstart, scenario format, checkpoint syntax, output reference
- [How we built it](docs/06-how-we-built-it.md) — 7-day build timeline
- [Architecture decisions](docs/02-decisions.md) — why standalone Docker, TypeScript, markdown scenarios
- [Implementation plan](docs/01-plan.md) — original phased plan with user stories
