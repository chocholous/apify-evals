import { describe, it, expect } from 'vitest';

import { buildChildEnv, APIFY_RUNTIME_KEYS_TO_STRIP } from '../agents/apify-env.js';

describe('buildChildEnv', () => {
    it('strips every targeted Apify runtime var', () => {
        const extra = Object.fromEntries(APIFY_RUNTIME_KEYS_TO_STRIP.map((k) => [k, 'runner-value']));
        const env = buildChildEnv(extra, '/tmp/ws');
        for (const k of APIFY_RUNTIME_KEYS_TO_STRIP) {
            expect(env[k], `${k} should be stripped`).toBeUndefined();
        }
    });

    it('strips the decisive at-home flag and the canonical ACTOR_* storage IDs', () => {
        // These are the vars the Apify SDK actually reads to route storage to the cloud.
        // Stripping APIFY_IS_AT_HOME flips Actor.isAtHome() to false -> local storage.
        const env = buildChildEnv(
            {
                APIFY_IS_AT_HOME: '1',
                ACTOR_DEFAULT_DATASET_ID: 'RUNNER_OWN_DATASET',
                ACTOR_DEFAULT_KEY_VALUE_STORE_ID: 'RUNNER_OWN_KVS',
                ACTOR_RUN_ID: 'RUN123',
            },
            '/tmp/ws',
        );
        expect(env.APIFY_IS_AT_HOME).toBeUndefined();
        expect(env.ACTOR_DEFAULT_DATASET_ID).toBeUndefined();
        expect(env.ACTOR_DEFAULT_KEY_VALUE_STORE_ID).toBeUndefined();
        expect(env.ACTOR_RUN_ID).toBeUndefined();
    });

    it('preserves APIFY_TOKEN — the agent legitimately needs it (e.g. `apify push`)', () => {
        expect(buildChildEnv({ APIFY_TOKEN: 'tok' }, '/tmp/ws').APIFY_TOKEN).toBe('tok');
    });

    it('points the SDK at a workspace-local storage dir', () => {
        expect(buildChildEnv(undefined, '/tmp/ws').APIFY_LOCAL_STORAGE_DIR).toBe('/tmp/ws/storage');
    });

    it('does not override a caller-provided APIFY_LOCAL_STORAGE_DIR', () => {
        expect(buildChildEnv({ APIFY_LOCAL_STORAGE_DIR: '/custom' }, '/tmp/ws').APIFY_LOCAL_STORAGE_DIR).toBe('/custom');
    });

    it('leaves APIFY_LOCAL_STORAGE_DIR untouched when no workDir is given', () => {
        expect(buildChildEnv({ APIFY_TOKEN: 'tok' }, undefined).APIFY_LOCAL_STORAGE_DIR).toBe(process.env.APIFY_LOCAL_STORAGE_DIR);
    });

    it('never mutates process.env', () => {
        const before = process.env.APIFY_IS_AT_HOME;
        buildChildEnv({ APIFY_IS_AT_HOME: '1', ACTOR_DEFAULT_DATASET_ID: 'X' }, '/tmp/ws');
        expect(process.env.APIFY_IS_AT_HOME).toBe(before);
        expect(process.env.ACTOR_DEFAULT_DATASET_ID).toBeUndefined();
    });

    it('covers both the canonical ACTOR_* names and their legacy APIFY_* aliases', () => {
        expect(APIFY_RUNTIME_KEYS_TO_STRIP).toContain('ACTOR_DEFAULT_DATASET_ID');
        expect(APIFY_RUNTIME_KEYS_TO_STRIP).toContain('APIFY_DEFAULT_DATASET_ID');
        expect(APIFY_RUNTIME_KEYS_TO_STRIP).toContain('APIFY_IS_AT_HOME');
    });

    it('strips NODE_ENV so scaffolded projects install devDependencies as-usual', () => {
        // apify/actor-node sets NODE_ENV=production; if that leaks into the agent's
        // shell, `apify create` templates that rely on a devDep at runtime (e.g. tsx)
        // fail because `npm install --omit=dev` drops it.
        expect(buildChildEnv({ NODE_ENV: 'production' }, '/tmp/ws').NODE_ENV).toBeUndefined();
        expect(APIFY_RUNTIME_KEYS_TO_STRIP).toContain('NODE_ENV');
    });
});
