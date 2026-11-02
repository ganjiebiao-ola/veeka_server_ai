#!/usr/bin/env sh
# regression-case:spec-authoring-smoke
# Guards the skill's contract: the four templates cover every parent-ticket (#31) checkpoint
# listed in references/coverage-map.md, checklists and clarification markers are intact, the
# S2 gap contract (00 gap-report template + gap-rules) keeps its class anchors, the S3 qa-loop
# keeps its gate anchors, the S4 downstream contract keeps its mapping/gate/field anchors, and
# the SKILL.md hard rules haven't been edited away.
# Usage: regression/smoke.sh <workspace-root>
set -e
root="${1:?usage: smoke.sh <workspace-root>}"
here="$(dirname "$0")"
tpl="$here/../assets/templates"
map="$here/../references/coverage-map.md"
skill="$here/../SKILL.md"
fail=0

# 1) Required files exist
for p in "$skill" "$map" "$here/../references/upstream-reuse.md" \
         "$here/../references/gap-rules.md" "$here/../references/qa-loop.md" \
         "$here/../references/downstream-contract.md" \
         "$tpl/00-gap-report.md" "$tpl/01-product-requirements.md" "$tpl/02-ui-design.md" \
         "$tpl/03-technical-goals.md" "$tpl/04-framework-constraints.md"; do
  [ -f "$p" ] || { echo "MISSING file: $p"; fail=1; }
done
[ "$fail" = 0 ] || { echo "FAIL"; exit 1; }

# 2) Every coverage-map check line resolves: anchor string present in the named template
while IFS= read -r line; do
  case "$line" in
    "check: "*) ;;
    *) continue ;;
  esac
  rest="${line#check: }"
  f="${rest%% :: *}"
  anchor="${rest#* :: }"
  if [ ! -f "$tpl/$f" ]; then
    echo "coverage map names unknown template: $f"; fail=1; continue
  fi
  grep -Fq -- "$anchor" "$tpl/$f" || { echo "coverage miss: $f :: $anchor"; fail=1; }
done < "$map"

# 3) Anti-deletion floors: dropping a check line must fail too (raise floors when adding lines)
count_checks() { grep -c "^check: $1" "$map" || true; }
[ "$(count_checks 01-product-requirements.md)" -ge 13 ] || { echo "coverage map lost lines for 01 (<13)"; fail=1; }
[ "$(count_checks 02-ui-design.md)" -ge 16 ]            || { echo "coverage map lost lines for 02 (<16)"; fail=1; }
[ "$(count_checks 03-technical-goals.md)" -ge 18 ]      || { echo "coverage map lost lines for 03 (<18)"; fail=1; }
[ "$(count_checks 04-framework-constraints.md)" -ge 17 ] || { echo "coverage map lost lines for 04 (<17)"; fail=1; }
[ "$(grep -c '^check: ' "$map" || true)" -ge 64 ]        || { echo "coverage map lost lines overall (<64)"; fail=1; }

# 4) Each template keeps its self-check boxes and clarification markers
check_template() { # file min_boxes
  boxes=$(grep -c '^- \[ \]' "$tpl/$1" || true)
  [ "$boxes" -ge "$2" ] || { echo "$1: checklist boxes dropped below $2 (now $boxes)"; fail=1; }
  grep -Fq "[NEEDS CLARIFICATION" "$tpl/$1" || { echo "$1: lost [NEEDS CLARIFICATION marker"; fail=1; }
}
check_template 01-product-requirements.md 6
check_template 02-ui-design.md 7
check_template 03-technical-goals.md 8
check_template 04-framework-constraints.md 7

# 4b) S2 (#114) gap contract: the 00 gap-report template and gap-rules keep their anchors
for s in "缺失" "含糊" "不自洽" "细节不足" "GAP-" "不自洽对照" "问答记录" "完成度判定" \
         "非四部分之一"; do
  grep -Fq -- "$s" "$tpl/00-gap-report.md" || { echo "00-gap-report.md lost anchor: $s"; fail=1; }
done
for s in "缺失" "含糊" "不自洽" "细节不足" "改写守则" "不得擅自裁决" "GAP-### 与 CL-###"; do
  grep -Fq -- "$s" "$here/../references/gap-rules.md" || { echo "gap-rules.md lost anchor: $s"; fail=1; }
done

# 4c) S3 (#115) qa-loop contract: gates, exit conditions and thresholds keep their anchors
for s in "至多 5 问" "D1 硬门禁" "D2 覆盖门禁" "D3 一致性门禁" "D4 残留额度" "退出条件" \
         "owner 确认" "不追求 Spec 完美化" "resolved(R"; do
  grep -Fq -- "$s" "$here/../references/qa-loop.md" || { echo "qa-loop.md lost anchor: $s"; fail=1; }
done

# 4d) S4 (#116) downstream contract: mapping, entry gate and #6 interface fields keep their anchors
for s in "命名映射" "启动门禁" "禁止脑补" "figma-source" "layout-export-target" "asset-naming" \
         "theme-tokens-source" "待确认"; do
  grep -Fq -- "$s" "$here/../references/downstream-contract.md" || { echo "downstream-contract.md lost anchor: $s"; fail=1; }
done

# 5) SKILL.md hard rules and S2/S3/S4 contract phrases still present
for s in "宁可保留 [NEEDS CLARIFICATION" "不得为了显得完整而删除" "单次填充,不做循环" \
         "该仓自己的 branch/PR" "gap-rules" "就地改写" "qa-loop" "够驱动生成即可" \
         "退出条件" "owner 确认" "downstream-contract" "移交摘要" "#114" "#115" "#116"; do
  grep -Fq -- "$s" "$skill" || { echo "SKILL.md lost phrase: $s"; fail=1; }
done

# 6) SKILL.md frontmatter intact: agentskills.io fields + the #48 metadata fields all present
head -n1 "$skill" | grep -qx -- "---" || { echo "SKILL.md: missing frontmatter opening ---"; fail=1; }
fm=$(sed -n '2,/^---$/p' "$skill")
for k in "name: spec-authoring" "description:" "id: skill:spec-authoring" "type: skill" "owner:" \
         "version:" "status:" "summary:" "use_when:" "usage:" "dependencies:" "regression:"; do
  printf '%s\n' "$fm" | grep -q "^$k" || { echo "SKILL.md frontmatter lost field: $k"; fail=1; }
done

# 7) Discovery: both runtime symlinks (.claude/skills, .agents/skills) resolve to this skill
for link in ".claude/skills" ".agents/skills"; do
  [ -f "$root/$link/spec-authoring/SKILL.md" ] || { echo "discovery path broken: $link/spec-authoring"; fail=1; }
done

# 8) Portability: the skill is written against the workspace *template*, never one team's instance —
# no mounted-repo id from the target workspace may be hard-coded in the skill's files.
# (If an id ever collides with ordinary prose, reword the prose; the check is cheap to satisfy.)
ids=$(sed -n 's/^[[:space:]]*- id:[[:space:]]*//p' "$root/workspace.yaml")
for id in $ids; do
  if grep -rqw --exclude-dir=.git -- "$id" "$here/.."; then
    echo "team-specific repo id leaked into skill files: $id"; fail=1
  fi
done

[ "$fail" = 0 ] && echo "OK: spec-authoring smoke passed" || echo "FAIL"
exit $fail
