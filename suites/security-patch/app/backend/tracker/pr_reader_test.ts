import { test } from "bun:test"
import assert from "node:assert/strict"
import { Hono } from "hono"
import { GitHubClient } from "./client.ts"
import { handleReadPR } from "../handlers/pr_reader.ts"
import { setKnownRepos } from "./repos.ts"

const pr = {
  number: 7, title: "Hardening queries", body: "## Fix pattern\n\nUse bindings.", state: "open", draft: false, merged: false,
  html_url: "https://github.com/a/b/pull/7", user: { login: "fixture" }, updated_at: "2026-10-14T00:00:00Z",
  head: { ref: "security/sqli-app-1234abcd", sha: "a".repeat(40) }, base: { ref: "main", sha: "b".repeat(40) },
  additions: 2, deletions: 1, changed_files: 101,
}

test("PR reader paginates files and discussion, pins checks to the commit, and only reads GitHub", async () => {
  const original = globalThis.fetch
  const requests: { path: string, method: string }[] = []
  let metadataReads = 0
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input))
    const path = url.pathname.replace("/repos/a/b/", "")
    requests.push({ path: path + url.search, method: init?.method ?? "GET" })
    if (path === "pulls/7") { metadataReads++; return Response.json(pr) }
    const page = Number(url.searchParams.get("page"))
    assert.equal(url.searchParams.get("per_page"), "100")
    if (path === "pulls/7/files") return Response.json(Array.from({ length: page === 1 ? 100 : 1 }, (_, index) => ({ filename: `app/${page}-${index}.php`, status: "modified", additions: 1, deletions: 1 })))
    if (path === "issues/7/comments") return Response.json(Array.from({ length: page === 1 ? 100 : 1 }, (_, index) => ({ id: page * 100 + index, body: "Comment" })))
    if (path.endsWith("/check-runs")) {
      assert(path.includes(pr.head.sha))
      assert.equal(url.searchParams.get("filter"), "latest")
      return Response.json({ check_runs: [{ id: 1, name: "Lint", status: "completed", conclusion: "success" }] })
    }
    if (path.endsWith("/status")) return Response.json({ statuses: [{ id: 2, context: "CI", state: "pending" }] })
    if (path === "pulls/7/reviews") return Response.json([{ id: 3, state: "APPROVED", body: "" }])
    if (path === "pulls/7/comments") return Response.json([{ id: 4, path: "app/query.php", body: "Review note", in_reply_to_id: 5 }])
    throw new Error("Unexpected request")
  }) as typeof fetch
  try {
    const data = await new GitHubClient("a/b", "placeholder").readPR(7)
    assert.equal(data.files.length, 101)
    assert.equal(data.comments.length, 101)
    assert.equal(data.body, pr.body)
    assert.equal(data.checks[0].conclusion, "success")
    assert.equal(data.statuses[0].state, "pending")
    assert.equal(data.reviews[0].state, "APPROVED")
    assert.equal(data.reviewComments[0].in_reply_to_id, 5)
    assert.deepEqual(data.unavailable, {})
    assert.equal(metadataReads, 2)
    assert(requests.every(request => request.method === "GET"))
  } finally { globalThis.fetch = original }
})

test("PR reader rejects other branches before reading files and exposes partial failures", async () => {
  const original = globalThis.fetch
  let suite = false
  let calls = 0
  globalThis.fetch = (async (input) => {
    calls++
    const path = new URL(String(input)).pathname
    if (path.endsWith("pulls/7")) return Response.json({ ...pr, head: { ...pr.head, ref: suite ? pr.head.ref : "feature/unrelated" } })
    if (path.endsWith("check-runs")) return new Response(null, { status: 403 })
    if (path.endsWith("status")) return Response.json({ statuses: [] })
    if (path.endsWith("files")) return new Response(null, { status: 502 })
    return Response.json([])
  }) as typeof fetch
  try {
    const client = new GitHubClient("a/b", "placeholder")
    await assert.rejects(client.readPR(7), /not a suite PR/)
    assert.equal(calls, 1)
    suite = true
    const data = await client.readPR(7)
    assert.match(data.unavailable.checks!, /403/)
    assert.match(data.unavailable.files!, /502/)
    assert.equal(data.body, pr.body)
    assert.deepEqual(data.files, [])
    assert.deepEqual(data.checks, [])
  } finally { globalThis.fetch = original }
})

test("PR reader rejects a changed commit instead of returning mixed diffs and checks", async () => {
  const original = globalThis.fetch
  let reads = 0
  globalThis.fetch = (async input => {
    const path = new URL(String(input)).pathname
    if (path.endsWith("pulls/7")) return Response.json({ ...pr, head: { ...pr.head, sha: ++reads === 1 ? pr.head.sha : "c".repeat(40) } })
    if (path.endsWith("check-runs")) return Response.json({ check_runs: [] })
    if (path.endsWith("status")) return Response.json({ statuses: [] })
    return Response.json([])
  }) as typeof fetch
  try { await assert.rejects(new GitHubClient("a/b", "placeholder").readPR(7), /changed while loading/) }
  finally { globalThis.fetch = original }
})

test("PR reader validates repository and PR number before calling GitHub", async () => {
  setKnownRepos(() => ["a/b"])
  let calls = 0
  const app = new Hono().get("/prs/:number", c => handleReadPR(c, { async readPR() { calls++; return { ...pr } as never } }))
  try {
    for (const path of ["/prs/0", "/prs/-1", "/prs/1e2", "/prs/9007199254740992", "/prs/7?repo=evil/repo"]) {
      assert.equal((await app.request(path)).status, 400)
    }
    assert.equal(calls, 0)
    assert.equal((await app.request("/prs/7?repo=a%2Fb")).status, 200)
    assert.equal(calls, 1)
  } finally {
    setKnownRepos(() => [])
  }
})
