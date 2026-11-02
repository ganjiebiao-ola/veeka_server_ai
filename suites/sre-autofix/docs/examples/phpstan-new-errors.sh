#!/usr/bin/env sh
# phpstan-new-errors.sh — example `config.yaml repos[].checks` command for a PHP repo with NO composer
# autoload and NO maintained PHPStan baseline: report only the errors a patch INTRODUCES.
#
#   checks: ["sh {root}/suites/sre-autofix/docs/examples/phpstan-new-errors.sh {worktree} {files}"]
#   ({root} = the workspace root: check commands run with cwd = the worktree, so a relative path would not resolve)
#
# How: (1) the changed files' HEAD versions are extracted to a temp dir and analysed once with
# --generate-baseline; (2) the patched files in the worktree are analysed with that baseline. Only new
# errors survive → non-zero exit. Both runs resolve symbols by scanning PHPSTAN_SCAN (default app/) plus
# optional framework stubs, so nothing is installed and nothing is written into the worktree.
#
# Env (all optional):
#   PHPSTAN_IMAGE   docker image            default ghcr.io/phpstan/phpstan:2
#   PHPSTAN_LEVEL   rule level              default 5  (argument.byRef — the 2026-08-26 drill bug — needs ≥ 5)
#   PHPSTAN_SCAN    dir under the worktree scanned for symbols   default app
#   PHPSTAN_STUBS   host dir of framework stubs (e.g. phalcon/ide-stubs src/) — mounted read-only
#   PHPSTAN_CACHE   host dir for PHPStan's result cache          default $HOME/.cache/sre-autofix/phpstan
#   PHPSTAN_MEM     --memory-limit                               default 2G
# Requires: docker, git. Non-PHP files are ignored; no PHP files → exit 0.
set -u
wt=${1:?worktree}; shift
IMAGE=${PHPSTAN_IMAGE:-ghcr.io/phpstan/phpstan:2}
LEVEL=${PHPSTAN_LEVEL:-5}
SCAN=${PHPSTAN_SCAN:-app}
CACHE=${PHPSTAN_CACHE:-$HOME/.cache/sre-autofix/phpstan}
MEM=${PHPSTAN_MEM:-2G}

files=""
for f in "$@"; do
  case "$f" in *.php) files="$files $f";; esac
done
[ -n "$files" ] || { echo "phpstan-new-errors: no PHP files changed, nothing to check"; exit 0; }
command -v docker >/dev/null || { echo "phpstan-new-errors: docker not on PATH"; exit 127; }

tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/base" "$tmp/cfg" "$CACHE"

# 1. HEAD versions of the changed files (new files have no base → nothing to baseline for them)
base_list=""
for f in $files; do
  if git -C "$wt" cat-file -e "HEAD:$f" 2>/dev/null; then
    mkdir -p "$tmp/base/$(dirname "$f")"
    git -C "$wt" show "HEAD:$f" > "$tmp/base/$f"
    base_list="$base_list /work/$f"
  fi
done

stub_mount=""; stub_scan=""
if [ -n "${PHPSTAN_STUBS:-}" ]; then
  stub_mount="-v $PHPSTAN_STUBS:/stubs:ro"; stub_scan="        - /stubs"
fi
cat > "$tmp/cfg/phpstan.neon" <<EOF
parameters:
    level: $LEVEL
    tmpDir: /cache
    reportUnmatchedIgnoredErrors: false
    scanDirectories:
        - /scan
$stub_scan
EOF
cat > "$tmp/cfg/with-baseline.neon" <<EOF
includes:
    - phpstan.neon
    - baseline.neon
EOF
: > "$tmp/cfg/baseline.neon"

run_phpstan() {  # $1 = host dir mounted at /work, rest = phpstan args
  work=$1; shift
  # shellcheck disable=SC2086
  docker run --rm -v "$work:/work" -v "$wt/$SCAN:/scan:ro" -v "$tmp/cfg:/cfg" -v "$CACHE:/cache" $stub_mount \
    -w /work "$IMAGE" analyse --no-progress --memory-limit "$MEM" "$@"
}

if [ -n "$base_list" ]; then
  # shellcheck disable=SC2086
  run_phpstan "$tmp/base" -c /cfg/phpstan.neon --generate-baseline /cfg/baseline.neon $base_list >/dev/null 2>&1 \
    || echo "phpstan-new-errors: baseline generation reported errors (continuing; pre-existing errors are ignored)"
fi
pre=$(grep -c 'message:' "$tmp/cfg/baseline.neon" 2>/dev/null || echo 0)

patched_list=""
for f in $files; do patched_list="$patched_list /work/$f"; done
# shellcheck disable=SC2086
run_phpstan "$wt" -c /cfg/with-baseline.neon --error-format raw $patched_list
rc=$?
echo "phpstan-new-errors: level $LEVEL, $pre pre-existing error(s) ignored, exit $rc"
exit $rc
