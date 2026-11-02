import { test } from "bun:test"
import assert from "node:assert/strict"
import { ImpactView } from "../src/components/ImpactView"
import { browser, harness, nodes, text, markup, is } from "./render"
import type { TrackerRow } from "../src/components/TrackerModal"
import { SheetContent, SheetHeader } from "../src/components/ui/sheet"
import { Tabs, TabsTrigger } from "../src/components/ui/tabs"

const rows: TrackerRow[] = [
  { id: "a", category: "sqli", file: "app/a.php", lines: [2, 9], severity: "P0", status: "needs human", reason: "Ownership\nFull reason", date: "29-10-2026", pr: "" },
  { id: "b", category: "cors", file: "app/b.php", lines: [7], severity: "P1", status: "in progress", reason: "Origin policy", date: "29-10-2026", pr: "[PR #7](https://github.com/a/b/pull/7)" },
  { id: "pr8:old.php", category: "sqli", file: "old.php", lines: [4], severity: "P0", status: "fixed", reason: "Seeded from PR", date: "01-10-2026", pr: "[PR #8](https://github.com/a/b/pull/8)" },
]
const props: Parameters<typeof ImpactView>[0] = { rows, categories: ["sqli", "cors"], prs: [
  { number: 7, title: "Fix cors", url: "https://github.com/a/b/pull/7", outcome: "open", imported: false, rowIds: ["b"], categories: ["cors"] },
  { number: 8, title: "Earlier fix", url: "https://github.com/a/b/pull/8", outcome: "excluded", imported: true, rowIds: ["pr8:old.php"], categories: ["sqli"] },
], pickHref: "/pick?repo=a%2Fb", reopen() {}, reopening: null, readPR() {}, closePR() {},
  coverage: { applicable: ["sqli", "cors"], scanned: ["sqli"], unscanned: ["cors"], coveredFiles: 2, consideredFiles: 4, lastScan: 1000000 } }
const button = (view: any, value: string) => nodes(view, node => is(node, "button") && text(node).includes(value))[0]
const testid = (view: any, id: string) => nodes(view, node => node.props["data-testid"] === id)
const selectTab = (view: any, name: string) => nodes(view, node => node.type === Tabs)[0].props.onValueChange(nodes(view, node => node.type === TabsTrigger && text(node) === name)[0].props.value)
const panelNode = (view: any) => nodes(view, node => typeof node.type === "function" && node.type.name === "ImpactPanel")[0]

test("Summary is default, tool tiles exclude imports, and clicks preset the shared panel", () => {
  const b = browser(), h = harness()
  try {
    let view = h.render(ImpactView, props)
    const selected = nodes(view, node => node.type === Tabs)[0].props.value
    assert.equal(text(nodes(view, node => node.type === TabsTrigger && node.props.value === selected)[0]), "Summary")
    assert.match(text(button(view, "Found by the tool")), /2/)
    assert.match(text(view), /1 rows imported/)
    button(view, "P0 not fixed yet").props.onClick()
    view = h.render(ImpactView, props)
    const panel = panelNode(view)
    assert.deepEqual(panel.props.preset.severity, ["P0"])
    assert.deepEqual(panel.props.preset.statuses, ["open", "needs human", "in progress"])
    assert.equal(panel.props.preset.population, "tool")
    const html = markup(view)
    assert.match(html, /aria-label="In a PR P1 1"/)
  } finally { h.cleanup(); b.cleanup() }
})
test("tabs search independently and whole rows open type and PR filters", () => {
  const b = browser(), h = harness()
  try {
    let view = h.render(ImpactView, props)
    selectTab(view, "Bug types")
    view = h.render(ImpactView, props)
    nodes(view, node => is(node, "input"))[0].props.onChange({ target: { value: "sqli" } })
    view = h.render(ImpactView, props)
    const typeRows = testid(view, "impact-row")
    assert.equal(typeRows.length, 1)
    testid(typeRows[0], "impact-row-link")[0].props.onClick()
    view = h.render(ImpactView, props)
    assert.equal(panelNode(view).props.preset.category, "sqli")
    selectTab(view, "PRs")
    view = h.render(ImpactView, props)
    assert.equal(nodes(view, node => is(node, "input"))[0].props.value, "")
    button(view, "#7 Fix cors").props.onClick()
    assert.equal(panelNode(h.render(ImpactView, props)).props.preset.pr, 7)
  } finally { h.cleanup(); b.cleanup() }
})
test("panel supports search, row expansion, actions, Esc and restores focus", async () => {
  const b = browser(), h = harness(), oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
  let closed = 0, focused = 0, reopened = ""
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    activeElement: { isConnected: true, focus() { focused++ } }, querySelector() { return null },
  } })
  try {
    button(h.render(ImpactView, props), "Found by the tool").props.onClick()
    const element = panelNode(h.render(ImpactView, props)), component = element.type as any
    const panelProps = { ...element.props, onClose() { closed++ }, reopen(id: string) { reopened = id } }
    let panel: any = h.render(component, panelProps)
    await h.flush()
    assert.equal(testid(panel, "impact-finding").length, 2)
    nodes(panel, node => is(node, "input"))[0].props.onChange({ target: { value: "Ownership" } })
    panel = h.render(component, panelProps)
    assert.equal(testid(panel, "impact-finding").length, 1)
    testid(panel, "impact-finding-toggle")[0].props.onClick()
    panel = h.render(component, panelProps)
    assert.match(text(panel), /app\/a.php:2,9/)
    button(panel, "Reopen").props.onClick()
    assert.equal(reopened, "a")
    panel.props.onOpenChange(false)
    assert.equal(closed, 1)
    let prevented = 0
    nodes(panel, node => node.type === SheetContent)[0].props.onCloseAutoFocus({ preventDefault() { prevented++ } })
    assert.equal(prevented, 1)
    assert.equal(focused, 1)
    h.cleanup()
  } finally {
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument); else Reflect.deleteProperty(globalThis, "document")
    b.cleanup()
  }
})
test("a PR opened from the PRs tab offers Read PR and Close PR even with no rows", () => {
  const b = browser(), h = harness()
  const read: number[] = [], closed: number[] = []
  const lone = { number: 12, title: "Lone", url: "https://github.com/a/b/pull/12", outcome: "open" as const, imported: false, rowIds: [], categories: ["sqli"] }
  const pageProps = { ...props, prs: [...props.prs, lone], readPR(pr: { number: number }) { read.push(pr.number) }, closePR(pr: { number: number }) { closed.push(pr.number) } }
  try {
    selectTab(h.render(ImpactView, pageProps), "PRs")
    button(h.render(ImpactView, pageProps), "#12 Lone").props.onClick()
    const element = panelNode(h.render(ImpactView, pageProps))
    const panel: any = h.render(element.type as any, element.props)
    assert.equal(testid(panel, "impact-finding").length, 0)
    const header = nodes(panel, node => node.type === SheetHeader)[0]
    nodes(header, node => is(node, "button") && text(node) === "Read PR")[0].props.onClick()
    nodes(header, node => is(node, "button") && text(node) === "Close")[0].props.onClick()
    assert.deepEqual([read, closed], [[12], [12]])
  } finally { h.cleanup(); b.cleanup() }
})
test("Chinese Summary and replacement reason are localized", () => {
  const b = browser("/overview", { ola_lang: "zh" }), h = harness()
  try { assert.match(text(h.render(ImpactView, props)), /工具发现的漏洞/); assert.doesNotMatch(text(h.render(ImpactView, props)), /impact\./) }
  finally { h.cleanup(); b.cleanup() }
})
test("coverage strip is one line, drops unknown file counts, and every outcome chip has a swatch", () => {
  const b = browser(), h = harness()
  try {
    const strip = (coverage: typeof props.coverage) => testid(h.render(ImpactView, { ...props, coverage }), "impact-coverage")[0]
    assert.match(text(strip(props.coverage)), /^1 of 2 bug types requested · 2 of 4 files read · last scan .+ · Never scanned: /)
    const unknownFiles = text(strip({ ...props.coverage!, coveredFiles: null, consideredFiles: null }))
    assert.doesNotMatch(unknownFiles, /files|\?/)
    const chips = testid(h.render(ImpactView, props), "outcome-chip")
    assert.equal(chips.length, 5)
    for (const chip of chips) assert.equal(testid(chip, "outcome-swatch").length, 1)
  } finally { h.cleanup(); b.cleanup() }
})
test("a row shared by an excluded and a rejected PR is labelled with the rejected PR in the Rejected panel", () => {
  const b = browser(), h = harness()
  const shared: TrackerRow = { id: "s", category: "sqli", file: "app/s.php", lines: [3], severity: "P0", status: "in progress", reason: "Shared", date: "29-10-2026", pr: "[PR #1836](https://github.com/a/b/pull/1836)" }
  const pr = (number: number, outcome: "excluded" | "rejected") => ({ number, title: `PR ${number}`, url: `https://github.com/a/b/pull/${number}`, outcome, imported: false, rowIds: ["s"], categories: ["sqli"] })
  const pageProps = { ...props, rows: [shared], prs: [pr(1836, "excluded"), pr(1840, "rejected")] }
  try {
    button(h.render(ImpactView, pageProps), "Rejected").props.onClick()
    const element = panelNode(h.render(ImpactView, pageProps))
    const panel: any = h.render(element.type as any, element.props)
    const links = testid(panel, "impact-finding-pr")
    assert.deepEqual(links.map(link => text(link)), ["PR #1840 ↗"])
  } finally { h.cleanup(); b.cleanup() }
})
