#!/usr/bin/env sh
# regression-case:ai-usage-weekly-smoke
# Guards the skill's contract (#22): skill files, the weekly script and its schema exist; the
# transparency hard-rules survive in SKILL.md; frontmatter stays complete; `submit` on the
# planted token-usage fixtures produces a schema-valid personal submission with a price-table
# cost and no raw paths/session ids; `team` aggregates the planted submissions, quarantines a
# broken file, lists the missing member, renders self-contained SVG charts, and never orders
# people by cost; both refuse to green on empty input.
# Usage: regression/smoke.sh <workspace-root>
set -e
root="${1:?usage: smoke.sh <workspace-root>}"
here="$(dirname "$0")"
fail=0

# 1) Required files
for p in "$here/../SKILL.md" "$here/../assets/pricing.json" "$here/../assets/narrative.example.json" \
         "$here/../references/report-contract.md" "$here/../assets/request.example.json" \
         "$root/platform-internals/schemas/ai-usage-submission.schema.json" \
         "$root/platform-internals/schemas/ai-resource-request.schema.json"; do
  [ -f "$p" ] || { echo "MISSING file: $p"; fail=1; }
done
[ -x "$root/scripts/ai-usage-weekly" ] || { echo "MISSING or non-executable scripts/ai-usage-weekly"; fail=1; }
python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$here/../assets/pricing.json" 2>/dev/null \
  || { echo "assets/pricing.json is not valid JSON"; fail=1; }

# 2) Hard-rule phrases still present (transparency contract + #22 scope)
for s in "never contains prompts, file paths, or session ids" \
         "不按费用排序" "估算" "不是绩效" "--reports-dir" \
         "ai-usage-submission.schema.json" "#22" "scripts/ai-usage-weekly" \
         "token-usage-report" "token-usage-tasks" "--narrative" "--summary-file" \
         "human_id" "workspace.yaml" "knowledge/ai-usage-reports" \
         "never pushes" "用量 / 费用 / 使用内容 / 产生的价值" \
         "三种金额" "不相加" "--cost-file" "quality" "submission_version" \
         "六项校验" "reports/team.json" "team-report.yml" \
         "--platform-export" "--bill" "platform-export.mapping.json" "择一" "platform_ids" \
         "提交前需要补齐" "<human_id>.html" \
         "request --form" "reports/requests/" "已有公司方案优先" "先确认再购买" "探索可以失败" "review_before_renewal" \
         "reports/budget.json" "预警用于支持决策" "1.5" "request review" \
         "month --allocation" "reports/months/" "allocation_columns" "合计一致" "[Unallocated]" \
         "identities" "Co-Authored-By" "下限" "--no-git" "未映射" "**Sunday**" "**估算**" "尚未接入" "no sort"; do
  grep -Fq -- "$s" "$here/../SKILL.md" || { echo "SKILL.md lost phrase: $s"; fail=1; }
done

# 3) Frontmatter completeness (12 fields)
[ "$(head -n1 "$here/../SKILL.md")" = "---" ] || { echo "SKILL.md missing frontmatter"; fail=1; }
for k in name description id type owner version status summary use_when usage dependencies regression; do
  grep -q "^$k:" "$here/../SKILL.md" || { echo "SKILL.md frontmatter lost: $k"; fail=1; }
done
grep -q '^regression: \["regression-case:ai-usage-weekly-smoke"\]' "$here/../SKILL.md" \
  || { echo "SKILL.md regression pointer wrong"; fail=1; }
grep -q '^id: regression-case:ai-usage-weekly-smoke' "$here/REGRESSION.md" 2>/dev/null \
  || { echo "REGRESSION.md missing or wrong id"; fail=1; }

# 4) Discovery links resolve for both runtimes
for p in ".claude/skills/ai-usage-weekly/SKILL.md" ".agents/skills/ai-usage-weekly/SKILL.md"; do
  [ -f "$root/$p" ] || { echo "MISSING discovery link: $p"; fail=1; }
done

# 5) Portability: no mounted-repo id from the target workspace hard-coded in skill files
ids=$(cat "$root/workspace.yaml" "$root/workspace.local.yaml" 2>/dev/null | sed -n 's/^[[:space:]]*- id:[[:space:]]*//p' || true)
for id in $ids; do
  if grep -rqw --exclude-dir=.git -- "$id" "$here/.."; then
    echo "team-specific repo id leaked into skill files: $id"; fail=1
  fi
done

# 6) Behavioral: `submit` on the token-usage fixtures -> a schema-valid submission with a
#    price-table cost, ISO-week window, no raw paths / session ids; narrative merge; refusals.
tool="$root/scripts/ai-usage-weekly"
fx="$root/platform-internals/tests/token-usage"
fw="$root/platform-internals/tests/ai-usage-weekly"
if [ -x "$tool" ] && [ -d "$fx" ] && [ -d "$fw" ]; then
  tmp=$(mktemp -d)
  # The planted sessions say cwd=/fake/ws/...; the workspace root must both hold workspace.yaml
  # (identity) and be that cwd prefix (attribution), so rewrite the fixture cwds to $tmp/ws.
  cp -R "$fx/claude-projects" "$tmp/claude"
  cp -R "$fx/codex-sessions" "$tmp/codex"
  cp -R "$fx/qoder-projects" "$tmp/qoder"
  find "$tmp/claude" "$tmp/codex" "$tmp/qoder" -name '*.jsonl' -exec sed -i.bak "s#/fake/ws#$tmp/ws#g" {} \; -exec rm -f {}.bak \;
  mkdir -p "$tmp/ws" "$tmp/reports" "$tmp/empty" "$tmp/out"
  cp "$fw/ws/workspace.yaml" "$tmp/ws/workspace.yaml"
  common="--workspace-root $tmp/ws --claude-dir $tmp/claude --codex-dir $tmp/codex --qoder-dir $tmp/qoder --pricing $fw/pricing.json --source native --out $tmp/out"
  # 6a) machine-only submission
  if "$tool" submit --week 2026-W33 $common --reports-dir "$tmp/reports" >/dev/null; then
    python3 - "$tmp/reports" "$tmp" <<'EOF' || fail=1
import json, os, sys
d, tmproot = sys.argv[1], sys.argv[2]
jp = os.path.join(d, "reports", "2026-W33", "alice.json")
mp = os.path.join(d, "reports", "2026-W33", "alice.md")
def check(cond, msg):
    if not cond:
        print("submit assertion failed: " + msg); sys.exit(1)
check(os.path.isfile(jp) and os.path.isfile(mp), "submission json/md not written under reports/<week>/<human_id>")
s = json.load(open(jp))
m, u, c = s["meta"], s["usage"], s["cost"]
check(m["human_id"] == "alice" and m["team"] == "fixture-team", "human_id/team not taken from workspace.yaml")
check(m["week"] == "2026-W33" and m["since"] == "2026-08-10" and m["until"] == "2026-08-16", "ISO week window wrong")
check(m["tool"] == "ai-usage-weekly" and m["schema_version"] == 2 and m["base_source"] == "native", "meta wrong")
check(m["business"] == "fixture-biz" and m["submission_version"] == 1 and isinstance(m["timezone"], str) and m["timezone"],
      "v2 meta business/timezone/submission_version wrong: %r" % m)
check(u["requests"] == 5 and u["input"] == 600 and u["output"] == 400 and u["cache_read"] == 1810,  # codex: 1000 input of which 800 cached -> 200 + 800, never 1800
      "usage totals wrong (claude msgs + codex sessions; codex cached_input ⊆ input, #203)")
check(abs(u["cache_hit_rate"] - 1010 / 1415) < 1e-6, "cache_hit_rate wrong")
check(u["task_instances"] >= 1 and u["sessions"] == 4, "sessions (3 claude incl. other + 1 codex) / task_instances wrong")
e = c["estimated"]
check(abs(e["amount"] - 0.0086725) < 1e-6, "price-table cost wrong: %r" % e)
check(e["method"] == "price-table" and e["pricing_version"] == "test-1" and "codex" in e["unpriced_models"]
      and e["source"] == "local-usage-log" and e["currency"] == "USD" and e["confirmed"] is False,
      "estimated block wrong: %r" % e)
check(c["actual"] is None and c["allocated"] is None, "actual/allocated must be null without --cost-file")
check("estimated_usd" not in c, "v1 cost.estimated_usd must be gone")
q = s["quality"]
check("actual-bill" in q["missing_sources"] and "platform-export" in q["missing_sources"], "quality.missing_sources wrong: %r" % q)
check(q["unpriced_models"] == e["unpriced_models"] and q["allocation"] == [] and q["shared_costs"] == []
      and q["confirmed_by"]["member"] is None, "quality block wrong: %r" % q)
mdtext = open(mp).read()
import re
check("待核实" in mdtext and not re.search(r"\$0\.00(?!\d)", mdtext), "md must show 待核实 for missing actual, never $0.00")
check("估算" in mdtext and "test-1" in mdtext, "md must label the estimate and its pricing version")
# T3 (#197): personal HTML beside json/md, from the same submission; program-made 提交前需要补齐 list
hp = os.path.join(d, "reports", "2026-W33", "alice.html")
check(os.path.isfile(hp), "personal html not written beside json/md")
h = open(hp).read()
check("<script src" not in h and "http://" not in h and "https://" not in h and "<svg" in h, "personal html must be self-contained with inline SVG")
check(">5<" in h and "2,815" in h and "3,615" not in h, "html KPI must show requests 5 and tokens 2,815 (600+400+1810+5; codex cache not double-counted) from the JSON")
check("估算" in h and "test-1" in h and "待核实" in h and not re.search(r"\$0\.00(?!\d)", h), "html must label 估算+pricing version, show 待核实 for missing actual, never $0.00")
for leak in ("s-aaa", "s-bbb", "s-ccc", "/fake/", "secret-project", "req_1", "msg_1", "q-sess-1", "q-msg-1", "secret prompt", tmproot):
    check(leak not in h, "html leaked raw session id / path: " + leak)
check("提交前需要补齐" in h and "账单待核实" in h and "叙事待补" in h and "无记录" in h,
      "checklist must include 本机估算/账单待核实, 叙事待补, days without records")
check("cost.actual" in h and "usage.by_day" in h, "each checklist item must point at its field")
check("提交前需要补齐" in mdtext and "账单待核实" in mdtext, "md must carry the same checklist")
check(u["by_day"]["2026-08-10"]["requests"] == 4 and abs(u["by_day"]["2026-08-10"]["cost"] - 0.0086725) < 1e-6,
      "by_day wrong")
check(u["by_model"]["claude-fable-5"]["requests"] == 3 and u["by_model"]["claude-sonnet-5"]["requests"] == 1
      and u["by_model"]["codex"]["requests"] == 1 and u["by_model"]["codex"]["cost"] is None, "by_model wrong")
check(u["by_bucket"]["alpha"]["requests"] == 2 and u["by_bucket"]["alpha"]["tokens"] == 2500
      and abs(u["by_bucket"]["alpha"]["cost"] - 0.0016) < 1e-6, "by_bucket alpha wrong: %r" % u["by_bucket"].get("alpha"))
check(set(u["by_bucket"]) == {"workspace", "alpha", "other"}, "buckets wrong")
check(s["narrative"] is None, "narrative should be null without --narrative")
# #531 Qoder: credits sit in by_agent.qoder only; requests / tokens / estimate above are unchanged by them
qd = u["by_agent"]["qoder"]
check(qd and qd["messages"] == 2 and abs(qd["credits"] - 0.75) < 1e-9 and qd["confirmed"] is False
      and set(qd["by_bucket"]) == {"alpha", "workspace"} and sorted(qd["by_day"]) == ["2026-08-10", "2026-08-12"],
      "by_agent.qoder wrong: %r" % qd)
check("qoder" not in u["by_model"] and "qoder" not in e["unpriced_models"] and "Qoder" in e["note"],
      "Qoder credits must stay out of by_model / unpriced models, and the estimate note must say so")
check(any(sc["name"] == "claude+codex+qoder" and "Qoder" in (sc.get("note") or "") for sc in u["sources"]), "sources must name qoder")
check("Qoder 积分" in mdtext and "0.75" in mdtext and "Qoder 积分" in h and "0.75" in h, "md/html must show Qoder credits")
nodays = [l for l in mdtext.splitlines() if "无记录" in l]
check(nodays and "08-12" not in nodays[0] and "08-11" in nodays[0], "a Qoder-only day must count as a day with records: %r" % nodays)
blob = open(jp).read() + open(mp).read()
for leak in ("s-aaa", "s-bbb", "s-ccc", "/fake/", "secret-project", "req_1", "msg_1", "q-sess-1", "q-msg-1", "secret prompt", tmproot):
    check(leak not in blob, "raw session id / path leaked: " + leak)
check("待补" in open(mp).read(), "md should mark the narrative as 待补")
EOF
  else
    echo "submit failed on the good fixture"; fail=1
  fi
  # 6b) narrative merge
  if "$tool" submit --week 2026-W33 $common --reports-dir "$tmp/reports" --narrative "$fw/narrative.json" >/dev/null; then
    python3 - "$tmp/reports" <<'EOF' || fail=1
import json, os, sys
d = sys.argv[1]
s = json.load(open(os.path.join(d, "reports", "2026-W33", "alice.json")))
md = open(os.path.join(d, "reports", "2026-W33", "alice.md")).read()
h = open(os.path.join(d, "reports", "2026-W33", "alice.html")).read()
ok = s["narrative"] and s["narrative"]["summary"].startswith("FIXTURE-SUMMARY") and "FIXTURE-SUMMARY" in md \
     and "commit abc1234" in md and "叙事待补" not in md \
     and "证据待确认" in h and "无证据任务" in h and "narrative.projects[0].tasks[1].evidence" in h \
     and "无测量依据" in h and "2 小时" in h and "FIXTURE-SUMMARY" in h and "commit abc1234" in h \
     and s["meta"]["submission_version"] == 2 and s["quality"]["confirmed_by"]["member"] == "alice" \
     and "ai_role" in s["narrative"]["projects"][0]["tasks"][0] and "resource_needs" in s["narrative"]
sys.exit(0 if ok else (print("narrative not merged into json/md") or 1))
EOF
  else
    echo "submit --narrative failed on the good fixture"; fail=1
  fi
  # 6b2) --cost-file: actual / allocated land in their own blocks, never summed into the estimate
  if "$tool" submit --week 2026-W33 $common --reports-dir "$tmp/reports" --cost-file "$fw/cost.json" >/dev/null; then
    python3 - "$tmp/reports" <<'EOF2' || fail=1
import json, os, sys
d = sys.argv[1]
s = json.load(open(os.path.join(d, "reports", "2026-W33", "alice.json")))
md = open(os.path.join(d, "reports", "2026-W33", "alice.md")).read()
c, q = s["cost"], s["quality"]
ok = c["actual"]["amount"] == 12.5 and c["actual"]["nature"] == "seat" and c["actual"]["confirmed"] is True \
     and c["allocated"]["amount"] == 7.5 and abs(c["estimated"]["amount"] - 0.0086725) < 1e-6 \
     and q["allocation"] == [{"target": "alpha", "ratio": 60}, {"target": "workspace", "ratio": 40}] \
     and "actual-bill" not in q["missing_sources"] and q["confirmed_by"]["billing"] == "bob" \
     and "12.50" in md and "7.50" in md and "seat" in md
sys.exit(0 if ok else (print("cost-file not merged: %r %r" % (c, q)) or 1))
EOF2
  else
    echo "submit --cost-file failed on the good fixture"; fail=1
  fi
  # 6b3) the shipped cost example must itself be accepted (an example the tool rejects is a trap)
  "$tool" submit --week 2026-W33 $common --reports-dir "$tmp/reports" --cost-file "$here/../assets/cost.example.json" >/dev/null 2>&1 \
    || { echo "assets/cost.example.json rejected by --cost-file"; fail=1; }
  # 6b2) #531 team: Qoder credits summed from the submissions; a member with no Qoder use shows a dash, never 0
  mkdir -p "$tmp/tq/reports/2026-W33"
  cp "$tmp/reports/reports/2026-W33/alice.json" "$tmp/tq/reports/2026-W33/alice.json"
  python3 -c "import json,sys; s=json.load(open(sys.argv[1])); s['meta']['human_id']='bob'; s['usage']['by_agent']['qoder']=None; json.dump(s,open(sys.argv[2],'w'))" \
    "$tmp/tq/reports/2026-W33/alice.json" "$tmp/tq/reports/2026-W33/bob.json"
  if "$tool" team --week 2026-W33 --reports-dir "$tmp/tq" --workspace-root "$tmp/ws" >/dev/null; then
    python3 - "$tmp/tq/reports/2026-W33/team-report.md" "$tmp/tq/reports/2026-W33/team-report.html" <<'EOFQ' || fail=1
import sys
md, h = open(sys.argv[1]).read(), open(sys.argv[2]).read()
rows = {l.split("|")[1].strip(): l for l in md.splitlines() if l.startswith("| alice") or l.startswith("| bob")}
ok = ("Qoder 积分合计" in md and "| 0.75(2 条消息) |" in md and "### Qoder 积分(按项目)" in md
      and "| 0.75 |" in rows.get("alice", "") and "| — |" in rows.get("bob", "") and "Qoder 积分合计" in h)
sys.exit(0 if ok else (print("team report must sum Qoder credits (0.75), list them by project, and show a dash for bob:\n" + "\n".join(rows.values())) or 1))
EOFQ
  else
    echo "team on two submissions (one with Qoder) failed"; fail=1
  fi
  # 6c) refusals: broken narrative, broken allocation, missing reports dir, empty sources -> exit 2, nothing written
  rc=0; "$tool" submit --week 2026-W33 $common --reports-dir "$tmp/reports" --cost-file "$fw/cost-broken.json" >"$tmp/alloc.out" 2>&1 || rc=$?
  [ "$rc" -eq 2 ] && grep -q "allocation" "$tmp/alloc.out" || { echo "allocation != 100% must exit 2 naming the field (got $rc)"; fail=1; }
  rc=0; "$tool" submit --week 2026-W33 $common --reports-dir "$tmp/reports" --narrative "$fw/narrative-broken.json" >/dev/null 2>&1 || rc=$?
  [ "$rc" -eq 2 ] || { echo "broken narrative must exit 2 (got $rc)"; fail=1; }
  rc=0; "$tool" team --week 2026-W33 --reports-dir "$tmp/nope" >/dev/null 2>&1 || rc=$?
  [ "$rc" -eq 2 ] && [ ! -d "$tmp/nope" ] || { echo "team on a missing --reports-dir must exit 2 without creating it (got $rc)"; fail=1; }
  rc=0; "$tool" submit --week 2026-W33 --workspace-root "$tmp/ws" --claude-dir "$tmp/empty" --codex-dir "$tmp/empty" --qoder-dir "$tmp/empty" \
       --pricing "$fw/pricing.json" --source native --out "$tmp/out" --reports-dir "$tmp/reports" >/dev/null 2>&1 || rc=$?
  [ "$rc" -eq 2 ] || { echo "empty sources must exit 2, vacuous green (got $rc)"; fail=1; }
  # 8) ingest (T2 #196): platform export + bill; dedup platform-over-local per (day, model); three
  #    source combinations pinned; cross-week session split by event time in the declared timezone;
  #    unknown column / unknown currency refused before anything is written.
  ing="$tmp/ing"; mkdir -p "$ing"
  if "$tool" submit --week 2026-W33 $common --reports-dir "$ing" --platform-export "$fw/platform-export.csv" --bill "$fw/bill.csv" >/dev/null; then
    python3 - "$ing/reports/2026-W33/alice.json" "$ing/reports/2026-W33/alice.md" <<'EOF6' || fail=1
import json, sys
s = json.load(open(sys.argv[1])); md = open(sys.argv[2]).read()
u, c, q = s["usage"], s["cost"], s["quality"]
def check(cond, msg):
    if not cond:
        print("ingest assertion failed: " + msg); sys.exit(1)
# local: fable-5 x3 + sonnet-5 x1 on 08-10, codex x1; platform: fable-5 x5 on 08-10 (supersedes), gpt x2 on 08-12
check(u["requests"] == 9, "both sources: requests must be 5(platform fable)+1(sonnet)+1(codex)+2(gpt)=9, got %r" % u["requests"])
check(u["by_model"]["claude-fable-5"]["requests"] == 5 and u["by_model"]["claude-fable-5"]["input"] == 1000,
      "overlapping (day, model) must take the platform record, not add: %r" % u["by_model"]["claude-fable-5"])
check(u["by_model"]["gpt-5.6-sol"]["requests"] == 2 and u["by_day"]["2026-08-12"]["requests"] == 2, "platform-only rows must be counted")
check(u["by_model"]["claude-sonnet-5"]["requests"] == 1, "local-only (day, model) must survive")
src = {x["type"]: x for x in u["sources"]}
check(set(src) == {"local-usage-log", "platform-export", "actual-bill"}, "usage.sources must list the three sources: %r" % list(src))
check(src["local-usage-log"]["superseded"] == 1 and src["platform-export"]["records"] == 2 and src["platform-export"]["skipped_other_users"] == 1,
      "sources bookkeeping wrong: %r" % src)
check(src["platform-export"]["reported_cost"]["amount"] == 0.0163 and "待核实" in md, "platform-reported cost must be kept apart and labelled 待核实")
check("/" not in src["platform-export"]["name"], "source name must not be a path")
check(c["actual"]["amount"] == 200 and c["actual"]["nature"] == "seat" and c["actual"]["currency"] == "USD" and c["actual"]["confirmed"] is True,
      "bill must land in cost.actual: %r" % c["actual"])
check(abs(c["allocated"]["amount"] - 200 * 7 / 31) < 1e-6 and "折算" in c["allocated"]["basis"], "subscription must be prorated to the report week: %r" % c["allocated"])
check(c["estimated"]["amount"] is not None and c["estimated"]["amount"] < 1, "estimate must stay an estimate, not absorb the bill")
check("platform-export" not in q["missing_sources"] and "actual-bill" not in q["missing_sources"], "given sources must leave missing_sources")
check("200.00" in md and "45.16" in md, "md must show actual 200.00 and allocated 45.16")
EOF6
  else
    echo "submit with --platform-export/--bill failed"; fail=1
  fi
  # 8b) platform only (empty local dirs) -> 7 requests; local only -> 5 (already pinned in 6a)
  if "$tool" submit --week 2026-W33 --workspace-root "$tmp/ws" --claude-dir "$tmp/empty" --codex-dir "$tmp/empty" --qoder-dir "$tmp/empty" --pricing "$fw/pricing.json" \
       --source native --out "$tmp/out" --reports-dir "$ing" --platform-export "$fw/platform-export.csv" >/dev/null; then
    python3 -c "import json,sys; s=json.load(open(sys.argv[1])); sys.exit(0 if s['usage']['requests']==7 and 'local-usage-log' in s['quality']['missing_sources'] else (print('platform-only: requests must be 7 and local-usage-log listed missing, got', s['usage']['requests'], s['quality']['missing_sources']) or 1))" \
      "$ing/reports/2026-W33/alice.json" || fail=1
  else
    echo "submit with platform export only (no local logs) must still write"; fail=1
  fi
  # 8b2) the same export as .xlsx (zipfile + xml reader, no dependency) gives the same numbers
  if "$tool" submit --week 2026-W33 --workspace-root "$tmp/ws" --claude-dir "$tmp/empty" --codex-dir "$tmp/empty" --qoder-dir "$tmp/empty" --pricing "$fw/pricing.json" \
       --source native --out "$tmp/out" --reports-dir "$ing" --platform-export "$fw/platform-export.xlsx" >/dev/null; then
    python3 -c "import json,sys; s=json.load(open(sys.argv[1])); sys.exit(0 if s['usage']['requests']==7 and s['usage']['by_model']['gpt-5.6-sol']['input']==600 else (print('xlsx export: requests must be 7 / gpt input 600, got', s['usage']['requests']) or 1))" \
      "$ing/reports/2026-W33/alice.json" || fail=1
  else
    echo "submit with an .xlsx platform export failed"; fail=1
  fi
  # 8c) cross-week session (Sun 23:30 -> Mon 00:30 Asia/Singapore) lands in two weeks by event time
  cp -R "$fw/xweek/claude-projects" "$tmp/xw"
  find "$tmp/xw" -name '*.jsonl' -exec sed -i.bak "s#/fake/ws#$tmp/ws#g" {} \; -exec rm -f {}.bak \;
  xc="--workspace-root $tmp/ws --claude-dir $tmp/xw --codex-dir $tmp/empty --qoder-dir $tmp/empty --pricing $fw/pricing.json --source native --out $tmp/out --reports-dir $ing --timezone Asia/Singapore"
  "$tool" submit --week 2026-W33 $xc >/dev/null && "$tool" submit --week 2026-W34 $xc >/dev/null || { echo "cross-week submit failed"; fail=1; }
  python3 - "$ing/reports" <<'EOF7' || fail=1
import json, os, sys
d = sys.argv[1]
a = json.load(open(os.path.join(d, "2026-W33", "alice.json"))); b = json.load(open(os.path.join(d, "2026-W34", "alice.json")))
ok = a["usage"]["requests"] == 1 and b["usage"]["requests"] == 1 and "2026-08-16" in a["usage"]["by_day"] and "2026-08-17" in b["usage"]["by_day"] \
     and a["meta"]["timezone"] == "Asia/Singapore"
sys.exit(0 if ok else (print("cross-week session must split by event time in the declared timezone: W33=%r W34=%r" % (a["usage"]["by_day"], b["usage"]["by_day"])) or 1))
EOF7
  # 8c2) the declared timezone, not the machine's, draws the day boundary: in UTC both messages are Sunday
  xu="--workspace-root $tmp/ws --claude-dir $tmp/xw --codex-dir $tmp/empty --qoder-dir $tmp/empty --pricing $fw/pricing.json --source native --out $tmp/out --reports-dir $ing/utc --timezone UTC"
  mkdir -p "$ing/utc"
  "$tool" submit --week 2026-W33 $xu >/dev/null || { echo "cross-week submit (UTC) failed"; fail=1; }
  python3 -c "import json,sys; s=json.load(open(sys.argv[1])); sys.exit(0 if s['usage']['requests']==2 and list(s['usage']['by_day'])==['2026-08-16'] else (print('with --timezone UTC both messages must fall on 2026-08-16, got', s['usage']['by_day']) or 1))" \
    "$ing/utc/reports/2026-W33/alice.json" || fail=1
  # 8d) refusals: unknown column, unknown currency -> exit 2, nothing written
  rm -rf "$ing/reports/2026-W35"
  rc=0; "$tool" submit --week 2026-W35 $common --reports-dir "$ing" --platform-export "$fw/platform-export-unknown.csv" >"$tmp/col.out" 2>&1 || rc=$?
  [ "$rc" -eq 2 ] && grep -q "Mystery Column" "$tmp/col.out" && [ ! -e "$ing/reports/2026-W35/alice.json" ] || { echo "unknown export column must exit 2 naming it, writing nothing (got $rc)"; fail=1; }
  rc=0; "$tool" submit --week 2026-W35 $common --reports-dir "$ing" --bill "$fw/bill-badcur.csv" >"$tmp/cur.out" 2>&1 || rc=$?
  [ "$rc" -eq 2 ] && grep -q 'US\$' "$tmp/cur.out" && [ ! -e "$ing/reports/2026-W35/alice.json" ] || { echo "unknown currency must exit 2 naming it, writing nothing (got $rc)"; fail=1; }
  # 9) `request` (T6 #200): a valid form -> reports/requests/<yyyy-mm>-<human_id>-<slug>.json + .md draft with
  #    every field and the fixed closing line; closed-loop fields start at draft; broken forms exit 2 naming
  #    the field and write nothing; --commit makes exactly one local commit and never touches the network.
  rq="$tmp/rq"; mkdir -p "$rq"; git -C "$rq" init -q 2>/dev/null; git -C "$rq" config user.email t@t; git -C "$rq" config user.name t
  if "$tool" request --form "$fw/requests/form.json" --workspace-root "$tmp/ws" --reports-dir "$rq" --commit >/dev/null; then
    python3 - "$rq" <<'EOF9' || fail=1
import glob, json, os, sys
d = sys.argv[1]
files = glob.glob(os.path.join(d, "reports", "requests", "2026-09-alice-*.json"))
def check(cond, msg):
    if not cond:
        print("request assertion failed: " + msg); sys.exit(1)
check(len(files) == 1, "expected one request json named <yyyy-mm>-<human_id>-<slug>.json, got %r" % files)
r = json.load(open(files[0])); md = open(files[0][:-5] + ".md").read()
check(r["human_id"] == "alice" and r["team"] == "fixture-team" and r["status"] == "draft" and r["bill_refs"] == [] and r["review_before_renewal"] is None,
      "closed-loop fields must start at draft / [] / null: %r" % {k: r.get(k) for k in ("human_id", "status", "bill_refs", "review_before_renewal")})
check(r["kind"] == "new" and r["amount"] == 400 and r["currency"] == "USD" and r["split"][0]["ratio"] == 70, "form fields not carried")
for needle in ("AI 资源申请草稿", "alice", "新购", "Claude Team seat ×2", "fixture-biz", "alpha", "FIXTURE-PURPOSE", "FIXTURE-OUTCOME",
               "400", "USD", "2026-09-01", "2026-11-30", "到期后人工确认", "alpha 70%", "FIXTURE-NOTE",
               "按公司现行流程", "购买或续费前取得确认", "保留账单与付款凭证", "已有公司方案优先", "探索可以失败"):
    check(needle in md, "draft md lacks: " + needle)
check("http://" not in md and "https://" not in md, "draft must not carry links the form did not give")
EOF9
    n=$(git -C "$rq" rev-list --count HEAD 2>/dev/null || echo 0)
    [ "$n" -eq 1 ] || { echo "request --commit must make exactly one local commit (got $n)"; fail=1; }
  else
    echo "request failed on the good form"; fail=1
  fi
  for bad in "form-end-before-start.json:end" "form-split.json:split" "form-missing.json:purpose" "form-currency.json:US\$"; do
    f="${bad%%:*}"; needle="${bad#*:}"
    rc=0; "$tool" request --form "$fw/requests/$f" --workspace-root "$tmp/ws" --reports-dir "$rq" >"$tmp/rq.out" 2>&1 || rc=$?
    [ "$rc" -eq 2 ] && grep -qF -- "$needle" "$tmp/rq.out" || { echo "request on $f must exit 2 naming '$needle' (got $rc)"; fail=1; }
  done
  [ "$(ls "$rq/reports/requests" | wc -l | tr -d ' ')" = "2" ] || { echo "a rejected form must write nothing"; fail=1; }
  # 10) monthly budget (T5 #199): reports/budget.json + the month's past weeks' bills -> 累计 / 余额 / 月底预测 / 档位;
  #     only cost.allocated / actual count (never the estimate); a member-week without a bill is 待核实;
  #     no budget.json -> 尚未提供 with no numbers; exactly 1.5x lands in the "<=1.5x" tier.
  cp -R "$fw/team-budget" "$tmp/tb5"
  if "$tool" team --week 2026-W34 --reports-dir "$tmp/tb5" --workspace-root "$tmp/ws" >/dev/null; then
    python3 - "$tmp/tb5/reports/2026-W34/team-report.md" "$tmp/tb5/reports/2026-W34/team-report.html" <<'EOFB' || fail=1
import sys
md, h = open(sys.argv[1]).read(), open(sys.argv[2]).read()
def check(cond, msg):
    if not cond:
        print("budget assertion failed: " + msg); sys.exit(1)
for blob, name in ((md, "md"), (h, "html")):
    sec = blob[blob.index("月度预算"):]
    check("2026-08" in sec and "300.00" in sec, name + ": budget section must name the month and the monthly budget")
    check("135.16" in sec, name + ": accumulated actual must be 40 + 45.16 + 50 = 135.16 (allocated only, never the estimate)")
    check("164.84" in sec, name + ": remaining must be 300 - 135.16 = 164.84")
    check("182.17" in sec, name + ": month-end forecast must be 135.16 / 23 * 31 = 182.17")
    check("正常" in sec, name + ": tier must be 正常 (forecast 0.61x)")
    check("待核实" in sec and "bob" in sec, name + ": bob's bill-less weeks must be 待核实, not 0")
    check("预警用于支持决策" in sec and "1.5" in sec and "下月扣减" in sec, name + ": the guide's rule and 不做考核 sentence must be on the page")
    check("W32" in sec and "W33" in sec and "W34" in sec, name + ": each past week of the month must be listed")
EOFB
  else
    echo "team with budget fixture failed"; fail=1
  fi
  "$tool" team --week 2026-W34 --reports-dir "$tmp/tb5" --workspace-root "$tmp/ws" --budget-file "$fw/budget-boundary.json" >/dev/null \
    && python3 -c "import sys; s=open(sys.argv[1]).read(); s=s[s.index('月度预算'):s.index('六项校验')]; sys.exit(0 if ('档位: 超出但 ≤1.5×' in s and '档位: 预计超过' not in s) else (print('exactly 1.5x must land in the <=1.5x tier, got: ' + [l for l in s.splitlines() if '档位' in l][0]) or 1))" "$tmp/tb5/reports/2026-W34/team-report.md" || fail=1
  "$tool" team --week 2026-W34 --reports-dir "$tmp/tb5" --workspace-root "$tmp/ws" --budget-file "$fw/budget-over.json" >/dev/null \
    && grep -q "档位: 预计超过 1.5×" "$tmp/tb5/reports/2026-W34/team-report.md" || { echo "forecast 1.82x of a 100 budget must be the >1.5x tier"; fail=1; }
  # 10b) `request review <id>` (T6 Phase 2): brings the resource's bills, utilisation and outcomes into a review draft;
  #      verdict is left to the human (json untouched); unknown id -> exit 2
  if "$tool" request review 2026-08-alice-claude-seat --reports-dir "$tmp/tb5" --workspace-root "$tmp/ws" >/dev/null; then
    python3 - "$tmp/tb5/reports/requests" <<'EOFR' || fail=1
import json, os, sys
d = sys.argv[1]
md = open(os.path.join(d, "2026-08-alice-claude-seat.review.md")).read()
r = json.load(open(os.path.join(d, "2026-08-alice-claude-seat.json")))
def check(cond, msg):
    if not cond:
        print("review assertion failed: " + msg); sys.exit(1)
check("135.16" in md and "ledger 2026-08" in md, "review must sum the bills matching bill_refs across the service period (40+45.16+50)")
check("W32" in md and "W33" in md and "W34" in md and "| **合计** | **135.16 USD** | **30** |" in md,
      "review must list utilisation per week for the requester (10+10+10 requests = 30)")
check("PR alpha#12" in md and "探测重构" in md, "review must bring in outcomes mentioning the resource")
check("continue" in md and "adjust" in md and "stop" in md and "review_before_renewal" in md, "review must leave the verdict to the human and say where to record it")
check(r["review_before_renewal"] is None, "review must not write the verdict into the json")
EOFR
  else
    echo "request review failed on the planted request"; fail=1
  fi
  rc=0; "$tool" request review nope-such-id --reports-dir "$tmp/tb5" --workspace-root "$tmp/ws" >/dev/null 2>&1 || rc=$?
  [ "$rc" -eq 2 ] || { echo "request review on an unknown id must exit 2 (got $rc)"; fail=1; }
  rm -f "$tmp/tb5/reports/budget.json"
  "$tool" team --week 2026-W34 --reports-dir "$tmp/tb5" --workspace-root "$tmp/ws" >/dev/null \
    && python3 -c "import sys; s=open(sys.argv[1]).read(); s=s[s.index('月度预算'):s.index('六项校验')]; sys.exit(0 if '尚未提供' in s and '135.16' not in s and '300' not in s else (print('without budget.json the section must read 尚未提供 with no numbers') or 1))" "$tmp/tb5/reports/2026-W34/team-report.md" || fail=1
  # 10c) #203 numbers: (a) Codex cached_input ⊆ input -> priced once, never added twice;
  #      (b) a week straddling the month boundary contributes only its in-month days — evenly when the
  #      allocated block has no items[], per bill service period when it has; (c) request review matches
  #      one bill_ref through items[] and never pulls the whole merged block along.
  python3 -c "import json,sys; p=json.load(open(sys.argv[1])); p['codex']['default']={'input':1.0,'cached_input':0.1,'output':2.0}; json.dump(p,open(sys.argv[2],'w'))" "$fw/pricing.json" "$tmp/pricing-codex.json"
  mkdir -p "$tmp/rep-codex"
  if "$tool" submit --week 2026-W33 --workspace-root "$tmp/ws" --claude-dir "$tmp/claude" --codex-dir "$tmp/codex" --qoder-dir "$tmp/empty" --pricing "$tmp/pricing-codex.json" --source native --out "$tmp/out" --reports-dir "$tmp/rep-codex" >/dev/null; then
    python3 - "$tmp/rep-codex/reports/2026-W33/alice.json" <<'EOFC' || fail=1
import json, sys
s = json.load(open(sys.argv[1])); u, e = s["usage"], s["cost"]["estimated"]
def check(cond, msg):
    if not cond:
        print("codex pricing assertion failed: " + msg); sys.exit(1)
# codex fixture: input 1000 (800 cached) / output 200 -> (200×1 + 800×0.1 + 200×2) / 1e6 = 0.00068, not (1000×1 + 800×0.1 + 200×2)
check(abs(u["by_model"]["codex"]["cost"] - 0.00068) < 1e-9, "codex cost must price the cached part once: %r" % u["by_model"]["codex"])
check(u["by_model"]["codex"]["input"] == 200 and u["by_model"]["codex"]["cache_read"] == 800, "codex by_model must split input into uncached 200 + cached 800")
check(abs(e["amount"] - (0.0086725 + 0.00068)) < 1e-6 and "codex" not in e["unpriced_models"], "estimate must add the codex 0.00068 once: %r" % e)
EOFC
  else
    echo "submit with codex pricing failed"; fail=1
  fi
  cp -R "$fw/team-budget" "$tmp/tb6"
  python3 - "$tmp/tb6/reports" <<'EOFW'
import json, os, sys
d = sys.argv[1]; a = json.load(open(os.path.join(d, "2026-W32", "alice.json")))
a["meta"].update({"week": "2026-W31", "since": "2026-07-27", "until": "2026-08-02"})
for k in ("estimated", "allocated"):
    a["cost"][k]["period"] = {"since": "2026-07-27", "until": "2026-08-02"}
a["cost"]["allocated"].update({"amount": 70.0, "basis": "fixture: weekly bill 07-27..08-02, 10/day, no items"})
a["cost"]["actual"].update({"amount": 70.0, "period": {"since": "2026-07-27", "until": "2026-08-02"}})  # pre-#203 file: the bill period lives in actual.period
os.makedirs(os.path.join(d, "2026-W31"), exist_ok=True)
json.dump(a, open(os.path.join(d, "2026-W31", "alice.json"), "w"), ensure_ascii=False, indent=1)
EOFW
  "$tool" team --week 2026-W34 --reports-dir "$tmp/tb6" --workspace-root "$tmp/ws" >/dev/null \
    && python3 -c "
import sys; s=open(sys.argv[1]).read(); s=s[s.index('月度预算'):s.index('六项校验')]
ok = '155.16' in s and '209.13' in s and '跨月折算 70.00→20.00' in s and 'W31' in s and '205.16' not in s
sys.exit(0 if ok else (print('W31 (07-27..08-02, a 70 weekly bill, no items) must add only 2/7 = 20 to August: 135.16 + 20 = 155.16, forecast 209.13; got:\n' + s) or 1))" "$tmp/tb6/reports/2026-W34/team-report.md" || fail=1
  python3 - "$tmp/tb6/reports/2026-W31/alice.json" <<'EOFW1'
import json, sys
p = sys.argv[1]; a = json.load(open(p))
# pre-#203 --bill file: no items, but the share 12.90 was already prorated from the August subscription
# (actual.period 08-01..08-31) — it must NOT be prorated again by 2/7 (= 3.69)
a["cost"]["allocated"].update({"amount": 12.9, "basis": "ledger 2026-08: 200.00 × 2/31 天"})
a["cost"]["actual"].update({"amount": 200.0, "period": {"since": "2026-08-01", "until": "2026-08-31"}})
json.dump(a, open(p, "w"), ensure_ascii=False, indent=1)
EOFW1
  "$tool" team --week 2026-W34 --reports-dir "$tmp/tb6" --workspace-root "$tmp/ws" >/dev/null \
    && python3 -c "
import sys; s=open(sys.argv[1]).read(); s=s[s.index('月度预算'):s.index('六项校验')]
ok = '148.06' in s and '3.69' not in s and '138.85' not in s
sys.exit(0 if ok else (print('a pre-#203 share already prorated from an August bill (actual.period 08-01..08-31) counts in full: 148.06, never 2/7 again; got:\n' + s) or 1))" "$tmp/tb6/reports/2026-W34/team-report.md" || fail=1
  python3 - "$tmp/tb6/reports/2026-W31/alice.json" <<'EOFW0'
import json, sys
p = sys.argv[1]; a = json.load(open(p))
a["cost"]["actual"] = None  # nothing says which days the 12.90 covers -> 待核实 on a straddling week, not a guess
json.dump(a, open(p, "w"), ensure_ascii=False, indent=1)
EOFW0
  "$tool" team --week 2026-W34 --reports-dir "$tmp/tb6" --workspace-root "$tmp/ws" >/dev/null \
    && python3 -c "
import sys; s=open(sys.argv[1]).read(); s=s[s.index('月度预算'):s.index('六项校验')]
w31 = [l for l in s.splitlines() if l.startswith('| W31')][0]
ok = '135.16' in s and '148.06' not in s and '待核实' in w31 and 'alice' in w31 and '无账单服务期' in w31
sys.exit(0 if ok else (print('a straddling week with no items and no actual.period must be 待核实 and not counted (135.16); got:\n' + w31) or 1))" "$tmp/tb6/reports/2026-W34/team-report.md" || fail=1
  python3 - "$tmp/tb6/reports/2026-W31/alice.json" <<'EOFW2'
import json, sys
p = sys.argv[1]; a = json.load(open(p))
# the same week, but the bill behind it is an August subscription: the share already covers only 08-01..08-02
a["cost"]["allocated"].update({"amount": 12.9, "basis": "ledger 2026-08: 200.00 × 2/31 天",
    "items": [{"source": "ledger 2026-08", "amount": 12.9, "nature": "seat", "period": {"since": "2026-08-01", "until": "2026-08-31"}}]})
json.dump(a, open(p, "w"), ensure_ascii=False, indent=1)
EOFW2
  "$tool" team --week 2026-W34 --reports-dir "$tmp/tb6" --workspace-root "$tmp/ws" >/dev/null \
    && python3 -c "
import sys; s=open(sys.argv[1]).read(); s=s[s.index('月度预算'):s.index('六项校验')]
ok = '148.06' in s and '跨月折算 12.90→12.90' in s
sys.exit(0 if ok else (print('an allocated share whose bill period is 08-01..08-31 is already all-August: 135.16 + 12.90 = 148.06, never prorated again; got:\n' + s) or 1))" "$tmp/tb6/reports/2026-W34/team-report.md" || fail=1
  cp -R "$fw/team-budget" "$tmp/tb7"
  python3 - "$tmp/tb7/reports/2026-W33/alice.json" <<'EOFI'
import json, sys
p = sys.argv[1]; a = json.load(open(p)); per = {"since": "2026-08-01", "until": "2026-08-31"}
a["cost"]["actual"].update({"amount": 1200.0, "nature": "shared", "source": "ledger 2026-08; gpu-invoice 2026-08",
    "items": [{"source": "ledger 2026-08", "amount": 200.0, "nature": "seat", "period": per},
              {"source": "gpu-invoice 2026-08", "amount": 1000.0, "nature": "gpu", "period": per}]})
a["cost"]["allocated"].update({"amount": 270.97, "nature": "shared", "source": "ledger 2026-08; gpu-invoice 2026-08",
    "basis": "ledger 2026-08: 200.00 × 7/31 天; gpu-invoice 2026-08: 1000.00 × 7/31 天",
    "items": [{"source": "ledger 2026-08", "amount": 45.16, "nature": "seat", "period": per},
              {"source": "gpu-invoice 2026-08", "amount": 225.81, "nature": "gpu", "period": per}]})
json.dump(a, open(p, "w"), ensure_ascii=False, indent=1)
EOFI
  if "$tool" request review 2026-08-alice-claude-seat --reports-dir "$tmp/tb7" --workspace-root "$tmp/ws" >/dev/null; then
    python3 - "$tmp/tb7/reports/requests/2026-08-alice-claude-seat.review.md" <<'EOFI2' || fail=1
import sys
md = open(sys.argv[1]).read()
def check(cond, msg):
    if not cond:
        print("review items assertion failed: " + msg); sys.exit(1)
w33 = [l for l in md.splitlines() if l.startswith("| 2026-W33 ")][0]
check("45.16 USD" in w33 and "270.97" not in md, "W33 must count only the ledger item (45.16), not the merged Claude+GPU block 270.97: " + w33)
check("未逐笔" not in w33, "a block with items[] is matched exactly, no 未逐笔 flag: " + w33)
check("| **合计** | **135.16 USD** |" in md, "total across the service period must stay 40 + 45.16 + 50 = 135.16")
check(any("未逐笔" in l for l in md.splitlines() if l.startswith("| 2026-W32 ")), "a pre-items block (W32) matched on its merged source must be flagged 未逐笔")
EOFI2
  else
    echo "request review with items failed"; fail=1
  fi
  "$tool" team --week 2026-W34 --reports-dir "$tmp/tb7" --workspace-root "$tmp/ws" >/dev/null \
    && python3 -c "import sys; s=open(sys.argv[1]).read(); s=s[s.index('月度预算'):s.index('六项校验')]; sys.exit(0 if '360.97' in s else (print('budget counts every bill: 40 + 270.97 + 50 = 360.97') or 1))" "$tmp/tb7/reports/2026-W34/team-report.md" || fail=1
  # 10d) review matching edges: an explicit bill_ref matches a source whole (invoice-1 ≠ invoice-10);
  #      currencies are never added together — per-currency totals, comparison only in the request's currency.
  cp -R "$fw/team-budget" "$tmp/tb8"
  python3 - "$tmp/tb8/reports" <<'EOFX'
import json, os, sys
d = sys.argv[1]; per = {"since": "2026-08-01", "until": "2026-08-31"}
p = os.path.join(d, "2026-W33", "alice.json"); a = json.load(open(p))
a["cost"]["allocated"].update({"amount": 1100.0, "source": "invoice-1; invoice-10", "basis": "fixture",
    "items": [{"source": "invoice-1", "amount": 100.0, "nature": "seat", "period": per},
              {"source": "invoice-10", "amount": 1000.0, "nature": "gpu", "period": per}]})
a["cost"]["actual"].update({"amount": 1100.0, "source": "invoice-1; invoice-10"})
json.dump(a, open(p, "w"), ensure_ascii=False, indent=1)
p = os.path.join(d, "2026-W34", "alice.json"); a = json.load(open(p))
for k in ("allocated", "actual"):
    a["cost"][k].update({"currency": "CNY", "source": "invoice-1"})
a["cost"]["allocated"]["amount"] = 700.0
json.dump(a, open(p, "w"), ensure_ascii=False, indent=1)
p = os.path.join(d, "requests", "2026-08-alice-claude-seat.json"); r = json.load(open(p))
r["bill_refs"] = ["invoice-1"]
json.dump(r, open(p, "w"), ensure_ascii=False, indent=1)
EOFX
  if "$tool" request review 2026-08-alice-claude-seat --reports-dir "$tmp/tb8" --workspace-root "$tmp/ws" >/dev/null; then
    python3 - "$tmp/tb8/reports/requests/2026-08-alice-claude-seat.review.md" <<'EOFX2' || fail=1
import sys
md = open(sys.argv[1]).read()
def check(cond, msg):
    if not cond:
        print("review edge assertion failed: " + msg); sys.exit(1)
w33 = [l for l in md.splitlines() if l.startswith("| 2026-W33 ")][0]
w34 = [l for l in md.splitlines() if l.startswith("| 2026-W34 ")][0]
check("100.00 USD" in w33 and "1100" not in w33 and "1,100" not in w33, "bill_ref invoice-1 must not match invoice-10: " + w33)
check("700.00 CNY" in w34, "W34 must be reported in its own currency: " + w34)
check("| **合计** | **700.00 CNY + 100.00 USD** |" in md, "totals must stay per currency, never 800: " + [l for l in md.splitlines() if "合计" in l][0])
check("800.00" not in md and "vs 账单累计 100.00 USD" in md and "待换算" in md and "700.00 CNY" in md,
      "comparison only in the request currency (USD), CNY listed as 待换算")
EOFX2
  else
    echo "request review edge case failed"; fail=1
  fi

  # 7) `team`: aggregates the planted submissions, quarantines the broken one, lists the missing
  #    member, keeps name order (bob costs more than alice yet alice comes first), renders a
  #    self-contained HTML, never shows 0 for missing data, and refuses to green on nothing.
  cp -R "$fw/team-reports" "$tmp/tr"
  printf 'LEAD-SUMMARY 本周重点是 alpha。\n' > "$tmp/summary.md"
  if "$tool" team --week 2026-W33 --reports-dir "$tmp/tr" --workspace-root "$tmp/ws" --summary-file "$tmp/summary.md" >/dev/null; then
    python3 - "$tmp/tr/reports/2026-W33" "$tmp" <<'EOF3' || fail=1
import json, os, re, sys
d, tmproot = sys.argv[1], sys.argv[2]
def check(cond, msg):
    if not cond:
        print("team assertion failed: " + msg); sys.exit(1)
hp, mp = os.path.join(d, "team-report.html"), os.path.join(d, "team-report.md")
check(os.path.isfile(hp) and os.path.isfile(mp), "team-report.html/.md not written beside the submissions")
h, md = open(hp).read(), open(mp).read()
for blob, name in ((h, "html"), (md, "md")):
    check("dave" in blob and "未纳入" in blob, name + ": broken file must be listed under 未纳入")
    check("carol" in blob and "未提交" in blob, name + ": missing member must be listed under 未提交")
    check("LEAD-SUMMARY" in blob, name + ": --summary-file not rendered")
    tbl = blob[blob.index("按成员"):]
    check(tbl.index("alice") < tbl.index("bob"), name + ": members must be in name order, not cost order")
    check("30" in blob and "4.00" in blob, name + ": total requests 30 / estimated total 4.00 wrong")
    check("估算" in blob and "test-1" in blob, name + ": estimate must be labelled with pricing version")
    check("12.50" in blob and "1/2" in blob, name + ": actual-cost confirmation must show 1 of 2 members")
    check("ALICE-METHOD" in blob and "BOB-FAIL" in blob and "ALICE-ACTION" in blob and "BOB-ACTION" in blob,
          name + ": 值得学习 / 失败 / 建议跟进 not concatenated")
    check("2/3" in blob, name + ": submission rate 2/3 missing")
    check("归属守恒" in blob and "成果有依据" in blob and "周期一致" in blob, name + ": six checks missing")
    check("1 项无证据" in blob or "无证据 1" in blob or "无证据: 1" in blob, name + ": evidence-less task count missing")
    # T6: reports/requests/*.json -> 本周新申请 (created in the week) + 待复评 (renewing, ends within 30 days, no review yet)
    check("本周新申请" in blob and "GPU box" in blob, name + ": this week's new request (GPU box, created 08-12) missing")
    check("待复评" in blob and "Codex quota" in blob, name + ": renewal due within 30 days without a review (Codex quota) missing")
    check("Old tool" not in blob, name + ": expired request must not be listed")
check("<script src" not in h and "http://" not in h and "https://" not in h, "html must be self-contained")
check("<svg" in h, "html must have inline SVG charts")
check(tmproot not in h and "/fake/" not in h and "s-aaa" not in h, "html leaked a path / session id")
EOF3
  else
    echo "team failed on the planted submissions"; fail=1
  fi
  # 7a2) lead's whole-team platform export: rows map to human_id via team.json platform_ids; a member
  #      with no submission still gets a usage row (叙事 待提交); an existing submission is deduped
  #      per (day, model) with the platform record winning.
  cp -R "$fw/team-reports" "$tmp/tp"; rm -f "$tmp/tp/reports/2026-W33/bob.json"
  if "$tool" team --week 2026-W33 --reports-dir "$tmp/tp" --workspace-root "$tmp/ws" --pricing "$fw/pricing.json" --platform-export "$fw/platform-export.csv" >/dev/null; then
    python3 - "$tmp/tp/reports/2026-W33/team-report.html" "$tmp/tp/reports/2026-W33/team-report.md" <<'EOF8' || fail=1
import sys
h, md = open(sys.argv[1]).read(), open(sys.argv[2]).read()
def check(cond, msg):
    if not cond:
        print("team platform-export assertion failed: " + msg); sys.exit(1)
for blob, name in ((h, "html"), (md, "md")):
    tbl = blob[blob.index("按成员"):]
    check("bob" in tbl and "待提交" in blob, name + ": platform-only member bob must appear with 叙事 待提交")
    check("bob-platform" not in blob, name + ": raw platform user id must be mapped away")
    # alice file cells: (08-10, fable-5) 6 + (08-12, fable-5) 4; platform: (08-10, fable-5) 5 replaces the 6,
    # (08-12, gpt) 2 is new, (08-12, fable-5) 4 stays -> 11 requests
    check("平台" in blob, name + ": platform source must be named")
import re
check(re.search(r"\| alice[^|]*\| 11 \|", md), "md: alice must be 5 (platform 08-10) + 4 (local 08-12 fable) + 2 (platform 08-12 gpt) = 11, got: " + [l for l in md.splitlines() if l.startswith("| alice")][0])
check(re.search(r"\| bob[^|]*\| 7 \|", md), "md: bob (platform only) must show 7 requests")
EOF8
  else
    echo "team --platform-export failed"; fail=1
  fi
  # 7a3) only the lead's export, no submissions at all -> still renders usage, narratives 待提交
  mkdir -p "$tmp/tp/reports/2026-W36"
  "$tool" team --week 2026-W36 --reports-dir "$tmp/tp" --workspace-root "$tmp/ws" --pricing "$fw/pricing.json" --platform-export "$fw/platform-export-w36.csv" >/dev/null \
    && grep -q "待提交" "$tmp/tp/reports/2026-W36/team-report.md" || { echo "team must render from the lead's export alone"; fail=1; }
  # 7b) no team.json -> coverage shows 待接入, never 0% / 0 members
  rm -f "$tmp/tr/reports/team.json"
  if "$tool" team --week 2026-W33 --reports-dir "$tmp/tr" --workspace-root "$tmp/ws" >/dev/null; then
    python3 - "$tmp/tr/reports/2026-W33/team-report.html" <<'EOF4' || fail=1
import re, sys
h = open(sys.argv[1]).read()
ok = "待接入" in h and not re.search(r"(?<![\d.])0%", h) and "carol" not in h
sys.exit(0 if ok else (print("without team.json coverage must read 待接入 (no 0%, no invented members)") or 1))
EOF4
  else
    echo "team without team.json must still render"; fail=1
  fi
  # 7c) allocation != 100% in a planted file -> page-top 归属守恒 warning, still renders
  cp -R "$fw/team-badalloc" "$tmp/tb"
  "$tool" team --week 2026-W34 --reports-dir "$tmp/tb" --workspace-root "$tmp/ws" >/dev/null || { echo "team must render despite a failed check"; fail=1; }
  python3 - "$tmp/tb/reports/2026-W34/team-report.html" <<'EOF5' || fail=1
import sys
h = open(sys.argv[1]).read()
sys.exit(0 if ("归属守恒" in h[:h.index("</header>")] if "</header>" in h else False) else (print("归属守恒 warning must appear at the page top") or 1))
EOF5
  # 7d) empty week -> exit 2
  mkdir -p "$tmp/tr/reports/2026-W40"
  rc=0; "$tool" team --week 2026-W40 --reports-dir "$tmp/tr" --workspace-root "$tmp/ws" >/dev/null 2>&1 || rc=$?
  [ "$rc" -eq 2 ] || { echo "team on an empty week must exit 2 (got $rc)"; fail=1; }
  # 7e) reports-repo automation template: only GITHUB_TOKEN, and its script reproduces `team` from a pushed path
  wf="$here/../assets/reports-repo/.github/workflows/team-report.yml"
  [ -f "$wf" ] || { echo "MISSING reports-repo workflow template"; fail=1; }
  if [ -f "$wf" ]; then
    grep -q "ai-usage-weekly" "$wf" || { echo "workflow template does not run ai-usage-weekly team"; fail=1; }
    if grep -o 'secrets\.[A-Za-z_]*' "$wf" | grep -vq 'secrets.GITHUB_TOKEN'; then echo "workflow template needs a non-GITHUB_TOKEN secret"; fail=1; fi
  fi
  sh "$here/../assets/reports-repo/scripts/team-report.sh" "$root" "$tmp/tr" "reports/2026-W33/alice.json" >/dev/null 2>&1 \
    && [ -f "$tmp/tr/reports/2026-W33/team-report.html" ] || { echo "reports-repo/scripts/team-report.sh did not reproduce team-report.html from a pushed path"; fail=1; }
  # 7f) missing reports dir: `submit` creates a LOCAL reports repo (own .git, starter files, roster /
  #     budget only as .example so no placeholder is read) and warns once; `team` never creates it.
  fresh="$tmp/fresh/ai-usage-reports"
  rc=0; "$tool" team --week 2026-W33 --reports-dir "$fresh" >/dev/null 2>&1 || rc=$?
  [ "$rc" -eq 2 ] && [ ! -d "$fresh" ] || { echo "team on a missing reports dir must exit 2 without creating it (got $rc)"; fail=1; }
  rc=0; out=$("$tool" submit --week 2026-W33 $common --reports-dir "$fresh" --commit 2>&1) || rc=$?
  [ "$rc" -eq 0 ] || { echo "submit on a missing reports dir must create it and succeed (got $rc)"; fail=1; }
  echo "$out" | grep -q "WARN: reports dir .* did not exist" && echo "$out" | grep -q "不是团队仓" \
    || { echo "submit did not warn that the created reports dir is local, not the team repo"; fail=1; }
  echo "$out" | grep -q "OK: committed in" || { echo "--commit must land in the created repo's own git"; fail=1; }
  for f in reports/2026-W33/alice.json README.md scripts/team-report.sh .github/workflows/team-report.yml \
           reports/team.json.example reports/budget.json.example; do
    [ -f "$fresh/$f" ] || { echo "created reports dir lacks $f"; fail=1; }
  done
  [ -d "$fresh/.git" ] || { echo "created reports dir has no .git of its own"; fail=1; }
  [ ! -f "$fresh/reports/team.json" ] && [ ! -f "$fresh/reports/budget.json" ] \
    || { echo "placeholder team.json / budget.json must not be seeded under their live names"; fail=1; }
  if "$tool" submit --week 2026-W33 $common --reports-dir "$fresh" 2>&1 | grep -q "WARN: reports dir"; then
    echo "second submit must not warn again about creating the reports dir"; fail=1; fi
  "$tool" team --week 2026-W33 --reports-dir "$fresh" >/dev/null 2>&1 || { echo "team must work on the created reports dir"; fail=1; }
  # 11) `month` (#360): the LiteLLM key allocation xlsx (sheets found by name, stored out of order) ->
  #     reports/months/<YYYY-MM>/ month.json + .md + .html; cost by file team in name order (case-insensitive);
  #     [Unallocated] on its own line; totals checked against Summary; no key / email in the output;
  #     use / delivery / value 待接入; re-import replaces, never doubles; a mismatch warns but still writes;
  #     the month comes from the file name only (september_2026 / 2026-10 / 202611 / 2026年12月); a name with
  #     no month or two months, and an unknown column, exit 2 and write nothing.
  mon="$tmp/month"; mkdir -p "$mon/reports"
  md="$mon/reports/months/2026-09"
  "$tool" month --allocation "$fw/allocation_september_2026.xlsx" --reports-dir "$mon" --workspace-root "$tmp/ws" >/dev/null \
    || { echo "month import of the good fixture failed"; fail=1; }
  check_month() {
    python3 - "$md" <<'PY' || { echo "month record wrong after $1"; fail=1; }
import json, os, re, sys
d = sys.argv[1]
m = json.load(open(os.path.join(d, "month.json")))
t = m["total"]
ok = abs(t["cost_usd"] - 77.504) < 1e-6 and abs(t["unallocated_usd"] - 2.5) < 1e-6 and t["unallocated_rows"] == 1 \
     and [x["team"] for x in m["teams"]] == ["Alpha", "beta", "Gamma"] \
     and m["teams"][0]["cost_usd"] == 55 and m["teams"][0]["keys"] == 2 and m["teams"][0]["tokens"] == 1400 \
     and all(c["status"] == "ok" for c in m["checks"]) and len(m["checks"]) == 2 \
     and m["ai_use"] is None and m["delivery"] is None and m["value"] is None \
     and "workspace_sha" in m and m["tool"].startswith("ws-") \
     and [x["key"] for x in m["not_connected"]] == ["quality", "bug_bash", "value_hypothesis", "maturity"]
blob = "".join(open(os.path.join(d, f), encoding="utf-8").read() for f in ("month.json", "month-report.md", "month-report.html"))
h = open(os.path.join(d, "month-report.html"), encoding="utf-8").read()
ok = ok and "example.com" not in blob and "svc-alpha-01" not in blob \
     and h.count("待接入") >= 7 and "尚未接入" not in h and "Bug Bash" not in h and "代码仓读取" not in h and "&lt;0.1%" in h and not re.search(r"(?<![\d.])0\.0%", h) and "<script src" not in h and "http" not in h
sys.exit(0 if ok else (print(json.dumps(m, ensure_ascii=False)[:600]) or 1))
PY
  }
  check_month "first import"
  "$tool" month --allocation "$fw/allocation_september_2026.xlsx" --reports-dir "$mon" --workspace-root "$tmp/ws" >"$tmp/mon2.out" 2>&1 \
    && grep -q "已整月替换" "$tmp/mon2.out" || { echo "month re-import must succeed and say it replaced the month"; fail=1; }
  check_month "re-import"
  rc=0; "$tool" month --allocation "$fw/allocation-unknown_2026-10.xlsx" --reports-dir "$mon" >"$tmp/mon3.out" 2>&1 || rc=$?
  [ "$rc" -eq 2 ] && grep -q "Mystery Column" "$tmp/mon3.out" && [ ! -e "$mon/reports/months/2026-10" ] \
    || { echo "month: unknown column must exit 2 naming it, writing nothing (got $rc)"; fail=1; }
  mkdir -p "$tmp/names"
  cp "$fw/allocation_september_2026.xlsx" "$tmp/names/allocation.xlsx"
  rc=0; "$tool" month --allocation "$tmp/names/allocation.xlsx" --reports-dir "$mon" >"$tmp/mon5.out" 2>&1 || rc=$?
  [ "$rc" -eq 2 ] && grep -q "states no month" "$tmp/mon5.out" || { echo "month: a file name with no month must exit 2 (got $rc)"; fail=1; }
  cp "$fw/allocation_september_2026.xlsx" "$tmp/names/2026-09_to_october_2026.xlsx"
  rc=0; "$tool" month --allocation "$tmp/names/2026-09_to_october_2026.xlsx" --reports-dir "$mon" >"$tmp/mon6.out" 2>&1 || rc=$?
  [ "$rc" -eq 2 ] && grep -q "more than one month" "$tmp/mon6.out" && [ ! -e "$mon/reports/months/2026-10" ] \
    || { echo "month: a file name with two months must exit 2, writing nothing (got $rc)"; fail=1; }
  cp "$fw/allocation_september_2026.xlsx" "$tmp/names/分摊_2026年12月.xlsx"
  "$tool" month --allocation "$tmp/names/分摊_2026年12月.xlsx" --reports-dir "$mon" --no-git >/dev/null 2>&1 \
    && [ -f "$mon/reports/months/2026-12/month.json" ] || { echo "month: 2026年12月 in the file name must land in 2026-12"; fail=1; }
  "$tool" month --allocation "$fw/allocation-mismatch_202611.xlsx" --reports-dir "$mon" --no-git >"$tmp/mon4.out" 2>&1 \
    || { echo "month: a total mismatch must still write the report"; fail=1; }
  python3 -c "import json,sys; m=json.load(open(sys.argv[1])); c={x['name']:x['status'] for x in m['checks']}; sys.exit(0 if c.get('合计一致')=='fail' else 1)" \
    "$mon/reports/months/2026-11/month.json" && grep -q "WARN: 校验未通过 合计一致" "$tmp/mon4.out" \
    && grep -q 'class="alert"' "$mon/reports/months/2026-11/month-report.html" \
    || { echo "month: a total mismatch must fail 合计一致, warn, and flag the page"; fail=1; }
  # 12) `month` + git (#363): a fake repo built here with fixed dates -> per-repo commits (no merges),
  #     AI-assisted commits (AI Co-Authored-By only, a human co-author does not count), reverts; the month
  #     is the author date in the team timezone; keys and authors map to persons through team.json
  #     identities (email or GitHub noreply login); non-person keys stay out of 按人; unmapped authors are
  #     listed, unmapped keys counted; without identities 按人 stays 待接入; a non-repo --repo exits 2.
  gr="$tmp/gitws/repos/fake-app"; mkdir -p "$gr"
  gc() { # gc <date> <name> <email> <message> [--allow-empty extra args]
    d="$1" n="$2" e="$3" msg="$4"; shift 4
    GIT_AUTHOR_DATE="$d" GIT_COMMITTER_DATE="$d" GIT_AUTHOR_NAME="$n" GIT_AUTHOR_EMAIL="$e" \
      GIT_COMMITTER_NAME="$n" GIT_COMMITTER_EMAIL="$e" git -C "$gr" commit -q --allow-empty -m "$msg" "$@"
  }
  git -C "$gr" init -q -b main
  gc 2026-08-31T23:30:00+08:00 Alice alice@example.com "before the month"
  gc 2026-08-31T18:30:00+00:00 Alice alice@example.com "Sep 1 02:30 in Singapore"
  gc 2026-09-02T10:00:00+08:00 Alice alice@example.com "ai work" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
  echo x >"$gr/f.txt"; git -C "$gr" add f.txt
  gc 2026-09-10T10:00:00+08:00 Bob 12345+bobgh@users.noreply.github.com "add f" -m "Co-authored-by: Codex <codex@openai.com>"
  GIT_AUTHOR_DATE=2026-09-11T10:00:00+08:00 GIT_COMMITTER_DATE=2026-09-11T10:00:00+08:00 GIT_AUTHOR_NAME=Bob \
    GIT_AUTHOR_EMAIL=12345+bobgh@users.noreply.github.com GIT_COMMITTER_NAME=Bob GIT_COMMITTER_EMAIL=bob@example.com \
    git -C "$gr" revert --no-edit HEAD >/dev/null
  git -C "$gr" checkout -q -b feature
  gc 2026-09-15T10:00:00+08:00 Carol carol@example.com "pair work" -m "Co-Authored-By: Julian <julian@example.com>"
  git -C "$gr" checkout -q main
  GIT_AUTHOR_DATE=2026-09-16T10:00:00+08:00 GIT_COMMITTER_DATE=2026-09-16T10:00:00+08:00 GIT_AUTHOR_NAME=Alice \
    GIT_AUTHOR_EMAIL=alice@example.com GIT_COMMITTER_NAME=Alice GIT_COMMITTER_EMAIL=alice@example.com \
    git -C "$gr" merge -q --no-ff -m "Merge feature" feature
  gc 2026-09-20T10:00:00+08:00 Dave dave@example.com "dave"
  gc 2026-10-01T00:30:00+08:00 Alice alice@example.com "after the month"
  gm="$tmp/gitmonth"; mkdir -p "$gm/reports"
  "$tool" month --allocation "$fw/allocation_september_2026.xlsx" --reports-dir "$gm" --workspace-root "$tmp/gitws" >"$tmp/g1.out" 2>&1 \
    && grep -q "按人 shows 待接入" "$tmp/g1.out" || { echo "month+git without identities must succeed and say 按人 is 待接入"; fail=1; }
  printf '%s\n' '{"team": "t", "members": ["alice", "bob"], "timezone": "Asia/Singapore",' \
    ' "identities": {"Alice@Example.com": "alice", "bob@example.com": "bob", "BOBGH": "bob"}}' >"$gm/reports/team.json"
  "$tool" month --allocation "$fw/allocation_september_2026.xlsx" --reports-dir "$gm" --workspace-root "$tmp/gitws" >"$tmp/g2.out" 2>&1 \
    || { echo "month+git with identities failed"; cat "$tmp/g2.out"; fail=1; }
  python3 - "$gm/reports/months/2026-09" <<'PY' || { echo "month+git record wrong"; fail=1; }
import json, os, sys
d = sys.argv[1]
m = json.load(open(os.path.join(d, "month.json")))
r = m["git"]["repos"]
ok = len(r) == 1 and r[0]["repo"] == "fake-app" and r[0]["commits"] == 6 and r[0]["ai_commits"] == 2 \
     and r[0]["reverts"] == 1 and r[0]["authors"] == 4 and m["git"]["timezone"] == "Asia/Singapore"
p = {x["human_id"]: x for x in m["people"]}
ok = ok and [x["human_id"] for x in m["people"]] == ["alice", "bob"] \
     and p["alice"]["cost_usd"] == 40 and p["alice"]["commits"] == 2 and p["alice"]["ai_commits"] == 1 \
     and p["alice"]["teams"] == ["Alpha"] and p["alice"]["keys"] == 1 \
     and p["bob"]["cost_usd"] == 20 and p["bob"]["commits"] == 2 and p["bob"]["ai_commits"] == 1 and p["bob"]["reverts"] == 1 \
     and p["bob"]["repos"] == {"fake-app": {"commits": 2, "ai_commits": 1, "reverts": 1}}
u = m["unmapped"]
ok = ok and u["keys"] == 1 and u["keys_cost_usd"] == 0.004 and "carol@example.com" not in json.dumps(u["keys"]) \
     and sorted(a["email"] for a in u["authors"]) == ["carol@example.com", "dave@example.com"]
h = open(os.path.join(d, "month-report.html"), encoding="utf-8").read()
md = open(os.path.join(d, "month-report.md"), encoding="utf-8").read()
blob = json.dumps(m) + h + md
ok = ok and "svc-alpha-01" not in json.dumps(m["people"]) and "下限" in h and "下限" in md \
     and "&lt;dave@example.com&gt;" in h and "<dave@example.com>" in md and "<script src" not in h and "http" not in h
sys.exit(0 if ok else (print(json.dumps({k: m[k] for k in ("git", "people", "unmapped")}, ensure_ascii=False)[:900]) or 1))
PY
  rc=0; "$tool" month --allocation "$fw/allocation_september_2026.xlsx" --reports-dir "$gm" --repo "$tmp/names" >"$tmp/g3.out" 2>&1 || rc=$?
  [ "$rc" -eq 2 ] && grep -q "not a git repo" "$tmp/g3.out" || { echo "month: a --repo that is not a git repo must exit 2 (got $rc)"; fail=1; }
  "$tool" month --allocation "$fw/allocation_september_2026.xlsx" --reports-dir "$gm" --workspace-root "$tmp/gitws" --no-git >/dev/null 2>&1 \
    && python3 -c "import json,sys; m=json.load(open(sys.argv[1])); sys.exit(0 if m['git'] is None and m['people'][1]['commits'] is None and m['people'][1]['cost_usd']==20 else 1)" \
       "$gm/reports/months/2026-09/month.json" \
    && grep -Fq "| bob | 待接入 | 待接入 | 待接入 | 待接入 | 待接入 |" "$gm/reports/months/2026-09/month-report.md" \
    && grep -Fq "| bob | beta | \$20.00 | 1 |" "$gm/reports/months/2026-09/month-report.md" \
    || { echo "month --no-git must leave git null, show commits 待接入 (not 0) and keep cost per person"; fail=1; }
  # 13) `month` + weekly data (#361): fake submissions across month boundaries -> a week counts in the
  #     month of its Sunday only (W35 ends in Aug, W40 in Oct: neither is in Sep); tokens by repo, models,
  #     agents, deliverables with evidence, the month's requests (new / reviewed with verdict); a coverage
  #     line in each section (submitted persons vs persons in the cost file, share of real cost); the
  #     estimate is labelled 估算; a month with no submissions keeps the sections 待接入.
  vm="$tmp/viewmonth"; mkdir -p "$vm/reports/requests"
  python3 - "$fw" "$vm" <<'PY' || { echo "could not build the #361 fixtures"; fail=1; }
import json, os, sys
fw, R = sys.argv[1], sys.argv[2]
def put(src, week, since, until, git_only=None):
    s = json.load(open(os.path.join(fw, "team-budget/reports", src)))
    s["meta"].update(week=week, since=since, until=until)
    if git_only:  # a repo the submission lists only under git (git_stats() counts every author): no row, no person
        s.setdefault("git", {})[git_only] = {"commits": 9, "insertions": 1, "deletions": 1}
    s["cost"]["estimated"]["period"] = {"since": since, "until": until}
    d = os.path.join(R, "reports", week); os.makedirs(d, exist_ok=True)
    json.dump(s, open(os.path.join(d, s["meta"]["human_id"] + ".json"), "w"), ensure_ascii=False)
put("2026-W34/alice.json", "2026-W35", "2026-08-24", "2026-08-30")
put("2026-W34/alice.json", "2026-W36", "2026-08-31", "2026-09-06")
put("2026-W34/bob.json", "2026-W39", "2026-09-21", "2026-09-27", git_only="gitonly")
put("2026-W34/alice.json", "2026-W40", "2026-09-28", "2026-10-04")
r = json.load(open(os.path.join(fw, "team-reports/reports/requests/2026-07-bob-codex-quota.json")))
r.update(id="2026-09-bob-codex-quota", created_at="2026-09-03T10:00:00+08:00", start="2026-09-01", end="2026-12-31", outcome="faster reviews")
r2 = dict(r, id="2026-06-alice-tool", human_id="alice", created_at="2026-06-01T10:00:00+08:00", start="2026-06-01", end="2026-09-30",
          review_before_renewal={"verdict": "stop", "reason": "not used", "reviewed_at": "2026-09-20T10:00:00+08:00", "reviewed_by": "lead"})
for x in (r, r2):
    json.dump(x, open(os.path.join(R, "reports/requests", x["id"] + ".json"), "w"))
json.dump({"timezone": "Asia/Singapore", "members": ["alice", "bob"],
           "identities": {"alice@example.com": "alice", "bob@example.com": "bob"}}, open(os.path.join(R, "reports/team.json"), "w"))
PY
  "$tool" month --allocation "$fw/allocation_september_2026.xlsx" --reports-dir "$vm" --no-git >"$tmp/v1.out" 2>&1 \
    || { echo "month with weekly data failed"; cat "$tmp/v1.out"; fail=1; }
  cp "$fw/allocation_september_2026.xlsx" "$tmp/names/allocation_october_2026.xlsx"
  "$tool" month --allocation "$tmp/names/allocation_october_2026.xlsx" --reports-dir "$vm" --no-git >/dev/null 2>&1 \
    || { echo "month 2026-10 with weekly data failed"; fail=1; }
  python3 - "$vm/reports/months" <<'PY' || { echo "month weekly view (#361) wrong"; fail=1; }
import json, os, re, sys
d = sys.argv[1]
m = json.load(open(os.path.join(d, "2026-09", "month.json")))
o = json.load(open(os.path.join(d, "2026-10", "month.json")))
u, dl, v, cv = m["ai_use"], m["delivery"], m["value"], m["coverage"]
ok = [w["week"] for w in m["intake"]["weeks"]] == ["2026-W36", "2026-W39"] and m["intake"]["submissions"] == 2 \
     and [w["week"] for w in o["intake"]["weeks"]] == ["2026-W40"] and o["intake"]["submissions"] == 1
ok = ok and u["tokens"] == 11000 and u["requests"] == 20 and abs(u["estimated_usd"] - 2.5) < 1e-9 \
     and [(r["repo"], r["tokens"], r["requests"], r["people"]) for r in u["by_repo"]] == [("alpha", 8000, 14, ["alice", "bob"]), ("workspace", 3000, 6, ["alice", "bob"])] \
     and all(set(r) == {"repo", "tokens", "requests", "people"} for r in u["by_repo"]) and "commits" not in dl \
     and [(r["human_id"], r["tokens"], r["requests"], r["weeks"], r["repos"]) for r in u["by_person"]] == [("alice", 5500, 10, 1, ["alpha", "workspace"]), ("bob", 5500, 10, 1, ["alpha", "workspace"])] \
     and sum(r["tokens"] for r in u["by_person"]) == u["tokens"] and "gitonly" not in json.dumps(u) \
     and [r["model"] for r in u["by_model"]] == ["claude-fable-5"] and [r["agent"] for r in u["by_agent"]] == ["claude"]
ok = ok and [x["evidence"] for x in dl["deliverables"]] == ["PR alpha#12"]
ok = ok and [r["id"] for r in v["new"]] == ["2026-09-bob-codex-quota"] and v["new"][0]["outcome"] == "faster reviews" \
     and [(r["id"], r["verdict"]) for r in v["reviewed"]] == [("2026-06-alice-tool", "stop")]
ok = ok and cv["submitted"] == ["alice", "bob"] and cv["cost_persons"] == 2 and cv["submitted_with_cost"] == 2 \
     and abs(cv["cost_covered_usd"] - 60) < 1e-9 and abs(cv["cost_share"] - 60 / 77.504) < 1e-6
h = open(os.path.join(d, "2026-09", "month-report.html"), encoding="utf-8").read()
md = open(os.path.join(d, "2026-09", "month-report.md"), encoding="utf-8").read()
ok = ok and md.count("覆盖: 2 人提交周报") == 1 and h.count("覆盖: 2 人提交周报") == 1 and "估算" not in h and "估算" not in md \
     and "PR alpha#12" in h and "停止 — not used" in md and "| alice | 5,500 | 10 | 待接入 | 待接入 | 待接入 |" in md \
     and "| alpha | 8,000 | 14 | 待接入 | 待接入 | 待接入 | alice, bob |" in md and "周报里的提交" not in md \
     and "http" not in h and "<script src" not in h
sys.exit(0 if ok else (print(json.dumps({k: m[k] for k in ("intake", "coverage", "ai_use", "delivery", "value")}, ensure_ascii=False)[:1200]) or 1))
PY
  python3 -c "import json,sys; m=json.load(open(sys.argv[1])); sys.exit(0 if m['intake']['submissions']==0 and m['coverage'] is None and m['ai_use'] is None and m['delivery'] is None and m['value'] is None else 1)" \
    "$mon/reports/months/2026-12/month.json" || { echo "month with no submissions must keep use / delivery / value 待接入"; fail=1; }
  # 14) views and sorting (#362): one self-contained page with a 按人 / 按仓库 / 成本 / 交付与价值 / 各月 / 详情
  #     menu and a section per view; one person table and one repo table (tokens next to commits); 各月 is its
  #     own view (not in the folded 详情) and lists every imported month (oldest first); only the repo table
  #     sorts (with numeric data-v); the person, team, month and detail tables carry no sort control (no
  #     ranking, #22 非目标); the page shows no 估算.
  "$tool" month --allocation "$fw/allocation_september_2026.xlsx" --reports-dir "$gm" --workspace-root "$tmp/gitws" >/dev/null 2>&1 \
    || { echo "month+git re-run for #362 failed"; fail=1; }
  python3 - "$vm/reports/months" "$gm/reports/months/2026-09" <<'PY' || { echo "month views / sorting (#362) wrong"; fail=1; }
import os, re, sys
vm, gm = sys.argv[1], sys.argv[2]
def segs(h):  # "<h2>title</h2>…" chunks, keyed by title
    return {x.split("</h2>", 1)[0]: x for x in h.split("<h2>")[1:]}
h10 = open(os.path.join(vm, "2026-10", "month-report.html"), encoding="utf-8").read()
md10 = open(os.path.join(vm, "2026-10", "month-report.md"), encoding="utf-8").read()
hg = open(os.path.join(gm, "month-report.html"), encoding="utf-8").read()
ok = all('<button type="button" data-view="%s">' % v in h10 for v in ("all", "person", "repo", "team", "value", "month", "detail")) \
     and all('<section data-view="%s">' % v in h10 for v in ("overview", "person", "repo", "team", "value", "month", "detail")) \
     and "show('all')" in h10 and all(">%s</div>" % c in h10 for c in ("成本", "AI 使用", "交付", "价值")) \
     and '<section data-view="month"><h2>各月(已导入,按月份排序)</h2>' in h10
months = re.findall(r"<tr><td>(\d{4}-\d{2})</td>", segs(h10)["各月(已导入,按月份排序)"])
ok = ok and months == ["2026-09", "2026-10"] and "| 2026-09 |" in md10 and "| 2026-10 |" in md10
for page in (h10, hg):
    sg = segs(page)
    ok = ok and "<details><summary>" in sg["详情"] and "各月" not in sg["详情"] and "估算" not in page
    for t in ("按人(名称排序)", "成本(按团队,名称排序)", "各月(已导入,按月份排序)", "详情"):
        ok = ok and 'class="sortable"' not in sg[t] and 'data-v="' not in sg[t]
ok = ok and '<table class="sortable">' in segs(hg)["按仓库"] and 'data-v="6"' in segs(hg)["按仓库"] \
     and '<table class="sortable">' in segs(h10)["按仓库"] and h10.count('class="sortable"') == 1 \
     and "<script src" not in h10 and "http" not in h10 and "section[data-view]" in h10
sys.exit(0 if ok else (print(list(segs(h10)), list(segs(hg)), months, h10.count('class="sortable"'),
                             re.findall(r'data-v="[^"]*"', segs(hg).get("按仓库", ""))[:8]) or 1))
PY

  # 15) starter roster (#362): a reports/team.json that still has the "<...>" placeholders of
  #     assets/reports-repo maps nobody — 按人 shows 待接入, not an empty table — and the 详情 label
  #     names only what 详情 holds (here only 校验).
  st="$tmp/starter"; mkdir -p "$st/reports"
  cp "$here/../assets/reports-repo/reports/team.json" "$st/reports/team.json"
  "$tool" month --allocation "$fw/allocation_september_2026.xlsx" --reports-dir "$st" --no-git >/dev/null 2>&1 \
    || { echo "month with the starter roster failed"; fail=1; }
  python3 - "$st/reports/months/2026-09" <<'PY' || { echo "month with the starter roster (#362) wrong"; fail=1; }
import json, os, sys
d = sys.argv[1]
m = json.load(open(os.path.join(d, "month.json")))
h = open(os.path.join(d, "month-report.html"), encoding="utf-8").read()
ok = m["people"] is None and "<summary>校验 — 点开</summary>" in h \
     and "待接入(本月没有周报;reports/team.json 没有 identities)" in h and "&lt;human_id&gt;" not in h
sys.exit(0 if ok else (print(m["people"], m.get("unmapped"), h.count("<summary>")) or 1))
PY
  rm -rf "$tmp"
else
  echo "MISSING scripts/ai-usage-weekly or its fixtures"; fail=1
fi

python3 "$here/test_cost_boundaries.py" "$root" || fail=1
python3 "$here/test_report_integrity.py" "$root" || fail=1

[ "$fail" = 0 ] && echo "OK: ai-usage-weekly smoke passed" || echo "FAIL"
exit $fail
