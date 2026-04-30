import { Actor, log } from 'apify';

await Actor.init();

log.info('Agent Evals Runner starting...');

// TODO: F1.2-F1.3 implementation
// 1. Read input (agent, model, scenario, envVars, mcpConfig, initScript, maxTokens, maxRetries)
// 2. Parse scenario (shared/scenario-parser)
// 3. Per test: run agent CLI → judge checkpoint → collect metrics
// 4. Push results to dataset, conversation log to KV store

log.info('Agent Evals Runner finished.');

await Actor.exit();
