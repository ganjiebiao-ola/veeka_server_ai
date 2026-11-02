#!/usr/bin/env bash
# Security Patch Agent — local dev script. Run it with no arguments for usage.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$REPO_ROOT/.runtime"
BACKEND_LOG="$RUNTIME_DIR/backend.log"
FRONTEND_LOG="$RUNTIME_DIR/frontend.log"
BACKEND_PID="$RUNTIME_DIR/backend.pid"
BACKEND_CONFIG="$RUNTIME_DIR/backend.config"
FRONTEND_PID="$RUNTIME_DIR/frontend.pid"
FRONTEND_DEPS="$RUNTIME_DIR/frontend.deps"
CREDS_FILE="$RUNTIME_DIR/.credentials.json"
# Scanner containers carry this label. The compose containers do not, so filters on it never touch them.
SCANNER_FILTER="label=ola-agent=true"

FRONTEND_PORT=32088
BACKEND_PORT=37018

mkdir -p "$RUNTIME_DIR"

# ----- auth mode ------------------------------------------------------------
# Two ways to authenticate the scanner's Claude Agent SDK:
#   oauth    (default) — Claude subscription credentials sliced from the host
#                        Keychain (macOS) / ~/.claude/.credentials.json (Linux).
#   settings           — follow the host ~/.claude/settings.json `env` block,
#                        i.e. whatever provider cc-switch has active
#                        (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ...).
# Select with `--auth=settings|oauth` or the OLA_AGENT_AUTH_MODE env var; the
# flag wins. Resolved AFTER .env loads via resolve_auth_mode (so a .env-set
# OLA_AGENT_AUTH_MODE is honored when no flag is passed).
AUTH_MODE_FLAG=""
for _arg in "$@"; do
  case "$_arg" in --auth=*) AUTH_MODE_FLAG="${_arg#--auth=}";; esac
done
AUTH_MODE="oauth"
SETTINGS_JSON="$HOME/.claude/settings.json"
resolve_auth_mode() {
  AUTH_MODE="$(printf '%s' "${AUTH_MODE_FLAG:-${OLA_AGENT_AUTH_MODE:-oauth}}" | tr '[:upper:]' '[:lower:]')"
}

# ----- pretty printers ------------------------------------------------------
RED='\033[31m'; GREEN='\033[32m'; YEL='\033[33m'; BLUE='\033[34m'; DIM='\033[2m'; RESET='\033[0m'
say()  { printf "%b\n" "$*"; }
ok()   { say "${GREEN}✓${RESET} $*"; }
warn() { say "${YEL}⚠${RESET}  $*"; }
err()  { say "${RED}✗${RESET} $*" >&2; }
hi()   { say "${BLUE}▎${RESET} $*"; }

# ----- helpers --------------------------------------------------------------
is_running() {
  case "$1" in
    backend)  local pidfile="$BACKEND_PID";;
    frontend) local pidfile="$FRONTEND_PID";;
    *) return 1;;
  esac
  [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null
}

# Port-level liveness — catches processes started outside this script.
port_alive() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

require_free_port() {
  if port_alive "$1"; then
    err "$2 port $1 is in use (pid $(lsof -ti tcp:"$1" -sTCP:LISTEN 2>/dev/null)). Stop its owner before run start."
    return 1
  fi
}

kill_tree() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$child"; done
  kill "$1" 2>/dev/null
}

# The pid file holds `bun run start`. The server runs as its child, so kill the whole tree.
# Background only the nohup command. A backgrounded `cd && nohup` list leaves a wrapper that holds the caller's stdout open.
# Then kill any bun still listening on our port (an orphan from an earlier session).
# Only bun: under compose, Docker's own process listens on these ports.
stop_server() {
  local pidfile=$1 port=$2 label=$3 pid stopped=false
  if [ -f "$pidfile" ]; then
    kill_tree "$(cat "$pidfile")" && stopped=true
    rm -f "$pidfile"
  fi
  for pid in $(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null); do
    case "$(ps -o comm= -p "$pid")" in *bun) kill "$pid" 2>/dev/null && stopped=true;; esac
  done
  if [ "$stopped" = true ]; then ok "$label stopped"; else ok "$label was not running"; fi
}

# Compose mounts the same file into scanners, so keep it while either backend runs.
remove_creds() {
  [ -f "$CREDS_FILE" ] || return 0
  if is_running backend || [ -n "$(docker ps -q --filter name=^ola-agent-backend$ 2>/dev/null)" ]; then return 0; fi
  rm -f "$CREDS_FILE"
  ok "removed exported credentials"
}

wait_for() {
  local url=$1 timeout=${2:-30}
  local deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [[ "$(curl -s -o /dev/null -w "%{http_code}" "$url" 2>/dev/null)" =~ ^[23] ]]; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

require_idle_backend() {
  if ! curl -fsS --max-time 5 "http://localhost:$BACKEND_PORT/api/runs/active" | bun -e '
    let body = "";
    process.stdin.on("data", data => body += data);
    process.stdin.on("end", () => {
      try { const runs = JSON.parse(body).runs; process.exit(Array.isArray(runs) && runs.length === 0 ? 0 : 1); }
      catch { process.exit(1); }
    });
  '; then
    err "runs are active or their status is unavailable; finish or stop runs first (stop --force overrides)"
    return 1
  fi
}

# ----- subcommands ----------------------------------------------------------
cmd_check() {
  hi "Checking prerequisites…"
  local all_ok=true

  if command -v docker >/dev/null; then ok "docker $(docker --version | awk '{print $3}' | tr -d ,)"; else err "docker missing — install Docker Desktop"; all_ok=false; fi
  if docker info >/dev/null 2>&1;     then ok "docker daemon running";                                else err "docker daemon not running — open Docker Desktop"; all_ok=false; fi
  if command -v bun >/dev/null; then ok "bun    $(bun --version)"; else err "bun missing — 'brew install oven-sh/bun/bun'"; all_ok=false; fi
  if command -v claude >/dev/null; then ok "claude $(claude --version | awk '{print $1}')"; else warn "claude CLI not found — first SDK call will fail"; fi
  if [ "${AUTH_MODE:-oauth}" = "settings" ]; then
    if [ -f "$SETTINGS_JSON" ]; then ok "auth=settings → $SETTINGS_JSON present (cc-switch provider)"; else warn "auth=settings but $SETTINGS_JSON missing — pick a provider in cc-switch (or use --auth=oauth)"; fi
  else
    if [ -d "$HOME/.claude" ]; then ok "auth=oauth → ~/.claude/ exists (login creds present)"; else warn "~/.claude/ missing — run 'claude login' first (or use --auth=settings)"; fi
  fi

  if [ "$all_ok" = false ]; then err "prereqs failed — fix the items above (setup: suites/security-patch/docs/quickstart.md)"; exit 1; fi
}

load_dotenv() {
  # Source .env if present (gitignored). Allows users to keep GH_TOKEN /
  # MAX_CONCURRENT_SCANS / etc. out of their shell rc.
  if [ -f "$REPO_ROOT/.env" ]; then
    # `set -a` exports every variable read; `set +a` restores normal mode.
    set -a
    # shellcheck disable=SC1091
    . "$REPO_ROOT/.env"
    set +a
    ok ".env loaded ($(grep -cE '^[A-Z_]+=' "$REPO_ROOT/.env") vars)"
  fi
}

# Shared first steps of every start command.
prepare() {
  if [ ! -e "$REPO_ROOT/.env" ]; then (umask 077; touch "$REPO_ROOT/.env"); fi
  load_dotenv          # before auth resolution so a .env-set OLA_AGENT_AUTH_MODE counts
  resolve_auth_mode
  cmd_check
  cmd_build_scanner
  mkdir -p "$REPO_ROOT/backend/workspace/runs" "$REPO_ROOT/backend/data"
}

cmd_start() {
  if ! is_running backend; then require_free_port "$BACKEND_PORT" backend || return 1; fi
  if ! is_running frontend; then require_free_port "$FRONTEND_PORT" frontend || return 1; fi
  load_dotenv
  resolve_auth_mode
  export OLA_DEV="${DEV_MODE:-0}"
  export OLA_AGENT_AUTH_MODE="$AUTH_MODE"
  if [ "$AUTH_MODE" = "settings" ]; then
    # Follow host cc-switch provider; no OAuth slice, leave creds path unset so
    # the backend skips refresh + credential mounting.
    cmd_export_settings_env
  else
    export OLA_AGENT_CREDENTIALS_HOST_PATH="$CREDS_FILE"
  fi
  # The digest below needs bun. Without it, report every missing prerequisite instead of "bun: command not found".
  command -v bun >/dev/null || cmd_check

  # Store only a digest of effective settings, never credential values.
  local config
  config="$(bun -e '
    const { createHash } = require("node:crypto");
    const { existsSync, readdirSync, readFileSync, statSync } = require("node:fs");
    const { join } = require("node:path");
    const keys = Object.keys(process.env).filter(key => /^(OLA_AGENT_|ANTHROPIC_)/.test(key) || ["OLA_DEV", "GH_TOKEN", "MAX_CONCURRENT_SCANS", "HOME", "PATH"].includes(key)).sort();
    const hash = createHash("sha256").update(JSON.stringify(keys.map(key => [key, process.env[key]])));
    const include = path => {
      if (!existsSync(path)) return;
      if (statSync(path).isDirectory()) {
        for (const name of readdirSync(path).sort()) include(join(path, name));
      } else {
        hash.update(path).update(readFileSync(path));
      }
    };
    for (const path of ["scanner", "skill", ".dockerignore"]) include(join(process.argv[1], path));
    const sources = path => {
      if (!existsSync(path)) return;
      if (statSync(path).isDirectory()) {
        for (const name of readdirSync(path).sort()) {
          if (!["node_modules", "workspace", "data"].includes(name)) sources(join(path, name));
        }
      } else if (/\.tsx?$/.test(path) || /\/(package\.json|bun\.lock|schema\.sql)$/.test(path)) {
        hash.update(path).update(readFileSync(path));
      }
    };
    for (const path of ["backend", "shared"]) sources(join(process.argv[1], path));
    process.stdout.write(hash.digest("hex"));
  ' "$REPO_ROOT")"

  if is_running backend && [ -f "$BACKEND_CONFIG" ] && [ "$(cat "$BACKEND_CONFIG")" = "$config" ]; then
    ok "backend already running with current settings"
  else
    if is_running backend; then
      require_idle_backend || return 1
    fi
    cmd_check
    cmd_build_scanner
    ( cd "$REPO_ROOT/backend" && bun install --frozen-lockfile )
    if [ "$AUTH_MODE" = "oauth" ]; then cmd_compose_export_creds; fi
    mkdir -p "$REPO_ROOT/backend/workspace/runs" "$REPO_ROOT/backend/data"
    if is_running backend; then
      require_idle_backend || return 1
      hi "settings changed; restarting backend…"
      stop_server "$BACKEND_PID" "$BACKEND_PORT" "backend"
    fi
    require_free_port "$BACKEND_PORT" backend || return 1
    hi "starting backend on :${BACKEND_PORT}…"
    ( cd "$REPO_ROOT/backend" && { nohup bun run start >> "$BACKEND_LOG" 2>&1 & echo $! > "$BACKEND_PID"; } )
    if wait_for "http://localhost:$BACKEND_PORT/api/health" 30 && kill -0 "$(cat "$BACKEND_PID")" 2>/dev/null; then
      printf '%s\n' "$config" > "$BACKEND_CONFIG"
      ok "backend up"
    else
      err "backend failed to start within 30s — tail $BACKEND_LOG"
      exit 1
    fi
  fi

  local frontend_deps
  frontend_deps="$(cat "$REPO_ROOT/frontend/package.json" "$REPO_ROOT/frontend/bun.lock" | shasum -a 256 | cut -d' ' -f1)"
  if is_running frontend && [ -f "$FRONTEND_DEPS" ] && [ "$(cat "$FRONTEND_DEPS")" = "$frontend_deps" ]; then
    ok "frontend already running with current dependencies"
  else
    if is_running frontend; then
      hi "frontend dependencies changed; restarting frontend…"
      stop_server "$FRONTEND_PID" "$FRONTEND_PORT" "frontend"
    fi
    hi "installing frontend dependencies…"
    ( cd "$REPO_ROOT/frontend" && bun install --frozen-lockfile )
    require_free_port "$FRONTEND_PORT" frontend || return 1
    hi "starting frontend on :${FRONTEND_PORT}…"
    ( cd "$REPO_ROOT/frontend" && { nohup bun run dev >> "$FRONTEND_LOG" 2>&1 & echo $! > "$FRONTEND_PID"; } )
    if wait_for "http://localhost:$FRONTEND_PORT/" 30 && kill -0 "$(cat "$FRONTEND_PID")" 2>/dev/null; then
      printf '%s\n' "$frontend_deps" > "$FRONTEND_DEPS"
      ok "frontend up"
    else
      err "frontend failed to start within 30s — tail $FRONTEND_LOG"
      exit 1
    fi
  fi

  say ""
  say "  ${GREEN}Security Patch Agent is ready!${RESET} 🛠️"
  say "  ${BLUE}Open:${RESET}     http://localhost:$FRONTEND_PORT"
  say "  ${DIM}backend:  http://localhost:$BACKEND_PORT/api/health${RESET}"
  say "  ${DIM}logs:     suites/security-patch/run logs${RESET}"
  say "  ${DIM}stop:     suites/security-patch/run stop${RESET}"
}

cmd_stop() {
  if [[ " $* " != *" --force "* ]] && { is_running backend || port_alive "$BACKEND_PORT"; }; then
    require_idle_backend || return 1
  fi
  stop_server "$FRONTEND_PID" "$FRONTEND_PORT" "frontend"
  stop_server "$BACKEND_PID"  "$BACKEND_PORT"  "backend"
  cmd_clean
  remove_creds
}

cmd_restart() { cmd_stop "$@" && cmd_start; }

cmd_status() {
  if is_running backend; then
    ok "backend  pid $(cat "$BACKEND_PID")  http://localhost:$BACKEND_PORT"
  elif port_alive "$BACKEND_PORT"; then
    ok "backend  ${DIM}(external, port $BACKEND_PORT)${RESET}  http://localhost:$BACKEND_PORT"
  else
    warn "backend  not running"
  fi

  if is_running frontend; then
    ok "frontend pid $(cat "$FRONTEND_PID")  http://localhost:$FRONTEND_PORT"
  elif port_alive "$FRONTEND_PORT"; then
    ok "frontend ${DIM}(external, port $FRONTEND_PORT)${RESET}  http://localhost:$FRONTEND_PORT"
  else
    warn "frontend not running"
  fi

  local n; n=$(docker ps -q --filter "$SCANNER_FILTER" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$n" -gt 0 ]; then
    hi "$n active scanner container(s):"
    docker ps --filter "$SCANNER_FILTER" --format "  {{.Names}}\t{{.Ports}}\t{{.Status}}"
  else
    hi "no active scanner containers"
  fi
}

cmd_logs() {
  if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != --follow ]; }; then
    err "usage: suites/security-patch/run logs [--follow]"
    return 2
  fi
  local files=()
  [ ! -f "$BACKEND_LOG" ] || files+=("$BACKEND_LOG")
  [ ! -f "$FRONTEND_LOG" ] || files+=("$FRONTEND_LOG")
  if [ ! -f "$BACKEND_LOG" ] && [ ! -f "$FRONTEND_LOG" ]; then
    err "no logs yet — run 'suites/security-patch/run start' first"
    exit 1
  fi
  if [ "${1:-}" = --follow ]; then
    tail -n 200 -f "${files[@]}"
  else
    tail -n 200 "${files[@]}"
  fi
}

cmd_clean() {
  hi "removing ola-agent-scanner-<uuid> containers (compose stack untouched)…"
  # Only scanner sibling containers; never ola-agent-backend / ola-agent-frontend.
  local targets; targets=$(docker ps -aq --filter "$SCANNER_FILTER" 2>/dev/null || true)
  if [ -z "$targets" ]; then ok "no scanner containers to remove"; return; fi
  local n=0
  while IFS= read -r id; do
    docker rm -f "$id" >/dev/null 2>&1 && n=$((n + 1))
  done <<< "$targets"
  ok "removed $n container(s)"
}

cmd_build_scanner() {
  hi "building scanner image ola-agent-scanner:latest…"
  ( cd "$REPO_ROOT" && docker build -f scanner/Dockerfile -t ola-agent-scanner:latest . )
  ok "scanner image built"
}

# settings-mode auth: read the host ~/.claude/settings.json `env` block (where
# cc-switch writes the active provider) and export its ANTHROPIC_* vars into the
# current shell. The backend (host-process or compose-forwarded) then passes
# them to scanner containers. No OAuth credentials are read or mounted.
cmd_export_settings_env() {
  if ! command -v jq >/dev/null; then
    err "jq is required for --auth=settings — 'brew install jq'"; exit 1
  fi
  if [ ! -f "$SETTINGS_JSON" ]; then
    err "$SETTINGS_JSON not found — open cc-switch and select a provider, or use --auth=oauth"
    exit 1
  fi
  local kv exported=0
  while IFS= read -r kv; do
    [ -z "$kv" ] && continue
    export "$kv"
    exported=$((exported + 1))
  done < <(jq -r '.env // {} | to_entries[] | select(.key|startswith("ANTHROPIC_")) | "\(.key)=\(.value)"' "$SETTINGS_JSON")
  if [ -z "${ANTHROPIC_AUTH_TOKEN:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    err "$SETTINGS_JSON has no ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY in its env block — pick a provider in cc-switch, or use --auth=oauth"
    exit 1
  fi
  # Signal the mode to the backend (and to compose, which forwards it) so OAuth
  # credential mounting / refresh is disabled even where the path is hard-coded.
  export OLA_AGENT_AUTH_MODE=settings
  ok "settings auth: exported $exported ANTHROPIC_* var(s) from $SETTINGS_JSON"
}

# ----- compose subcommands --------------------------------------------------

# Extract just the claudeAiOauth slice from the host OAuth store and write a
# file the backend container can mount. Filtering keeps unrelated MCP tokens
# out of the container's view.
cmd_compose_export_creds() {
  local platform; platform=$(uname -s)
  case "$platform" in
    Darwin)
      hi "exporting claudeAiOauth from macOS Keychain…"
      if ! command -v jq >/dev/null; then
        err "jq is required for credential filtering on macOS — 'brew install jq'"
        exit 1
      fi
      if ! security find-generic-password -s 'Claude Code-credentials' -w 2>/dev/null \
            | jq '{claudeAiOauth}' > "$CREDS_FILE.tmp"; then
        err "could not read 'Claude Code-credentials' from Keychain — run 'claude login' first"
        rm -f "$CREDS_FILE.tmp"
        exit 1
      fi
      mv "$CREDS_FILE.tmp" "$CREDS_FILE"
      chmod 600 "$CREDS_FILE"
      ok "wrote $CREDS_FILE (claudeAiOauth only)"
      ;;
    Linux)
      hi "copying ~/.claude/.credentials.json…"
      if [ ! -f "$HOME/.claude/.credentials.json" ]; then
        err "$HOME/.claude/.credentials.json missing — run 'claude login' first"
        exit 1
      fi
      cp "$HOME/.claude/.credentials.json" "$CREDS_FILE"
      chmod 600 "$CREDS_FILE"
      ok "wrote $CREDS_FILE"
      ;;
    *)
      err "compose mode auto-export unsupported on $platform; copy your credentials manually to $CREDS_FILE"
      exit 1
      ;;
  esac
}

# Base (macOS dev) compose flow: export the Keychain/file credential slice,
# then bring up just the base compose file.
cmd_compose_start() {
  prepare
  if [ "$AUTH_MODE" = "settings" ]; then
    # Export ANTHROPIC_* + OLA_AGENT_AUTH_MODE into the shell; the base compose
    # forwards them to the backend container (see docker-compose.yml).
    cmd_export_settings_env
  else
    cmd_compose_export_creds
  fi
  hi "docker compose up -d --build…"
  ( cd "$REPO_ROOT" && docker compose up -d --build )
  say ""
  ok "compose stack up"
  say "  ${BLUE}Open:${RESET}     http://localhost:$FRONTEND_PORT"
  say "  ${DIM}backend:  http://localhost:$BACKEND_PORT/api/health${RESET}"
  say "  ${DIM}logs:     docker compose logs -f${RESET}"
  say "  ${DIM}stop:     ./scripts/dev.sh compose:stop${RESET}"
}

cmd_compose_stop() {
  hi "docker compose down…"
  ( cd "$REPO_ROOT" && docker compose down )
  cmd_clean
  remove_creds
}

# Linux server compose flow: layer docker-compose.server.yml on the base. No
# Keychain export — the override mounts the host's ~/.claude/.credentials.json
# (kept fresh by the keep-claude-token-fresh cron) directly, and the per-run
# refresh writes the slice to .runtime for scanners. Ports bind to 127.0.0.1.
SERVER_COMPOSE="-f docker-compose.yml -f docker-compose.server.yml"

cmd_compose_server_start() {
  prepare
  if [ "$AUTH_MODE" = "settings" ]; then
    cmd_export_settings_env
    # The server override (docker-compose.server.yml) still RO-mounts
    # $HOME/.claude/.credentials.json. The backend ignores it in settings mode,
    # but Docker creates an empty dir if that file is absent — keep it present.
    if [ ! -f "$HOME/.claude/.credentials.json" ]; then
      warn "server+settings: $HOME/.claude/.credentials.json absent; docker-compose.server.yml mounts it. Run 'claude login' once, or drop that volume from the override."
    fi
  elif [ -z "${ANTHROPIC_API_KEY:-}" ] && [ ! -f "$HOME/.claude/.credentials.json" ]; then
    # Bare OAuth (no API key) needs the host credentials file to exist.
    err "$HOME/.claude/.credentials.json missing and ANTHROPIC_API_KEY unset — run 'claude login', set an API key in .env, or use --auth=settings"
    exit 1
  fi
  hi "docker compose (base + server override) up -d --build…"
  ( cd "$REPO_ROOT" && docker compose $SERVER_COMPOSE up -d --build )
  say ""
  ok "server stack up (bound to 127.0.0.1)"
  say "  ${BLUE}Tunnel:${RESET}   ssh -L $FRONTEND_PORT:localhost:$FRONTEND_PORT <user>@<server>"
  say "  ${DIM}then open http://localhost:$FRONTEND_PORT${RESET}"
  say "  ${DIM}logs:     docker compose $SERVER_COMPOSE logs -f${RESET}"
  say "  ${DIM}stop:     ./scripts/dev.sh compose:server:stop${RESET}"
}

cmd_compose_server_stop() {
  hi "docker compose (base + server override) down…"
  ( cd "$REPO_ROOT" && docker compose $SERVER_COMPOSE down )
  cmd_clean
}

usage() {
  cat <<EOF
Security Patch Agent local dev manager.

Usage: $(basename "$0") <command>

  start     Start backend (Bun on :$BACKEND_PORT) + frontend (Vite on :$FRONTEND_PORT).
            Keep unchanged servers. Reload changed backend settings when no scans are active.
  dev       Start with developer controls (Smoke check and subagents).
  stop      Stop idle servers, remove scanner containers and exported creds. --force overrides the run guard.
  restart   stop + start.
  status    Show server PIDs and live scanner containers.
  check     Verify prereqs (docker / bun / claude CLI / login creds).
  logs [--follow]  show the last 200 lines, optionally follow new lines.
  clean     Remove scanner containers only (compose stack untouched).

  build:scanner  Build the ola-agent-scanner:latest image (Dockerfile in scanner/).

  compose:start  Export OAuth creds (Keychain/file) → build scanner image → docker compose up.
  compose:stop   docker compose down + clean scanner containers + remove exported creds.

  compose:server:start  Linux server: base + docker-compose.server.yml (ports on
                        127.0.0.1, host OAuth creds mounted). No Keychain export.
  compose:server:stop   Tear down the server stack + clean scanner containers.

Auth (append --auth=MODE to start / dev / compose:start / compose:server:start):
  --auth=oauth     (default) Claude subscription credentials (Keychain/file).
  --auth=settings  Follow host ~/.claude/settings.json provider (cc-switch):
                   ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ... — no claude
                   login needed, no keys in .env. Equivalent: OLA_AGENT_AUTH_MODE=settings.

Open after start:  http://localhost:$FRONTEND_PORT
EOF
}

case "${1:-help}" in
  start)          cmd_start ;;
  dev)            DEV_MODE=1 cmd_start ;;
  stop)           cmd_stop "${@:2}" ;;
  restart)        cmd_restart "${@:2}" ;;
  status)         cmd_status ;;
  check)          load_dotenv; resolve_auth_mode; cmd_check ;;
  logs)           cmd_logs "${@:2}" ;;
  clean)          cmd_clean ;;
  build:scanner)  cmd_build_scanner ;;
  compose:start)  cmd_compose_start ;;
  compose:stop)   cmd_compose_stop ;;
  compose:server:start) cmd_compose_server_start ;;
  compose:server:stop)  cmd_compose_server_stop ;;
  help|--help|-h|"") usage ;;
  *) err "unknown command: $1"; usage; exit 2 ;;
esac
