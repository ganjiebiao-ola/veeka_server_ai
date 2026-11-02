import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { test } from "bun:test"
import { strict as assert } from "node:assert"
import type { Context } from "hono"
import { Store } from "../store/repo.ts"
import type { RunScannerArgs } from "../docker/controller.ts"
import { handleGetRun, handleResumeRun, handleStartRun, heldRows } from "./runs.ts"

const id = (n: number) => n.toString(16).padStart(64, "0")

for (const [stored, checkpointLanguage, expected] of [["en", "zh", "en"], ["zh", "en", "zh"], ["en", undefined, "en"], [undefined, "en", "en"], [undefined, undefined, "zh"]] as const) {
test(`resume of a run stored as ${stored ?? "unset"} with checkpoint ${checkpointLanguage ?? "unset"} writes ${expected}, whatever the UI locale`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const store = await Store.open(`${dir}/test.sqlite`)
  const launches: RunScannerArgs[] = []
  const deps = {
    store, runsRootDir: dir, maxConcurrent: 10, scannerImage: "test", getGhToken: async () => "fixture", activeRuns: new Map(),
    credentialsHostPath: `${dir}/credentials.json`, bus: { publish() {} }, controller: { runScanner(args: RunScannerArgs) {
      launches.push(args)
      return { containerName: "test", stdin: new WritableStream().getWriter(),
        stdout: new ReadableStream({ start(c) { c.close() } }), stderr: new ReadableStream({ start(c) { c.close() } }),
        process: { exited: new Promise(() => {}) } }
    } },
  }
  const ctx = { req: { param: () => "old", text: async () => JSON.stringify({ language: stored === "en" ? "zh" : "en" }) },
    json: (body: unknown, status = 200) => Response.json(body, { status }) } as unknown as Context
  try {
    store.ensureSession("s1")
    await writeFile(deps.credentialsHostPath, "{}")
    store.createRun({ runId: "old", sessionId: "s1", repoUrl: "https://github.com/a/b", branch: "main", skill: "ola-security-audit", model: "opus", effort: "high",
      mode: "scan", authMode: "oauth", ...(stored ? { language: stored } : {}) })
    store.updateRunStatus("old", "stopped")
    await mkdir(`${dir}/old/artifacts`, { recursive: true })
    await writeFile(`${dir}/old/artifacts/checkpoint.json`, JSON.stringify({ done: [], bundled: false, ...(checkpointLanguage ? { language: checkpointLanguage } : {}) }))
    const response = await handleResumeRun(ctx, deps as never)
    assert.equal(response.status, 201, await response.clone().text())
    const { runId } = await response.json() as { runId: string }
    assert.equal(launches[0].env.OUTPUT_LANGUAGE, expected)
    assert.equal(store.getRun(runId)?.language, expected)
  } finally { store.close(); await rm(dir, { recursive: true }) }
})
}

for (const mode of ["scan", "fix"] as const) {
for (const reviewProvider of ["claude", "codex"] as const) {
test(`resume ${mode} with ${reviewProvider} review reuses start auth validation and supports overrides and the saved default`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const store = await Store.open(`${dir}/test.sqlite`)
  const launches: RunScannerArgs[] = []
  const deps = {
    store, runsRootDir: dir, maxConcurrent: 10, scannerImage: "test", getGhToken: async () => "fixture", activeRuns: new Map(),
    codexAuthHostPath: `${dir}/codex-auth.json`,
    credentialsHostPath: `${dir}/credentials.json`, anthropicApiKey: undefined as string | undefined,
    relayBaseUrl: undefined as string | undefined, relayAuthToken: undefined as string | undefined,
    bus: { publish() {} }, controller: { runScanner(args: RunScannerArgs) {
      launches.push(args)
      return { containerName: "test", stdin: new WritableStream().getWriter(),
        stdout: new ReadableStream({ start(c) { c.close() } }), stderr: new ReadableStream({ start(c) { c.close() } }),
        process: { exited: new Promise(() => {}) } }
    } },
  }
  const request = { sessionId: "s1", repoUrl: "https://github.com/a/b", branch: "main",
    skill: "ola-security-audit", model: "opus", effort: "high", mode, provider: "claude", reviewProvider } as const
  const ctx = (body: unknown = {}, runId = "old") => ({ req: { param: () => runId, text: async () => JSON.stringify(body) },
    json: (body: unknown, status = 200) => Response.json(body, { status }) }) as unknown as Context
  try {
    store.ensureSession("s1")
    await writeFile(deps.codexAuthHostPath, "{}")
    await writeFile(deps.credentialsHostPath, "{}")
    store.createRun({ ...request, runId: "old", authMode: "api-key" })
    store.updateRunStatus("old", "stopped")
    await mkdir(`${dir}/old/artifacts`, { recursive: true })
    await writeFile(`${dir}/old/artifacts/checkpoint.json`, '{"done":[],"bundled":false,"language":"en"}')

    for (const authMode of ["invalid", "", 1, false, [], {}, "api-key", "relay"]) {
      const response = await handleResumeRun(ctx({ authMode }), deps as never)
      const start = await handleStartRun(ctx(), deps as never, { ...request, authMode } as never)
      assert.equal(response.status, 400, JSON.stringify(authMode))
      assert.deepEqual(await response.json(), await start.json())
      assert.equal(launches.length, 0)
      assert.deepEqual(store.attempts("old").map(run => run.runId), ["old"])
    }

    deps.anthropicApiKey = "test.api.key"
    deps.relayBaseUrl = "https://relay.invalid"
    deps.relayAuthToken = "test.relay.token"
    let source = "old"
    for (const authMode of [undefined, "oauth", "api-key", "relay"] as const) {
      const sourceAuth = store.getRun(source)?.authMode
      const response = await handleResumeRun(ctx(authMode === undefined ? {} : { authMode }, source), deps as never)
      assert.equal(response.status, 201, await response.clone().text())
      const { runId } = await response.json() as { runId: string }
      const expected = authMode ?? "api-key"
      assert.equal(store.getRun(runId)?.authMode, expected)
      assert.equal(store.getRun(source)?.authMode, sourceAuth)
      const launched = launches.at(-1)!
      assert.equal(launched.env.OUTPUT_LANGUAGE, "en")
      assert.equal(launched.env.ANTHROPIC_API_KEY, expected === "api-key" ? deps.anthropicApiKey : undefined)
      assert.equal(launched.credentialsHostPath, expected === "oauth" ? deps.credentialsHostPath : undefined)
      assert.equal(launched.env.ANTHROPIC_AUTH_TOKEN, expected === "relay" ? deps.relayAuthToken : undefined)
      const summary = await handleGetRun({ req: { param: () => runId }, json: (body: unknown) => Response.json(body) } as unknown as Context, { store })
      assert.equal((await summary.json() as { authMode: string }).authMode, expected)
      store.updateRunStatus(runId, "stopped")
      await writeFile(`${dir}/${runId}/artifacts/checkpoint.json`, '{"done":[],"bundled":false,"language":"en"}')
      source = runId
    }
    assert.equal(launches.length, 4)
  } finally { store.close(); await rm(dir, { recursive: true }) }
})
}
}

test("Codex resume rejects Claude auth channels without changing the attempt chain", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const store = await Store.open(`${dir}/test.sqlite`)
  const launches: RunScannerArgs[] = []
  const deps = {
    store, runsRootDir: dir, maxConcurrent: 10, scannerImage: "test", getGhToken: async () => "fixture", activeRuns: new Map(),
    codexAuthHostPath: `${dir}/codex-auth.json`, anthropicApiKey: "test.api.key",
    relayBaseUrl: "https://relay.invalid", relayAuthToken: "test.relay.token",
    bus: { publish() {} }, controller: { runScanner(args: RunScannerArgs) {
      launches.push(args)
      return { containerName: "test", stdin: new WritableStream().getWriter(),
        stdout: new ReadableStream({ start(c) { c.close() } }), stderr: new ReadableStream({ start(c) { c.close() } }),
        process: { exited: new Promise(() => {}) } }
    } },
  }
  const resume = (runId: string, body: unknown) => handleResumeRun({
    req: { param: () => runId, text: async () => JSON.stringify(body) },
    json: (body: unknown, status = 200) => Response.json(body, { status }),
  } as unknown as Context, deps as never)
  try {
    store.ensureSession("s1")
    await writeFile(deps.codexAuthHostPath, "{}")
    for (const reviewProvider of ["claude", "codex"] as const) {
      const old = `old-${reviewProvider}`
      store.createRun({ runId: old, sessionId: "s1", repoUrl: "https://github.com/a/b", branch: "main",
        skill: "ola-security-audit", model: "gpt-6.1-sol", effort: "high", mode: "scan", provider: "codex", reviewProvider, authMode: "oauth" })
      store.updateRunStatus(old, "stopped")
      await mkdir(`${dir}/${old}/artifacts`, { recursive: true })
      await writeFile(`${dir}/${old}/artifacts/checkpoint.json`, '{"done":[],"bundled":false}')
      const count = launches.length
      for (const [authMode, error] of [["api-key", "OPENAI_API_KEY is not set on this server"], ["relay", "Codex runs require oauth or api-key authMode"]]) {
        const response = await resume(old, { authMode })
        assert.equal(response.status, 400)
        assert.deepEqual(await response.json(), { error })
        assert.equal(launches.length, count)
        assert.deepEqual(store.attempts(old).map(run => run.runId), [old])
        assert.equal(store.getRun(old)?.authMode, "oauth")
        assert.equal(store.getRun(old)?.status, "stopped")
        await assert.rejects(readFile(`${dir}/${old}/artifacts/resumed.json`), { code: "ENOENT" })
      }
      let source = old
      for (const body of [{ authMode: "oauth" }, {}]) {
        const response = await resume(source, body)
        assert.equal(response.status, 201, await response.clone().text())
        const { runId } = await response.json() as { runId: string }
        assert.equal(store.getRun(runId)?.authMode, "oauth")
        assert.equal(store.getRun(runId)?.reviewProvider, reviewProvider)
        assert.equal(launches.at(-1)?.codexAuthHostPath, deps.codexAuthHostPath)
        store.updateRunStatus(runId, "stopped")
        await writeFile(`${dir}/${runId}/artifacts/checkpoint.json`, '{"done":[],"bundled":false}')
        source = runId
      }
    }
  } finally { store.close(); await rm(dir, { recursive: true }) }
})

for (const reviewSettings of [{}, { reviewModel: "gpt-6.1-sol", reviewEffort: "xhigh" as const }])
test("a stopped run resumes with only the unfinished rows, once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const store = await Store.open(`${dir}/test.sqlite`)
  const launches: RunScannerArgs[] = []
  await writeFile(`${dir}/fake-codex-auth.json`, "{}")
  const deps = {
    store, runsRootDir: dir, maxConcurrent: 10, scannerImage: "test", getGhToken: async () => "fixture", codexAuthHostPath: `${dir}/fake-codex-auth.json`, activeRuns: new Map(),
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
  let payload: { runId?: string, error?: string } = {}
  let status = 0
  const call = (runId: string, body?: unknown) => {
    const c = { req: { param: () => runId, text: async () => (body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body)) }, json: (v: typeof payload, code = 200) => { payload = v; status = code; return new Response() } } as unknown as Context
    return handleResumeRun(c, deps as never)
  }
  try {
    store.ensureSession("s1")
    store.createRun({ runId: "old", sessionId: "s1", repoUrl: "https://github.com/a/b", branch: "main", skill: "ola-security-audit", model: "opus", effort: "high", mode: "fix", categories: "", provider: "claude", reviewProvider: "codex", ...reviewSettings })
    const art = `${dir}/old/artifacts`
    await mkdir(art, { recursive: true })
    await writeFile(`${art}/picked.json`, JSON.stringify([1, 2, 3, 4, 5].map(n => ({ id: id(n), category: "sqli" }))))
    // Runs before the rename saved the repo context under its old name.
    await writeFile(`${art}/indexing-context.json`, JSON.stringify([{ path: "operator-note.md", content: "Use parameter binding." }]))
    await writeFile(`${art}/findings.json`, "[]")
    await writeFile(`${art}/resume.bundle`, "bundle")
    await writeFile(`${art}/report.md`, "Fixed rows 1 and 2.\n")
    await writeFile(`${art}/checkpoint.json`, JSON.stringify({ reason: "cap", done: [id(1), id(2)], bundled: true, caps: { maxBudgetUsd: 3 } }))

    // Not stopped yet: refused.
    await call("old")
    assert.equal(status, 409)
    store.updateRunStatus("old", "stopped")
    await call("old")
    assert.equal(status, 201, String(payload.error))
    const env = launches[0].env
    assert.equal(env.RESUME_DONE, `${id(1)},${id(2)}`)
    assert.equal(env.RESUME_BUNDLE, "/workspace/artifacts/resume.bundle")
    assert.equal(env.PICKED_FILE, "/workspace/artifacts/picked.json")
    assert.equal((env as unknown as Record<string, unknown>).MAX_BUDGET_USD, undefined)
    assert.equal(env.MODE, "fix")
    assert.equal(env.PROVIDER, "claude")
    assert.equal(env.REVIEW_PROVIDER, "codex")
    assert.equal(env.REVIEW_MODEL, reviewSettings.reviewModel)
    assert.equal(env.REVIEW_EFFORT, reviewSettings.reviewEffort)
    assert.equal(store.getRun(payload.runId!)?.reviewModel, reviewSettings.reviewModel)
    assert.equal(store.getRun(payload.runId!)?.reviewEffort, reviewSettings.reviewEffort)
    assert.equal(store.getRun(payload.runId!)?.reviewProvider, "codex")
    const next = `${dir}/${payload.runId}/artifacts`
    assert.equal(JSON.parse(await readFile(`${next}/picked.json`, "utf8")).length, 5)
    const context = JSON.parse(await readFile(`${next}/repo-context.json`, "utf8"))
    assert.deepEqual(context.filter((document: { path: string }) => document.path === "operator-note.md"),
      [{ path: "operator-note.md", content: "Use parameter binding." }])
    assert.equal(await readFile(`${next}/resume.bundle`, "utf8"), "bundle")
    assert.equal(await readFile(`${next}/resume-report.md`, "utf8"), "Fixed rows 1 and 2.\n")
    // Both attempts list the same chain, oldest first.
    const chain = ["old", payload.runId]
    assert.deepEqual(store.attempts("old").map(a => a.runId), chain)
    assert.deepEqual(store.attempts(payload.runId!).map(a => a.runId), chain)
    // A second Resume of the same run is refused.
    await call("old")
    assert.equal(status, 409)
    assert.equal(payload.error, "run already resumed")
    assert.equal(launches.length, 1)
  } finally { store.close(); await rm(dir, { recursive: true }) }
})


test("resume ignores legacy request and checkpoint caps and carries review files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const store = await Store.open(`${dir}/test.sqlite`)
  const launches: RunScannerArgs[] = []
  await writeFile(`${dir}/fake-codex-auth.json`, "{}")
  const deps = {
    store, runsRootDir: dir, maxConcurrent: 10, scannerImage: "test", getGhToken: async () => "fixture", codexAuthHostPath: `${dir}/fake-codex-auth.json`, activeRuns: new Map(),
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
  let payload: Record<string, unknown> = {}
  let status = 0
  const ctx = (runId: string, body?: string) => ({ req: { param: () => runId, text: async () => body ?? "" }, json: (v: typeof payload, code = 200) => { payload = v; status = code; return new Response() } }) as unknown as Context
  const stoppedRun = async (name: string, caps: unknown) => {
    store.createRun({ runId: name, sessionId: "s1", repoUrl: "https://github.com/a/b", branch: "main", skill: "ola-security-audit", model: "opus", effort: "high", mode: "fix", categories: "", provider: "claude", reviewProvider: "claude" })
    const art = `${dir}/${name}/artifacts`
    await mkdir(art, { recursive: true })
    await writeFile(`${art}/picked.json`, JSON.stringify([{ id: id(1), category: "sqli" }]))
    await writeFile(`${art}/findings.json`, "[]")
    await writeFile(`${art}/review-1.json`, '["note"]')
    await writeFile(`${art}/checks.json`, "[]")
    await writeFile(`${art}/batch.json`, JSON.stringify({ fix_pattern: "old notes", review_did_not_run: [1] }))
    await writeFile(`${art}/checkpoint.json`, JSON.stringify({ reason: "cap", done: [id(1)], bundled: false, caps, review_did_not_run: [1], progress: { phase: "review", review: [{ round: 1, notes: 1, fixed: false }] } }))
    store.updateRunStatus(name, "stopped")
  }
  try {
    store.ensureSession("s1")
    await stoppedRun("a", { maxTurns: 50, maxBudgetUsd: 0.8 })
    // Legacy caps are not returned to the UI.
    await handleGetRun({ req: { param: () => "a" }, json: (v: typeof payload) => { payload = v; return new Response() } } as unknown as Context, { store, runsRootDir: dir })
    assert.equal(payload.caps, undefined)

    // Malformed request bodies leave the run resumable.
    for (const body of [[], "{oops"]) {
      await handleResumeRun(ctx("a", typeof body === "string" ? body : JSON.stringify(body)), deps as never)
      assert.equal(status, 400, JSON.stringify(body))
    }
    assert.equal(launches.length, 0)

    // Legacy request fields are ignored.
    await handleResumeRun(ctx("a", JSON.stringify({ maxBudgetUsd: 2.5, smokeSeconds: 30 })), deps as never)
    assert.equal(status, 201, String(payload.error))
    assert.equal(launches[0].env.SMOKE_SECONDS, "0")
    assert.equal((launches[0].env as unknown as Record<string, unknown>).MAX_BUDGET_USD, undefined)
    assert.equal((launches[0].env as unknown as Record<string, unknown>).MAX_TURNS, undefined)
    // The review and check files and the checkpoint carry over to the new run.
    const next = `${dir}/${payload.runId}/artifacts`
    assert.equal(await readFile(`${next}/review-1.json`, "utf8"), '["note"]')
    assert.equal(await readFile(`${next}/checks.json`, "utf8"), "[]")
    assert.equal(JSON.parse(await readFile(`${next}/resume-checkpoint.json`, "utf8")).progress.phase, "review")
    assert.deepEqual(JSON.parse(await readFile(`${next}/resume-checkpoint.json`, "utf8")).review_did_not_run, [1])
    await assert.rejects(readFile(`${next}/batch.json`), { code: "ENOENT" })

    // Legacy checkpoint fields are ignored without a request body too.
    await stoppedRun("b", { maxTurns: 50, maxBudgetUsd: 0.8 })
    await handleResumeRun(ctx("b"), deps as never)
    assert.equal(status, 201, String(payload.error))
    assert.equal(launches[1].env.SMOKE_SECONDS, "0")
    assert.equal((launches[1].env as unknown as Record<string, unknown>).MAX_BUDGET_USD, undefined)
    assert.equal((launches[1].env as unknown as Record<string, unknown>).MAX_TURNS, undefined)
  } finally { store.close(); await rm(dir, { recursive: true }) }
})

test("held rows come from running runs and stopped runs nobody resumed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const store = await Store.open(`${dir}/test.sqlite`)
  try {
    store.ensureSession("s1")
    const runs: Array<[string, "scanning" | "stopped" | "completed", number]> = [["live", "scanning", 1], ["paused", "stopped", 2], ["resumed", "stopped", 3], ["done", "completed", 4]]
    for (const [runId, status, n] of runs) {
      store.createRun({ runId, sessionId: "s1", repoUrl: "https://github.com/a/b", branch: "main", skill: "ola-security-audit", model: "opus", effort: "high", mode: "fix" })
      store.updateRunStatus(runId, status)
      await mkdir(`${dir}/${runId}/artifacts`, { recursive: true })
      await writeFile(`${dir}/${runId}/artifacts/picked.json`, JSON.stringify([{ id: id(n) }]))
    }
    await writeFile(`${dir}/resumed/artifacts/resumed.json`, "{}")
    assert.deepEqual([...await heldRows({ store, runsRootDir: dir })].sort(), [id(1), id(2)])
  } finally { store.close(); await rm(dir, { recursive: true }) }
})

for (const checkpointBytes of [0, 6_083_577, 16 * 1024 * 1024, 16 * 1024 * 1024 + 1]) {
test(`a stopped scan resumes with its inputs and checkpoint (${checkpointBytes} bytes), once`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const store = await Store.open(`${dir}/test.sqlite`)
  const launches: RunScannerArgs[] = []
  const deps = {
    store, runsRootDir: dir, maxConcurrent: 10, scannerImage: "test", getGhToken: async () => "fixture", activeRuns: new Map(),
    bus: { publish() {} }, controller: { runScanner(args: RunScannerArgs) {
      launches.push(args)
      return { containerName: "test", stdin: new WritableStream().getWriter(),
        stdout: new ReadableStream({ start(c) { c.close() } }), stderr: new ReadableStream({ start(c) { c.close() } }),
        process: { exited: new Promise(() => {}) } }
    } },
  }
  const previousDev = process.env.OLA_DEV
  process.env.OLA_DEV = "1"
  try {
    store.ensureSession("s1")
    store.createRun({ runId: "scan", sessionId: "s1", repoUrl: "https://github.com/a/b", branch: "main", skill: "ola-security-audit", model: "opus", effort: "high", mode: "scan", categories: "sqli,cmd-injection", maxSubagents: 2, includeP2: true })
    store.updateRunStatus("scan", "stopped")
    const checkpoint = { reason: "quota", head: "a".repeat(40), bundled: true, done: [id(1)], caps: { maxBudgetUsd: 12 },
      scan: { findings: [], coveredFiles: ["src/query.php"] } }
    await mkdir(`${dir}/scan/artifacts`, { recursive: true })
    const json = JSON.stringify(checkpoint)
    await writeFile(`${dir}/scan/artifacts/checkpoint.json`, json.padEnd(Math.max(json.length, checkpointBytes)))
    await writeFile(`${dir}/scan/artifacts/auth.json`, '{"evidence":[]}', { mode: 0o600 })
    const c = { req: { param: () => "scan", text: async () => "" }, json: (body: unknown, status = 200) => Response.json(body, { status }) } as unknown as Context
    if (checkpointBytes === 0) {
      for (const value of [undefined, "0"]) {
        if (value === undefined) delete process.env.OLA_DEV
        else process.env.OLA_DEV = value
        const refused = await handleResumeRun(c, deps as never)
        assert.equal(refused.status, 400)
        assert.match((await refused.json()).error, /require dev mode/)
        assert.equal(launches.length, 0)
        assert.equal(store.getRun("scan")?.status, "stopped")
      }
      process.env.OLA_DEV = "1"
    }
    const response = await handleResumeRun(c, deps as never)
    if (checkpointBytes > 16 * 1024 * 1024) {
      assert.equal(response.status, 409)
      assert.equal(launches.length, 0)
      return
    }
    assert.equal(response.status, 201, await response.clone().text())
    const { runId } = await response.json() as { runId: string }
    const env = launches[0].env
    assert.equal(env.MODE, "scan")
    assert.equal(env.CATEGORIES, "sqli,cmd-injection")
    assert.equal(env.INCLUDE_P2, "true")
    assert.equal(env.MAX_SUBAGENTS, "2")
    assert.equal((env as unknown as Record<string, unknown>).MAX_BUDGET_USD, undefined)
    assert.equal(env.COMMIT_SHA, checkpoint.head)
    assert.equal(env.PICKED_FILE, undefined)
    assert.equal(env.RESUME_DONE, undefined)
    assert.equal(env.RESUME_BUNDLE, undefined)
    assert.equal(store.getRun(runId)?.mode, "scan")
    assert.equal(store.getRun(runId)?.includeP2, true)
    assert.equal(store.getRun(runId)?.maxSubagents, 2)
    assert.deepEqual(JSON.parse(await readFile(`${dir}/${runId}/artifacts/resume-checkpoint.json`, "utf8")), checkpoint)
    assert.equal((await readFile(`${dir}/${runId}/artifacts/resume-checkpoint.json`)).length, Math.max(json.length, checkpointBytes))
    assert.deepEqual(JSON.parse(await readFile(`${dir}/${runId}/artifacts/auth.json`, "utf8")), { evidence: [] })
    assert.equal((await handleResumeRun(c, deps as never)).status, 409)
    assert.equal(launches.length, 1)
  } finally {
    if (previousDev === undefined) delete process.env.OLA_DEV
    else process.env.OLA_DEV = previousDev
    store.close(); await rm(dir, { recursive: true })
  }
})
}

test("overlapping resumes launch one scanner and keep the source resumed once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const store = await Store.open(`${dir}/test.sqlite`)
  let launches = 0
  const deps = {
    store, runsRootDir: dir, maxConcurrent: 10, scannerImage: "test", getGhToken: async () => "fixture", activeRuns: new Map(),
    bus: { publish() {} }, controller: { runScanner() {
      launches++
      return { containerName: "test", stdin: new WritableStream().getWriter(),
        stdout: new ReadableStream({ start(c) { c.close() } }), stderr: new ReadableStream({ start(c) { c.close() } }),
        process: { exited: new Promise(() => {}) } }
    } },
  }
  const c = { req: { param: () => "old", text: async () => "" },
    json: (body: unknown, status = 200) => Response.json(body, { status }) } as unknown as Context
  try {
    store.ensureSession("s1")
    store.createRun({ runId: "old", sessionId: "s1", repoUrl: "https://github.com/a/b", branch: "main",
      skill: "ola-security-audit", model: "opus", effort: "high", mode: "fix" })
    store.updateRunStatus("old", "stopped")
    await mkdir(`${dir}/old/artifacts`, { recursive: true })
    await writeFile(`${dir}/old/artifacts/checkpoint.json`, '{"done":[],"bundled":false}')
    const responses = await Promise.all([handleResumeRun(c, deps as never), handleResumeRun(c, deps as never)])
    assert.deepEqual(responses.map(response => response.status).sort(), [201, 409],
      JSON.stringify(await Promise.all(responses.map(response => response.clone().json()))))
    assert.equal(launches, 1)
    const saved = JSON.parse(await readFile(`${dir}/old/artifacts/resumed.json`, "utf8"))
    assert.deepEqual(store.attempts(saved.runId).map(run => run.runId), ["old", saved.runId])
    const stale = await handleStartRun(c, deps as never, {
      sessionId: "s1", repoUrl: "https://github.com/a/b", branch: "main", skill: "ola-security-audit",
      model: "opus", effort: "high", mode: "fix",
    }, undefined, { from: "old", done: [], bundled: false })
    assert.equal(stale.status, 409)
    assert.equal(launches, 1)
  } finally { store.close(); await rm(dir, { recursive: true }) }
})
