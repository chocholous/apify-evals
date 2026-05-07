# How We Built Agent Evals

This project was built in 7 days (Apr 30 – May 6, 2026) by a human and Claude Code (Opus). The human set direction, made architectural decisions, and validated results. Claude wrote the code, tests, and documentation. Everything was built iteratively — spike first, implement, verify with real agent runs, then move on.

The codebase is ~2400 LOC of production TypeScript and ~2500 LOC of tests across 194 test cases, with 45 commits. No code was copy-pasted from other projects; patterns were borrowed from Apify's ai-sandbox but rewritten from scratch.

## Build timeline

1. **Day 1 — Spec + spikes.** Started with a project doc outlining goals. Ran 6 spike tests to validate key assumptions: Claude CLI streaming format, LLM-as-judge via `--json-schema`, subprocess env injection, budget abort behavior. Two spikes changed the plan (no SDK needed for judge, `--bare` flag broken).
2. **Day 1 — Monorepo scaffold.** npm workspaces with `shared/` library and `actors/runner/`. TypeScript, ESLint, Prettier. Scenario parser using gray-matter + regex.
3. **Day 1 — Shared library.** Claude adapter (`spawn` + NDJSON parsing), deterministic judge (contains/regex/json-schema/script), LLM judge, log masking. 33 unit tests.
4. **Day 1 — Runner Actor.** Full pipeline: parse scenario → run agent → judge checkpoints → push results. First successful cloud-like run locally.
5. **Day 1-2 — E2E + stability.** 13 end-to-end tests covering all MVP user stories. AI stability test (3 runs, 83% pass rate). Discovered 6 issues from real agent runs that unit tests couldn't catch.
6. **Day 2 — Init presets.** `mcp_native`, `cli_native`, `mcpc` presets for configuring agent environment. Custom bash script support.
7. **Day 2 — Cloud deploy.** Docker image with Claude CLI pre-installed. Discovered Alpine needs curl+bash, ownership issues with `/usr/src/app`. Fixed iteratively against real Apify Cloud builds.
8. **Day 3 — Multi-agent.** Generic agent registry replacing hardcoded Claude adapter. Added Codex with its quirks (stdin pipe-eof, cumulative usage, `cached_input_tokens` field name). OpenCode adapter followed.
9. **Day 3 — Fat Docker.** Single Dockerfile installing all three agent CLIs. Trajectory detection (tool calls, file ops from bash commands via regex + filesystem scan).
10. **Day 4 — Discoverability scoring.** `expectedTools` in scenario frontmatter. Runner compares declared vs. actual tool usage — measures whether agents find the right tools.
11. **Day 4 — Workspace isolation.** Agent runs in `/tmp/eval-workspace-*`, can't modify runner files. Judge sees workspace files for script checkpoints. Root owns app dir, agent writes only to `/tmp`.
12. **Day 4-5 — Metrics depth.** Per-turn token breakdown, planning vs execution turns, tool execution time, error recovery counting, cache hit rate. JudgeMetrics for judge cost/latency tracking.
13. **Day 5 — SDK judge + OTel.** Anthropic SDK judge (~5x faster than CLI judge, auto-detected via API key). OpenTelemetry instrumentation with GenAI semantic conventions, custom OTLP JSON exporter to KV store.
14. **Day 6 — Cleanup round 1.** Removed dead code (`runClaude`, `judgeCheckpoint` wrappers, unused frontmatter fields). Centralized magic numbers into `constants.ts`. Fixed transitive dependency issues.
15. **Day 6 — Cleanup round 2.** Deep codebase audit. Exported internal parsers for proper testing. Fixed unsafe `parentSpanContext` cast in OTel exporter. Replaced shell-interpolated `find` with `execFileSync`. Removed 4 dead exports. Rewrote parser tests from "reimplemented logic" to "test actual functions" — went from 174 to 194 tests.
16. **Key design decision: standalone Docker over metamorph.** Scored 8:2 vs. Apify's ai-sandbox metamorph pattern. Streaming subprocess control, multi-agent support, and version pinning made it worth owning the Dockerfile.
17. **Key design decision: markdown scenarios with YAML frontmatter.** Simpler than JSON schemas, version-controllable, human-readable. `## Test` / `## Checkpoint` / `## Monitor` sections with `---` separators for multi-step.
18. **Key design decision: deterministic checks first, LLM judge as fallback.** `contains:`, `regex:`, `json-schema:`, `script:` run with confidence 1.0 and zero cost. LLM judge only for subjective criteria. All checks must pass for overall pass.
19. **What we'd do differently: export parsers from day one.** Internal functions couldn't be tested directly, so early tests reimplemented parsing logic — a maintenance trap we caught only during the final audit.
20. **What we'd do differently: script checkpoints need sandboxing.** Currently they run as bash with full filesystem access. In a multi-tenant setup, this needs a proper sandbox (Docker-in-Docker or gVisor).
