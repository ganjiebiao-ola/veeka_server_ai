import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp, rm } from "node:fs/promises"
import { afterEach, beforeEach, test } from "bun:test"
import { deepStrictEqual as assertEquals, throws } from "node:assert/strict"
import type { Context } from "hono"
import { handleOverview, handlePick, handleTrackers } from "../handlers/pick.ts"
import { handleListRepos, handleRemoveRepo } from "../handlers/repos.ts"
import { Store } from "../store/repo.ts"
import { githubRepo, resolveTracker, setKnownRepos, trackerForUrl, trackerRepos } from "./repos.ts"
import { GitHubClient } from "./client.ts"

beforeEach(() => { setKnownRepos(() => []) })
afterEach(() => { setKnownRepos(() => []) })

test("rejects dot-only repository components", () => {
  for (const repo of ["./user", "../user", ".../user", "user/.", "user/..", "user/..."]) {
    assertEquals(githubRepo(`https://github.com/${repo}`), undefined)
    throws(() => new GitHubClient(repo, "placeholder"), /invalid tracker repository/)
  }
  assertEquals(githubRepo("user/...git"), undefined)
  assertEquals(githubRepo("owner.name/repo.name.git"), "owner.name/repo.name")
})

test("tracker list preserves order and deduplicates repositories", () => {
  assertEquals(trackerRepos(), [])
  throws(() => resolveTracker(), /no repo yet: start a scan on a GitHub repo first/)
  setKnownRepos(() => ["a/one", "b/two", "A/One"])
  assertEquals(trackerRepos(), ["a/one", "b/two"])
  assertEquals(resolveTracker(), "a/one")
  assertEquals(resolveTracker("B/Two"), "b/two")
  throws(() => resolveTracker("evil/repo"), /not a configured tracker/)
  assertEquals(trackerForUrl("https://github.com/b/two.git"), "b/two")
  assertEquals(trackerForUrl("https://github.com/evil/repo"), undefined)
})

test("Pick and Overview reject an unlisted repo with 400, and /api/trackers lists the allowlist", async () => {
  setKnownRepos(() => ["a/one", "b/two", "A/One"])
  const call = async (run: (c: Context) => Promise<Response> | Response, query: Record<string, string>) => {
    let status = 200
    let payload: unknown
    const c = { req: { query: (name: string) => query[name], queries: () => [] },
      json: (value: unknown, code = 200) => { payload = value; status = code; return new Response() } } as unknown as Context
    await run(c)
    return { status, payload }
  }
  assertEquals((await call((c) => handlePick(c, {} as never), { repo: "evil/repo" })).status, 400)
  assertEquals((await call((c) => handleOverview(c, {} as never), { repo: "evil/repo" })).status, 400)
  assertEquals((await call((c) => handleTrackers(c), {})).payload, { repos: ["a/one", "b/two"], removable: ["a/one", "b/two"] })
})

test("the repos list and remove endpoints round-trip through the store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const store = await Store.open(`${dir}/repos.sqlite`)
  try {
    store.touchRepo("a/one", "https://github.com/A/One", "main")
    store.touchRepo("b/two", "https://github.com/b/two", "")
    store.touchRepo("a/one", "https://github.com/A/One", "dev")
    assertEquals(store.listRepos().map((r) => [r.repo, r.branch]), [["a/one", "dev"], ["b/two", ""]])
    const call = (run: (c: Context) => Response, query: Record<string, string> = {}) => {
      let status = 200
      let payload: unknown
      const c = { req: { query: (name: string) => query[name] }, json: (value: unknown, code = 200) => { payload = value; status = code; return new Response() } } as unknown as Context
      run(c)
      return { status, payload }
    }
    assertEquals(call((c) => handleRemoveRepo(c, { store }), { url: "not a repo" }).status, 400)
    assertEquals(call((c) => handleRemoveRepo(c, { store }), { url: "https://github.com/A/One.git" }).status, 200)
    assertEquals((call((c) => handleListRepos(c, { store })).payload as { repos: unknown[] }).repos.length, 1)
  } finally { store.close(); await rm(dir, { recursive: true }) }
})
