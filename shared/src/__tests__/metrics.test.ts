import { describe, it, expect } from 'vitest';

import { formatCost, formatDuration } from '../metrics.js';

describe('formatCost', () => {
    it('formats tiny costs', () => expect(formatCost(0.000123)).toBe('$0.000123'));
    it('formats small costs', () => expect(formatCost(0.0567)).toBe('$0.0567'));
    it('formats normal costs', () => expect(formatCost(1.23)).toBe('$1.23'));
});

describe('formatDuration', () => {
    it('formats ms', () => expect(formatDuration(500)).toBe('500ms'));
    it('formats seconds', () => expect(formatDuration(5000)).toBe('5.0s'));
    it('formats minutes', () => expect(formatDuration(120000)).toBe('2.0m'));
});
