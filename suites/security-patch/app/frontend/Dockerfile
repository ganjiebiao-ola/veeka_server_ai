# OlaAgent frontend — Vite build → nginx static serve.
#
# nginx also reverse-proxies /api/* to the backend service on the compose
# network, with SSE-friendly buffering disabled (long-lived run-event stream).

FROM oven/bun:1.4.2 AS build
WORKDIR /app

COPY frontend/package.json frontend/bun.lock /app/
RUN bun install --frozen-lockfile

COPY frontend /app
RUN bun run build

# ----- runtime stage -----
FROM nginx:alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=10 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
