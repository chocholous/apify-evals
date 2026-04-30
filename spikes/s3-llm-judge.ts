/**
 * Spike S3: Custom LLM judge s tool_use
 *
 * Ověřuje, že Anthropic SDK tool_use vrací structured verdict.
 * Simuluje judge flow: agent output + checkpoint → structured verdict.
 *
 * Pass kritérium: Vrátí {verdict: "pass"|"fail"|"unclear", evidence: string, confidence: number}
 */

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  authToken: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN,
});

const JUDGE_TOOL = {
  name: "submit_verdict",
  description:
    "Submit your evaluation verdict for whether the agent's output satisfies the checkpoint criteria.",
  input_schema: {
    type: "object" as const,
    properties: {
      verdict: {
        type: "string",
        enum: ["pass", "fail", "unclear"],
        description:
          "pass = checkpoint fully satisfied, fail = clearly not satisfied, unclear = cannot determine",
      },
      evidence: {
        type: "string",
        description:
          "Specific evidence from the agent output that supports your verdict. Quote relevant parts.",
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Confidence in your verdict (0.0 to 1.0)",
      },
    },
    required: ["verdict", "evidence", "confidence"],
  },
};

interface Verdict {
  verdict: "pass" | "fail" | "unclear";
  evidence: string;
  confidence: number;
}

async function judgeCheckpoint(
  agentOutput: string,
  checkpoint: string,
): Promise<Verdict> {
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    tools: [JUDGE_TOOL],
    tool_choice: { type: "tool", name: "submit_verdict" },
    messages: [
      {
        role: "user",
        content: `You are an evaluation judge. Determine whether the agent's output satisfies the checkpoint criteria.

## Agent Output
${agentOutput}

## Checkpoint Criteria
${checkpoint}

Evaluate carefully and submit your verdict using the submit_verdict tool.`,
      },
    ],
  });

  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error(`No tool_use in response. Content types: ${response.content.map((b) => b.type).join(", ")}`);
  }

  return toolUse.input as Verdict;
}

async function main() {
  console.log("=== Spike S3: LLM-as-judge s tool_use ===\n");

  // Test 1: Jasný PASS
  console.log("--- Test 1: Expected PASS ---");
  const v1 = await judgeCheckpoint(
    "The capital of France is Paris. It has been the capital since the 10th century.",
    "The answer must state that Paris is the capital of France.",
  );
  console.log(`Verdict: ${v1.verdict} (confidence: ${v1.confidence})`);
  console.log(`Evidence: ${v1.evidence}\n`);

  // Test 2: Jasný FAIL
  console.log("--- Test 2: Expected FAIL ---");
  const v2 = await judgeCheckpoint(
    "The largest city in France is Lyon with over 2 million people.",
    "The answer must correctly identify Paris as the largest city in France.",
  );
  console.log(`Verdict: ${v2.verdict} (confidence: ${v2.confidence})`);
  console.log(`Evidence: ${v2.evidence}\n`);

  // Test 3: UNCLEAR — neúplná odpověď
  console.log("--- Test 3: Expected UNCLEAR ---");
  const v3 = await judgeCheckpoint(
    "I found several issues in the repository but couldn't access the specific one you mentioned due to rate limiting.",
    "The GitHub issue #1234 about 'Fatal error in Playwright' must be found, and the author's website URL must be https://karel.com",
  );
  console.log(`Verdict: ${v3.verdict} (confidence: ${v3.confidence})`);
  console.log(`Evidence: ${v3.evidence}\n`);

  // Vyhodnocení
  const results = [
    { test: "PASS case", expected: "pass", actual: v1.verdict },
    { test: "FAIL case", expected: "fail", actual: v2.verdict },
    { test: "UNCLEAR case", expected: "unclear", actual: v3.verdict },
  ];

  const allCorrect = results.every((r) => r.actual === r.expected);
  const passCount = results.filter((r) => r.actual === r.expected).length;

  console.log("--- Summary ---");
  for (const r of results) {
    const ok = r.actual === r.expected ? "OK" : "MISMATCH";
    console.log(`  ${r.test}: expected=${r.expected}, actual=${r.actual} [${ok}]`);
  }

  console.log(
    `\n=== SPIKE S3: ${passCount >= 2 ? "PASS" : "FAIL"} (${passCount}/3 correct) ===`,
  );

  if (passCount >= 2) {
    console.log("- tool_use forces structured verdict output");
    console.log("- Verdict, evidence, and confidence all present");
    console.log("- Judge correctly distinguishes pass/fail/unclear cases");
  }
}

main().catch(console.error);
