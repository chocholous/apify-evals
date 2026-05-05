---
name: workspace-context-judge
description: Verify that LLM judge sees workspace files and can evaluate code quality
abortOnFailure: false
---

## Test
Create a file called app.ts with a simple Express-like HTTP server that:
- Listens on port 3000
- Has a GET / endpoint returning { status: "ok" }
- Has a GET /health endpoint returning { healthy: true }
- Has proper error handling middleware

Do NOT actually run the server, just create the file.

## Checkpoint

### Checks
script: test -f app.ts && echo "file exists"

### Judge
Evaluate the code in app.ts (which should be visible in the workspace files below).
The code should:
- Import or require a web framework (Express, Fastify, or built-in http)
- Define at least 2 route handlers (/ and /health)
- Return JSON responses with correct structure
- Include error handling (try/catch, error middleware, or error event handler)
- Be syntactically valid TypeScript

Rate the code quality. Pass if it meets all 5 criteria above.
