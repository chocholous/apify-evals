---
name: typescript-project-setup
description: Agent creates a TypeScript project from scratch, writes tests, runs them
abortOnFailure: true
language: typescript
expectedTools:
  required: [Bash, Write]
  optional: [Read, Edit]
  forbidden: []
---

## Test
Create a TypeScript project in the current directory:
1. Initialize with npm (package.json with type: module)
2. Install typescript and vitest as dev dependencies
3. Create tsconfig.json with strict mode, ES2022 target, NodeNext module
4. Create src/calculator.ts with functions: add, subtract, multiply, divide (divide should throw on zero)
5. Create src/calculator.test.ts with vitest tests for all 4 functions including divide-by-zero
6. Run the tests with npx vitest run and report results

## Expected Tools
Bash: npm init -y, npm install -D typescript vitest
Write: tsconfig.json, src/calculator.ts, src/calculator.test.ts

## Checkpoint

### Checks
regex: (pass|✓|PASS)

### Script
# Verify project structure
test -f package.json || { echo "package.json missing"; exit 1; }
test -f tsconfig.json || { echo "tsconfig.json missing"; exit 1; }
test -f src/calculator.ts || { echo "calculator.ts missing"; exit 1; }
test -f src/calculator.test.ts || { echo "calculator.test.ts missing"; exit 1; }

# Verify package.json has vitest
grep -q "vitest" package.json || { echo "vitest not in package.json"; exit 1; }

# Verify calculator has all functions
for fn in add subtract multiply divide; do
  grep -q "$fn" src/calculator.ts || { echo "calculator.ts missing $fn function"; exit 1; }
done

# Verify tests exist for all functions
for fn in add subtract multiply divide; do
  grep -q "$fn" src/calculator.test.ts || { echo "test file missing test for $fn"; exit 1; }
done

# Actually run the tests
npx vitest run 2>&1 | tail -5
RESULT=$?
if [ $RESULT -eq 0 ]; then
  echo "all tests pass"
else
  echo "tests failed with exit code $RESULT"
  exit 1
fi

### Judge
The TypeScript code should be well-structured with proper types. The divide function
must handle division by zero (throw an error). Tests should cover basic cases
and the edge case. The project should compile and all tests pass.
