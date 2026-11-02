#!/usr/bin/env sh
# regression/sync-fixture.sh — the sync mechanism on a synthetic upstream + downstream pair.
# Proves, with the REAL scripts/check-ownership and scripts/upstream-pin from <workspace-root>:
#   1. a downstream that only edits seed/team paths passes check-ownership against its pin;
#   2. a local edit to a framework path is caught (FAIL) — the "change upstream first" guard;
#   3. round 1: upstream edits a seed, edits a framework file, renames a framework file, adds a new seed
#      → `git merge` is conflict-free, the seed keeps the team's text, the framework follows upstream,
#      the renamed old path is gone, the new seed arrives; check-ownership fails until upstream-pin, then passes;
#   4. round 2: both sides edit the same seed again → still conflict-free, the team's text wins;
#   5. negative: a clone WITHOUT merge.ours.driver conflicts on the seed — why the skill's preflight sets it;
#   6. rebase: git swaps ours/theirs, so merge-keep-team must still keep the team's seed text, while a
#      plain `true` driver silently drops it — why the preflight configures the script, not `true`;
#   7. first pin: upstream-pin over the seed workspace.yaml's multi-word placeholder writes a clean sha
#      that check-ownership accepts, and a re-pin keeps a trailing `# comment`.
# Pure git + python3, everything under a mktemp dir. Usage: sync-fixture.sh <workspace-root>
set -e
ws="${1:?usage: sync-fixture.sh <workspace-root>}"
ws="$(CDPATH= cd -- "$ws" && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/sync-fixture.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT INT TERM
fail=0
say() { printf '  %s\n' "$*"; }
expect() {  # expect <desc> <want-rc> <cmd...>
  _d="$1"; _w="$2"; shift 2
  set +e; "$@" >"$tmp/out" 2>&1; _rc=$?; set -e
  if [ "$_rc" = "$_w" ]; then say "ok   $_d"; else say "FAIL $_d (rc=$_rc, want $_w)"; sed 's/^/       /' "$tmp/out"; fail=1; fi
}
gitq() { git -c user.name=fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false "$@"; }

# --- upstream (stands in for the template) -------------------------------------------------------
up="$tmp/up"; mkdir -p "$up"; cd "$up"; gitq init -q -b main .
mkdir -p platform-internals scripts/lib agent-instructions rules
cp "$ws/scripts/check-ownership" "$ws/scripts/upstream-pin" scripts/
cp "$ws/scripts/lib/merge-keep-team" scripts/lib/
cat > platform-internals/ownership.yaml <<'YAML'
version: 1
framework:
  - .gitattributes
  - agent-instructions/
  - platform-internals/
  - scripts/
seed:
  - README.md
  - rules/
  - workspace.yaml
generated:
  - CLAUDE.md
YAML
cat > .gitattributes <<'ATTR'
/README.md merge=ours
rules/** merge=ours
/workspace.yaml merge=ours
/CLAUDE.md merge=ours
ATTR
echo "template readme v1" > README.md
echo "<Team> rules v1" > rules/team-rules.md
echo "security defaults v1" > agent-instructions/security-defaults.md
echo "tool v1" > scripts/tool
echo "generated v1" > CLAUDE.md
printf 'owner: template\nteam: template\n' > workspace.yaml
gitq add -A; gitq commit -q -m "U1: template"; U1=$(git rev-parse HEAD)

# --- downstream (stands in for a team workspace) --------------------------------------------------
down="$tmp/down"; gitq clone -q "$up" "$down"; cd "$down"
git config merge.ours.driver 'scripts/lib/merge-keep-team %O %A %B'; git config rerere.enabled true
echo "team readme" > README.md
echo "PA rules" > rules/team-rules.md
printf 'owner: pa\nteam: pa\nupstream:\n  url: %s\n  branch: main\n  synced_commit: %s\n' "$up" "$U1" > workspace.yaml
gitq add -A; gitq commit -q -m "team fill-in"
expect "1.  seeds edited, framework untouched -> check-ownership OK" 0 python3 scripts/check-ownership .

echo "local hack" >> agent-instructions/security-defaults.md
expect "2.  local framework edit -> check-ownership FAIL" 1 python3 scripts/check-ownership .
git checkout -q -- agent-instructions/security-defaults.md

# --- round 1 --------------------------------------------------------------------------------------
cd "$up"
echo "template readme v2" > README.md
echo "security defaults v2" > agent-instructions/security-defaults.md
gitq mv scripts/tool scripts/tool2
echo "<Team> new rule" > rules/new-rule.md
gitq add -A; gitq commit -q -m "U2: seed edit, framework edit, rename, new seed"; U2=$(git rev-parse HEAD)

cd "$down"; gitq fetch -q origin
expect "3a. round-1 merge is conflict-free" 0 gitq merge --no-ff -q -m "sync U2" origin/main
[ "$(cat README.md)" = "team readme" ] && say "ok   3b. seed kept the team's text" || { say "FAIL 3b. seed lost the team's text: $(cat README.md)"; fail=1; }
[ "$(cat agent-instructions/security-defaults.md)" = "security defaults v2" ] && say "ok   3c. framework follows upstream" || { say "FAIL 3c. framework did not follow upstream"; fail=1; }
[ ! -e scripts/tool ] && [ -e scripts/tool2 ] && say "ok   3d. renamed framework file: old path gone" || { say "FAIL 3d. orphaned rename"; fail=1; }
[ -e rules/new-rule.md ] && say "ok   3e. new seed file arrived" || { say "FAIL 3e. new seed file missing"; fail=1; }
expect "3f. after merge, stale pin -> check-ownership FAIL" 1 python3 scripts/check-ownership .
expect "3g. upstream-pin U2" 0 python3 scripts/upstream-pin "$U2"
gitq add -A; gitq commit -q -m "pin U2"
expect "3h. pinned -> check-ownership OK" 0 python3 scripts/check-ownership .

# --- round 2: both sides touch the same seed again -----------------------------------------------
echo "team readme v2" > README.md; gitq commit -q -am "team readme v2"
cd "$up"; echo "template readme v3" > README.md; echo "security defaults v3" > agent-instructions/security-defaults.md
gitq commit -q -am "U3"; U3=$(git rev-parse HEAD)
cd "$down"; gitq fetch -q origin
expect "4a. round-2 merge is conflict-free" 0 gitq merge --no-ff -q -m "sync U3" origin/main
[ "$(cat README.md)" = "team readme v2" ] && say "ok   4b. team text wins again" || { say "FAIL 4b. seed clobbered"; fail=1; }
expect "4c. upstream-pin U3" 0 python3 scripts/upstream-pin "$U3"
gitq add -A; gitq commit -q -m "pin U3"
expect "4d. check-ownership OK" 0 python3 scripts/check-ownership .

# --- negative: no merge driver configured --------------------------------------------------------
down2="$tmp/down2"; gitq clone -q "$up" "$down2"; cd "$down2"
gitq checkout -q -b team "$U1"
echo "team readme" > README.md; gitq commit -q -am "team readme"
expect "5a. WITHOUT merge.ours.driver the seed conflicts" 1 gitq merge --no-ff -q -m "sync" origin/main
gitq merge --abort 2>/dev/null || true
git config merge.ours.driver 'scripts/lib/merge-keep-team %O %A %B'
expect "5b. WITH the driver the same merge is clean" 0 gitq merge --no-ff -q -m "sync" origin/main
[ "$(cat README.md)" = "team readme" ] && say "ok   5c. team text kept" || { say "FAIL 5c. seed clobbered"; fail=1; }

# --- rebase: the driver must keep the team's side even when git swaps ours/theirs ---------------
down3="$tmp/down3"; gitq clone -q "$up" "$down3"; cd "$down3"
git config merge.ours.driver 'scripts/lib/merge-keep-team %O %A %B'
gitq checkout -q -b team "$U1"
echo "team readme" > README.md; gitq commit -q -am "team readme"
expect "6a. rebase onto upstream with merge-keep-team is clean" 0 gitq rebase -q origin/main
[ "$(cat README.md)" = "team readme" ] && say "ok   6b. rebase kept the team's text" || { say "FAIL 6b. rebase dropped the team's text: $(cat README.md)"; fail=1; }
down4="$tmp/down4"; gitq clone -q "$up" "$down4"; cd "$down4"
git config merge.ours.driver true
gitq checkout -q -b team "$U1"
echo "team readme" > README.md; gitq commit -q -am "team readme"
expect "6c. plain 'true' driver: rebase reports no conflict" 0 gitq rebase -q origin/main
[ "$(cat README.md)" != "team readme" ] && say "ok   6d. ...but silently DROPS the team's text - why preflight configures merge-keep-team" || { say "FAIL 6d. expected the plain driver to drop the team's text (git behaviour changed?)"; fail=1; }

down5="$tmp/down5"; gitq clone -q "$up" "$down5"; cd "$down5"
git config merge.ours.driver 'scripts/lib/merge-keep-team %O %A %B'
{ printf 'owner: pa\nteam: pa\n'; sed -n '/^# upstream:$/,/^#   synced_commit:/{s/^# //;p;}' "$ws/workspace.yaml"; } > workspace.yaml
expect "7a. first upstream-pin over the seed's placeholder" 0 python3 scripts/upstream-pin "$U3"
pin_line=$(grep '^  synced_commit:' workspace.yaml)
[ "$pin_line" = "  synced_commit: $U3" ] && say "ok   7b. placeholder fully replaced" || { say "FAIL 7b. placeholder left behind: $pin_line"; fail=1; }
expect "7c. first pin -> check-ownership OK" 0 python3 scripts/check-ownership .
sed "s/^  synced_commit: .*/  synced_commit: $U3   # pinned by hand/" workspace.yaml > workspace.yaml.new && mv workspace.yaml.new workspace.yaml
python3 scripts/upstream-pin "$U2" >/dev/null
pin_line=$(grep '^  synced_commit:' workspace.yaml)
[ "$pin_line" = "  synced_commit: $U2   # pinned by hand" ] && say "ok   7d. re-pin keeps a trailing comment" || { say "FAIL 7d. trailing comment lost: $pin_line"; fail=1; }

[ "$fail" = 0 ] && echo "OK: sync-fixture passed" || echo "FAIL: sync-fixture"
exit $fail
