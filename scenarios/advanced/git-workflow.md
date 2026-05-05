---
name: git-workflow
description: Agent must initialize a git repo, make commits, and use git properly
abortOnFailure: true
expectedTools:
  required: [Bash, Write]
  optional: [Read, Edit]
  forbidden: []
---

## Test
Create a fresh directory /tmp/eval-git-project and work inside it:
1. Initialize a git repository
2. Create a file README.md with content "# My Project\n\nA test project."
3. Create a file src/index.ts with content "export const VERSION = '1.0.0';"
4. Stage and commit all files with message "Initial commit"
5. Show the git log and report the commit hash

## Expected Tools
Bash: git init, git add, git commit
Write: README.md, src/index.ts

## Checkpoint

### Script
cd /tmp/eval-git-project 2>/dev/null || { echo "directory not found"; exit 1; }
test -d .git || { echo "not a git repo"; exit 1; }
COMMITS=$(git log --oneline 2>/dev/null | wc -l | tr -d ' ')
test "$COMMITS" -ge 1 || { echo "no commits found"; exit 1; }
test -f README.md || { echo "README.md missing"; exit 1; }
test -f src/index.ts || { echo "src/index.ts missing"; exit 1; }
git log --oneline | head -1 | grep -qi "initial" || { echo "commit message doesn't contain 'initial'"; exit 1; }
echo "git repo with $COMMITS commit(s), message OK"

---

## Test
In /tmp/eval-git-project, create a new branch called "feature/add-utils", add a file src/utils.ts with a function "add(a: number, b: number): number", commit it, and show the branch list.

## Checkpoint

### Script
cd /tmp/eval-git-project 2>/dev/null || { echo "directory not found"; exit 1; }
BRANCH=$(git branch --show-current 2>/dev/null)
test "$BRANCH" = "feature/add-utils" || { echo "not on feature/add-utils branch (on: $BRANCH)"; exit 1; }
test -f src/utils.ts || { echo "src/utils.ts missing"; exit 1; }
grep -q "add" src/utils.ts || { echo "utils.ts missing add function"; exit 1; }
COMMITS=$(git log --oneline 2>/dev/null | wc -l | tr -d ' ')
test "$COMMITS" -ge 2 || { echo "expected at least 2 commits, got $COMMITS"; exit 1; }
echo "branch feature/add-utils with $COMMITS commits, utils.ts OK"
