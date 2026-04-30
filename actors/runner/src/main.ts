import { Actor, log } from 'apify';
import { parseScenario } from '@apify-evals/shared';

await Actor.init();

log.info('Agent Evals Runner starting...');

const input = await Actor.getInput<{ scenario?: string }>();

if (input?.scenario) {
    const parsed = parseScenario(input.scenario);
    log.info(`Scenario "${parsed.meta.name}": ${parsed.tests.length} test(s), abortOnFailure=${parsed.meta.abortOnFailure}`);
    for (let i = 0; i < parsed.tests.length; i++) {
        log.info(`  Test ${i + 1}: "${parsed.tests[i].test.slice(0, 80)}..."`);
    }
} else {
    log.info('No scenario provided. Pass a Markdown scenario string as input.scenario.');
}

// TODO: F1.2-F1.3 implementation
// 1. Run agent CLI subprocess per test
// 2. Judge checkpoints (deterministic + LLM)
// 3. Collect metrics from streaming output
// 4. Push results to dataset, conversation log to KV store

log.info('Agent Evals Runner finished.');

await Actor.exit();
