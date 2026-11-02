import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readBaseSha, buildExportCommands } from "./exports.mjs";

test("readBaseSha returns sha from base.json", () => {
  const fake = () => JSON.stringify({ sha: "abc123", branch: "main" });
  assert.equal(readBaseSha("/art", fake), "abc123");
});

test("readBaseSha returns null when file unreadable", () => {
  const fake = () => { throw new Error("ENOENT"); };
  assert.equal(readBaseSha("/art", fake), null);
});

test("readBaseSha returns null when sha missing/empty", () => {
  assert.equal(readBaseSha("/art", () => JSON.stringify({ branch: "main" })), null);
  assert.equal(readBaseSha("/art", () => JSON.stringify({ sha: "" })), null);
});

test("buildExportCommands diffs/logs against base sha", () => {
  const { patchCmd, commitsCmd } = buildExportCommands("/repo", "/art", "base99");
  assert.deepEqual(patchCmd, { cmd: "git", args: ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "diff", "--no-ext-diff", "--no-textconv", "base99"], outFile: "/art/working.patch" });
  assert.deepEqual(commitsCmd, { cmd: "git", args: ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "log", "--no-ext-diff", "--no-textconv", "base99..HEAD", "--format=%H%n%s%n%b%n--END--"], outFile: "/art/commits.log" });
});

test("buildExportCommands falls back to HEAD when base sha null", () => {
  const { patchCmd, commitsCmd } = buildExportCommands("/repo", "/art", null);
  assert.deepEqual(patchCmd, { cmd: "git", args: ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "diff", "--no-ext-diff", "--no-textconv", "HEAD"], outFile: "/art/working.patch" });
  assert.deepEqual(commitsCmd, { cmd: "git", args: ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "log", "--no-ext-diff", "--no-textconv", "-n", "50", "--format=%H%n%s%n%b%n--END--"], outFile: "/art/commits.log" });
});

test("scan output defaults to P0/P1 and strips fix advice without changing priorities", async () => {
  const { scanOutput } = await import("./exports.mjs");
  const rows = ["P0", "P1", "P2"].map(severity => ({ severity, fix_summary: "Bind input", reason: "Evidence: input reaches sink\r\nFix: Bind input\r\nSeverity: model judgment" }));
  assert.deepEqual(scanOutput(rows).map(row => row.severity), ["P0", "P1"]);
  const included = scanOutput(rows, true);
  assert.deepEqual(included.map(row => row.severity), ["P0", "P1", "P2"]);
  assert.ok(included.every(row => row.fix_summary === "" && row.reason === "Evidence: input reaches sink\nSeverity: model judgment"));
  assert.equal(rows[0].fix_summary, "Bind input");
});

test("scan output preserves malformed rows alongside valid findings", async () => {
  const { scanOutput } = await import("./exports.mjs");
  const malformed = [null, false, 0, "bad row", []];
  const p1 = { severity: "P1", reason: "Evidence: reachable\nFix: Bind input", fix_summary: "Bind input" };
  const p2 = { severity: "P2", reason: "Evidence: low impact", fix_summary: "Bind input" };
  const rows = [...malformed, p1, p2];
  for (const includeP2 of [false, true]) {
    assert.deepEqual(scanOutput(rows, includeP2), [
      ...malformed,
      { ...p1, reason: "Evidence: reachable", fix_summary: "" },
      ...(includeP2 ? [{ ...p2, fix_summary: "" }] : []),
    ]);
  }
  assert.equal(p1.fix_summary, "Bind input");
});

test("scan skill requests evidence without fix advice and keeps fix-mode output", () => {
  const skill = readFileSync(new URL("../../skill/ola-security-audit/SKILL.md", import.meta.url), "utf8");
  const scan = skill.split("## 0.5 Scan mode")[1].split("## 0.6")[0];
  assert.match(scan, /`Verdict:`, `Evidence:`, `Severity:`/);
  assert.doesNotMatch(scan, /`Severity:` and `Fix:`/);
  const summary = skill.split("**scan 模式模板**")[1].split("**fix 模式模板**")[0];
  assert.doesNotMatch(summary, /修复建议|Fix:/);
  assert.match(skill, /`fix_summary` 写修复说明/);
});
