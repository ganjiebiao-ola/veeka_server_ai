import { ImpactView } from "../src/components/lazy"
import { RepoSettings } from "../src/components/RepoSettings"
import { test } from "bun:test"
import assert from "node:assert/strict"
import type React from "react"
import { App } from "../src/App"
import { LandingPage, type LandingPageProps } from "../src/pages/LandingPage"
import { PickPage } from "../src/pages/PickPage"
import { OverviewPage } from "../src/pages/OverviewPage"
import { RunPage } from "../src/pages/RunPage"
import { ConfirmDialog } from "../src/components/ConfirmDialog"
import { RepoProfile } from "../src/components/RepoProfile"
import { TopBar } from "../src/components/TopBar"
import { TrackerSelect } from "../src/components/TrackerSelect"
import { Checkbox } from "../src/components/ui/checkbox"
import { browser, harness, nodes, text, is } from "./render"

const repoUrl = "https://github.com/owner/repo"
const row = { id: "one", category: "sqli", subsystem: "app", severity: "P1", file: "a.php", lines: [1], status: "open", reason: "Check" }
const pick = { repoUrl, rows: [row], suggestedIds: [row.id], hidden: [] }
const overview = { repo: "owner/repo", availableTypes: [], types: [], needsHuman: [],
  openPRs: [{ number: 7, title: "Fix", draft: false, url: `${repoUrl}/pull/7` }], ignored: [row] }
const pickProps = { sessionId: "fixture", activeRuns: [], onStarted() {} }
const button = (view: React.ReactNode, name: string | RegExp) => nodes(view, node => is(node, "button")
  && (typeof name === "string" ? text(node) === name : name.test(text(node))))[0]

function fixture(path = "/pick?repo=owner/repo", overviewData: object = overview) {
  const b = browser(path, { "ola-agent.sessionId": "fixture" })
  const h = harness()
  const originalFetch = globalThis.fetch
  const writes: { url: string, init: RequestInit, finish: (response: Response) => void, fail: (error: Error) => void }[] = []
  globalThis.fetch = ((input: any, init: RequestInit = {}) => {
    const url = String(input)
    if (init.method && init.method !== "GET") return new Promise<Response>((finish, fail) => writes.push({ url, init, finish, fail }))
    if (url === "/api/providers") return Promise.resolve(Response.json({ claude: { available: true }, codex: { available: true } }))
    if (url === "/api/repos") return Promise.resolve(Response.json({ repos: [{ url: repoUrl, branch: "main" }] }))
    if (url.startsWith("/api/repos/language?")) return Promise.resolve(Response.json({ language: "PHP", share: 100 }))
    if (url === "/api/trackers") return Promise.resolve(Response.json({ repos: ["owner/repo"], removable: ["owner/repo"] }))
    if (url === "/api/relay/models") return Promise.resolve(Response.json({ configured: false, models: [] }))
    if (url.startsWith("/api/pick?")) return Promise.resolve(Response.json(pick))
    if (url.startsWith("/api/overview?")) return Promise.resolve(Response.json(overviewData))
    if (url === "/api/health") return Promise.resolve(Response.json({ dev: false }))
    if (url === "/api/runs/active") return Promise.resolve(Response.json({ runs: [] }))
    if (url === "/api/sessions/fixture/refresh") return Promise.resolve(new Response(null, { status: 204 }))
    if (url === "/api/runs/fixture") return Promise.resolve(Response.json({ runId: "fixture", mode: "scan", status: "scanning", repoUrl }))
    throw new Error(`Unexpected request: ${url}`)
  }) as typeof fetch
  return { h, writes, async cleanup() {
    for (const write of writes) write.finish(Response.json({ error: "Cancelled" }, { status: 500 }))
    await h.flush()
    h.cleanup()
    globalThis.fetch = originalFetch
    b.cleanup()
  } }
}

for (const active of [false, true]) {
  test(`Scan ${active ? "concurrent start" : "start"} sends one App start request before the response resolves`, async () => {
    const f = fixture("/")
    const { h, writes } = f
    try {
      h.render(App, {})
      await h.flush()
      const landing = nodes(h.render(App, {}), node => node.type === LandingPage)[0]
      const props: LandingPageProps = { ...landing.props, onStarted() {}, activeRuns: active
        ? [{ runId: "active", status: "scanning", repoUrl, mode: "scan" }] : [] }
      h.render(LandingPage, props)
      await h.flush()
      let view = h.render(LandingPage, props)
      nodes(view, node => is(node, "select") && node.props.id === "recent-repo")[0].props.onChange({ target: { value: repoUrl } })
      view = h.render(LandingPage, props)
      await h.flush()
      await new Promise(resolve => setTimeout(resolve, 420))
      view = h.render(LandingPage, props)
      let submit = button(view, "Start scan").props.onClick
      submit()
      submit()
      assert.equal(writes.length, 1)
      assert.equal(JSON.parse(String(writes[0].init.body)).includeP2, false)
      assert.equal(writes[0].url, "/api/runs")
      assert.equal(writes[0].init.method, "POST")
      assert.equal(button(h.render(LandingPage, props), "Working…").props.disabled, true)
      writes[0].finish(Response.json({ error: "Try again" }, { status: 503 }))
      await h.flush()
      assert.equal(button(h.render(LandingPage, props), "Start scan").props.disabled, false)
      view = h.render(LandingPage, props)
      const p2 = nodes(view, node => is(node, "label") && text(node).includes("Include P2"))[0]
      const checkbox = nodes(p2, node => node.type === Checkbox)[0]
      assert.equal(checkbox.props.checked, false)
      checkbox.props.onCheckedChange(true)
      submit = button(h.render(LandingPage, props), "Start scan").props.onClick
      submit()
      assert.equal(writes.length, 2)
      assert.equal(JSON.parse(String(writes[1].init.body)).includeP2, true)
      writes[1].finish(Response.json({ runId: "new", status: "queued" }))
      await h.flush()
      assert.equal(button(h.render(LandingPage, props), "Start scan").props.disabled, false)
      submit()
      assert.equal(writes.length, 3)
    } finally { await f.cleanup() }
  })
}

test("Fix selected ignores two clicks until its paid request settles", async () => {
  const f = fixture()
  const { h, writes } = f
  try {
    h.render(PickPage, pickProps)
    await h.flush()
    nodes(h.render(PickPage, pickProps), node => node.type === Checkbox && node.props["aria-label"] === "Pick one")[0].props.onCheckedChange(true)
    const submit = button(h.render(PickPage, pickProps), "Fix selected (1)").props.onClick
    submit()
    submit()
    assert.equal(writes.length, 1)
    assert.equal(writes[0].url, "/api/pick")
    assert.equal(button(h.render(PickPage, pickProps), "Working…").props.disabled, true)
    writes[0].finish(Response.json({ error: "Try again" }, { status: 503 }))
    await h.flush()
    submit()
    assert.equal(writes.length, 2)
    writes[1].finish(Response.json({ runId: "new" }))
    await h.flush()
    assert.equal(button(h.render(PickPage, pickProps), "Fix selected (1)").props.disabled, false)
    submit()
    assert.equal(writes.length, 3)
  } finally { await f.cleanup() }
})

for (const action of ["ignore", "needs-human"] as const) {
  const selectLabel = action === "ignore" ? "Ignore selected" : "Needs human"
  const confirmLabel = action === "ignore" ? "Ignore" : "Needs human"
  test(`${action} sends one GitHub write for two clicks and permits retry after failure`, async () => {
    const f = fixture()
    const { h, writes } = f
    try {
      h.render(PickPage, pickProps)
      await h.flush()
      nodes(h.render(PickPage, pickProps), node => node.type === Checkbox && node.props["aria-label"] === "Pick one")[0].props.onCheckedChange(true)
      button(h.render(PickPage, pickProps), `${selectLabel} (1)`).props.onClick()
      const dialog = nodes(h.render(PickPage, pickProps), node => typeof node.type === "function" && node.type.name === "RowChangeDialog")[0]
      const component = dialog.type as React.FunctionComponent<any>
      nodes(h.render(component, dialog.props), node => is(node, "textarea"))[0].props.onChange({ target: { value: "Accepted risk" } })
      const submit = button(h.render(component, dialog.props), confirmLabel).props.onClick
      submit()
      submit()
      assert.equal(writes.length, 1)
      assert.equal(writes[0].url, `/api/pick/${action}`)
      assert.equal(button(h.render(component, dialog.props), "Working…").props.disabled, true)
      writes[0].fail(new Error("Offline"))
      await h.flush()
      assert.equal(button(h.render(component, dialog.props), confirmLabel).props.disabled, false)
      button(h.render(component, dialog.props), confirmLabel).props.onClick()
      assert.equal(writes.length, 2)
      writes[1].finish(Response.json({ ok: true }))
      await h.flush()
      assert.equal(nodes(h.render(PickPage, pickProps), node => node.type === component).length, 0)
    } finally { await f.cleanup() }
  })
}

for (const needsHuman of [false, true]) {
  test(`Reopen ${needsHuman ? "needs-human" : "ignored"} sends one GitHub write for two clicks and releases the guard on both outcomes`, async () => {
    const f = fixture("/overview?repo=owner/repo", needsHuman ? {
      ...overview, ignored: [], needsHuman: [{ ...row, url: "https://github.com/a/b/blob/main/sqli.json" }],
      types: [{ category: "sqli", url: "https://github.com/a/b/blob/main/sqli.json", total: 1, counts: {}, rows: [
        { ...row, status: "needs human", date: "22-10-2026", pr: "" },
      ] }],
    } : overview)
    const { h, writes } = f
    try {
      h.render(OverviewPage, {})
      await h.flush()
      const submit = () => nodes(h.render(OverviewPage, {}), node => node.type === ImpactView)[0].props.reopen("one")
      submit()
      submit()
      assert.equal(writes.length, 1)
      assert.equal(writes[0].url, "/api/pick/reopen")
      assert.deepEqual(JSON.parse(writes[0].init.body as string), { repo: "owner/repo", ids: ["one"] })
      assert.equal(nodes(h.render(OverviewPage, {}), node => node.type === ImpactView)[0].props.reopening, "one")
      writes[0].finish(Response.json({ error: "Try again" }, { status: 503 }))
      await h.flush()
      assert.equal(nodes(h.render(OverviewPage, {}), node => node.type === ImpactView)[0].props.reopening, null)
      assert.match(text(h.render(OverviewPage, {})), /Try again/)
      submit()
      assert.equal(writes.length, 2)
      writes[1].finish(Response.json({ ok: true }))
      await h.flush()
      assert.equal(nodes(h.render(OverviewPage, {}), node => node.type === ImpactView)[0].props.reopening, null)
      submit()
      assert.equal(writes.length, 3)
    } finally { await f.cleanup() }
  })
}

test("Reopen targets the row ID for misc rows sharing a location", async () => {
    const rows = [
      { ...row, id: "a".repeat(64), category: "misc", url: "https://github.com/a/b/blob/main/misc.json", reason: "Review protocol", kind: "protocol", status: "needs human" },
      { ...row, id: "b".repeat(64), category: "misc", url: "https://github.com/a/b/blob/main/misc.json", reason: "Review auth", kind: "auth", status: "needs human" },
    ]
    const f = fixture("/overview?repo=owner/repo", {
      ...overview, ignored: [], needsHuman: rows,
      types: [{ category: "misc", url: "https://github.com/a/b/blob/main/misc.json", total: rows.length, counts: { "needs human": rows.length }, rows: rows.map(row => ({ ...row, date: "22-10-2026", pr: "" })) }],
    })
    const { h, writes } = f
    try {
      h.render(OverviewPage, {})
      await h.flush()
      nodes(h.render(OverviewPage, {}), node => node.type === ImpactView)[0].props.reopen(rows[rows.length - 1].id)
      assert.equal(writes.length, 1)
      assert.equal(writes[0].url, "/api/pick/reopen")
      assert.deepEqual(JSON.parse(writes[0].init.body as string), { repo: "owner/repo", ids: [rows[rows.length - 1].id] })
    } finally { await f.cleanup() }
})

test("Close PR sends each GitHub step once despite repeated clicks between steps", async () => {
  const f = fixture("/overview?repo=owner/repo")
  const { h, writes } = f
  try {
    h.render(OverviewPage, {})
    await h.flush()
    nodes(h.render(OverviewPage, {}), node => node.type === ImpactView)[0].props.closePR(overview.openPRs[0])
    const dialog = nodes(h.render(OverviewPage, {}), node => typeof node.type === "function" && node.type.name === "ClosePRDialog")[0]
    const component = dialog.type as React.FunctionComponent<any>
    const submit = button(h.render(component, dialog.props), "Close PR").props.onClick
    submit()
    submit()
    assert.equal(writes.length, 1)
    assert.equal(button(h.render(component, dialog.props), "Working…").props.disabled, true)
    writes[0].finish(Response.json({ error: "Try again" }, { status: 503 }))
    await h.flush()
    const retry = button(h.render(component, dialog.props), "Retry")
    assert.equal(retry.props.disabled, false)
    retry.props.onClick()
    retry.props.onClick()
    for (const [index, step] of ["comment", "close", "branch", "rows"].entries()) {
      assert.equal(writes.length, index + 2)
      assert.equal(writes[index + 1].url, "/api/overview/prs/7/close")
      assert.equal(JSON.parse(String(writes[index + 1].init.body)).step, step)
      submit()
      assert.equal(writes.length, index + 2)
      writes[index + 1].finish(Response.json({ ok: true }))
      await h.flush()
    }
    assert.equal(button(h.render(component, dialog.props), "Done").props.disabled, undefined)
  } finally { await f.cleanup() }
})

test("Repo profile save sends one PUT for two clicks and releases the guard on both outcomes", async () => {
  const f = fixture()
  const { h, writes } = f
  const props = { url: repoUrl, profile: null, override: null, onSaved() {} }
  try {
    h.render(RepoProfile, props)
    await h.flush()
    nodes(h.render(RepoProfile, props), node => is(node, "input"))[0].props.onChange({ target: { value: "8.2" } })
    const submit = button(h.render(RepoProfile, props), "Save").props.onClick
    submit()
    submit()
    assert.equal(writes.length, 1)
    assert.equal(writes[0].url, "/api/repos/profile")
    assert.equal(writes[0].init.method, "PUT")
    assert.equal(button(h.render(RepoProfile, props), "Save").props.disabled, true)
    writes[0].fail(new Error("Offline"))
    await h.flush()
    assert.equal(button(h.render(RepoProfile, props), "Save").props.disabled, false)
    button(h.render(RepoProfile, props), "Save").props.onClick()
    assert.equal(writes.length, 2)
    writes[1].finish(new Response(null, { status: 204 }))
    await h.flush()
    assert.equal(button(h.render(RepoProfile, props), "Save").props.disabled, false)
    button(h.render(RepoProfile, props), "Save").props.onClick()
    assert.equal(writes.length, 3)
  } finally { await f.cleanup() }
})

for (const page of ["TrackerSelect", "LandingPage"]) {
  test(`${page} Remove sends one DELETE for two confirmation clicks and releases the guard on both outcomes`, async () => {
    const f = fixture()
    const { h, writes } = f
    const props: LandingPageProps = { sessionId: "fixture", activeRuns: [], onStarted() {}, startRun: async () => ({ runId: "new", status: "queued" }) }
    const trackerProps = { value: "owner/repo", onChange() {} }
    const renderPage = () => {
      if (page === "TrackerSelect") return h.render(TrackerSelect, trackerProps)
      const settings = h.render(RepoSettings, nodes(h.render(LandingPage, props), node => node.type === RepoSettings)[0].props as any)
      const row = nodes(settings, node => node.props.repo)[0]
      return <>{settings}{row && h.render(row.type as any, row.props as any) as any}</>
    }
    try {
      renderPage()
      await h.flush()
      if (page === "LandingPage") {
        h.render(LandingPage, props)
      }
      const confirm = () => {
        button(renderPage(), "Remove").props.onClick()
        const dialog = nodes(renderPage(), node => node.type === ConfirmDialog)[0]
        return button(h.render(ConfirmDialog, dialog.props), "Remove").props.onClick
      }
      const submit = confirm()
      submit()
      submit()
      assert.equal(writes.length, 1)
      assert.equal(writes[0].url, `/api/repos?url=${encodeURIComponent(repoUrl)}`)
      assert.equal(writes[0].init.method, "DELETE")
      assert.equal(button(renderPage(), "Remove").props.disabled, true)
      writes[0].finish(new Response(null, { status: 503 }))
      await h.flush()
      assert.equal(button(renderPage(), "Remove").props.disabled, false)
      confirm()()
      assert.equal(writes.length, 2)
      writes[1].finish(new Response(null, { status: 204 }))
      await h.flush()
      if (page === "TrackerSelect") {
        assert.equal(button(renderPage(), "Remove").props.disabled, false)
        confirm()()
        assert.equal(writes.length, 3)
      } else assert.equal(button(renderPage(), "Remove"), undefined)
    } finally { await f.cleanup() }
  })
}

test("Cancel run sends one POST for two clicks and releases the guard on both outcomes", async () => {
  const f = fixture()
  const { h, writes } = f
  const previous = new Map(["alert", "dispatchEvent"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.defineProperty(globalThis, "alert", { configurable: true, value() {} })
  Object.defineProperty(globalThis, "dispatchEvent", { configurable: true, value: () => true })
  const props = { runId: "fixture", mode: "scan" as const, onResumed() {} }
  const topBar = () => {
    const top = nodes(h.render(RunPage, props), node => node.type === TopBar)[0]
    return h.render(TopBar, top.props)
  }
  try {
    h.render(RunPage, props)
    await h.flush()
    const cancelRun = () => {
      button(topBar(), "Cancel run").props.onClick()
      const dialog = nodes(h.render(RunPage, props), node => node.type === ConfirmDialog)[0]
      return dialog.props.onConfirm
    }
    const submit = cancelRun()
    submit()
    submit()
    assert.equal(writes.length, 1)
    assert.equal(writes[0].url, "/api/runs/fixture/stop")
    assert.equal(button(topBar(), "Cancel run").props.disabled, true)
    writes[0].fail(new Error("Offline"))
    await h.flush()
    assert.equal(button(topBar(), "Cancel run").props.disabled, false)
    cancelRun()()
    assert.equal(writes.length, 2)
    writes[1].finish(Response.json({ ok: true }))
    await h.flush()
    assert.equal(button(topBar(), "Cancel run").props.disabled, false)
    cancelRun()()
    assert.equal(writes.length, 3)
  } finally {
    await f.cleanup()
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
