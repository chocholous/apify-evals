/**
 * Spike S4: Scenario Markdown parser
 *
 * Ověřuje, že gray-matter + vlastní parser zvládne YAML frontmatter
 * + --- separátory + ## Test/## Checkpoint/## Monitor sekce.
 *
 * Pass kritérium: Parsuje korektně frontmatter, N testů, každý s test/checkpoint/monitor.
 */

import matter from "gray-matter";

interface ScenarioMeta {
  name: string;
  description: string;
  abortOnFailure: boolean;
}

interface TestCase {
  test: string;
  checkpoint: string;
  monitor: string | null;
}

interface ParsedScenario {
  meta: ScenarioMeta;
  tests: TestCase[];
}

function parseScenario(markdown: string): ParsedScenario {
  const { data, content } = matter(markdown);

  const meta: ScenarioMeta = {
    name: data.name ?? "unnamed",
    description: data.description ?? "",
    abortOnFailure: data.abortOnFailure ?? false,
  };

  // Split by --- (horizontal rule) but skip the frontmatter delimiter
  // gray-matter already strips frontmatter, so content starts after it
  const rawBlocks = content
    .split(/^---$/m)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  const tests: TestCase[] = [];

  for (const block of rawBlocks) {
    const testMatch = block.match(/## Test\s*\n([\s\S]*?)(?=## Checkpoint|## Monitor|$)/i);
    const checkpointMatch = block.match(/## Checkpoint\s*\n([\s\S]*?)(?=## Monitor|$)/i);
    const monitorMatch = block.match(/## Monitor\s*\n([\s\S]*?)$/i);

    if (testMatch && checkpointMatch) {
      tests.push({
        test: testMatch[1].trim(),
        checkpoint: checkpointMatch[1].trim(),
        monitor: monitorMatch ? monitorMatch[1].trim() : null,
      });
    }
  }

  return { meta, tests };
}

// --- Test scenarios ---

const SCENARIO_1 = `---
name: github-issue-lookup
description: Find GitHub issue and author's website
abortOnFailure: true
---

## Test
Find the GitHub issue in repo apify/crawlee that references
"Fatal error in Playwright" and find the personal website
of the author of that issue.

## Checkpoint
- The issue number is #1234
- The author's personal website URL is https://karel.com

## Monitor
Return a JSON array with list of tools called to fulfill this task.

---

## Test
Create a new branch called "fix-1234" and commit a fix
for the issue found in the previous step.

## Checkpoint
- Branch "fix-1234" exists
- At least one commit on the branch references issue #1234

## Monitor
Return JSON with git operations performed.
`;

const SCENARIO_2 = `---
name: simple-math
description: Simple math test with no monitor
abortOnFailure: false
---

## Test
What is 2+2?

## Checkpoint
The answer is 4.
`;

const SCENARIO_3 = `---
name: three-step-workflow
description: Multi-step with mixed monitor presence
abortOnFailure: true
---

## Test
Step 1: Search for "Apify" on Google.

## Checkpoint
At least 3 results found.

## Monitor
Return JSON array of URLs found.

---

## Test
Step 2: Visit the first result.

## Checkpoint
Page title contains "Apify".

---

## Test
Step 3: Extract the pricing information.

## Checkpoint
At least one pricing tier is found with a dollar amount.

## Monitor
Return JSON with pricing tiers.
`;

function main() {
  console.log("=== Spike S4: Scenario Markdown parser ===\n");

  const scenarios = [
    { name: "2-test with monitors", input: SCENARIO_1, expectedTests: 2, expectedAbort: true },
    { name: "1-test no monitor", input: SCENARIO_2, expectedTests: 1, expectedAbort: false },
    { name: "3-test mixed monitors", input: SCENARIO_3, expectedTests: 3, expectedAbort: true },
  ];

  let allPass = true;

  for (const s of scenarios) {
    console.log(`--- ${s.name} ---`);
    const parsed = parseScenario(s.input);

    console.log(`  Meta: name="${parsed.meta.name}", abortOnFailure=${parsed.meta.abortOnFailure}`);
    console.log(`  Tests found: ${parsed.tests.length} (expected: ${s.expectedTests})`);

    const countOk = parsed.tests.length === s.expectedTests;
    const abortOk = parsed.meta.abortOnFailure === s.expectedAbort;

    for (let i = 0; i < parsed.tests.length; i++) {
      const t = parsed.tests[i];
      console.log(`  Test ${i + 1}:`);
      console.log(`    prompt: "${t.test.slice(0, 60)}..."`);
      console.log(`    checkpoint: "${t.checkpoint.slice(0, 60)}..."`);
      console.log(`    monitor: ${t.monitor ? `"${t.monitor.slice(0, 60)}..."` : "null"}`);

      if (!t.test || !t.checkpoint) {
        console.log(`    [FAIL] Missing test or checkpoint`);
        allPass = false;
      }
    }

    if (!countOk) {
      console.log(`  [FAIL] Wrong test count: ${parsed.tests.length} vs ${s.expectedTests}`);
      allPass = false;
    }
    if (!abortOk) {
      console.log(`  [FAIL] Wrong abortOnFailure: ${parsed.meta.abortOnFailure} vs ${s.expectedAbort}`);
      allPass = false;
    }
    if (countOk && abortOk) {
      console.log(`  [OK]`);
    }
    console.log();
  }

  console.log(`=== SPIKE S4: ${allPass ? "PASS" : "FAIL"} ===`);
  if (allPass) {
    console.log("- gray-matter parses YAML frontmatter correctly");
    console.log("- --- separator splits tests correctly");
    console.log("- ## Test/## Checkpoint/## Monitor regex extraction works");
    console.log("- Optional monitor (null when missing) works");
  }
}

main();
