#!/usr/bin/env sh
# regression-case:token-usage-analysis-smoke
# Guards the skill's contract: skill files and the collector exist, the privacy hard-rules
# survive in SKILL.md, frontmatter stays complete, and the collector run on planted fixtures
# (platform-internals/tests/token-usage/) aggregates correctly, anonymizes non-workspace
# projects, and refuses to green on empty sources.
# Usage: regression/smoke.sh <workspace-root>
set -e
root="${1:?usage: smoke.sh <workspace-root>}"
here="$(dirname "$0")"
fail=0

# 1) Required files
for p in "$here/../SKILL.md" "$here/../references/metrics-guide.md" \
         "$here/../references/tool-selection-adr.md"; do
  [ -f "$p" ] || { echo "MISSING skill file: $p"; fail=1; }
done
[ -x "$root/scripts/token-usage-report" ] || { echo "MISSING or non-executable scripts/token-usage-report"; fail=1; }

# 2) Hard-rule phrases still present
for s in "never contains prompts, file paths, or user identifiers" \
         "runs/token-usage/" "Never commit the report" \
         'aggregated anonymously as "other"' "--all-projects" \
         "cross-check" "# inferred" "#32" "zero-dependency" \
         "not a performance-evaluation input" "scripts/token-usage-report" \
         "--source auto" "fallback" "labels each section's source" \
         "Zero-manual" "never a person score" "token-usage-tasks" \
         "never auto-downloads" "correlatable set" "task_instance_id" \
         "--html --open" "never published as a web artifact" \
         "more than 30 minutes idle" "--instance" "legacy_annotations_v1" \
         "Codex-only behavior"; do
  grep -Fq -- "$s" "$here/../SKILL.md" || { echo "SKILL.md lost phrase: $s"; fail=1; }
done
grep -Fq -- "不得用于个人绩效评估" "$here/../references/metrics-guide.md" \
  || { echo "metrics-guide lost the no-performance-review red line"; fail=1; }

# 3) Frontmatter completeness (12 fields)
[ "$(head -n1 "$here/../SKILL.md")" = "---" ] || { echo "SKILL.md missing frontmatter"; fail=1; }
for k in name description id type owner version status summary use_when usage dependencies regression; do
  grep -q "^$k:" "$here/../SKILL.md" || { echo "SKILL.md frontmatter lost: $k"; fail=1; }
done

# 4) Behavioral: the collector must aggregate the planted fixtures correctly.
#    Pinned: recursion into <session>/subagents/, keep-max streaming dedup, bucket
#    attribution, anonymization, ccusage adapter (label / reconciliation / fallback).
chk="$root/scripts/token-usage-report"
fx="$root/platform-internals/tests/token-usage"
if [ -x "$chk" ] && [ -d "$fx" ]; then
  tmp=$(mktemp -d)
  cp -R "$fx/claude-projects" "$tmp/claude"
  cp -R "$fx/codex-sessions" "$tmp/codex"
  cp -R "$fx/qoder-projects" "$tmp/qoder"
  mkdir -p "$tmp/out" "$tmp/empty"
  if "$chk" --since 2026-08-01 --until 2026-08-31 --workspace-root /fake/ws --source native \
       --claude-dir "$tmp/claude" --codex-dir "$tmp/codex" --qoder-dir "$tmp/qoder" --out "$tmp/out" --json >/dev/null; then
    python3 - "$tmp/out" <<'EOF' || fail=1
import json, os, sys
out = sys.argv[1]
base = "usage-report-2026-08-01-2026-08-31"
data = json.load(open(os.path.join(out, base + ".json")))
c, x = data["claude"], data["codex"]
def check(cond, msg):
    if not cond:
        print("fixture assertion failed: " + msg)
        sys.exit(1)
check(c["totals"]["input"] == 400, "claude input wrong (subagents/ recursion broken?)")
check(c["totals"]["output"] == 200, "claude output wrong (keep-max streaming dedup broken?)")
check(set(c["by_bucket"]) == {"workspace", "alpha", "other"}, "claude buckets wrong")
check(c["sidechain"].get("messages") == 2, "sidechain count wrong (subagent transcript missed?)")
check(x["totals"]["output"] == 200 and x["totals"]["sessions"] == 1,
      "codex totals wrong (event-counter increments must preserve full-window totals)")
check("alpha" in x["by_bucket"], "codex bucket attribution wrong")
# Qoder: credits only. One copy per message id (only the last copy has usage); bad credits / times and
# out-of-window rows are skipped, never a crash; credits never become tokens.
q = data["qoder"]
check(q["totals"]["messages"] == 2 and abs(q["totals"]["credits"] - 0.75) < 1e-9,
      "qoder totals wrong (dedup by message id, skip bad credits/timestamps): %r" % q["totals"])
check(set(q["by_bucket"]) == {"alpha", "workspace"} and abs(q["by_bucket"]["alpha"]["credits"] - 0.5) < 1e-9
      and q["sessions"] == 2, "qoder buckets / sessions wrong (a message copied into a resumed session counts once): %r" % q)
check(sorted(q["by_day"]) == ["2026-08-10", "2026-08-12"], "qoder by_day wrong: %r" % q["by_day"])
check(data["meta"]["qoder_files"] == 2 and c["totals"]["input"] == 400, "qoder must not touch claude tokens")
blob = open(os.path.join(out, base + ".json")).read()
blob += open(os.path.join(out, base + ".md")).read()
check("secret-project" not in blob and "/fake/elsewhere" not in blob,
      "non-workspace project leaked into the report")
check("q-sess-1" not in blob and "q-msg-1" not in blob and "secret prompt" not in blob and "/fake/ws" not in blob,
      "qoder session id / message id / prompt / path leaked into the report")
check("## Qoder" in blob and "0.75" in blob, "markdown lacks the Qoder credits section")
# day x bucket x model cells (additive; consumed by ai-usage-weekly for exact cost attribution)
cells = c.get("cells") or []
check(sum(r["input"] for r in cells) == c["totals"]["input"]
      and sum(r["cache_read"] for r in cells) == c["totals"]["cache_read"],
      "claude.cells do not roll up to totals")
check(any(r["day"] == "2026-08-10" and r["bucket"] == "alpha" and r["model"] == "claude-sonnet-5"
          and r["cache_read"] == 1000 for r in cells),
      "claude.cells missing the alpha/sonnet cell")
EOF
  else
    echo "collector failed on the good fixture"; fail=1
  fi
  # Qoder only (no Claude / Codex data): a report, not the "no local session data" exit 2
  if ! "$chk" --since 2026-08-01 --until 2026-08-31 --workspace-root /fake/ws --source native \
       --claude-dir "$tmp/empty" --codex-dir "$tmp/empty" --qoder-dir "$tmp/qoder" --out "$tmp/out-qoder-only" >/dev/null; then
    echo "a Qoder-only window must still produce a report"; fail=1
  fi
  # workspace_repo_ids: workspace.yaml's repositories: is a frozen [] on main; the real mount
  # list lives in the gitignored workspace.local.yaml sidecar (scripts/setup-repos). Both are read.
  mkdir -p "$tmp/wsroot"
  printf 'owner: x\nteam: t\nrepositories: []\n' > "$tmp/wsroot/workspace.yaml"
  printf 'repositories:\n  - id: alpha\n    path: repos/alpha\n  - id: beta\n    path: repos/beta\n' \
    > "$tmp/wsroot/workspace.local.yaml"
  python3 - "$chk" "$tmp/wsroot" <<'EOF' || { echo "workspace_repo_ids ignores workspace.local.yaml"; fail=1; }
import importlib.util, sys
from importlib.machinery import SourceFileLoader
loader = SourceFileLoader("tur", sys.argv[1])
m = importlib.util.module_from_spec(importlib.util.spec_from_loader("tur", loader))
loader.exec_module(m)
sys.exit(0 if m.workspace_repo_ids(sys.argv[2]) == ["alpha", "beta"] else 1)
EOF
  # ccusage adapter: injected good JSON -> external base usage + passing reconciliation
  if "$chk" --since 2026-08-01 --until 2026-08-31 --workspace-root /fake/ws \
       --claude-dir "$tmp/claude" --codex-dir "$tmp/codex" --qoder-dir "$tmp/empty" --out "$tmp/out2" \
       --ccusage-json "$fx/ccusage-json/daily.json" >/dev/null; then
    md="$tmp/out2/usage-report-2026-08-01-2026-08-31.md"
    grep -q "基础用量来源:ccusage" "$md" || { echo "hybrid report lost the ccusage source label"; fail=1; }
    grep -q "对账通过" "$md" || { echo "reconciliation did not pass on the good ccusage fixture"; fail=1; }
    grep -q "成本(USD)" "$md" || { echo "hybrid report lost the cost column"; fail=1; }
    grep -q "可关联集 claude+codex" "$md" || { echo "base usage lost the correlatable-set label"; fail=1; }
    grep -q "未归属用量" "$md" && grep -q "gemini" "$md" \
      || { echo "unattributed-CLI appendix missing (gemini fixture)"; fail=1; }
    grep -q "| 2026-08-10 | 1,010 | 405 | 1,410 | 1.63 |" "$md" \
      || { echo "correlatable daily trend leaked non-correlatable agents"; fail=1; }
  else
    echo "collector failed with the good ccusage fixture"; fail=1
  fi
  # A missing Claude source must not hide external Codex base usage. Sections ①/③ remain
  # usable; message-granularity-only sections ②/④ stay visible and state their limitation.
  if "$chk" --since 2026-08-01 --until 2026-08-31 --workspace-root /fake/ws \
       --claude-dir "$tmp/empty" --codex-dir "$tmp/codex" --qoder-dir "$tmp/empty" --out "$tmp/out-codex-only" \
       --ccusage-json "$fx/ccusage-json/daily-codex-only.json" >/dev/null; then
    md="$tmp/out-codex-only/usage-report-2026-08-01-2026-08-31.md"
    grep -q "## ① 消耗速度" "$md" \
      && grep -q "| 2026-08-10 | 600 | 200 | 400 | 0.40 |" "$md" \
      || { echo "Codex-only report lost the external burn-rate trend"; fail=1; }
    grep -q "## ③ 模型选用" "$md" && grep -q "gpt-fake" "$md" \
      || { echo "Codex-only report lost the external model mix"; fail=1; }
    grep -q "## ② 任务热点" "$md" && grep -q "## ④ 使用模式" "$md" \
      && grep -q "## ⑤ Git 关联" "$md" && [ "$(grep -c "本节不可用" "$md")" -ge 3 ] \
      || { echo "Codex-only report did not preserve unavailable attribution sections"; fail=1; }
  else
    echo "collector failed on the valid Codex-only fixture"; fail=1
  fi
  # An external document with dates but no claude/codex agent is not a valid base source.
  if "$chk" --since 2026-08-01 --until 2026-08-31 --workspace-root /fake/ws \
       --source ccusage --claude-dir "$tmp/claude" --codex-dir "$tmp/codex" --qoder-dir "$tmp/empty" \
       --out "$tmp/out-no-correlatable" \
       --ccusage-json "$fx/ccusage-json/daily-no-correlatable.json" >/dev/null 2>&1; then
    echo "ccusage accepted JSON with no correlatable agent data"; fail=1
  fi
  # A structurally recognizable document with invalid numeric fields must fail with a
  # schema reason, never leak a Python traceback or silently coerce arbitrary text.
  if "$chk" --since 2026-08-01 --until 2026-08-31 --workspace-root /fake/ws \
       --source ccusage --claude-dir "$tmp/claude" --codex-dir "$tmp/codex" --qoder-dir "$tmp/empty" \
       --out "$tmp/out-invalid-schema" \
       --ccusage-json "$fx/ccusage-json/daily-invalid-schema.json" \
       >"$tmp/invalid-schema.log" 2>&1; then
    echo "ccusage accepted an invalid numeric schema"; fail=1
  else
    grep -q "ccusage JSON schema invalid" "$tmp/invalid-schema.log" \
      || { echo "invalid ccusage schema lost its concrete reason"; fail=1; }
    grep -q "Traceback" "$tmp/invalid-schema.log" \
      && { echo "invalid ccusage schema leaked a traceback"; fail=1; }
  fi
  # Valid external usage is sufficient for base sections even when neither native parser
  # has records; attribution-only sections must stay explicit about being unavailable.
  if "$chk" --since 2026-08-01 --until 2026-08-31 --workspace-root /fake/ws \
       --source ccusage --claude-dir "$tmp/empty" --codex-dir "$tmp/does-not-exist" --qoder-dir "$tmp/empty" \
       --out "$tmp/out-external-only" \
       --ccusage-json "$fx/ccusage-json/daily-codex-only.json" >/dev/null; then
    md="$tmp/out-external-only/usage-report-2026-08-01-2026-08-31.md"
    grep -q "基础用量来源:ccusage" "$md" && grep -q "gpt-fake" "$md" \
      && grep -q "缺少可重叠的原生数据" "$md" \
      && [ "$(grep -c "本节不可用" "$md")" -ge 3 ] \
      || { echo "external-only report lost usable base or unavailable-section labels"; fail=1; }
  else
    echo "collector rejected valid external-only usage"; fail=1
  fi
  # Runtime failures must state the failing operation, not merely the detected version.
  mkdir -p "$tmp/fake-bin"
  printf '%s\n' '#!/bin/sh' \
    'if [ "$1" = "--version" ]; then echo "20.0.0"; exit 0; fi' \
    'exit 7' > "$tmp/fake-bin/ccusage"
  chmod +x "$tmp/fake-bin/ccusage"
  if env PATH="$tmp/fake-bin:/usr/bin:/bin" "$chk" --since 2026-08-01 --until 2026-08-31 \
       --workspace-root /fake/ws --source ccusage --claude-dir "$tmp/claude" \
       --codex-dir "$tmp/codex" --qoder-dir "$tmp/empty" --out "$tmp/out-runtime-failure" \
       >"$tmp/runtime-failure.log" 2>&1; then
    echo "ccusage runtime failure unexpectedly succeeded"; fail=1
  else
    grep -q "ccusage daily 退出码 7" "$tmp/runtime-failure.log" \
      || { echo "ccusage runtime failure lost its actual reason"; fail=1; }
  fi
  # Supply-chain: auto must NEVER auto-download ccusage — with a PATH that has no ccusage,
  # auto falls back to native (labeled), and --source ccusage fails loudly instead.
  if env PATH=/usr/bin:/bin "$chk" --since 2026-08-01 --until 2026-08-31 --workspace-root /fake/ws \
       --claude-dir "$tmp/claude" --codex-dir "$tmp/codex" --qoder-dir "$tmp/empty" --out "$tmp/out5" >/dev/null 2>&1; then
    grep -q "native(fallback)" "$tmp/out5/usage-report-2026-08-01-2026-08-31.md" \
      || { echo "auto without ccusage did not fall back to native"; fail=1; }
  else
    echo "auto without ccusage failed instead of falling back"; fail=1
  fi
  if env PATH=/usr/bin:/bin "$chk" --since 2026-08-01 --until 2026-08-31 --workspace-root /fake/ws \
       --source ccusage --claude-dir "$tmp/claude" --codex-dir "$tmp/codex" --qoder-dir "$tmp/empty" --out "$tmp/out6" >/dev/null 2>&1; then
    echo "--source ccusage silently succeeded without the tool (must fail loudly)"; fail=1
  fi
  # divergent external totals -> the >5% data-quality flag must appear
  "$chk" --since 2026-08-01 --until 2026-08-31 --workspace-root /fake/ws \
       --claude-dir "$tmp/claude" --codex-dir "$tmp/codex" --qoder-dir "$tmp/empty" --out "$tmp/out3" \
       --ccusage-json "$fx/ccusage-json/daily-divergent.json" >/dev/null \
    && grep -q "差值超过 5%" "$tmp/out3/usage-report-2026-08-01-2026-08-31.md" \
    || { echo "divergent ccusage fixture did not raise the >5% flag"; fail=1; }
  # corrupt external JSON -> automatic native fallback, labeled
  echo "not json" > "$tmp/corrupt.json"
  "$chk" --since 2026-08-01 --until 2026-08-31 --workspace-root /fake/ws \
       --claude-dir "$tmp/claude" --codex-dir "$tmp/codex" --qoder-dir "$tmp/empty" --out "$tmp/out4" \
       --ccusage-json "$tmp/corrupt.json" >/dev/null \
    && grep -q "native(fallback)" "$tmp/out4/usage-report-2026-08-01-2026-08-31.md" \
    || { echo "corrupt ccusage JSON did not fall back to native"; fail=1; }
  if "$chk" --claude-dir "$tmp/empty" --codex-dir "$tmp/does-not-exist" --qoder-dir "$tmp/empty" \
       --workspace-root /fake/ws --out "$tmp/out" >/dev/null 2>&1; then
    echo "collector greened on empty sources (vacuous-green)"; fail=1
  fi
  # Task-instance view (#32 S2.1): zero-annotation run works, attribution + behavior correct,
  # anonymization holds, and an annotation round-trip raises the row to 标注 confidence.
  tk="$root/scripts/token-usage-tasks"
  if [ -x "$tk" ]; then
    if "$tk" report --since 2026-08-01 --until 2026-08-31 --workspace-root /fake/ws \
         --db "$tmp/ann.sqlite" --claude-dir "$tmp/claude" --out "$tmp/tasks" --json --html >/dev/null; then
      tmd="$tmp/tasks/tasks-2026-08-01-2026-08-31.md"
      grep -q "alpha@feat/x" "$tmd" || { echo "task view lost the alpha@feat/x row"; fail=1; }
      grep -q "2/1/1/0" "$tmd" || { echo "task behavior profile (读/改/跑/代理) wrong"; fail=1; }
      grep -q "✚test" "$tmd" || { echo "task test signal missing"; fail=1; }
      grep -q "secret-project" "$tmd" && { echo "task view leaked a non-workspace project"; fail=1; }
      grep -q "不是评价" "$tmd" || { echo "task view lost the not-a-review disclaimer"; fail=1; }
      grep "^| other |" "$tmd" | grep -q "聚合,无序列" \
        || { echo "anonymous aggregate row still renders a stage sequence"; fail=1; }
      thtml="$tmp/tasks/tasks-2026-08-01-2026-08-31.html"
      [ -f "$thtml" ] && grep -q "<table>" "$thtml" && ! grep -q "secret-project" "$thtml" \
        || { echo "task view --html missing, malformed, or leaking"; fail=1; }
      iid=$(python3 - "$tmp/tasks/tasks-2026-08-01-2026-08-31.json" <<'EOF'
import json, sys
rows = json.load(open(sys.argv[1]))["tasks"]
print(next(r["task_instance_id"] for r in rows if r["bucket"] == "alpha"))
EOF
      )
      "$tk" annotate --workspace-root /fake/ws --db "$tmp/ann.sqlite" --instance "$iid" \
           --result success --ref "#0" >/dev/null || { echo "annotate failed"; fail=1; }
      "$tk" report --since 2026-08-01 --until 2026-08-31 --workspace-root /fake/ws \
           --db "$tmp/ann.sqlite" --claude-dir "$tmp/claude" --out "$tmp/tasks" >/dev/null
      grep -q "success (#0)" "$tmd" || { echo "annotation did not surface in the task view"; fail=1; }
      grep -q "标注" "$tmd" || { echo "annotated row did not gain 标注 confidence"; fail=1; }
    else
      echo "task view failed on the good fixture"; fail=1
    fi
  else
    echo "MISSING scripts/token-usage-tasks"; fail=1
  fi
  # S2.1 task instances: session boundaries and >30m idle gaps split one branch into
  # distinct rows. IDs are stable and anonymous; stage order and token allocation are
  # derived from the real message/tool sequence.
  if "$tk" report --since 2026-08-01 --until 2026-08-31 --workspace-root /fake/ws \
       --db "$tmp/instances.sqlite" --claude-dir "$fx/claude-task-instances" \
       --out "$tmp/instances" --json >/dev/null; then
    python3 - "$tmp/instances/tasks-2026-08-01-2026-08-31.json" <<'EOF' || fail=1
import json, sys
data = json.load(open(sys.argv[1]))
rows = [r for r in data["tasks"] if r["bucket"] == "alpha"]
def check(cond, msg):
    if not cond:
        print("task-instance assertion failed: " + msg)
        raise SystemExit(1)
check(len(rows) == 3, "same branch was not split by session + idle gap")
ids = [r["task_instance_id"] for r in rows]
check(len(set(ids)) == 3, "instance IDs are not unique")
check(not any("s-split" in i or "s-parallel" in i for i in ids),
      "raw session identifier leaked into task_instance_id")
first = next(r for r in rows if r["stage_sequence"] == ["explore", "edit", "test"])
check(first["stage_sequence"] == ["explore", "edit", "test"], "stage sequence wrong")
check(first["stage_tokens"] == {"explore": 20, "edit": 40, "test": 60},
      "per-stage token allocation wrong")
EOF
    "$tk" report --since 2026-08-01 --until 2026-08-31 --workspace-root /fake/ws \
         --db "$tmp/instances.sqlite" --claude-dir "$fx/claude-task-instances" \
         --out "$tmp/instances-rerun" --json >/dev/null
    python3 - "$tmp/instances/tasks-2026-08-01-2026-08-31.json" \
      "$tmp/instances-rerun/tasks-2026-08-01-2026-08-31.json" <<'EOF' || fail=1
import json, sys
def ids(path):
    return sorted(r["task_instance_id"] for r in json.load(open(path))["tasks"])
if ids(sys.argv[1]) != ids(sys.argv[2]):
    print("task-instance assertion failed: IDs changed across identical reruns")
    raise SystemExit(1)
EOF
    iid1=$(python3 - "$tmp/instances/tasks-2026-08-01-2026-08-31.json" <<'EOF'
import json, sys
rows = sorted(json.load(open(sys.argv[1]))["tasks"], key=lambda r: r["first"])
print(rows[0]["task_instance_id"])
EOF
    )
    iid2=$(python3 - "$tmp/instances/tasks-2026-08-01-2026-08-31.json" <<'EOF'
import json, sys
rows = sorted(json.load(open(sys.argv[1]))["tasks"], key=lambda r: r["first"])
print(rows[1]["task_instance_id"])
EOF
    )
    "$tk" annotate --workspace-root /fake/ws --db "$tmp/instances.sqlite" \
         --instance "$iid1" --instance "$iid2" --result success --ref "#127" \
         --type implementation --first-pass yes >/dev/null \
      || { echo "multi-instance annotation failed"; fail=1; }
    "$tk" report --since 2026-08-01 --until 2026-08-31 --workspace-root /fake/ws \
         --db "$tmp/instances.sqlite" --claude-dir "$fx/claude-task-instances" \
         --out "$tmp/instances-merged" --json >/dev/null
    python3 - "$tmp/instances-merged/tasks-2026-08-01-2026-08-31.json" \
      "$tmp/instances.sqlite" "$iid1" "$iid2" <<'EOF' || fail=1
import json, sqlite3, sys
data = json.load(open(sys.argv[1]))
rows = data["tasks"]
def check(cond, msg):
    if not cond:
        print("annotation-v2 assertion failed: " + msg)
        raise SystemExit(1)
check(len(rows) == 2, "same issue ref did not merge two instances into one task")
merged = next((r for r in rows if r.get("task_id") == "#127"), None)
check(merged is not None, "merged task has no issue-ref task_id")
check(set(merged["task_instance_ids"]) == {sys.argv[3], sys.argv[4]},
      "merged task lost its source instances")
check(merged["tokens"] == 220, "merged task token total is wrong")
con = sqlite3.connect(sys.argv[2])
cols = {r[1] for r in con.execute("PRAGMA table_info(annotations)")}
check("task_instance_id" in cols and "task_key" not in cols and "note" not in cols,
      "annotation schema is not structured v2")
for iid in (sys.argv[3], sys.argv[4]):
    row = con.execute("SELECT window_start, window_end FROM annotations WHERE task_instance_id=?",
                      (iid,)).fetchone()
    check(row is not None and all(row), "annotation is not bound to its instance window")
con.close()
EOF
    if "$tk" annotate --workspace-root /fake/ws --db "$tmp/instances.sqlite" \
         --instance "$iid1" --result success --note "free text is forbidden" \
         >"$tmp/note.log" 2>&1; then
      echo "annotation v2 still accepted a free-form note"; fail=1
    else
      grep -q "unrecognized arguments: --note" "$tmp/note.log" \
        || { echo "free-form note was rejected for the wrong reason"; fail=1; }
    fi
    if "$tk" annotate --workspace-root /fake/ws --db "$tmp/instances.sqlite" \
         --instance "$iid1" --result success --ref "/private/sensitive/path" \
         >"$tmp/ref.log" 2>&1; then
      echo "annotation accepted a path-shaped issue ref"; fail=1
    else
      grep -q "issue ref must match #<digits>" "$tmp/ref.log" \
        || { echo "unsafe issue ref was rejected for the wrong reason"; fail=1; }
    fi
  else
    echo "task-instance report failed on the split fixture"; fail=1
  fi
  # Existing v1 cluster annotations are preserved but quarantined: they cannot be mapped
  # safely to one of several new instances and therefore must never auto-attach.
  python3 - "$tmp/legacy.sqlite" <<'EOF'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute("""CREATE TABLE annotations (
    task_key TEXT PRIMARY KEY,
    ref TEXT, task_type TEXT, result TEXT, first_pass TEXT, note TEXT,
    updated_at TEXT NOT NULL)""")
con.execute("INSERT INTO annotations VALUES (?,?,?,?,?,?,?)",
            ("alpha@feat/x", "#old", "implementation", "success", "yes",
             "legacy free text", "2026-08-01T00:00:00+00:00"))
con.commit(); con.close()
EOF
  "$tk" report --since 2026-08-01 --until 2026-08-31 --workspace-root /fake/ws \
       --db "$tmp/legacy.sqlite" --claude-dir "$fx/claude-task-instances" \
       --out "$tmp/legacy" --json >/dev/null || { echo "legacy annotation migration failed"; fail=1; }
  python3 - "$tmp/legacy.sqlite" "$tmp/legacy/tasks-2026-08-01-2026-08-31.json" \
    "$tmp/legacy/tasks-2026-08-01-2026-08-31.md" <<'EOF' || fail=1
import json, sqlite3, sys
con = sqlite3.connect(sys.argv[1])
tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
if "legacy_annotations_v1" not in tables:
    print("migration assertion failed: v1 annotations were not preserved")
    raise SystemExit(1)
row = con.execute("SELECT task_key, ref, note FROM legacy_annotations_v1").fetchone()
if row != ("alpha@feat/x", "#old", "legacy free text"):
    print("migration assertion failed: preserved v1 row changed")
    raise SystemExit(1)
con.close()
data = json.load(open(sys.argv[2]))
if data["meta"].get("legacy_annotations") != 1:
    print("migration assertion failed: report did not surface reassignment count")
    raise SystemExit(1)
blob = open(sys.argv[2]).read() + open(sys.argv[3]).read()
if "legacy free text" in blob or any(r.get("outcome") for r in data["tasks"]):
    print("migration assertion failed: legacy cluster label auto-attached or leaked")
    raise SystemExit(1)
EOF
  # Relative DB overrides must work outside the workspace, and an existing source with no
  # records in the requested window must fail rather than emit a vacuous zero-row report.
  tk_abs=$(cd "$(dirname "$tk")" && pwd)/$(basename "$tk")
  fx_abs=$(cd "$fx" && pwd)
  (cd "$tmp" && "$tk_abs" report --since 2026-08-01 --until 2026-08-31 \
       --workspace-root /fake/ws --db relative.sqlite \
       --claude-dir "$fx_abs/claude-task-instances" --out "$tmp/relative" >/dev/null) \
    || { echo "relative annotation DB path failed"; fail=1; }
  if "$tk" report --since 2030-01-01 --until 2030-01-31 --workspace-root /fake/ws \
       --db "$tmp/empty-window.sqlite" --claude-dir "$fx/claude-task-instances" \
       --out "$tmp/empty-window" >/dev/null 2>&1; then
    echo "task-instance report greened with no records in the requested window"; fail=1
  fi
  rm -rf "$tmp"
else
  echo "MISSING scripts/token-usage-report or its fixtures"; fail=1
fi

# 5) Discovery links resolve for both runtimes
for p in ".claude/skills/token-usage-analysis/SKILL.md" ".agents/skills/token-usage-analysis/SKILL.md"; do
  [ -f "$root/$p" ] || { echo "MISSING discovery link: $p"; fail=1; }
done

# 6) Portability: the skill is written against the workspace *template*, never one team's
# instance — no mounted-repo id from the target workspace may be hard-coded in skill files.
ids=$(sed -n 's/^[[:space:]]*- id:[[:space:]]*//p' "$root/workspace.yaml")
for id in $ids; do
  if grep -rqw --exclude-dir=.git -- "$id" "$here/.."; then
    echo "team-specific repo id leaked into skill files: $id"; fail=1
  fi
done

python3 "$here/test_codex_windows.py" "$root" || fail=1

[ "$fail" = 0 ] && echo "OK: token-usage-analysis smoke passed" || echo "FAIL"
exit $fail
