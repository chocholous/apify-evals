---
name: us1-complex-tool-use
description: "US1 deep: Agent must use multiple tools to solve a task"
abortOnFailure: false
---

## Test
Create a directory /tmp/eval-us1-deep, then create 3 files inside it: hello.txt with content "hello", world.txt with content "world", and count.txt with content "3". Then list the directory and report how many files are in it.

## Checkpoint
The answer must state that there are exactly 3 files in the directory.

---

## Test
Read the file /tmp/eval-us1-deep/hello.txt and /tmp/eval-us1-deep/world.txt, concatenate their contents with a space between them, and write the result to /tmp/eval-us1-deep/combined.txt. Then read combined.txt and report its contents.

## Checkpoint
contains: hello world
