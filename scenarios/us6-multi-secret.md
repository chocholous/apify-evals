---
name: us6-multi-secret
description: "US6 deep: Multiple secrets, tool call args, error messages"
abortOnFailure: false
---

## Test
Run these bash commands and report their output:
1. echo "Token is $SECRET_TOKEN_A"
2. echo "Key is $SECRET_KEY_B"  
3. cat /tmp/nonexistent-$SECRET_TOKEN_A.txt (this will fail — report the error)

## Checkpoint
The output must show the values of both SECRET_TOKEN_A and SECRET_KEY_B. The third command should produce a "No such file" error that includes SECRET_TOKEN_A in the filename.
