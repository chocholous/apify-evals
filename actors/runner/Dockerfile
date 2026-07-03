FROM apify/actor-node:24 AS builder

COPY --chown=myuser:myuser package*.json ./
COPY --chown=myuser:myuser shared/package*.json ./shared/
COPY --chown=myuser:myuser actors/runner/package*.json ./actors/runner/

RUN npm install --include=dev --audit=false --workspaces

COPY --chown=myuser:myuser tsconfig.base.json ./
COPY --chown=myuser:myuser shared/ ./shared/
COPY --chown=myuser:myuser actors/runner/ ./actors/runner/

RUN ./node_modules/.bin/tsc -p shared/tsconfig.json
RUN ./node_modules/.bin/tsc -p actors/runner/tsconfig.json

# --- Runtime: all agent CLIs pre-installed ---
FROM apify/actor-node:24

USER root
RUN apk add --no-cache \
    curl bash git openssh-client \
    jq yq python3 py3-pip \
    build-base \
    wget ca-certificates \
    zip unzip \
    && ln -sf /usr/bin/python3 /usr/bin/python

# Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && cp /root/.local/bin/claude /usr/local/bin/claude \
    && chmod 755 /usr/local/bin/claude

# OpenCode CLI (installs to ~/.opencode/bin/)
RUN curl -fsSL https://opencode.ai/install | bash \
    && cp /root/.opencode/bin/opencode /usr/local/bin/opencode \
    && chmod 755 /usr/local/bin/opencode

# Codex CLI + Apify CLI
RUN npm install -g @openai/codex apify-cli

# Verify all CLIs are available
RUN claude --version && codex --version && opencode --version && apify --version

# Install runtime deps as root (npm needs write access to node_modules)
COPY package*.json ./
COPY shared/package*.json ./shared/
COPY actors/runner/package*.json ./actors/runner/

RUN npm install --omit=dev --omit=optional --audit=false --workspaces \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && rm -r /root/.npm

# Copy compiled code
COPY --from=builder /usr/src/app/shared/dist ./shared/dist
COPY --from=builder /usr/src/app/actors/runner/dist ./actors/runner/dist
COPY actors/runner/ ./actors/runner/

# Lock down runner code: root owns /usr/src/app (agent can't modify runner files)
# Agent workspace will be created at /tmp/eval-workspace-* (writable by myuser)
RUN chown -R root:root /usr/src/app \
    && chmod -R 755 /usr/src/app \
    && mkdir -p /home/myuser \
    && chown myuser:myuser /home/myuser

USER myuser
WORKDIR /usr/src/app/actors/runner

CMD ["node", "dist/main.js"]
