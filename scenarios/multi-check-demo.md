---
name: multi-check-demo
description: Demonstrates all checkpoint types in one scenario
abortOnFailure: false
---

## Test
What is the largest planet in our solar system? Answer in one complete sentence in English.

## Checkpoint
contains: Jupiter
regex: \b(largest|biggest|massive)\b
The answer should be factually correct and mention that Jupiter is a gas giant.

---

## Test
Create a file /tmp/eval-demo.json with this exact content: {"status":"ok","count":42}

## Checkpoint

### Checks
contains: ok
json-schema: {"type":"object","required":["status","count"],"properties":{"status":{"type":"string"},"count":{"type":"integer"}}}

### Script
cat /tmp/eval-demo.json | jq -e '.count == 42'

### Judge
The agent should have created the file and confirmed it exists.

### warn-Judge (haiku)
Did the agent verify the file content after creation (e.g. cat or read the file)?
