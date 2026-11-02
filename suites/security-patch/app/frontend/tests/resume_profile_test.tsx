import { test } from "bun:test"
import assert from "node:assert/strict"
import { ResumeBar } from "../src/components/ResumeBar"
import { RepoProfile } from "../src/components/RepoProfile"
import { ProviderSelect } from "../src/components/ProviderSelect"
import { PickPage } from "../src/pages/PickPage"
import { browser, harness, nodes, text, is } from "./render"

test("Resume posts chosen auth without changing the stopped run's provider", async () => {
  const b = browser()
  const originalFetch = globalThis.fetch
  const requests: { url: string, init?: RequestInit }[] = []
  const resumed: string[] = []
  let finish!: (response: Response) => void
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    requests.push({ url: String(input), init })
    if (init?.method === "POST") return new Promise<Response>(resolve => { finish = resolve })
    if (String(input) === "/api/providers") return Response.json({ claude: { available: true, auth: "subscription", apiKey: true } })
    return Response.json({ provider: "claude", reviewProvider: "codex", authMode: "relay", caps: { maxTurns: 40, maxBudgetUsd: 1.5 } })
  }) as typeof fetch
  const h = harness()
  const props = { runId: "stopped/run ?", onResumed: (id: string) => resumed.push(id) }
  try {
    h.render(ResumeBar, props)
    await h.flush()
    let view = h.render(ResumeBar, props)
    const inputs = nodes(view, node => is(node, "input"))
    assert.deepEqual(inputs, [])
    const auth = nodes(view, node => is(node, "select"))[0]
    assert.equal(auth.props.value, "relay")
    assert.deepEqual(nodes(auth, node => node.type === "option").map(node => node.props.value), ["relay", "oauth", "api-key"])
    auth.props.onChange({ target: { value: "oauth" } })
    view = h.render(ResumeBar, props)
    const pending = nodes(view, node => is(node, "button"))[0].props.onClick()
    view = h.render(ResumeBar, props)
    assert.equal(nodes(view, node => is(node, "button"))[0].props.disabled, true)
    assert.match(text(view), /Resuming/)
    assert.deepEqual(resumed, [])
    assert.equal(requests[0].url, "/api/runs/stopped%2Frun%20%3F")
    const post = requests.find(request => request.init?.method === "POST")!
    assert.equal(post.url, "/api/runs/stopped%2Frun%20%3F/resume")
    assert.deepEqual(post.init?.headers, { "Content-Type": "application/json" })
    assert.deepEqual(JSON.parse(String(post.init?.body)), { authMode: "oauth" })
    finish(Response.json({ runId: "next" }, { status: 201 }))
    await pending
    assert.deepEqual(resumed, ["next"])
  } finally {
    h.cleanup()
    globalThis.fetch = originalFetch
    b.cleanup()
  }
})

for (const choice of ["claude", "claude-api-key"]) {
  test(`Pick and Resume preserve chosen ${choice} auth and review provider, and Resume ignores legacy caps`, async () => {
    const b = browser()
    const originalFetch = globalThis.fetch
    const requests: { url: string, init: RequestInit }[] = []
    globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
      const url = String(input)
      requests.push({ url, init })
      if (url === "/api/providers") return Response.json({ claude: { available: true, apiKey: true }, codex: { available: true } })
      if (url === "/api/pick") return Response.json({ runId: "stopped" }, { status: 201 })
      if (url.startsWith("/api/pick?")) return Response.json({ repoUrl: "https://github.com/owner/repo", rows: [
        { id: "one", category: "sqli", subsystem: "app", severity: "P1", file: "app/a.php", lines: [1], status: "open", reason: "Check" },
      ], hidden: [], suggestedIds: ["one"] })
      if (url === "/api/runs/stopped") return Response.json({ provider: "claude", authMode: choice === "claude-api-key" ? "api-key" : "oauth", caps: { maxTurns: 40, maxBudgetUsd: 2.75 } })
      assert.equal(url, "/api/runs/stopped/resume")
      return Response.json({ runId: "resumed" }, { status: 201 })
    }) as typeof fetch
    const h = harness()
    const started: string[] = []
    const props = { sessionId: "session", activeRuns: [], onStarted: (id: string) => started.push(id) }
    try {
      h.render(PickPage, props)
      await h.flush()
      nodes(h.render(PickPage, props), node => node.props["aria-label"] === "Pick one")[0].props.onCheckedChange(true)
      let view = h.render(PickPage, props)
      const providers = nodes(view, node => node.type === ProviderSelect)
      providers[0].props.onChange(choice)
      providers[1].props.onChange("codex")
      assert.equal(nodes(view, node => is(node, "input") && node.props.type === "number").length, 0)
      view = h.render(PickPage, props)
      const start = nodes(view, node => is(node, "button") && text(node).startsWith("Fix selected"))[0]
      assert.equal(start.props.disabled, false)
      start.props.onClick()
      await h.flush()
      const picked = JSON.parse(String(requests.find(request => request.url === "/api/pick")?.init.body))
      assert.equal(picked.provider, "claude")
      assert.equal(picked.reviewProvider, "codex")
      assert.equal(picked.authMode, choice === "claude-api-key" ? "api-key" : undefined)
      assert.equal(picked.maxTurns, undefined)
      assert.equal(picked.maxBudgetUsd, undefined)
      assert.deepEqual(started, ["stopped"])
      const resumeProps = { runId: started[0], onResumed: (id: string) => started.push(id) }
      h.render(ResumeBar, resumeProps)
      await h.flush()
      view = h.render(ResumeBar, resumeProps)
      await nodes(view, node => is(node, "button"))[0].props.onClick()
      assert.deepEqual(JSON.parse(String(requests.at(-1)?.init.body)), { authMode: choice === "claude-api-key" ? "api-key" : "oauth" })
      assert.deepEqual(started, ["stopped", "resumed"])
    } finally {
      h.cleanup()
      globalThis.fetch = originalFetch
      b.cleanup()
    }
  })
}

for (const scenario of [
  { provider: "claude", authMode: "api-key", available: true, auth: "subscription", apiKey: true, options: ["api-key", "oauth"], chosen: "oauth" },
  { provider: "claude", authMode: "oauth", available: true, auth: "subscription", apiKey: true, options: ["oauth", "api-key"], chosen: "api-key" },
  { provider: "claude", authMode: "api-key", available: true, auth: "api-key", apiKey: false, options: ["api-key"], chosen: "api-key" },
  { provider: "claude", authMode: "oauth", available: true, auth: "subscription", apiKey: false, options: ["oauth"], chosen: "oauth" },
  { provider: "claude", authMode: "relay", available: false, options: ["relay"], chosen: "relay" },
  { provider: "codex", authMode: "oauth", available: true, auth: "subscription", apiKey: true, options: ["oauth"], chosen: "oauth" },
  { provider: "codex", authMode: "oauth", codex: { available: true, auth: "subscription", apiKey: true }, options: ["oauth", "api-key"], chosen: "api-key" },
  { provider: "codex", authMode: "api-key", codex: { available: true, auth: "subscription", apiKey: true }, options: ["api-key", "oauth"], chosen: "oauth" },
  { provider: "codex", authMode: "api-key", codex: { available: true, auth: "api-key", apiKey: true }, options: ["api-key"], chosen: "api-key" },
  { provider: "codex", authMode: "oauth", codex: { available: true, auth: "subscription" }, options: ["oauth"], chosen: "oauth" },
]) {
  test(`Resume ${scenario.provider} ${scenario.authMode} offers ${scenario.options} and sends ${scenario.chosen}`, async () => {
    const originalFetch = globalThis.fetch
    let body: unknown
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      if (init?.method === "POST") {
        body = JSON.parse(String(init.body))
        return Response.json({ runId: "next" })
      }
      return Response.json(String(input) === "/api/providers"
        ? { claude: { available: scenario.available, auth: scenario.auth, apiKey: scenario.apiKey }, codex: scenario.codex ?? { available: true } }
        : { provider: scenario.provider, authMode: scenario.authMode })
    }) as typeof fetch
    const h = harness()
    const props = { runId: "stopped", onResumed() {} }
    try {
      h.render(ResumeBar, props)
      await h.flush()
      let view = h.render(ResumeBar, props)
      const select = nodes(view, node => is(node, "select"))[0]
      assert.equal(select.props.value, scenario.authMode)
      assert.deepEqual(nodes(select, node => node.type === "option").map(node => node.props.value), scenario.options)
      if (scenario.provider === "codex" && scenario.options.length > 1) {
        assert.deepEqual(nodes(select, node => node.type === "option").map(node => text(node)), scenario.options.map(mode => mode === "oauth" ? "Codex · Subscription" : "Codex · API key"))
      }
      select.props.onChange({ target: { value: scenario.chosen } })
      view = h.render(ResumeBar, props)
      await nodes(view, node => is(node, "button"))[0].props.onClick()
      assert.deepEqual(body, { authMode: scenario.chosen })
    } finally {
      h.cleanup()
      globalThis.fetch = originalFetch
    }
  })
}

test("Resume omits the previous run's auth while the next run's metadata loads", async () => {
  const originalFetch = globalThis.fetch
  let body: unknown
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    if (init?.method === "POST") {
      body = JSON.parse(String(init.body))
      return Response.json({ runId: "resumed" })
    }
    if (String(input) === "/api/providers") return Response.json({})
    if (String(input) === "/api/runs/old") return Response.json({ provider: "claude", authMode: "api-key" })
    return new Promise<Response>(() => {})
  }) as typeof fetch
  const h = harness()
  try {
    h.render(ResumeBar, { runId: "old", onResumed() {} })
    await h.flush()
    const props = { runId: "next", onResumed() {} }
    h.render(ResumeBar, props)
    await h.flush()
    const view = h.render(ResumeBar, props)
    assert.equal(nodes(view, node => is(node, "select")).length, 0)
    await nodes(view, node => is(node, "button"))[0].props.onClick()
    assert.deepEqual(body, {})
  } finally {
    h.cleanup()
    globalThis.fetch = originalFetch
  }
})

test("Resume cannot submit twice before React renders the busy state", async () => {
  const originalFetch = globalThis.fetch
  let posts = 0
  let finish!: (response: Response) => void
  globalThis.fetch = (async () => {
    posts++
    return new Promise<Response>(resolve => { finish = resolve })
  }) as unknown as typeof fetch
  const h = harness()
  try {
    const view = h.render(ResumeBar, { runId: "stopped", onResumed() {} })
    const submit = nodes(view, node => is(node, "button"))[0].props.onClick
    const first = submit()
    const second = submit()
    assert.equal(posts, 1)
    finish(Response.json({ runId: "next" }))
    await Promise.all([first, second])
  } finally {
    h.cleanup()
    globalThis.fetch = originalFetch
  }
})

for (const failure of ["network", "server", "HTML", "missing runId"]) {
  test(`Resume recovers from ${failure} failure and retries with only auth options`, async () => {
    const originalFetch = globalThis.fetch
    let posts = 0
    let resumed = ""
    globalThis.fetch = (async (_input: any, init?: RequestInit) => {
      if (!init) return new Response(null, { status: 503 })
      posts++
      assert.deepEqual(JSON.parse(String(init.body)), {})
      if (posts > 1) return Response.json({ runId: "retry" })
      if (failure === "network") throw new Error("Connection lost")
      if (failure === "server") return Response.json({ error: "Request rejected" }, { status: 400 })
      if (failure === "HTML") return new Response("<html>Unavailable</html>", { status: 502 })
      return Response.json({})
    }) as typeof fetch
    const h = harness()
    const props = { runId: "stopped", onResumed: (id: string) => { resumed = id } }
    try {
      h.render(ResumeBar, props)
      await h.flush()
      let view = h.render(ResumeBar, props)
      for (const input of nodes(view, node => is(node, "input"))) input.props.onChange({ target: { value: "  " } })
      view = h.render(ResumeBar, props)
      await nodes(view, node => is(node, "button"))[0].props.onClick()
      view = h.render(ResumeBar, props)
      assert.equal(resumed, "")
      assert.equal(nodes(view, node => is(node, "button"))[0].props.disabled, false)
      assert.match(text(view), failure === "network" ? /Connection lost/ : failure === "server" ? /Request rejected/ : failure === "HTML" ? /Resume failed \(502\)/ : /Resume failed \(200\)/)
      await nodes(view, node => is(node, "button"))[0].props.onClick()
      assert.equal(resumed, "retry")
      assert.equal(posts, 2)
      assert.equal(nodes(h.render(ResumeBar, props), node => node.props.className === "push-error").length, 0)
    } finally {
      h.cleanup()
      globalThis.fetch = originalFetch
    }
  })
}

test("RepoProfile validates PHP and saves trimmed overrides as JSON", async () => {
  const originalFetch = globalThis.fetch
  let request: RequestInit | undefined
  let finish!: (response: Response) => void
  const saved: unknown[] = []
  globalThis.fetch = ((input: any, init?: RequestInit) => {
    assert.equal(input, "/api/repos/profile")
    request = init
    return new Promise<Response>(resolve => { finish = resolve })
  }) as typeof fetch
  const h = harness()
  const props = { url: "https://github.com/owner/repo", profile: { language: "php", php: "7.2", framework: "phalcon", sources: [] }, override: null, onSaved: (value: unknown) => saved.push(value) }
  try {
    h.render(RepoProfile, props)
    await h.flush()
    let view = h.render(RepoProfile, props)
    assert.equal(nodes(view, node => is(node, "button"))[0].props.disabled, true)
    assert.match(text(view), /PHP 7.2 · phalcon/)
    for (const value of ["8", "8.2.1", "abc", "-1.2"]) {
      nodes(view, node => is(node, "input"))[0].props.onChange({ target: { value } })
      view = h.render(RepoProfile, props)
      assert.equal(nodes(view, node => is(node, "input"))[0].props["aria-invalid"], true)
      assert.equal(nodes(view, node => is(node, "button"))[0].props.disabled, true)
      assert.equal(request, undefined)
    }
    const inputs = nodes(view, node => is(node, "input"))
    inputs[0].props.onChange({ target: { value: " 8.2 " } })
    inputs[1].props.onChange({ target: { value: " Laravel " } })
    view = h.render(RepoProfile, props)
    assert.equal(nodes(view, node => is(node, "input"))[0].props["aria-invalid"], false)
    assert.equal(nodes(view, node => is(node, "button"))[0].props.disabled, false)
    const pending = nodes(view, node => is(node, "button"))[0].props.onClick()
    assert.equal(nodes(h.render(RepoProfile, props), node => is(node, "button"))[0].props.disabled, true)
    assert.equal(request?.method, "PUT")
    assert.deepEqual(request?.headers, { "Content-Type": "application/json" })
    assert.deepEqual(JSON.parse(String(request?.body)), { url: props.url, php: "8.2", framework: "laravel" })
    finish(new Response(null, { status: 204 }))
    await pending
    assert.deepEqual(saved, [{ php: "8.2", framework: "laravel" }])
    view = h.render(RepoProfile, { ...props, override: { php: "8.2", framework: "laravel" } })
    assert.match(text(view), /Saved\. The next scan uses these values/)
    assert.equal(nodes(view, node => is(node, "button"))[0].props.disabled, true)
    assert.deepEqual(nodes(view, node => is(node, "input")).map(node => node.props.value), [" 8.2 ", " Laravel "])
  } finally {
    h.cleanup()
    globalThis.fetch = originalFetch
  }
})

for (const failure of ["network", "JSON", "HTML"]) {
  test(`RepoProfile displays ${failure} save failures and can retry or clear overrides`, async () => {
    const originalFetch = globalThis.fetch
    let requests = 0
    const saved: unknown[] = []
    globalThis.fetch = (async (_input: any, init: RequestInit) => {
      requests++
      assert.deepEqual(JSON.parse(String(init.body)), { url: "repo", php: "", framework: "" })
      if (requests > 1) return new Response(null, { status: 204 })
      if (failure === "network") throw new Error("Offline")
      return failure === "JSON" ? Response.json({ error: "Not allowed" }, { status: 403 }) : new Response("Bad gateway", { status: 502 })
    }) as typeof fetch
    const h = harness()
    const props = { url: "repo", profile: null, override: { php: "8.2", framework: "laravel" }, onSaved: (value: unknown) => saved.push(value) }
    try {
      h.render(RepoProfile, props)
      await h.flush()
      let view = h.render(RepoProfile, props)
      for (const input of nodes(view, node => is(node, "input"))) input.props.onChange({ target: { value: " " } })
      view = h.render(RepoProfile, props)
      await nodes(view, node => is(node, "button"))[0].props.onClick()
      view = h.render(RepoProfile, props)
      assert.match(text(view), failure === "JSON" ? /Not allowed/ : /Could not save\. Try again/)
      assert.deepEqual(saved, [])
      assert.equal(nodes(view, node => is(node, "button"))[0].props.disabled, false)
      await nodes(view, node => is(node, "button"))[0].props.onClick()
      assert.deepEqual(saved, [{ php: "", framework: "" }])
      assert.doesNotMatch(text(h.render(RepoProfile, props)), /Not allowed|Could not save/)
      const nextProps = { ...props, url: "other", override: { php: "7.4", framework: "symfony" } }
      h.render(RepoProfile, nextProps)
      await h.flush()
      view = h.render(RepoProfile, nextProps)
      assert.deepEqual(nodes(view, node => is(node, "input")).map(node => node.props.value), ["7.4", "symfony"])
      assert.doesNotMatch(text(view), /Saved\./)
    } finally {
      h.cleanup()
      globalThis.fetch = originalFetch
    }
  })
}
