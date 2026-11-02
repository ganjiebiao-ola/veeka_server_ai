import { test } from "bun:test"
import { strict as assert } from "node:assert"
import { GitHubClient } from "./client.ts"
import { withTrackerLock } from "./tracker.ts"

const files = (paths: string[], more = false, cursor: string | null = null) => ({
  nodes: paths.map(path => ({ path, changeType: "MODIFIED" })), pageInfo: { hasNextPage: more, endCursor: cursor },
})
const response = (repository: unknown) => Response.json({ data: { repository } })

test("every GitHub method times out and releases the tracker lock", async () => {
  const originalFetch = globalThis.fetch
  const originalTimer = globalThis.setTimeout
  const methods: string[] = []
  globalThis.setTimeout = ((handler: () => void, ms: number) => {
    assert.equal(ms, 15_000)
    return originalTimer(handler, 0)
  }) as typeof setTimeout
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    methods.push(init?.method ?? "GET")
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
    })
  }) as unknown as typeof fetch
  const client = new GitHubClient("timeout/repo", "placeholder")
  try {
    for (const action of [() => client.prState(1), () => client.commentPR(1, "test"),
      () => client.closePR(1), () => client.deleteBranch("security/sqli-api-0123abcd")]) {
      const held = withTrackerLock<unknown>(client.repo, action)
      const next = withTrackerLock(client.repo, async () => "released")
      await assert.rejects(held, /tracker GitHub request timed out/)
      assert.equal(await next, "released")
    }
    assert.deepEqual(methods, ["GET", "POST", "PATCH", "DELETE"])
  } finally {
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalTimer
  }
})

test("PR and file pagination caches across clients for 60 seconds", async () => {
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  let now = originalNow()
  Date.now = () => now
  const queries: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("pulls/1/files?")) {
      queries.push(String(input))
      return Response.json([{ filename: "b.php" }])
    }
    const query = JSON.parse(String(init?.body)).query as string
    queries.push(query)
    if (query.includes('after: "next-prs"')) return response({ pullRequests: {
      nodes: [{ number: 2, headRefName: "dev", files: files(["c.php"]) }], pageInfo: { hasNextPage: false },
    } })
    return response({ pullRequests: { nodes: [{ number: 1, headRefName: "security/sqli-api-0123abcd", changedFiles: 101,
      files: files(["a.php"], true, "next-files") }], pageInfo: { hasNextPage: true, endCursor: "next-prs" } } })
  }) as unknown as typeof fetch
  try {
    const client = new GitHubClient("pagination/repo", "placeholder")
    assert.deepEqual((await client.openPRs(undefined, true)).flatMap(pr => pr.files), ["a.php", "b.php", "c.php"])
    assert.equal(queries.length, 3)
    assert.ok(queries[0].includes("changedFiles"))
    assert.ok(queries[1].endsWith("pulls/1/files?per_page=100&page=2"))
    now += 59_999
    assert.equal((await new GitHubClient(client.repo, "placeholder").openPRs(undefined, true)).length, 2)
    assert.equal(queries.length, 3)
    now++
    await client.openPRs(undefined, true)
    assert.equal(queries.length, 6)
    await new GitHubClient(client.repo, "another-placeholder").openPRs(undefined, true)
    assert.equal(queries.length, 9)
  } finally {
    Date.now = originalNow
    globalThis.fetch = originalFetch
  }
})

test("GraphQL errors fail closed and do not poison the open-PR cache", async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return calls === 1 ? Response.json({ errors: [{ message: "unavailable" }], data: { repository: {} } })
      : response({ pullRequests: { nodes: [], pageInfo: { hasNextPage: false } } })
  }) as unknown as typeof fetch
  try {
    const client = new GitHubClient("retry/repo", "placeholder")
    await assert.rejects(client.openPRs(undefined, true), /tracker GitHub GraphQL request failed/)
    assert.deepEqual(await client.openPRs(undefined, true), [])
    assert.equal(calls, 2)
  } finally { globalThis.fetch = original }
})

for (const changedFiles of [100, 377, 601, 3000]) for (const firstRename of [false, true]) {
  test(`${changedFiles} changed files, first-page rename ${firstRename}, use at most four REST pages and keep paths`, async () => {
    const original = globalThis.fetch
    const paths = Array.from({ length: Math.min(changedFiles, 3000) }, (_, i) => `file-${i}.php`)
    const renamed = new Map<number, string>()
    if (firstRename) renamed.set(5, "old-first.php")
    renamed.set(200, "old-later.php")
    const requested: number[] = []
    let active = 0
    let peak = 0
    let queries = 0
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/graphql")) {
        queries++
        assert.match(JSON.parse(String(init?.body)).query, /changedFiles/)
        const first = files(paths.slice(0, 100), changedFiles > 100)
        if (firstRename) first.nodes[5].changeType = "RENAMED"
        return response({ pullRequests: { nodes: [{ number: 7, headRefName: "dev", changedFiles, files: first }],
          pageInfo: { hasNextPage: false } } })
      }
      const url = new URL(String(input))
      assert.equal(url.pathname, "/repos/parallel/repo/pulls/7/files")
      assert.equal(url.searchParams.get("per_page"), "100")
      const page = Number(url.searchParams.get("page"))
      requested.push(page)
      active++
      peak = Math.max(peak, active)
      // Reverse completion order to check that it cannot change the returned paths.
      await new Promise(resolve => setTimeout(resolve, 5 - page % 4))
      active--
      return Response.json(paths.slice((page - 1) * 100, page * 100).map((filename, i) => ({
        filename, previous_filename: renamed.get((page - 1) * 100 + i),
      })))
    }) as unknown as typeof fetch
    try {
      const result = await new GitHubClient("parallel/repo", "placeholder").openPRs()
      const lastPage = Math.min(30, Math.ceil(changedFiles / 100))
      const firstPage = firstRename ? 1 : 2
      const pages = Math.max(0, lastPage - firstPage + 1)
      assert.deepEqual(requested, Array.from({ length: pages }, (_, i) => i + firstPage))
      assert.equal(peak, Math.min(4, pages))
      assert.equal(queries, 1)
      assert.deepEqual(result, [{ number: 7, headRefName: "dev",
        files: [...paths, ...[...renamed].filter(([index]) => index < paths.length).map(([, path]) => path)] }])
    } finally { globalThis.fetch = original }
  })
}

test("REST file failures reject the read and evict the open-PR cache", async () => {
  const original = globalThis.fetch
  let fail = true
  let reads = 0
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/graphql")) {
      reads++
      return response({ pullRequests: { nodes: [{ number: 7, headRefName: "dev", changedFiles: 101,
        files: files(["first.php"], true) }], pageInfo: { hasNextPage: false } } })
    }
    return fail ? new Response(null, { status: 503 }) : Response.json([{ filename: "last.php", previous_filename: "old.php" }])
  }) as unknown as typeof fetch
  try {
    const client = new GitHubClient("rest-retry/repo", "placeholder")
    await assert.rejects(client.openPRs(undefined, true), /tracker GitHub request failed \(503\)/)
    fail = false
    assert.deepEqual((await client.openPRs(undefined, true))[0].files, ["first.php", "last.php", "old.php"])
    assert.equal(reads, 2)
  } finally { globalThis.fetch = original }
})

test("PR state lookups batch unique numbers and handle missing PRs", async () => {
  const original = globalThis.fetch
  const queries: string[] = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const query = JSON.parse(String(init?.body)).query as string
    queries.push(query)
    return response(Object.fromEntries([...query.matchAll(/pr(\d+):/g)].map(([, n]) =>
      [`pr${n}`, Number(n) === 999 ? null : { state: ["OPEN", "MERGED", "CLOSED"][Number(n) % 3] }])))
  }) as unknown as typeof fetch
  try {
    const client = new GitHubClient("states/repo", "placeholder")
    const states = await client.prStates([...Array.from({ length: 101 }, (_, i) => i + 1), 1])
    assert.equal(states.size, 101)
    assert.deepEqual([states.get(1), states.get(2), states.get(3)], ["merged", "closed", "open"])
    assert.equal(queries.length, 2)
    assert.equal(await client.prStates([]).then(states => states.size), 0)
    assert.equal(queries.length, 2)
    await assert.rejects(client.prStates([999]), /PR state missing/)
  } finally { globalThis.fetch = original }
})

test("creating or closing a PR invalidates the shared open-PR cache", async () => {
  const original = globalThis.fetch
  let reads = 0
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/graphql")) {
      reads++
      return response({ pullRequests: { nodes: [], pageInfo: { hasNextPage: false } } })
    }
    return Response.json({ number: 7 })
  }) as unknown as typeof fetch
  try {
    const client = new GitHubClient("invalidate/repo", "placeholder")
    await client.openPRs(undefined, true)
    await client.createPR({ head: "security/sqli-api-0123abcd", base: "main", title: "Fixture", body: "", draft: true })
    await new GitHubClient(client.repo, "placeholder").openPRs(undefined, true)
    await client.closePR(7)
    await client.openPRs(undefined, true)
    assert.equal(reads, 3)
  } finally { globalThis.fetch = original }
})

test("a PR above the 3000-file REST limit keeps every path through GraphQL pages", async () => {
  const original = globalThis.fetch
  const paths = Array.from({ length: 3100 }, (_, i) => `file-${i}.php`)
  const restPages: number[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/graphql")) {
      const query = JSON.parse(String(init?.body)).query as string
      const after = Number(query.match(/after: "c(\d+)"/)?.[1] ?? 0)
      const page = files(paths.slice(after, after + 100), after + 100 < paths.length, `c${after + 100}`)
      if (after === 200) page.nodes[0].changeType = "RENAMED"
      return response(after ? { pullRequest: { files: page } }
        : { pullRequests: { nodes: [{ number: 7, headRefName: "dev", changedFiles: 3100, files: page }], pageInfo: { hasNextPage: false } } })
    }
    const pageNumber = Number(new URL(String(input)).searchParams.get("page"))
    restPages.push(pageNumber)
    return Response.json(paths.slice((pageNumber - 1) * 100, Math.min(pageNumber * 100, 3000)).map((filename, i) => ({
      filename, previous_filename: (pageNumber - 1) * 100 + i === 200 ? "old-later.php" : undefined,
    })))
  }) as unknown as typeof fetch
  try {
    const [pr] = await new GitHubClient("huge/repo", "placeholder").openPRs()
    assert.deepEqual(new Set(pr.files), new Set([...paths, "old-later.php"]))
    assert.equal(restPages.length, 30)
  } finally { globalThis.fetch = original }
})
