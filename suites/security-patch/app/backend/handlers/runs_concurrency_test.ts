import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { test } from "bun:test"
import { strict as assert } from "node:assert"
import type { Context } from "hono"
import type { StartRunRequest } from "../../shared/types.ts"
import type { PickClient } from "../tracker/pick.ts"
import type { Row } from "../tracker/rows.ts"
import type { TrackerFile, TrackerStore } from "../tracker/store.ts"
import { setKnownRepos } from "../tracker/repos.ts"
import { RunEventBus } from "../events/bus.ts"
import { Store } from "../store/repo.ts"
import { handleRunEvents, handleStartRun } from "./runs.ts"
import type { RunHandlersDeps } from "./runs.ts"

const body: Partial<StartRunRequest> = { sessionId: "s1", repoUrl: "https://github.com/start-tests/repo",
  skill: "ola-security-audit", model: "haiku", effort: "low", mode: "fix", pickedIds: ["a".repeat(64)] }
const context = { json: (body: unknown, status = 200, headers?: HeadersInit) => Response.json(body, { status, headers }) } as unknown as Context

class MemoryStore implements TrackerStore {
  files: TrackerFile[] = [{ category: "sqli", log: [], url: "https://example.test/sqli.json", rows: [
    { id: "a".repeat(64), category: "sqli", date: "01-01-2026", file: "app/api/a.php",
      lines: [1], severity: "P1", status: "open", reason: "", pr: "" },
  ] }]
  failMark = false
  async read() { return structuredClone(this.files) }
  async write(file: TrackerFile, rows: Row[], message: string) {
    if (this.failMark) throw new Error("pick marking failed")
    const next = { ...file, rows: structuredClone(rows), log: [...file.log, ...(message ? [{ at: "now", message }] : [])], sha: "sha" }
    this.files = [...this.files.filter(current => current.category !== file.category), next]
    return next
  }
}
class PickFake implements PickClient {
  async openPRFiles() { return [] }
  async prState() { return "open" as const }
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "ola-start-"))
  const store = await Store.open(`${dir}/test.sqlite`)
  const trackerStore = new MemoryStore()
  let launches = 0
  const stopped: string[] = []
  const deps = {
    store, createTrackerStore: async () => trackerStore, runsRootDir: dir, maxConcurrent: 1, scannerImage: "test", getGhToken: async () => "fixture", activeRuns: new Map(), bus: new RunEventBus(),
    controller: { runScanner() {
      launches++
      return { containerName: "test", stdin: new WritableStream().getWriter(),
        stdout: new ReadableStream({ start(c) { c.close() } }),
        stderr: new ReadableStream({ start(c) { c.close() } }), process: { exited: new Promise(() => {}) } }
    }, async stopGraceful(container: string) { stopped.push(container) } },
  } as unknown as RunHandlersDeps
  setKnownRepos(() => ["start-tests/repo"])
  return { dir, store, trackerStore, deps, stopped, launches: () => launches, async close() {
    for (const scanner of deps.activeRuns.values()) await scanner.stop()
    setKnownRepos(() => [])
    store.close()
    await rm(dir, { recursive: true })
  } }
}

test("a pending tracker read reserves capacity and locks starts for the repository", async () => {
  const f = await fixture()
  const client = new PickFake()
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const read = f.trackerStore.read.bind(f.trackerStore)
  f.trackerStore.read = async () => { entered.resolve(); await gate.promise; return read() }
  const first = handleStartRun(context, f.deps, body, client)
  try {
    await entered.promise
    assert.equal(f.store.countActive(), 0)
    const otherRepo = await handleStartRun(context, f.deps, { ...body, repoUrl: "https://github.com/other/repo", mode: "scan", pickedIds: undefined })
    assert.equal(otherRepo.status, 429)
    assert.equal(otherRepo.headers.get("Retry-After"), "5")
    const sameRepo = await handleStartRun(context, f.deps, { ...body, repoUrl: "https://github.com/START-TESTS/REPO.git" }, client)
    assert.equal(sameRepo.status, 409)
    assert.equal(f.launches(), 0)
    gate.resolve()
    const response = await first
    assert.equal(response.status, 201)
    assert.equal(f.launches(), 1)
    assert.equal(f.trackerStore.files[0].rows[0].status, "in progress")
    assert.equal(f.store.countActive(), 1)
  } finally { gate.resolve(); await first; await f.close() }
})

test("a failed Pick preflight releases the reservation and repository lock", async () => {
  const f = await fixture()
  const client = new PickFake()
  try {
    const refused = await handleStartRun(context, f.deps, { ...body, pickedIds: ["b".repeat(64)] }, client)
    assert.equal(refused.status, 400)
    assert.equal(f.store.countActive(), 0)
    assert.equal((await handleStartRun(context, f.deps, body, client)).status, 201)
    assert.equal(f.launches(), 1)
  } finally { await f.close() }
})

test("failed pick marking stops the scanner and releases capacity for retry", async () => {
  const f = await fixture()
  const client = new PickFake()
  f.trackerStore.failMark = true
  try {
    const response = await handleStartRun(context, f.deps, body, client)
    assert.equal(response.status, 500)
    const { runId, error } = await response.json()
    assert.equal(error, "could not mark picked rows. Run stopped so the rows cannot be picked twice: pick marking failed")
    assert.equal(f.store.getRun(runId)?.status, "failed")
    assert.equal(f.store.getRun(runId)?.error, error)
    assert.deepEqual(f.stopped, ["test"])
    assert.deepEqual(f.deps.bus.history(runId).at(-1), { type: "run_finished", status: "failed", error })
    assert.equal(f.store.countActive(), 0)
    assert.equal(f.deps.activeRuns.size, 0)
    assert.equal(f.launches(), 1)
    assert.equal(f.trackerStore.files[0].rows[0].status, "open")
    f.trackerStore.failMark = false
    assert.equal((await handleStartRun(context, f.deps, body, client)).status, 201)
    assert.equal(f.launches(), 2)
  } finally { await f.close() }
})

test("live subscribers receive the marking failure as the terminal event", async () => {
  const f = await fixture()
  const client = new PickFake()
  f.trackerStore.failMark = true
  const marking = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const mark = f.trackerStore.write.bind(f.trackerStore)
  f.trackerStore.write = async (file, rows, message) => {
    marking.resolve()
    await gate.promise
    return mark(file, rows, message)
  }
  const starting = handleStartRun(context, f.deps, body, client)
  try {
    await marking.promise
    const runId = [...f.deps.activeRuns.keys()][0]!
    const stream = handleRunEvents({ req: { param: () => runId } } as unknown as Context, f.deps)
    const received = stream.text()
    gate.resolve()
    const response = await starting
    assert.equal(response.status, 500)
    const { error } = await response.json()
    const events = (await received).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)))
    assert.deepEqual(events.at(-1), { type: "run_finished", status: "failed", error })
    assert.deepEqual(events.filter(event => event.type === "run_status" && event.status === "failed"),
      [{ type: "run_status", status: "failed", error }])
    assert.deepEqual(f.deps.bus.history(runId).filter(event => event.type === "run_finished"),
      [{ type: "run_finished", status: "failed", error }])
    assert.equal(f.store.getRun(runId)?.status, "failed")
    assert.equal(f.store.getRun(runId)?.error, error)
    assert.deepEqual(f.stopped, ["test"])
  } finally { gate.resolve(); await starting; await f.close() }
})

test("artifact preparation failures release capacity and fail the queued run", async () => {
  const f = await fixture()
  try {
    await writeFile(`${f.dir}/not-a-directory`, "fixture")
    const request = { ...body, repoUrl: "https://github.com/other/repo", mode: "scan" as const, pickedIds: undefined }
    const response = await handleStartRun(context, { ...f.deps, runsRootDir: `${f.dir}/not-a-directory` }, request)
    assert.equal(response.status, 500)
    const { runId } = await response.json()
    assert.equal(f.store.getRun(runId)?.status, "failed")
    assert.equal(f.store.countActive(), 0)
    assert.equal(f.launches(), 0)
    assert.equal((await handleStartRun(context, f.deps, request)).status, 201)
  } finally { await f.close() }
})
