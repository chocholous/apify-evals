---
name: trajectory-test
description: Tests tool usage trajectory capture - agent must use multiple tools
---

## Test
Create a directory /tmp/eval-trajectory, then create two files inside it: a.txt with content "alpha" and b.txt with content "beta". List the directory contents and report what you created.

## Checkpoint
contains: a.txt
contains: b.txt
script: ls /tmp/eval-trajectory/a.txt /tmp/eval-trajectory/b.txt && cat /tmp/eval-trajectory/a.txt | grep -q "alpha" && cat /tmp/eval-trajectory/b.txt | grep -q "beta" && echo "both files correct"

---

## Test
Read /tmp/eval-trajectory/a.txt and /tmp/eval-trajectory/b.txt, concatenate them with a newline between, and write the result to /tmp/eval-trajectory/combined.txt. Report the contents.

## Checkpoint
script: cat /tmp/eval-trajectory/combined.txt | grep -q "alpha" && cat /tmp/eval-trajectory/combined.txt | grep -q "beta" && echo "combined file correct"
