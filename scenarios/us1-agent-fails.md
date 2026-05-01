---
name: us1-agent-fails
description: "US1 deep: Agent cannot fulfill the task — judge should detect failure"
abortOnFailure: false
---

## Test
Read the file /tmp/this-file-definitely-does-not-exist-xyz-98765.txt and report its contents.

## Checkpoint
The answer must contain the exact text "Successfully read the file contents" and the file content must be "secret data inside".
