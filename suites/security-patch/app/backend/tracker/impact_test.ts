import { test, expect } from "bun:test"
import { classifyAdoption } from "./adoption.ts"
import { impactSummary, type SummaryPR } from "../../shared/impact.ts"
import { backfillImpact, commentReason } from "../cli/backfill_impact.ts"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { TrackerFile, TrackerStore } from "./store.ts"
import { scanCoverage } from "./coverage.ts"

const pushedSha = "a".repeat(40)
test("adoption classifies full, partial, dropped fixes, rejected, excluded, unknown and open", () => {
  const merged = { state: "merged" as const }
  expect(classifyAdoption(merged, { pushedSha }, { pushed: ["patch"], merged: ["patch"] })).toBe("full")
  expect(classifyAdoption(merged, { pushedSha }, { pushed: ["patch"], merged: ["patch", "edit"] })).toBe("partial")
  expect(classifyAdoption(merged, { pushedSha }, { pushed: ["patch", "other"], merged: ["patch"] })).toBe("partial")
  expect(classifyAdoption(merged)).toBe("unknown")
  expect(classifyAdoption(merged, { pushedSha })).toBe("unknown")
  expect(classifyAdoption({ state: "closed" })).toBe("rejected")
  expect(classifyAdoption({ state: "closed" }, { closeReason: "bad fix" })).toBe("rejected")
  for (const closeReason of ["test PR", "test pr", "superseded", "replaced by a newer PR", "Replaced by a newer pr"]) expect(classifyAdoption({ state: "closed" }, { closeReason })).toBe("excluded")
  expect(classifyAdoption({ state: "open" })).toBe("open")
  expect(commentReason(["Closed from the security-patch app. Reason: test PR."])).toBe("test PR")
})
const row = (id: string, status = "open", severity = "P1", pr = "", reason = "Finding") => ({ id, category: "sqli", status, severity, pr, reason })
const pr = (number: number, outcome: SummaryPR["outcome"], imported = false): SummaryPR => ({ number, title: "Fix", url: "", outcome, imported, rowIds: [], categories: ["sqli"] })
test("tiles and funnel share the tool population and exclude imported and ignored rows", () => {
  const summary = impactSummary([
    row("a", "open", "P0"), row("b", "needs human", "P0"), row("c", "in progress", "P0", "[PR #1](https://github.com/a/b/pull/1)"),
    row("d", "fixed", "P1", "[PR #2](https://github.com/a/b/pull/2)"), row("e", "ignored", "P1", "", "False positive"),
    row("f", "ignored", "P2", "", "Won't fix"), row("pr9:x.php", "fixed", "P0"), row("pr10:x.php", "in progress"), row("pr11:x.php"),
  ], [pr(1, "open"), pr(2, "full"), pr(3, "excluded"), pr(9, "excluded", true)])
  expect([summary.found, summary.inPR, summary.merged, summary.prs]).toEqual([4, 2, 1, 2])
  expect(summary.stages.map(stage => stage.total)).toEqual([4, 2, 2, 1])
  expect(summary.severity).toEqual({ P0: 3, P1: 1, P2: 0, "": 0 })
  expect(summary.p0).toEqual({ total: 3, rowIds: ["a", "b", "c"], open: 1, human: 1, inPR: 1 })
  expect(summary.imported).toEqual({ total: 3, fixed: 1, progress: 1, open: 1 })
  expect(summary.outcomes).toEqual({ full: 1, partial: 0, rejected: 0, unknown: 0, open: 1 })
})
test("a picked P0 row without a PR link counts as open and the parts add up", () => {
  const summary = impactSummary([row("a", "in progress", "P0"), row("b", "open", "P0"), row("c", "needs human", "P0"), row("d", "in progress", "P0", "[PR #1](https://github.com/a/b/pull/1)")], [pr(1, "open")])
  expect(summary.p0).toEqual({ total: 4, rowIds: ["a", "b", "c", "d"], open: 2, human: 1, inPR: 1 })
  expect(summary.p0.open + summary.p0.human + summary.p0.inPR).toBe(summary.p0.total)
})
test("backfill dry run reads commits and comments, defaults closes to Rejected and never writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "impact-backfill-"))
  await mkdir(join(dir, "12345678-run", "artifacts"), { recursive: true })
  await writeFile(join(dir, "12345678-run", "artifacts", "commits.log"), `${pushedSha}\nFix\n\n--END--\n`)
  let writes = 0
  const files: TrackerFile[] = [{ category: "sqli", rows: [], log: [], url: "" }]
  const store: TrackerStore = { async read() { return files }, async write(file) { writes++; return file } }
  const client = {
    async impactPRs() { return [1, 2, 3, 4].map(number => ({ number, title: "Fix", url: "", ref: `security/sqli-app-${number === 1 ? "12345678" : "abcdef01"}`, head: "", base: "", state: number === 1 || number === 4 ? "open" as const : "closed" as const })) },
    async listComments(number: number) { return number === 2 ? ["Closed from the security-patch app. Reason: superseded."] : [] },
  }
  try {
    const report = await backfillImpact(store, client, dir, true)
    expect(writes).toBe(0)
    expect(files[0].prs).toBeUndefined()
    expect(report.changes.map(change => change.record)).toEqual([{ pushedSha }, { closeReason: "replaced by a newer PR" }, { closeReason: "bad fix" }])
    expect(report.missing).toEqual(["PR #4: missing or ambiguous local commits.log"])
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test("coverage uses completed scans, profile applicability and unique files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "impact-coverage-"))
  await mkdir(join(dir, "scan", "artifacts"), { recursive: true })
  await writeFile(join(dir, "scan", "artifacts", "scan-coverage.json"), JSON.stringify({ coveredFiles: ["a.php"], consideredFiles: ["a.php", "b.php"], categories: ["sqli"] }))
  try {
    const result = scanCoverage("a/b", [{ runId: "scan", repoUrl: "https://github.com/a/b", status: "completed", mode: "scan", finishedAt: 100 } as never], dir, { language: "php", php: "8.2", framework: "laravel" }, null)
    expect(result.scanned).toEqual(["sqli"])
    expect(result.applicable).not.toContain("loose-compare")
    expect(result.applicable).not.toContain("mass-assignment")
    expect([result.coveredFiles, result.consideredFiles, result.lastScan]).toEqual([1, 2, 100])
  } finally { await rm(dir, { recursive: true, force: true }) }
})
