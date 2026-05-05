---
name: skill-injection-test
description: Test that init script can inject CLAUDE.md rules into workspace and agent follows them
abortOnFailure: true
---

## Test
Read the CLAUDE.md file in your current directory and follow the rules defined there. Create the project as specified.

## Checkpoint

### Script
# Verify CLAUDE.md was injected into workspace
WORKSPACE=$(find /tmp -type d -name "eval-workspace-*" 2>/dev/null | head -1)
if [ -z "$WORKSPACE" ]; then
  echo "workspace not found"
  exit 1
fi
test -f "$WORKSPACE/CLAUDE.md" && echo "CLAUDE.md present in workspace" || { echo "CLAUDE.md missing"; exit 1; }
# Verify agent created the expected output
test -f "$WORKSPACE/greeting.ts" && echo "greeting.ts created" || { echo "greeting.ts missing"; exit 1; }
grep -q "Ahoj" "$WORKSPACE/greeting.ts" && echo "uses Czech greeting" || { echo "missing Czech greeting"; exit 1; }

### Judge
The agent should have read CLAUDE.md and followed its instructions to create greeting.ts with a Czech greeting.
