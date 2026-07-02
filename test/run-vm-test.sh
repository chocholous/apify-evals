#!/bin/bash
# Run tests inside the production Docker image (OrbStack Docker).
# Verifies that the actual deployed image works — same base, same CLIs.
#
# Usage: ./test/run-vm-test.sh [e2e-filter]
#   No args = unit tests + full E2E suite + agent smoke tests
#   filter  = unit tests + filtered E2E + agent smoke tests

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DOCKER="$HOME/.orbstack/bin/docker"
IMAGE_NAME="apify-evals-runner"
FILTER="${1:-}"

# Load secrets from .env
if [ -f "$PROJECT_DIR/.env" ]; then
    source "$PROJECT_DIR/.env"
fi

if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    echo "ERROR: CLAUDE_CODE_OAUTH_TOKEN not set. Create .env or export it."
    exit 1
fi

OPENAI_API_KEY="${OPENAI_API_KEY:-}"

echo "=== Building production Docker image ==="
$DOCKER build --network host -t "$IMAGE_NAME" -f "$PROJECT_DIR/actors/runner/Dockerfile" "$PROJECT_DIR" 2>&1 | tail -10

echo ""
echo "=== Running tests inside production image ==="
echo "Same image that gets deployed to Apify platform."
echo ""

ENV_ARGS="-e CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN -e CLAUDE_CODE=0"
if [ -n "$OPENAI_API_KEY" ]; then
    ENV_ARGS="$ENV_ARGS -e OPENAI_API_KEY=$OPENAI_API_KEY"
fi

$DOCKER run --rm \
    -v "$PROJECT_DIR:/home/project:ro" \
    $ENV_ARGS \
    -w /usr/src/app \
    "$IMAGE_NAME" \
    bash -c "
        set -e

        echo '--- Environment ---'
        echo \"User: \$(whoami)\"
        echo \"Node: \$(node --version)\"
        echo \"Claude: \$(claude --version 2>/dev/null || echo 'NOT FOUND')\"
        echo \"Codex: \$(codex --version 2>/dev/null || echo 'NOT FOUND')\"
        echo \"OpenCode: \$(opencode --version 2>/dev/null || echo 'NOT FOUND')\"
        echo \"Apify: \$(apify --version 2>/dev/null || echo 'NOT FOUND')\"
        echo ''

        # Copy source (image has built dist/, but we need test files too)
        cp -r /home/project/shared/src shared/src 2>/dev/null || true
        cp -r /home/project/shared/vitest.config.ts shared/ 2>/dev/null || true
        cp -r /home/project/shared/tsconfig.json shared/ 2>/dev/null || true
        cp -r /home/project/actors/runner/test actors/runner/test 2>/dev/null || true
        cp -r /home/project/scenarios actors/runner/../../scenarios 2>/dev/null || true
        cp -r /home/project/tsconfig.base.json . 2>/dev/null || true

        # Install dev deps for tests (vitest, tsx)
        npm install --include=dev --silent 2>&1 | tail -3

        # Unit tests
        echo ''
        echo '--- Unit tests (shared) ---'
        cd shared && npx vitest run 2>&1 | tail -8
        cd ..

        # E2E tests (Claude Code)
        if [ -n \"\${CLAUDE_CODE_OAUTH_TOKEN:-}\" ]; then
            echo ''
            echo '--- E2E tests (Claude Code) ---'
            cd actors/runner
            npx tsx test/e2e/run-e2e.ts ${FILTER:-us1-smoke} 2>&1
            cd ../..
        else
            echo 'SKIP: Claude E2E (no CLAUDE_CODE_OAUTH_TOKEN)'
        fi

        # Agent CLI smoke tests
        echo ''
        echo '--- Agent CLI smoke tests ---'
        PASS=0
        FAIL=0

        # Claude Code
        echo -n '  Claude Code: '
        CLAUDE_RESP=\$(claude -p 'Reply with just the number 42.' --output-format json --max-turns 1 --no-session-persistence --dangerously-skip-permissions < /dev/null 2>/dev/null || echo 'ERROR')
        if echo \"\$CLAUDE_RESP\" | grep -q '42'; then
            echo 'PASS'
            PASS=\$((PASS + 1))
        else
            echo \"FAIL — \$(echo \"\$CLAUDE_RESP\" | head -c 200)\"
            FAIL=\$((FAIL + 1))
        fi

        # Codex
        if [ -n \"\${OPENAI_API_KEY:-}\" ]; then
            echo -n '  Codex: '
            CODEX_RESP=\$(echo '' | codex exec 'Reply with just the number 42.' --json --dangerously-bypass-approvals-and-sandbox --ephemeral --ignore-user-config --skip-git-repo-check 2>/dev/null || echo 'ERROR')
            if echo \"\$CODEX_RESP\" | grep -q '42'; then
                echo 'PASS'
                PASS=\$((PASS + 1))
            else
                echo \"FAIL — \$(echo \"\$CODEX_RESP\" | head -c 200)\"
                FAIL=\$((FAIL + 1))
            fi
        else
            echo '  Codex: SKIP (no OPENAI_API_KEY)'
        fi

        # OpenCode (no key required for free models, but may not work in CI)
        echo -n '  OpenCode: '
        if opencode --version > /dev/null 2>&1; then
            echo 'INSTALLED (run test skipped — requires provider config)'
        else
            echo 'NOT FOUND'
            FAIL=\$((FAIL + 1))
        fi

        # Agent isolation check (Claude should NOT pick up host CLAUDE.md)
        echo ''
        echo '--- Agent isolation check ---'
        RESPONSE=\$(claude -p 'Say hello in one word.' --output-format json --max-turns 1 --no-session-persistence --dangerously-skip-permissions < /dev/null 2>/dev/null | python3 -c \"import sys,json; r=json.load(sys.stdin); print(r.get('result',''))\" 2>/dev/null || echo 'FAILED')
        echo \"Agent response: \$RESPONSE\"
        if echo \"\$RESPONSE\" | grep -qi 'ahoj\|dobrý\|zdravím'; then
            echo 'FAIL: Agent responded in Czech — isolation broken!'
            FAIL=\$((FAIL + 1))
        else
            echo 'PASS: Agent did NOT respond in Czech'
            PASS=\$((PASS + 1))
        fi

        echo ''
        echo \"=== VM tests complete: \$PASS passed, \$FAIL failed ===\"
        [ \$FAIL -eq 0 ] || exit 1
    "
