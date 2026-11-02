import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp, rm } from "node:fs/promises"
import { test } from "bun:test"
import { deepStrictEqual as assertEquals } from "node:assert/strict"
import type { Context } from "hono"
import { Store } from "../store/repo.ts"
import type { TrackerFile, TrackerStore } from "../tracker/store.ts"
import type { Row } from "../tracker/rows.ts"
import { scrub } from "../tracker/scrub.ts"
import { handlePostFindings, handlePostPreview } from "./runs.ts"

class MemoryStore implements TrackerStore {
  files: TrackerFile[] = []
  async read() { return structuredClone(this.files) }
  async write(file: TrackerFile, rows: Row[], message: string) {
    const next = { ...file,
      rows: rows.map(row => ({ ...structuredClone(row), file: scrub(row.file)[0], reason: scrub(row.reason)[0] })),
      log: [...file.log, ...(message ? [{ at: "now", message: scrub(message)[0] }] : [])],
      sha: "sha", url: `https://example.test/${file.category}.json` }
    this.files = [...this.files.filter(current => current.category !== file.category), next]
    return next
  }
}

test("the Run tab posts only ticked, unposted findings of a completed GitHub scan run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const store = await Store.open(join(dir, "t.sqlite"))
  const warn = console.warn
  console.warn = () => {}
  try {
    store.ensureSession("s1")
    const base = { sessionId: "s1", branch: "main", skill: "ola-security-audit" as const, model: "haiku", effort: "low" as const }
    store.createRun({ ...base, runId: "scan", repoUrl: "https://github.com/Owner/Repo.git", mode: "scan" })
    store.createRun({ ...base, runId: "fix", repoUrl: "https://github.com/owner/repo", mode: "fix" })
    store.createRun({ ...base, runId: "local", repoUrl: "local:/tmp/repo", mode: "scan" })
    for (const id of ["scan", "fix", "local"]) store.updateRunStatus(id, "completed")
    const token = "ghp_" + "X".repeat(36)
    const row = { severity: "P1" as const, line: 10, reason: "Unsafe query", status: "candidate" as const }
    store.insertFinding("scan", { ...row, id: "a".repeat(64), category: "sqli", file: `src/${token}/query.ts` })
    store.insertFinding("scan", { ...row, id: "b".repeat(64), category: "misc", file: "src/b.ts", kind: "race-condition" })
    store.insertFinding("scan", { ...row, id: "c".repeat(64), category: "cors", file: "src/c.ts" })

    const trackerStore = new MemoryStore()
    let stores = 0
    const call = async (runId: string, body: unknown, createTrackerStore: (repo: string) => Promise<TrackerStore> = async (repo) => {
      assertEquals(repo, "owner/repo")
      stores++
      return trackerStore
    }) => {
      let status = 200
      let payload: unknown
      const c = {
        req: { param: () => runId, json: async () => body },
        json: (value: unknown, code = 200) => { payload = value; status = code; return new Response() },
      } as unknown as Context
      await (body === "preview" ? handlePostPreview : handlePostFindings)(c, { store, createTrackerStore })
      return { status, payload }
    }

    assertEquals((await call("missing", { ids: ["x"] })).status, 404)
    assertEquals((await call("fix", { ids: ["x"] })).status, 409)
    assertEquals((await call("local", { ids: ["x"] })).status, 400)
    assertEquals((await call("scan", { ids: [] })).status, 400)
    assertEquals((await call("scan", { ids: [1] })).status, 400)

    // The dev unticked c as a false positive.
    const failed = await call("scan", { ids: ["a".repeat(64), "b".repeat(64)] }, async () => ({
      read: async () => { throw new Error(`token ${token}`) },
      write: trackerStore.write.bind(trackerStore),
    }))
    assertEquals(failed.status, 502)
    assertEquals(JSON.stringify(failed.payload).includes(token), false)
    assertEquals(store.listFindings("scan").some(f => f.posted), false)

    assertEquals((await call("scan", { ids: ["a".repeat(64), "b".repeat(64)] })).payload, { added: 2, skipped: 0 })
    assertEquals(trackerStore.files.map(file => file.category), ["sqli", "misc"])
    const sqli = trackerStore.files.find(file => file.category === "sqli")!.rows[0]
    assertEquals(sqli.file, "src/«已脱敏:github-token»/query.ts")
    assertEquals(trackerStore.files.find(file => file.category === "misc")!.rows[0].kind, "race-condition")
    assertEquals(store.listFindings("scan").map(f => f.posted ?? false), [true, true, false])

    // Posted findings are left out, so a second click posts nothing new.
    assertEquals((await call("scan", { ids: ["a".repeat(64)] })).payload, { added: 0, skipped: 0 })
    assertEquals(stores, 2)
    assertEquals(trackerStore.files.map(file => file.log.length), [1, 1])

    // New findings: one on a tracked line, one 5 lines away, one in a new file.
    store.insertFinding("scan", { ...row, id: "d".repeat(64), category: "misc", file: "/workspace/repo/src/b.ts", line: 10, kind: "race-condition" })
    store.insertFinding("scan", { ...row, id: "e".repeat(64), category: "misc", file: "src/b.ts", line: 15, kind: "race-condition" })
    store.insertFinding("scan", { ...row, id: "f".repeat(64), category: "sqli", file: "src/new.ts" })
    const preview = await call("scan", "preview")
    assertEquals(preview.payload, { repo: "owner/repo", matches: {
      ["d".repeat(64)]: { kind: "tracked", url: "https://example.test/misc.json", file: "src/b.ts", line: 10, status: "open" },
      ["e".repeat(64)]: { kind: "similar", url: "https://example.test/misc.json", file: "src/b.ts", line: 10, status: "open" },
    } })
    assertEquals((await call("fix", "preview")).status, 409)
    const unreadable = await call("scan", "preview", async () => { throw new Error(`token ${token}`) })
    assertEquals(unreadable.status, 502)
    assertEquals(JSON.stringify(unreadable.payload).includes(token), false)
  } finally {
    console.warn = warn
    store.close()
    await rm(dir, { recursive: true })
  }
})
