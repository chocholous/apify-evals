export const JUDGE_MODEL = 'claude-sonnet-4-6';
export const JUDGE_MODEL_MAP: Record<string, string> = {
    haiku: 'claude-haiku-4-5-20251001',
    sonnet: 'claude-sonnet-4-6',
    opus: 'claude-opus-4-6',
};
export const SCRIPT_TIMEOUT_MS = 60_000;
export const INIT_SCRIPT_TIMEOUT_MS = 300_000;
export const JQ_TIMEOUT_MS = 30_000;
// Silence-escalation ladder for the agent subprocess. Fires only while no tool is
// in flight — apify nested actor calls / long bash legitimately take many minutes.
// Notice/warn rungs are advisory (logged to stderr + recorded in hungWarnings);
// SIGTERM is the first destructive action. Replaces the legacy per-result teardown
// (see GH#1) and the old HUNG_TURN_* advisory pair (which only logged, never killed).
export const SILENCE_NOTICE_MS = 30_000;
export const SILENCE_WARN1_MS = 40_000;
export const SILENCE_WARN2_MS = 50_000;
export const SILENCE_SIGTERM_MS = 60_000;
export const SILENCE_SIGKILL_GRACE_MS = 10_000;
export const SILENCE_FORCE_RESOLVE_GRACE_MS = 5_000;
export const SILENCE_CHECK_INTERVAL_MS = 5_000;
