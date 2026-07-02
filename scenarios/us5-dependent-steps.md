---
name: us5-dependent-steps
description: "US5 deep: Steps that depend on each other"
---

## Test
Generate a random 8-character alphanumeric string using bash (e.g. with openssl rand -hex 4) and write it to /tmp/eval-us5-random.txt. Report the generated string.

## Checkpoint
regex: [a-f0-9]{8}

---

## Test
Read the file /tmp/eval-us5-random.txt and create a new file /tmp/eval-us5-reversed.txt with the string reversed (using bash rev command). Report both the original and reversed strings.

## Checkpoint
The answer must show two strings where the second is the character-by-character reverse of the first.

---

## Test
Read both /tmp/eval-us5-random.txt and /tmp/eval-us5-reversed.txt. Concatenate them with a dash separator and write to /tmp/eval-us5-final.txt. Report the final string.

## Checkpoint
regex: [a-f0-9]{8}-[a-f0-9]{8}
