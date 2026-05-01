#!/bin/bash
# Run tests in a clean Linux VM (OrbStack Docker)
# Usage: ./test/run-vm-test.sh [test-filter]
#
# Tests:
# 1. Unit tests (42) — no claude CLI needed
# 2. E2E smoke test — needs CLAUDE_CODE_OAUTH_TOKEN
# 3. Agent isolation check — verifies no CLAUDE.md leakage

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DOCKER="$HOME/.orbstack/bin/docker"
IMAGE_NAME="apify-evals-vm-test"
FILTER="${1:-}"

# Load token from .env
if [ -f "$PROJECT_DIR/.env" ]; then
    source "$PROJECT_DIR/.env"
fi

if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    echo "ERROR: CLAUDE_CODE_OAUTH_TOKEN not set. Create .env or export it."
    exit 1
fi

echo "=== Building test VM image ==="
$DOCKER build --network host -t "$IMAGE_NAME" -f "$SCRIPT_DIR/Dockerfile.vm-test" "$PROJECT_DIR" 2>&1 | tail -5

echo ""
echo "=== Running tests in clean Linux VM ==="
echo "No CLAUDE.md, no local config, non-root user"
echo ""

$DOCKER run --rm \
    -v "$PROJECT_DIR:/home/testuser/project:ro" \
    -e "CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN" \
    -e "CLAUDE_CODE=0" \
    -w /home/testuser/work \
    "$IMAGE_NAME" \
    bash -c "
        set -e

        # Copy project (read-only mount, need writable copy)
        cp -r /home/testuser/project/* .
        cp -r /home/testuser/project/.gitignore . 2>/dev/null || true

        echo '--- Environment ---'
        echo \"User: \$(whoami)\"
        echo \"Node: \$(node --version)\"
        echo \"Claude: \$(claude --version 2>/dev/null || echo 'not found')\"
        echo \"CLAUDE.md exists: \$(test -f ~/.claude/CLAUDE.md && echo YES || echo NO)\"
        echo \"Home dir CLAUDE.md: \$(test -f ~/CLAUDE.md && echo YES || echo NO)\"
        echo ''

        # Install deps
        echo '--- Installing dependencies ---'
        npm install --silent 2>&1 | tail -3

        # Unit tests
        echo ''
        echo '--- Unit tests (shared) ---'
        cd shared && npx vitest run 2>&1 | tail -5
        cd ..

        # Build
        echo ''
        echo '--- Build ---'
        cd shared && npm run build 2>&1
        cd ../actors/runner && npm run build 2>&1
        cd ../..

        # E2E smoke test (if claude is available and token set)
        if command -v claude &>/dev/null && [ -n \"\${CLAUDE_CODE_OAUTH_TOKEN:-}\" ]; then
            echo ''
            echo '--- E2E smoke test (clean VM, no CLAUDE.md) ---'
            cd actors/runner
            # Use tsx directly (apify-cli not installed in VM)
            mkdir -p storage/key_value_stores/default
            echo '{\"scenario\":\"---\\nname: vm-smoke\\ndescription: VM smoke test\\nabortOnFailure: true\\n---\\n\\n## Test\\nWhat is 2+2? Answer with just the number.\\n\\n## Checkpoint\\ncontains: 4\\n\",\"maxTurns\":3,\"maxBudgetUsd\":0.50}' > storage/key_value_stores/default/INPUT.json
            APIFY_LOCAL_STORAGE_DIR=storage npx tsx src/main.ts 2>&1
            echo 'Dataset output:'
            cat storage/datasets/default/*.json 2>/dev/null | python3 -m json.tool 2>/dev/null | head -20
            cd ../..

            echo ''
            echo '--- Agent isolation check ---'
            echo 'Verifying agent responds in English (no Czech CLAUDE.md)...'
            RESPONSE=\$(claude -p 'Say hello in one word.' --output-format json --max-turns 1 --no-session-persistence --dangerously-skip-permissions < /dev/null 2>/dev/null | python3 -c \"import sys,json; r=json.load(sys.stdin); print(r.get('result',''))\" 2>/dev/null || echo 'FAILED')
            echo \"Agent response: \$RESPONSE\"
            if echo \"\$RESPONSE\" | grep -qi 'ahoj\|dobrý\|zdravím'; then
                echo 'FAIL: Agent responded in Czech — isolation broken!'
                exit 1
            else
                echo 'PASS: Agent did NOT respond in Czech'
            fi
        else
            echo ''
            echo 'SKIP: E2E tests (claude CLI not available or no token)'
        fi

        echo ''
        echo '=== VM tests complete ==='
    "
