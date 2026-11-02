import { test } from "bun:test"
import assert from "node:assert/strict"
import React from "react"
import { ActivityArea, ActivityTimeline } from "../src/components/ActivityArea"
import { ArtifactButtons } from "../src/components/ArtifactButtons"
import { CompletionCard } from "../src/components/CompletionCard"
import { ReportView, SUMMARY_MARKER } from "../src/components/ReportView"
import { harness, markup, nodes, text, is } from "./render"

test("activity shows the live log, then separates summary and process downloads, with a legacy fallback", () => {
  const h = harness()
  const props = { runId: "run/id", assistantText: `Inspecting code\n${SUMMARY_MARKER}\nFinal verdict`, timeline: [], toolLog: [], findings: [], streaming: true }
  try {
    const live = h.render(ActivityArea, props)
    const report = nodes(live, node => node.type === ReportView)[0]
    assert.equal(report.props.text, "Inspecting code")
    assert.equal(report.props.streaming, true)
    assert.match(text(live), /final summary.*when the run ends/)
    assert.doesNotMatch(markup(live), /Final verdict|OLA:FINAL-SUMMARY/)
    assert.equal(nodes(live, node => node.type === ActivityTimeline)[0].props.ended, false)
    const finished = h.render(ActivityArea, { ...props, streaming: false })
    const reports = nodes(finished, node => node.type === ReportView)
    assert.deepEqual(reports.map(node => [node.props.title, node.props.text, node.props.downloadKind]), [
      ["Summary", "Final verdict", "response"], ["Activity log", "Inspecting code", "activity"],
    ])
    assert.equal(reports[1].props.defaultOpen, false)
    assert.equal(nodes(finished, node => node.type === ActivityTimeline)[0].props.ended, true)
    const legacy = h.render(ActivityArea, { ...props, streaming: false, assistantText: "Legacy report" })
    const single = nodes(legacy, node => node.type === ReportView)
    assert.equal(single.length, 1)
    assert.equal(single[0].props.text, "Legacy report")
    assert.equal(single[0].props.downloadKind, "report")
    assert.doesNotMatch(text(legacy), /final summary.*when the run ends/)
  } finally { h.cleanup() }
})

test("activity distinguishes loading, unknown, full, scoped and non-audit scope", () => {
  const base = { runId: "r", assistantText: "", timeline: [], toolLog: [], findings: [], streaming: true }
  const render = (scope: React.ComponentProps<typeof ActivityArea>["scope"]) => markup(<ActivityArea {...base} scope={scope} />)
  assert.doesNotMatch(render(null), /data-testid="scope-banner"/)
  assert.doesNotMatch(render({ mode: "fix", skill: "ola-security-audit", categories: [] }), /data-testid="scope-banner"/)
  assert.doesNotMatch(render({ mode: "fix", skill: "ola-security-audit", categories: ["sqli"] }), /data-testid="scope-banner"/)
  assert.match(render("error"), /Scope unknown.*details did not load/)
  assert.match(render({ skill: "ola-security-audit", categories: [] }), /Scope: Full \(17 types\)/)
  assert.doesNotMatch(render({ skill: "ola-security-audit", categories: [] }), /⚠️/)
  assert.match(render({ skill: "ola-security-audit", categories: ["sqli", "custom-check"] }), /data-testid="scope-banner".*⚠️.*Scoped: SQLi.*custom-check/)
  assert.match(render({ skill: "ola-security-audit", categories: ["sqli"] }), /aria-hidden="true">⚠️/)
  assert.match(render({ skill: "security-review", categories: [] }), /Scope: Security review/)
  assert.match(render({ skill: "other", categories: ["sqli"] }), /Scope: N\/A/)
})

test("the timeline shows tool results, marks unfinished tools stopped, and respects the reader's scroll position", async () => {
  const h = harness()
  const props = {
    timeline: [{ thinking: "Inspect inputs" }, { tool: 0 }, { tool: 1 }, { tool: 2 }, { tool: 3 }, { tool: 4 }, { tool: 99 }],
    toolLog: [
      { tool: "Read", input: { file_path: "query.ts" }, ok: true, summary: "Read source" },
      { tool: "Edit", input: { path: "query.ts" }, ok: false, summary: "Permission denied" },
      { tool: "Grep", input: { pattern: "SELECT" } },
      { tool: "Custom", input: { value: "Inspect metadata" } },
      { tool: "Custom", input: { value: 12 } },
    ],
    ended: false,
  }
  const list = { scrollHeight: 1000, scrollTop: 0, clientHeight: 200 }
  try {
    assert.equal(h.render(ActivityTimeline, { timeline: [], toolLog: [], ended: false }), null)
    let view = h.render(ActivityTimeline, props)!
    const ol = nodes(view, node => node.type === "ol")[0]
    Reflect.get(ol, "ref").current = list
    await h.flush()
    assert.equal(list.scrollTop, 1000)
    assert.equal(view.props.open, true)
    assert.match(text(view), /Inspect inputs.*Read.*query.ts.*✓ Read source.*Edit.*query.ts.*✗ Permission denied.*Grep.*SELECT.*….*Inspect metadata/s)
    assert.equal(nodes(view, node => node.type === "li").length, 6)
    const html = markup(view)
    assert.match(html, /data-kind="read" data-status="ok"/)
    assert.match(html, /data-kind="change" data-status="failed"/)
    assert.match(html, /data-kind="other" data-status="running"/)
    list.scrollTop = 200
    ol.props.onScroll({ currentTarget: list })
    view = h.render(ActivityTimeline, { ...props, timeline: [...props.timeline, { thinking: "Next step" }] })!
    await h.flush()
    assert.equal(list.scrollTop, 200)
    list.scrollTop = 780
    ol.props.onScroll({ currentTarget: list })
    view = h.render(ActivityTimeline, { ...props, timeline: [...props.timeline, { thinking: "Next step" }, { thinking: "Last step" }] })!
    await h.flush()
    assert.equal(list.scrollTop, 1000)
    list.scrollTop = 400
    view = h.render(ActivityTimeline, { ...props, ended: true })!
    await h.flush()
    assert.equal(list.scrollTop, 400)
    assert.equal(view.props.open, false)
    assert.match(markup(view), /data-status="stopped"/)
    assert.equal(nodes(view, node => node.type === "span" && text(node) === "■").length, 3)
    assert.doesNotMatch(text(view), /…/)
  } finally { h.cleanup() }
})

test("reports collapse with a short preview, expand to markdown and keep the chosen artifact download", () => {
  const h = harness()
  const heading = "A".repeat(90)
  const props = { runId: "run/id ?", text: `\n\n# ${heading}\n\n**Finding**`, title: "Summary", downloadKind: "response" as const, defaultOpen: false }
  try {
    let view = h.render(ReportView, props)
    const toggle = () => nodes(view, node => is(node, "button"))[0]
    assert.equal(toggle().props["aria-expanded"], false)
    assert.equal(text(nodes(view, node => node.props["data-testid"] === "report-preview")[0]), "A".repeat(80) + "…")
    const marked = h.render(ReportView, { ...props, text: `${SUMMARY_MARKER}\n## Verdict ${SUMMARY_MARKER}` })
    assert.equal(text(nodes(marked, node => node.props["data-testid"] === "report-preview")[0]), "Verdict")
    assert.equal(nodes(view, node => node.type === "article").length, 0)
    const link = nodes(view, node => node.type === "a")[0]
    assert.equal(link.props.href, "/api/runs/run%2Fid%20%3F/artifacts/response")
    assert.equal(link.props.title, "summary.md")
    toggle().props.onClick()
    view = h.render(ReportView, props)
    assert.equal(toggle().props["aria-expanded"], true)
    assert.match(markup(view), /<strong>Finding<\/strong>/)
    toggle().props.onClick()
    view = h.render(ReportView, props)
    assert.equal(nodes(view, node => node.type === "article").length, 0)
    assert.equal(nodes(view, node => node.type === "a")[0].props.href, link.props.href)
  } finally { h.cleanup() }
})

test("streaming reports follow new text only while the reader stays near the bottom", async () => {
  const h = harness()
  const props = { runId: "r", text: "First output", streaming: true }
  const stream = { scrollHeight: 1000, scrollTop: 0, clientHeight: 200 }
  try {
    let view = h.render(ReportView, props)
    const pre = nodes(view, node => node.type === "pre")[0]
    Reflect.get(pre, "ref").current = stream
    await h.flush()
    assert.equal(stream.scrollTop, 1000)
    stream.scrollTop = 100
    pre.props.onScroll({ currentTarget: stream })
    view = h.render(ReportView, { ...props, text: "Second output" })
    await h.flush()
    assert.equal(stream.scrollTop, 100)
    assert.match(text(view), /Second output/)
    stream.scrollTop = 790
    pre.props.onScroll({ currentTarget: stream })
    h.render(ReportView, { ...props, text: "Third output" })
    await h.flush()
    assert.equal(stream.scrollTop, 1000)
    stream.scrollTop = 500
    view = h.render(ReportView, { ...props, text: "**Final**", streaming: false })
    await h.flush()
    assert.equal(stream.scrollTop, 500)
    assert.equal(nodes(view, node => node.type === "pre").length, 0)
    assert.match(markup(view), /<strong>Final<\/strong>/)
  } finally { h.cleanup() }
})

for (const error of [undefined, "Scanner exited unexpectedly"]) {
  test(`failed completion shows ${error ? "the run error" : "a fallback error"} without success actions`, () => {
    const h = harness()
    try {
      const view = h.render(CompletionCard, { runId: "r", mode: "fix", status: "failed", error, prUrl: "https://github.com/owner/repo/pull/1" })
      assert.equal(view.props.variant, "destructive")
      assert.equal(view.props.role, "alert")
      assert.match(text(view), /Run failed/)
      assert.match(text(view), error ? /Scanner exited unexpectedly/ : /Unknown error/)
      assert.equal(nodes(view, node => node.type === ArtifactButtons || node.type === "a").length, 0)
    } finally { h.cleanup() }
  })
}

test("completed runs keep artifact controls and distinguish a PR link from a push error", () => {
  const h = harness()
  const props = { runId: "r", mode: "fix" as const, status: "completed" as const, pushError: "GitHub unavailable" }
  try {
    let view = h.render(CompletionCard, props)
    assert.match(text(view), /GitHub unavailable/)
    assert.equal(nodes(view, node => node.type === "a").length, 0)
    const artifacts = nodes(view, node => node.type === ArtifactButtons)[0]
    assert.equal(artifacts.props.runId, "r")
    assert.equal(artifacts.props.mode, "fix")
    view = h.render(CompletionCard, { ...props, prUrl: "https://github.com/owner/repo/pull/7" })
    const link = nodes(view, node => node.type === "a")[0]
    assert.equal(link.props.href, "https://github.com/owner/repo/pull/7")
    assert.equal(link.props.target, "_blank")
    assert.equal(link.props.rel, "noopener noreferrer")
    assert.doesNotMatch(text(view), /GitHub unavailable/)
  } finally { h.cleanup() }
})
