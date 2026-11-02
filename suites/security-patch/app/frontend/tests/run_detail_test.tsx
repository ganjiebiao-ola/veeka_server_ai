import { test } from "bun:test"
import assert from "node:assert/strict"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { FindingsPanel, RunDetailPage } from "../src/pages/RunDetailPage"
import { I18nProvider } from "../src/i18n"
import { RunFacts } from "../src/components/RunFacts"
import { replayEvents } from "../../backend/events/replay.ts"
import { harness, nodes, text, is } from "./render"
import { ReportView } from "../src/components/ReportView"
import { RunOutcome } from "../src/components/RunOutcome"
import { CompletionCard } from "../src/components/CompletionCard"
import { ResumeBar } from "../src/components/ResumeBar"
import { Checkbox } from "../src/components/ui/checkbox"

const findings = [
  { id: "new", category: "sqli", severity: "P1" as const, file: "query.ts", line: 1, reason: "Unchecked input", fixSummary: "Bind parameters" },
  { id: "tracked", category: "cors", severity: "P2" as const, file: "cors.ts", line: 2 },
  { id: "posted", category: "sqli", severity: "P1" as const, file: "done.ts", line: 3, posted: true },
]
const initialCheck = { repo: "owner/repo", matches: {
  tracked: { kind: "tracked" as const, url: "https://github.com/owner/tracker/blob/main/sqli.json", file: "cors.ts", line: 2, status: "open" },
} }
const button = (view: React.ReactNode, name: string) => nodes(view, node => is(node, "button") && text(node) === name)[0]
const checkboxes = (view: React.ReactNode) => nodes(view, node => node.type === Checkbox)

test("posting findings ignores a second click before React renders the disabled button", async () => {
  const originalFetch = globalThis.fetch
  const pending: ((response: Response) => void)[] = []
  const requests: RequestInit[] = []
  globalThis.fetch = ((input: any, init?: RequestInit) => {
    assert.equal(String(input), "/api/runs/run%2Fid/post")
    requests.push(init!)
    return new Promise<Response>(resolve => pending.push(resolve))
  }) as unknown as typeof fetch
  const h = harness()
  const props = { findings, initialCheck, runId: "run/id", canPost: true, onPosted() {} }
  try {
    const post = button(h.render(FindingsPanel, props), "Post 1 to GitHub")
    post.props.onClick()
    post.props.onClick()
    assert.equal(requests.length, 1)
    assert.equal(requests[0].method, "POST")
    assert.deepEqual(JSON.parse(requests[0].body as string), { ids: ["new"] })
    const busy = h.render(FindingsPanel, props)
    assert.equal(button(busy, "Posting…").props.disabled, true)
    assert(checkboxes(busy).every(node => node.props.disabled))
    assert(nodes(busy, node => is(node, "button")).every(node => node.props.disabled))
  } finally {
    pending.forEach(resolve => resolve(Response.json({ error: "Cancelled" }, { status: 500 })))
    await h.flush()
    h.cleanup()
    globalThis.fetch = originalFetch
  }
})

test("finished run details render reasoning and Bash commands as timed one-line folds in one collapsed timeline", async () => {
  const frames = [
    { kind: "sdk_message", ts: Date.UTC(2026, 0, 2, 3, 4, 5), message: { type: "assistant", message: { content: [
      { type: "thinking", thinking: "Check the affected code" },
      { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "pwd" } },
    ] } } },
    { kind: "sdk_message", message: { type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "bash-1", content: "/workspace/repo", is_error: false },
    ] } } },
    { kind: "run_finished" },
  ]
  let events = ""
  for await (const line of replayEvents(new Response(frames.map(frame => JSON.stringify(frame)).join("\n")).body!)) events += line
  const dispatcher = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
  const originalDispatcher = dispatcher.current
  const originalFetch = globalThis.fetch
  const states: any[] = []
  const effects: (() => void | (() => void))[] = []
  const cleanups: (() => void)[] = []
  const requests: string[] = []
  let index = 0
  dispatcher.current = {
    useContext: (context: any) => context._currentValue,
    useState(initial: any) {
      const i = index++
      if (!(i in states)) states[i] = typeof initial === "function" ? initial() : initial
      return [states[i], (value: any) => { states[i] = typeof value === "function" ? value(states[i]) : value }]
    },
    useEffect: (effect: () => void | (() => void)) => effects.push(effect),
  }
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    requests.push(url)
    if (url.endsWith("/fixture")) return Response.json({
      runId: "fixture", status: "completed", mode: "audit-only", repoUrl: "https://github.com/example/repo", branch: "main",
    })
    if (url.endsWith("/artifacts/events?replay=1")) return new Response(events)
    if (url.endsWith("/artifacts/report")) return new Response("Completed report")
    return new Response(null, { status: 404 })
  }) as typeof fetch
  const props = { runId: "fixture", onBack() {}, onResumed() {} }
  try {
    RunDetailPage(props)
    for (const effect of effects.splice(0)) {
      const cleanup = effect()
      if (cleanup) cleanups.push(cleanup)
    }
    await new Promise(resolve => setTimeout(resolve, 0))
    index = 0
    const view = RunDetailPage(props)
    dispatcher.current = originalDispatcher
    const html = renderToStaticMarkup(view)
    assert(requests.includes("/api/runs/fixture/artifacts/events?replay=1"))
    assert.match(html, /aria-expanded="false"[^>]*>(?:(?!<\/button>).)*run\.timeline/)
    const time = '<time [^>]*dateTime="2026-01-02T03:04:05\\.000Z">'
    assert.match(html, new RegExp(`<li[^>]*><details[^>]*><summary data-kind="reasoning"[^>]*><svg.*?</svg>${time}`))
    assert.match(html, />Check the affected code<\/span><\/summary><\/details><\/li>/)
    assert.match(html, new RegExp(`<li[^>]*><details[^>]*><summary data-kind="run" data-status="ok"[^>]*><svg.*?</svg>${time}`))
    assert.match(html, /<span[^>]*>Bash<\/span><span[^>]*>pwd<\/span><span[^>]*><span[^>]*>✓<\/span> \/workspace\/repo<\/span><\/summary>/)
    // The tool result frame has no ts, so its time comes from the tool call.
    assert.equal(html.match(/<time /g)?.length, 2)
    assert.doesNotMatch(html, /terminal-panel/)
  } finally {
    for (const cleanup of cleanups) cleanup()
    dispatcher.current = originalDispatcher
    globalThis.fetch = originalFetch
  }
})

test("only new findings start ticked, and GitHub matches link to their tracker file", () => {
  const findings = [
    { id: "a", category: "sqli", severity: "P1" as const, file: "a.ts", line: 1 },
    { id: "b", category: "cors", severity: "P2" as const, file: "b.ts", line: 2 },
    { id: "c", category: "cors", severity: "P2" as const, file: "c.ts", line: 3, posted: true },
    { id: "d", category: "sqli", severity: "P1" as const, file: "d.ts", line: 4 },
    { id: "e", category: "sqli", severity: "P1" as const, file: "e.ts", line: 9 },
  ]
  const initialCheck = { repo: "owner/repo", matches: {
    d: { kind: "tracked" as const, url: "https://github.com/owner/tracker/blob/main/sqli.json", file: "d.ts", line: 4, status: "open" },
    e: { kind: "similar" as const, url: "https://github.com/owner/tracker/blob/main/sqli.json", file: "e.ts", line: 5, status: "fixed" },
  } }
  const render = (canPost: boolean) => renderToStaticMarkup(
    <I18nProvider><FindingsPanel findings={findings} runId="r" canPost={canPost} onPosted={() => {}} initialCheck={initialCheck} /></I18nProvider>)
  const html = render(true)
  assert.equal(html.match(/role="checkbox"/g)?.length, 4)
  assert.equal(html.match(/aria-checked="true"/g)?.length, 2)
  assert.match(html, /aria-checked="true"[^>]*aria-label="SQLi \(§1.1\) a.ts:1"/)
  assert.match(html, /href="https:\/\/github.com\/owner\/tracker\/blob\/main\/sqli.json"[^>]*title="Tracker file already has d.ts:4 \(open\)."[^>]*>Tracked</)
  assert.match(html, />Similar</)
  assert.match(html, />Posted</)
  assert.match(html, /2 new · 1 already tracked · 1 similar/)
  assert.doesNotMatch(renderToStaticMarkup(<I18nProvider><FindingsPanel findings={findings.slice(0, 1)} runId="r" canPost onPosted={() => {}} initialCheck={{ repo: "owner/repo", matches: {} }} /></I18nProvider>), /1 new · |\d already tracked|\d similar/)
  assert.match(html, /Post 2 to GitHub/)
  const readOnly = render(false)
  assert.doesNotMatch(readOnly, /role="checkbox"|Post \d to GitHub|Tracked</)
})

test("run facts show Run, Model and Usage groups, and a zero subagent cap reads as none", () => {
  const meta = {
    runId: "r", status: "completed", mode: "scan", repoUrl: "https://github.com/o/r", skill: "ola-security-audit", categories: ["sqli"],
    provider: "claude", authMode: "oauth", model: "sonnet", maxSubagents: 0, startedAt: 1_000, finishedAt: 120_000,
    usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreateTokens: 0 },
  } as any
  const html = renderToStaticMarkup(<I18nProvider><RunFacts meta={meta} note="The container is gone." /></I18nProvider>)
  assert.match(html, /<dt[^>]*>Run<\/dt>.*<dt[^>]*>Model<\/dt>.*<dt[^>]*>Usage<\/dt>/)
  assert.match(html, /no subagents/)
  assert.match(html, />1\.5k tokens</)
  assert.match(html, />1m 59s</)
  assert.match(html, /<p[^>]*>The container is gone\.<\/p>/)
})

test("the GitHub check selects only new findings and selection controls post only ticked ids", async () => {
  const originalFetch = globalThis.fetch
  const requests: { url: string, init?: RequestInit }[] = []
  let finishCheck!: (response: Response) => void
  const reloaded = findings.map(finding => ({ ...finding, posted: true }))
  let posted: unknown
  globalThis.fetch = ((input: any, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, init })
    if (url.endsWith("/findings")) return Promise.resolve(Response.json({ findings: reloaded }))
    if (init?.method === "POST") return Promise.resolve(Response.json({ added: 1, skipped: 1 }))
    return new Promise<Response>(resolve => { finishCheck = resolve })
  }) as unknown as typeof fetch
  const h = harness()
  const props = { findings, runId: "run/id", canPost: true, onPosted(value: unknown) { posted = value } }
  try {
    let view = h.render(FindingsPanel, props)
    assert.match(text(view), /Checking tracker files/)
    assert.equal(button(view, "Post 0 to GitHub").props.disabled, true)
    assert(checkboxes(view).every(node => node.props.disabled))
    await h.flush()
    finishCheck(Response.json(initialCheck))
    await h.flush()
    view = h.render(FindingsPanel, props)
    assert.deepEqual(checkboxes(view).map(node => node.props.checked), [true, false])
    assert.match(text(view), /1 new · 1 already tracked/)
    assert.match(text(view), /Unchecked input.*Bind parameters|Bind parameters.*Unchecked input/)
    assert.equal(nodes(view, node => is(node, "td") && node.props.colSpan === 6).length, 1)
    button(view, "Select all").props.onClick()
    view = h.render(FindingsPanel, props)
    assert.equal(button(view, "Post 2 to GitHub").props.disabled, false)
    button(view, "Clear").props.onClick()
    view = h.render(FindingsPanel, props)
    assert.equal(button(view, "Post 0 to GitHub").props.disabled, true)
    button(view, "Select new").props.onClick()
    view = h.render(FindingsPanel, props)
    const checks = checkboxes(view)
    checks[0].props.onCheckedChange(false)
    checks[1].props.onCheckedChange(true)
    view = h.render(FindingsPanel, props)
    assert.deepEqual(checkboxes(view).map(node => node.props.checked), [false, true])
    button(view, "Post 1 to GitHub").props.onClick()
    await h.flush()
    view = h.render(FindingsPanel, props)
    assert.deepEqual(requests.map(request => [request.url, request.init?.method ?? "GET"]), [
      ["/api/runs/run%2Fid/post", "GET"], ["/api/runs/run%2Fid/post", "POST"], ["/api/runs/run%2Fid/findings", "GET"],
    ])
    assert.deepEqual(JSON.parse(requests[1].init!.body as string), { ids: ["tracked"] })
    assert.deepEqual(requests[1].init!.headers, { "Content-Type": "application/json" })
    assert.deepEqual(posted, reloaded)
    assert.match(text(view), /Posted to GitHub: 1 added, 1 already there/)
    assert.equal(button(view, "Post 0 to GitHub").props.disabled, true)
  } finally {
    h.cleanup()
    globalThis.fetch = originalFetch
  }
})

for (const failure of ["server", "html", "network"]) {
  test(`posting shows a ${failure} error and allows a successful retry`, async () => {
    const originalFetch = globalThis.fetch
    let attempts = 0
    let reloads = 0
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      if (String(input).endsWith("/findings")) {
        reloads++
        return new Response(null, { status: 404 })
      }
      assert.equal(init?.method, "POST")
      assert.deepEqual(JSON.parse(init!.body as string), { ids: ["new"] })
      attempts++
      if (attempts > 1) return Response.json({ added: 1, skipped: 0 })
      if (failure === "network") throw new Error("Offline")
      return failure === "html" ? new Response("<html>Gateway error</html>", { status: 502 })
        : Response.json({ error: "GitHub denied the write" }, { status: 403 })
    }) as unknown as typeof fetch
    const h = harness()
    const props = { findings, initialCheck, runId: "r", canPost: true, onPosted() { assert.fail("Missing findings must not replace existing findings") } }
    try {
      button(h.render(FindingsPanel, props), "Post 1 to GitHub").props.onClick()
      await h.flush()
      let view = h.render(FindingsPanel, props)
      const error = nodes(view, node => node.props.role === "alert")[0]
      assert.equal(error.props.role, "alert")
      assert.equal(text(error), failure === "network" ? "Offline" : failure === "html" ? "HTTP 502" : "GitHub denied the write")
      assert.equal(button(view, "Post 1 to GitHub").props.disabled, false)
      assert(checkboxes(view).every(node => !node.props.disabled))
      assert.equal(reloads, 0)
      button(view, "Post 1 to GitHub").props.onClick()
      view = h.render(FindingsPanel, props)
      assert.equal(nodes(view, node => node.props.role === "alert").length, 0)
      await h.flush()
      view = h.render(FindingsPanel, props)
      assert.equal(attempts, 2)
      assert.equal(reloads, 1)
      assert.match(text(view), /1 added, 0 already there/)
      assert.equal(button(view, "Post 0 to GitHub").props.disabled, true)
    } finally {
      h.cleanup()
      globalThis.fetch = originalFetch
    }
  })
}

test("a failed GitHub check warns, selects unposted findings and leaves manual selection available", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => Response.json({ error: "GitHub unavailable" }, { status: 503 })) as unknown as typeof fetch
  const h = harness()
  const props = { findings, runId: "r", canPost: true, onPosted() {} }
  try {
    h.render(FindingsPanel, props)
    await h.flush()
    const view = h.render(FindingsPanel, props)
    assert.match(text(view), /Could not check tracker files.*GitHub unavailable.*Review the list/)
    assert.equal(button(view, "Select new").props.disabled, true)
    assert.equal(button(view, "Post 2 to GitHub").props.disabled, false)
    assert.deepEqual(checkboxes(view).map(node => node.props.checked), [true, true])
  } finally {
    h.cleanup()
    globalThis.fetch = originalFetch
  }
})

for (const fails of [false, true]) {
  test(`GitHub check ignores ${fails ? "failure" : "success"} after unmount`, async () => {
    const originalFetch = globalThis.fetch
    let finish!: (response: Response) => void
    globalThis.fetch = (() => new Promise<Response>(resolve => { finish = resolve })) as unknown as typeof fetch
    const h = harness()
    const props = { findings, runId: "r", canPost: true, onPosted() {} }
    try {
      h.render(FindingsPanel, props)
      await h.flush()
      h.cleanup()
      finish(fails ? new Response(null, { status: 503 }) : Response.json(initialCheck))
      await h.flush()
      const view = h.render(FindingsPanel, props)
      assert.match(text(view), /Checking tracker files/)
      assert.equal(button(view, "Post 0 to GitHub").props.disabled, true)
    } finally {
      h.cleanup()
      globalThis.fetch = originalFetch
    }
  })
}

for (const scenario of ["scan", "fix", "stopped", "resumed", "non-github"] as const) {
  test(`run details expose the correct actions and reports for ${scenario}`, async () => {
    const originalFetch = globalThis.fetch
    const meta = {
      runId: "run/id", runNumber: 12, mode: scenario === "fix" ? "fix" : "scan", branch: "main",
      repoUrl: scenario === "non-github" ? "https://example.com/owner/repo" : "https://github.com/owner/repo.git",
      status: ["stopped", "resumed"].includes(scenario) ? "stopped" : "completed",
      attempts: scenario === "resumed" ? [{ runId: "run/id" }, { runId: "later" }] : undefined,
      stopReason: scenario === "stopped" ? "quota" : undefined,
    }
    const urls: string[] = []
    globalThis.fetch = (async (input: any) => {
      const url = String(input)
      urls.push(url)
      if (url.endsWith("/run%2Fid")) return Response.json(meta)
      if (url.endsWith("/findings")) return Response.json({ findings })
      if (url.endsWith("/report")) return new Response("Legacy full report")
      if (url.endsWith("/response")) return new Response("Final summary")
      if (url.endsWith("/activity") && scenario === "scan") return new Response("Process log")
      if (url.endsWith("/push")) return Response.json(scenario === "fix" ? { pr: 7 } : { prUrl: "javascript:alert(1)" })
      return new Response(null, { status: 404 })
    }) as unknown as typeof fetch
    const h = harness()
    let backs = 0
    let prevented = false
    const onResumed = () => {}
    const props = { runId: "run/id", onBack() { backs++ }, onResumed }
    try {
      assert.match(text(h.render(RunDetailPage, props)), /Loading/)
      await h.flush()
      let view = h.render(RunDetailPage, props)
      assert.equal(text(nodes(view, node => node.type === "h1")[0]), "owner/repo #12 main")
      // Only a fix run opens a PR, so only it asks for push.json.
      assert.equal(urls.some(url => url.endsWith("/artifacts/push")), scenario === "fix")
      const panel = nodes(view, node => node.type === FindingsPanel)[0]
      assert.equal(panel.props.canPost, scenario === "scan")
      if (scenario === "scan") {
        const findingView = h.render(FindingsPanel, panel.props)
        assert(nodes(findingView, node => is(node, "th")).some(node => text(node) === "Select findings"))
      }
      const reports = nodes(view, node => node.type === ReportView)
      assert.deepEqual(reports.map(node => [node.props.text, node.props.downloadKind]), scenario === "scan"
        ? [["Final summary", "response"], ["Process log", "activity"]] : [["Legacy full report", "report"]])
      if (scenario === "scan") {
        assert.equal(reports[1].props.defaultOpen, false)
        assert.equal(nodes(view, node => node.type === FindingsPanel || node.type === ReportView)[0].type, FindingsPanel)
        panel.props.onPosted(findings.map(finding => ({ ...finding, posted: true })))
        view = h.render(RunDetailPage, props)
        assert.equal(nodes(view, node => node.type === FindingsPanel || node.type === ReportView)[0].type, ReportView)
      }
      const outcome = nodes(view, node => node.type === RunOutcome)[0]
      const result = h.render(RunOutcome, outcome.props)
      const card = nodes(result, node => node.type === CompletionCard)[0]
      const outcomeView = card ? h.render(CompletionCard, card.props) : result
      const pr = nodes(outcomeView, node => node.type === "a" && node.props.href === "https://github.com/owner/repo/pull/7")
      assert.equal(pr.length, scenario === "fix" ? 1 : 0)
      assert.equal(nodes(view, node => node.type === "a" && node.props.href?.startsWith("javascript:")).length, 0)
      const resume = nodes(outcomeView, node => node.type === ResumeBar)
      assert.equal(resume.length, scenario === "stopped" ? 1 : 0)
      if (resume.length) {
        assert.equal(resume[0].props.runId, "run/id")
        assert.equal(resume[0].props.onResumed, onResumed)
        assert.match(text(outcomeView), /provider quota/)
      }
      if (scenario === "resumed") assert.match(text(outcomeView), /resumed/)
      nodes(view, node => node.type === "a" && node.props.href === "/history")[0].props.onClick({ preventDefault() { prevented = true } })
      assert.equal(backs, 1)
      assert.equal(prevented, true)
    } finally {
      h.cleanup()
      globalThis.fetch = originalFetch
    }
  })
}

test("run metadata errors show a load error and keep the History action", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch
  const h = harness()
  let backs = 0
  const props = { runId: "missing", onBack() { backs++ }, onResumed() {} }
  try {
    h.render(RunDetailPage, props)
    await h.flush()
    const view = h.render(RunDetailPage, props)
    assert.match(text(nodes(view, node => node.props.role === "alert")[0]), /metadata HTTP 503/)
    nodes(view, node => node.type === "a")[0].props.onClick({ preventDefault() {} })
    assert.equal(backs, 1)
  } finally {
    h.cleanup()
    globalThis.fetch = originalFetch
  }
})

test("findings list new before tracked, then by severity, and search limits what posts", () => {
  const findings = [
    { id: "t", category: "sqli", severity: "P0" as const, file: "app/t.ts", line: 1, subsystem: "app" },
    { id: "n2", category: "cors", severity: "P2" as const, file: "lib/n2.ts", line: 2, subsystem: "lib" },
    { id: "n1", category: "sqli", severity: "P1" as const, file: "app/n1.ts", line: 3, subsystem: "app" },
  ]
  const initialCheck = { repo: "owner/repo", matches: { t: { kind: "tracked" as const, url: "https://github.com/owner/tracker/blob/main/sqli.json", file: "app/t.ts", line: 1, status: "open" } } }
  const h = harness()
  const props = { findings, initialCheck, runId: "r", canPost: true, onPosted() {} }
  try {
    let view = h.render(FindingsPanel, props)
    const order = () => checkboxes(view).map(node => node.props["aria-label"])
    assert.deepEqual(order(), ["SQLi (§1.1) app/n1.ts:3", "CORS reflection (§1.10) lib/n2.ts:2", "SQLi (§1.1) app/t.ts:1"])
    nodes(view, node => is(node, "input") && node.props.type === "search")[0].props.onChange({ target: { value: "APP/" } })
    view = h.render(FindingsPanel, props)
    assert.deepEqual(order(), ["SQLi (§1.1) app/n1.ts:3", "SQLi (§1.1) app/t.ts:1"])
    assert(button(view, "Post 1 to GitHub"))
  } finally {
    h.cleanup()
  }
})


test("scan finding search matches file and reason and clears", () => {
  const h = harness()
  const props = { findings, initialCheck, runId: "r", canPost: false, onPosted() {} }
  try {
    let view = h.render(FindingsPanel, props)
    const search = (value: string) => { nodes(view, node => is(node, "input") && node.props.type === "search")[0].props.onChange({ target: { value } }); view = h.render(FindingsPanel, props) }
    const locations = () => nodes(view, node => node.type === "code").map(text)
    assert.equal(locations().length, 3)
    search("CORS.TS")
    assert.deepEqual(locations(), ["cors.ts:2"])
    search("cors.ts:2")
    assert.deepEqual(locations(), ["cors.ts:2"])
    search("UNCHECKED INPUT")
    assert.deepEqual(locations(), ["query.ts:1"])
    search("")
    assert.equal(locations().length, 3)
  } finally { h.cleanup() }
})
