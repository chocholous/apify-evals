import { describe, it, expect } from 'vitest';

import { maskSecrets, maskEventsJsonl } from '../log-masker.js';

describe('maskSecrets', () => {
    const secrets = {
        GITHUB_TOKEN: 'ghp_abc123def456',
        API_KEY: 'sk-ant-secret-xyz',
    };

    it('masks all occurrences of secret values', () => {
        const text = 'Token is ghp_abc123def456 and key is sk-ant-secret-xyz';
        const masked = maskSecrets(text, secrets);
        expect(masked).toBe('Token is ***GITHUB_TOKEN*** and key is ***API_KEY***');
    });

    it('masks secrets in JSON strings', () => {
        const json = JSON.stringify({ token: 'ghp_abc123def456', data: 'safe' });
        const masked = maskSecrets(json, secrets);
        expect(masked).not.toContain('ghp_abc123def456');
        expect(masked).toContain('***GITHUB_TOKEN***');
        expect(masked).toContain('safe');
    });

    it('handles multiple occurrences', () => {
        const text = 'ghp_abc123def456 and again ghp_abc123def456';
        const masked = maskSecrets(text, secrets);
        expect(masked).toBe('***GITHUB_TOKEN*** and again ***GITHUB_TOKEN***');
    });

    it('skips short values (< 4 chars)', () => {
        const text = 'value is ab';
        const masked = maskSecrets(text, { SHORT: 'ab' });
        expect(masked).toBe('value is ab');
    });

    it('handles empty secrets', () => {
        const text = 'nothing to mask';
        expect(maskSecrets(text, {})).toBe('nothing to mask');
    });
});

describe('maskEventsJsonl', () => {
    it('masks secrets across multiple lines', () => {
        const lines = [
            '{"type":"user","content":"token is ghp_abc123"}',
            '{"type":"assistant","content":"got it"}',
            '{"type":"user","content":"key is sk-secret"}',
        ];
        const secrets = { TOKEN: 'ghp_abc123', KEY: 'sk-secret' };
        const masked = maskEventsJsonl(lines, secrets);

        expect(masked[0]).toContain('***TOKEN***');
        expect(masked[0]).not.toContain('ghp_abc123');
        expect(masked[1]).toBe(lines[1]);
        expect(masked[2]).toContain('***KEY***');
    });
});
