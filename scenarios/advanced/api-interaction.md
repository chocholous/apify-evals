---
name: api-interaction
description: Agent must call a public API, process response, and store results
abortOnFailure: true
expectedTools:
  required: [Bash]
  optional: [Write, Read]
  forbidden: []
---

## Test
Use curl to fetch the list of GitHub repositories for the user "apify" from the GitHub API (https://api.github.com/users/apify/repos?per_page=5&sort=updated).
Parse the JSON response to extract repository names and their star counts.
Save the result as a JSON array to /tmp/eval-api/repos.json with format:
[{"name": "repo-name", "stars": 123}, ...]
Report which repo has the most stars.

## Expected Tools
Bash: curl https://api.github.com/users/apify/repos, jq to parse
Write: /tmp/eval-api/repos.json

## Checkpoint

### Script
test -f /tmp/eval-api/repos.json || { echo "repos.json missing"; exit 1; }
COUNT=$(jq 'length' /tmp/eval-api/repos.json)
test "$COUNT" -ge 3 || { echo "expected at least 3 repos, got $COUNT"; exit 1; }
# Verify structure
jq -e '.[0] | .name and .stars' /tmp/eval-api/repos.json > /dev/null 2>&1 || { echo "invalid structure: missing name or stars"; exit 1; }
# Verify stars are numbers
jq -e 'all(.stars | type == "number")' /tmp/eval-api/repos.json > /dev/null 2>&1 || { echo "stars should be numbers"; exit 1; }
MAX=$(jq 'max_by(.stars) | .name' /tmp/eval-api/repos.json -r)
echo "correct: $COUNT repos, most starred: $MAX"

### Judge
The agent should have successfully called the GitHub API, parsed the response,
and correctly identified the most-starred repository. The data should be real
and current (not fabricated).
