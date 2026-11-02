import { test } from "bun:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Context } from "hono"
import type { RunScannerArgs } from "../docker/controller.ts"
import { ScannerRun } from "../orchestrator/scanner.ts"
import { Store } from "../store/repo.ts"
import { handlePauseRun, handleResumeRun, handleStopRun } from "./runs.ts"

for (const provider of ["claude", "codex"] as const) test(`${provider} pause waits for checkpoint, becomes stopped, and resumes through the existing handler`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-pause-"))
  const store = await Store.open(join(dir, "test.sqlite"))
  const launches: RunScannerArgs[] = []
  let output: ReadableStreamDefaultController<Uint8Array>
  let command = ""
  let stops = 0
  const checkpoint = { reason: "pause", done: [], bundled: false, scan: { findings: [], coveredFiles: ["done.php"] } }
  const deps = {
    activeRuns: new Map<string, ScannerRun>(),
    store, runsRootDir: dir, maxConcurrent: 10, scannerImage: "test", getGhToken: async () => "fixture",
    credentialsHostPath: join(dir, "credentials.json"), codexAuthHostPath: join(dir, "auth.json"),
    bus: { publish() {} }, controller: {
      stopGraceful: async () => { stops++ },
      runScanner(args: RunScannerArgs) {
        launches.push(args)
        return { containerName: "test", stdin: new WritableStream<Uint8Array>({ write(bytes) { command = new TextDecoder().decode(bytes) } }).getWriter(),
          stdout: new ReadableStream<Uint8Array>({ start(c) { output = c } }),
          stderr: new ReadableStream({ start(c) { c.close() } }), process: { exited: new Promise(() => {}) } }
      },
    },
  }
  const ctx = (runId = "old") => ({ req: { param: () => runId, text: async () => "{}" },
    json: (body: unknown, status = 200) => Response.json(body, { status }) }) as unknown as Context
  try {
    await writeFile(deps.credentialsHostPath, "{}")
    await writeFile(deps.codexAuthHostPath, "{}")
    await mkdir(join(dir, "old/artifacts"), { recursive: true })
    store.ensureSession("s1")
    store.createRun({ runId: "old", sessionId: "s1", repoUrl: "https://github.com/a/b", branch: "main",
      skill: "ola-security-audit", model: provider === "claude" ? "sonnet" : "gpt-6.1-sol", effort: "high", mode: "scan", provider, authMode: "oauth" })
    const scanner = new ScannerRun("old", deps as never)
    await scanner.start({ artifactsHostDir: join(dir, "old/artifacts"), env: {} } as RunScannerArgs)
    deps.activeRuns.set("old", scanner)
    store.updateRunStatus("old", "scanning")
    assert.equal((await handlePauseRun(ctx(), deps)).status, 200)
    assert.deepEqual(JSON.parse(command), { type: "pause" })
    assert.equal(store.getRun("old")?.status, "scanning")
    assert.equal(stops, 0)
    assert.equal((await handleResumeRun(ctx(), deps as never)).status, 409)
    // The bridge emits run_stopped only after its checkpoint is complete.
    await writeFile(join(dir, "old/artifacts/checkpoint.json"), JSON.stringify(checkpoint))
    output!.enqueue(new TextEncoder().encode('{"kind":"run_stopped","reason":"pause"}\n'))
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(store.getRun("old")?.status, "stopped")
    assert.equal(store.getRun("old")?.error, "stopped at user pause")
    const resumed = await handleResumeRun(ctx(), deps as never)
    assert.equal(resumed.status, 201, await resumed.clone().text())
    const { runId } = await resumed.json() as { runId: string }
    assert.deepEqual(JSON.parse(await readFile(join(dir, runId, "artifacts/resume-checkpoint.json"), "utf8")), checkpoint)
    assert.deepEqual(store.attempts("old").map(run => run.runId), ["old", runId])
    assert.equal(launches.length, 2)
    assert.equal((await handlePauseRun(ctx(), deps)).status, 409)
    await handleStopRun(ctx(runId), deps)
    assert.equal(store.getRun(runId)?.status, "aborted")
    assert.equal(stops, 1)
    await assert.rejects(readFile(join(dir, runId, "artifacts/checkpoint.json")), { code: "ENOENT" })
    assert.equal((await handleResumeRun(ctx(runId), deps as never)).status, 409)
  } finally { store.close(); await rm(dir, { recursive: true, force: true }) }
})

test("pause rejects missing, inactive, terminal and non-scan runs and reports a closed stdin", async () => {
  const calls: string[] = []
  let run: { mode: string, status: string } | undefined = { mode: "scan", status: "scanning" }
  const deps = { store: { getRun: () => run }, activeRuns: new Map<string, unknown>() }
  const ctx = (id = "run") => ({ req: { param: () => id }, json: (body: unknown, status = 200) => Response.json(body, { status }) }) as unknown as Context
  const pause = (id?: string) => handlePauseRun(ctx(id), deps as never)
  assert.equal((await pause("../bad")).status, 400)
  run = undefined
  assert.equal((await pause()).status, 404)
  run = { mode: "scan", status: "scanning" }
  assert.equal((await pause()).status, 409)
  deps.activeRuns.set("run", { pause: async () => { calls.push("pause"); throw new Error("closed") } })
  for (const status of ["completed", "failed", "aborted", "stopped"]) {
    run.status = status
    assert.equal((await pause()).status, 409)
  }
  run = { mode: "fix", status: "scanning" }
  assert.equal((await pause()).status, 409)
  assert.equal(calls.length, 0)
  run.mode = "scan"
  assert.equal((await pause()).status, 503)
})

test("stop after a finished pause checkpoint but before run_stopped removes the checkpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-pause-"))
  const store = await Store.open(join(dir, "test.sqlite"))
  const deps = {
    store, runsRootDir: dir, activeRuns: new Map<string, ScannerRun>(), bus: { publish() {} },
    controller: { stopGraceful: async () => {}, runScanner: () => ({ containerName: "test",
      stdin: new WritableStream<Uint8Array>().getWriter(), stdout: new ReadableStream<Uint8Array>(),
      stderr: new ReadableStream({ start(c) { c.close() } }), process: { exited: new Promise(() => {}) } }) },
  }
  const ctx = { req: { param: () => "old" }, json: (body: unknown, status = 200) => Response.json(body, { status }) } as unknown as Context
  try {
    await mkdir(join(dir, "old/artifacts"), { recursive: true })
    store.ensureSession("s1")
    store.createRun({ runId: "old", sessionId: "s1", repoUrl: "https://github.com/a/b", branch: "main",
      skill: "ola-security-audit", model: "sonnet", effort: "high", mode: "scan", provider: "claude", authMode: "oauth" })
    const scanner = new ScannerRun("old", deps as never)
    await scanner.start({ artifactsHostDir: join(dir, "old/artifacts"), env: {} } as RunScannerArgs)
    deps.activeRuns.set("old", scanner)
    store.updateRunStatus("old", "scanning")
    assert.equal((await handlePauseRun(ctx, deps)).status, 200)
    await writeFile(join(dir, "old/artifacts/checkpoint.json"), JSON.stringify({ reason: "pause", done: [], bundled: false }))
    assert.equal((await handleStopRun(ctx, deps)).status, 200)
    assert.equal(store.getRun("old")?.status, "aborted")
    await assert.rejects(readFile(join(dir, "old/artifacts/checkpoint.json")), { code: "ENOENT" })
  } finally { store.close(); await rm(dir, { recursive: true, force: true }) }
})
