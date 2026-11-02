import { test } from "node:test";
import assert from "node:assert/strict";
import { doneIds, fixRoundDone, isQuotaError, mergeScanFindings, newProgress, parseProgress, parseScanCheckpoint, parseScanCoverage } from "./resume.mjs";
import { assignFindingIds } from "./finding-ids.mjs";


test("quota errors stop the run instead of failing it", () => {
  for (const m of ["429 Too Many Requests", "rate_limit_error", "Claude usage limit reached", "Your credit balance is too low", "Overloaded", "You've hit your session limit · resets 10am (UTC)", "RESOURCE_EXHAUSTED", "Resource has been exhausted (e.g. check quota)", "Your quota is exhausted", "You've run out of credits, the credits will be reset till your next cycle.", "Free limit reached for Qwen-Coder-Qoder Model today.", "You've reached your monthly Lite model limit.", "You've reached your daily usage limit for Chat."]) assert.equal(isQuotaError(m), true, m);
  for (const m of ["ENOENT", "SyntaxError: bad JSON", "exit code 1", "session expired", "session limiter failed", "session_limit column is missing"]) assert.equal(isQuotaError(m), false, m);
});

const candidate = { category: "sqli", severity: "P1", file: "src/query.php", line: 4, snippet: "query(input)",
  fix_summary: "", status: "candidate", reason: "unbound input", function: "queryUser", sink: "query(input)" };

test("scan merge uses computed IDs, keeps earlier findings, and retains identity inputs", () => {
  const other = { ...candidate, sink: "query(other)", line: 10 };
  const merged = mergeScanFindings([candidate, other], [{ ...candidate, id: "forged", reason: "updated", line: 5 }]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].reason, "updated");
  assert.equal(merged[0].id, undefined);
  assert.equal(merged[0].function, candidate.function);
  assert.equal(assignFindingIds(merged, "scan")[0].id, assignFindingIds([candidate], "scan")[0].id);
});

test("scan checkpoints and coverage reject malformed agent data", () => {
  const empty = { findings: [], coveredFiles: [] };
  assert.deepEqual(parseScanCheckpoint(undefined), empty);
  assert.deepEqual(parseScanCheckpoint({ scan: { findings: [candidate], coveredFiles: [candidate.file, candidate.file] } }),
    { findings: [candidate], coveredFiles: [candidate.file] });
  for (const row of [null, [], { ...candidate, status: "fixed" }, { ...candidate, line: 0 },
    { ...candidate, line: "4" }, { ...candidate, category: "unknown" }, { ...candidate, severity: "critical" },
    { ...candidate, file: "../outside.php" }, { ...candidate, function: {} }, { ...candidate, extra: "instruction" }]) {
    assert.deepEqual(parseScanCheckpoint({ scan: { findings: [row], coveredFiles: [candidate.file] } }), empty);
  }
  for (const paths of [null, {}, [1], [""], ["/root/key"], ["../key"], ["src/../key"], ["a\\b"], ["a\nb"], ["C:/key"]]) {
    assert.deepEqual(parseScanCoverage(paths), []);
  }
  assert.deepEqual(parseScanCoverage(["src/query.php", "src/query.php"]), ["src/query.php"]);
});

test("the checkpoint counts only findings with a final status", () => {
  assert.deepEqual(doneIds([{ id: "a", status: "fixed" }, { id: "b", status: "candidate" }, { id: "c", status: "false positive" }, { id: "d", status: "needs human" }, null, { status: "fixed" }]), ["a", "c", "d"]);
  assert.deepEqual(doneIds({}), []);
});

test("progress from a checkpoint is read strictly", () => {
  assert.deepEqual(parseProgress(undefined), newProgress());
  assert.deepEqual(parseProgress({ progress: { phase: "bogus", review: [{ round: 1, notes: 1 }] } }), newProgress());
  const p = parseProgress({ progress: { phase: "review", review: [{ round: 1, notes: 2, fixed: true }, { round: 3, notes: 1 }, { round: 2, notes: 0 }] } });
  assert.deepEqual(p.review, [{ round: 1, notesFile: "review-1.json", notes: 2, fixed: true }]);
  // Check progress counts only once the review finished, and never beyond the 2 check fix rounds.
  assert.equal(parseProgress({ progress: { phase: "review", checkFixRounds: 1 } }).checkFixRounds, 0);
  assert.equal(parseProgress({ progress: { phase: "checks", checkFixRounds: 9, checksPassed: true } }).checkFixRounds, 2);
  assert.equal(parseProgress({ progress: { phase: "checks", checkFixRounds: "1" } }).checkFixRounds, 0);
});

test("the fix round is skipped once it finished or every picked row is done", () => {
  assert.equal(fixRoundDone(newProgress(), [], ["a"]), false);
  assert.equal(fixRoundDone(newProgress(), ["a"], ["a", "b"]), false);
  assert.equal(fixRoundDone(newProgress(), ["a", "b", "c"], ["a", "b"]), true);
  assert.equal(fixRoundDone(newProgress(), [], []), false);
  assert.equal(fixRoundDone(parseProgress({ progress: { phase: "review" } }), [], ["a"]), true);
});

test("review rework revision survives resume and rejects non-revisions", () => {
  for (const reworkBase of ["a".repeat(40), "b".repeat(64), "HEAD; touch bad", "c".repeat(41), 3]) {
    const p = parseProgress({ progress: { phase: "review", review: [{ round: 1, notes: 1, fixed: true, reworkBase }] } });
    assert.equal(p.review[0].reworkBase, typeof reworkBase === "string" && [40, 64].includes(reworkBase.length) ? reworkBase : undefined);
  }
});
