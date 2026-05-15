---
name: jq-tool-checks-demo
description: Demonstrates jq checkpoint type for validating agent tool usage and trajectory
abortOnFailure: false
---

## Test
Create a file /tmp/jq-demo.json with contents {"status":"ok","count":42}. Then read it back and confirm the contents.

## Checkpoint

### Checks
contains: ok

jq: [.[] | select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and .name=="Bash")] | length > 0
jq: [.[] | select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and .name=="Read")] | length > 0

warn-jq: [.[] | select(.type=="assistant") | .message.content[]? | select(.type=="tool_use") | .name | select(test("^Web(Search|Fetch)$"))] | length == 0

### Judge
The agent should have created the JSON file and confirmed its contents.

---

## Test
Search for "Apify web scraping" using a web search tool and summarize the top results.

## Checkpoint

### Checks
contains: Apify

jq: [.[] | select(.type=="assistant") | .message.content[]? | select(.type=="tool_use") | .name | select(test("^Web(Search|Fetch)$"))] | length > 0

jq: [.[] | select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and .name=="Bash") | .input.command? // "" | select(test("apify (actors )?call"))] | length > 0

### Judge
The agent should have used web search or Apify actors to find information.
