import { test, expect } from "bun:test"
import { GitHubTrackerStore, TrackerConflict, retryTracker, serializeTracker, storeRows } from "./store.ts"
import type { Row, Status } from "./rows.ts"

const row = (id: string): Row => ({ id, category: "sqli", file: "app/test.php", lines: [1], severity: "P1", status: "open", reason: "reason", date: "01-01-2026", pr: "" })
const file = { category: "sqli", rows: [row("b"), row("a")], log: [], url: "" }

test("serializes sorted rows one per line and round trips", () => {
  const text = serializeTracker("owner/repo", file)
  expect(text.split("\n").filter(line => line.trimStart().startsWith('{"id"'))).toHaveLength(2)
  expect(JSON.parse(text).rows).toEqual([row("a"), row("b")])
})

const legacyStatuses = ["candidate", "deferred", "picked", "in PR", "false positive", "won't fix"] as const
const currentStatuses: Status[] = ["open", "open", "in progress", "in progress", "ignored", "ignored"]

test("store rows normalize legacy statuses without changing the source", () => {
  const rows = legacyStatuses.map((status, i) => ({ ...row(i.toString(16)), status }))
  expect(storeRows([{ ...file, rows }]).map(row => row.status)).toEqual(currentStatuses)
  expect(rows.map(row => row.status)).toEqual([...legacyStatuses])
})

test("store rows deduplicate by id and prefer destinations regardless of file order or misc kind", () => {
  const destination = { ...row("a"), status: "ignored" as const }
  const misc = { category: "misc", rows: [{ ...row("a"), category: "misc", kind: "" }, { ...row("b"), category: "misc", kind: "sqli" }], log: [], url: "" }
  const target = { ...file, rows: [destination, destination] }
  for (const files of [[misc, target], [target, misc]]) {
    expect(storeRows(files).sort((a, b) => a.id.localeCompare(b.id))).toEqual([destination, misc.rows[1]])
  }
})

test("store reads legacy statuses and writes only current statuses", async () => {
  const original = globalThis.fetch
  const rows = legacyStatuses.map((status, i) => ({ ...row(i.toString(16)), status }))
  let content = JSON.stringify({ version: 1, repo: "owner/repo", ...file, rows })
  globalThis.fetch = (async (_url, init) => {
    if (init?.method === "PUT") {
      content = Buffer.from(JSON.parse(init.body as string).content, "base64").toString()
      return Response.json({ content: { sha: "new-sha" } })
    }
    return Response.json({ data: { repository: { object: { entries: [{ name: "sqli.json", object: { text: content, oid: "sha" } }] } } } })
  }) as typeof fetch
  try {
    const store = new GitHubTrackerStore("owner/repo", "token")
    expect((await store.read())[0].rows.map(row => row.status)).toEqual(currentStatuses)
    const saved = await store.write(file, rows, "")
    expect(saved.rows.map(row => row.status)).toEqual(currentStatuses)
    expect(JSON.parse(content).rows.map((row: Row) => row.status)).toEqual(currentStatuses)
  } finally { globalThis.fetch = original }
})

test("store preserves vendor versions through scrubbing and JSON round trips", async () => {
  const original = globalThis.fetch
  let content = ""
  globalThis.fetch = (async (_url, init) => {
    if (init?.method === "PUT") {
      content = Buffer.from(JSON.parse(init.body as string).content, "base64").toString()
      return Response.json({ content: { sha: "sha" } })
    }
    return Response.json({ data: { repository: { object: { entries: [{ name: `${JSON.parse(content).category}.json`, object: { text: content, oid: "sha" } }] } } } })
  }) as typeof fetch
  try {
    const store = new GitHubTrackerStore("owner/repo", "token")
    for (const category of ["vendor-cve", "misc"]) {
      const rows = ["1.2.3.4", "sk-abcdefghijklmnopqrstuv", "1.0.0|x", "1.0%25", "1.0&amp;2", "dev-main#a1b2"].map((version, i) => ({
        ...row(i.toString(16)), category, ...(category === "misc" ? { kind: "vendor-cve" } : {}),
        file: `example/client@${version}`, reason: "token=abcdefghijklmnopqrstuv",
      }))
      const saved = await store.write({ ...file, category, rows: [] }, rows, "")
      expect(saved.rows.map(row => row.file)).toEqual(rows.map(row => row.file))
      expect(saved.rows.every(row => !row.reason.includes("abcdefghijklmnopqrstuv"))).toBe(true)
      expect((await store.read())[0].rows).toEqual(saved.rows)
    }
  } finally { globalThis.fetch = original }
})

test("read rejects a broken file", async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => Response.json({ data: { repository: { object: { entries: [{ name: "sqli.json", object: { text: JSON.stringify({ version: 2 }), oid: "sha" } }] } } } })) as unknown as typeof fetch
  try { await expect(new GitHubTrackerStore("owner/repo", "token").read()).rejects.toThrow("invalid tracker file") }
  finally { globalThis.fetch = original }
})

test("read rejects duplicate row ids within a file", async () => {
  const original = globalThis.fetch
  const content = JSON.stringify({ version: 1, repo: "owner/repo", ...file,
    rows: [row("a"), row("b"), { ...row("a"), reason: "new reason" }] })
  globalThis.fetch = (async () => Response.json({ data: { repository: { object: { entries: [{ name: "sqli.json", object: { text: content, oid: "sha" } }] } } } })) as unknown as typeof fetch
  try { await expect(new GitHubTrackerStore("owner/repo", "token").read()).rejects.toThrow("duplicate tracker row id") }
  finally { globalThis.fetch = original }
})

test("write rejects duplicate row ids before transport", async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => { calls++; throw new Error("unexpected transport") }) as unknown as typeof fetch
  try {
    const rows = [row("a"), row("b"), { ...row("a"), reason: "new reason" }]
    await expect(new GitHubTrackerStore("owner/repo", "token").write(file, rows, "")).rejects.toThrow("duplicate tracker row id")
    expect(calls).toBe(0)
  } finally { globalThis.fetch = original }
})

test("write rejects ids that need scrubbing without exposing or changing them", async () => {
  const original = globalThis.fetch
  const token = "fixture.operator.secret.123456"
  let calls = 0
  globalThis.fetch = (async () => { calls++; throw new Error("unexpected transport") }) as unknown as typeof fetch
  try {
    for (const secret of [token, "sk-abcdefghijklmnopqrstuv", "fake@example.test", "8.8.8.8"]) {
      const id = `pr7:app/${secret}.php`
      const rows = [{ ...row(id), lines: [42] }]
      await expect(new GitHubTrackerStore("owner/repo", token).write(file, rows, "")).rejects.toThrow(new Error("unsafe tracker row id in sqli at line 42"))
      expect(rows[0].id).toBe(id)
    }
    expect(calls).toBe(0)
  } finally { globalThis.fetch = original }
})

test("write reports a conflict", async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response(null, { status: 409 })) as unknown as typeof fetch
  try { await expect(new GitHubTrackerStore("owner/repo", "token").write(file, file.rows, "update")).rejects.toBeInstanceOf(TrackerConflict) }
  finally { globalThis.fetch = original }
})

test("retry reapplies after a conflict and stops after two retries", async () => {
  let calls = 0
  const store = { read: async () => [], write: async () => file }
  expect(await retryTracker(store, async () => { if (++calls === 1) throw new TrackerConflict(); return calls })).toBe(2)
  calls = 0
  await expect(retryTracker(store, async () => { calls++; throw new TrackerConflict() })).rejects.toBeInstanceOf(TrackerConflict)
  expect(calls).toBe(3)
})


test("store scrubs every free-text field, including vendor package names and old logs", async () => {
  const original = globalThis.fetch
  const token = "fixture.operator.secret.123456"
  let payload: any
  globalThis.fetch = (async (_url, init) => {
    payload = JSON.parse(init!.body as string)
    return Response.json({ content: { sha: "sha" } })
  }) as typeof fetch
  try {
    for (const category of ["sqli", "vendor-cve", "misc"]) {
      const rows = [{ ...row("a"), category,
        ...(category === "misc" ? { kind: "vendor-cve" } : {}),
        file: category === "sqli" ? `app/${token}.php` : `example/${token}@1.2.3.4`,
        reason: token, pr: `[${token}](https://example.test/${token})`, extra: token }]
      const saved = await new GitHubTrackerStore("owner/repo", token).write({ ...file, category,
        log: [{ at: token, message: token, extra: token } as any] }, rows, token)
      const content = Buffer.from(payload.content, "base64").toString()
      expect(content).not.toContain(token)
      expect(JSON.stringify(saved)).not.toContain(token)
      expect(payload.message).not.toContain(token)
      if (category !== "sqli") expect(saved.rows[0].file).toEndWith("@1.2.3.4")
    }
  } finally { globalThis.fetch = original }
})

test("mixed-case business repos use the same read and write directory", async () => {
  const original = globalThis.fetch
  const requests: { url: string, body: any }[] = []
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init!.body as string) })
    return init?.method === "PUT" ? Response.json({ content: { sha: "sha" } })
      : Response.json({ data: { repository: { object: null } } })
  }) as typeof fetch
  try {
    for (const repo of ["Owner/Repo", "owner/repo"]) {
      const store = new GitHubTrackerStore(repo, "token")
      expect(await store.read()).toEqual([])
      await store.write(file, file.rows, "")
    }
    expect(requests[0].body.query).toContain("main:trackers/repo")
    expect(requests[0]).toEqual(requests[2])
    expect(requests[1]).toEqual(requests[3])
    expect(JSON.parse(Buffer.from(requests[1].body.content, "base64").toString()).repo).toBe("owner/repo")
  } finally { globalThis.fetch = original }
})

test("both tracker transports abort stalled requests after 15 seconds", async () => {
  const originalFetch = globalThis.fetch
  const originalTimeout = AbortSignal.timeout
  const delays: number[] = []
  const controllers: AbortController[] = []
  AbortSignal.timeout = (ms: number) => {
    delays.push(ms)
    const controller = new AbortController()
    controllers.push(controller)
    return controller.signal
  }
  globalThis.fetch = ((_url, init) => new Promise<Response>((_resolve, reject) => {
    expect(init?.signal).toBeDefined()
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))
  })) as typeof fetch
  try {
    const store = new GitHubTrackerStore("owner/repo", "token")
    for (const operation of [() => store.read(), () => store.write(file, file.rows, "")]) {
      const pending = operation()
      expect(delays.at(-1)).toBe(15_000)
      controllers.at(-1)!.abort(new Error("fixture timeout"))
      await expect(pending).rejects.toThrow("fixture timeout")
    }
    expect(delays).toEqual([15_000, 15_000])
  } finally { globalThis.fetch = originalFetch; AbortSignal.timeout = originalTimeout }
})

for (const error of [{ message: "sha does not match" }, { errors: [{ field: "sha", code: "missing_field" }] }]) {
  test(`422 SHA conflict retries: ${JSON.stringify(error)}`, async () => {
    const original = globalThis.fetch
    let writes = 0
    globalThis.fetch = (async (_url, init) => {
      if (init?.method === "PUT") return ++writes === 1 ? Response.json(error, { status: 422 }) : Response.json({ content: { sha: "new" } })
      return Response.json({ data: { repository: { object: null } } })
    }) as typeof fetch
    try {
      const store = new GitHubTrackerStore("owner/repo", "token")
      await retryTracker(store, async () => store.write(file, file.rows, ""))
      expect(writes).toBe(2)
    } finally { globalThis.fetch = original }
  })
}

test("non-conflict 422 and missing repositories fail without retries", async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async (_url, init) => {
    calls++
    return init?.method === "PUT" ? Response.json({ message: "invalid content" }, { status: 422 })
      : Response.json({ data: { repository: null } })
  }) as typeof fetch
  try {
    const store = new GitHubTrackerStore("owner/repo", "token")
    await expect(retryTracker({ read: async () => [], write: store.write.bind(store) }, async () => store.write(file, file.rows, ""))).rejects.toThrow("422")
    expect(calls).toBe(1)
    await expect(store.read()).rejects.toThrow("GraphQL")
  } finally { globalThis.fetch = original }
})

test("repository and category paths reject traversal and invalid segments before transport", async () => {
  for (const repo of ["../repo", "owner/..", "owner/repo/extra", "owner/repo?x", "owner/repo#x", "owner//repo", "owner/", "owner/ repo"]) {
    expect(() => new GitHubTrackerStore(repo, "token")).toThrow("invalid tracker repository")
    expect(() => new GitHubTrackerStore("owner/repo", "token", repo)).toThrow("invalid tracker repository")
  }
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => { calls++; throw new Error("unexpected transport") }) as unknown as typeof fetch
  try {
    for (const category of ["../sqli", "sqli/../../x", "unknown", "sqli.json"]) {
      await expect(new GitHubTrackerStore("owner/repo", "token").write({ ...file, category }, [], "")).rejects.toThrow("category")
    }
    expect(calls).toBe(0)
  } finally { globalThis.fetch = original }
})


test("retry helper reads fresh files before every change and does not retry other errors", async () => {
  let reads = 0
  let changes = 0
  const store = { read: async () => [{ ...file, rows: [row(String(++reads))] }], write: async () => file }
  const result = await retryTracker(store, async files => {
    expect(files[0].rows[0].id).toBe(String(++changes))
    if (changes < 3) throw new TrackerConflict()
    return files[0].rows
  })
  expect(result).toEqual([row("3")])
  expect(reads).toBe(3)
  await expect(retryTracker(store, async () => { throw new Error("permission denied") })).rejects.toThrow("permission denied")
  expect(reads).toBe(4)
})

test("an exact operator token in a vendor version is scrubbed", async () => {
  const original = globalThis.fetch
  let content = ""
  globalThis.fetch = (async (_url, init) => {
    content = Buffer.from(JSON.parse(init!.body as string).content, "base64").toString()
    return Response.json({ content: { sha: "sha" } })
  }) as typeof fetch
  try {
    const operatorCredential = "fixture-operator-credential-123456"
    const rows = [{ ...row("a"), category: "vendor-cve", file: `example/client@${operatorCredential}` }]
    await new GitHubTrackerStore("owner/repo", operatorCredential).write({ ...file, category: "vendor-cve" }, rows, "")
    expect(content).not.toContain(operatorCredential)
  } finally { globalThis.fetch = original }
})

test("read rejects invalid category paths and mismatched document repositories", async () => {
  const original = globalThis.fetch
  try {
    for (const [name, data, error] of [
      ["../sqli.json", { version: 1, repo: "owner/repo", ...file }, "category"],
      ["unknown.json", { version: 1, repo: "owner/repo", ...file }, "category"],
      ["sqli.json", { version: 1, repo: "other/repo", ...file }, "invalid tracker file"],
    ] as const) {
      globalThis.fetch = (async () => Response.json({ data: { repository: { object: { entries: [{ name, object: { text: JSON.stringify(data), oid: "sha" } }] } } } })) as unknown as typeof fetch
      await expect(new GitHubTrackerStore("owner/repo", "token").read()).rejects.toThrow(error)
    }
  } finally { globalThis.fetch = original }
})

test("an imported row id with spaces and brackets round trips through PR metadata", async () => {
  const original = globalThis.fetch
  const id = "pr12:app/Http/My File+[v2].php"
  let content = ""
  globalThis.fetch = (async (_url, init) => {
    if (init?.method === "PUT") {
      content = Buffer.from(JSON.parse(init.body as string).content, "base64").toString()
      return Response.json({ content: { sha: "new-sha" } })
    }
    return Response.json({ data: { repository: { object: { entries: [{ name: "sqli.json", object: { text: content, oid: "sha" } }] } } } })
  }) as typeof fetch
  try {
    const store = new GitHubTrackerStore("owner/repo", "token")
    await store.write({ ...file, prs: { 12: { rowIds: [id] } } }, [row(id)], "")
    expect((await store.read())[0].prs).toEqual({ 12: { rowIds: [id] } })
  } finally { globalThis.fetch = original }
})

test("write refuses PR row ids that validateRow rejects or that need scrubbing, before transport", async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => { calls++; throw new Error("unexpected transport") }) as unknown as typeof fetch
  try {
    const secret = ["sk", "-", "abcdefghijklmnopqrstuv"].join("")
    for (const bad of ["../escape", "pr0:app/a.php", "not-hex", `pr7:app/${secret}.php`]) {
      await expect(new GitHubTrackerStore("owner/repo", "token").write({ ...file, prs: { 7: { rowIds: [bad] } } }, [], "")).rejects.toThrow("invalid tracker PR metadata")
    }
    expect(calls).toBe(0)
  } finally { globalThis.fetch = original }
})
