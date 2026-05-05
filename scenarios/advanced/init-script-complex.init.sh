#!/bin/bash
# Init script for init-script-complex scenario
# Sets up a project scaffold with pre-written tests that agent must implement

set -e

# package.json
cat > package.json << 'PKGJSON'
{
  "name": "validator-project",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "vitest": "^4.1.0",
    "typescript": "^6.0.0"
  }
}
PKGJSON

# tsconfig
cat > tsconfig.json << 'TSCONF'
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "strict": true
  }
}
TSCONF

# CLAUDE.md with spec
cat > CLAUDE.md << 'CLAUDEMD'
# Validator Project

Implement `src/validator.ts` with these functions:

## validateEmail(email: string): boolean
- Must contain exactly one `@`
- Must have a non-empty local part (before @)
- Must have a domain with at least one `.` (e.g., `example.com`)
- Return `true` if valid, `false` otherwise

## validateAge(age: unknown): boolean
- Must be a number (not string, not NaN)
- Must be an integer (no decimals)
- Must be between 0 and 150 inclusive
- Return `true` if valid, `false` otherwise

## validateName(name: unknown): boolean
- Must be a string
- Must be between 2 and 100 characters (trimmed)
- Must not be empty or whitespace-only
- Return `true` if valid, `false` otherwise

Export all three functions as named exports.
CLAUDEMD

# Pre-written tests
mkdir -p src
cat > src/validator.test.ts << 'TESTFILE'
import { describe, it, expect } from 'vitest';
import { validateEmail, validateAge, validateName } from './validator.js';

describe('validateEmail', () => {
    it('accepts valid emails', () => {
        expect(validateEmail('user@example.com')).toBe(true);
        expect(validateEmail('a@b.co')).toBe(true);
        expect(validateEmail('test.user@domain.org')).toBe(true);
    });
    it('rejects invalid emails', () => {
        expect(validateEmail('')).toBe(false);
        expect(validateEmail('nodomain@')).toBe(false);
        expect(validateEmail('@nodomain.com')).toBe(false);
        expect(validateEmail('no-at-sign')).toBe(false);
        expect(validateEmail('two@@ats.com')).toBe(false);
        expect(validateEmail('no@dot')).toBe(false);
    });
});

describe('validateAge', () => {
    it('accepts valid ages', () => {
        expect(validateAge(0)).toBe(true);
        expect(validateAge(25)).toBe(true);
        expect(validateAge(150)).toBe(true);
    });
    it('rejects invalid ages', () => {
        expect(validateAge(-1)).toBe(false);
        expect(validateAge(151)).toBe(false);
        expect(validateAge(25.5)).toBe(false);
        expect(validateAge('25')).toBe(false);
        expect(validateAge(NaN)).toBe(false);
        expect(validateAge(null)).toBe(false);
    });
});

describe('validateName', () => {
    it('accepts valid names', () => {
        expect(validateName('Jo')).toBe(true);
        expect(validateName('Alice')).toBe(true);
        expect(validateName('A'.repeat(100))).toBe(true);
    });
    it('rejects invalid names', () => {
        expect(validateName('')).toBe(false);
        expect(validateName('A')).toBe(false);
        expect(validateName('A'.repeat(101))).toBe(false);
        expect(validateName('   ')).toBe(false);
        expect(validateName(123)).toBe(false);
        expect(validateName(null)).toBe(false);
    });
});
TESTFILE

# Install deps
npm install --audit=false 2>&1 | tail -3

echo "Scaffold ready: package.json, CLAUDE.md, src/validator.test.ts"
echo "Agent must implement src/validator.ts"
