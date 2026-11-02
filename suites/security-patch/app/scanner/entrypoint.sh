#!/usr/bin/env bash
# Scanner container entrypoint.
#
# Required env (injected by backend `docker run -e ...`):
#   RUN_ID     uuid for the scan
#   REPO_URL   git clone URL (https://github.com/...). Not used when
#              LOCAL_WORKSPACE=1.
#   BRANCH     branch name (may be empty → fallback main → master)
#   COMMIT_SHA optional full commit SHA, cloned without a depth limit
#   SKILL      ola-security-audit (skill runs only)
#   MODEL      fable | opus | sonnet | haiku  (or full versioned ID; bridge.mjs
#              maps fable to claude-fable-5 and haiku to claude-haiku-5-5)
#   EFFORT     low | medium | high | xhigh | max
#   MODE       scan | fix
#
# Generic headless runs (set together by the backend; absent on skill runs):
#   LOCAL_WORKSPACE=1   /workspace/repo is a host bind mount — skip auth+clone
#   PROMPT_FILE         path of the raw task prompt (read by bridge.mjs)
#   EVENTS_LOG=1        bridge appends every frame to artifacts/events.jsonl
#   WORKSPACE_CHOWN     "uid:gid" to chown the workspace back to on exit
#
# Auth:
#   GH_TOKEN env (Personal Access Token)
#      → given to the clone/fetch git processes (and bridge push) through an
#        inline credential helper, never a file. REPO_URL must be
#        a https://github.com/ URL.
#   Without it only public repos work.
#
# Output protocol: JSONL on stdout, one event per line.
# Input (stdin): JSONL push and shutdown commands from backend.
set -u
set -o pipefail

emit()  { printf '%s\n' "$1" >&2; }              # diagnostic only
emitj() { printf '%s\n' "$1"; }                  # protocol → stdout

run_id="${RUN_ID:-unknown}"
branch="${BRANCH:-}"

status() {
  emitj "$(jq -cn --arg r "$run_id" --arg s "$1" '{runId:$r,kind:"scanner_status",status:$s}')"
}

fail() {
  emitj "$(jq -cn --arg r "$run_id" --arg e "$1" '{runId:$r,kind:"scanner_failed",error:$e}')"
  exit 1
}

# --- 0. check the Codex sandbox before auth, cloning, or model requests -----
# Docker can block bubblewrap namespace creation even when the CLI starts.
if [ "${PROVIDER:-claude}" = "codex" ] || {
  [ "${MODE:-fix}" = "fix" ] && [ "${REVIEW_PROVIDER:-claude}" = "codex" ]
}; then
  # Codex rejects a CODEX_HOME that does not exist. An API-key run mounts no login file to create it.
  [ -z "${CODEX_HOME:-}" ] || mkdir -p "$CODEX_HOME"
  if ! timeout 10s "${CODEX_PATH:-/usr/local/bin/codex}" -s read-only sandbox -- /bin/true >/dev/null 2>&1; then
    fail "Codex read-only sandbox preflight failed. Check container namespace permissions and the Codex installation."
  fi
fi

# --- 1. configure git auth ------------------------------------------------
# Generic headless runs (LOCAL_WORKSPACE=1): /workspace/repo is a host bind
# mount prepared by the caller — no git auth, no clone. Sanity-check the
# mount and emit the clone_done frame the orchestrator expects for its
# "ingest" step, then fall through to the bridge.
if [ "${LOCAL_WORKSPACE:-}" = "1" ]; then
  if [ ! -d /workspace/repo ] || [ -z "$(ls -A /workspace/repo 2>/dev/null)" ]; then
    fail "workspace mount missing or empty at /workspace/repo"
  fi
  emitj "$(jq -cn --arg r "$run_id" '{runId:$r,kind:"clone_done",branch:"(local)"}')"
fi

# Root-only credential dirs: the agent user cannot list or open anything under them.
chmod 700 /root/.ssh /root/.codex /root/.gemini /root/.qoder 2>/dev/null || true

if [ "${LOCAL_WORKSPACE:-}" = "1" ]; then
  : # bind-mounted workspace — git auth not needed
elif [ -n "${GH_TOKEN:-}" ]; then
  emit "auth: GH_TOKEN env (PAT)"
  # The token only goes to github.com. Any other host (or userinfo such as
  # https://github.com@evil.example/x) could receive it, so refuse the run.
  case "${REPO_URL:-}" in
    https://github.com/*) ;;
    *) fail "GH_TOKEN auth requires REPO_URL to start with https://github.com/" ;;
  esac
  # No credentials file: the agent can read files in the container, and the
  # contents could leak into events.jsonl or report.md. remote_git (clone
  # block) and lib/push.mjs give the token to one git process via its env.
  # The agent runs as user "agent" (lib/agent-user.mjs) with the token scrubbed
  # from its env. This bridge process stays root, so /proc/<pid>/environ is closed to it.
  git_token=$GH_TOKEN
  export GH_TOKEN

else
  emit "auth: none — only public repos will succeed"
fi

# --- pre-set git identity so the model can run plain `git commit` ----------
# Without these, git refuses with "please tell me who you are" and the
# model fallbacks to `git -c user.email=... -c user.name=... commit ...`,
# which (a) bloats every command, and (b) defeats the backend SdkMapper's
# commit-step heuristic regex (\bgit\s+commit\b).
# The agent user commits, so the identity goes in its own gitconfig. Root runs no git
# in /workspace/repo after the handoff below, so it needs no safe.directory entry.
agent_git() { git config --file /home/agent/.gitconfig "$@"; }
agent_git user.email "ola-codesec-agent@bot.local"
agent_git user.name  "Ola Codesec Agent"
agent_git commit.gpgsign false
chown agent:agent /home/agent/.gitconfig

# --- 2. clone with branch fallback -----------------------------------------
if [ "${LOCAL_WORKSPACE:-}" != "1" ]; then
  repo_url="${REPO_URL:?REPO_URL required}"
  status "cloning"
  # git with the GH_TOKEN credential helper for https://github.com only. The
  # token is in this one process's env, not in a file or in git config.
  remote_git() {
    if [ -n "${git_token:-}" ]; then
      SECPATCH_GIT_TOKEN="$git_token" git -c credential.helper= \
        -c 'credential.https://github.com.helper=!f() { test "$1" = get && echo username=x-access-token && echo "password=$SECPATCH_GIT_TOKEN"; }; f' "$@"
    else
      git "$@"
    fi
  }
  clone_branch() {
    rm -rf /workspace/repo
    if [ -n "${COMMIT_SHA:-}" ]; then
      remote_git clone --no-tags "$repo_url" /workspace/repo 2>/tmp/clone.err
    else
      remote_git clone --depth 50 --no-tags ${1:+--branch "$1"} "$repo_url" /workspace/repo 2>/tmp/clone.err
    fi
  }

  if [ -n "${COMMIT_SHA:-}" ]; then
    [[ "$COMMIT_SHA" =~ ^[a-fA-F0-9]{40}$ ]] || fail "COMMIT_SHA must be a full 40-character commit SHA"
    clone_branch "" || fail "git clone failed for commit SHA"
    remote_git -C /workspace/repo fetch --no-tags origin "$COMMIT_SHA" 2>/tmp/clone.err || fail "git fetch failed for commit SHA"
    git -C /workspace/repo checkout --detach "$COMMIT_SHA" 2>/tmp/clone.err || fail "git checkout failed for commit SHA"
    [ "$(git -C /workspace/repo rev-parse HEAD)" = "$(printf '%s' "$COMMIT_SHA" | tr '[:upper:]' '[:lower:]')" ] || fail "commit SHA mismatch"
  elif [ -n "$branch" ]; then
    if ! clone_branch "$branch"; then
      fail "git clone failed on branch '$branch': $(tr '\n' ' ' < /tmp/clone.err | head -c 500)"
    fi
  else
    if ! clone_branch "main"; then
      emit "main clone failed, trying master…"
      if ! clone_branch "master"; then
        fail "git clone failed on main and master: $(tr '\n' ' ' < /tmp/clone.err | head -c 500)"
      fi
    fi
  fi

  actual_branch=$(git -C /workspace/repo rev-parse --abbrev-ref HEAD || echo "HEAD")
  if [ -n "${COMMIT_SHA:-}" ]; then
    actual_branch="${branch:-$(git -C /workspace/repo symbolic-ref --short refs/remotes/origin/HEAD | sed 's|^origin/||')}"
  fi
  emitj "$(jq -cn --arg r "$run_id" --arg b "$actual_branch" '{runId:$r,kind:"clone_done",branch:$b}')"
fi

# Record the clone baseline: bridge uses .sha for patch/commits diff, backend
# uses .branch for the compare URL base. Written to the mounted artifacts dir
# so the backend can read it even after the container is gone.
base_sha=$(git -C /workspace/repo rev-parse HEAD 2>/dev/null || echo "")
if [ -n "$base_sha" ]; then
  jq -cn --arg s "$base_sha" --arg b "${actual_branch:-}" \
    '{sha:$s, branch:$b}' > /workspace/artifacts/base.json
fi

# Resume: replay the stopped run's commits on top of the base. base.json keeps the original base.
if [ -n "${RESUME_BUNDLE:-}" ]; then
  git -C /workspace/repo fetch -q "$RESUME_BUNDLE" HEAD 2>/tmp/resume.err \
    && git -C /workspace/repo checkout -q FETCH_HEAD 2>>/tmp/resume.err \
    || fail "resume bundle did not apply: $(tr '\n' ' ' < /tmp/resume.err | head -c 300)"
fi

# --- 3. start the SDK bridge -----------------------------------------------
# bridge.mjs owns its own status transitions. Don't pre-emit "scanning" here.
# Restore the bind mount even if setup fails after the ownership handoff.
workspace_owner=""
if [ "${LOCAL_WORKSPACE:-}" = "1" ]; then
  workspace_owner=$(stat -c %u:%g /workspace/repo) || fail "could not record workspace owner"
fi
restore_workspace_owner() {
  setpriv --reuid=agent --regid=agent --clear-groups kill -9 -- -1 2>/dev/null || true
  if [ "${LOCAL_WORKSPACE:-}" = "1" ]; then
    chown -hR "${WORKSPACE_CHOWN:-$workspace_owner}" /workspace/repo 2>/dev/null || true
  fi
}
trap restore_workspace_owner EXIT
# Hand the workspace to the agent user. It gets the model login as a copy, never
# GH_TOKEN. Root pushes from its own repo, built from a bundle the agent writes.
chown -R agent:agent /workspace/repo || fail "could not give /workspace/repo to the agent user"
# The backend copies the scanned repo's current notes into the run. Install them where the skill reads them.
notes_dir=/root/.claude/skills/ola-security-audit/targets
notes_name=$(printf '%s' "${REPO_URL:-}" | sed -nE 's#^https://github\.com/([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+)$#\1__\2#p' | sed 's/\.git$//')
if [ -n "$notes_name" ] && [ -f /workspace/artifacts/target-notes.md ] && [ ! -L /workspace/artifacts/target-notes.md ]; then
  mkdir -p "$notes_dir" && install -o root -g root -m 644 /workspace/artifacts/target-notes.md "$notes_dir/$notes_name.md" ||
    fail "could not install the repo notes"
fi
chmod 1777 /workspace/artifacts
# Share only named inputs and carried outputs. Keep host access through the input owner or output group.
for name in picked.json repo-context.json prompt.txt resume-checkpoint.json resume-report.md auth.json findings.json review-1.json review-2.json checks.json resume.bundle; do
  file=/workspace/artifacts/$name
  [ -f "$file" ] && [ ! -L "$file" ] || continue
  case "$name" in
    # Agent ownership also permits atomic replacement in the sticky artifacts directory.
    auth.json|findings.json|review-1.json|review-2.json|resume.bundle) chown agent "$file" && chmod 660 "$file" ;;
    # No agent process exists yet. Carried checks remain a root-written output.
    checks.json) chown root "$file" && chmod 644 "$file" ;;
    *) chgrp agent "$file" && chmod 640 "$file" ;;
  esac || fail "could not share $name with the agent user"
done
if [ -f /root/.claude/.credentials.json ]; then
  install -o agent -g agent -m 600 /root/.claude/.credentials.json /home/agent/.claude/.credentials.json
fi
# Codex and Antigravity rotate their tokens inside a run. The agent works on a copy, so on exit root
# copies a sane refreshed file back into the mounted one. In place: a bind-mounted file can't be renamed over.
codex_keys=""
if [ -n "${CODEX_HOME:-}" ] || [ -f /root/.codex/auth.json ]; then
  install -d -o agent -g agent -m 700 /home/agent/.codex
fi
if [ -f /root/.codex/auth.json ]; then
  codex_keys=$(jq -c 'keys' /root/.codex/auth.json 2>/dev/null) || codex_keys=""
  install -o agent -g agent -m 600 /root/.codex/auth.json /home/agent/.codex/auth.json
fi
agy_keys=""
if [ -f /root/.gemini/antigravity-cli/antigravity-oauth-token ]; then
  agy_keys=$(jq -c 'keys' /root/.gemini/antigravity-cli/antigravity-oauth-token 2>/dev/null) || agy_keys=""
  install -d -o agent -g agent -m 700 /home/agent/.gemini/antigravity-cli
  install -o agent -g agent -m 600 /root/.gemini/antigravity-cli/antigravity-oauth-token /home/agent/.gemini/antigravity-cli/antigravity-oauth-token
fi
if [ -d /root/.qoder/.auth ]; then
  install -d -o agent -g agent -m 700 /home/agent/.qoder/.auth
  for src in /root/.qoder/.auth/*; do
    [ -f "$src" ] && [ ! -L "$src" ] || continue
    case "${src##*/}" in
      user|machine_id|dynamic-*.json) install -o agent -g agent -m 600 "$src" "/home/agent/.qoder/.auth/${src##*/}" ;;
    esac
  done
  # Copy-back compares against this, so a host login refreshed during the run is never overwritten.
  [ -f /root/.qoder/.auth/user ] && [ ! -L /root/.qoder/.auth/user ] && install -m 600 /root/.qoder/.auth/user /root/.qoder/user.snapshot
fi
# Never fails the run. Args: agent copy, mounted file, JSON array of the mounted file's top-level keys
# (or "opaque" for a non-JSON token file), provider label, and for "opaque" the mounted file's copy-in snapshot.
auth_copy_back() {
  local src=$1 dst=$2 keys=$3 label=$4 snapshot=${5:-} why=""
  [ -n "$keys" ] || return 0
  setpriv --reuid=agent --regid=agent --clear-groups kill -9 -- -1 2>/dev/null || true
  # Keep one bounded agent read in memory. Only the root-only destination uses root IO.
  why=$(bun -e '
    import { agentFs } from "/opt/lib/agent-fs.mjs"
    import { readFileSync, writeFileSync } from "node:fs"
    const [src, dst, keys, snapshot] = process.argv.slice(1)
    let bytes
    try { bytes = agentFs.readFileSync(src, undefined, 65536) }
    catch (error) { console.log(error.message === "file too large" ? "over 64 KiB" : "not a regular file"); process.exit(0) }
    if (keys === "opaque") {
      try {
        const before = readFileSync(snapshot)
        if (!bytes.length) console.log("empty file")
        else if (!before.equals(readFileSync(dst))) console.log("host login changed during the run")
        else if (!bytes.equals(before)) writeFileSync(dst, bytes)
      } catch { console.log("write failed") }
      process.exit(0)
    }
    let value
    try { value = JSON.parse(bytes.toString("utf8")) } catch { console.log("not a JSON object"); process.exit(0) }
    if (!value || typeof value !== "object" || Array.isArray(value)) console.log("not a JSON object")
    else if (Object.keys(value).some(key => !JSON.parse(keys).includes(key))) console.log("new top-level keys")
    else {
      try { if (!bytes.equals(readFileSync(dst))) writeFileSync(dst, bytes) }
      catch { console.log("write failed") }
    }
  ' "$src" "$dst" "$keys" "$snapshot") || why="copy failed"
  [ -z "$why" ] || emit "$label auth copy-back skipped: $why"
  return 0
}
# Run the bridge as a child (not exec) so control returns here on exit: the Codex and Antigravity logins
# are copied back, and in a local workspace the bind mount is chowned back to the caller (the
# container runs as root, and root-owned files would break the caller's cleanup).
# docker stop's SIGTERM is forwarded to the bridge, so this path runs inside the stop grace window.
# A normal run keeps stdin for the backend's push and shutdown commands.
if [ "${LOCAL_WORKSPACE:-}" = "1" ]; then
  bun /opt/bridge.mjs &
else
  bun /opt/bridge.mjs <&0 &
fi
child=$!
trap 'kill -TERM "$child" 2>/dev/null' TERM INT
wait "$child"
rc=$?
if kill -0 "$child" 2>/dev/null; then
  # wait was interrupted by the trap — reap the bridge for its real status.
  wait "$child" 2>/dev/null
  rc=$?
fi
auth_copy_back /home/agent/.codex/auth.json /root/.codex/auth.json "$codex_keys" codex
auth_copy_back /home/agent/.gemini/antigravity-cli/antigravity-oauth-token /root/.gemini/antigravity-cli/antigravity-oauth-token "$agy_keys" antigravity
# Only the login token can refresh. machine_id and the dynamic-* text caches are never written back.
[ -f /root/.qoder/user.snapshot ] && auth_copy_back /home/agent/.qoder/.auth/user /root/.qoder/.auth/user opaque qoder /root/.qoder/user.snapshot
# The artifacts dir is a host bind mount: undo the run-time 1777 so the host folder is not left world-writable.
chmod 755 /workspace/artifacts 2>/dev/null || true
exit "$rc"
