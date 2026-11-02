import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, test } from "bun:test"
import { strict as assert } from "node:assert"
import type { Context } from "hono"
import { today } from "./rows.ts"
import type { Row } from "./rows.ts"
import type { TrackerFile, TrackerStore } from "./store.ts"
import { CATEGORIES } from "./rows.ts"
import { handleOverview } from "../handlers/pick.ts"
import { setKnownRepos } from "./repos.ts"

beforeEach(() => { setKnownRepos(() => ["owner/repo"]) })
afterEach(() => { setKnownRepos(() => []) })

const row = (n: number, category: string, status: Row["status"], reason = ""): Row => ({
  id: n.toString(16).padStart(64, "0"), category, file: `app/${n}.php`, lines: [n], severity: "P1", status, reason, date: today(), pr: "",
})

class MemoryStore implements TrackerStore {
  files: TrackerFile[]
  writes = 0
  constructor(rows: Row[]) {
    this.files = [...new Set(rows.map(row => row.category))].map(category => ({
      category, rows: structuredClone(rows.filter(row => row.category === category)), log: [],
      url: `https://example.test/${category}.json`,
    }))
  }
  async read() { return structuredClone(this.files) }
  async write(file: TrackerFile, rows: Row[], message: string) {
    const next = { ...file, rows: structuredClone(rows),
      log: [...file.log, ...(message ? [{ at: "now", message }] : [])], sha: "sha" }
    this.files = [...this.files.filter(current => current.category !== file.category), next]
    this.writes++
    return structuredClone(next)
  }
}

test("overview counts rows by status for all bug types and normalizes legacy statuses and lists open PRs", async () => {
  const trackerStore = new MemoryStore([
    row(1, "sqli", "candidate"), row(2, "sqli", "candidate"), row(3, "sqli", "needs human", "Changes behavior"),
    row(4, "sqli", "fixed"), row(5, "cors", "in PR"),
  ])
  const before = await trackerStore.read()
  const client = {
    async suitePRs() { return [{ number: 7, title: "【P1·SQL 注入】接口参数化", draft: false, url: "https://github.com/a/b/pull/7" }] },
    async openPRFiles() { return [] }, async prState() { return "open" as const },
  }
  let payload: any
  const c = { json: (v: unknown) => { payload = v; return new Response() } } as unknown as Context
  // A running fix run picked row 5, so the row sync leaves it in progress.
  const runsRootDir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  await mkdir(join(runsRootDir, "run-1", "artifacts"), { recursive: true })
  await writeFile(join(runsRootDir, "run-1", "artifacts", "picked.json"), JSON.stringify([{ id: row(5, "cors", "in PR").id }]))
  const store = { listUnfinishedRuns: () => [{ runId: "run-1" }], stoppedRunIds: () => [] }
  try {
    await handleOverview(c, { store, runsRootDir, createTrackerStore: async () => trackerStore } as never, client)
  } finally { await rm(runsRootDir, { recursive: true }) }
  assert.equal(payload.types.length, CATEGORIES.length)
  const sqli = payload.types.find((t: { category: string }) => t.category === "sqli")
  assert.deepEqual(sqli.rows, trackerStore.files[0].rows.map(row => ({ ...row, status: row.status === "candidate" ? "open" : row.status })))
  assert.deepEqual(Object.keys(sqli.counts), ["open", "in progress", "fixed", "ignored", "needs human"])
  const empty = payload.types.find((t: { category: string }) => t.category === "weak-hash")
  assert.deepEqual([empty.url, empty.total], [null, 0])
  assert.deepEqual(empty.rows, [])
  assert.deepEqual(payload.needsHuman, [{ id: row(3, "sqli", "needs human").id, category: "sqli", url: trackerStore.files[0].url, file: "app/3.php", lines: [3], severity: "P1", reason: "Changes behavior" }])
  assert.equal(payload.openPRs[0].number, 7)
  assert.equal(trackerStore.writes, 0)
  assert.deepEqual(await trackerStore.read(), before)
  assert.deepEqual([sqli.url, sqli.total, sqli.counts.open, sqli.counts.ignored, sqli.counts.fixed], [trackerStore.files[0].url, 4, 2, 0, 1])
  assert.equal(payload.types.find((t: { category: string }) => t.category === "cors").counts["in progress"], 1)
})

test("Overview combines bug types and priorities across counts and PRs", async () => {
  const { overview } = await import("./overview.ts")
  const trackerStore = new MemoryStore([
    { ...row(1, "sqli", "needs human"), severity: "P0", pr: "[PR #7](https://github.com/a/b/pull/7)" },
    { ...row(2, "sqli", "in progress"), severity: "P1", pr: "[PR #8](https://github.com/a/b/pull/8)" },
  ])
  const client = {
    async openPRFiles() { return [] }, async prState() { return "open" as const },
    async suitePRs() { return [7, 8].map(number => ({ number, title: "Fixture", draft: false, url: `https://github.com/a/b/pull/${number}` })) },
  }
  const filtered = await overview(client, trackerStore, "a/b", { categories: ["sqli"], severities: ["P0"] })
  assert.equal(filtered.availableTypes.length, CATEGORIES.length)
  assert.equal(filtered.types.length, 1)
  assert.equal(filtered.types[0].total, 1)
  assert.equal(filtered.types[0].counts["needs human"], 1)
  assert.deepEqual(filtered.types[0].rows, [trackerStore.files[0].rows[0]])
  assert.equal(filtered.types[0].url, trackerStore.files[0].url)
  assert.deepEqual(filtered.needsHuman, [{ id: row(1, "sqli", "needs human").id, category: "sqli", url: trackerStore.files[0].url, file: "app/1.php", lines: [1], severity: "P0", reason: "" }])
  assert.deepEqual(filtered.openPRs.map(pr => pr.number), [7])
  const empty = await overview(client, trackerStore, "a/b", { severities: ["P2"] })
  assert.deepEqual([empty.types, empty.needsHuman, empty.openPRs], [[], [], []])
})

test("Overview groups imported PRs apart from tool PRs and passes only tool PRs to adoption evidence", async () => {
  const { overview } = await import("./overview.ts")
  const link = (n: number) => `[PR #${n}](https://github.com/a/b/pull/${n})`
  const trackerStore = new MemoryStore([
    { ...row(1, "sqli", "fixed"), pr: link(7) },
    { ...row(2, "sqli", "open"), pr: "" },
    { ...row(3, "sqli", "fixed"), id: "pr20:old.php", pr: link(20) },
  ])
  const pushedSha = "a".repeat(40)
  trackerStore.files[0].prs = { 7: { pushedSha }, 9: { rowIds: [row(2, "sqli", "open").id], closeReason: "bad fix" } }
  const detail = (number: number, state: "open" | "closed" | "merged", ref: string) => ({ number, title: `PR ${number}`, url: "", state, head: "", base: "", ref })
  const details = [detail(7, "merged", "security/sqli-app-12345678"), detail(9, "closed", "security/sqli-app-abcdef01"), detail(20, "merged", "feature/human"), detail(30, "open", "feature/other")]
  let evidenceFor: number[] = []
  const client = {
    async suitePRs() { return [] }, async impactPRs() { return details },
    async adoptionEvidence(prs: { number: number }[]) {
      evidenceFor = prs.map(pr => pr.number)
      return new Map([[7, { pushed: ["x"], merged: ["x"] }]])
    },
    async openPRFiles() { return [] }, async prState() { return "open" as const },
  }
  const result = await overview(client, trackerStore, "a/b", {}, "/tmp/ola-runs")
  assert.deepEqual(evidenceFor, [7, 9])
  const byNumber = Object.fromEntries(result.prs.map(pr => [pr.number, pr]))
  assert.deepEqual([byNumber[7].outcome, byNumber[7].imported], ["full", false])
  assert.deepEqual([byNumber[9].outcome, byNumber[9].rowIds], ["rejected", [row(2, "sqli", "open").id]])
  assert.deepEqual([byNumber[20].outcome, byNumber[20].imported, byNumber[20].rowIds], ["excluded", true, ["pr20:old.php"]])
  assert.equal(byNumber[30], undefined)
  assert.deepEqual([result.summary.prs, result.summary.imported.total, result.summary.outcomes.full, result.summary.outcomes.rejected], [2, 1, 1, 1])
})

test("Overview returns distinct IDs for misc store rows sharing a location and honors priority filters", async () => {
  const rows = [
    { ...row(1, "misc", "needs human", "Review protocol"), kind: "protocol-review" },
    { ...row(2, "misc", "needs human", "Review ownership"), kind: "owner-review", file: "app/1.php", lines: [1] },
    { ...row(3, "misc", "needs human", "Lower priority"), kind: "owner-review", severity: "P2" },
  ]
  const trackerStore = new MemoryStore(rows)
  const client = {
    async suitePRs() { return [] },
    async openPRFiles() { return [] }, async prState() { return "open" as const },
  }
  let payload: any
  const c = { req: { query: () => "owner/repo", queries: (key: string) => key === "severity" ? ["P1"] : [] },
    json: (value: unknown) => { payload = value; return new Response() } } as unknown as Context
  await handleOverview(c, { store: { listUnfinishedRuns: () => [], stoppedRunIds: () => [] }, runsRootDir: "unused", createTrackerStore: async () => trackerStore } as never, client)
  assert.deepEqual(payload.needsHuman.map((row: Row) => [row.id, row.file, row.lines, row.reason]),
    rows.slice(0, 2).map(row => [row.id, row.file, row.lines, row.reason]))
})

test("Overview rejects invalid filter values before reading GitHub", async () => {
  for (const [category, severity] of [["unknown", ""], ["", "P9"]]) {
    let status = 0
    const c = { req: { queries: (key: string) => key === "category" && category ? [category] : key === "severity" && severity ? [severity] : [] },
      json: (_: unknown, code = 200) => { status = code; return new Response() } } as unknown as Context
    await handleOverview(c, {} as never)
    assert.equal(status, 400)
  }
})

class CountingStore extends MemoryStore {
  reads = 0
  async read() { this.reads++; return super.read() }
}

test("a cold Overview request downloads the tracker files once, and once more after the refresh wrote", async () => {
  const noRuns = { listUnfinishedRuns: () => [], stoppedRunIds: () => [] }
  const client = { async suitePRs() { return [] }, async openPRFiles() { return [] }, async prState() { return "closed" as const } }
  const request = async (repo: string, trackerStore: CountingStore) => {
    setKnownRepos(() => [repo])
    let payload: any
    const c = { req: { query: () => repo, queries: () => [] }, json: (value: unknown) => { payload = value; return new Response() } } as unknown as Context
    await handleOverview(c, { store: noRuns, runsRootDir: "unused", createTrackerStore: async () => trackerStore } as never, client)
    return payload
  }

  const idle = new CountingStore([row(1, "sqli", "open")])
  await request("cold-idle/repo", idle)
  assert.equal(idle.reads, 1)
  // A request inside the 60 s refresh window skips the refresh and reads once.
  await request("cold-idle/repo", idle)
  assert.equal(idle.reads, 2)

  const stale = new CountingStore([{ ...row(2, "sqli", "in progress"), pr: "[PR #5](https://github.com/a/b/pull/5)" }])
  const payload = await request("cold-write/repo", stale)
  assert.equal(stale.writes, 1)
  assert.equal(payload.types.find((t: { category: string }) => t.category === "sqli").rows[0].status, "open")
  assert.equal(stale.reads, 2)
})

test("Overview reads the PR list once, alongside the tracker refresh", async () => {
  const events: string[] = []
  const trackerStore = new MemoryStore([row(1, "sqli", "open")])
  const read = trackerStore.read.bind(trackerStore)
  trackerStore.read = async () => { events.push("tracker"); return read() }
  const client = {
    async suitePRs() { return [] }, async openPRFiles() { return [] }, async prState() { return "open" as const },
    async impactPRs() { events.push("impact"); return [] },
  }
  setKnownRepos(() => ["parallel/repo"])
  const c = { req: { query: () => "parallel/repo", queries: () => [] }, json: () => new Response() } as unknown as Context
  await handleOverview(c, { store: { listUnfinishedRuns: () => [], stoppedRunIds: () => [] }, runsRootDir: "unused", createTrackerStore: async () => trackerStore } as never, client)
  assert.equal(events[0], "impact")
  assert.equal(events.filter(event => event === "impact").length, 1)
})
