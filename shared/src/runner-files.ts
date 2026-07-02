import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Runner's private bookkeeping directory — a SIBLING of the agent's workspace,
 * NOT a subdirectory of it. Placing runner files outside the workspace is the
 * strict-isolation guarantee:
 *
 * 1. `apify push` only bundles files inside the workspace, so nothing in the
 *    meta dir can leak into the agent's deployed Actor source.
 * 2. The runner never writes to the agent's workspace, so the agent's
 *    deliverable (and any measurement of it — e.g. "did the agent create
 *    `.actorignore`?") is not contaminated by framework files.
 *
 * Scenario checkpoint scripts that need to read runner-written artefacts
 * receive the meta-dir path via the `EVAL_META_DIR` environment variable,
 * which the runner injects into checkpoint subprocesses (and only checkpoint
 * subprocesses — NOT into the agent's env, so the agent never even knows the
 * meta dir exists).
 */

/** Filenames the runner writes inside the meta dir. */
export const RUNNER_FILES = {
    trajectory: 'trajectory.json',
    checkpoint: 'checkpoint.json',
    checkResults: 'check-results.json',
} as const;

/** Env-var name that points checkpoint subprocesses at the meta dir. */
export const META_DIR_ENV_VAR = 'EVAL_META_DIR';

/**
 * Allocate a meta-dir path that's a sibling of `workspaceDir`. The runner
 * passes the workspace UUID through so both share the same identifier — useful
 * for log-correlating "which workspace did this meta dir belong to" without
 * needing a separate registry.
 */
export function metaDirFor(workspaceDir: string): string {
    // workspaceDir is e.g. /tmp/eval-workspace-abc12345
    // → meta dir is    /tmp/eval-meta-abc12345
    return workspaceDir.replace(/eval-workspace-/, 'eval-meta-');
}

/** Idempotent mkdir for the meta dir. */
export function ensureMetaDir(metaDir: string): void {
    mkdirSync(metaDir, { recursive: true });
}

/** Absolute path to the runner's trajectory file inside `metaDir`. */
export function trajectoryPath(metaDir: string): string {
    return join(metaDir, RUNNER_FILES.trajectory);
}

/** Absolute path to the runner's checkpoint file inside `metaDir`. */
export function checkpointPath(metaDir: string): string {
    return join(metaDir, RUNNER_FILES.checkpoint);
}

/** Absolute path to the runner's check-results file inside `metaDir`. */
export function checkResultsPath(metaDir: string): string {
    return join(metaDir, RUNNER_FILES.checkResults);
}
