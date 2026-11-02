import { test } from "bun:test"
import { strict as assert } from "node:assert"
import { commitEntries, eventRows, patchFiles } from "../src/components/DiagnosticReader"

test("eventRows keeps readable steps and hides thinking-token counters", () => {
  const frames = [
    { ts: 1000, kind: "round_started", round: 1, prompt: "scan the repo" },
    { ts: 2000, kind: "sdk_message", message: { type: "system", subtype: "init", model: "claude-opus-5-5", claude_code_version: "3.1.0" } },
    { ts: 2500, kind: "sdk_message", message: { type: "system", subtype: "thinking_tokens", estimated_tokens: 9 } },
    { ts: 3000, kind: "sdk_message", message: { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "app/a.php" } }] } } },
    { ts: 4000, kind: "sdk_message", message: { type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text: "line 1\nline 2" }] }] } } },
    { ts: 65000, kind: "sdk_message", message: { type: "result", subtype: "success", num_turns: 74 } },
  ]
  const { rows, hidden } = eventRows(frames.map(f => JSON.stringify(f)).join("\n") + "\nnot json\n")
  assert.equal(hidden, 1)
  assert.deepEqual(rows.map(r => [r.at, r.label, r.text]), [
    ["+0:00", "round_started", "round: 1"],
    ["+0:01", "system · init", "claude-opus-5-5 · Claude Code 3.1.0"],
    ["+0:02", "tool · Read", "app/a.php"],
    ["+0:03", "result", "line 1"],
    ["+1:04", "result · success", "74 turns"],
  ])
  assert.equal(rows[0].detail, "scan the repo")
  assert.equal(rows[3].detail, "line 1\nline 2")
})

test("patchFiles splits a git diff per file and counts changed lines", () => {
  const patch = [
    "diff --git a/app/a.php b/app/a.php", "index 1..2 100644", "--- a/app/a.php", "+++ b/app/a.php",
    "@@ -1,2 +1,2 @@", " keep", "-old", "+new", "+more",
    "diff --git a/gone.txt b/gone.txt", "deleted file mode 100644", "--- a/gone.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye",
    "diff --git a/logo.png b/logo.png", "Binary files a/logo.png and b/logo.png differ", "",
  ].join("\n")
  assert.deepEqual(patchFiles(patch), [
    { name: "app/a.php", additions: 2, deletions: 1, diff: "@@ -1,2 +1,2 @@\n keep\n-old\n+new\n+more" },
    { name: "gone.txt", additions: 0, deletions: 1, diff: "@@ -1 +0,0 @@\n-bye" },
    { name: "logo.png", additions: 0, deletions: 0, diff: "Binary files a/logo.png and b/logo.png differ" },
  ])
  assert.deepEqual(patchFiles(""), [])
})

test("commitEntries reads the --END-- separated commit log", () => {
  const sha = (c: string) => c.repeat(40)
  const log = `${sha("a")}\nfix: one\nline 1\n\nline 2\n\n--END--\n${sha("b")}\ntest: two\n\n--END--\n`
  assert.deepEqual(commitEntries(log), [
    { sha: sha("a"), subject: "fix: one", body: "line 1\n\nline 2" },
    { sha: sha("b"), subject: "test: two", body: "" },
  ])
})
