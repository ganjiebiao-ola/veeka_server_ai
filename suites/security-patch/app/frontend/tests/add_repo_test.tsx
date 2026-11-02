import { test } from "bun:test"
import assert from "node:assert/strict"
import { ConfirmDialog } from "../src/components/ConfirmDialog"
import { RepoSettings } from "../src/components/RepoSettings"
import { LandingPage } from "../src/pages/LandingPage"
import { Alert } from "../src/components/ui/alert"
import { browser, harness, nodes, text, is } from "./render"

const url = "https://github.com/owner/new-repo"
const props = { sessionId: "fixture", activeRuns: [], onStarted() {}, startRun: async () => ({ runId: "new", status: "queued" as const }) }

for (const scenario of ["non-PHP", "listed", "git", "slash", "case", "ssh", "ssh-url", "bare", "success", "failure", "network"] as const) {
  test(`Add repo: ${scenario}`, async () => {
    const b = browser("/")
    const originalFetch = globalThis.fetch
    let post: RequestInit | undefined
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const path = String(input)
      if (path === "/api/repos" && init?.method === "POST") {
        post = init
        if (scenario === "network") throw new Error("network")
        return scenario === "failure" ? Response.json({ error: "Bad branch" }, { status: 400 }) : Response.json({ ok: true, repo: "owner/new-repo" })
      }
      if (path === "/api/repos") return Response.json({ repos: ["listed", "git", "slash", "case", "ssh", "ssh-url", "bare"].includes(scenario) || (scenario === "success" && post) ? [{ url: scenario === "ssh" ? "git@github.com:owner/new-repo.git" : scenario === "ssh-url" ? "ssh://git@github.com/owner/new-repo" : scenario === "bare" ? "owner/new-repo" : url, branch: "main" }] : [] })
      if (path.startsWith("/api/repos/language?")) return Response.json({ language: scenario === "non-PHP" ? "Go" : "PHP", share: 82 })
      return Response.json(path === "/api/providers" ? { claude: { available: true } } : { models: [] })
    }) as typeof fetch
    const h = harness()
    try {
      h.render(LandingPage, props)
      await h.flush()
      const settings = () => h.render(RepoSettings, nodes(h.render(LandingPage, props), node => node.type === RepoSettings)[0].props as any)
      let view = settings()
      const inputUrl = scenario === "git" ? `${url}.git` : scenario === "slash" ? `${url}/` : scenario === "case" ? "https://github.com/OWNER/New-Repo" : url
      nodes(view, node => is(node, "input") && node.props.type === "url")[0].props.onChange({ target: { value: ` ${inputUrl} ` } })
      settings()
      await h.flush()
      await new Promise(resolve => setTimeout(resolve, 420))
      view = settings()
      const button = nodes(view, node => is(node, "button") && text(node) === "Add repo")[0]
      assert.equal(button.props.disabled, ["non-PHP", "listed", "git", "slash", "case", "ssh", "ssh-url", "bare"].includes(scenario))
      if (scenario === "non-PHP") {
        assert.match(text(view), /Language: Go \(82%\)/)
        assert.match(text(view), /This repo is Go\. The scan supports PHP only for now\./)
        assert.equal(nodes(view, node => node.type === Alert && node.props.variant === "warning").length, 1)
      }
      if (button.props.disabled) return
      nodes(view, node => is(node, "input") && is(node, "input") && node.props.type === "text")[0].props.onChange({ target: { value: "main" } })
      view = settings()
      await nodes(view, node => is(node, "button") && text(node) === "Add repo")[0].props.onClick()
      await h.flush()
      view = settings()
      assert.equal(post?.method, "POST")
      assert.deepEqual(post?.headers, { "Content-Type": "application/json" })
      assert.deepEqual(JSON.parse(post!.body as string), { url, branch: "main" })
      if (scenario === "success") {
        assert.match(text(view), /Added\./)
        assert.ok(nodes(h.render(LandingPage, props), node => node.type === "option" && node.props.value === url).length)
        assert.equal(nodes(view, node => is(node, "input") && node.props.type === "url")[0].props.value, "")
        assert.equal(nodes(view, node => is(node, "input") && node.props.type === "text")[0].props.value, "")
      } else assert.match(text(view), scenario === "failure" ? /Bad branch/ : /Could not add the repo\./)
    } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
  })
}

test("Repos lists branch and language and removal updates the scan dropdown", async () => {
  const b = browser("/")
  const originalFetch = globalThis.fetch
  let deleted = ""
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const path = String(input)
    if (init?.method === "DELETE") { deleted = path; return new Response(null, { status: 204 }) }
    if (path === "/api/repos") return Response.json({ repos: [{ url, branch: "main" }] })
    if (path.startsWith("/api/repos/language?")) return Response.json({ language: "PHP", share: 82 })
    return Response.json(path === "/api/providers" ? { claude: { available: true } } : { models: [] })
  }) as typeof fetch
  const h = harness()
  try {
    h.render(LandingPage, props)
    await h.flush()
    const page = () => h.render(LandingPage, props)
    const settings = () => h.render(RepoSettings, nodes(page(), node => node.type === RepoSettings)[0].props as any)
    const row = () => { const item = nodes(settings(), node => node.props.repo)[0]; return h.render(item.type as any, item.props as any) as any }
    assert.equal(nodes(page(), node => is(node, "button") && ["Add repo", "Remove"].includes(text(node))).length, 0)
    assert.match(text(settings()), /Repos · 1/)
    row()
    await h.flush()
    await new Promise(resolve => setTimeout(resolve, 420))
    assert.match(text(row()), /owner\/new-repo · main · PHP/)
    assert.equal(nodes(row(), node => is(node, "button") && text(node) === "Remove")[0].props["aria-label"], "Remove owner/new-repo")
    nodes(page(), node => is(node, "select") && node.props.id === "recent-repo")[0].props.onChange({ target: { value: url } })
    await h.flush()
    nodes(row(), node => is(node, "button") && text(node) === "Remove")[0].props.onClick()
    const dialog = nodes(settings(), node => node.type === ConfirmDialog)[0]
    const confirmation = h.render(ConfirmDialog, dialog.props as any)
    assert.match(text(confirmation), /Remove https:\/\/github.com\/owner\/new-repo from the list/)
    nodes(confirmation, node => is(node, "button") && text(node) === "Remove")[0].props.onClick()
    await h.flush()
    assert.equal(deleted, `/api/repos?url=${encodeURIComponent(url)}`)
    assert.match(text(settings()), /No repos yet\./)
    assert.equal(nodes(page(), node => node.type === "option" && node.props.value === url).length, 0)
    await h.flush()
    assert.match(text(page()), /Add a repo in the Repos section first\./)
    assert.equal(nodes(page(), node => is(node, "input") && node.props.placeholder === "Default branch")[0].props.value, "")
  } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
})


test("Add and remove cannot overlap", async () => {
  const b = browser("/")
  const originalFetch = globalThis.fetch
  let finish: (response: Response) => void = () => {}
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const path = String(input)
    if (init?.method === "POST" || init?.method === "DELETE") return new Promise<Response>(resolve => { finish = resolve })
    if (path === "/api/repos") return Response.json({ repos: [{ url, branch: "main" }] })
    if (path.startsWith("/api/repos/language?")) return Response.json({ language: "PHP", share: 82 })
    return Response.json(path === "/api/providers" ? { claude: { available: true } } : { models: [] })
  }) as typeof fetch
  const h = harness()
  try {
    const settings = () => h.render(RepoSettings, nodes(h.render(LandingPage, props), node => node.type === RepoSettings)[0].props as any)
    const row = () => { const item = nodes(settings(), node => node.props.repo)[0]; return h.render(item.type as any, item.props as any) as any }
    settings()
    await h.flush()
    nodes(settings(), node => is(node, "input") && node.props.type === "url")[0].props.onChange({ target: { value: "https://github.com/owner/other" } })
    settings()
    await h.flush()
    await new Promise(resolve => setTimeout(resolve, 420))
    const add = () => nodes(settings(), node => is(node, "button") && text(node) === "Add repo")[0]
    assert.equal(add().props.disabled, false)
    add().props.onClick()
    assert.equal(nodes(row(), node => is(node, "button"))[0].props.disabled, true)
    assert.ok(nodes(settings(), node => is(node, "input")).every(node => node.props.disabled))
    finish(Response.json({ ok: true }))
    await h.flush()
    nodes(settings(), node => is(node, "input") && node.props.type === "url")[0].props.onChange({ target: { value: "https://github.com/owner/other" } })
    settings()
    await h.flush()
    await new Promise(resolve => setTimeout(resolve, 420))
    assert.equal(add().props.disabled, false)
    nodes(row(), node => is(node, "button"))[0].props.onClick()
    const dialog = nodes(settings(), node => node.type === ConfirmDialog)[0]
    nodes(h.render(ConfirmDialog, dialog.props), node => is(node, "button") && text(node) === "Remove")[0].props.onClick()
    assert.equal(add().props.disabled, true)
    finish(new Response(null, { status: 204 }))
    await h.flush()
  } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
})

for (const lang of ["en", "zh"] as const) {
  test(`Scan requires a saved repo in ${lang}`, async () => {
    const b = browser("/", { ola_lang: lang })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: any) => Response.json(String(input) === "/api/providers" ? { claude: { available: true } } : String(input) === "/api/repos" ? { repos: [] } : { models: [] })) as typeof fetch
    const h = harness()
    try {
      h.render(LandingPage, props)
      await h.flush()
      const view = h.render(LandingPage, props)
      assert.match(text(view), lang === "en" ? /Add a repo in the Repos section first\./ : /先在“仓库”部分添加仓库。/)
      assert.equal(nodes(view, node => node.props["data-testid"] === "start-scan")[0].props.disabled, true)
    } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
  })
}

test("Scan waits for saved repos and reports a load failure", async () => {
  const b = browser("/")
  const originalFetch = globalThis.fetch
  let resolveRepos!: (response: Response) => void
  globalThis.fetch = ((input: any) => String(input) === "/api/repos"
    ? new Promise<Response>(resolve => { resolveRepos = resolve })
    : Promise.resolve(Response.json(String(input) === "/api/providers" ? { claude: { available: true } } : { models: [] }))) as typeof fetch
  const h = harness()
  try {
    const page = () => h.render(LandingPage, props)
    let view = page()
    await h.flush()
    view = page()
    assert.doesNotMatch(text(view), /Add a repo in the Repos section first\.|Could not load repositories/)
    assert.equal(nodes(view, node => is(node, "button") && text(node) === "Start scan")[0].props.disabled, true)
    resolveRepos(new Response(null, { status: 503 }))
    await h.flush()
    view = page()
    assert.match(text(view), /Could not load repositories: 503/)
    assert.doesNotMatch(text(view), /Add a repo in the Repos section first\./)
    assert.equal(nodes(view, node => is(node, "button") && text(node) === "Start scan")[0].props.disabled, true)
  } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
})

test("Scan defaults to the first repo, sends the selected URL, and picks the next after removal", async () => {
  const b = browser("/")
  const originalFetch = globalThis.fetch
  const other = "https://github.com/owner/other.git"
  let request: any
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    if (init?.method === "DELETE") return new Response(null, { status: 204 })
    return Response.json(String(input) === "/api/providers" ? { claude: { available: true } } : String(input) === "/api/repos" ? { repos: [{ url, branch: "main" }, { url: other, branch: "dev" }] } : { models: [] })
  }) as typeof fetch
  const h = harness()
  const scanProps = { ...props, startRun: async (value: any) => { request = value; return { runId: "new", status: "queued" as const } } }
  try {
    const page = () => h.render(LandingPage, scanProps)
    page()
    await h.flush()
    page()
    await h.flush()
    assert.equal(nodes(page(), node => is(node, "select") && node.props.id === "recent-repo")[0].props.value, url)
    assert.equal(nodes(page(), node => is(node, "input") && node.props.placeholder === "Default branch")[0].props.value, "main")
    nodes(page(), node => is(node, "select") && node.props.id === "recent-repo")[0].props.onChange({ target: { value: other } })
    page()
    await h.flush()
    await new Promise(resolve => setTimeout(resolve, 420))
    await nodes(page(), node => node.props["data-testid"] === "start-scan")[0].props.onClick()
    assert.equal(request.repoUrl, other)
    assert.equal(request.branch, "dev")
    const settings = () => h.render(RepoSettings, nodes(page(), node => node.type === RepoSettings)[0].props as any)
    nodes(settings(), node => node.props.repo)[1].props.onRemove()
    const dialog = nodes(settings(), node => node.type === ConfirmDialog)[0]
    nodes(h.render(ConfirmDialog, dialog.props), node => is(node, "button") && text(node) === "Remove")[0].props.onClick()
    await h.flush()
    page()
    await h.flush()
    assert.equal(nodes(page(), node => is(node, "select") && node.props.id === "recent-repo")[0].props.value, url)
    assert.equal(nodes(page(), node => is(node, "input") && node.props.placeholder === "Default branch")[0].props.value, "main")
  } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
})
