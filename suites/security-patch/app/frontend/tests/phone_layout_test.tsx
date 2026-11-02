import { test } from "bun:test"
import assert from "node:assert/strict"
import React from "react"
import { FindingsPanel } from "../src/pages/RunDetailPage"
import { DiagnosticReader } from "../src/components/DiagnosticReader"
import { PickPage } from "../src/pages/PickPage"
import { TrackerSelect } from "../src/components/TrackerSelect"
import { browser, harness, is, markup, nodes, text } from "./render"

test("findings with long paths stay inside a scroll wrapper", () => {
  const html = markup(<FindingsPanel runId="fixture" canPost initialCheck={{ repo: "owner/repo", matches: {} }} onPosted={() => {}}
    findings={[{ id: "one", category: "signature-compare", severity: "P1", file: "vendor/" + "a".repeat(150) + ".php", line: 42, reason: "Check ownership" }]} />)
  assert.match(html, /<div data-slot="table-container" class="[^"]*overflow-x-auto[^"]*"><table/)
  assert.match(html, /<\/table><\/div>/)
})

for (const kind of ["run-info", "events"] as const) {
  test(`${kind} diagnostic tables each have a scroll wrapper`, async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => kind === "run-info"
      ? Response.json({ image: "scanner", env: { OLA_AGENT_MODEL: "sonnet" } })
      : new Response(JSON.stringify({ kind: "round_started", ts: 1, round: 1 }))) as unknown as typeof fetch
    const h = harness()
    const props = { runId: "fixture", kind, onClose() {} }
    try {
      h.render(DiagnosticReader, props)
      await h.flush()
      const html = markup(h.render(DiagnosticReader, props).props.children)
      assert.equal(html.match(/<div data-slot="table-container" class="[^"]*overflow-x-auto[^"]*"><table/g)?.length, kind === "run-info" ? 2 : 1)
    } finally { h.cleanup(); globalThis.fetch = originalFetch }
  })
}

test("phone layout contains long repo controls and keeps the Pick footer in document flow", async () => {
  const b = browser()
  const originalFetch = globalThis.fetch
  const file = "vendor/" + "a".repeat(150) + "/b.php"
  globalThis.fetch = (async (input: any) => {
    const url = String(input)
    if (url === "/api/providers") return Response.json({ claude: { available: true } })
    if (url === "/api/trackers") return Response.json({ repos: ["owner/" + "r".repeat(120)], removable: [] })
    return Response.json({ repoUrl: "https://github.com/owner/repo", suggestedIds: ["one"],
      rows: [{ id: "one", category: "sqli", subsystem: "app", severity: "P1", file, lines: [1], status: "open", reason: "Check" }],
      hidden: [{ id: "hidden", category: "sqli", file, lines: [1], severity: "P1", blockedBy: [7] }] })
  }) as typeof fetch
  const h = harness()
  const props = { sessionId: "fixture", activeRuns: [], onStarted() {} }
  const classes = (node: React.ReactElement<any> | undefined) => String(node?.props.className ?? "").split(/\s+/)
  try {
    h.render(PickPage, props)
    h.render(TrackerSelect, { value: null, onChange() {} })
    await h.flush()
    const view = h.render(PickPage, props)
    const footer = nodes(view, node => node.type === "footer")[0]
    assert(classes(footer).includes("sticky"))
    assert(classes(footer).includes("max-sm:static"))
    const info = footer.props.children[0]
    assert(classes(info).includes("[overflow-wrap:anywhere]"))
    assert(classes(info).includes("min-w-0"))
    const steps = nodes(view, node => node.type === "div" && nodes(node.props.children, child => is(child, "button") && /Show steps/.test(text(child))).length > 0).at(-1)
    assert(classes(steps).includes("flex-wrap"))
    const table = nodes(view, node => is(node, "table"))[0]
    assert(classes(table).includes("table-fixed"))
    assert(classes(table).includes("[&_td]:[overflow-wrap:anywhere]"))
    const group = nodes(view, node => typeof node.type === "function" && node.type.name === "HiddenPRRows")[0]
    const item = nodes(h.render(group.type as React.FunctionComponent<any>, group.props), node => node.type === "li")[0]
    assert(classes(item).includes("min-w-0"))
    assert(classes(item).includes("[overflow-wrap:anywhere]"))
    const repo = h.render(TrackerSelect, { value: null, onChange() {} })!
    assert(classes(repo).includes("min-w-0"))
    assert(classes(repo).includes("w-full"))
    assert(classes(nodes(repo, node => node.type === "div")[0]).includes("min-w-0"))
  } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
})
