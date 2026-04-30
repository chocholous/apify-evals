/**
 * Spike S5: Env var injection + masking
 *
 * Ověřuje bezpečné předání env vars do claude subprocess + maskování v logu.
 *
 * Pass kritérium: Agent má přístup k env vars, ale v JSONL logu jsou maskovány.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const SECRETS = {
  MY_SECRET_TOKEN: "super-secret-value-12345",
  GITHUB_TOKEN: "ghp_fake0123456789abcdef",
};

function maskSecrets(text: string, secrets: Record<string, string>): string {
  let masked = text;
  for (const [key, value] of Object.entries(secrets)) {
    if (value.length >= 4) {
      masked = masked.replaceAll(value, `***${key}***`);
    }
  }
  return masked;
}

async function main() {
  console.log("=== Spike S5: Env var injection + masking ===\n");

  const prompt = `Run this exact bash command and show me the output: printenv MY_SECRET_TOKEN && printenv GITHUB_TOKEN`;

  console.log("Injecting env vars:", Object.keys(SECRETS).join(", "));
  console.log("Running claude with secrets in env...\n");

  const child = spawn("claude", [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--max-turns", "3",
    "--no-session-persistence",
    "--allowedTools", "Bash",
    "--dangerously-skip-permissions",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...SECRETS },
  });

  const rl = createInterface({ input: child.stdout });

  const rawLines: string[] = [];
  const maskedLines: string[] = [];
  let secretLeakedInRaw = false;
  let secretLeakedInMasked = false;
  let agentAccessedSecrets = false;

  rl.on("line", (line) => {
    if (!line.trim()) return;

    rawLines.push(line);
    const masked = maskSecrets(line, SECRETS);
    maskedLines.push(masked);

    for (const value of Object.values(SECRETS)) {
      if (line.includes(value)) {
        secretLeakedInRaw = true;
      }
      if (masked.includes(value)) {
        secretLeakedInMasked = true;
      }
    }

    try {
      const event = JSON.parse(line);
      // Check if agent's response mentions the secret values
      if (event.type === "assistant" && event.message?.content) {
        const text = JSON.stringify(event.message.content);
        for (const value of Object.values(SECRETS)) {
          if (text.includes(value)) {
            agentAccessedSecrets = true;
          }
        }
      }
    } catch { /* non-JSON line */ }
  });

  child.on("close", (code) => {
    console.log(`Exit code: ${code}`);
    console.log(`Total raw lines: ${rawLines.length}`);
    console.log(`Secrets present in raw output: ${secretLeakedInRaw}`);
    console.log(`Secrets present in masked output: ${secretLeakedInMasked}`);
    console.log(`Agent accessed secrets: ${agentAccessedSecrets}\n`);

    // Show a sample masked line
    const sampleMasked = maskedLines.find((l) => l.includes("***"));
    if (sampleMasked) {
      console.log("Sample masked line (truncated):");
      console.log(`  ${sampleMasked.slice(0, 200)}...\n`);
    }

    const maskingWorks = secretLeakedInRaw && !secretLeakedInMasked;
    const envInjectionWorks = agentAccessedSecrets || secretLeakedInRaw;

    console.log("--- Results ---");
    console.log(`  Env injection works: ${envInjectionWorks}`);
    console.log(`  Masking removes secrets: ${maskingWorks}`);
    console.log(`  Raw has secrets: ${secretLeakedInRaw}`);
    console.log(`  Masked has secrets: ${secretLeakedInMasked}`);

    const pass = envInjectionWorks && !secretLeakedInMasked;
    console.log(`\n=== SPIKE S5: ${pass ? "PASS" : "FAIL"} ===`);
    if (pass) {
      console.log("- Env vars successfully passed to claude subprocess");
      console.log("- Simple string replacement masking works");
      console.log("- Masked JSONL log is safe to store");
    }
  });
}

main();
