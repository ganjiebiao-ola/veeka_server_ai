import { expect, test } from "bun:test"
import { migrate } from "./migrate_tracker.ts"
import { END, START, renderRows, type Row } from "../tracker/rows.ts"
import { GitHubTrackerStore, TrackerConflict, type TrackerFile, type TrackerStore } from "../tracker/store.ts"
import { GitHubClient } from "../tracker/client.ts"

test("migration checks category and status counts using the stored files", async () => {
  const rows: Row[] = [{ id: "1", category: "sqli", file: "a.php", lines: [1], severity: "P1", status: "open", reason: "", date: "01-01-2026", pr: "" }]
  const files: TrackerFile[] = []
  const store: TrackerStore = {
    async read() { return structuredClone(files) },
    async write(file, next, message) {
      const saved = { ...file, rows: next, sha: "sha", log: [{ at: "now", message }] }
      files.push(saved)
      return saved
    },
  }
  const client = { async legacyTrackingIssues() { return [{ number: 1, category: "sqli", body: `${START}${renderRows(rows)}${END}` }] } }
  expect(await migrate(client, store)).toEqual({ before: { sqli: { open: 1 } }, after: { sqli: { open: 1 } }, matches: true })
  await expect(migrate(client, store)).rejects.toThrow("already exists")
})


const row = (id: string, status: Row["status"] = "open"): Row => ({ id, category: "sqli", file: `${id}.php`, lines: [1], severity: "P1", status, reason: "original", date: "01-01-2026", pr: "" })
const body = (rows: Row[]) => `${START}${renderRows(rows)}${END}`

function memoryStore(initial: TrackerFile[] = []) {
  let files = structuredClone(initial)
  const store: TrackerStore = {
    async read() { return structuredClone(files) },
    async write(file, rows, message) {
      const saved = { ...file, rows: structuredClone(rows), sha: "saved", log: [...file.log, { at: "now", message }] }
      files = [...files.filter(current => current.category !== file.category), saved]
      return saved
    },
  }
  return store
}

test("forced migration replaces rows, keeps fresh file metadata, and retries conflicts", async () => {
  const store = memoryStore([{ category: "sqli", rows: [row("b", "ignored")], sha: "old", log: [], url: "" }])
  const write = store.write.bind(store)
  const shas: (string | undefined)[] = []
  store.write = async (file, rows, message) => {
    shas.push(file.sha)
    if (shas.length === 1) {
      await write({ ...file, log: [{ at: "now", message: "owner note" }] }, [row("c")], "")
      throw new TrackerConflict()
    }
    return write(file, rows, message)
  }
  const client = { legacyTrackingIssues: async () => [{ number: 1, category: "sqli", body: body([row("a")]) }] }
  expect((await migrate(client, store, true)).matches).toBe(true)
  const [saved] = await store.read()
  expect(saved.rows).toEqual([row("a")])
  expect(saved.log.some(entry => entry.message === "owner note")).toBe(true)
  expect(shas).toEqual(["old", "saved"])
})

test("migration refuses a file created during a conflict unless forced", async () => {
  const store = memoryStore()
  const write = store.write.bind(store)
  let writes = 0
  store.write = async (file, rows, message) => {
    writes++
    await write(file, [row("b", "ignored")], "owner note")
    throw new TrackerConflict()
  }
  await expect(migrate({ legacyTrackingIssues: async () => [{ number: 1, category: "sqli", body: body([row("a")]) }] }, store)).rejects.toThrow("already exists")
  expect(writes).toBe(1)
  expect((await store.read())[0].rows).toEqual([row("b", "ignored")])
})

test("migration stops after three conflicts without writing legacy issues", async () => {
  const store = memoryStore()
  let writes = 0
  store.write = async () => { writes++; throw new TrackerConflict() }
  await expect(migrate({ legacyTrackingIssues: async () => [{ number: 1, category: "sqli", body: body([row("a")]) }] }, store)).rejects.toBeInstanceOf(TrackerConflict)
  expect(writes).toBe(3)
  expect(await store.read()).toEqual([])
})

test("migration reads paged and continuation issues, normalizes legacy statuses, and only writes JSON contents", async () => {
  const original = globalThis.fetch
  const requests: { url: string, method: string, query?: string }[] = []
  const legacy = ["candidate", "deferred", "picked", "in PR", "false positive", "won't fix"] as const
  const expected = ["open", "open", "in progress", "in progress", "ignored", "ignored"]
  const legacyBody = (start: number, end: number) => `${START}\n` + legacy.slice(start, end).map((status, i) =>
    `| ${(start + i).toString(16)} | ${(start + i).toString(16)}.php:1 | app | P1 | ${status} | original | batch | |`).join("\n") + `\n${END}`
  let stored: any
  let pages = 0
  let conflicts = 0
  globalThis.fetch = (async (url, init) => {
    const payload = JSON.parse(init!.body as string)
    const method = init!.method!
    requests.push({ url: String(url), method, query: payload.query })
    if (method === "PUT") {
      expect(String(url)).toBe("https://api.github.com/repos/fixture/tracker/contents/trackers/repo/sqli.json")
      if (++conflicts === 1) return Response.json({ errors: [{ field: "sha", code: "missing_field" }] }, { status: 422 })
      stored = JSON.parse(Buffer.from(payload.content, "base64").toString())
      return Response.json({ content: { sha: "saved" } })
    }
    expect(method).toBe("POST")
    expect(String(url)).toBe("https://api.github.com/graphql")
    expect(payload.query).toStartWith("query {")
    if (payload.query.includes("issues(first:")) {
      pages++
      if (pages === 1) return Response.json({ data: { repository: { issues: { nodes: [
        { number: 2, title: "security-patch: sqli (2)", body: legacyBody(3, 6) },
        { number: 9, title: "unrelated", body: "ignored" },
      ], pageInfo: { hasNextPage: true, endCursor: "next-page" } } } } })
      expect(payload.query).toContain('after: "next-page"')
      return Response.json({ data: { repository: { issues: { nodes: [{ number: 1, title: "security-patch: sqli", body: legacyBody(0, 3) }], pageInfo: { hasNextPage: false, endCursor: null } } } } })
    }
    expect(payload.query).toContain("main:trackers/repo")
    return Response.json({ data: { repository: { object: stored ? { entries: [{ name: "sqli.json", object: { text: JSON.stringify(stored), oid: "saved" } }] } : null } } })
  }) as typeof fetch
  try {
    const result = await migrate(new GitHubClient("Owner/Repo", "token"), new GitHubTrackerStore("Owner/Repo", "token", "fixture/tracker"))
    expect(result.matches).toBe(true)
    expect(stored.repo).toBe("owner/repo")
    expect(stored.rows.map((row: Row) => row.status)).toEqual(expected)
    expect(pages).toBe(2)
    expect(conflicts).toBe(2)
    expect(requests.every(request => request.method === "PUT" ? request.url.includes("/contents/") : request.url.endsWith("/graphql") && request.query?.startsWith("query {"))).toBe(true)
    expect(requests.some(request => /\/issues(?:\/|$)|mutation/.test(request.url + request.query))).toBe(false)
  } finally { globalThis.fetch = original }
})
