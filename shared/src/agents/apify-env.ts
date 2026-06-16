import { join } from 'node:path';

/**
 * Apify runtime env vars that must NOT bleed into agent / check subprocesses.
 *
 * The runner itself runs inside an Apify container. There the SDK routes storage
 * to the CLOUD whenever `APIFY_IS_AT_HOME` is set, reading the default storage IDs
 * from the canonical `ACTOR_*` names (the legacy `APIFY_*` aliases are stripped too,
 * for older platform builds). If a child process inherits these, any Actor it runs
 * locally pushes its output into the RUNNER's own cloud dataset / KV store / queue,
 * burying the per-test verdict records. Observed in eval-pack Run 7: an agent's
 * locally-run scraper wrote 879 product rows into the runner's default dataset.
 *
 * Stripping `APIFY_IS_AT_HOME` is the decisive part — it makes the SDK fall back to
 * the local memory storage client (writing under `APIFY_LOCAL_STORAGE_DIR`). The
 * storage-ID and run-identity vars are stripped as well so nothing can re-point a
 * child at the runner's cloud storages. `APIFY_TOKEN` is deliberately preserved —
 * the agent legitimately needs it (e.g. `apify push`).
 */
export const APIFY_RUNTIME_KEYS_TO_STRIP = [
    // At-home flag — the decisive switch: when set, the SDK uses the cloud storage client.
    'APIFY_IS_AT_HOME',
    // Default storage IDs — canonical ACTOR_* (what the SDK reads) + legacy APIFY_* aliases.
    'ACTOR_DEFAULT_DATASET_ID', 'APIFY_DEFAULT_DATASET_ID',
    'ACTOR_DEFAULT_KEY_VALUE_STORE_ID', 'APIFY_DEFAULT_KEY_VALUE_STORE_ID',
    'ACTOR_DEFAULT_REQUEST_QUEUE_ID', 'APIFY_DEFAULT_REQUEST_QUEUE_ID',
    // Run / actor identity.
    'ACTOR_RUN_ID', 'APIFY_ACTOR_RUN_ID',
    'ACTOR_ID', 'APIFY_ACTOR_ID',
    'ACTOR_BUILD_ID', 'APIFY_ACTOR_BUILD_ID',
    'ACTOR_BUILD_NUMBER', 'APIFY_ACTOR_BUILD_NUMBER',
    'ACTOR_TASK_ID', 'APIFY_ACTOR_TASK_ID',
    'ACTOR_INPUT_KEY', 'APIFY_INPUT_KEY',
    'ACTOR_EVENTS_WEBSOCKET_URL', 'APIFY_ACTOR_EVENTS_WS_URL',
    'APIFY_TIMEOUT_AT',
    'APIFY_PROXY_PASSWORD',
] as const;

/**
 * Build the env for a child process (agent CLI or check subprocess): start from the
 * current process env merged with `extraEnv`, strip the Apify runtime vars above, and
 * point the SDK at a workspace-local storage dir. Never mutates `process.env`.
 */
export function buildChildEnv(
    extraEnv: Record<string, string> | undefined,
    workDir: string | undefined,
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = extraEnv ? { ...process.env, ...extraEnv } : { ...process.env };
    for (const k of APIFY_RUNTIME_KEYS_TO_STRIP) delete env[k];
    if (workDir && !env.APIFY_LOCAL_STORAGE_DIR) {
        env.APIFY_LOCAL_STORAGE_DIR = join(workDir, 'storage');
    }
    return env;
}
