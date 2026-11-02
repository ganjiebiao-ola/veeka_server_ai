# Ola Security Agent backend — Bun + Hono runtime.
#
# Mounts host docker.sock so scanner containers are siblings on the host
# daemon. Workspace path is identity-mounted to keep host/container paths
# consistent for bind-mounts the backend passes to `docker run`.

FROM oven/bun:1.4.2 AS bun-bin
FROM docker:27-cli AS docker-cli

FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=bun-bin /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

COPY backend /app/backend
COPY shared  /app/shared
COPY scanner/lib/profile.mjs scanner/lib/agent-user.mjs scanner/lib/agent-fs.mjs /app/scanner/lib/
COPY skill/ola-security-audit/findings.schema.json /app/skill/ola-security-audit/findings.schema.json
COPY skill/ola-security-audit/SKILL.md skill/ola-security-audit/applies-to.json /app/skill/ola-security-audit/
WORKDIR /app/backend

RUN bun install --frozen-lockfile --production --ignore-scripts

RUN mkdir -p /app/backend/workspace/runs /app/backend/data

ENV OLA_AGENT_RUNS_ROOT=/app/backend/workspace/runs \
    OLA_AGENT_DB_PATH=/app/backend/data/ola-agent.sqlite

EXPOSE 37018

HEALTHCHECK --interval=5s --timeout=3s --start-period=15s --retries=20 \
  CMD curl -fsS http://localhost:37018/api/health || exit 1

CMD ["bun", "run", "start"]
