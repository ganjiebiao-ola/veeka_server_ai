import { test, expect } from "bun:test"
import { TrackerConflict, type TrackerFile, type TrackerStore } from "./store.ts"
import { Tracker } from "./tracker.ts"
import { confirmPick, preparePick, ignoreRows, reopenRows, refreshRows, type PickClient } from "./pick.ts"
import { overview } from "./overview.ts"
import type { Row } from "./rows.ts"

const row = (n: number, extra: Partial<Row> = {}): Row => ({ id: String(n).padStart(64, "0"), category: "sqli", file: `app/${n}.php`, lines: [1], severity: "P1", status: "open", reason: "reason", date: "01-01-2026", pr: "", ...extra })
class MemoryStore implements TrackerStore {
  files: TrackerFile[] = []
  conflicts = 0
  reads = 0
  async read() { this.reads++; return structuredClone(this.files) }
  async write(file: TrackerFile, rows: Row[], message: string) {
    if (this.conflicts-- > 0) throw new TrackerConflict()
    const next = { ...file, rows: structuredClone(rows), log: [...file.log, ...(message ? [{ at: "now", message }] : [])], sha: "sha", url: `https://example.test/${file.category}.json` }
    this.files = [...this.files.filter(current => current.category !== file.category), next]
    return next
  }
}
const client: PickClient = { openPRFiles: async () => [], prState: async () => "merged" }

test("tracker retries a complete cycle once and stops after three conflicts", async () => {
  const store = new MemoryStore()
  store.conflicts = 1
  await new Tracker(store).update("sqli", () => [row(1)], "update")
  expect(store.reads).toBe(2)
  expect(store.files[0].rows).toEqual([row(1)])
  store.conflicts = 3
  store.reads = 0
  await expect(new Tracker(store).update("sqli", () => [row(2)], "update")).rejects.toBeInstanceOf(TrackerConflict)
  expect(store.reads).toBe(3)
})

test("scans deduplicate rows and scan log prefixes including legacy misc rows", async () => {
  const store = new MemoryStore()
  await new Tracker(store).update("misc", () => [row(1, { category: "misc", kind: "sqli" })], "")
  const tracker = new Tracker(store)
  const finding = { id: row(1).id, category: "sqli", file: row(1).file, line: 1, severity: "P1", status: "open" as const, reason: "reason" }
  expect(await tracker.scan("sqli", [finding], "Scan run: first")).toBe(false)
  await tracker.scan("sqli", [{ ...finding, id: row(2).id, file: row(2).file }], "Scan run: first")
  await tracker.scan("sqli", [{ ...finding, id: row(3).id, file: row(3).file }], "Scan run: duplicate")
  expect(store.files.find(file => file.category === "sqli")!.log).toHaveLength(1)
})

test("pick, ignore, reopen, PR refresh and misc promotion use tracker files", async () => {
  const store = new MemoryStore()
  const tracker = new Tracker(store)
  await tracker.update("sqli", () => [row(1), row(2)], "")
  await confirmPick(client, store, "owner/repo", [row(1).id])
  await ignoreRows(client, store, "owner/repo", [row(2).id], "skip")
  await reopenRows(client, store, "owner/repo", [row(2).id])
  let rows = store.files.find(file => file.category === "sqli")!.rows
  expect(rows.map(item => item.status)).toEqual(["in progress", "open"])
  expect(rows[1].reason).toBe("reason")
  await tracker.update("sqli", () => [{ ...rows[0], pr: "[PR #7](https://github.com/owner/repo/pull/7)" }], "")
  await tracker.update("misc", () => [row(3, { category: "misc", kind: "sqli" })], "")
  await refreshRows(client, store, "owner/repo", new Set())
  rows = store.files.find(file => file.category === "sqli")!.rows
  expect(rows.find(item => item.id === row(1).id)?.status).toBe("fixed")
  expect(rows.find(item => item.id === row(3).id)?.category).toBe("sqli")
  expect(store.files.find(file => file.category === "misc")!.rows).toHaveLength(0)
  const result = await overview({ ...client, suitePRs: async () => [] }, store, "owner/repo")
  expect(result.types.find(type => type.category === "sqli")?.url).toBe("https://example.test/sqli.json")
})


function conflictEdit(store: MemoryStore, edit: (files: TrackerFile[]) => void, category = "sqli") {
  const write = store.write.bind(store)
  let conflicted = false
  store.write = async (file, rows, message) => {
    if (file.category === category && !conflicted) {
      conflicted = true
      edit(store.files)
      throw new TrackerConflict()
    }
    return write(file, rows, message)
  }
}

test("Pick retries only selected status and PR changes and keeps fresh owner fields", async () => {
  const store = new MemoryStore()
  store.files = [{ category: "sqli", rows: [row(1), row(2)], log: [], url: "" }]
  conflictEdit(store, files => {
    files[0].rows = [row(1, { severity: "P0", reason: "selected owner edit", file: "new.php", lines: [9], date: "02-01-2026" }),
      row(2, { status: "ignored", reason: "unselected owner edit" })]
  })
  await confirmPick(client, store, "owner/repo", [row(1).id])
  expect(store.files[0].rows).toEqual([
    row(1, { severity: "P0", reason: "selected owner edit", file: "new.php", lines: [9], date: "02-01-2026", status: "in progress" }),
    row(2, { status: "ignored", reason: "unselected owner edit" }),
  ])
})

for (const action of ["ignore", "reopen", "refresh"] as const) {
  test(`${action} reapplies its change to fresh owner fields after conflict`, async () => {
    const store = new MemoryStore()
    const original = row(1, action === "reopen" ? { status: "ignored", reason: "Ignored: old\nEarlier reason: original" }
      : action === "refresh" ? { status: "in progress", pr: "[PR #7](https://github.com/owner/repo/pull/7)" } : {})
    store.files = [{ category: "sqli", rows: [original], log: [], url: "" }]
    const fresh = { ...original, severity: "P0", reason: action === "reopen" ? "Ignored: edited\nEarlier reason: fresh" : "fresh" }
    conflictEdit(store, files => { files[0].rows = [fresh] })
    if (action === "ignore") await ignoreRows(client, store, "owner/repo", [original.id], "skip")
    else if (action === "reopen") await reopenRows(client, store, "owner/repo", [original.id])
    else await refreshRows(client, store, "owner/repo")
    expect(store.files[0].rows[0]).toEqual({ ...fresh, status: action === "ignore" ? "ignored" : action === "reopen" ? "open" : "fixed",
      reason: action === "ignore" ? "Ignored: skip\nEarlier reason: fresh" : "fresh", pr: action === "refresh" ? original.pr : "" })
  })
}

for (const change of [{ reason: "fresh owner edit", severity: "P0" }, { kind: "cors", status: "ignored" }] as Partial<Row>[]) {
  test(`promotion preserves moved-row source edits on removal conflict: ${JSON.stringify(change)}`, async () => {
    const store = new MemoryStore()
    const original = row(1, { category: "misc", kind: "sqli" })
    store.files = [{ category: "misc", rows: [original], log: [], url: "" }]
    conflictEdit(store, files => { files.find(file => file.category === "misc")!.rows = [{ ...original, ...change }] }, "misc")
    await refreshRows(client, store, "owner/repo", new Set())
    const fresh = { ...original, ...change }
    const preserved = store.files.flatMap(file => file.rows).find(row => row.id === original.id && row.reason === fresh.reason && row.severity === fresh.severity && row.status === fresh.status && (change.kind ? row.kind === change.kind : true))
    expect(preserved).toBeDefined()
    await refreshRows(client, store, "owner/repo", new Set())
    expect(store.files.flatMap(file => file.rows).some(row => row.id === original.id && row.reason === fresh.reason && row.severity === fresh.severity && row.status === fresh.status)).toBe(true)
  })
}

test("seed rechecks moved source rows after a removal conflict", async () => {
  const store = new MemoryStore()
  const original = row(1, { id: "pr7:app/1.php", category: "sqli", reason: "original" })
  store.files = [{ category: "sqli", rows: [original], log: [], url: "" }]
  conflictEdit(store, files => { files.find(file => file.category === "sqli")!.rows = [{ ...original, reason: "fresh owner edit", severity: "P0" }] })
  await new Tracker(store).seed([{ number: 7, category: "cors", headRefName: "security/cors-x", state: "merged", sites: [{ file: "app/1.php", lines: [1] }] }])
  expect(store.files.flatMap(file => file.rows).some(row => row.id === original.id && row.reason === "fresh owner edit" && row.severity === "P0")).toBe(true)
})


test("prepared Pick rechecks fresh eligibility when marked", async () => {
  const store = new MemoryStore()
  store.files = [{ category: "sqli", rows: [row(1)], log: [], url: "" }]
  const prepared = await preparePick(client, store, "owner/repo", [row(1).id])
  store.files[0].rows = [row(1, { status: "ignored", reason: "owner decision" })]
  await expect(prepared.mark()).rejects.toThrow("selection changed")
  expect(store.files[0].rows).toEqual([row(1, { status: "ignored", reason: "owner decision" })])
})

test("refresh keeps a replacement PR assigned during a conflict", async () => {
  const store = new MemoryStore()
  const original = row(1, { status: "in progress", pr: "[PR #7](https://github.com/owner/repo/pull/7)" })
  const fresh = { ...original, pr: "[PR #8](https://github.com/owner/repo/pull/8)", reason: "owner reassigned", severity: "P0" }
  store.files = [{ category: "sqli", rows: [original], log: [], url: "" }]
  conflictEdit(store, files => { files[0].rows = [fresh] })
  await refreshRows(client, store, "owner/repo")
  expect(store.files[0].rows).toEqual([fresh])
})

test("seed keeps fresh misc kind edits when removing a moved source", async () => {
  const store = new MemoryStore()
  const original = row(1, { id: "pr7:app/1.php", category: "misc", kind: "sqli" })
  store.files = [{ category: "misc", rows: [original], log: [], url: "" }]
  conflictEdit(store, files => { files.find(file => file.category === "misc")!.rows = [{ ...original, kind: "idor" }] }, "misc")
  await new Tracker(store).seed([{ number: 7, category: "cors", headRefName: "security/cors-x", state: "merged", sites: [{ file: "app/1.php", lines: [1] }] }])
  expect(store.files.find(file => file.category === "misc")!.rows).toEqual([{ ...original, kind: "idor" }])
})


test("promotion keeps both owners' edits when source and destination change during a conflict", async () => {
  const store = new MemoryStore()
  const original = row(1, { category: "misc", kind: "sqli" })
  store.files = [{ category: "misc", rows: [original], log: [], url: "" }]
  conflictEdit(store, files => {
    files.find(file => file.category === "misc")!.rows = [{ ...original, reason: "source owner edit" }]
    const target = files.find(file => file.category === "sqli")!
    target.rows = target.rows.map(row => ({ ...row, severity: "P0", reason: "destination owner edit" }))
  }, "misc")
  await refreshRows(client, store, "owner/repo", new Set())
  expect(store.files.find(file => file.category === "misc")!.rows[0].reason).toBe("source owner edit")
  const destination = store.files.find(file => file.category === "sqli")!.rows[0]
  expect(destination.reason).toBe("destination owner edit")
  expect(destination.severity).toBe("P0")
})
