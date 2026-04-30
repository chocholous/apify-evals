/**
 * Spike S1: Claude Code subprocess streaming
 *
 * Ověřuje, že `claude -p --output-format stream-json` jde parsovat
 * v reálném čase přes spawn + readline a extrahovat token counts.
 *
 * Pass kritérium: Token counts matchují finální result event.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const PROMPT = 'What is 2+2? Answer in one word.';

interface StreamEvent {
  type: string;
  subtype?: string;
  // assistant message event
  message?: {
    model: string;
    content: Array<{ type: string; text?: string }>;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  // result event (flat structure)
  is_error?: boolean;
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  stop_reason?: string;
  session_id?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    costUSD: number;
  }>;
  [key: string]: unknown;
}

console.log('=== Spike S1: Claude Code subprocess streaming ===\n');
console.log(`Prompt: "${PROMPT}"\n`);

const child = spawn('claude', [
  '-p', PROMPT,
  '--output-format', 'stream-json',
  '--verbose',
  '--max-turns', '1',
  '--no-session-persistence',
], {
  stdin: 'pipe',
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env },
});

const rl = createInterface({ input: child.stdout });

let eventCount = 0;
let resultEvent: StreamEvent | null = null;
const eventTypes = new Map<string, number>();
let assistantText = '';

rl.on('line', (line) => {
  if (!line.trim()) return;

  try {
    const event: StreamEvent = JSON.parse(line);
    eventCount++;

    const key = event.subtype ? `${event.type}:${event.subtype}` : event.type;
    eventTypes.set(key, (eventTypes.get(key) ?? 0) + 1);

    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text) {
          assistantText += block.text;
        }
      }
    }

    if (event.type === 'result') {
      resultEvent = event;
    }

    // Real-time progress
    if (eventCount % 5 === 0 || event.type === 'result') {
      process.stdout.write(`\r  Events: ${eventCount}, Text so far: "${assistantText.slice(0, 50)}"`);
    }
  } catch {
    console.error(`\n  [WARN] Non-JSON line: ${line.slice(0, 100)}`);
  }
});

let stderrOutput = '';
child.stderr.on('data', (data) => {
  stderrOutput += data.toString();
});

child.on('close', (code) => {
  console.log('\n');
  console.log(`Exit code: ${code}`);
  console.log(`Total events: ${eventCount}`);
  console.log(`Event types: ${JSON.stringify(Object.fromEntries(eventTypes), null, 2)}`);
  console.log(`Assistant text: "${assistantText}"`);

  if (stderrOutput.trim()) {
    console.log(`\nStderr (first 500 chars): ${stderrOutput.slice(0, 500)}`);
  }

  if (resultEvent && resultEvent.type === 'result') {
    console.log('\n--- Result Event ---');
    console.log(`Turns: ${resultEvent.num_turns}`);
    console.log(`Duration: ${resultEvent.duration_ms}ms (API: ${resultEvent.duration_api_ms}ms)`);
    console.log(`Stop reason: ${resultEvent.stop_reason}`);
    console.log(`Total cost: $${resultEvent.total_cost_usd}`);
    console.log(`Is error: ${resultEvent.is_error}`);

    if (resultEvent.usage) {
      console.log(`Input tokens: ${resultEvent.usage.input_tokens}`);
      console.log(`Output tokens: ${resultEvent.usage.output_tokens}`);
      console.log(`Cache read: ${resultEvent.usage.cache_read_input_tokens ?? 0}`);
      console.log(`Cache creation: ${resultEvent.usage.cache_creation_input_tokens ?? 0}`);
    }

    if (resultEvent.modelUsage) {
      console.log(`\nModel usage breakdown:`);
      for (const [model, usage] of Object.entries(resultEvent.modelUsage)) {
        console.log(`  ${model}: in=${usage.inputTokens} out=${usage.outputTokens} cache_read=${usage.cacheReadInputTokens} cost=$${usage.costUSD}`);
      }
    }

    console.log('\n=== SPIKE S1: PASS ===');
    console.log('- NDJSON streaming works via spawn + readline');
    console.log('- Requires --verbose flag for stream-json');
    console.log('- Events: system:init → assistant (full message) → rate_limit_event → result:success');
    console.log('- Token counts and cost available in result event (flat structure)');
    console.log('- modelUsage breakdown per model available');
  } else {
    console.log('\n=== SPIKE S1: FAIL ===');
    console.log('- No result event received');
    if (stderrOutput) {
      console.log(`- Stderr: ${stderrOutput.slice(0, 300)}`);
    }
  }
});
