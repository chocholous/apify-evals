import { spawnSync } from 'node:child_process';

import { AGENT_REGISTRY } from '../agents/registry.js';

/**
 * True when the `claude` CLI binary is resolvable on PATH.
 *
 * The integration suites spawn the real agent and make live, billable API
 * calls. In CI the binary isn't installed (and we don't want to spend API
 * budget per push), so those suites must skip rather than fail with
 * `spawn claude ENOENT`. Local dev machines with an authenticated `claude`
 * run them normally. The binary name comes from the agent registry so this
 * stays in sync if the command ever changes.
 */
let cached: boolean | undefined;

export function claudeAvailable(): boolean {
    if (cached !== undefined) return cached;
    const command = AGENT_REGISTRY['claude-code'].command;
    const probe = spawnSync(command, ['--version'], { stdio: 'ignore' });
    cached = !probe.error && probe.status === 0;
    return cached;
}
