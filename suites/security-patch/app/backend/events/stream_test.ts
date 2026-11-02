import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { test, spyOn } from "bun:test"
import { strict as assert } from "node:assert"
import type { Context } from "hono"
import type { RunEvent } from "../../shared/types.ts"
import { Store } from "../store/repo.ts"
import { handleRunEvents } from "../handlers/runs.ts"
import { buildApp } from "../cli/server.ts"
import { RunEventBus } from "./bus.ts"
import { setKnownRepos, trackerForUrl } from "../tracker/repos.ts"

const context = (runId: string) => ({
  req: { param: () => runId },
  json: (body: unknown, status = 200) => Response.json(body, { status }),
}) as unknown as Context

test("terminal event streams replay saved events and close with the stored result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-events-"))
  const store = await Store.open(`${dir}/test.sqlite`)
  const bus = new RunEventBus()
  const deps = { store, bus, runsRootDir: dir }
  try {
    store.ensureSession("s1")
    for (const status of ["completed", "failed", "stopped", "aborted"] as const) {
      store.createRun({ runId: status, sessionId: "s1", repoUrl: "https://github.com/a/b", branch: "main",
        skill: "ola-security-audit", model: "sonnet", effort: "low", mode: "scan" })
      store.updateRunStatus(status, status, status === "completed" ? {} : { error: "fixture failure" })
      const saved: RunEvent = { type: "thinking_emitted", text: "Saved event" }
      if (status === "completed") {
        bus.publish(status, saved)
        bus.publish(status, { type: "run_finished", status })
        bus.publish(status, { type: "push_result", ok: true, branch: "security/test" })
      } else if (status !== "aborted") {
        await mkdir(`${dir}/${status}/artifacts`, { recursive: true })
        await writeFile(`${dir}/${status}/artifacts/events.jsonl`, JSON.stringify(saved) + "\n")
      }
      const response = handleRunEvents(context(status), deps)
      assert.equal(response.status, 200)
      const text = await response.text()
      assert.ok(text.startsWith("retry: 1000\n\n"))
      const events = text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)))
      assert.deepEqual(events.at(-1), { type: "run_finished", status, ...(status !== "completed" ? { error: "fixture failure" } : {}) })
      assert.equal(events.filter(event => event.type === "run_finished").length, 1)
      if (status !== "aborted") assert.deepEqual(events[0], saved)
      if (status === "completed") assert.equal(events[1].type, "push_result")
    }
    assert.equal(handleRunEvents(context("unknown"), deps).status, 404)
    assert.equal(handleRunEvents(context("../outside"), deps).status, 400)
  } finally { store.close(); await rm(dir, { recursive: true }) }
})

test("cancelling a live event stream unsubscribes while a read is waiting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-events-"))
  const store = await Store.open(`${dir}/test.sqlite`)
  const bus = new RunEventBus()
  try {
    store.ensureSession("s1")
    store.createRun({ runId: "live", sessionId: "s1", repoUrl: "https://github.com/a/b", branch: "main",
      skill: "ola-security-audit", model: "sonnet", effort: "low", mode: "scan" })
    const reader = handleRunEvents(context("live"), { store, bus, runsRootDir: dir }).body!.getReader()
    await reader.read()
    const waiting = reader.read()
    await reader.cancel()
    assert.equal((await waiting).done, true)
    const inner = bus as unknown as { channels: Map<string, unknown>, closers: Map<string, unknown> }
    assert.equal(inner.channels.size, 0)
    assert.equal(inner.closers.size, 0)
    bus.publish("live", { type: "run_finished", status: "completed" })
    const next = bus.subscribe("live")
    assert.deepEqual((await next.next()).value, { type: "run_finished", status: "completed" })
    await next.return!()
  } finally { store.close(); await rm(dir, { recursive: true }) }
})

test("a live event stream forwards completion and unsubscribes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-events-"))
  const store = await Store.open(`${dir}/test.sqlite`)
  const bus = new RunEventBus()
  try {
    store.ensureSession("s1")
    store.createRun({ runId: "live", sessionId: "s1", repoUrl: "https://github.com/a/b", branch: "main",
      skill: "ola-security-audit", model: "sonnet", effort: "low", mode: "scan" })
    const response = handleRunEvents(context("live"), { store, bus, runsRootDir: dir })
    bus.publish("live", { type: "run_finished", status: "completed" })
    assert.match(await response.text(), /"type":"run_finished","status":"completed"/)
    const inner = bus as unknown as { channels: Map<string, unknown>, closers: Map<string, unknown> }
    assert.equal(inner.channels.size, 0)
    assert.equal(inner.closers.size, 0)
  } finally { store.close(); await rm(dir, { recursive: true }) }
})

test("unhandled errors return JSON and log no exception or request secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-errors-"))
  const store = await Store.open(`${dir}/test.sqlite`)
  const logs: unknown[][] = []
  const listRepos = spyOn(store, "listRepos")
  const log = spyOn(console, "error").mockImplementation((...args) => { logs.push(args) })
  try {
    const app = await buildApp({ store, controller: { sweepOrphans: async () => [] } as never })
    listRepos.mockImplementation(() => { throw new Error("private fixture credential") })
    const response = await app.request("/api/repos?token=private-request-credential")
    assert.equal(response.status, 500)
    assert.match(response.headers.get("content-type")!, /application\/json/)
    assert.deepEqual(await response.json(), { error: "Internal server error" })
    assert.deepEqual(logs, [["[http] GET /api/repos: unhandled error"]])
  } finally {
    listRepos.mockRestore()
    log.mockRestore()
    setKnownRepos(() => [])
    store.close()
    await rm(dir, { recursive: true })
  }
  // A later skill run resolves trackers before launching its scanner.
  assert.doesNotThrow(() => trackerForUrl("https://github.com/a/b"))
})

for (const failure of [false, true]) test(`fix streams stay live through PR ${failure ? "failure" : "creation"}, including reconnects`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-fix-events-"))
  const store = await Store.open(`${dir}/test.sqlite`)
  const bus = new RunEventBus()
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const { ScannerRun } = await import("../orchestrator/scanner.ts")
  const scanner = new ScannerRun("fix", {
    store, bus, controller: {} as never,
    async onFixComplete(runId) {
      entered.resolve()
      await gate.promise
      if (failure) throw new Error("fixture PR failure")
      bus.publish(runId, { type: "push_result", ok: true, prUrl: "https://github.com/a/b/pull/1" })
    },
  })
  const deps = { store, bus, runsRootDir: dir, activeRuns: new Map([["fix", scanner]]) }
  const received: Promise<string>[] = []
  try {
    store.ensureSession("s1")
    store.createRun({ runId: "fix", sessionId: "s1", repoUrl: "https://github.com/a/b", branch: "main",
      skill: "ola-security-audit", model: "sonnet", effort: "low", mode: "fix" })
    received.push(handleRunEvents(context("fix"), deps).text())
    const inner = scanner as unknown as { handleBridgeEvent(event: unknown): void }
    inner.handleBridgeEvent({ kind: "run_finished" })
    await entered.promise
    assert.equal(store.getRun("fix")?.status, "completed")
    received.push(handleRunEvents(context("fix"), deps).text())
    assert.ok(!bus.history("fix").some(event => event.type === "run_finished" || event.type === "run_status" && event.status === "completed"))
    gate.resolve()
    for (const text of await Promise.all(received)) {
      const events = text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)))
      assert.deepEqual(events.at(-1), { type: "run_finished", status: "completed", ...(failure ? { error: "fixture PR failure" } : {}) })
      assert.deepEqual(events.find(event => event.type === "push_result"), failure
        ? { type: "push_result", ok: false, error: "fixture PR failure" }
        : { type: "push_result", ok: true, prUrl: "https://github.com/a/b/pull/1" })
    }
  } finally { gate.resolve(); await Promise.all(received); store.close(); await rm(dir, { recursive: true }) }
})
