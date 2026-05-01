---
name: us5-abort-on-failure
description: "US5 deep: Step 1 fails, step 2 must NOT run (abortOnFailure=true)"
abortOnFailure: true
---

## Test
Read the file /tmp/nonexistent-eval-file-abc.txt and report its exact contents.

## Checkpoint
The file contents must be exactly "this is the secret content".

---

## Test
Write "step2-was-reached" to /tmp/eval-us5-step2-marker.txt

## Checkpoint
contains: step2-was-reached
