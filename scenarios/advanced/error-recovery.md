---
name: error-recovery
description: Agent must handle errors and self-correct — tests errorRecoveryCount metric
abortOnFailure: false
expectedTools:
  required: [Bash, Write]
  optional: [Read, Edit]
  forbidden: []
---

## Test
Do the following steps. Some will fail — you need to figure out why and fix them:

1. Run: cat /tmp/eval-recovery/data.txt (this file doesn't exist yet — you'll get an error)
2. Create the directory and file with content "hello world"
3. Run: python3 -c "import json; print(json.loads(open('/tmp/eval-recovery/data.txt').read()))" (this will fail because the file contains plain text, not JSON)
4. Fix the file content to be valid JSON: {"message": "hello world"}
5. Run the python command again — it should succeed now
6. Report the value of the "message" field

## Checkpoint

### Checks
contains: hello world

### Script
test -f /tmp/eval-recovery/data.txt || { echo "file missing"; exit 1; }
cat /tmp/eval-recovery/data.txt | jq -e '.message == "hello world"' > /dev/null 2>&1 || { echo "file is not valid JSON with correct message"; exit 1; }
echo "file contains valid JSON with correct message"

### Judge
The agent should have encountered errors, understood them, and self-corrected.
The trajectory should show error recovery — initial failures followed by fixes.
