---
name: checkpoint-syntax-demo
description: Demonstrates every checkpoint syntax variant — use as a reference
abortOnFailure: false
---

## Test
What is the largest planet in our solar system? Answer in one sentence.

## Checkpoint
contains: Jupiter
regex: \b(largest|biggest)\b
The answer should be factually correct and mention that Jupiter is a gas giant.

---

## Test
Create a file /tmp/syntax-demo.json with content: {"status":"ok","items":3}

## Checkpoint

### Checks
contains: ok
warn-contains: syntax-demo
regex: "status"
warn-regex: created|wrote
json-schema: {"type":"object","required":["status","items"],"properties":{"status":{"type":"string"},"items":{"type":"integer"}}}

### Script
cat /tmp/syntax-demo.json | jq -e '.items == 3'

### Judge
The agent must have created the file with the exact JSON content requested.

### Judge (opus)
Evaluate whether the agent verified the file was created correctly (e.g. read it back or used cat).

### warn-Judge (haiku)
Did the agent provide a clear confirmation message after creating the file?

---

## Test
List the files in the current directory using a shell command. Show the output.

## Checkpoint

### Checks
jq: [.[] | select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and .name=="Bash")] | length > 0
warn-jq: [.[] | select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and .name=="Bash") | .input.command? // "" | select(test("ls"))] | length > 0

### warn-Judge
The output should show a directory listing in a readable format.
