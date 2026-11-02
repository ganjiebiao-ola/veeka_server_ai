import { test, expect } from "bun:test"
import { GitHubClient } from "./client.ts"
import { GitHubTrackerStore, recordPR, type TrackerFile, type TrackerStore } from "./store.ts"
import { closeStep } from "./close_pr.ts"

test("impact PR metadata loads numbered pages in parallel waves and shares its cached in-flight read across clients", async () => {
  const original = fetch
  const urls: string[] = []
  let total = 2050
  globalThis.fetch = (async (url: any) => {
    urls.push(String(url))
    const page = Number(new URL(String(url)).searchParams.get("page"))
    const numbers = Array.from({ length: Math.max(0, Math.min(100, total - (page - 1) * 100)) }, (_, i) => (page - 1) * 100 + i + 1)
    return Response.json(numbers.map(number => ({ number, title: "Fix", html_url: `u${number}`, state: number === 1 ? "open" : "closed", merged_at: number === 2 ? "2026-01-01T00:00:00Z" : null,
      head: { ref: "security/sqli-app-12345678", sha: "a".repeat(40) }, base: { sha: "b".repeat(40) } })))
  }) as unknown as typeof fetch
  try {
    const a = new GitHubClient("a/impact-cache-test", "test"), b = new GitHubClient("a/impact-cache-test", "test")
    const result = await Promise.all([a.impactPRs(), b.impactPRs()])
    expect(result[0]).toHaveLength(2050)
    expect(result[0].slice(0, 3).map(pr => pr.state)).toEqual(["open", "merged", "closed"])
    expect(result[0][0]).toEqual({ number: 1, title: "Fix", url: "u1", state: "open", head: "a".repeat(40), base: "b".repeat(40), ref: "security/sqli-app-12345678" })
    expect(urls).toHaveLength(40)
    expect(urls.every(url => url.includes("pulls?state=all&sort=created&direction=asc&per_page=100&page="))).toBe(true)
    await a.impactPRs()
    expect(urls).toHaveLength(40)
    total = 50
    const c = new GitHubClient("a/impact-short-test", "test")
    expect(await c.impactPRs()).toHaveLength(50)
    expect(urls).toHaveLength(60)
  } finally { globalThis.fetch = original }
})
test("tracker metadata survives a normal row update and a JSON round trip", async () => {
  const original = fetch
  let content = ""
  globalThis.fetch = (async (_url: any, init: RequestInit) => {
    if (init.method === "PUT") {
      content = Buffer.from(JSON.parse(String(init.body)).content, "base64").toString()
      return Response.json({ content: { sha: "file-sha" } })
    }
    return Response.json({ data: { repository: { object: { entries: [{ name: "sqli.json", object: { text: content, oid: "file-sha" } }] } } } })
  }) as unknown as typeof fetch
  try {
    const store = new GitHubTrackerStore("a/b", "token")
    const file = { category: "sqli", rows: [], log: [], url: "", prs: { 7: { pushedSha: "a".repeat(40), closeReason: "superseded" } } }
    await store.write(file, [], "Update")
    const read = (await store.read())[0]
    expect(read.prs).toEqual(file.prs)
    await store.write(read, [], "Other update")
    expect(JSON.parse(content).prs).toEqual(file.prs)
  } finally { globalThis.fetch = original }
})
test("close reason is recorded in the tracker log and legacy superseded reads as replaced", async () => {
  let files: TrackerFile[] = [{ category: "sqli", rows: [], log: [], url: "", prs: { 7: {} } }]
  const store: TrackerStore = { async read() { return structuredClone(files) }, async write(file, rows, message) {
    const next = { ...file, rows, log: [...file.log, { at: "now", message }] }; files = [next]; return next
  } }
  const client = { async suitePR() { return { state: "open", merged: false, ref: "security/sqli-app-12345678", sameRepo: true } }, async listComments() { return [] }, async commentPR() {}, async closePR() {} } as any
  await closeStep(client, store, "a/b", 7, "comment", "superseded")
  await closeStep(client, store, "a/b", 7, "close", "superseded")
  expect(files[0].prs?.[7].closeReason).toBe("replaced by a newer PR")
  expect(files[0].log[0].message).toContain("replaced by a newer PR")
  await recordPR(store, 7, { pushedSha: "a".repeat(40) }, ["sqli"], "pushed")
  expect(files[0].prs?.[7].closeReason).toBe("replaced by a newer PR")
})
