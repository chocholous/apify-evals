#!/bin/bash
# Run tests in a clean Linux VM (OrbStack Docker)
# Usage: ./test/run-vm-test.sh [e2e-filter]
#   No args = unit tests + full E2E suite + isolation check
#   filter  = unit tests + filtered E2E + isolation check

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

        # E2E tests (if claude is available)
        if command -v claude &>/dev/null && [ -n \"\${CLAUDE_CODE_OAUTH_TOKEN:-}\" ]; then
            echo ''
            echo '--- E2E tests (clean VM, no CLAUDE.md) ---'
            cd actors/runner
            npx tsx test/e2e/run-e2e.ts $FILTER 2>&1
            cd ../..

            echo ''
            echo '--- Agent isolation check ---'
            RESPONSE=\$(claude -p 'Say hello in one word.' --output-format json --max-turns 1 --no-session-persistence --dangerously-skip-permissions < /dev/null 2>/dev/null | python3 -c \"import sys,json; r=json.load(sys.stdin); print(r.get('result',''))\" 2>/dev/null || echo 'FAILED')
            echo \"Agent response: \$RESPONSE\"
            if echo \"\$RESPONSE\" | grep -qi 'ahoj\|dobrý\|zdravím'; then
                echo 'FAIL: Agent responded in Czech — isolation broken!'
                exit 1
            else
                echo 'PASS: Agent did NOT respond in Czech'
            fi
        else
            echo 'SKIP: E2E tests (claude CLI not available or no token)'
        fi

        echo ''
        echo '=== VM tests complete ==='
    "
