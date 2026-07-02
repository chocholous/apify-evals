---
name: script-validation
description: Tests script checkpoint with downloaded validator
---

## Test
Write a JSON file /tmp/eval-script-test.json that contains an array of 3 objects, each with "name" (string) and "age" (integer) fields. Use realistic data.

## Checkpoint

### Checks
json-schema: {"type":"array","minItems":3,"items":{"type":"object","required":["name","age"],"properties":{"name":{"type":"string"},"age":{"type":"integer"}}}}

### Script
output=$(cat)
file="/tmp/eval-script-test.json"
if [ ! -f "$file" ]; then
  echo "File $file does not exist"
  exit 1
fi
count=$(jq 'length' "$file")
if [ "$count" -ne 3 ]; then
  echo "Expected 3 items, got $count"
  exit 1
fi
echo "Valid: $count items with name+age fields"

### Judge
The response should acknowledge creating the file and briefly describe its contents.
