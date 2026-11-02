#!/usr/bin/env sh
# regression-case:incident-fix-smoke
# Guards the skill's contract: the workspace paths it points at resolve, its templates/references
# exist with their fixed anchors, the contract markers appear exactly once (the suite splices on
# them), the contract anchors that upstream evals grep for are still present, and no project-
# specific noun or team repo id leaked into the skill. Usage: regression/smoke.sh <workspace-root>
set -e
root="${1:?usage: smoke.sh <workspace-root>}"
here="$(dirname "$0")"
skill="$here/.."
fail=0
for p in "workspace.yaml" "agent-instructions/security-defaults.md" "rules/team-rules.md" "suites/sre-autofix/SUITE.md"; do
  [ -e "$root/$p" ] || { echo "MISSING in workspace: $p"; fail=1; }
done
for f in assets/templates/FIXNOTES.md assets/templates/verification.json references/verification-schema.md \
         references/fixnotes-guide.md references/runtime-hints.md; do
  [ -f "$skill/$f" ] || { echo "MISSING: $f"; fail=1; }
done
grep -q '^## 改了什么' "$skill/assets/templates/FIXNOTES.md" || { echo "FIXNOTES template lost 《改了什么》"; fail=1; }
grep -q '"all_passed": *false' "$skill/assets/templates/verification.json" || { echo "verification template must default to all_passed:false"; fail=1; }
for m in "<!-- BEGIN incident-fix:contract -->" "<!-- END incident-fix:contract -->"; do
  [ "$(grep -c -- "$m" "$skill/SKILL.md")" = 1 ] || { echo "marker count != 1: $m"; fail=1; }
done
# contract anchors — parity with ola-sre-agent fixleg_test.go (v3 + v4 anchors) + output contract
for s in "不构成实现约束" "既有防线" "优先以最小改动接入" "留下可观测痕迹" "不反噬主路径" "同构位点（任务 8" \
         "既有防线普查结果（任务 4" "不是本代码的 bug" "传播路径" "产品决策" "不是**验收目标" \
         "不要 commit" "not_verified" "改了什么" "all_passed"; do
  grep -qF -- "$s" "$skill/SKILL.md" || { echo "SKILL.md lost phrase: $s"; fail=1; }
done
# project-noun ban — parity with TestGenericBriefHasNoProjectSpecificNouns
for n in mustLogin mustGetCurrentUser InfoProvider BlindBox getCurrentUser pt-oversea olachat authcode BbcStrategy live_pk \
         config_db getLevelsByTaskID pingMysql onPing readonly_config LivePk DbEventListener giftConfigV2 IsBlindBoxEnabled \
         RpcBlindBox GetUserFeatureFlag pt-app.private pazzy; do
  if grep -rq --exclude-dir=.git --exclude-dir=regression -- "$n" "$skill"; then echo "project-specific noun leaked into skill files: $n"; fail=1; fi
done
# portability — only repositories[].id (agent_suites[].id legitimately appears in skill text)
ids=$(awk '/^repositories:/{f=1;next} /^[A-Za-z_]/{f=0} f && /^[[:space:]]*- id:/{sub(/.*- id:[[:space:]]*/,""); print}' "$root/workspace.yaml")
for id in $ids; do
  if grep -rqw --exclude-dir=.git --exclude-dir=regression -- "$id" "$skill"; then echo "team-specific repo id leaked into skill files: $id"; fail=1; fi
done
grep -q '^id: skill:incident-fix$' "$skill/SKILL.md" || { echo "frontmatter id wrong"; fail=1; }
grep -Eq '^version: "[0-9a-f]{40}"$' "$skill/SKILL.md" || { echo "frontmatter version not a 40-hex SHA"; fail=1; }
[ "$fail" = 0 ] && echo "OK: incident-fix smoke passed" || echo "FAIL"
exit $fail
