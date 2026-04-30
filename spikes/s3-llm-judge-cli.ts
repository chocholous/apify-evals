/**
 * Spike S3: LLM judge přes claude -p + --json-schema
 *
 * Místo přímého Anthropic SDK volání používáme claude CLI jako judge.
 * Výhoda: funguje s OAuth tokenem, stejný mechanismus jako agent run.
 *
 * Pass kritérium: Vrátí {verdict: "pass"|"fail"|"unclear", evidence: string, confidence: number}
 */

import { spawn } from "node:child_process";

const VERDICT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["pass", "fail", "unclear"],
      description: "pass = checkpoint fully satisfied, fail = clearly not satisfied, unclear = cannot determine",
    },
    evidence: {
      type: "string",
      description: "Specific evidence from the agent output that supports your verdict. Quote relevant parts.",
    },
    confidence: {
      type: "number",
      description: "Confidence in your verdict (0.0 to 1.0)",
    },
  },
  required: ["verdict", "evidence", "confidence"],
});

interface Verdict {
  verdict: "pass" | "fail" | "unclear";
  evidence: string;
  confidence: number;
}

function judgeCheckpoint(agentOutput: string, checkpoint: string): Promise<Verdict> {
  return new Promise((resolve, reject) => {
    const prompt = `You are an evaluation judge. Determine whether the agent's output satisfies the checkpoint criteria.

## Agent Output
${agentOutput}

## Checkpoint Criteria
${checkpoint}

Evaluate carefully and return your verdict.`;

    const child = spawn("claude", [
      "-p", prompt,
      "--output-format", "json",
      "--json-schema", VERDICT_SCHEMA,
      "--model", "claude-haiku-4-5-20251001",
      "--max-turns", "3",
      "--no-session-persistence",
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });

    child.on("close", (code) => {
      try {
        const result = JSON.parse(stdout);
        if (result.structured_output) {
          resolve(result.structured_output as Verdict);
        } else if (code !== 0) {
          reject(new Error(`claude exited with code ${code}: ${result.errors?.join(", ") ?? stderr.slice(0, 500)}`));
        } else {
          reject(new Error(`No structured_output in result: ${stdout.slice(0, 500)}`));
        }
      } catch {
        reject(new Error(`Failed to parse result JSON (code ${code}): ${stdout.slice(0, 300)} | stderr: ${stderr.slice(0, 200)}`));
      }
    });
  });
}

async function main() {
  console.log("=== Spike S3: LLM judge přes claude -p + --json-schema ===\n");

  const tests = [
    {
      name: "PASS case",
      expected: "pass",
      output: "The capital of France is Paris. It has been the capital since the 10th century.",
      checkpoint: "The answer must state that Paris is the capital of France.",
    },
    {
      name: "FAIL case",
      expected: "fail",
      output: "The largest city in France is Lyon with over 2 million people.",
      checkpoint: "The answer must correctly identify Paris as the largest city in France.",
    },
    {
      name: "UNCLEAR case",
      expected: "unclear",
      output: "I found several issues in the repository but couldn't access the specific one due to rate limiting.",
      checkpoint: "The GitHub issue #1234 about 'Fatal error in Playwright' must be found, and the author's website URL must be https://karel.com",
    },
  ];

  const results: Array<{ test: string; expected: string; actual: string; confidence: number; evidence: string }> = [];

  for (const t of tests) {
    console.log(`--- ${t.name} (expected: ${t.expected}) ---`);
    const start = Date.now();
    const verdict = await judgeCheckpoint(t.output, t.checkpoint);
    const elapsed = Date.now() - start;
    console.log(`  Verdict: ${verdict.verdict} (confidence: ${verdict.confidence}) [${elapsed}ms]`);
    console.log(`  Evidence: ${verdict.evidence}\n`);
    results.push({ test: t.name, expected: t.expected, actual: verdict.verdict, confidence: verdict.confidence, evidence: verdict.evidence });
  }

  const passCount = results.filter((r) => r.actual === r.expected).length;

  console.log("--- Summary ---");
  for (const r of results) {
    const ok = r.actual === r.expected ? "OK" : "MISMATCH";
    console.log(`  ${r.test}: expected=${r.expected}, actual=${r.actual} confidence=${r.confidence} [${ok}]`);
  }

  console.log(`\n=== SPIKE S3: ${passCount >= 2 ? "PASS" : "FAIL"} (${passCount}/3 correct) ===`);

  if (passCount >= 2) {
    console.log("- claude -p + --json-schema forces structured verdict");
    console.log("- Works with OAuth token (no ANTHROPIC_API_KEY needed)");
    console.log("- Judge via CLI subprocess = same mechanism as agent run");
  }
}

main().catch(console.error);
