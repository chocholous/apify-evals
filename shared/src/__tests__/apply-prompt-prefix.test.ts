import { describe, it, expect } from 'vitest';

import { applyPromptPrefix } from '../agents/run.js';

describe('applyPromptPrefix', () => {
    const USER_PROMPT = 'Build a TypeScript Apify Actor that scrapes products from https://example.com/products.';

    it('prepends systemPrompt with the canonical separator when both are non-empty', () => {
        const sp = 'You are building an Apify Actor. Use Crawlee for crawling.';
        const result = applyPromptPrefix(sp, USER_PROMPT);
        expect(result).toBe(`${sp}\n\n---\n\nUser task:\n\n${USER_PROMPT}`);
    });

    it('uses a "User task:" label so the model sees structure, not a run-on string', () => {
        // The label matters: agents are trained to look for task boundaries.
        // If a future refactor drops the label, this test catches it.
        const result = applyPromptPrefix('Some context.', USER_PROMPT);
        expect(result).toContain('\n\nUser task:\n\n');
    });

    it('returns the user prompt unchanged when systemPrompt is undefined', () => {
        expect(applyPromptPrefix(undefined, USER_PROMPT)).toBe(USER_PROMPT);
    });

    it('returns the user prompt unchanged when systemPrompt is null', () => {
        expect(applyPromptPrefix(null, USER_PROMPT)).toBe(USER_PROMPT);
    });

    it('returns the user prompt unchanged when systemPrompt is the empty string', () => {
        // Apify strips empty-string fields from saved task inputs, so this
        // is the de-facto representation of "user provided nothing" once a
        // task input round-trips through Apify storage.
        expect(applyPromptPrefix('', USER_PROMPT)).toBe(USER_PROMPT);
    });

    it('returns the user prompt unchanged when systemPrompt is whitespace-only', () => {
        // Anthropic's API rejects `system` payloads whose text content is
        // whitespace-only with `400 system: text content blocks must contain
        // non-whitespace text`. By treating " " / "\n" / "\t" the same as
        // empty here, callers don't have to defensively trim — the prefix
        // simply doesn't get added, and the model sees only the user task.
        for (const sp of [' ', '   ', '\n', '\t', '  \n\t  ']) {
            expect(applyPromptPrefix(sp, USER_PROMPT)).toBe(USER_PROMPT);
        }
    });

    it('preserves the user prompt verbatim — no transformation of the user input', () => {
        // The user prompt is the user's voice; the prefix never edits it.
        const trickyUserPrompt = 'Build a TypeScript Actor.\n\n---\n\nUse Crawlee.\n\nUser task: nested.';
        const result = applyPromptPrefix('Apify context.', trickyUserPrompt);
        expect(result.endsWith(trickyUserPrompt)).toBe(true);
    });

    it('preserves the systemPrompt verbatim — no edits, no trimming of internal whitespace', () => {
        // The systemPrompt may legitimately contain markdown including its
        // own `---` separators (e.g. multi-section Apify-shipped context).
        // The prefix never edits the systemPrompt either.
        const multiSection = '## Section A\nFoo.\n\n---\n\n## Section B\nBar.';
        const result = applyPromptPrefix(multiSection, USER_PROMPT);
        expect(result.startsWith(multiSection)).toBe(true);
    });
});
