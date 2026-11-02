import { test } from "bun:test"
import assert from "node:assert/strict"
import { PROVIDERS } from "../src/types/events"
import { PickPage } from "../src/pages/PickPage"
import { TrackerSelect } from "../src/components/TrackerSelect"
import { ProviderSelect } from "../src/components/ProviderSelect"
import { Checkbox } from "../src/components/ui/checkbox"
import { Collapsible } from "../src/components/ui/collapsible"
import { browser, harness, nodes, text, is } from "./render"

const providers = { claude: { available: true }, codex: { available: true } }
const row = (id: string) => ({ id, category: "sqli", subsystem: "app", severity: "P1", file: `${id}.php`, lines: [1], status: "open", reason: "Check" })
const pick = (rows = [row("one")]) => ({
  repoUrl: "https://github.com/owner/repo", rows, suggestedIds: rows.slice(0, 50).map(row => row.id),
  hidden: [{ ...row("hidden"), blockedBy: [7, 8] }],
  limits: { maxFilesPerBatch: 10 },
})
const props = { sessionId: "fixture", activeRuns: [], onStarted() {} }
const fixButton = (view: React.ReactNode) => nodes(nodes(view, node => node.type === "footer")[0], node => is(node, "button")).at(-1)!
const check = (view: React.ReactNode, id = "one") => nodes(view, node => node.type === Checkbox && [`Pick ${id}`, `选择 ${id}`].includes(node.props["aria-label"]))[0].props.onCheckedChange(true)
const ignorePR = (view: React.ReactNode, number: number) => nodes(view, node => is(node, "label") && text(node) === `Ignore this PR #${number}`)[0].props.children[0]

for (const action of ["ignore", "needs-human"] as const) for (const streaming of [false, true]) {
  const selectLabel = action === "ignore" ? "Ignore selected" : "Needs human"
  const confirmLabel = action === "ignore" ? "Ignore" : "Needs human"
  test(`Pick removes ${action} rows and clears selection after ${streaming ? "SSE" : "JSON"} loading`, async () => {
    const b = browser()
    const originalFetch = globalThis.fetch
    const requests: { url: string, init: RequestInit }[] = []
    globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
      const url = String(input)
      if (url === "/api/health") return Response.json({ dev: false })
      requests.push({ url, init })
      if (url === "/api/providers") return Response.json(providers)
      if (url === `/api/pick/${action}`) return Response.json({ changed: 2 })
      assert.equal(init.method, undefined)
      assert.match(url, /^\/api\/pick\?/)
      return streaming
        ? new Response(`data: ${JSON.stringify({ ...pick(), type: "done" })}\n\n`, { headers: { "Content-Type": "text/event-stream" } })
        : Response.json(pick())
    }) as typeof fetch
    const h = harness()
    try {
      h.render(PickPage, props)
      await h.flush()
      let view = h.render(PickPage, props)
      ignorePR(view, 7).props.onCheckedChange()
      view = h.render(PickPage, props)
      ignorePR(view, 8).props.onCheckedChange()
      view = h.render(PickPage, props)
      check(view)
      view = h.render(PickPage, props)
      nodes(view, node => node.props["aria-label"] === "Pick hidden")[0].props.onCheckedChange(true)
      view = h.render(PickPage, props)
      assert.equal(text(fixButton(view)), "Fix selected (2)")
      assert.equal(fixButton(view).props.disabled, false)
      nodes(view, node => is(node, "button") && text(node) === `${selectLabel} (2)`)[0].props.onClick()
      view = h.render(PickPage, props)
      const dialog = nodes(view, node => typeof node.type === "function" && node.type.name === "RowChangeDialog")[0]
      const component = dialog.type as React.FunctionComponent<any>
      assert.equal(requests.filter(request => request.init.method === "POST").length, 0)
      let content = h.render(component, dialog.props)
      const confirm = () => nodes(content, node => is(node, "button") && text(node) === confirmLabel)[0]
      assert.equal(confirm().props.disabled, true)
      confirm().props.onClick()
      assert.equal(requests.filter(request => request.init.method === "POST").length, 0)
      assert.equal(nodes(content, node => is(node, "textarea"))[0].props.maxLength, 500)
      nodes(content, node => is(node, "textarea"))[0].props.onChange({ target: { value: "Accepted risk" } })
      content = h.render(component, dialog.props)
      assert.equal(confirm().props.disabled, false)
      confirm().props.onClick()
      await h.flush()
      const changed = requests.filter(request => request.url === `/api/pick/${action}`)
      assert.equal(changed.length, 1)
      assert.equal(changed[0].init.method, "POST")
      assert.deepEqual(JSON.parse(changed[0].init.body as string), { repo: "owner/repo", ids: ["one", "hidden"], reason: "Accepted risk" })
      view = h.render(PickPage, props)
      assert.equal(nodes(view, node => /^Pick (one|hidden)$/.test(node.props["aria-label"] ?? "")).length, 0)
      assert.equal(text(fixButton(view)), "Fix selected (0)")
      assert.equal(fixButton(view).props.disabled, true)
      ignorePR(view, 7).props.onCheckedChange()
      view = h.render(PickPage, props)
      ignorePR(view, 7).props.onCheckedChange()
      view = h.render(PickPage, props)
      assert.equal(nodes(view, node => /^Pick (one|hidden)$/.test(node.props["aria-label"] ?? "")).length, 0)
      assert.equal(requests.filter(request => request.url.startsWith("/api/pick?")).length, 1)
    } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
  })
}

test("hidden PR groups show three rows and expand while the whole section stays closed", async () => {
  const b = browser()
  const originalFetch = globalThis.fetch
  const hidden = Array.from({ length: 55 }, (_, i) => ({ ...row(`secret${i}`), blockedBy: [1252, 1253] }))
  globalThis.fetch = (async (input: any) => Response.json(String(input) === "/api/providers" ? providers : { ...pick(), hidden })) as typeof fetch
  const h = harness()
  try {
    h.render(PickPage, props)
    await h.flush()
    const view = h.render(PickPage, props)
    const section = nodes(view, node => node.type === Collapsible && /55 hidden/.test(text(node)))[0]
    assert.equal(section.props.open, undefined)
    const groups = nodes(section, node => typeof node.type === "function" && node.type.name === "HiddenPRRows")
    assert.equal(groups.length, 2)
    const component = groups[0].type as React.FunctionComponent<any>
    let group = h.render(component, groups[0].props)
    assert.equal(nodes(group, node => node.type === "li").length, 3)
    assert.match(text(group), /\+52 more/)
    nodes(group, node => is(node, "button"))[0].props.onClick()
    group = h.render(component, groups[0].props)
    assert.equal(nodes(group, node => node.type === "li").length, 55)
    assert.equal(nodes(h.render(PickPage, props), node => node.type === Collapsible && node.props.open === true).length, 0)
    nodes(group, node => is(node, "button"))[0].props.onClick()
    assert.equal(nodes(h.render(component, groups[0].props), node => node.type === "li").length, 3)
  } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
})

for (const item of [
  { name: "cap long line lists at eight", severity: "P1", lines: Array.from({ length: 68 }, (_, i) => i + 1), expected: /hidden.php:1,2,3,4,5,6,7,8 \+60 more/, absent: /8,9/ },
  { name: "use a dash for empty severity", severity: "", lines: [1], expected: / · – · hidden.php:1/, absent: /· ·/ },
]) {
  test(`hidden rows ${item.name}`, async () => {
    const b = browser()
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: any) => Response.json(String(input) === "/api/providers" ? providers
      : { ...pick(), hidden: [{ ...row("hidden"), severity: item.severity, lines: item.lines, blockedBy: [7] }] })) as typeof fetch
    const h = harness()
    try {
      h.render(PickPage, props)
      await h.flush()
      const view = h.render(PickPage, props)
      const group = nodes(view, node => typeof node.type === "function" && node.type.name === "HiddenPRRows")[0]
      const content = h.render(group.type as React.FunctionComponent<any>, group.props)
      assert.match(text(content), item.expected)
      assert.doesNotMatch(text(content), item.absent)
    } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
  })
}

test("Pick retains init candidates and applies overlapping PR toggles locally", async () => {
  const b = browser("/pick?repo=owner/repo", { "secpatch.ignorePRs:owner/repo": "[8]" })
  const originalFetch = globalThis.fetch
  let requests = 0
  const hidden = { id: "hidden", category: "sqli", file: "hidden.php", lines: [1], severity: "P1", blockedBy: [7, 8] }
  globalThis.fetch = (async (input: any) => {
    if (String(input) === "/api/health") return Response.json({ dev: false })
    if (String(input) === "/api/providers") return Response.json(providers)
    if (String(input) === "/api/relay/models") return Response.json({ configured: false, models: [] })
    requests++
    const init = { ...pick([row("one"), row("hidden")]), hidden: [], type: "init" }
    const done = { ...pick(), hidden: [hidden], type: "done" }
    return new Response([init, done].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } })
  }) as typeof fetch
  const h = harness()
  try {
    h.render(PickPage, props)
    await h.flush()
    let view = h.render(PickPage, props)
    assert.equal(nodes(view, node => node.props["aria-label"] === "Pick hidden").length, 0)
    ignorePR(view, 7).props.onCheckedChange()
    view = h.render(PickPage, props)
    await h.flush()
    assert.match(text(view), /0 hidden/)
    check(view)
    view = h.render(PickPage, props)
    nodes(view, node => node.props["aria-label"] === "Pick hidden")[0].props.onCheckedChange(true)
    view = h.render(PickPage, props)
    ignorePR(view, 8).props.onCheckedChange()
    view = h.render(PickPage, props)
    assert.match(text(view), /1 hidden/)
    assert.equal(nodes(view, node => node.props["aria-label"] === "Pick hidden").length, 0)
    assert.equal(text(fixButton(view)), "Fix selected (1)")
    assert.equal(fixButton(view).props.disabled, false)
    assert.equal(requests, 1)
  } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
})

for (const streaming of [false, true]) {
  test(`Pick consumes ${streaming ? "SSE" : "JSON"} hidden rows and limits, remembers PR overrides and confirms them`, async () => {
    const b = browser("/pick?repo=owner/repo", { "secpatch.ignorePRs:owner/repo": "[8]" })
    const originalFetch = globalThis.fetch
    const requests: string[] = []
    let posted: any
    globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
      const url = String(input)
      if (url === "/api/health") return Response.json({ dev: false })
      if (url === "/api/providers") return Response.json(providers)
      if (url === "/api/relay/models") return Response.json({ configured: false, models: [] })
      if (init.method === "POST") { posted = JSON.parse(init.body as string); return Response.json({ runId: "new" }) }
      requests.push(url)
      const data = pick()
      return streaming ? new Response(["progress", "done"].map(type => `data: ${JSON.stringify({ ...data, type, checkedPRs: 2, totalPRs: 2 })}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } }) : Response.json(data)
    }) as typeof fetch
    const h = harness()
    try {
      h.render(PickPage, props)
      await h.flush()
      let view = h.render(PickPage, props)
      assert.deepEqual(new URL(requests[0], "http://fixture").searchParams.getAll("ignorePR"), [])
      assert.match(text(view), /1 hidden/)
      assert.equal(nodes(view, node => node.type === "a" && node.props.href === "https://github.com/owner/repo/pull/7").length, 1)
      assert.match(text(view), /At most 10 files per batch/)
      ignorePR(view, 7).props.onCheckedChange()
      await h.flush()
      view = h.render(PickPage, props)
      assert.equal(requests.length, 1)
      assert.match(text(view), /0 hidden/)
      assert.doesNotMatch(text(view), /Still checking open PRs/)
      assert.equal(b.storage.get("secpatch.ignorePRs:owner/repo"), "[8,7]")
      assert.equal(fixButton(view).props.disabled, true)
      check(view)
      view = h.render(PickPage, props)
      assert.equal(fixButton(view).props.disabled, false)
      assert.equal(nodes(view, node => is(node, "select") && node.props.children?.some?.((option: any) => option?.props?.value === "zh")).length, 0)
      await fixButton(view).props.onClick()
      await h.flush()
      assert.equal(posted.language, "en")
      assert.deepEqual(posted.ignorePRs, [8, 7])
      assert.deepEqual(posted.pickedIds, ["one"])
      ignorePR(view, 7).props.onCheckedChange()
      view = h.render(PickPage, props)
      assert.match(text(view), /1 hidden/)
      assert.equal(nodes(view, node => node.props["aria-label"] === "Pick hidden").length, 0)
      assert.equal(requests.length, 1)
      const changeRepo = nodes(view, node => node.type === TrackerSelect)[0].props.onChange
      changeRepo("other/repo")
      h.render(PickPage, props)
      await h.flush()
      assert.deepEqual(new URL(requests.at(-1)!, "http://fixture").searchParams.getAll("ignorePR"), [])
    } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
  })
}

test("Pick starts with nothing selected even when the server suggests findings", async () => {
  const b = browser()
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: any) => Response.json(String(input) === "/api/providers" ? providers : pick([row("one"), row("two")]))) as typeof fetch
  const h = harness()
  try {
    h.render(PickPage, props)
    await h.flush()
    const view = h.render(PickPage, props)
    assert.equal(text(fixButton(view)), "Fix selected (0)")
    assert.equal(fixButton(view).props.disabled, true)
    assert.deepEqual(nodes(view, node => node.type === Checkbox && /^Pick (one|two)$/.test(node.props["aria-label"] ?? "")).map(node => node.props.checked), [false, false])
  } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
})

test("Pick shows all-hidden explanation and excludes needs-human candidates", async () => {
  const b = browser()
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: any) => Response.json(String(input) === "/api/providers" ? providers : pick([{ ...row("human"), status: "needs human" }]))) as typeof fetch
  const h = harness()
  try {
    h.render(PickPage, props)
    await h.flush()
    const view = h.render(PickPage, props)
    assert.match(text(view), /All findings are hidden/)
    assert.doesNotMatch(text(view), /No findings match/)
    assert.equal(fixButton(view).props.disabled, true)
    assert.equal(nodes(view, node => node.type === Checkbox && node.props["aria-label"] === "Pick human").length, 0)
  } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
})

test("Pick displays the server file limit", async () => {
  const b = browser()
  const originalFetch = globalThis.fetch
  const data = { ...pick(), limits: { maxFilesPerBatch: 3 } }
  globalThis.fetch = (async (input: any) => Response.json(String(input) === "/api/providers" ? providers : data)) as typeof fetch
  const h = harness()
  try {
    h.render(PickPage, props)
    await h.flush()
    const view = h.render(PickPage, props)
    assert.match(text(view), /At most 3 files per batch/)
  } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
})

for (const streaming of [false, true]) {
  test(`Pick allows Fix without limits from an older ${streaming ? "SSE" : "JSON"} backend`, async () => {
    const b = browser()
    const originalFetch = globalThis.fetch
    const { limits, ...data } = pick()
    let posted: any
    globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
      if (String(input) === "/api/health") return Response.json({ dev: false })
      if (String(input) === "/api/providers") return Response.json(providers)
      if (String(input) === "/api/relay/models") return Response.json({ configured: false, models: [] })
      if (init.method === "POST") { posted = JSON.parse(init.body as string); return Response.json({ runId: "new" }) }
      return streaming
        ? new Response(`data: ${JSON.stringify({ ...data, type: "done" })}\n\n`, { headers: { "Content-Type": "text/event-stream" } })
        : Response.json(data)
    }) as typeof fetch
    const h = harness()
    try {
      h.render(PickPage, props)
      await h.flush()
      check(h.render(PickPage, props))
      const view = h.render(PickPage, props)
      assert.equal(fixButton(view).props.disabled, false)
      assert.doesNotMatch(text(view), /Open suite PRs|At most .* files per batch/)
      await fixButton(view).props.onClick()
      await h.flush()
      assert.deepEqual(posted.pickedIds, ["one"])
    } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
  })
}

test("Pick groups can select more than 50 findings", async () => {
  const b = browser()
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: any) => Response.json(String(input) === "/api/providers" ? providers : pick(Array.from({ length: 51 }, (_, i) => row(String(i)))))) as typeof fetch
  const h = harness()
  try {
    h.render(PickPage, props)
    await h.flush()
    let view = h.render(PickPage, props)
    const group = () => nodes(view, node => node.type === Checkbox && node.props["aria-label"]?.startsWith("Pick all"))[0]
    assert.match(group().props["aria-label"], /SQLi \(§1.1\)/)
    assert.equal(group().props.checked, false)
    assert.equal(nodes(view, node => node.type === Checkbox && /^Pick \d/.test(node.props["aria-label"] ?? "")).length, 51)
    group().props.onCheckedChange()
    view = h.render(PickPage, props)
    assert.equal(group().props.checked, true)
    assert.equal(fixButton(view).props.disabled, false)
    assert.match(text(fixButton(view)), /51/)
  } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
})

test("Pick announces the steps expander state and keeps its button after toggling", async () => {
  const b = browser()
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: any) => Response.json(String(input) === "/api/providers" ? providers : pick())) as typeof fetch
  const h = harness()
  try {
    h.render(PickPage, props)
    await h.flush()
    let view = h.render(PickPage, props)
    const button = nodes(view, node => is(node, "button") && text(node).includes("Show steps"))[0]
    assert.equal(button.props["aria-expanded"], false)
    button.props.onClick()
    view = h.render(PickPage, props)
    const expanded = nodes(view, node => is(node, "button") && text(node).includes("Hide steps"))[0]
    assert.equal(expanded.props["aria-expanded"], true)
    expanded.props.onClick()
    assert.equal(nodes(h.render(PickPage, props), node => is(node, "button") && text(node).includes("Show steps"))[0].props["aria-expanded"], false)
  } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
})

test("Pick reports HTML errors without a JSON parse error or a contradictory empty state", async () => {
  const b = browser()
  const originalFetch = globalThis.fetch
  let failPost = false
  let failGet = false
  globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
    if (String(input) === "/api/health") return Response.json({ dev: false })
    if (String(input) === "/api/providers") return Response.json(providers)
    if (String(input) === "/api/relay/models") return Response.json({ configured: false, models: [] })
    if (init.method === "POST" && failPost || failGet) return new Response("<html>Bad gateway</html>", { status: 502 })
    return Response.json(pick())
  }) as typeof fetch
  const h = harness()
  try {
    h.render(PickPage, props)
    await h.flush()
    check(h.render(PickPage, props))
    failPost = true
    await fixButton(h.render(PickPage, props)).props.onClick()
    await h.flush()
    assert.match(text(h.render(PickPage, props)), /HTTP 502/)
    assert.equal(fixButton(h.render(PickPage, props)).props.disabled, false)
    assert.equal(nodes(h.render(PickPage, props), node => is(node, "button") && text(node) === "Retry").length, 0)
    failGet = true
    nodes(h.render(PickPage, props), node => is(node, "button") && text(node) === "Refresh")[0].props.onClick()
    await h.flush()
    const view = h.render(PickPage, props)
    assert.match(text(view), /HTTP 502/)
    assert.doesNotMatch(text(view), /JSON Parse|No findings match/)
    assert.equal(nodes(view, node => is(node, "table")).length, 1)
    assert.match(text(view), /one.php:1/)
    assert.equal(nodes(view, node => node.props["aria-label"] === "Pick one")[0].props.checked, true)
    assert.equal(fixButton(view).props.disabled, true)
    failGet = false
    nodes(view, node => is(node, "button") && text(node) === "Retry")[0].props.onClick()
    await h.flush()
    const recovered = h.render(PickPage, props)
    assert.doesNotMatch(text(recovered), /HTTP 502/)
    assert.match(text(recovered), /one.php:1/)
    assert.equal(fixButton(recovered).props.disabled, false)
  } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
})

test("Pick clears old repository data and ignores an old response after a repo switch", async () => {
  const b = browser()
  const originalFetch = globalThis.fetch
  let resolveOld: (value: Response) => void = () => {}
  let count = 0
  globalThis.fetch = (async (input: any) => {
    if (String(input) === "/api/health") return Response.json({ dev: false })
    if (String(input) === "/api/providers") return Response.json(providers)
    if (String(input) === "/api/relay/models") return Response.json({ configured: false, models: [] })
    count++
    if (count === 1) return Response.json(pick())
    return new Promise<Response>(resolve => { if (count === 2) resolveOld = resolve })
  }) as typeof fetch
  const h = harness()
  try {
    h.render(PickPage, props)
    await h.flush()
    let view = h.render(PickPage, props)
    nodes(view, node => is(node, "button") && text(node) === "Refresh")[0].props.onClick()
    nodes(view, node => node.type === TrackerSelect)[0].props.onChange("other/repo")
    h.render(PickPage, props)
    await h.flush()
    resolveOld(Response.json(pick()))
    await h.flush()
    view = h.render(PickPage, props)
    assert.doesNotMatch(text(view), /1 hidden|Open suite PRs/)
    assert.equal(fixButton(view).props.disabled, true)
  } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
})

test("Pick tolerates unavailable storage and localizes the note counter", async () => {
  const b = browser("/pick?repo=owner/repo", { ola_lang: "zh" })
  const h = harness()
  const originalFetch = globalThis.fetch
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("Storage blocked") } })
  globalThis.fetch = (async (input: any) => Response.json(String(input) === "/api/providers" ? providers : pick())) as typeof fetch
  try {
    h.render(PickPage, props)
    await h.flush()
    check(h.render(PickPage, props))
    const view = h.render(PickPage, props)
    assert.match(text(nodes(view, node => node.props.id === "pick-note-count")[0]), /0\/1,000 字符/)
    const toggle = nodes(view, node => is(node, "label") && text(node).includes("#7"))[0].props.children[0]
    assert.doesNotThrow(() => toggle.props.onCheckedChange())
    await h.flush()
    assert.equal(fixButton(h.render(PickPage, props)).props.disabled, false)
  } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
})

for (const stopped of [false, true]) {
  test(`Pick blocks Fix after PR checks ${stopped ? "are stopped" : "end without done"}`, async () => {
    const b = browser()
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async (input: any) => {
      if (String(input) === "/api/health") return Response.json({ dev: false })
      if (String(input) === "/api/providers") return Response.json(providers)
      if (String(input) === "/api/relay/models") return Response.json({ configured: false, models: [] })
      if (++calls === 1) return Response.json(pick())
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...pick(), type: "init" })}\n\n`))
        if (!stopped) controller.close()
      } }), { headers: { "Content-Type": "text/event-stream" } })
    }) as typeof fetch
    const h = harness()
    try {
      h.render(PickPage, props)
      await h.flush()
      check(h.render(PickPage, props))
      let view = h.render(PickPage, props)
      assert.equal(fixButton(view).props.disabled, false)
      nodes(view, node => is(node, "button") && text(node) === "Refresh")[0].props.onClick()
      await h.flush()
      view = h.render(PickPage, props)
      if (stopped) {
        nodes(view, node => is(node, "button") && text(node) === "Stop")[0].props.onClick()
        view = h.render(PickPage, props)
      }
      assert.match(text(view), /PR checks did not finish/)
      assert.equal(fixButton(view).props.disabled, true)
    } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
  })
}

for (const relayOnly of [false, true]) test(`Pick uses gateway models for relay fixes and reviews (relay only: ${relayOnly})`, async () => {
  const b = browser()
  const originalFetch = globalThis.fetch
  let posted: any
  globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
    const url = String(input)
    if (url === "/api/health") return Response.json({ dev: false })
    if (url === "/api/providers") return Response.json({ claude: { available: false }, codex: { available: !relayOnly }, antigravity: { available: false } })
    if (url === "/api/relay/models") return Response.json({ configured: true, models: ["gw-one", "gw-two"] })
    if (init.method === "POST") { posted = JSON.parse(init.body as string); return Response.json({ runId: "new" }) }
    return Response.json(pick())
  }) as typeof fetch
  const h = harness()
  try {
    h.render(PickPage, props)
    await h.flush()
    let view = h.render(PickPage, props)
    const runPicker = () => nodes(view, node => node.type === ProviderSelect && node.props.fix)[0]
    assert.deepEqual(runPicker().props.litellm, { disabled: false, error: undefined })
    runPicker().props.onChange("litellm")
    view = h.render(PickPage, props)
    assert.equal(runPicker().props.value, "litellm")
    assert.equal(nodes(view, node => node.type === ProviderSelect && node.props.review)[0].props.authMode, "relay")
    await h.flush()
    view = h.render(PickPage, props)
    const reviewPicker = () => nodes(view, node => node.type === ProviderSelect && node.props.review)[0]
    const reviewSelect = () => nodes(view, node => is(node, "select"))[2]
    assert.equal(reviewPicker().props.value, relayOnly ? "claude" : "codex")
    assert.equal(reviewSelect().props.value, relayOnly ? "gw-one" : PROVIDERS.codex.defaultModel)
    reviewPicker().props.onChange("claude")
    view = h.render(PickPage, props)
    assert.equal(reviewSelect().props.value, "gw-one")
    assert.deepEqual(nodes(reviewSelect(), node => node.type === "option").map(node => node.props.value), ["gw-one", "gw-two"])
    const modelSelect = nodes(view, node => is(node, "select") && node.props.value === "gw-one")[0]
    assert.deepEqual(nodes(modelSelect, node => node.type === "option").map(node => node.props.value), ["gw-one", "gw-two"])
    modelSelect.props.onChange({ target: { value: "gw-two" } })
    view = h.render(PickPage, props)
    check(view)
    view = h.render(PickPage, props)
    await fixButton(view).props.onClick()
    await h.flush()
    assert.equal(posted.authMode, "relay")
    assert.equal(posted.model, "gw-two")
    assert.equal(posted.reviewProvider, "claude")
    assert.equal(posted.reviewModel, "gw-one")
    reviewSelect().props.onChange({ target: { value: "gw-two" } })
    view = h.render(PickPage, props)
    check(view)
    view = h.render(PickPage, props)
    await fixButton(view).props.onClick()
    assert.equal(posted.reviewModel, "gw-two")
    runPicker().props.onChange("claude")
    view = h.render(PickPage, props)
    assert(nodes(view, node => is(node, "select") && node.props.value === "opus").length)
  } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
})


test("Pick preserves selected findings across searches", async () => {
  const b = browser()
  const originalFetch = globalThis.fetch
  const rows = [{ ...row("one"), file: "src/Alpha.php", reason: "Untrusted input" }, { ...row("two"), reason: "Bind parameters" }]
  globalThis.fetch = (async (input: any) => Response.json(String(input) === "/api/providers" ? providers : pick(rows))) as typeof fetch
  const h = harness()
  try {
    h.render(PickPage, props)
    await h.flush()
    let view = h.render(PickPage, props)
    const search = (value: string) => { nodes(view, node => is(node, "input") && node.props.type === "search")[0].props.onChange({ target: { value } }); view = h.render(PickPage, props) }
    const picks = () => nodes(view, node => node.type === Checkbox && /^Pick (one|two)$/.test(node.props["aria-label"] ?? ""))
    assert.equal(picks().length, 2)
    nodes(view, node => node.type === Checkbox && node.props["aria-label"] === "Pick one")[0].props.onCheckedChange(false)
    view = h.render(PickPage, props)
    nodes(view, node => node.type === Checkbox && node.props["aria-label"] === "Pick two")[0].props.onCheckedChange(false)
    view = h.render(PickPage, props)
    search("ALPHA.PHP")
    assert.deepEqual(picks().map(node => node.props["aria-label"]), ["Pick one"])
    picks()[0].props.onCheckedChange(true)
    view = h.render(PickPage, props)
    search("BIND PARAMETERS")
    assert.deepEqual(picks().map(node => node.props["aria-label"]), ["Pick two"])
    assert.equal(text(fixButton(view)), "Fix selected (1)")
    picks()[0].props.onCheckedChange(true)
    view = h.render(PickPage, props)
    assert.equal(text(fixButton(view)), "Fix selected (2)")
    search("")
    assert.deepEqual(picks().map(node => node.props.checked), [true, true])
  } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
})

test("Pick sends the OpenAI key channel for Codex fixes and keeps the Codex review on its login", async () => {
  const b = browser()
  const originalFetch = globalThis.fetch
  let posted: any
  globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
    if (String(input) === "/api/health") return Response.json({ dev: false })
    if (String(input) === "/api/providers") return Response.json({ claude: { available: true }, codex: { available: true, auth: "subscription", apiKey: true } })
    if (init.method === "POST") { posted = JSON.parse(init.body as string); return Response.json({ runId: "new" }) }
    return Response.json(pick())
  }) as typeof fetch
  const h = harness()
  try {
    h.render(PickPage, props)
    await h.flush()
    let view = h.render(PickPage, props)
    nodes(view, node => node.type === ProviderSelect && node.props.fix)[0].props.onChange("codex-api-key")
    nodes(view, node => node.type === ProviderSelect && node.props.review)[0].props.onChange("codex")
    view = h.render(PickPage, props)
    assert.equal(nodes(view, node => node.type === ProviderSelect && node.props.fix)[0].props.value, "codex-api-key")
    assert(nodes(view, node => is(node, "select") && node.props.value === "gpt-6.1-sol").length)
    check(view)
    view = h.render(PickPage, props)
    await fixButton(view).props.onClick()
    await h.flush()
    assert.equal(posted.provider, "codex")
    assert.equal(posted.reviewProvider, "codex")
    assert.equal(posted.model, "gpt-6.1-sol")
    assert.equal(posted.authMode, "api-key")
  } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
})

test("Pick selects native Codex fixes with its model and oauth channel", async () => {
  const b = browser()
  const originalFetch = globalThis.fetch
  let posted: any
  globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
    if (String(input) === "/api/health") return Response.json({ dev: false })
    if (String(input) === "/api/providers") return Response.json({ ...providers, claude: { available: true, apiKey: true } })
    if (init.method === "POST") { posted = JSON.parse(init.body as string); return Response.json({ runId: "new" }) }
    return Response.json(pick())
  }) as typeof fetch
  const h = harness()
  try {
    h.render(PickPage, props)
    await h.flush()
    let view = h.render(PickPage, props)
    nodes(view, node => node.type === ProviderSelect && node.props.fix)[0].props.onChange("codex")
    view = h.render(PickPage, props)
    assert.equal(nodes(view, node => node.type === ProviderSelect && node.props.fix)[0].props.value, "codex")
    assert(nodes(view, node => is(node, "select") && node.props.value === "gpt-6.1-sol").length)
    check(view)
    view = h.render(PickPage, props)
    await fixButton(view).props.onClick()
    await h.flush()
    assert.equal(posted.provider, "codex")
    assert.equal(posted.model, "gpt-6.1-sol")
    assert.equal(posted.effort, "medium")
    assert.equal(posted.authMode, undefined)
  } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
})

for (const available of [
  { claude: { available: true }, codex: { available: true }, antigravity: { available: true } },
  { claude: { available: true }, codex: { available: false }, antigravity: { available: true } },
  { claude: { available: true }, codex: { available: false }, antigravity: { available: false } },
]) test(`Pick defaults reviewer to the first available alternative: ${JSON.stringify(available)}`, async () => {
  const b = browser()
  const original = globalThis.fetch
  let posted: any
  globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
    if (String(input) === "/api/health") return Response.json({ dev: false })
    if (String(input) === "/api/providers") return Response.json(available)
    if (init.method === "POST") { posted = JSON.parse(String(init.body)); return Response.json({ runId: "new" }) }
    return Response.json(pick())
  }) as typeof fetch
  const h = harness()
  const render = () => h.render(PickPage, props)
  try {
    render(); await h.flush(); render(); await h.flush()
    let view = render()
    const expected = available.codex.available ? "codex" : available.antigravity.available ? "antigravity" : "claude"
    assert.equal(nodes(view, node => node.type === ProviderSelect && node.props.review)[0].props.value, expected)
    check(view)
    view = h.render(PickPage, props)
    await fixButton(view).props.onClick()
    assert.equal(posted.reviewProvider, expected)
    assert.equal(posted.reviewModel, PROVIDERS[expected].defaultModel)
    assert.equal(posted.reviewEffort, PROVIDERS[expected].defaultEffort)
    for (const provider of ["claude", "codex", "antigravity"] as const) {
      nodes(view, node => node.type === ProviderSelect && node.props.review)[0].props.onChange(provider)
      view = render()
      const selects = nodes(view, node => is(node, "select"))
      assert.equal(selects[2].props.value, PROVIDERS[provider].defaultModel)
      assert.deepEqual(nodes(selects[2], node => node.type === "option").map(node => node.props.value), PROVIDERS[provider].models.map(model => model.value))
      assert.equal(selects[3].props.value, PROVIDERS[provider].defaultEffort)
      assert.deepEqual(nodes(selects[3], node => node.type === "option").map(node => node.props.value), PROVIDERS[provider].efforts)
    }
    nodes(view, node => node.type === ProviderSelect && node.props.fix)[0].props.onChange("codex")
    render(); await h.flush(); view = render()
    assert.equal(nodes(view, node => node.type === ProviderSelect && node.props.review)[0].props.value, "claude")
  } finally { h.cleanup(); globalThis.fetch = original; b.cleanup() }
})

test("Pick hides effort for Qoder fixers and reviewers and omits it from the request", async () => {
  const b = browser()
  const original = globalThis.fetch
  let posted: any
  globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
    if (String(input) === "/api/health") return Response.json({ dev: false })
    if (String(input) === "/api/providers") return Response.json({ ...providers, qoder: { available: true } })
    if (init.method === "POST") { posted = JSON.parse(String(init.body)); return Response.json({ runId: "new" }) }
    return Response.json(pick())
  }) as typeof fetch
  const h = harness()
  const render = () => h.render(PickPage, props)
  const efforts = (view: React.ReactNode) => nodes(view, node => is(node, "select") && PROVIDERS.claude.efforts.includes(node.props.value)).length
  try {
    render(); await h.flush(); render(); await h.flush()
    let view = render()
    assert.equal(efforts(view), 2)
    nodes(view, node => node.type === ProviderSelect && node.props.review)[0].props.onChange("qoder")
    view = render()
    assert.equal(efforts(view), 1)
    check(view)
    view = h.render(PickPage, props)
    await fixButton(view).props.onClick()
    assert.equal(posted.reviewProvider, "qoder")
    assert.equal(posted.reviewModel, "Qwen3.8-Flash")
    assert.equal("reviewEffort" in posted, false)
    assert.equal(posted.effort, "high")
    nodes(view, node => node.type === ProviderSelect && node.props.fix)[0].props.onChange("qoder")
    render(); await h.flush(); view = render()
    nodes(view, node => node.type === ProviderSelect && node.props.review)[0].props.onChange("codex")
    view = render()
    assert.equal(efforts(view), 1)
    check(view)
    view = h.render(PickPage, props)
    await fixButton(view).props.onClick()
    assert.equal(posted.provider, "qoder")
    assert.equal("effort" in posted, false)
    assert.equal(posted.reviewEffort, PROVIDERS.codex.defaultEffort)
  } finally { h.cleanup(); globalThis.fetch = original; b.cleanup() }
})
