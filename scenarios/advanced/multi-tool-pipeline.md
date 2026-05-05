---
name: multi-tool-pipeline
description: Agent must chain multiple tools in correct order to build a data pipeline
abortOnFailure: true
expectedTools:
  required: [Bash, Write, Read]
  optional: [Edit, Glob, Grep]
  forbidden: []
---

## Test
Build a simple data processing pipeline:
1. Create directory /tmp/eval-pipeline
2. Write a JSON file /tmp/eval-pipeline/input.json with an array of 5 objects:
   [{"name":"Alice","age":30},{"name":"Bob","age":25},{"name":"Charlie","age":35},{"name":"Diana","age":28},{"name":"Eve","age":32}]
3. Write a bash script /tmp/eval-pipeline/process.sh that:
   - Reads input.json
   - Filters people with age >= 30 using jq
   - Writes the result to output.json
4. Run the script
5. Read output.json and report how many people passed the filter and their names

## Expected Tools
Bash: mkdir -p /tmp/eval-pipeline
Write: /tmp/eval-pipeline/input.json (5 objects), /tmp/eval-pipeline/process.sh (jq filter)
Bash: chmod +x, bash process.sh
Read: /tmp/eval-pipeline/output.json

## Checkpoint

### Checks
contains: Alice
contains: Charlie
contains: Eve
regex: \b3\b

### Script
cd /tmp/eval-pipeline
test -f input.json || { echo "input.json missing"; exit 1; }
test -f process.sh || { echo "process.sh missing"; exit 1; }
test -f output.json || { echo "output.json missing"; exit 1; }
INPUT_COUNT=$(jq 'length' input.json)
OUTPUT_COUNT=$(jq 'length' output.json)
test "$INPUT_COUNT" -eq 5 || { echo "input has $INPUT_COUNT items, expected 5"; exit 1; }
test "$OUTPUT_COUNT" -eq 3 || { echo "output has $OUTPUT_COUNT items, expected 3"; exit 1; }
# Verify correct people
jq -e 'all(.age >= 30)' output.json > /dev/null || { echo "output contains people under 30"; exit 1; }
echo "pipeline correct: $INPUT_COUNT input → $OUTPUT_COUNT output (age >= 30)"

### Judge
The agent should have created all files, run the processing script successfully,
and correctly identified that 3 people (Alice, Charlie, Eve) pass the age >= 30 filter.
