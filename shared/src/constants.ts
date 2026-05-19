export const JUDGE_MODEL = 'claude-sonnet-4-6';
export const JUDGE_MODEL_MAP: Record<string, string> = {
    haiku: 'claude-haiku-4-5-20251001',
    sonnet: 'claude-sonnet-4-6',
    opus: 'claude-opus-4-6',
};
export const SCRIPT_TIMEOUT_MS = 60_000;
export const INIT_SCRIPT_TIMEOUT_MS = 300_000;
export const JQ_TIMEOUT_MS = 30_000;
// Hung-turn detection — only counts silence while waiting for the LLM (not during tool execution).
// Threshold 60s is well above normal text_delta cadence; check every 15s.
export const HUNG_TURN_THRESHOLD_MS = 60_000;
export const HUNG_TURN_CHECK_INTERVAL_MS = 15_000;
