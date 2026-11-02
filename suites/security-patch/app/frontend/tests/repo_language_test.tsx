import { test } from "bun:test"
import assert from "node:assert/strict"
import { LandingPage } from "../src/pages/LandingPage"
import { RepoProfile } from "../src/components/RepoProfile"
import { browser, harness, nodes, text, is } from "./render"

const url = "https://github.com/owner/repo"
const props = { sessionId: "fixture", activeRuns: [], onStarted() {}, startRun: async () => ({ runId: "new", status: "queued" as const }) }

for (const scenario of ["PHP", "Go", "error", "null"] as const) {
  test(`Scan handles ${scenario} language detection`, async () => {
    const b = browser("/")
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: any) => {
      const path = String(input)
      if (path === "/api/providers") return Response.json({ claude: { available: true } })
      if (path === "/api/repos") return Response.json({ repos: [{ url, branch: "main" }] })
      if (path.startsWith("/api/repos/language?")) {
        assert.equal(path, `/api/repos/language?url=${encodeURIComponent(url)}`)
        return scenario === "error" ? new Response(null, { status: 503 }) : Response.json({ language: scenario === "null" ? null : scenario, share: 82 })
      }
      return Response.json({ configured: false, models: [] })
    }) as typeof fetch
    const h = harness()
    try {
      h.render(LandingPage, props)
      await h.flush()
      let view = h.render(LandingPage, props)
      nodes(view, node => is(node, "select") && node.props.id === "recent-repo")[0].props.onChange({ target: { value: url } })
      h.render(LandingPage, props)
      await h.flush()
      await new Promise(resolve => setTimeout(resolve, 420))
      view = h.render(LandingPage, props)
      assert.equal(nodes(view, node => node.type === RepoProfile).length, scenario === "Go" ? 0 : 1)
      assert.equal(nodes(view, node => is(node, "button") && text(node) === "Start scan")[0].props.disabled, scenario === "Go")
      if (scenario === "PHP" || scenario === "Go") assert.match(text(view), new RegExp(`Language: ${scenario} \\(82%\\)`))
      else assert.doesNotMatch(text(view), /Language:/)
      if (scenario === "Go") assert.match(text(view), /This repo is Go\. The scan supports PHP only for now\./)
      else assert.doesNotMatch(text(view), /The scan supports PHP only for now/)
    } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
  })
}

test("Scan ignores an outdated language response", async () => {
  const b = browser("/")
  const originalFetch = globalThis.fetch
  let resolveLanguage!: (response: Response) => void
  globalThis.fetch = ((input: any) => {
    const path = String(input)
    if (path.startsWith("/api/repos/language?")) return new Promise<Response>(resolve => { resolveLanguage = resolve })
    return Promise.resolve(Response.json(path === "/api/providers" ? { claude: { available: true } } : path === "/api/repos" ? { repos: [{ url, branch: "main" }, { url: "https://github.com/owner/other", branch: "dev" }] } : { models: [] }))
  }) as typeof fetch
  const h = harness()
  try {
    h.render(LandingPage, props)
    await h.flush()
    let view = h.render(LandingPage, props)
    nodes(view, node => is(node, "select") && node.props.id === "recent-repo")[0].props.onChange({ target: { value: url } })
    h.render(LandingPage, props)
    await h.flush()
    await new Promise(resolve => setTimeout(resolve, 420))
    view = h.render(LandingPage, props)
    nodes(view, node => is(node, "select") && node.props.id === "recent-repo")[0].props.onChange({ target: { value: "https://github.com/owner/other" } })
    h.render(LandingPage, props)
    await h.flush()
    resolveLanguage(Response.json({ language: "Go", share: 82 }))
    await h.flush()
    assert.doesNotMatch(text(h.render(LandingPage, props)), /Language:|This repo is Go/)
  } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
})

test("Scan waits for language detection and allows a failed lookup", async () => {
  const b = browser("/")
  const originalFetch = globalThis.fetch
  let resolveLanguage!: (response: Response) => void
  let starts = 0
  globalThis.fetch = ((input: any) => {
    const path = String(input)
    if (path.startsWith("/api/repos/language?")) return new Promise<Response>(resolve => { resolveLanguage = resolve })
    return Promise.resolve(Response.json(path === "/api/providers" ? { claude: { available: true } } : path === "/api/repos" ? { repos: [{ url, branch: "main" }] } : { models: [] }))
  }) as typeof fetch
  const h = harness()
  const scanProps = { ...props, startRun: async () => { starts++; return { runId: "new", status: "queued" as const } } }
  try {
    const page = () => h.render(LandingPage, scanProps)
    page()
    await h.flush()
    page()
    await h.flush()
    page()
    await h.flush()
    let start = nodes(page(), node => is(node, "button") && text(node) === "Start scan")[0]
    assert.equal(start.props.disabled, true)
    await start.props.onClick()
    assert.equal(starts, 0)
    await new Promise(resolve => setTimeout(resolve, 420))
    assert.equal(nodes(page(), node => is(node, "button") && text(node) === "Start scan")[0].props.disabled, true)
    resolveLanguage(new Response(null, { status: 503 }))
    await h.flush()
    start = nodes(page(), node => is(node, "button") && text(node) === "Start scan")[0]
    assert.equal(start.props.disabled, false)
    await start.props.onClick()
    assert.equal(starts, 1)
  } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
})
