---
name: init-script-complex
description: Test complex init script that sets up project scaffold and custom validators
abortOnFailure: true
expectedTools:
  required: [Bash, Write]
  optional: [Read, Edit]
  forbidden: []
---

## Test
You are in a pre-configured project directory. Read the CLAUDE.md file and the existing package.json to understand the project structure.
Then implement the missing src/validator.ts module as described in CLAUDE.md.
Run the existing tests to verify your implementation.

## Expected Tools
Read: CLAUDE.md, package.json, src/validator.test.ts
Write: src/validator.ts

## Checkpoint

### Script
# Run the pre-existing tests (timeout 60s for npm cold start)
npx vitest run 2>&1 | tail -3
RESULT=$?
if [ $RESULT -eq 0 ]; then
  echo "all tests pass"
else
  echo "tests failed"
  exit 1
fi

### Judge
The validator.ts implementation should follow the spec from CLAUDE.md exactly:
- validateEmail function that checks for @ and domain
- validateAge function that checks for positive integer 0-150
- validateName function that checks for non-empty string, 2-100 chars
All pre-written tests should pass.
