import { afterEach, beforeEach, expect, test } from "bun:test"
import { GitHubTrackerStore, serializeTracker } from "./store.ts"
import { ignoreRows, needsHumanRows, preparePick, reopenRows, type PickClient } from "./pick.ts"
import { setKnownRepos } from "./repos.ts"
import type { Row } from "./rows.ts"

beforeEach(() => { setKnownRepos(() => ["owner/repo"]) })
afterEach(() => { setKnownRepos(() => []) })

const row = (n: number): Row => ({
  id: n.toString(16).padStart(64, "0"), category: "sqli", date: "01-01-2026",
  file: `app/api/${n}.php`, lines: [1], severity: "P1", status: "open", reason: "", pr: "",
})
const client: PickClient = { openPRFiles: async () => [], prState: async () => "open" }

async function withTracker(rows: Row[], run: (store: GitHubTrackerStore, saved: () => { log: { message: string }[], rows: Row[] }, commits: string[]) => Promise<void>) {
  const original = globalThis.fetch
  let content = serializeTracker("owner/repo", { category: "sqli", rows, log: [], url: "" })
  const commits: string[] = []
  globalThis.fetch = (async (_url, init) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(init.body as string)
      commits.push(body.message)
      content = Buffer.from(body.content, "base64").toString()
      return Response.json({ content: { sha: "new-sha" } })
    }
    return Response.json({ data: { repository: { object: { entries: [{ name: "sqli.json", object: { text: content, oid: "sha" } }] } } } })
  }) as typeof fetch
  try { await run(new GitHubTrackerStore("owner/repo", "fixture-operator-credential", "owner/tracker"), () => JSON.parse(content), commits) }
  finally { globalThis.fetch = original }
}

test("Ignore, Needs human and Reopen log the change and title the commit", async () => {
  await withTracker([row(1), row(2), row(3)], async (store, saved, commits) => {
    await ignoreRows(client, store, "owner/repo", [row(1).id, row(2).id], "  Test-only endpoint  ")
    await needsHumanRows(client, store, "owner/repo", [row(3).id], "x".repeat(150))
    await reopenRows(client, store, "owner/repo", [row(1).id])
    const expected = ["Ignored 2 row(s): Test-only endpoint", `Needs human for 1 row(s): ${"x".repeat(100)}`, "Reopened 1 row(s)"]
    expect(saved().log.map(entry => entry.message)).toEqual(expected)
    expect(commits).toEqual(expected)
  })
})

test("Pick logs the row count and run id and titles the commit", async () => {
  await withTracker([row(1), row(2)], async (store, saved, commits) => {
    await (await preparePick(client, store, "owner/repo", [row(1).id, row(2).id])).mark("run-7")
    expect(saved().log.map(entry => entry.message)).toEqual(["Picked 2 row(s) for a fix (run run-7)"])
    expect(commits).toEqual(["Picked 2 row(s) for a fix (run run-7)"])
  })
  await withTracker([row(1)], async (store, saved) => {
    await (await preparePick(client, store, "owner/repo", [row(1).id])).mark()
    expect(saved().log.map(entry => entry.message)).toEqual(["Picked 1 row(s) for a fix"])
  })
})

test("a secret in an Ignore reason is scrubbed from the log, the commit title and the row", async () => {
  const secret = ["ghp", "_", "a".repeat(36)].join("")
  await withTracker([row(1)], async (store, saved, commits) => {
    await ignoreRows(client, store, "owner/repo", [row(1).id], `leaked ${secret} in the test fixture`)
    for (const text of [JSON.stringify(saved()), commits.join("\n")]) expect(text).not.toContain(secret)
    expect(commits[0]).toStartWith("Ignored 1 row(s): leaked ")
    expect(saved().log).toHaveLength(1)
  })
})

test("a token cut by the 100 character log limit leaves no prefix in the log", async () => {
  const secret = ["ghp", "_", "a".repeat(36)].join("")
  const reason = `${"x".repeat(90)} ${secret} tail`
  await withTracker([row(1)], async (store, saved, commits) => {
    await ignoreRows(client, store, "owner/repo", [row(1).id], reason)
    for (const text of [saved().log[0].message, commits[0]]) expect(text).not.toMatch(/ghp_|ghp/)
  })
})
