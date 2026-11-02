import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { afterEach, beforeEach, test } from "bun:test"
import { Hono } from "hono"
import { strict as assert } from "node:assert"
import type { Row } from "./rows.ts"
import type { TrackerFile, TrackerStore } from "./store.ts"
import { candidates, ignoreRows, needsHumanRows, reopenRows, suggested, subsystem, confirmPick, preparePick, loadPick, streamPick, batches, queuedBatches, confirming, refreshRows, refreshReadRows, BATCH, DEFAULT_PICK_LIMIT } from "./pick.ts"
import type { PickClient } from "./pick.ts"
import { handleStartRun } from "../handlers/runs.ts"
import { handlePick, handleRowChange, finishBatch } from "../handlers/pick.ts"
import { GitHubClient } from "./client.ts"
import { Tracker } from "./tracker.ts"
import { Store } from "../store/repo.ts"
import type { Context } from "hono"
import type { RunScannerArgs } from "../docker/controller.ts"
import { setKnownRepos } from "./repos.ts"

beforeEach(() => { setKnownRepos(() => ["owner/repo"]) })
afterEach(() => { setKnownRepos(() => []) })

const row = (n: number, extra: Partial<Row> = {}): Row => ({
  id: n.toString(16).padStart(64, "0"), category: "sqli", date: "01-01-2026",
  file: `app/api/${n}.php`, lines: [1], severity: "P1", status: "open", reason: "", pr: "", ...extra,
})
class MemoryStore implements TrackerStore {
  files: TrackerFile[]
  writes = 0
  constructor(rows: Row[] = []) {
    this.files = [...new Set(rows.map(row => row.category))].map(category => ({
      category, rows: structuredClone(rows.filter(row => row.category === category)), log: [],
      url: `https://example.test/${category}.json`,
    }))
  }
  async read() { return structuredClone(this.files) }
  async write(file: TrackerFile, rows: Row[], message: string) {
    const next = { ...file, rows: structuredClone(rows),
      log: [...file.log, ...(message ? [{ at: "now", message }] : [])], sha: "sha",
      url: `https://example.test/${file.category}.json` }
    this.files = [...this.files.filter(current => current.category !== file.category), next]
    this.writes++
    return structuredClone(next)
  }
}
class Fake implements PickClient {
  store: MemoryStore
  files: string[] = []
  openPRs?: PickClient["openPRs"]
  prStates?: PickClient["prStates"]
  constructor(rows: Row[]) { this.store = new MemoryStore(rows) }
  async openPRFiles() { return this.files }
  states: Record<number, "open" | "merged" | "closed"> = {}
  async prState(n: number) { return this.states[n] ?? "open" }
}
test("Pick orders severity, excludes PR files and in PR, groups and caps suggestions", () => {
  const input = [row(1, { severity: "" }), row(2, { severity: "P2" }), row(3), row(4, { severity: "P0" }),
    row(5, { severity: "P0", status: "in progress" }), row(6, { severity: "P0" }), row(7, { file: "other/7.php" }),
    ...Array.from({ length: 15 }, (_, i) => row(i + 10, { status: "open" }))]
  const rows = candidates(input, ["./app/api/6.php"])
  assert.equal(rows[0].id, row(4).id)
  assert.equal(rows[0].subsystem, "app/api")
  assert.equal(subsystem(row(1, { file: "root.php" })), "root.php")
  assert.ok(!rows.some(r => [row(5).id, row(6).id].includes(r.id)))
  assert.deepEqual(rows.map(r => r.severity), [...rows.map(r => r.severity)].sort((a,b) => ["P0", "P1", "P2", ""].indexOf(a) - ["P0", "P1", "P2", ""].indexOf(b)))
  const ids = suggested(rows)
  assert.equal(ids.length, DEFAULT_PICK_LIMIT)
  assert.equal(ids[0], row(4).id)
  assert.ok(ids.every(id => rows.find(r => r.id === id)?.subsystem === "app/api"))
  assert.deepEqual(suggested([]), [])
})
test("Confirm marks selected rows in progress and keeps same-group rows open", async () => {
  const fake = new Fake([row(1), row(2), row(3, { status: "open" }), row(4, { status: "in progress" }), row(5, { file: "other/5.php" }), row(6)])
  fake.files = [row(6).file]
  await confirmPick(fake, fake.store, "a/b", [row(1).id])
  const byId = (n: number) => fake.store.files[0].rows.find(r => r.id === row(n).id)!
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(n => byId(n).status), ["in progress", "open", "open", "in progress", "open", "open"])
  assert.ok(!("subsystem" in byId(1)))
  await assert.rejects(() => confirmPick(fake, fake.store, "a/b", [row(4).id]))
  await assert.rejects(() => confirmPick(fake, fake.store, "a/b", []))
  assert.equal(fake.store.writes, 1)
})
test("Confirm accepts rows of one bug type across subsystems", async () => {
  const fake = new Fake([row(2), row(5, { file: "other/5.php" })])
  await confirmPick(fake, fake.store, "a/b", [row(2).id, row(5).id])
  assert.deepEqual(fake.store.files[0].rows.map(r => r.status), ["in progress", "in progress"])
})
test("Picking clears an old PR link so refresh keeps the row in progress", async () => {
  const pr = "[PR #7](https://github.com/a/b/pull/7)"
  const otherPR = "[PR #8](https://github.com/a/b/pull/8)"
  const fake = new Fake([row(1, { pr }), row(2, { pr: otherPR })])
  fake.states[7] = "closed"
  let reads = 0
  const prState = fake.prState.bind(fake)
  fake.prState = (n: number) => { reads++; return prState(n) }
  await confirmPick(fake, fake.store, "a/b", [row(1).id])
  const picked = () => fake.store.files[0].rows.find(r => r.id === row(1).id)!
  assert.equal(picked().status, "in progress")
  assert.equal(picked().pr, "")
  assert.equal(fake.store.files[0].rows.find(r => r.id === row(2).id)!.pr, otherPR)
  assert.equal(await refreshRows(fake, fake.store, "a/b"), 0)
  assert.equal(picked().status, "in progress")
  assert.equal(reads, 0)
  assert.equal(fake.store.writes, 1)
})
test("Pick accepts unnormalized candidate and deferred rows", () => {
  const rows = [row(1), row(2, { status: "candidate" }), row(3, { status: "deferred" }),
    row(4, { status: "picked" }), row(5, { status: "ignored" })]
  assert.deepEqual(candidates(rows, []).map(row => row.id), rows.slice(0, 3).map(row => row.id))
})
test("Pick loads legacy store rows and refreshes legacy PR rows", async () => {
  const fake = new Fake([row(1), row(2), row(3, { status: "in progress", pr: "[PR #7](https://github.com/a/b/pull/7)" })])
  fake.store.files[0].rows = fake.store.files[0].rows.map(row => ({ ...row, status: row.status === "open" ? "deferred" : "in PR" }))
  const loadedStatuses = (await loadPick(fake, fake.store)).rows.map(row => row.status)
  fake.states[7] = "merged"
  assert.equal(await refreshRows(fake, fake.store, "a/b"), 1)
  assert.equal(fake.store.files[0].rows.find(item => item.id === row(3).id)!.status, "fixed")
  await confirmPick(fake, fake.store, "a/b", [row(1).id])
  assert.equal(fake.store.files[0].rows.find(item => item.id === row(1).id)!.status, "in progress")
  assert.deepEqual(loadedStatuses, ["open", "open"])
})
test("Pick GET never writes or starts, confirm validates then starts fix with ids", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const store = await Store.open(`${dir}/test.sqlite`)
  const launches: (RunScannerArgs & { timeoutMs?: number })[] = []
  const fake = new Fake([row(1), row(2)])
  const order: string[] = []
  const write = fake.store.write.bind(fake.store)
  fake.store.write = async (...args) => { order.push("mark"); return await write(...args) }
  const deps = {
    createTrackerStore: async () => fake.store, store, runsRootDir: dir, maxConcurrent: 10, scannerImage: "test", getGhToken: async () => "fixture", activeRuns: new Map(),
    bus: { publish() {} }, controller: { runScanner(args: RunScannerArgs) {
      assert.equal(fake.store.files[0].rows.find(row => row.id === args.env.PICKED_IDS)?.status, "open")
      order.push("start")
      launches.push(args)
      return {
        containerName: "test", stdin: new WritableStream().getWriter(),
        stdout: new ReadableStream({ start(c) { c.close() } }),
        stderr: new ReadableStream({ start(c) { c.close() } }),
        process: { exited: new Promise(() => {}) },
      }
    } },
  }
  let payload: any
  let status = 0
  let body: any = { sessionId: "s1", pickedIds: [row(1).id], model: "opus", effort: "high", reviewProvider: "claude", reviewModel: "sonnet", reviewEffort: "low", smokeSeconds: 30, language: "en" }
  const c = { req: { json: () => Promise.resolve(body) }, json: (value: unknown, code = 200) => { payload = value; status = code; return new Response() } } as unknown as Context
  const previousDev = process.env.OLA_DEV
  process.env.OLA_DEV = "1"
  try {
    await handlePick(c, deps as never, false, fake)
    assert.equal(fake.store.writes, 0)
    assert.equal(launches.length, 0)
    assert.deepEqual(payload.suggestedIds, [row(1).id, row(2).id])
    for (const note of ["x".repeat(1001), 42, null, {}]) {
      body.note = note
      await handlePick(c, deps as never, true, fake)
      assert.equal(status, 400)
      assert.match(payload.error, /note/)
      assert.equal(launches.length, 0)
      assert.equal(fake.store.writes, 0)
    }
    body.note = "  Use parameter binding.".padEnd(1000, " ")
    body.model = "invalid"
    await handlePick(c, deps as never, true, fake)
    assert.equal(status, 400)
    assert.equal(fake.store.writes, 0)
    body.model = "opus"
    body.effort = "invalid"
    await handlePick(c, deps as never, true, fake)
    assert.equal(status, 400)
    assert.equal(fake.store.writes, 0)
    delete body.model
    delete body.effort
    for (const value of [undefined, "0"]) {
      if (value === undefined) delete process.env.OLA_DEV
      else process.env.OLA_DEV = value
      await handlePick(c, deps as never, true, fake)
      assert.equal(status, 400)
      assert.match(payload.error, /require dev mode/)
      assert.equal(launches.length, 0)
      assert.equal(fake.store.writes, 0)
    }
    process.env.OLA_DEV = "1"
    await handlePick(c, deps as never, true, fake)
    assert.equal(status, 201)
    assert.equal(fake.store.writes, 1)
    assert.deepEqual(order, ["start", "mark"])
    assert.equal(launches[0].env.PICKED_IDS, row(1).id)
    assert.equal(launches[0].env.PICKED_FILE, "/workspace/artifacts/picked.json")
    assert.deepEqual(JSON.parse(await readFile(`${launches[0].artifactsHostDir}/picked.json`, "utf8")),
      [(( { id, category, file, lines, severity, reason }) => ({ id, category, file, lines, severity, reason }))(row(1))])
    const context = JSON.parse(await readFile(`${launches[0].artifactsHostDir}/repo-context.json`, "utf8"))
    assert.deepEqual(context.filter((document: { path: string }) => document.path === "operator-note.md"),
      [{ path: "operator-note.md", content: "Use parameter binding." }])
    assert.equal(launches[0].env.OUTPUT_LANGUAGE, "en")
    assert.equal(launches[0].env.SMOKE_SECONDS, "30")
    assert.equal(launches[0].env.MODE, "fix")
    assert.equal(launches[0].timeoutMs, undefined)
    assert.equal(launches[0].env.MODEL, "opus")
    assert.equal(launches[0].env.EFFORT, "high")
    assert.equal(launches[0].env.REVIEW_MODEL, "sonnet")
    assert.equal(launches[0].env.REVIEW_EFFORT, "low")
    assert.equal(store.getRun(payload.runId)?.reviewModel, "sonnet")
    assert.equal(store.getRun(payload.runId)?.reviewEffort, "low")
    assert.equal(store.getRun(payload.runId)?.mode, "fix")
    body.pickedIds = [row(2).id]
    fake.openPRs = async () => [{ number: 1252, headRefName: "dev", files: [row(2).file] }]
    await handlePick(c, deps as never, true, fake)
    assert.equal(status, 400)
    assert.equal(launches.length, 1)
    body.ignorePRs = [1252]
    body.note = "   "
    delete body.language
    delete body.smokeSeconds
    await handlePick(c, deps as never, true, fake)
    assert.equal(status, 201)
    assert.deepEqual(order, ["start", "mark", "start", "mark"])
    assert.equal(launches[1].env.OUTPUT_LANGUAGE, "zh")
    const blankContext = await readFile(`${launches[1].artifactsHostDir}/repo-context.json`, "utf8").then(JSON.parse, () => [])
    assert.ok(!blankContext.some((document: { path: string }) => document.path === "operator-note.md"))
  } finally {
    if (previousDev === undefined) delete process.env.OLA_DEV
    else process.env.OLA_DEV = previousDev
    store.close(); await rm(dir, { recursive: true })
  }
})

test("GitHub Pick reads paginate PR files including renames", async () => {
  const original = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    requests.push(url)
    if (url.endsWith("/graphql")) return Response.json({ data: { repository: { pullRequests: {
      nodes: [{ number: 12, headRefName: "dev", changedFiles: 101, files: {
        nodes: Array.from({ length: 100 }, (_, i) => ({ path: `app/${i}.php`, changeType: "MODIFIED" })),
        pageInfo: { hasNextPage: true, endCursor: "files-100" },
      } }], pageInfo: { hasNextPage: false },
    } } } })
    if (url.includes("pulls/12/files?")) return Response.json([{ filename: "new.php", previous_filename: "old.php" }])
    throw new Error("unexpected fake request")
  }) as typeof fetch
  try {
    const files = await new GitHubClient("a/b", "placeholder").openPRFiles()
    assert.equal(files.length, 102)
    assert.deepEqual(files.slice(-2), ["new.php", "old.php"])
    assert.equal(requests.filter(url => url.endsWith("/graphql")).length, 1)
  } finally { globalThis.fetch = original }
})

test("Pick returns an empty list without reading PR files when no rows need fixing", async () => {
  const client = new Fake([{ ...row(1), status: "fixed" }])
  client.openPRFiles = () => { throw new Error("Empty Pick must not read PR files") }
  assert.deepEqual(await loadPick(client, client.store), { rows: [], suggestedIds: [], hidden: [], limits: { maxFilesPerBatch: 10 } })
})

test("GET Pick reads 58 open PRs and files in one GraphQL query", async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async (input: string | URL | Request) => {
    assert.equal(String(input), "https://api.github.com/graphql")
    calls++
    return Response.json({ data: { repository: { pullRequests: {
      nodes: Array.from({ length: 58 }, (_, i) => ({ number: i + 1, headRefName: "security/sqli-api-0123abcd",
        files: { nodes: [{ path: `app/${i + 1}.php`, changeType: "MODIFIED" }], pageInfo: { hasNextPage: false } } })),
      pageInfo: { hasNextPage: false },
    } } } })
  }) as unknown as typeof fetch
  try {
    const client = new GitHubClient("speed/repo", "placeholder")
    const fake = new Fake([row(1)])
    const result = await loadPick(client, fake.store)
    assert.deepEqual(result.rows.map(row => row.id), [row(1).id])
    assert.equal(calls, 1)
  } finally { globalThis.fetch = original }
})

for (const change of ["new PR", "new file"] as const) {
  test(`confirmation bypasses the display cache after ${change}`, async () => {
    const original = globalThis.fetch
    let calls = 0
    let changed = false
    globalThis.fetch = (async () => {
      calls++
      const count = changed || change === "new file" ? 1 : 0
      return Response.json({ data: { repository: { pullRequests: {
        nodes: Array.from({ length: count }, (_, i) => ({ number: i + 1, headRefName: "security/sqli-api-0123abcd",
          files: { nodes: [{ path: changed ? row(1).file : "other.php", changeType: "MODIFIED" }],
            pageInfo: { hasNextPage: false } } })),
        pageInfo: { hasNextPage: false },
      } } } })
    }) as unknown as typeof fetch
    try {
      const fake = new Fake([row(1)])
      const client = new GitHubClient(`fresh-${change.replaceAll(" ", "-")}/repo`, "placeholder")
      assert.equal((await loadPick(client, fake.store)).rows.length, 1)
      changed = true
      assert.equal((await loadPick(client, fake.store)).rows.length, 1)
      assert.equal(calls, 1)
      await assert.rejects(preparePick(client, fake.store, client.repo, [row(1).id]), /overlaps/)
      assert.equal(calls, 2)
      assert.equal(fake.store.writes, 0)
    } finally { globalThis.fetch = original }
  })
}

test("launch failure leaves rows unchanged, marking failure stops the run with an error", async () => {
  for (const failLaunch of [true, false]) {
    const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
    const store = await Store.open(`${dir}/test.sqlite`)
    const fake = new Fake([row(1), row(2)])
    const order: string[] = []
    fake.store.write = async () => { order.push("mark"); throw new Error("tracker write failed") }
    const stopped: string[] = []
    const launches: RunScannerArgs[] = []
    const deps = {
      createTrackerStore: async () => fake.store, store, runsRootDir: dir, maxConcurrent: 10, scannerImage: "test", getGhToken: async () => "fixture", activeRuns: new Map(),
      bus: { publish() {} },
      controller: { runScanner(args: RunScannerArgs) {
        order.push("start")
        launches.push(args)
        assert.equal(fake.store.files[0].rows[0].status, "open")
        if (failLaunch) throw new Error("launch failed")
        return {
          containerName: "test", stdin: new WritableStream().getWriter(),
          stdout: new ReadableStream({ start(c) { c.close() } }),
          stderr: new ReadableStream({ start(c) { c.close() } }),
          process: { exited: new Promise(() => {}) },
        }
      }, async stopGraceful(container: string) { stopped.push(container) } },
    }
    let payload: any
    let status = 0
    const body = { sessionId: "s1", pickedIds: [row(1).id], model: "opus", effort: "high" }
    const c = { req: { json: () => Promise.resolve(body) }, json: (value: unknown, code = 200) => { payload = value; status = code; return new Response() } } as unknown as Context
    try {
      // Exercise both entry points, including optional pickedIds on POST /runs.
      if (failLaunch) await handlePick(c, deps as never, true, fake)
      else await handleStartRun(c, deps as never, {
        ...body, repoUrl: `https://github.com/owner/repo`,
        skill: "ola-security-audit", mode: "fix",
        model: "opus", effort: "high",
      }, fake)
      assert.equal(status, 500)
      assert.deepEqual(order, failLaunch ? ["start"] : ["start", "mark"])
      assert.deepEqual(fake.store.files[0].rows.map(r => r.status), ["open", "open"])
      const error = failLaunch ? "launch failed" : "could not mark picked rows. Run stopped so the rows cannot be picked twice: tracker write failed"
      assert.equal(payload.error, error)
      assert.equal(store.getRun(payload.runId)?.status, "failed")
      assert.equal(store.getRun(payload.runId)?.error, error)
      assert.deepEqual(stopped, failLaunch ? [] : ["test"])
      assert.equal(deps.activeRuns.size, 0)
      assert.equal(launches[0].env.PICKED_FILE, "/workspace/artifacts/picked.json")
    } finally {
      store.close()
      await rm(dir, { recursive: true })
    }
  }
})

test("Batch split keeps whole files and caps files per batch", async () => {
  // 30 rows over 25 files: rows 0-4 share a file with rows 25-29.
  const rows = Array.from({ length: 30 }, (_, i) => row(i + 1, { file: `app/api/${i % 25}.php` }))
  const split = batches(rows)
  assert.deepEqual(split.map(b => new Set(b.map(r => r.file)).size), [10, 10, 5])
  assert.deepEqual(split.map(b => b.length), [15, 10, 5])
  assert.equal(split.flat().length, 30)
  const fake = new Fake(rows)
  const pick = await preparePick(fake, fake.store, "a/b", rows.map(r => r.id))
  assert.deepEqual(pick.picked.map(r => r.id), split[0].map(r => r.id))
  assert.deepEqual(pick.rest, split.slice(1).map(b => b.map(r => r.id)))
  await pick.mark()
  // Only the first batch is marked, later batches stay in Pick.
  assert.equal(fake.store.files[0].rows.filter(r => r.status === "in progress").length, 15)
  assert.equal(fake.store.files[0].rows.filter(r => r.status === "open").length, 15)
})

test("Finishing a batch carries ignored PRs to the next batch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const store = await Store.open(`${dir}/test.sqlite`)
  const launches: RunScannerArgs[] = []
  const rows = Array.from({ length: 25 }, (_, i) => row(i + 1, { file: `app/api/${i}.php` }))
  const fake = Object.assign(new Fake(rows), { prs: [] as { head: string, draft: boolean }[],
    async createPR(pr: { head: string, draft: boolean }) { this.prs.push(pr); return 100 + this.prs.length } })
  fake.openPRs = async () => [{ number: 1252, headRefName: "dev", files: rows.map(row => row.file) }]
  const pushes: string[] = []
  const activeRuns = new Map()
  const deps = {
    createTrackerStore: async () => fake.store, store, runsRootDir: dir, maxConcurrent: 10, scannerImage: "test", getGhToken: async () => "fixture", activeRuns,
    bus: { publish() {} },
    controller: { async stopAndRemove() {}, runScanner(args: RunScannerArgs) {
      launches.push(args)
      return {
        containerName: "test", stdin: new WritableStream().getWriter(),
        stdout: new ReadableStream({ start(c) { c.close() } }),
        stderr: new ReadableStream({ start(c) { c.close() } }),
        process: { exited: new Promise(() => {}) },
      }
    } },
  }
  // Simulates a completed fix run: every picked row fixed, one file changed, checks pass.
  const complete = async (runId: string, ids: string[]) => {
    activeRuns.set(runId, { pushToBranch: async (branch: string) => { pushes.push(branch); return { ok: true } } })
    for (const id of ids) store.insertFinding(runId, { id, category: "sqli", severity: "P1", status: "fixed", reason: "Bound the parameter" })
    const art = `${dir}/${runId}/artifacts`
    await writeFile(`${art}/working.patch`, "diff --git a/app/api/0.php b/app/api/0.php\n+fixed\n")
    await writeFile(`${art}/checks.json`, JSON.stringify([{ name: "lint", command: "php -l", ok: true }]))
    await writeFile(`${art}/base.json`, JSON.stringify({ sha: "x", branch: "main" }))
  }
  let payload: any
  const body = { sessionId: "s1", ignorePRs: [1252], pickedIds: rows.map(r => r.id), smokeSeconds: 17, note: "Use parameter binding.", language: "en" }
  const c = { req: { json: () => Promise.resolve(body) }, json: (value: unknown) => { payload = value; return new Response() } } as unknown as Context
  const previousDev = process.env.OLA_DEV
  process.env.OLA_DEV = "1"
  try {
    await handlePick(c, deps as never, true, fake)
    const first = payload.runId
    const firstIds = launches[0].env.PICKED_IDS!.split(",")
    assert.equal(firstIds.length, 10)
    assert.equal(queuedBatches.get(first)?.rest.length, 2)
    assert.deepEqual(queuedBatches.get(first)?.body.ignorePRs, [1252])
    assert.equal(queuedBatches.get(first)?.body.smokeSeconds, 17)
    assert.equal(launches[0].env.SMOKE_SECONDS, "17")
    await complete(first, firstIds)
    const second = await finishBatch(deps as never, first, fake)
    assert.ok(second)
    assert.deepEqual(fake.prs.map(pr => pr.draft), [false])
    assert.match(pushes[0], /^security\/sqli-app-api-/)
    assert.deepEqual(firstIds.map(id => fake.store.files[0].rows.find(r => r.id === id)!.status), Array(10).fill("in progress"))
    assert.equal(fake.store.files[0].rows.find(r => r.id === firstIds[0])!.pr, `[PR #101](https://github.com/owner/repo/pull/101)`)
    assert.deepEqual(launches[1].env.PICKED_IDS!.split(","), rows.slice(10, 20).map(r => r.id))
    assert.equal(queuedBatches.get(second!)?.rest.length, 1)
    assert.deepEqual(queuedBatches.get(second!)?.body.ignorePRs, [1252])
    assert.equal(queuedBatches.get(second!)?.body.smokeSeconds, 17)
    assert.equal(launches[1].env.SMOKE_SECONDS, "17")
    assert.equal(launches[1].env.OUTPUT_LANGUAGE, "en")
    assert.equal(store.getRun(second!)?.language, "en")
    for (const launch of launches) {
      const context = JSON.parse(await readFile(`${launch.artifactsHostDir}/repo-context.json`, "utf8"))
      assert.deepEqual(context.find((document: { path: string }) => document.path === "operator-note.md"),
        { path: "operator-note.md", content: body.note })
    }
    assert.equal(queuedBatches.has(first), false)
    await complete(second!, launches[1].env.PICKED_IDS!.split(","))
    const third = await finishBatch(deps as never, second!, fake)
    assert.ok(third)
    assert.equal(fake.prs.length, 2)
    assert.deepEqual(launches[2].env.PICKED_IDS!.split(","), rows.slice(20).map(r => r.id))
    assert.equal(queuedBatches.has(third!), false)
  } finally {
    if (previousDev === undefined) delete process.env.OLA_DEV
    else process.env.OLA_DEV = previousDev
    queuedBatches.clear(); store.close(); await rm(dir, { recursive: true })
  }
})

test("Row refresh follows PR states and writes nothing on a second pass", async () => {
  const pr = (n: number) => `[PR #${n}](https://github.com/a/b/pull/${n})`
  const fake = new Fake([row(1, { status: "in progress", pr: pr(7) }), row(2, { status: "in progress", pr: pr(8) }),
    row(3, { status: "in progress", pr: pr(9) }), row(4, { status: "in progress", pr: pr(7) }), row(5)])
  fake.states = { 7: "merged", 8: "closed" }
  let reads = 0
  const prState = fake.prState.bind(fake)
  fake.prState = (n: number) => { reads++; return prState(n) }
  assert.equal(await refreshRows(fake, fake.store, "a/b"), 1)
  const byId = (n: number) => fake.store.files[0].rows.find(r => r.id === row(n).id)!
  assert.deepEqual([1, 2, 3, 4, 5].map(n => byId(n).status), ["fixed", "open", "in progress", "fixed", "open"])
  assert.equal(byId(1).pr, pr(7))
  assert.equal(byId(2).pr, "")
  assert.equal(reads, 3)
  assert.equal(await refreshRows(fake, fake.store, "a/b"), 0)
  assert.equal(fake.store.writes, 1)
})

test("Row refresh reopens a row stuck in progress without a PR, unless a run holds it", async () => {
  const fake = new Fake([row(1, { status: "in progress" }), row(2, { status: "in progress" })])
  // Without the held set, as before, the rows stay.
  assert.equal(await refreshRows(fake, fake.store, "a/b"), 0)
  assert.equal(await refreshRows(fake, fake.store, "a/b", new Set([row(2).id])), 1)
  assert.deepEqual(fake.store.files[0].rows.map(r => r.status), ["open", "in progress"])
})

test("GitHub PR state reads merged, closed and open", async () => {
  const original = globalThis.fetch
  const prs: Record<string, unknown> = { 1: { state: "closed", merged_at: "2026-10-01T00:00:00Z" }, 2: { state: "closed", merged_at: null }, 3: { state: "open", merged_at: null } }
  globalThis.fetch = ((input: string | URL | Request) => Promise.resolve(Response.json(prs[String(input).split("/").pop()!]))) as unknown as typeof fetch
  try {
    const client = new GitHubClient("a/b", "placeholder")
    assert.deepEqual([await client.prState(1), await client.prState(2), await client.prState(3)], ["merged", "closed", "open"])
  } finally { globalThis.fetch = original }
})

test("Row refresh looks up PR states for all tracker files at once", async () => {
  const pr = (n: number) => `[PR #${n}](https://github.com/a/b/pull/${n})`
  const store = new MemoryStore(["sqli", "cors", "weak-hash"].map((category, i) =>
    row(i + 1, { category, status: "in progress", pr: pr(i + 1) })))
  let inFlight = 0
  let peak = 0
  const client: PickClient = {
    openPRFiles: async () => [],
    prState: async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise(resolve => setTimeout(resolve, 20))
      inFlight--
      return "open"
    },
  }
  store.write = async () => { throw new Error("no row changes, so nothing is written") }
  assert.equal(await refreshRows(client, store, "a/b"), 0)
  assert.equal(peak, 3)
})

test("A scan start does not wait for the row refresh, but still starts it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const store = await Store.open(`${dir}/test.sqlite`)
  const launches: RunScannerArgs[] = []
  setKnownRepos(() => ["a/b"])
  let refreshStarted = false
  let finishRefresh!: (files: TrackerFile[]) => void
  const pending = new Promise<TrackerFile[]>(resolve => { finishRefresh = resolve })
  // The refresh answers after the assertion, so a start that waited would hang.
  const fake = new Fake([])
  fake.store.read = () => { refreshStarted = true; return pending }
  const deps = {
    createTrackerStore: async () => fake.store, store, runsRootDir: dir, maxConcurrent: 10, scannerImage: "test", getGhToken: async () => "fixture", activeRuns: new Map(),
    bus: { publish() {} }, controller: { runScanner(args: RunScannerArgs) {
      launches.push(args)
      return {
        containerName: "test", stdin: new WritableStream().getWriter(),
        stdout: new ReadableStream({ start(c) { c.close() } }),
        stderr: new ReadableStream({ start(c) { c.close() } }),
        process: { exited: new Promise(() => {}) },
      }
    } },
  }
  let status = 0
  const c = { json: (_: unknown, code = 200) => { status = code; return new Response() } } as unknown as Context
  try {
    await handleStartRun(c, deps as never, { sessionId: "s1", repoUrl: "https://github.com/a/b", skill: "ola-security-audit",
      model: "sonnet", effort: "high", mode: "scan" }, fake)
    assert.equal(status, 201)
    assert.equal(launches.length, 1)
    assert.equal(refreshStarted, true)
  } finally {
    finishRefresh([])
    store.close()
    await rm(dir, { recursive: true })
  }
})

test("handlePick streams SSE events and keeps rows held by an unfinished run", async () => {
  const fake = new Fake([row(1), row(2), row(3, { status: "in progress" })])
  const runsRootDir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  await Bun.write(join(runsRootDir, "held-run", "artifacts", "picked.json"), JSON.stringify([{ id: row(3).id }]))
  let heldReads = 0
  const deps = { createTrackerStore: async () => fake.store, runsRootDir, store: { listUnfinishedRuns: () => { heldReads++; return [{ runId: "held-run" }] }, stoppedRunIds: () => [] } }
  fake.openPRFiles = async (onBatch?: (files: string[], checked: number, total: number) => void) => {
    onBatch?.([row(2).file], 1, 2)
    onBatch?.([], 2, 2)
    return [row(2).file]
  }
  setKnownRepos(() => ["stream/repo"])
  try {
    const c = {
      req: {
        header: (name: string) => (name.toLowerCase() === "accept" ? "text/event-stream" : undefined),
        query: () => undefined,
      },
    } as unknown as Context
    const res = await handlePick(c, deps as never, false, fake)
    assert.equal(res.headers.get("Content-Type"), "text/event-stream; charset=utf-8")
    const text = await res.text()
    const lines = text.split("\n\n").filter(Boolean)
    assert.equal(lines.length, 4)
    const events = lines.map(line => JSON.parse(line.replace(/^data:\s*/, "")))
    assert.equal(events[0].type, "init")
    assert.equal(events[0].rows.length, 2)
    assert.equal(events[1].type, "progress")
    assert.equal(events[1].rows.length, 1)
    assert.equal(events[1].checkedPRs, 1)
    assert.equal(events[2].type, "progress")
    assert.equal(events[2].checkedPRs, 2)
    assert.equal(events[3].type, "done")
    assert.equal(events[3].rows.length, 1)
    assert.equal(heldReads, 1)
    assert.equal(fake.store.files[0].rows.find(r => r.id === row(3).id)?.status, "in progress")
    assert.equal(fake.store.writes, 0)
  } finally {
    await rm(runsRootDir, { recursive: true })
  }
})

test("Pick includes vendor CVE rows and groups them by package", () => {
  const row = (id: string, extra: Partial<Row>): Row => ({ id, category: "misc", file: "app/a.php", lines: [1], severity: "P2",
    status: "open", reason: "r", date: "19-10-2026", pr: "", kind: "auth", ...extra })
  const rows = [row("vendor", { kind: "vendor-cve", file: "example/client@1.2.3", severity: "P1" }), row("code", {})]
  assert.deepEqual(candidates(rows, []).map(row => row.id), ["vendor", "code"])
  assert.equal(subsystem(rows[0]), "example/client")
  assert.equal(batches([rows[0], { ...rows[0], id: "copy" }, rows[1]], 1).length, 2)
})


test("Pick excludes vendor packages when an open PR touches any listed tree, its lockfile or its patch log", () => {
  const vendor = row(1, { category: "vendor-cve", file: "guzzlehttp/guzzle@6.3.3", reason: "Advisory. Trees: lib/vendor, tools/vendor" })
  for (const file of ["lib/vendor/guzzlehttp/guzzle/src/Client.php", "tools/vendor/guzzlehttp/guzzle/src/Client.php",
    "lib/vendor/composer/installed.json", "lib/composer.lock", "tools/composer.lock", "lib/vendor/guzzlehttp/psr7/src/Uri.php",
    "lib/VENDOR_PATCHES.md", "./tools/VENDOR_PATCHES.md"]) {
    assert.deepEqual(candidates([vendor], [file]), [], file)
  }
  for (const file of ["other/vendor/guzzlehttp/guzzle/src/Client.php", "lib/composer.json", "VENDOR_PATCHES.md", "other/VENDOR_PATCHES.md"]) {
    assert.equal(candidates([vendor], [file]).length, 1)
  }
})


test("Pick excludes a root vendor tree when an open PR touches its patch log", () => {
  const vendor = row(1, { category: "vendor-cve", file: "guzzlehttp/guzzle@6.3.3", reason: "Advisory. Trees: vendor" })
  assert.deepEqual(candidates([vendor], ["VENDOR_PATCHES.md"]), [])
  assert.equal(candidates([vendor], ["lib/VENDOR_PATCHES.md"]).length, 1)
  for (const trees of ["./vendor", "vendor/"]) {
    assert.deepEqual(candidates([{ ...vendor, reason: `Advisory. Trees: ${trees}` }], ["VENDOR_PATCHES.md"]), [], trees)
  }
  const nested = { ...vendor, reason: "Advisory. Trees: sdk/vendor/" }
  assert.deepEqual(candidates([nested], ["sdk/VENDOR_PATCHES.md"]), [])
  assert.deepEqual(candidates([nested], ["sdk/composer.lock"]), [])
})

test("Ignore keeps the row as ignored with both reasons in the store and a log entry", async () => {
  const fake = new Fake([row(1, { reason: "agent said P1" }), row(2)])
  assert.equal(await ignoreRows(fake, fake.store, "owner/repo", [row(1).id], "  Test-only endpoint  "), 1)
  assert.deepEqual([1, 2].map(n => fake.store.files[0].rows.find(r => r.id === row(n).id)).map(r => [r?.status, r?.reason]), [["ignored", "Ignored: Test-only endpoint\nEarlier reason: agent said P1"], ["open", ""]])
  assert.deepEqual(fake.store.files[0].log, [{ at: "now", message: "Ignored 1 row(s): Test-only endpoint" }])
  // An ignored row stays out of Pick.
  assert.deepEqual(candidates(fake.store.files[0].rows, []).map(r => r.id), [row(2).id])
})

test("Ignore refuses a bad reason, a missing row or a row a run holds, and writes nothing", async () => {
  const fake = new Fake([row(1), row(2, { status: "in progress" })])
  await assert.rejects(ignoreRows(fake, fake.store, "owner/repo", [row(1).id], " "), /reason/)
  await assert.rejects(ignoreRows(fake, fake.store, "owner/repo", [row(1).id], "x".repeat(501)), /reason/)
  await assert.rejects(ignoreRows(fake, fake.store, "owner/repo", [row(9).id], "why"), /reload the page/)
  await assert.rejects(ignoreRows(fake, fake.store, "owner/repo", [row(1).id, row(2).id], "why"), /not open/)
  await assert.rejects(ignoreRows(fake, fake.store, "owner/repo", [row(1).id], "why", new Set([row(1).id])), /not open/)
  assert.equal(fake.store.writes, 0)
})

test("Reopen puts an ignored row back in Pick and keeps why it was ignored", async () => {
  const fake = new Fake([row(1, { reason: "agent analysis" }), row(2), row(3, { status: "ignored", reason: "false positive from a fix run" })])
  await assert.rejects(reopenRows(fake, fake.store, "owner/repo", [row(2).id]), /not ignored/)
  await ignoreRows(fake, fake.store, "owner/repo", [row(1).id], "Test-only endpoint")
  assert.equal(await reopenRows(fake, fake.store, "owner/repo", [row(1).id, row(3).id]), 2)
  const reason = (n: number) => fake.store.files[0].rows.find(r => r.id === row(n).id)?.reason
  // Reopen restores the reason from before Ignore, and keeps a fix run's reason as it is.
  assert.deepEqual([reason(1), reason(3)], ["agent analysis", "false positive from a fix run"])
  assert.deepEqual(fake.store.files[0].log.map(entry => entry.message), ["Ignored 1 row(s): Test-only endpoint", "Reopened 2 row(s)"])
  assert.deepEqual(candidates(fake.store.files[0].rows, []).map(r => r.id).sort(), [row(1).id, row(2).id, row(3).id].sort())
})

test("Needs human keeps severity and both reasons, and Reopen restores the earlier reason", async () => {
  const fake = new Fake([row(1, { severity: "P0", reason: "agent analysis\nMore detail" }), row(2)])
  assert.equal(await needsHumanRows(fake, fake.store, "owner/repo", [row(1).id], "  Protocol needs an owner decision  "), 1)
  const human = fake.store.files[0].rows.find(r => r.id === row(1).id)!
  assert.equal(human.status, "needs human")
  assert.equal(human.severity, "P0")
  assert.equal(human.reason, "Needs human: Protocol needs an owner decision\nEarlier reason: agent analysis\nMore detail")
  assert.deepEqual((await loadPick(fake, fake.store)).rows.map(r => r.id), [row(2).id])
  assert.deepEqual(fake.store.files[0].log.map(entry => entry.message), ["Needs human for 1 row(s): Protocol needs an owner decision"])
  assert.equal(await reopenRows(fake, fake.store, "owner/repo", [row(1).id]), 1)
  const reopened = fake.store.files[0].rows.find(r => r.id === row(1).id)!
  assert.equal(reopened.status, "open")
  assert.equal(reopened.severity, "P0")
  assert.equal(reopened.reason, "agent analysis\nMore detail")
  assert.ok((await loadPick(fake, fake.store)).rows.some(r => r.id === row(1).id))
})

test("Needs human refuses invalid reasons, IDs, held rows and rows in a PR without writing", async () => {
  const fake = new Fake([row(1), row(2, { status: "in PR", pr: "[PR #7](https://github.com/owner/repo/pull/7)" })])
  for (const reason of [undefined, null, 123, "", " ", "x".repeat(501)]) {
    await assert.rejects(needsHumanRows(fake, fake.store, "owner/repo", [row(1).id], reason), /reason/)
  }
  for (const ids of [[], [row(1).id, row(1).id]]) {
    await assert.rejects(needsHumanRows(fake, fake.store, "owner/repo", ids, "why"), /unique row ids/)
  }
  await assert.rejects(needsHumanRows(fake, fake.store, "owner/repo", [row(9).id], "why"), /reload the page/)
  await assert.rejects(needsHumanRows(fake, fake.store, "owner/repo", [row(1).id], "why", new Set([row(1).id])), /not open/)
  await assert.rejects(needsHumanRows(fake, fake.store, "owner/repo", [row(1).id, row(2).id], "why"), /not open/)
  assert.equal(fake.store.writes, 0)
  assert.equal(fake.store.files[0].rows[0].status, "open")
})

for (const change of [ignoreRows, needsHumanRows]) {
  test(`${change.name} refuses operator text that can spoof the earlier reason`, async () => {
    const fake = new Fake([row(1, { reason: "agent analysis\nEarlier reason: original detail" })])
    for (const reason of ["Review\nMore detail", "Review\nEarlier reason: spoofed", "Review\r\nEarlier reason: spoofed", "Review\rEarlier reason: spoofed", "Review · Earlier reason: spoofed"]) {
      await assert.rejects(change(fake, fake.store, "owner/repo", [row(1).id], reason), /reason/)
    }
    assert.equal(fake.store.writes, 0)
    await change(fake, fake.store, "owner/repo", [row(1).id], "Owner decision")
    await reopenRows(fake, fake.store, "owner/repo", [row(1).id])
    assert.equal(fake.store.files[0].rows[0].reason, "agent analysis\nEarlier reason: original detail")
  })
}

test("Reopen keeps a fix agent's needs-human reason and handles a row with no earlier reason", async () => {
  const fake = new Fake([row(1, { status: "needs human", reason: "Owner review required" }), row(2)])
  await needsHumanRows(fake, fake.store, "owner/repo", [row(2).id], "x".repeat(500))
  assert.equal(await reopenRows(fake, fake.store, "owner/repo", [row(1).id, row(2).id]), 2)
  assert.deepEqual(fake.store.files[0].rows.map(r => [r.status, r.reason]), [["open", "Owner review required"], ["open", ""]])
})

test("Needs human handler shares the Pick lock, checks held rows and accepts Reopen", async () => {
  const fake = new Fake([row(1), row(2, { status: "in PR" })])
  const runsRootDir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  await Bun.write(join(runsRootDir, "held-run", "artifacts", "picked.json"), JSON.stringify([{ id: row(1).id }]))
  let held = true
  const deps = { createTrackerStore: async () => fake.store, runsRootDir, store: { listUnfinishedRuns: () => held ? [{ runId: "held-run" }] : [], stoppedRunIds: () => [] } }
  const app = new Hono()
  for (const action of ["needs-human", "reopen"] as const) {
    app.post(`/api/pick/${action}`, c => handleRowChange(c, deps as never, action, fake))
  }
  const post = (ids = [row(1).id], reason?: string, action = "needs-human") => app.request(`/api/pick/${action}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: "owner/repo", ids, reason }),
  })
  try {
    confirming.add("owner/repo")
    assert.equal((await post([row(1).id], "Owner decision")).status, 409)
    confirming.delete("owner/repo")
    const heldResponse = await post([row(1).id], "Owner decision")
    assert.equal(heldResponse.status, 400)
    assert.match((await heldResponse.json()).error, /not open/)
    held = false
    assert.equal((await post()).status, 400)
    assert.equal((await post([row(2).id], "Owner decision")).status, 400)
    assert.equal(fake.store.writes, 0)
    const marked = await post([row(1).id], "Owner decision")
    assert.equal(marked.status, 200)
    assert.deepEqual(await marked.json(), { changed: 1 })
    assert.equal(fake.store.files[0].rows.find(r => r.id === row(1).id)!.status, "needs human")
    assert.equal((await post([row(1).id], undefined, "reopen")).status, 200)
    assert.equal(fake.store.files[0].rows.find(r => r.id === row(1).id)!.status, "open")
    assert.equal(confirming.has("owner/repo"), false)
  } finally {
    confirming.delete("owner/repo")
    await rm(runsRootDir, { recursive: true, force: true })
  }
})

test("A rescan does not bring an ignored row back", async () => {
  const fake = new Fake([row(1)])
  await ignoreRows(fake, fake.store, "owner/repo", [row(1).id], "Test-only endpoint")
  const r = row(1)
  await new Tracker(fake.store, "owner/repo").scan("sqli", [{ id: r.id, category: r.category, file: r.file, line: r.lines[0], severity: r.severity, status: "open", reason: "found again" }], "Scan x: found")
  assert.deepEqual(fake.store.files[0].rows.map(x => x.status), ["ignored"])
  assert.equal(candidates(fake.store.files[0].rows, []).length, 0)
})

for (const [status, prefix] of [["ignored", "Ignored"], ["needs human", "Needs human"]] as const) {
  for (const separator of [" · ", "\n"]) {
    test(`Reopen reads existing ${status} rows with ${JSON.stringify(separator)}`, async () => {
      const fake = new Fake([row(4, { status, reason: `${prefix}: old style${separator}Earlier reason: kept` })])
      await reopenRows(fake, fake.store, "owner/repo", [row(4).id])
      assert.equal(fake.store.files[0].rows[0].reason, "kept")
    })
  }
}

for (const failAt of [0, 1, 2, 3]) {
  test(`refresh promotes misc kinds without changing fields, retrying write failure ${failAt}`, async () => {
    const legacy = [
      row(1, { category: "misc", kind: "tls-verify-off", status: "in progress", reason: "Owner review | keep this", pr: "[PR #7](https://github.com/a/b/pull/7)" }),
      row(2, { category: "misc", kind: "tls-verify-off", status: "fixed", lines: [12, 40], pr: "[PR #8](https://github.com/a/b/pull/8)" }),
      row(3, { category: "misc", kind: "vendor-cve", status: "ignored", file: "example/client@1.2.3.4", reason: "Accepted advisory", pr: "[PR #9](https://github.com/a/b/pull/9)" }),
      row(4, { category: "misc", kind: "tls-verify-off", status: "in progress" }),
    ]
    const unrelated = row(5, { category: "misc", kind: "idor" })
    const targetRow = row(6, { category: "tls-verify-off", status: "ignored" })
    const store = new MemoryStore([...legacy, unrelated, targetRow])
    const note = { at: "earlier", message: "Human note" }
    store.files[0].log.push(note)
    let writes = 0
    let failed = false
    const write = store.write.bind(store)
    store.write = async (...args) => {
      writes++
      if (!failed && writes === failAt) { failed = true; throw new Error("write failed") }
      return write(...args)
    }
    const client: PickClient = {
      async prState() { throw new Error("promotion must not refresh moved statuses") },
      async openPRFiles() { return [] },
    }
    const file = (category: string) => store.files.find(file => file.category === category)!
    if (failAt) {
      await assert.rejects(() => refreshRows(client, store, "a/b", new Set()), /write failed/)
      assert.equal(file("misc").rows.length, 5)
    }
    await refreshRows(client, store, "a/b", new Set())
    assert.deepEqual(file("misc").rows, [unrelated])
    for (const { kind, ...original } of legacy) {
      const moved = file(kind!).rows.find(row => row.id === original.id)
      assert.deepEqual(moved, { ...original, category: kind })
    }
    assert.deepEqual(file("misc").log, [note])
    assert.ok(store.files.filter(file => file.category !== "misc").every(file => file.log.length === 0))
    assert.deepEqual(file("tls-verify-off").rows.find(row => row.id === targetRow.id), targetRow)
    const before = writes
    // A later refresh still follows PR state normally. All PRs stay open here.
    client.prState = async () => "open"
    await refreshRows(client, store, "a/b")
    assert.equal(writes, before)
  })
}

test("new and legacy vendor categories share grouping and tree overlap rules", () => {
  for (const type of [{ category: "vendor-cve" }, { category: "misc", kind: "vendor-cve" }]) {
    const vendor = row(1, { ...type, file: "example/client@1.2.3", reason: "Trees: lib/vendor" })
    assert.equal(subsystem(vendor), "example/client")
    assert.deepEqual(candidates([vendor], ["lib/vendor/client.php"]), [])
    assert.equal(candidates([vendor], []).length, 1)
  }
})

test("Pick reports hidden rows, blockers and limits, and ignored PRs only remove their own blocks", async () => {
  const fake = new Fake([row(1), row(2), row(3, { status: "needs human" })])
  const prs = [
    { number: 1252, headRefName: "dev", files: [row(1).file, row(2).file, row(3).file] },
    { number: 7, headRefName: "security/sqli-api-0123abcd", files: [row(2).file] },
  ]
  fake.openPRs = async onBatch => { onBatch?.(prs, 2, 2); return prs }
  const result = await loadPick(fake, fake.store)
  assert.deepEqual(result.rows, [])
  assert.deepEqual(result.hidden.map(row => [row.id, row.blockedBy]), [[row(1).id, [1252]], [row(2).id, [1252, 7]]])
  assert.deepEqual(Object.keys(result.hidden[0]), ["id", "category", "file", "lines", "severity", "blockedBy"])
  assert.deepEqual(result.limits, { maxFilesPerBatch: 10 })
  const ignored = await loadPick(fake, fake.store, [1252])
  assert.deepEqual(ignored.rows.map(row => row.id), [row(1).id])
  assert.deepEqual(ignored.hidden.map(row => row.blockedBy), [[7]])
  const updates: any[] = []
  await streamPick(fake, fake.store, update => updates.push(update), [1252])
  for (const update of updates.filter(update => update.type !== "init")) {
    assert.deepEqual(update.hidden, ignored.hidden)
    assert.deepEqual(update.limits, result.limits)
    assert.deepEqual(update.rows.map((row: Row) => row.id), [row(1).id])
  }
  await assert.rejects(preparePick(fake, fake.store, "owner/repo", [row(1).id]), /overlaps/)
  assert.equal((await preparePick(fake, fake.store, "owner/repo", [row(1).id], [1252])).picked[0].id, row(1).id)
  await assert.rejects(preparePick(fake, fake.store, "owner/repo", [row(3).id], [1252]), /selection changed/)
})

test("GET Pick accepts repeated ignorePR parameters in JSON and SSE", async () => {
  const fake = new Fake([row(1), row(2)])
  fake.openPRs = async onBatch => {
    const prs = [1252, 7].map(number => ({ number, headRefName: "dev", files: [row(1).file] }))
    onBatch?.(prs, 2, 2)
    return prs
  }
  const deps = { createTrackerStore: async () => fake.store, runsRootDir: "/tmp", store: { listUnfinishedRuns: () => [], stoppedRunIds: () => [] } }
  const app = new Hono().get("/api/pick", c => handlePick(c, deps as never, false, fake))
  const res = await app.request("/api/pick?ignorePR=1252&ignorePR=7")
  assert.equal(res.status, 200)
  const body = await res.json() as any
  assert.deepEqual(body.rows.map((row: Row) => row.id), [row(1).id, row(2).id])
  assert.deepEqual(body.hidden, [])
  assert.equal(body.limits.maxFilesPerBatch, 10)
  const stream = await app.request("/api/pick?stream=1&ignorePR=1252&ignorePR=7")
  const events = (await stream.text()).trim().split("\n\n").map(line => JSON.parse(line.replace(/^data: /, "")))
  assert.deepEqual(events.at(-1).rows, body.rows)
  assert.deepEqual(events.at(-1).hidden, body.hidden)
  assert.deepEqual(events.at(-1).limits, body.limits)
  for (const value of ["0", "-1", "1x", "9007199254740992", ""]) {
    assert.equal((await app.request(`/api/pick?ignorePR=${value}`)).status, 400)
  }
})

test("Pick confirmation maps GitHub failures to 502 and keeps validation errors at 400", async () => {
  const fake = new Fake([row(1)])
  const deps = { createTrackerStore: async () => fake.store, runsRootDir: "/tmp", maxConcurrent: 1, getGhToken: async () => "fixture",
    store: { countActive: () => 0, reserveStart: () => () => {}, listUnfinishedRuns: () => [], stoppedRunIds: () => [] } }
  const app = new Hono().post("/api/pick", c => handlePick(c, deps as never, true, fake))
  const post = (extra: object = {}) => app.request("/api/pick", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "s1", pickedIds: [row(1).id], ...extra }) })
  for (const ignorePRs of [[0], [-1], [1.5], ["7"], {}, "7", null]) {
    assert.equal((await post({ ignorePRs })).status, 400)
  }
  assert.equal((await post({ pickedIds: [] })).status, 400)
  fake.openPRFiles = async () => { throw new Error("tracker GitHub request failed (503)") }
  const failed = await post()
  assert.equal(failed.status, 502)
  assert.match((await failed.json() as any).error, /GitHub/)
  assert.ok(!confirming.has("owner/repo"))
})

for (const stream of [false, true]) {
  test(`GET Pick ${stream ? "SSE" : "JSON"} reads tracker files once per request while PRs are loading`, async () => {
    const repo = `overlap-${stream}/repo`
    setKnownRepos(() => [repo])
    const fake = new Fake([row(1), row(2)])
    const read = fake.store.read.bind(fake.store)
    let reads = 0
    let prReads = 0
    let loadingPRs = false
    let release!: () => void
    fake.openPRs = async (_onBatch, useCache) => {
      assert.equal(useCache, true)
      prReads++
      loadingPRs = true
      await new Promise<void>(resolve => { release = resolve })
      loadingPRs = false
      return [{ number: 7, headRefName: "dev", files: [row(2).file] }]
    }
    fake.store.read = async () => {
      reads++
      assert.equal(loadingPRs, true)
      release()
      return read()
    }
    const deps = { createTrackerStore: async () => fake.store, runsRootDir: "/tmp", store: { listUnfinishedRuns: () => [], stoppedRunIds: () => [] } }
    const app = new Hono().get("/api/pick", c => handlePick(c, deps as never, false, fake))
    for (let request = 1; request <= 2; request++) {
      const res = await app.request(`/api/pick?repo=${repo}${stream ? "&stream=1" : ""}`)
      assert.equal(res.status, 200)
      const body = stream ? (await res.text()).trim().split("\n\n").map(line => JSON.parse(line.slice(6))).at(-1)
        : await res.json() as any
      assert.deepEqual(body.rows.map((row: Row) => row.id), [row(1).id])
      assert.deepEqual(body.hidden.map((row: { blockedBy: number[] }) => row.blockedBy), [[7]])
      assert.equal(reads, request)
      assert.equal(prReads, request)
    }
  }, 1000)
}

for (const change of ["write", "write failure", "list failure", "state failure"] as const) {
  test(`GET Pick rereads tracker files after refresh ${change}`, async () => {
    const repo = `refresh-${change.replaceAll(" ", "-")}/repo`
    setKnownRepos(() => [repo])
    const fake = new Fake([row(1, { status: "in progress", pr: "[PR #7](https://github.com/a/b/pull/7)" })])
    const read = fake.store.read.bind(fake.store)
    let reads = 0
    fake.store.read = async () => {
      reads++
      if (change === "list failure" && reads === 1) throw new Error("tracker GitHub request failed (503)")
      return read()
    }
    fake.prStates = async () => {
      if (change === "state failure") {
        fake.store.files[0].rows = [row(2)]
        throw new Error("tracker GitHub request failed (503)")
      }
      return new Map([[7, "closed"]])
    }
    if (change === "write failure") fake.store.write = async () => {
      fake.store.files[0].rows = [row(2)]
      throw new Error("tracker GitHub request failed (503)")
    }
    const deps = { createTrackerStore: async () => fake.store, runsRootDir: "/tmp", store: { listUnfinishedRuns: () => [], stoppedRunIds: () => [] } }
    const app = new Hono().get("/api/pick", c => handlePick(c, deps as never, false, fake))
    const res = await app.request(`/api/pick?repo=${repo}`)
    assert.equal(res.status, 200)
    const body = await res.json() as any
    const expected = change === "write" ? [row(1).id] : change === "list failure" ? [] : [row(2).id]
    assert.deepEqual(body.rows.map((row: Row) => row.id), expected)
    assert.equal(reads, 2)
  })
}

test("POST Pick rereads tracker files after a GET instead of confirming its snapshot", async () => {
  const repo = "fresh-post/repo"
  setKnownRepos(() => [repo])
  const fake = new Fake([row(1)])
  const read = fake.store.read.bind(fake.store)
  let reads = 0
  fake.store.read = async () => { reads++; return read() }
  const deps = { createTrackerStore: async () => fake.store, runsRootDir: "/tmp", maxConcurrent: 1, getGhToken: async () => "fixture",
    store: { countActive: () => 0, reserveStart: () => () => {}, listUnfinishedRuns: () => [], stoppedRunIds: () => [] } }
  const app = new Hono().get("/api/pick", c => handlePick(c, deps as never, false, fake))
    .post("/api/pick", c => handlePick(c, deps as never, true, fake))
  assert.equal((await app.request(`/api/pick?repo=${repo}`)).status, 200)
  assert.equal(reads, 1)
  fake.store.files[0].rows[0].status = "fixed"
  const res = await app.request("/api/pick", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo, sessionId: "s1", pickedIds: [row(1).id] }) })
  assert.equal(res.status, 400)
  assert.match((await res.json() as any).error, /selection changed/)
  assert.equal(reads, 3)
  assert.equal(fake.store.writes, 0)
})

test("overlapped open-PR failures keep the JSON 502 and SSE error responses", async () => {
  for (const stream of [false, true]) {
    const fake = new Fake([row(1)])
    fake.openPRs = async () => { throw new Error("tracker GitHub request failed (503)") }
    const deps = { createTrackerStore: async () => fake.store, runsRootDir: "/tmp", store: { listUnfinishedRuns: () => [], stoppedRunIds: () => [] } }
    const app = new Hono().get("/api/pick", c => handlePick(c, deps as never, false, fake))
    const res = await app.request(`/api/pick${stream ? "?stream=1" : ""}`)
    assert.equal(res.status, stream ? 200 : 502)
    if (stream) {
      const events = (await res.text()).trim().split("\n\n").map(line => JSON.parse(line.slice(6)))
      assert.equal(events.at(-1).type, "error")
      assert.equal(events.at(-1).error, "tracker GitHub request failed (503)")
    } else assert.deepEqual(await res.json(), { error: "tracker GitHub request failed (503)" })
  }
})

test("read refresh coalesces and runs at most once per minute per repo", async () => {
  const original = Date.now
  let now = original()
  Date.now = () => now
  const fake = new Fake([row(1, { status: "in progress" })])
  let reads = 0
  const read = fake.store.read.bind(fake.store)
  fake.store.read = async () => { reads++; return read() }
  try {
    await Promise.all([refreshReadRows(fake, fake.store, "rate/repo", new Set()), refreshReadRows(fake, fake.store, "rate/repo", new Set())])
    assert.equal(reads, 2)
    assert.equal(fake.store.writes, 1)
    fake.store.files[0].rows[0].status = "in progress"
    now += 59_999
    await refreshReadRows(fake, fake.store, "rate/repo", new Set())
    assert.equal(reads, 2)
    assert.equal(fake.store.writes, 1)
    now++
    await refreshReadRows(fake, fake.store, "rate/repo", new Set())
    assert.equal(reads, 4)
    assert.equal(fake.store.writes, 2)
    await refreshReadRows(fake, fake.store, "rate/other", new Set())
    assert.equal(reads, 5)
  } finally { Date.now = original }
})

test("refresh batches PR states and preserves human edits made during the lookup", async () => {
  const pr = (n: number) => `[PR #${n}](https://github.com/a/b/pull/${n})`
  const fake = new Fake([row(1, { status: "in progress", pr: pr(7) }), row(2, { status: "in progress", pr: pr(7) }),
    row(3, { status: "in progress", pr: pr(8) })])
  let batches = 0
  fake.prState = async () => { throw new Error("use the batch") }
  fake.prStates = async numbers => {
    batches++
    assert.deepEqual(numbers, [7, 8])
    fake.store.files[0].rows[0] = { ...fake.store.files[0].rows[0], reason: "Human evidence", severity: "P2" }
    fake.store.files[0].rows[1].status = "needs human"
    fake.store.files[0].rows[2].pr = pr(9)
    fake.store.files[0].rows.push(row(4))
    fake.store.files[0].log.push({ at: "now", message: "New human note" })
    return new Map([[7, "merged"], [8, "closed"]])
  }
  assert.equal(await refreshRows(fake, fake.store, "race/repo"), 1)
  assert.equal(batches, 1)
  assert.deepEqual(fake.store.files[0].log, [{ at: "now", message: "New human note" }])
  const byId = (n: number) => fake.store.files[0].rows.find(row => row.id === n.toString(16).padStart(64, "0"))!
  assert.deepEqual([byId(1).status, byId(1).severity, byId(1).reason], ["fixed", "P2", "Human evidence"])
  assert.equal(byId(2).status, "needs human")
  assert.equal(byId(3).pr, pr(9))
  assert.equal(byId(3).status, "in progress")
  assert.equal(byId(4).status, "open")
})

test("background misc promotion does not take the Pick confirmation lock", async () => {
  const repo = "background/repo"
  const source = row(1, { category: "misc", kind: "sqli" })
  const store = new MemoryStore([source])
  let moves = 0
  const write = store.write.bind(store)
  store.write = async (file, rows, message) => {
    assert.ok(!confirming.has(repo))
    if (file.category === "sqli") moves++
    return write(file, rows, message)
  }
  const client: PickClient = {
    async openPRFiles() { return [] },
    async prState() { return "open" },
    async prStates() { return new Map() },
  }
  await refreshRows(client, store, repo, new Set())
  assert.equal(moves, 1)
  assert.deepEqual(store.files.find(file => file.category === "misc")!.rows, [])
  assert.equal(store.files.find(file => file.category === "sqli")!.rows[0].id, source.id)
})

test("Reopen keeps an agent reason that starts like an operator one and clears a trimmed empty earlier reason", async () => {
  const fake = new Fake([
    row(1, { status: "needs human", reason: "Needs human: owner must approve" }),
    row(2, { status: "ignored", reason: "Ignored: duplicate\nEarlier reason:" }),
  ])
  assert.equal(await reopenRows(fake, fake.store, "owner/repo", [row(1).id, row(2).id]), 2)
  assert.deepEqual(fake.store.files[0].rows.map(r => [r.status, r.reason]), [["open", "Needs human: owner must approve"], ["open", ""]])
})
