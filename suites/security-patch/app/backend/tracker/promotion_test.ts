import { afterEach, beforeEach, test } from "bun:test"
import { strict as assert } from "node:assert"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Context } from "hono"
import type { Row } from "./rows.ts"
import { TrackerConflict, type TrackerFile, type TrackerStore } from "./store.ts"
import { confirming, confirmPick, ignoreRows, loadPick, refreshRows, reopenRows, streamPick } from "./pick.ts"
import { overview } from "./overview.ts"
import { Tracker } from "./tracker.ts"
import { setKnownRepos } from "./repos.ts"
import { heldRows } from "../handlers/runs.ts"
import { Store } from "../store/repo.ts"
import { matchTracked, postFindings } from "../orchestrator/findings.ts"
import { openBatchPR } from "../orchestrator/batch_pr.ts"
import type { BatchPRClient } from "../orchestrator/batch_pr.ts"

beforeEach(() => { setKnownRepos(() => ["owner/repo"]) })
afterEach(() => { setKnownRepos(() => []) })

const row = (n: number, extra: Partial<Row> = {}): Row => ({
  id: n.toString(16).padStart(64, "0"), category: "misc", kind: "tls-verify-off",
  file: `app/api/${n}.php`, lines: [1], severity: "P1", status: "open",
  reason: "Original reason", date: "01-01-2026", pr: "", ...extra,
})

class Fake implements BatchPRClient, TrackerStore {
  files = new Map<string, TrackerFile>()
  writes = 0
  constructor(rows: Row[]) { this.files.set("misc", { category: "misc", rows, log: [], url: "https://example.test/misc.json" }) }
  rows(category: string) { return this.files.get(category)!.rows }
  async read() { return structuredClone([...this.files.values()]) }
  async write(file: TrackerFile, rows: Row[], message: string) {
    if (this.files.get(file.category)?.sha !== file.sha) throw new TrackerConflict()
    const next = { ...file, rows: structuredClone(rows),
      log: [...file.log, ...(message ? [{ at: "now", message }] : [])],
      sha: String(++this.writes), url: `https://example.test/${file.category}.json` }
    this.files.set(file.category, next)
    return structuredClone(next)
  }
  async openPRFiles() { return [] as string[] }
  async suitePRs() { return [] }
  async prState() { return "open" as const }
  async createPR(): Promise<number> { throw new Error("unexpected PR creation") }
}

for (const action of ["ignore", "reopen"] as const) {
  test(`${action} resolves the current file after waiting for promotion`, async () => {
    const source = row(1, action === "reopen" ? { status: "ignored", reason: "Ignored: old\nEarlier reason: Original reason" } : {})
    const fake = new Fake([source])
    let ready!: () => void
    let resume!: () => void
    const waiting = new Promise<void>(resolve => { ready = resolve })
    const gate = new Promise<void>(resolve => { resume = resolve })
    const write = fake.write.bind(fake)
    fake.write = async (file, rows, message) => {
      if (file.category === source.kind) {
        ready()
        await gate
      }
      return write(file, rows, message)
    }
    const promotion = refreshRows(fake, fake, "a/b", new Set())
    await waiting
    const changed = action === "ignore" ? ignoreRows(fake, fake, "a/b", [source.id], "Accepted") : reopenRows(fake, fake, "a/b", [source.id])
    await Promise.resolve()
    resume()
    await promotion
    assert.equal(await changed, 1)
    assert.deepEqual(fake.rows("misc"), [])
    const destination = fake.rows(source.kind!)[0]
    assert.equal(destination.status, action === "ignore" ? "ignored" : "open")
    assert.equal(destination.reason, action === "ignore" ? "Ignored: Accepted\nEarlier reason: Original reason" : "Original reason")
    assert.equal((await loadPick(fake, fake)).rows.length, action === "ignore" ? 0 : 1)
  })
}

for (const action of ["ignore", "reopen", "insert"] as const) {
  test(`promotion keeps a concurrent misc ${action} during source removal`, async () => {
    const kept = row(2, { kind: "idor", ...(action === "reopen" ? {
      status: "ignored" as const, reason: "Ignored: old\nEarlier reason: Original reason",
    } : {}) })
    const fake = new Fake([row(1), kept])
    const write = fake.write.bind(fake)
    fake.write = async (file, rows, message) => {
      if (file.category === "tls-verify-off") {
        if (action === "ignore") fake.files.get("misc")!.rows = fake.rows("misc").map(row => row.id === kept.id ? { ...row, status: "ignored" } : row)
        else if (action === "reopen") fake.files.get("misc")!.rows = fake.rows("misc").map(row => row.id === kept.id ? { ...row, status: "open" } : row)
        else fake.files.get("misc")!.rows = [...fake.rows("misc"), row(3, { kind: "idor" })]
      }
      return write(file, rows, message)
    }
    await refreshRows(fake, fake, "a/b", new Set())
    if (action === "insert") assert.deepEqual(fake.rows("misc").map(row => row.id), [kept.id, row(3).id])
    else assert.equal(fake.rows("misc")[0].status, action === "ignore" ? "ignored" : "open")
    assert.equal(fake.rows("tls-verify-off").length, 1)
  })
}

for (const action of ["ignore", "reopen"] as const) {
  test(`promotion uses the latest ${action} state of a moved row`, async () => {
    const original = row(1, action === "reopen" ? {
      status: "ignored", reason: "Ignored: old\nEarlier reason: Original reason",
    } : {})
    const fake = new Fake([original])
    const read = fake.read.bind(fake)
    let sourceReads = 0
    fake.read = async () => {
      if (++sourceReads === 2) {
        fake.files.get("misc")!.rows = [{ ...original, status: action === "ignore" ? "ignored" : "open" }]
      }
      return read()
    }
    await refreshRows(fake, fake, "a/b", new Set())
    assert.equal(fake.rows("tls-verify-off")[0].status, action === "ignore" ? "ignored" : "open")
    assert.deepEqual(fake.rows("misc"), [])
  })
}

test("promotion fetches destination edits after a write conflict", async () => {
  const fake = new Fake([row(1)])
  const destination = row(2, { category: "tls-verify-off", status: "ignored", reason: "Owner edit" })
  delete destination.kind
  fake.files.set("tls-verify-off", { category: "tls-verify-off", rows: [destination], log: [], url: "https://example.test/tls-verify-off.json" })
  const write = fake.write.bind(fake)
  let edited = false
  fake.write = async (file, rows, message) => {
    if (file.category === "tls-verify-off" && !edited) {
      edited = true
      await write(file, [destination, { ...destination, id: row(3).id }], "Owner edit")
    }
    return write(file, rows, message)
  }
  await refreshRows(fake, fake, "a/b", new Set())
  assert.equal(fake.rows("tls-verify-off").length, 3)
  assert.deepEqual(fake.rows("tls-verify-off").find(row => row.id === destination.id), destination)
  assert.deepEqual(fake.files.get("tls-verify-off")!.log.map(entry => entry.message), ["Owner edit"])
})

test("promotion leaves the confirmation lock free even when a save fails", async () => {
  const fake = new Fake([row(1)])
  const write = fake.write.bind(fake)
  fake.write = async (file, rows, message) => {
    if (file.category === "tls-verify-off") {
      assert.equal(confirming.has("owner/repo"), false)
      throw new Error("destination failed")
    }
    return write(file, rows, message)
  }
  await assert.rejects(() => refreshRows(fake, fake, "owner/repo", new Set()), /destination failed/)
  assert.equal(confirming.has("owner/repo"), false)
})

for (const onlyType of ["misc", undefined]) {
  for (const kind of ["tls-verify-off", "vendor-cve"]) {
    test(`reseed ${onlyType ?? "all types"} keeps existing ${kind} fields in misc`, async () => {
      const original = row(1, { id: "pr7:app/api/1.php", kind, status: "ignored", reason: "Accepted by owner",
        pr: "[PR #7](https://github.com/a/b/pull/7)" })
      const fake = new Fake([original])
      await new Tracker(fake, "a/b").seed([{ number: 7, headRefName: `security/${kind}-x`, kind, state: "merged",
        sites: [{ file: original.file, lines: original.lines }] }], onlyType)
      const matching = (await fake.read()).flatMap(file => file.rows)
        .filter(row => row.id === original.id)
      assert.deepEqual(matching, [original])
    })
  }
}

for (const held of [undefined, new Set([row(1).id])]) {
  test(`refresh keeps an active misc batch when held is ${held ? "known" : "unknown"}`, async () => {
    const original = row(1, { status: "in progress" })
    const fake = new Fake([original])
    await refreshRows(fake, fake, "a/b", held)
    assert.deepEqual(fake.rows("misc"), [original])
    assert.equal(fake.files.has("tls-verify-off"), false)
    const dir = await mkdtemp(join(tmpdir(), "secpatch-promotion-"))
    try {
      const art = join(dir, "run-1", "artifacts")
      await mkdir(art, { recursive: true })
      await writeFile(join(art, "picked.json"), JSON.stringify([original]))
      await writeFile(join(art, "working.patch"), "diff --git a/app/api/1.php b/app/api/1.php\n+x\n")
      await writeFile(join(art, "checks.json"), JSON.stringify([{ name: "lint", command: "php -l", ok: true }]))
      let pushes = 0
      let prs = 0
      fake.createPR = async () => { prs++; return 7 }
      const deps = {
        runsRootDir: dir,
        store: { getRun: () => ({ mode: "fix", branch: "main" }),
          listFindings: () => [{ id: original.id, category: "misc", kind: original.kind, status: "fixed" }],
          getContainerId: () => undefined },
        activeRuns: new Map([["run-1", { pushToBranch: async () => { pushes++; return { ok: true } } }]]),
        controller: { stopAndRemove: async () => {} }, bus: { publish() {} },
      }
      assert.equal(await openBatchPR(deps as never, "run-1", fake, fake, "a/b"), 7)
      assert.deepEqual({ pushes, prs, released: !deps.activeRuns.has("run-1") }, { pushes: 1, prs: 1, released: true })
      await refreshRows(fake, fake, "a/b", new Set())
      assert.deepEqual(fake.rows("misc"), [])
      assert.equal(fake.rows("tls-verify-off")[0].pr, "[PR #7](https://github.com/a/b/pull/7)")
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
}

for (const category of ["tls-verify-off", "vendor-cve"]) {
  for (const sameId of [true, false]) {
    test(`posting ${category} before refresh keeps legacy history matched by ${sameId ? "id" : "location"}`, async () => {
      const original = row(1, { kind: category, file: category === "vendor-cve" ? "example/client@1.2.3" : "app/api/1.php",
        status: "ignored", reason: "Accepted by owner", pr: "[PR #7](https://github.com/a/b/pull/7)" })
      const fake = new Fake([original])
      assert.deepEqual(await postFindings("scan", "a/b", [{ id: sameId ? original.id : row(2).id, category,
        file: original.file, line: sameId ? 1 : 2, severity: "P1", status: "needs human", reason: "New scan reason" }], fake),
      { added: 0, skipped: 1 })
      await refreshRows(fake, fake, "a/b", new Set())
      const { kind, ...fields } = original
      assert.deepEqual(fake.rows(category), [{ ...fields, category }])
      assert.deepEqual(fake.rows("misc"), [])
    })
  }
}

test("a failed source save leaves destination rows usable across Pick, Overview, ignore and reopen", async () => {
  const fake = new Fake([row(1)])
  const write = fake.write.bind(fake)
  fake.write = async (file, rows, message) => {
    if (file.category === "misc") throw new Error("source failed")
    return write(file, rows, message)
  }
  await assert.rejects(() => refreshRows(fake, fake, "a/b", new Set()), /source failed/)
  assert.deepEqual((await loadPick(fake, fake)).rows.map(row => [row.id, row.category]), [[row(1).id, "tls-verify-off"]])
  const updates: string[][] = []
  await streamPick(fake, fake, update => updates.push(update.rows.map(row => row.id)))
  assert.ok(updates.length > 0)
  assert.ok(updates.every(ids => ids.length === 1 && ids[0] === row(1).id))
  await ignoreRows(fake, fake, "a/b", [row(1).id], "Accepted")
  assert.deepEqual((await loadPick(fake, fake)).rows, [])
  const summary = await overview(fake, fake, "a/b")
  assert.equal(summary.types.find(type => type.category === "misc")!.total, 0)
  assert.deepEqual(summary.types.find(type => type.category === "misc")!.rows, [])
  assert.deepEqual(summary.ignored.map(row => [row.id, row.category]), [[row(1).id, "tls-verify-off"]])
  await reopenRows(fake, fake, "a/b", [row(1).id])
  assert.equal(fake.rows("tls-verify-off")[0].reason, "Original reason")
  await confirmPick(fake, fake, "a/b", [row(1).id])
  assert.equal(fake.rows("tls-verify-off")[0].status, "in progress")
  assert.equal(fake.rows("misc")[0].status, "open")
})

for (const kind of ["tls-verify-off", "vendor-cve"]) {
  test(`full reseed after migration keeps ${kind} operator fields`, async () => {
    const original = row(1, { id: "pr7:app/api/1.php", kind, status: "ignored", reason: "Accepted by owner", pr: "[PR #7](https://github.com/a/b/pull/7)" })
    const fake = new Fake([original])
    await refreshRows(fake, fake, "a/b", new Set())
    await new Tracker(fake, "a/b").seed([{ number: 7, headRefName: `security/${kind}-x`, kind, state: "merged", sites: [{ file: original.file, lines: original.lines }] }])
    await refreshRows(fake, fake, "a/b", new Set())
    const { kind: _, ...fields } = original
    assert.deepEqual(fake.rows(kind), [{ ...fields, category: kind }])
  })
}

test("migration preserves a finding posted after the destination read", async () => {
  const fake = new Fake([row(1)])
  const read = fake.read.bind(fake)
  let sourceReads = 0
  let posting: Promise<unknown> | undefined
  fake.read = async () => {
    if (++sourceReads === 2) {
      posting = postFindings("scan", "a/b", [{ id: row(2).id, category: "tls-verify-off", file: "app/api/2.php", line: 1, severity: "P1", status: "candidate", reason: "New finding" }], fake)
    }
    return read()
  }
  await refreshRows(fake, fake, "a/b", new Set())
  await posting
  assert.deepEqual(fake.rows("tls-verify-off").map(row => row.id).sort(), [row(1).id, row(2).id])
})

test("tracked matching uses the destination status after a source save fails", async () => {
  const fake = new Fake([row(1)])
  const save = fake.write.bind(fake)
  fake.write = async (file, rows, message) => {
    if (file.category === "misc") throw new Error("source failed")
    return save(file, rows, message)
  }
  await assert.rejects(() => refreshRows(fake, fake, "a/b", new Set()), /source failed/)
  await ignoreRows(fake, fake, "a/b", [row(1).id], "Accepted")
  const finding = { id: row(1).id, category: "tls-verify-off", file: row(1).file, line: 1, severity: "P1" as const, status: "candidate" as const }
  assert.equal((await matchTracked([finding], fake))[finding.id].status, "ignored")
})

test("a completed run still waiting to open its PR keeps its legacy batch", async () => {
  const original = row(1, { status: "in progress" })
  const fake = new Fake([original])
  const dir = await mkdtemp(join(tmpdir(), "secpatch435-completion-"))
  const store = await Store.open(join(dir, "test.sqlite"))
  try {
    store.ensureSession("s1")
    store.createRun({ runId: "run-1", sessionId: "s1", repoUrl: "https://github.com/a/b", branch: "main", skill: "ola-security-audit", model: "opus", effort: "high", mode: "fix" })
    store.insertFinding("run-1", { id: original.id, category: "misc", severity: "P1", kind: original.kind, status: "fixed" })
    const art = join(dir, "run-1", "artifacts")
    await mkdir(art, { recursive: true })
    await writeFile(join(art, "picked.json"), JSON.stringify([original]))
    await writeFile(join(art, "working.patch"), "diff --git a/app/api/1.php b/app/api/1.php\n+x\n")
    await writeFile(join(art, "checks.json"), JSON.stringify([{ name: "lint", command: "php -l", ok: true }]))
    store.updateRunStatus("run-1", "completed")
    let pushes = 0
    fake.createPR = async () => 7
    const deps = { runsRootDir: dir, store,
      activeRuns: new Map([["run-1", { pushToBranch: async () => { pushes++; return { ok: true } } }]]),
      controller: { stopAndRemove: async () => {} }, bus: { publish() {} } }
    const read = fake.read.bind(fake)
    let first = true
    fake.read = async () => {
      if (first) {
        first = false
        await refreshRows(fake, fake, "a/b", await heldRows(deps))
      }
      return read()
    }
    const pr = await openBatchPR(deps as never, "run-1", fake, fake, "a/b")
    assert.deepEqual({ pr, pushes }, { pr: 7, pushes: 1 })
  } finally { store.close(); await rm(dir, { recursive: true, force: true }) }
})

for (const category of ["tls-verify-off", "vendor-cve"]) {
  test(`posting ${category} between the final destination read and save survives promotion`, async () => {
    const original = row(1, { kind: category })
    const fake = new Fake([original])
    const save = fake.write.bind(fake)
    let injected = false
    let posting: Promise<unknown> | undefined
    fake.write = async (file, rows, message) => {
      if (file.category === category && !injected) {
        injected = true
        posting = postFindings("scan", "a/b", [{
          id: row(2).id, category, file: "app/api/2.php", line: 1,
          severity: "P1", status: "candidate", reason: "New finding",
        }], fake)

      }
      return save(file, rows, message)
    }
    await refreshRows(fake, fake, "a/b", new Set())
    assert.deepEqual(await posting, { added: 1, skipped: 0 })
    assert.deepEqual(fake.rows(category).map(row => row.id).sort(), [original.id, row(2).id])
  })

  test(`reseeding ${category} without optional kind preserves the promoted operator fields`, async () => {
    const original = row(1, {
      id: "pr7:app/api/1.php", kind: category, severity: "P0", status: "ignored",
      reason: "Accepted by owner", date: "01-01-2026", pr: "[PR #7](https://github.com/a/b/pull/7)",
    })
    const seed = [{ number: 7, headRefName: `security/${category}-x`, state: "merged" as const,
      sites: [{ file: original.file, lines: original.lines }] }]
    const fake = new Fake([original])
    await new Tracker(fake, "a/b").seed(seed)
    assert.deepEqual(fake.rows("misc"), [original])
    await refreshRows(fake, fake, "a/b", new Set())
    await new Tracker(fake, "a/b").seed(seed)
    await refreshRows(fake, fake, "a/b", new Set())
    const { kind, ...fields } = original
    const actual = (await fake.read()).flatMap(file => file.rows)
      .filter(row => row.id === original.id)
    assert.deepEqual(actual, [{ ...fields, category }])
  })

  for (const onlyType of [undefined, "misc", category]) {
    test(`seeding a misc PR as ${category}${onlyType ? ` with only-type ${onlyType}` : ""} keeps its operator fields`, async () => {
      const original = row(1, {
        id: "pr7:app/api/1.php", kind: category, severity: "P0", status: "ignored",
        reason: "Accepted by owner", date: "01-01-2026", pr: "[PR #7](https://github.com/a/b/pull/7)",
      })
      const fake = new Fake([original])
      await new Tracker(fake, "a/b").seed([{ number: 7, headRefName: "security/x", state: "merged", category,
        sites: [{ file: original.file, lines: original.lines }] }], onlyType)
      const { kind, ...fields } = original
      const actual = (await fake.read()).flatMap(file => file.rows)
      assert.deepEqual(actual, [onlyType ? original : { ...fields, category }])
    })
  }
}


test("failed runs cached for event replay do not keep their rows out of Pick", async () => {
  const original = row(1, { status: "in progress" })
  const fake = new Fake([original])
  const dir = await mkdtemp(join(tmpdir(), "secpatch435-failed-"))
  const store = await Store.open(join(dir, "test.sqlite"))
  try {
    store.ensureSession("s1")
    store.createRun({ runId: "run-1", sessionId: "s1", repoUrl: "https://github.com/a/b", branch: "main", skill: "ola-security-audit", model: "opus", effort: "high", mode: "fix" })
    const art = join(dir, "run-1", "artifacts")
    await mkdir(art, { recursive: true })
    await writeFile(join(art, "picked.json"), JSON.stringify([original]))
    store.updateRunStatus("run-1", "failed")
    const deps = { runsRootDir: dir, store, activeRuns: new Map([["run-1", {}]]) }
    assert.deepEqual([...await heldRows(deps)], [])
    await refreshRows(fake, fake, "a/b", await heldRows(deps))
    await refreshRows(fake, fake, "a/b", await heldRows(deps))
    assert.deepEqual((await loadPick(fake, fake)).rows.map(row => row.id), [original.id])
  } finally { store.close(); await rm(dir, { recursive: true, force: true }) }
})
