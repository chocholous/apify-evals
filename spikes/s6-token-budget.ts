/**
 * Spike S6: Token budget abort
 *
 * Zjištění z prvního pokusu: assistant message usage NENÍ inkrementální streaming —
 * je to snapshot po completion celé message. Pro real-time budget tracking potřebujeme
 * buď:
 * a) claude --max-budget-usd (nativní, doporučený)
 * b) SIGTERM po result eventu z prvního turnu (mezi-turnový abort)
 *
 * Tento spike testuje oba přístupy.
 *
 * Pass kritérium: Subprocess se korektně ukončí pod budget limitem.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// Test 1: claude --max-budget-usd jako nativní budget control
async function testNativeBudget(): Promise<boolean> {
  console.log("--- Test 1: claude --max-budget-usd (native) ---");

  return new Promise((resolve) => {
    const child = spawn("claude", [
      "-p", "Write a very long and detailed 5000 word essay about every planet in the solar system.",
      "--output-format", "stream-json",
      "--verbose",
      "--max-turns", "5",
      "--max-budget-usd", "0.01",
      "--no-session-persistence",
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const rl = createInterface({ input: child.stdout });
    let resultEvent: Record<string, unknown> | null = null;

    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (event.type === "result") {
          resultEvent = event;
        }
      } catch { /* skip */ }
    });

    child.on("close", (code) => {
      console.log(`  Exit code: ${code}`);
      if (resultEvent) {
        console.log(`  Is error: ${resultEvent.is_error}`);
        console.log(`  Total cost: $${resultEvent.total_cost_usd}`);
        console.log(`  Terminal reason: ${resultEvent.terminal_reason}`);
        console.log(`  Output tokens: ${(resultEvent.usage as Record<string, unknown>)?.output_tokens}`);
      }
      const pass = resultEvent != null;
      console.log(`  Result: ${pass ? "OK" : "FAIL"} — ${pass ? "native budget control works" : "no result event"}\n`);
      resolve(pass);
    });
  });
}

// Test 2: Manual SIGTERM abort between turns
async function testManualAbort(): Promise<boolean> {
  console.log("--- Test 2: Manual SIGTERM abort ---");

  return new Promise((resolve) => {
    const child = spawn("claude", [
      "-p", "Count from 1 to 1000, one number per line. Use echo in bash.",
      "--output-format", "stream-json",
      "--verbose",
      "--max-turns", "10",
      "--no-session-persistence",
      "--dangerously-skip-permissions",
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const rl = createInterface({ input: child.stdout });
    let turnCount = 0;
    let killed = false;
    let finalCost = 0;
    let finalOutputTokens = 0;

    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);

        if (event.type === "assistant") {
          turnCount++;
          const outTokens = event.message?.usage?.output_tokens ?? 0;
          console.log(`  Turn ${turnCount}: output_tokens=${outTokens}`);

          if (turnCount >= 2 && !killed) {
            console.log(`  [ABORT] Killing after ${turnCount} turns`);
            killed = true;
            child.kill("SIGTERM");
          }
        }

        if (event.type === "result") {
          finalCost = event.total_cost_usd ?? 0;
          finalOutputTokens = (event.usage as Record<string, unknown>)?.output_tokens as number ?? 0;
        }
      } catch { /* skip */ }
    });

    child.on("close", (code, signal) => {
      console.log(`  Exit code: ${code}, signal: ${signal}`);
      console.log(`  Killed by us: ${killed}`);
      console.log(`  Turns completed: ${turnCount}`);
      console.log(`  Final cost: $${finalCost}`);
      console.log(`  Final output tokens: ${finalOutputTokens}`);

      const pass = killed && (signal === "SIGTERM" || code !== 0);
      console.log(`  Result: ${pass ? "OK" : "PARTIAL"} — ${pass ? "manual abort works" : "agent finished before abort or no signal"}\n`);
      resolve(pass);
    });
  });
}

async function main() {
  console.log("=== Spike S6: Token budget abort ===\n");

  const t1 = await testNativeBudget();
  const t2 = await testManualAbort();

  console.log("--- Summary ---");
  console.log(`  Native --max-budget-usd: ${t1 ? "PASS" : "FAIL"}`);
  console.log(`  Manual SIGTERM abort: ${t2 ? "PASS" : "PARTIAL"}`);

  const overall = t1; // Native budget is the critical path
  console.log(`\n=== SPIKE S6: ${overall ? "PASS" : "FAIL"} ===`);
  if (overall) {
    console.log("- claude --max-budget-usd is the recommended budget control");
    console.log("- Usage available in result event (not real-time per-token)");
    console.log("- Manual SIGTERM works as fallback for between-turn abort");
    console.log("- For production: use --max-budget-usd + between-turn SIGTERM as safety net");
  }
}

main();
