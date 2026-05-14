export const JUDGE_MODEL = 'claude-sonnet-4-6';
export const JUDGE_MODEL_MAP: Record<string, string> = {
    haiku: 'claude-haiku-4-5-20251001',
    sonnet: 'claude-sonnet-4-6',
    opus: 'claude-opus-4-6',
};
export const SCRIPT_TIMEOUT_MS = 60_000;
export const INIT_SCRIPT_TIMEOUT_MS = 300_000;
export const MAX_WORKSPACE_FILES = 20;
export const MAX_WORKSPACE_FILE_SIZE = 5000;
export const EVIDENCE_MAX_CHARS = 1000;
export const TOOL_INPUT_MAX_CHARS = 500;
export const JQ_TIMEOUT_MS = 30_000;
