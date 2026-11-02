# Scanner image: per-scan sibling container the backend spawns through host
# docker.sock. One container per run; killed on completion + TTL.
#
# Build context = repo root so the COPY can pull skill/ from one level up.

FROM oven/bun:1.4.2 AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ripgrep ca-certificates curl jq openssh-client python3-venv \
 && curl -fsSL https://packages.sury.org/php/apt.gpg -o /usr/share/keyrings/sury-php.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/sury-php.gpg] https://packages.sury.org/php/ bookworm main" > /etc/apt/sources.list.d/sury-php.list \
 && rm -rf /var/lib/apt/lists/*

# The phalcon, semgrep, agents, antigravity and qoder stages do not depend on each other, so BuildKit builds them in
# parallel. The final stage copies in only their results.

# Check step: PHP 7.2 + Phalcon 3 + PHPUnit 8, the pilot repo's runtime. Debian 12 has no
# PHP 7.2, so it comes from packages.sury.org. Phalcon 3.4.5 builds from its release source.
FROM base AS phalcon
RUN apt-get update && apt-get install -y --no-install-recommends \
      php7.2-cli php7.2-dev php7.2-mbstring php7.2-xml php7.2-json php7.2-curl php7.2-mysql gcc make libpcre3-dev \
 && curl -fsSL https://github.com/phalcon/cphalcon/archive/refs/tags/v3.4.5.tar.gz | tar xz -C /tmp \
 && cd /tmp/cphalcon-3.4.5/build && ./install --phpize /usr/bin/phpize7.2 --php-config /usr/bin/php-config7.2 \
 && cp "$(php-config7.2 --extension-dir)/phalcon.so" /phalcon.so

FROM base AS semgrep
RUN python3 -m venv /opt/semgrep-venv \
 && /opt/semgrep-venv/bin/pip install --no-cache-dir semgrep==1.179.0

# Install Claude tooling.
#   - claude-code (CLI binary "claude") — the skill harness; spawned as a
#     child process by the SDK to talk to api.anthropic.com.
#   - claude-agent-sdk — programmatic SDK; ESM-imported by bridge.mjs to drive
#     the query() loop. As of late 2025, Anthropic split CLI and SDK into
#     separate npm packages; we need both.
#
# IMPORTANT — version compatibility anchor.
#   Anthropic releases both packages from the same CI pipeline with synced
#   trailing patch numbers (claude-code@2.1.N ↔ claude-agent-sdk@0.3.N, same N).
#   Mixing different N values risks SDK↔CLI protocol drift (unknown flags or
#   message types). Always pin both to the same trailing number; bump together.
#   Verify with: ./scripts/check-claude-versions.sh
FROM oven/bun:1.4.2 AS agents
ARG CLAUDE_PATCH=291
WORKDIR /opt
# bun installs the musl builds of the Claude binaries next to the glibc ones. Debian uses glibc, so
# the musl copies (about 460 MB) never run.
RUN echo '{"name":"ola-scanner-bridge","private":true,"type":"module"}' > /opt/package.json \
 && bun add --ignore-scripts \
      "@anthropic-ai/claude-code@2.1.${CLAUDE_PATCH}" \
      "@anthropic-ai/claude-agent-sdk@0.3.${CLAUDE_PATCH}" \
      "@openai/codex@0.159.3" \
 && rm -rf /opt/node_modules/@anthropic-ai/*-musl

# Antigravity CLI: pinned release, SHA-512 from the vendor's release manifest. Bump the version and
# both checksums together.
FROM base AS antigravity
ARG AGY_VERSION=1.4.12
ARG AGY_BUILD=4768735748292608
ARG AGY_SHA512_AMD64=ea01c73b772187bca928852cf96235f0d846d6da5ebdac188b9ae719597465737f325540d483ee5f3f62d151029001713344972a187ddfb98cc7b97f7204b7f4
ARG AGY_SHA512_ARM64=7cae317fb6a02eb387982f06bfb234b366879cf9a80ad8969b571e5a55d1e37a6a5a49cd6b703c0443bb417937cf5e3b14a8c80cb26917ad79eef723a9f374c7
RUN case "$(dpkg --print-architecture)" in \
      amd64) path=linux-x64/cli_linux_x64.tar.gz; sha=$AGY_SHA512_AMD64 ;; \
      arm64) path=linux-arm/cli_linux_arm64.tar.gz; sha=$AGY_SHA512_ARM64 ;; \
      *) echo "unsupported architecture" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /tmp/agy.tar.gz "https://storage.googleapis.com/antigravity-public/antigravity-cli/${AGY_VERSION}-${AGY_BUILD}/${path}" \
 && echo "$sha  /tmp/agy.tar.gz" | sha512sum -c - \
 && tar -xzf /tmp/agy.tar.gz -C /tmp antigravity \
 && install -m 755 /tmp/antigravity /agy \
 && test "$(/agy --version)" = "$AGY_VERSION"

# Qoder CLI: pinned npm tarball, SHA-512 from the registry's integrity field. Only its self-contained bundle is
# unpacked, so no dependency resolves at build time: Grep uses the base image's ripgrep, and the image
# (sharp, photon) and clipboard packages serve interactive features. Bun cannot load the bundle, so it runs on a
# pinned Node binary. Bump the version and checksum together.
FROM base AS qoder
ARG QODER_VERSION=1.1.81
ARG QODER_SHA512=55efff8e784fe56e0cf8a53d5121a318dbe817fe0b3fa47f29cbb64a64b26b900f95829bd10a6cf43901cf946d1b425f585c2823c2049f699fe3cfae13ea389b
COPY --from=node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4 /usr/local/bin/node /opt/qoder/node
RUN curl -fsSL -o /tmp/qodercli.tgz "https://registry.npmjs.org/@qoder-ai/qodercli/-/qodercli-${QODER_VERSION}.tgz" \
 && echo "$QODER_SHA512  /tmp/qodercli.tgz" | sha512sum -c - \
 && tar -xzf /tmp/qodercli.tgz -C /opt/qoder --strip-components=1 package/bundle \
 && rm /tmp/qodercli.tgz \
 && test "$(/opt/qoder/node /opt/qoder/bundle/qodercli.js --version)" = "$QODER_VERSION"

FROM base
RUN apt-get update && apt-get install -y --no-install-recommends \
      php7.2-cli php7.2-mbstring php7.2-xml php7.2-json php7.2-curl php7.2-mysql \
 && curl -fsSL https://phar.phpunit.de/phpunit-8.phar -o /usr/local/bin/phpunit && chmod +x /usr/local/bin/phpunit \
 && rm -rf /var/lib/apt/lists/*
COPY --from=phalcon /phalcon.so /tmp/phalcon.so
RUN mv /tmp/phalcon.so "$(php7.2 -r 'echo ini_get("extension_dir");')/phalcon.so" \
 && printf '; priority=30\nextension=phalcon.so\n' > /etc/php/7.2/mods-available/phalcon.ini && phpenmod -v 7.2 phalcon \
 && php7.2 -m | grep -qx phalcon

COPY --from=semgrep /opt/semgrep-venv /opt/semgrep-venv
RUN ln -s /opt/semgrep-venv/bin/semgrep /usr/local/bin/semgrep && semgrep --version

COPY --from=agents /opt/ /opt/
RUN ln -sf /opt/node_modules/.bin/claude /usr/local/bin/claude \
 && for tool in codex; do \
      printf '#!/bin/sh\nexec bun --bun run /opt/node_modules/.bin/%s "$@"\n' "$tool" > "/usr/local/bin/$tool" \
      && chmod +x "/usr/local/bin/$tool"; \
    done \
 && /usr/local/bin/claude --version
COPY --from=antigravity /agy /usr/local/bin/agy
RUN /usr/local/bin/agy --version
COPY --from=qoder /opt/qoder /opt/qoder
RUN printf '#!/bin/sh\nexec /opt/qoder/node /opt/qoder/bundle/qodercli.js "$@"\n' > /usr/local/bin/qodercli \
 && chmod +x /usr/local/bin/qodercli \
 && qodercli --version

ENV HOME=/root \
    IS_SANDBOX=1 \
    CLAUDE_CONFIG_DIR=/root/.claude \
    GIT_TERMINAL_PROMPT=0

# Composer for `composer audit` on vendor trees. Below the slow layers, so it keeps their cache.
COPY --from=composer:2.8.12 /usr/bin/composer /usr/local/bin/composer

# Skills shipped with the image; user-invocable as /ola-security-audit.
# The model runs as "agent", so every skill file must be world-readable. The repo notes in targets/ are written 0600.
COPY skill/ /root/.claude/skills/
RUN chmod -R a+rX /root/.claude/skills
# bridge.mjs imports ../skill/ola-security-audit/findings.schema.json, so from /opt it reads /skill.
COPY skill/ola-security-audit/findings.schema.json /skill/ola-security-audit/findings.schema.json

# The model runs as "agent" (lib/agent-user.mjs). /root is 0711 so it can reach the skills below by
# exact path, and the entrypoint makes /root/.ssh, /root/.codex, /root/.gemini and /root/.qoder 0700. Its config dir links to them.
# Read-only native runs get their own home and empty workspace under /home/agent per run (lib/agent-fs.mjs readOnlyHome).
RUN useradd -m -u 10001 -s /bin/bash agent \
 && chmod 711 /root \
 && mkdir -p /home/agent/.claude /home/agent/.gemini /home/agent/.qoder \
 && ln -s /root/.claude/skills /home/agent/.claude/skills \
 && chown -R agent:agent /home/agent/.claude /home/agent/.gemini /home/agent/.qoder

COPY scanner/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY scanner/semgrep/      /opt/semgrep/
COPY shared/providers.json /shared/providers.json
COPY scanner/lib/          /opt/lib/
COPY scanner/fixtures/     /opt/fixtures/
COPY scanner/bridge.mjs    /opt/bridge.mjs
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /workspace
RUN mkdir -p /workspace/repo /workspace/artifacts

# stdin must stay open so the backend can write push and shutdown commands. The
# container is started with `docker run -i`.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
