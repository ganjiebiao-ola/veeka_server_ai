# scripts/lib/harness.sh — destructive-action harness primitives (#50)
#
# POSIX sh, zero-dependency. `source` this from any script that may perform a destructive action, and
# gate that action behind harness_guard. This is the block-and-confirm / dry-run interface that
# agent-instructions/security-defaults.md §2 declares but does not implement.
#
# Trusted channel (the key design): approval is read from /dev/tty — a human at the controlling
# terminal. A model driving the script over stdin, injected repo content, or a CI pipeline CANNOT
# forge a /dev/tty response, so an approval genuinely comes "from outside the model and the repo"
# (security-defaults §1/§4). /dev/tty is the ONLY channel this function reads; no controlling
# terminal → fail-safe BLOCKED. The out-of-band alternative is a process, not a channel: land the
# destructive change through a reviewed PR instead of executing it live — nothing here reads or
# verifies a PR approval.
#
# Red line (assert, never relax): a destructive action never writes a credential into the repo and
# always reuses the operator's own local permissions — never a team-wide key
# (rules/access-and-credentials.md). Credential-in-repo scanning is scripts/check-secret-scan.

# 根目录解析（绝不用 CWD）：runs/harness-log.jsonl 必须落在【本工作区】里，而不是当前工作目录
# 恰好所在的那个 git 仓库 —— 从挂载在 repos/<repo>/ 里的目录调用时，`git rev-parse --show-toplevel`
# 会返回那个业务仓库的根，日志就写进了别人的仓库（且在那里没有被 gitignore）。
# 本文件是被 `.`（source）进来的，POSIX sh 下 `$0` 给的是调用方脚本、不是本文件，所以按优先级取：
#   1) 调用方在 source 之前设好的 HARNESS_ROOT —— 每个 source 点自己已经算过 root，最可靠；
#   2) bash 的 $BASH_SOURCE（等价于 ${BASH_SOURCE[0]}，dash/POSIX sh 下为空，语法本身仍合法），
#      本文件在 scripts/lib/ 下，向上两级即工作区根；
#   3) 兜底 git rev-parse / pwd —— 仅在 POSIX sh 且调用方没传 HARNESS_ROOT 时才会走到，
#      也就是上面那个 CWD 敏感的老行为，所以新增 source 点请一律显式传 HARNESS_ROOT。
# 只在 source 时解析一次：之后调用方 cd 到哪里都不影响日志落点。
# 校验 + 归一化：调用方传入的 HARNESS_ROOT 可能是相对路径（如 "."，会继续跟着 CWD 跑，等于没修复
# CWD 敏感问题）或者压根不是本工作区根（例如误继承了别处的环境变量）。统一 cd 进去取绝对路径，并
# 确认 scripts/lib/harness.sh 自身就在这个根下面——校验失败一律当作没传，走后面的兜底分支。
if [ -n "${HARNESS_ROOT:-}" ]; then
  _hr_abs=$(CDPATH= cd -- "$HARNESS_ROOT" 2>/dev/null && pwd)
  if [ -n "$_hr_abs" ] && [ -f "$_hr_abs/scripts/lib/harness.sh" ]; then
    HARNESS_ROOT="$_hr_abs"
  else
    HARNESS_ROOT=""
  fi
  unset _hr_abs
fi
if [ -z "${HARNESS_ROOT:-}" ] && [ -n "${BASH_SOURCE:-}" ]; then
  HARNESS_ROOT=$(CDPATH= cd -- "$(dirname -- "$BASH_SOURCE")/../.." 2>/dev/null && pwd)
fi
if [ -z "${HARNESS_ROOT:-}" ]; then
  HARNESS_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
fi

_harness_root() { printf '%s' "$HARNESS_ROOT"; }
# sha 一律相对工作区根取（同理，不能取到业务仓库的 HEAD）；无 .git（如 `ws init` 出来的新工作区）时降级。
_harness_sha()  { git -C "$(_harness_root)" rev-parse HEAD 2>/dev/null || echo "0000000000000000000000000000000000000000"; }
_harness_short(){ git -C "$(_harness_root)" rev-parse --short HEAD 2>/dev/null || echo "nogit"; }
_harness_run_id() { printf 'run-%s-%s' "$(date -u +%Y%m%dT%H%M%SZ)" "$(_harness_short)"; }
_json_escape()  { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# _harness_log <run_id> <ts> <sha> <action> <target> <decision> <approver> <channel>
_harness_log() {
  _hl_root="$(_harness_root)"
  mkdir -p "$_hl_root/runs"
  if [ -n "$7" ]; then _hl_appr="\"$(_json_escape "$7")\""; else _hl_appr="null"; fi
  printf '{"run_id":"%s","ts":"%s","workspace_sha":"%s","action":"%s","target":"%s","decision":"%s","approver":%s,"channel":"%s"}\n' \
    "$1" "$2" "$3" "$(_json_escape "$4")" "$(_json_escape "$5")" "$6" "$_hl_appr" "$8" \
    >> "$_hl_root/runs/harness-log.jsonl"
}

# harness_guard <action> <target>
# Blocks a destructive action until a human approves via /dev/tty. Returns 0 (approved) or 1 (blocked).
# Every call appends one record to runs/harness-log.jsonl (run_id, decision, approver, channel);
# runs/ is created on first use and gitignored — its format is platform-internals/runs-format.md.
harness_guard() {
  _hg_action="$1"; _hg_target="$2"
  _hg_run_id="$(_harness_run_id)"
  _hg_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  _hg_sha="$(_harness_sha)"

  printf '\n[harness] DESTRUCTIVE action requires approval\n' >&2
  printf '  run_id : %s\n  action : %s\n  target : %s\n' "$_hg_run_id" "$_hg_action" "$_hg_target" >&2

  # No controlling terminal (CI / pipe / model stdin) → fail-safe block; /dev/tty is the only
  # approval channel. Probe by actually opening /dev/tty: a bare
  # test -r/-w passes on macOS even when the device is "not configured" (node exists, open() fails).
  if ! { true < /dev/tty; } 2>/dev/null || ! { true > /dev/tty; } 2>/dev/null; then
    _harness_log "$_hg_run_id" "$_hg_ts" "$_hg_sha" "$_hg_action" "$_hg_target" "blocked" "" "no-tty"
    printf '  decision: BLOCKED (no controlling terminal — /dev/tty is the only approval channel; run from a real terminal, or land the change through a reviewed PR instead)\n' >&2
    return 1
  fi

  printf '  To approve: type your human-id, then re-type the exact target to confirm.\n' > /dev/tty
  # `IFS= read -r`: no backslash escaping AND no word-splitting, so a human-id or target containing
  # `\` or leading/trailing whitespace is confirmed verbatim (plain `read -r` still strips whitespace).
  printf '  human-id: ' > /dev/tty; IFS= read -r _hg_appr < /dev/tty
  printf '  confirm target (%s): ' "$_hg_target" > /dev/tty; IFS= read -r _hg_confirm < /dev/tty

  if [ -n "$_hg_appr" ] && [ "$_hg_confirm" = "$_hg_target" ]; then
    _harness_log "$_hg_run_id" "$_hg_ts" "$_hg_sha" "$_hg_action" "$_hg_target" "approved" "$_hg_appr" "tty"
    printf '  decision: APPROVED by %s (run_id %s)\n' "$_hg_appr" "$_hg_run_id" >&2
    return 0
  fi

  _harness_log "$_hg_run_id" "$_hg_ts" "$_hg_sha" "$_hg_action" "$_hg_target" "blocked" "$_hg_appr" "tty"
  printf '  decision: BLOCKED (human-id empty or target confirmation mismatch)\n' >&2
  return 1
}

# harness_dryrun <cmd...>
# When DRY_RUN=1, print what would run instead of running it. Otherwise execute normally.
harness_dryrun() {
  if [ "${DRY_RUN:-0}" = "1" ]; then
    printf '[harness] DRY_RUN: would execute: %s\n' "$*" >&2
    return 0
  fi
  "$@"
}
