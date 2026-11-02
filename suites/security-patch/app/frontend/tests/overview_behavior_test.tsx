import { test } from "bun:test"
import assert from "node:assert/strict"
import { OverviewPage, filterOverview } from "../src/pages/OverviewPage"
import { ImpactView } from "../src/components/lazy"
import { TrackerSelect } from "../src/components/TrackerSelect"
import { browser, harness, nodes, text, is } from "./render"

const rows = ([ ["a", "open", "P0", ""], ["b", "in progress", "P1", "[PR #7](https://github.com/owner/repo/pull/7)"],
  ["c", "fixed", "P1", "[PR #8](https://github.com/owner/repo/pull/8)"], ["d", "ignored", "P2", ""] ] as const)
  .map(([id, status, severity, pr], i) => ({ id, category: "sqli", file: `${id}.php`, lines: [i + 1], status, severity, pr, reason: "Check", date: "22-10-2026" }))
const data: Parameters<typeof filterOverview>[0] = {
  repo: "owner/repo", availableTypes: ["sqli", "cors"], types: [{ category: "sqli", url: "", rows, total: 4, counts: { open: 1, "in progress": 1, fixed: 1, ignored: 1 } }, { category: "cors", url: null, rows: [], total: 0, counts: {} }],
  openPRs: [7, 8, 9].map(number => ({ number, title: `PR ${number}`, draft: false, url: `https://github.com/owner/repo/pull/${number}` })),
  needsHuman: [], ignored: [], prs: [7, 8].map(number => ({ number, title: "Fix", url: "", outcome: "open", imported: false, rowIds: [number === 7 ? "b" : "c"], categories: ["sqli"] })),
}
const impact = (view: any) => nodes(view, node => node.type === ImpactView)[0]
test("Overview filters counts and PR row IDs locally using the PR column", () => {
  assert.equal(filterOverview(data, [], []), data)
  const filtered = filterOverview(data, ["sqli"], ["P1"])
  assert.deepEqual(filtered.types[0].counts, { open: 0, "in progress": 1, fixed: 1, ignored: 0 })
  assert.deepEqual(filtered.prs?.map(pr => pr.number), [7, 8])
  assert.deepEqual(filterOverview(data, [], ["P0"]).prs, [])
  assert.equal(data.types[0].total, 4)
})
test("a rejected PR whose row link was reset stays under category and priority filters", () => {
  const reset = { ...rows[0], id: "r", severity: "P1" as const, pr: "" }
  const closed = { number: 9, title: "Closed", url: "", outcome: "rejected" as const, imported: false, rowIds: ["r"], categories: ["sqli"] }
  const empty = { number: 10, title: "No rows", url: "", outcome: "open" as const, imported: false, rowIds: [], categories: ["sqli"] }
  const base = { ...data, types: [{ category: "sqli", url: "", rows: [reset], total: 1, counts: {} }], openPRs: [], prs: [closed, empty] }
  assert.deepEqual(filterOverview(base, ["sqli"], []).prs?.map(pr => pr.number), [9, 10])
  assert.deepEqual(filterOverview(base, [], ["P1"]).prs?.map(pr => pr.number), [9])
  assert.deepEqual(filterOverview(base, ["sqli"], ["P1"]).prs?.[0].rowIds, ["r"])
  assert.deepEqual(filterOverview(base, ["cors"], []).prs, [])
  assert.deepEqual(filterOverview(base, [], ["P0"]).prs, [])
})
test("Overview fetches once and filters the shared impact view locally", async () => {
  const b = browser("/overview?repo=owner/repo"), h = harness(), previous = fetch
  let reads = 0
  globalThis.fetch = (async () => { reads++; return Response.json(data) }) as unknown as typeof fetch
  try {
    h.render(OverviewPage, {}); await h.flush()
    let view = h.render(OverviewPage, {})
    assert.equal(impact(view).props.rows.length, 4)
    nodes(view, node => is(node, "button") && text(node) === "P1")[0].props.onClick()
    view = h.render(OverviewPage, {})
    assert.equal(impact(view).props.rows.length, 2)
    assert.equal(reads, 1)
  } finally { h.cleanup(); globalThis.fetch = previous; b.cleanup() }
})
for (const failure of [false, true]) test(`Overview ignores an old repo's Reopen ${failure ? "failure" : "success"}`, async () => {
  const b = browser("/overview?repo=owner/repo"), h = harness(), previous = fetch
  let finish: (response: Response) => void = () => {}
  const reads: string[] = []
  globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
    if (init.method === "POST") return new Promise<Response>(resolve => { finish = resolve })
    reads.push(String(input)); return Response.json({ ...data, repo: String(input).includes("other") ? "other/repo" : "owner/repo" })
  }) as unknown as typeof fetch
  try {
    h.render(OverviewPage, {}); await h.flush()
    let view = h.render(OverviewPage, {})
    impact(view).props.reopen("d")
    nodes(view, node => node.type === TrackerSelect)[0].props.onChange("other/repo")
    h.render(OverviewPage, {}); await h.flush()
    finish(failure ? Response.json({ error: "Old error" }, { status: 503 }) : Response.json({ ok: true }))
    await h.flush(); view = h.render(OverviewPage, {})
    assert.equal(reads.length, 2)
    assert.doesNotMatch(text(view), /Old error/)
    assert.match(String(impact(view).key), /other\/repo$/)
  } finally { h.cleanup(); globalThis.fetch = previous; b.cleanup() }
})
test("Overview retains data after refresh errors and clears the panel on repo change", async () => {
  const b = browser("/overview?repo=owner/repo"), h = harness(), previous = fetch
  let fail = false, hold = false
  globalThis.fetch = (async () => hold ? new Promise<Response>(() => {}) : fail ? new Response("gateway", { status: 502 }) : Response.json(data)) as unknown as typeof fetch
  try {
    h.render(OverviewPage, {}); await h.flush()
    fail = true
    nodes(h.render(OverviewPage, {}), node => is(node, "button") && text(node) === "Refresh")[0].props.onClick()
    await h.flush()
    let view = h.render(OverviewPage, {})
    assert.match(text(view), /HTTP 502/)
    assert.equal(impact(view).props.rows.length, 4)
    hold = true
    nodes(view, node => node.type === TrackerSelect)[0].props.onChange("other/repo")
    h.render(OverviewPage, {}); await h.flush(); view = h.render(OverviewPage, {})
    assert.equal(nodes(view, node => node.type === ImpactView).length, 0)
  } finally { h.cleanup(); globalThis.fetch = previous; b.cleanup() }
})
