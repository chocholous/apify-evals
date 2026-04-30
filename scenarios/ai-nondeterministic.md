---
name: ai-nondeterministic
description: "Non-deterministic AI test: tasks where agent can take different paths"
abortOnFailure: false
---

## Test
Use the Bash tool to find which process is currently using the most CPU on this machine. Report the process name and its CPU percentage.

## Checkpoint
The answer must contain a process name and a CPU percentage number. The process name must be a real process (not made up). The CPU percentage must be a non-negative number (can exceed 100% on multi-core systems).

---

## Test
Create a temporary file at /tmp/eval-test-marker.txt with the content "eval-run-ok" using Bash. Then read it back and confirm the content.

## Checkpoint
The answer must confirm that the file /tmp/eval-test-marker.txt was created and contains "eval-run-ok".
