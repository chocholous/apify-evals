---
name: us6-env-vars
description: "US6: Verify env var injection and masking"
abortOnFailure: false
---

## Test
Run this bash command and show the output: printenv TEST_SECRET_KEY

## Checkpoint
contains: secret-value-for-eval-test
