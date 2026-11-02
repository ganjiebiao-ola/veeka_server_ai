import { ActiveRunBanner } from "../src/components/ActiveRunBanner"
import { ImpactView } from "../src/components/lazy"
import { RepoSettings } from "../src/components/RepoSettings"
import { test } from "bun:test"
import assert from "node:assert/strict"
import React from "react"
import { HistoryPage } from "../src/pages/HistoryPage"
import { LandingPage } from "../src/pages/LandingPage"
import { PickPage } from "../src/pages/PickPage"
import { OverviewPage } from "../src/pages/OverviewPage"
import { useI18n } from "../src/i18n"
import { ProviderSelect } from "../src/components/ProviderSelect"
import { KeySettings } from "../src/components/KeySettings"
import { TrackerSelect } from "../src/components/TrackerSelect"
import { ConfirmDialog } from "../src/components/ConfirmDialog"
import { AlertDialog, AlertDialogContent, AlertDialogTitle } from "../src/components/ui/alert-dialog"
import { TrackerModal } from "../src/components/TrackerModal"
import { TopBar } from "../src/components/TopBar"
import { Reason } from "../src/components/Reason"
import { fmtDuration, RunFacts } from "../src/components/RunFacts"
import { ChecklistSidebar } from "../src/components/ChecklistSidebar"
import type { RunSummary } from "../src/types/events"
import { FindingsPanel } from "../src/pages/RunDetailPage"
import { Checkbox } from "../src/components/ui/checkbox"
import { Label } from "../src/components/ui/label"
import { browser, harness, nodes, text, markup, is } from "./render"

test("key settings show masked status, refresh it, and submit only entered keys", async () => {
  const b = browser("/")
  const originalFetch = globalThis.fetch
  let sent: unknown
  let status = { anthropicApiKey: "fixtur••••", openaiApiKey: null as string | null, relayAuthToken: null as string | null, ghToken: null as string | null }
  globalThis.fetch = (async (_input: any, init?: RequestInit) => {
    if (init?.method === "PUT") { sent = JSON.parse(String(init.body)); return new Response(null, { status: 400 }) }
    return Response.json(status)
  }) as typeof fetch
  const h = harness()
  try {
    h.render(KeySettings, {})
    await h.flush()
    let view = h.render(KeySettings, {})
    const inputs = nodes(view, node => is(node, "input"))
    assert.equal(inputs[0].props.type, "password")
    assert.equal(inputs[0].props.placeholder, "fixtur••••")
    assert.equal(inputs[1].props.type, "password")
    assert.equal(inputs[1].props.placeholder, "Not set")
    assert.match(text(view), /OpenAI API key \(Codex\)/)
    assert.equal(inputs[2].props.placeholder, "Not set")
    assert.equal(inputs[3].props.type, "password")
    assert.equal(inputs[3].props.placeholder, "Not set")
    assert.match(text(view), /active runs keep their starting token/)
    status = { anthropicApiKey: "fixtur••••", openaiApiKey: "sk-fix••••", relayAuthToken: "relay-••••", ghToken: "github••••" }
    await nodes(view, node => is(node, "button") && text(node) === "Refresh")[0].props.onClick()
    await h.flush()
    view = h.render(KeySettings, {})
    assert.equal(nodes(view, node => is(node, "input"))[1].props.placeholder, "sk-fix••••")
    assert.equal(nodes(view, node => is(node, "input"))[2].props.placeholder, "relay-••••")
    assert.equal(nodes(view, node => is(node, "input"))[3].props.placeholder, "github••••")
    nodes(view, node => is(node, "input"))[3].props.onChange({ target: { value: "fixture.github" } })
    nodes(view, node => is(node, "input"))[2].props.onChange({ target: { value: "fixture.relay" } })
    nodes(view, node => is(node, "input"))[1].props.onChange({ target: { value: "sk-fixture.openai" } })
    view = h.render(KeySettings, {})
    await nodes(view, node => is(node, "button"))[0].props.onClick()
    await h.flush()
    assert.deepEqual(sent, { openaiApiKey: "sk-fix" + "ture.openai", relayAuthToken: "fixture.relay", ghToken: "fixture.github" })
    assert.match(text(h.render(KeySettings, {})), /Could not save keys/)
  } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
})

test("LiteLLM is visible but disabled when unconfigured", () => {
  const b = browser("/")
  const h = harness()
  try {
    const view = h.render(ProviderSelect, { value: "claude", onChange() {}, litellm: { disabled: true } })
    const option = nodes(view, node => node.type === "option" && node.props.value === "litellm")[0]
    assert.equal(option.props.disabled, true)
    assert.match(text(option), /LiteLLM/)
  } finally { h.cleanup(); b.cleanup() }
})

test("Codex offers its login and the OpenAI key when both exist, and one label otherwise", () => {
  const b = browser("/")
  const h = harness()
  const options = (view: React.ReactNode) => nodes(view, node => node.type === "option").map(node => [node.props.value, text(node)])
  try {
    const both = { claude: { available: true }, antigravity: { available: false }, qoder: { available: true }, codex: { available: true, auth: "subscription" as const, apiKey: true } }
    assert.deepEqual(options(h.render(ProviderSelect, { value: "codex", onChange() {}, availability: both })).filter(([value]) => String(value).startsWith("codex")),
      [["codex", "Codex · Subscription"], ["codex-api-key", "Codex · API key"]])
    assert.deepEqual(options(h.render(ProviderSelect, { value: "codex-api-key", onChange() {}, availability: both, review: true })).filter(([value]) => String(value).startsWith("codex")),
      [["codex", "Codex"]])
    const keyOnly = { claude: { available: true }, antigravity: { available: false }, qoder: { available: true }, codex: { available: true, auth: "api-key" as const, apiKey: true } }
    assert.deepEqual(options(h.render(ProviderSelect, { value: "codex", onChange() {}, availability: keyOnly })).filter(([value]) => String(value).startsWith("codex")),
      [["codex", "Codex · API key"]])
    const review = h.render(ProviderSelect, { value: "codex", onChange() {}, availability: both, review: true, authMode: "api-key", provider: "codex" })
    assert.deepEqual(options(review).filter(([value]) => value === "claude" || value === "codex"), [["claude", "Claude · Subscription"], ["codex", "Codex · API key"]])
  } finally { h.cleanup(); b.cleanup() }
})

for (const scenario of [
  { name: "login and key, login chosen", codex: { available: true, auth: "subscription", apiKey: true }, choice: "codex", authMode: undefined },
  { name: "login and key, key chosen", codex: { available: true, auth: "subscription", apiKey: true }, choice: "codex-api-key", authMode: "api-key" },
  { name: "an apikey-mode login file and the key", codex: { available: true, auth: "api-key", apiKey: true }, choice: "codex", authMode: "api-key" },
  { name: "key only", codex: { available: true, auth: "api-key", apiKey: true }, choice: "codex", authMode: "api-key" },
  { name: "login only", codex: { available: true, auth: "subscription" }, choice: "codex", authMode: undefined },
] as const) {
  test(`Scan sends Codex authMode ${scenario.authMode} for ${scenario.name} and keeps a valid model`, async () => {
    const b = browser("/")
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: any) => Response.json(String(input) === "/api/providers"
      ? { claude: { available: true }, codex: scenario.codex }
      : String(input) === "/api/repos" ? { repos: [{ url: "https://github.com/owner/repo", branch: "main" }] } : { configured: false, models: [] })) as typeof fetch
    let request: any
    const h = harness()
    const props = { sessionId: "fixture", activeRuns: [], onStarted() {}, startRun: async (value: any) => { request = value; return { runId: "new", status: "queued" as const } } }
    try {
      h.render(LandingPage, props)
      await h.flush()
      let view = h.render(LandingPage, props)
      nodes(view, node => is(node, "select") && node.props.id === "recent-repo")[0].props.onChange({ target: { value: "https://github.com/owner/repo" } })
      view = h.render(LandingPage, props)
      nodes(view, node => node.type === ProviderSelect)[0].props.onChange(scenario.choice)
      view = h.render(LandingPage, props)
      assert.equal(nodes(view, node => node.type === ProviderSelect)[0].props.value, scenario.choice === "codex" && scenario.authMode === "api-key" && scenario.codex.auth !== "api-key" ? "codex-api-key" : scenario.choice)
      await h.flush()
      await new Promise(resolve => setTimeout(resolve, 420))
      view = h.render(LandingPage, props)
      nodes(view, node => node.props["data-testid"] === "start-scan")[0].props.onClick()
      await h.flush()
      assert.equal(request.provider, "codex")
      assert.equal(request.model, "gpt-6.1-sol")
      assert.equal(request.authMode, scenario.authMode)
    } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
  })
}

for (const lang of ["en", "zh"] as const) test(`Scan uses the API key when no subscription login exists and sends the ${lang} UI language`, async () => {
  const b = browser("/", { ola_lang: lang })
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: any) => Response.json(String(input) === "/api/providers"
    ? { claude: { available: true, auth: "api-key" }, codex: { available: true } }
    : String(input) === "/api/repos" ? { repos: [{ url: "https://github.com/owner/repo", branch: "main" }] } : { configured: false, models: [] })) as typeof fetch
  let request: any
  const h = harness()
  const props = { sessionId: "fixture", activeRuns: [], onStarted() {}, startRun: async (value: any) => { request = value; return { runId: "new", status: "queued" as const } } }
  try {
    h.render(LandingPage, props)
    await h.flush()
    let view = h.render(LandingPage, props)
    nodes(view, node => is(node, "select") && node.props.id === "recent-repo")[0].props.onChange({ target: { value: "https://github.com/owner/repo" } })
    view = h.render(LandingPage, props)
    nodes(view, node => node.type === ProviderSelect)[0].props.onChange("codex")
    view = h.render(LandingPage, props)
    nodes(view, node => node.type === ProviderSelect)[0].props.onChange("claude")
    view = h.render(LandingPage, props)
    await h.flush()
    await new Promise(resolve => setTimeout(resolve, 420))
    view = h.render(LandingPage, props)
    nodes(view, node => node.props["data-testid"] === "start-scan")[0].props.onClick()
    await h.flush()
    assert.equal(request.authMode, "api-key")
    assert.equal(request.language, lang)
  } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
})

for (const lang of ["en", "zh"] as const) {
  test(`Scan and Pick localize provider loading failures in ${lang}`, async () => {
    const b = browser("/pick?repo=owner/repo", { ola_lang: lang })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: any) => String(input) === "/api/providers" ? new Response(null, { status: 503 })
      : Response.json({ rows: [], hidden: [], suggestedIds: [], repos: [], models: [], configured: false })) as typeof fetch
    const h = harness()
    const props = { sessionId: "fixture", activeRuns: [], onStarted() {}, startRun: async () => ({ runId: "new", status: "queued" as const }) }
    try {
      h.render(LandingPage, props)
      h.render(PickPage, props)
      await h.flush()
      for (const view of [h.render(LandingPage, props), h.render(PickPage, props)]) {
        assert.match(text(view), lang === "en" ? /Could not load providers: HTTP 503/ : /无法加载提供方：HTTP 503/)
      }
    } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
  })

  test(`translation values keep literal dollar replacement sequences in ${lang}`, () => {
    const b = browser("/", { ola_lang: lang })
    const h = harness()
    const msg = "$& $$ $` $'"
    function Probe() { return useI18n().t("common.failed_to_load", { msg }) }
    try {
      assert.equal(h.render(Probe, {}), `${lang === "en" ? "Failed to load: " : "加载失败："}${msg}`)
    } finally { h.cleanup(); b.cleanup() }
  })

  test(`durations use compact hours and days in ${lang}`, () => {
    const expected = lang === "en"
      ? ["0s", "59s", "1m 00s", "59m 59s", "1h 0m", "1h 1m", "23h 59m", "1d 0h", "3d 6h"]
      : ["0秒", "59秒", "1分 00秒", "59分 59秒", "1小时 0分", "1小时 1分", "23小时 59分", "1天 0小时", "3天 6小时"]
    assert.deepEqual([0, 59, 60, 3599, 3600, 3661, 86399, 86400, 4685 * 60 + 7].map(seconds => fmtDuration(0, seconds * 1000, lang)), expected)
    assert.equal(fmtDuration(undefined, 1, lang), "—")
    assert.equal(fmtDuration(1, undefined, lang), "—")
  })

  test(`History uses distinct status labels and leaves fix scope empty in ${lang}`, async () => {
    const b = browser("/history", { ola_lang: lang })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => Response.json({ runs: ["fix", "scan"].map((mode, i) => ({
      runId: mode, runNumber: 12 - i, mode, status: "completed", skill: "ola-security-audit", repoUrl: "https://github.com/owner/repo",
      startedAt: 0, finishedAt: 4685 * 60000 + 7000,
    })) })) as unknown as typeof fetch
    const h = harness()
    try {
      h.render(HistoryPage, { onOpenRun() {} })
      await h.flush()
      const view = h.render(HistoryPage, { onOpenRun() {} })
      const rows = nodes(nodes(view, node => is(node, "tbody"))[0], node => is(node, "tr"))
      const numberHeader = nodes(view, node => is(node, "th"))[0]
      assert.equal(text(numberHeader), lang === "en" ? "Run number" : "运行编号")
      assert.match(text(nodes(rows[0], node => is(node, "td"))[0]), /#12/)
      const modeCell = (row: React.ReactNode) => nodes(row, node => is(node, "td"))[2]
      assert.equal(text(modeCell(rows[0])), lang === "en" ? "Fix" : "修复")
      assert.match(text(modeCell(rows[1])), lang === "en" ? /Full/ : /全量/)
      assert(!nodes(view, node => is(node, "th")).some(node => text(node) === (lang === "en" ? "Scope" : "范围")))
      assert.match(text(rows[0]), lang === "en" ? /3d 6h/ : /3天 6小时/)
      const options = nodes(nodes(view, node => is(node, "select"))[0], node => node.type === "option" && node.props.value)
      const expected = lang === "en"
        ? ["Connecting", "Queued", "Cloning repo", "Running", "Completed", "Failed", "Cancelled", "Paused (resumable)"]
        : ["连接中", "排队中", "克隆仓库中", "运行中", "已完成", "失败", "已取消", "已暂停（可继续）"]
      assert.deepEqual(options.map(node => text(node)), expected)
      assert.equal(new Set(options.map(node => text(node))).size, 8)
    } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
  })

  test(`live run header shows the run number beside the repo in ${lang}`, () => {
    const b = browser("/runs/uuid", { ola_lang: lang })
    const h = harness()
    try {
      const view = h.render(TopBar, { runId: "uuid", runNumber: 12, status: "scanning", repo: "owner/repo", branch: "main" })
      const repo = nodes(view, node => node.props["data-testid"] === "run-repo")[0]
      assert.equal(text(repo), "owner/repo #12 main")
      assert.equal(nodes(view, node => node.type === "h1")[0].props.title, "uuid")
    } finally { h.cleanup(); b.cleanup() }
  })
}

test("Chinese run facts and live steps localize minute and second units", () => {
  const b = browser("/", { ola_lang: "zh" })
  const h = harness()
  const originalNow = Date.now
  Date.now = () => 439000
  try {
    const meta: RunSummary = { runId: "fixture", runNumber: 1, sessionId: "session", mode: "scan", status: "completed", repoUrl: "https://github.com/owner/repo", branch: "main", skill: "ola-security-audit", model: "opus", effort: "high", startedAt: 0, finishedAt: 439000 }
    assert.match(text(h.render(RunFacts, { meta })), /7分 19秒/)
    const view = h.render(ChecklistSidebar, { steps: [{ name: "scan", status: "in_progress", startedAt: 0 }] })
    assert.match(text(view), /7分 19秒/)
    assert.doesNotMatch(text(view), /7m|19s/)
  } finally { h.cleanup(); Date.now = originalNow; b.cleanup() }
})

test("Advisories bullets cap at five and preserve following reason sections when expanded", () => {
  const h = harness()
  const props = { text: "IDs: CVE-2026-1000\nAdvisories:\n" + Array.from({ length: 8 }, (_, i) => `- CVE-2026-${1000 + i}: Review reachability`).join("\n") + "\nTrees: vendor/package\nFix: Review manually" }
  try {
    let view = h.render(Reason, props)
    assert.equal(nodes(view, node => node.type === "p" && text(node).startsWith("• ")).length, 5)
    assert.match(text(view), /\+3 more/)
    assert.doesNotMatch(text(view), /CVE-2026-1005/)
    assert.match(text(view), /Trees: vendor\/package.*Fix: Review manually/)
    nodes(view, node => is(node, "button"))[0].props.onClick()
    view = h.render(Reason, props)
    assert.equal(nodes(view, node => node.type === "p" && text(node).startsWith("• ")).length, 8)
    assert.match(text(view), /CVE-2026-1007/)
    nodes(view, node => is(node, "button") && text(node) === "Collapse")[0].props.onClick()
    assert.equal(nodes(h.render(Reason, props), node => node.type === "p" && text(node).startsWith("• ")).length, 5)
  } finally { h.cleanup() }
})

test("IDs lines cap at five even when the IDs are not CVE or GHSA", () => {
  const h = harness()
  const props = { text: "Verdict: needs human.\nIDs: CVE-2026-1000, " + Array.from({ length: 7 }, (_, i) => `PKSA-aaaa-bbbb-${i}`).join(", ") + "\nTrees: x" }
  try {
    const view = h.render(Reason, props)
    assert.match(text(view), /\+3 more/)
    assert.doesNotMatch(text(view), /PKSA-aaaa-bbbb-5/)
    assert.match(text(view), /PKSA-aaaa-bbbb-3/)
  } finally { h.cleanup() }
})

test("History uses one native link per row, supports Space, filters status on the server and shows tokens and duration", async () => {
  const originalFetch = globalThis.fetch
  let requests = 0
  const opened: string[] = []
  globalThis.fetch = (async (input: any) => {
    requests++
    const query = new URL(String(input), "http://localhost").searchParams
    return Response.json({ runs: ["completed", "failed"].filter(status => !query.get("status") || status === query.get("status")).map((status, i) => ({
      runId: String(i), runNumber: 12 - i, status, repoUrl: "https://github.com/owner/repo", mode: "scan", skill: "ola-security-audit",
      branch: "main", startedAt: 1000, finishedAt: 120000, model: "sonnet", effort: "high", usage: {
        inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0,
      },
    })) })
  }) as unknown as typeof fetch
  const h = harness()
  const props = { onOpenRun: (id: string) => opened.push(id) }
  try {
    h.render(HistoryPage, props)
    await h.flush()
    let view = h.render(HistoryPage, props)
    assert.equal(nodes(view, node => is(node, "tr") && node.props.tabIndex != null).length, 0)
    const links = nodes(view, node => node.type === "a")
    assert.equal(links.length, 2)
    assert.equal(links[0].props.href, "/runs/0")
    let prevented = false
    links[0].props.onKeyDown({ key: " ", preventDefault() { prevented = true } })
    assert.equal(prevented, true)
    links[0].props.onClick({ button: 0, preventDefault() {} })
    assert.deepEqual(opened, ["0", "0"])
    assert.match(text(view), /15.*1m 59s/)
    assert.match(text(view), /Full/)
    nodes(view, node => is(node, "select"))[0].props.onChange({ target: { value: "failed" } })
    view = h.render(HistoryPage, props)
    await h.flush()
    view = h.render(HistoryPage, props)
    assert.equal(nodes(view, node => node.type === "a").length, 1)
    assert.equal(requests, 2)
  } finally { h.cleanup(); globalThis.fetch = originalFetch }
})

test("Scan preserves each provider's chosen model and effort, labels checkboxes and shows concurrent starts inline", async () => {
  const b = browser("/")
  globalThis.confirm = () => { throw new Error("Must use an in-page confirmation") }
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: any) => Response.json(String(input) === "/api/providers"
    ? { claude: { available: true }, codex: { available: true } }
    : String(input) === "/api/repos" ? { repos: [{ url: "https://github.com/owner/repo", branch: "main" }] } : { configured: false, models: [] })) as typeof fetch
  let starts = 0
  let request: any
  const h = harness()
  const props = {
    sessionId: "fixture", activeRuns: [{ runId: "active", status: "scanning", repoUrl: "repo", mode: "scan" }],
    onStarted() {}, startRun: async (req: any) => { starts++; request = req; return { runId: "new", status: "queued" as const } },
  }
  try {
    h.render(LandingPage, props)
    await h.flush()
    let view = h.render(LandingPage, props)
    const choose = (label: string, value: string) => nodes(view, node => typeof node.type === "function" && node.props.label === label)[0].props.onChange(value)
    assert.equal(nodes(view, node => typeof node.props.label === "string" && /output language|输出语言/i.test(node.props.label)).length, 0)
    choose("Effort", "max")
    choose("Model", "opus")
    view = h.render(LandingPage, props)
    nodes(view, node => node.type === ProviderSelect)[0].props.onChange("codex")
    view = h.render(LandingPage, props)
    choose("Effort", "xhigh")
    view = h.render(LandingPage, props)
    nodes(view, node => node.type === ProviderSelect)[0].props.onChange("claude")
    view = h.render(LandingPage, props)
    assert.equal(nodes(view, node => node.props.label === "Effort")[0].props.value, "max")
    assert.equal(nodes(view, node => node.props.label === "Model")[0].props.value, "opus")
    const checkboxes = nodes(view, node => node.type === Checkbox && node.props["aria-label"])
    assert.equal(checkboxes.length, 17)
    assert(checkboxes.every(node => node.props["aria-label"] !== "on"))
    assert.equal(checkboxes[0].props["aria-label"], "SQLi (§1.1)")
    assert.equal(checkboxes[14].props["aria-label"], "Numeric juggling (§1.5)")
    assert.match(text(view), /PHP-specific · 0\/3/)
    assert.deepEqual(checkboxes.filter(node => node.props.checked).map(node => node.props["aria-label"]),
      ["SQLi (§1.1)", "Command injection (§1.2)", "Deserialization/POP (§1.3)", "Hardcoded secret (§1.11)", "Exposed test API (§1.19)"])
    const group = (name: RegExp) => {
      const label = nodes(view, node => node.type === Label && name.test(text(node)) && nodes(node, child => child.type === Checkbox && !child.props["aria-label"]).length > 0)[0]
      return nodes(label, node => node.type === Checkbox)[0]
    }
    const toggleGroup = (name: RegExp) => { group(name).props.onCheckedChange(); view = h.render(LandingPage, props) }
    assert.equal(group(/General/).props.checked, "indeterminate")
    toggleGroup(/General/)
    assert.match(text(view), /General \(any language\) · 14\/14/)
    toggleGroup(/PHP-specific/)
    assert.match(text(view), /Bug types · All 17 types/)
    toggleGroup(/General/)
    toggleGroup(/PHP-specific/)
    assert.match(text(view), /Bug types · 0 selected/)
    toggleGroup(/General/)
    nodes(view, node => is(node, "select") && node.props.id === "recent-repo")[0].props.onChange({ target: { value: "https://github.com/owner/repo" } })
    view = h.render(LandingPage, props)
    await h.flush()
    await new Promise(resolve => setTimeout(resolve, 420))
    view = h.render(LandingPage, props)
    toggleGroup(/General/)
    assert.match(text(view), /Tick at least one bug type\./)
    toggleGroup(/General/)
    assert.doesNotMatch(text(view), /Tick at least one bug type/)
    const start = () => nodes(view, node => node.props["data-testid"] === "start-scan")[0].props.onClick()
    const banner = nodes(view, node => node.type === ActiveRunBanner)[0]
    assert.match(text(h.render(ActiveRunBanner, banner.props)), /A run is active/)
    assert.equal(nodes(view, node => node.type === ConfirmDialog).length, 0)
    await start()
    await h.flush()
    assert.equal(starts, 1)
    assert.equal(request.language, "en")
    assert.equal(request.effort, "max")
    assert.equal(request.model, "opus")
  } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
})

for (const failure of ["HTTP", "network"]) {
  test(`Tracker Remove confirms first and shows ${failure} failures`, async () => {
    const b = browser()
    globalThis.confirm = () => { throw new Error("Must use an in-page confirmation") }
    const originalFetch = globalThis.fetch
    let deletes = 0
    globalThis.fetch = (async (_input: any, init: RequestInit = {}) => {
      if (init.method !== "DELETE") return Response.json({ repos: ["owner/repo"], removable: ["owner/repo"] })
      deletes++
      if (failure === "network") throw new Error("Network lost")
      return new Response("Unavailable", { status: 500 })
    }) as typeof fetch
    const h = harness()
    const props = { value: "owner/repo", onChange() { throw new Error("Should keep the selected repo") } }
    try {
      h.render(TrackerSelect, props)
      await h.flush()
      let view = h.render(TrackerSelect, props)
      await nodes(view, node => is(node, "button"))[0].props.onClick()
      assert.equal(deletes, 0)
      view = h.render(TrackerSelect, props)
      let dialog = nodes(view, node => node.type === ConfirmDialog)[0]
      let confirmation = h.render(ConfirmDialog, dialog.props)
      assert.match(text(confirmation), /Remove owner\/repo from the list/)
      nodes(confirmation, node => is(node, "button") && text(node) === "Cancel")[0].props.onClick()
      view = h.render(TrackerSelect, props)
      assert.equal(nodes(view, node => node.type === ConfirmDialog).length, 0)
      assert.equal(deletes, 0)
      await nodes(view, node => is(node, "button"))[0].props.onClick()
      view = h.render(TrackerSelect, props)
      dialog = nodes(view, node => node.type === ConfirmDialog)[0]
      confirmation = h.render(ConfirmDialog, dialog.props)
      nodes(confirmation, node => is(node, "button") && text(node) === "Remove")[0].props.onClick()
      await h.flush()
      view = h.render(TrackerSelect, props)
      assert.equal(deletes, 1)
      assert.match(text(view), /Could not remove repository/)
      assert.equal(nodes(view, node => node.props.role === "alert").length, 1)
    } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
  })
}

test("recent repo removal confirms, keeps the repo on failure and renders that failure on Scan", async () => {
  const b = browser("/")
  globalThis.confirm = () => { throw new Error("Must use an in-page confirmation") }
  const originalFetch = globalThis.fetch
  let deletes = 0
  globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
    if (init.method === "DELETE") { deletes++; return new Response(null, { status: 503 }) }
    return Response.json(String(input) === "/api/repos" ? { repos: [{ url: "https://github.com/owner/repo", branch: "main" }] }
      : String(input) === "/api/providers" ? { claude: { available: true } } : { configured: false, models: [] })
  }) as typeof fetch
  const h = harness()
  const props = { sessionId: "fixture", activeRuns: [], onStarted() {}, startRun: async () => ({ runId: "new", status: "queued" as const }) }
  try {
    h.render(LandingPage, props)
    await h.flush()
    const settings = () => h.render(RepoSettings, nodes(h.render(LandingPage, props), node => node.type === RepoSettings)[0].props as any)
    const renderRow = () => { const view = settings(); const row = nodes(view, node => node.props.repo)[0]; return h.render(row.type as any, row.props as any) as any }
    let view = settings()
    await nodes(renderRow(), node => is(node, "button") && text(node) === "Remove")[0].props.onClick()
    assert.equal(deletes, 0)
    view = settings()
    let dialog = nodes(view, node => node.type === ConfirmDialog)[0]
    let confirmation = h.render(ConfirmDialog, dialog.props)
    assert.match(text(confirmation), /Remove https:\/\/github.com\/owner\/repo from the list/)
    nodes(confirmation, node => is(node, "button") && text(node) === "Cancel")[0].props.onClick()
    view = settings()
    assert.equal(nodes(view, node => node.type === ConfirmDialog).length, 0)
    assert.equal(deletes, 0)
    nodes(renderRow(), node => is(node, "button") && text(node) === "Remove")[0].props.onClick()
    view = settings()
    dialog = nodes(view, node => node.type === ConfirmDialog)[0]
    confirmation = h.render(ConfirmDialog, dialog.props)
    nodes(confirmation, node => is(node, "button") && text(node) === "Remove")[0].props.onClick()
    await h.flush()
    view = settings()
    assert.equal(deletes, 1)
    assert.match(text(view), /Could not remove repository: HTTP 503/)
    assert.equal(nodes(h.render(LandingPage, props), node => node.type === "option" && node.props.value === "https://github.com/owner/repo").length, 1)
  } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
})

for (const disabled of [false, true]) {
  test(`in-page confirmation opens a labeled dialog, supports Escape and returns focus to ${disabled ? "the page" : "its opener"}`, () => {
    const h = harness()
    let cancelled = 0
    let confirmed = 0
    let focused = ""
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      activeElement: { isConnected: true, matches: () => disabled, focus() { focused = "opener" } },
      querySelector: (selector: string) => selector === "main" ? { focus() { focused = "page" } } : null,
    } })
    try {
      const view = h.render(ConfirmDialog, { message: "Confirm action", confirmLabel: "Continue", onConfirm() { confirmed++ }, onCancel() { cancelled++ } })
      assert.equal(view.type, AlertDialog)
      assert.equal(view.props.open, true)
      const content = nodes(view, node => node.type === AlertDialogContent)[0]
      assert.match(text(nodes(content, node => node.type === AlertDialogTitle)[0]), /Confirm action/)
      const cancel = nodes(content, node => is(node, "button") && text(node) === "Cancel")[0]
      Reflect.get(cancel, "ref").current = { focus() { focused = "cancel" } }
      let prevented = 0
      content.props.onOpenAutoFocus({ preventDefault() { prevented++ } })
      assert.equal(focused, "cancel")
      view.props.onOpenChange(false)
      assert.equal(cancelled, 1)
      cancel.props.onClick()
      assert.equal(cancelled, 2)
      nodes(content, node => is(node, "button") && text(node) === "Continue")[0].props.onClick()
      assert.equal(confirmed, 1)
      content.props.onCloseAutoFocus({ preventDefault() { prevented++ } })
      assert.equal(prevented, 2)
      assert.equal(focused, disabled ? "page" : "opener")
    } finally {
      h.cleanup()
      if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument)
      else Reflect.deleteProperty(globalThis, "document")
    }
  })
}

for (const action of ["ignore", "needs-human"] as const) for (const disabled of [false, true]) {
  test(`Pick ${action} confirmation is a labeled dialog that cancels on Escape and restores focus to ${disabled ? "the page when its opener is disabled" : "its opener"}`, async () => {
    const b = browser("/pick?repo=owner/repo")
    const originalFetch = globalThis.fetch
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
    globalThis.fetch = (async (input: any) => Response.json(String(input) === "/api/providers" ? { claude: { available: true } }
      : { repoUrl: "https://github.com/owner/repo", rows: [{ id: "one", category: "sqli", subsystem: "app", severity: "P1", file: "app/a.php", lines: [1], status: "open", reason: "Check" }], hidden: [], suggestedIds: ["one"] })) as typeof fetch
    const h = harness()
    const props = { sessionId: "fixture", activeRuns: [], onStarted() {} }
    let focused = ""
    try {
      h.render(PickPage, props)
      await h.flush()
      let view = h.render(PickPage, props)
      assert.equal(view.props.tabIndex, -1)
      nodes(view, node => is(node, "button") && text(node).startsWith(action === "needs-human" ? "Needs human" : "Ignore selected"))[0].props.onClick()
      view = h.render(PickPage, props)
      const modal = nodes(view, node => typeof node.type === "function" && node.type.name === "RowChangeDialog")[0]
      Object.defineProperty(globalThis, "document", { configurable: true, value: {
        activeElement: { isConnected: true, matches: () => disabled, focus() { focused = "opener" } },
        querySelector: (selector: string) => selector === "main" ? { focus() { focused = "page" } } : null,
      } })
      const dialog = h.render(modal.type as React.FunctionComponent<any>, modal.props) as React.ReactElement<any>
      assert.equal(dialog.type, AlertDialog)
      assert.equal(dialog.props.open, true)
      const content = nodes(dialog, node => node.type === AlertDialogContent)[0]
      assert.match(text(nodes(content, node => node.type === AlertDialogTitle)[0]), action === "ignore" ? /Ignore/ : /human/)
      dialog.props.onOpenChange(false)
      assert.equal(nodes(h.render(PickPage, props), node => node.type === modal.type).length, 0)
      let prevented = false
      content.props.onCloseAutoFocus({ preventDefault() { prevented = true } })
      assert.equal(prevented, true)
      assert.equal(focused, disabled ? "page" : "opener")
    } finally {
      h.cleanup()
      globalThis.fetch = originalFetch
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument)
      else Reflect.deleteProperty(globalThis, "document")
      b.cleanup()
    }
  })
}

for (const disabled of [false, true]) {
  test(`overview Close PR dialog cancels on Escape and restores focus to ${disabled ? "the page when its opener is disabled" : "its opener"}`, async () => {
    const b = browser("/overview?repo=owner/repo")
    const originalFetch = globalThis.fetch
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
    const pr = { number: 7, title: "Fix", draft: false, url: "https://github.com/owner/repo/pull/7" }
    globalThis.fetch = (async () => Response.json({ repo: "owner/repo", availableTypes: [], types: [], needsHuman: [], openPRs: [pr] })) as unknown as typeof fetch
    const h = harness()
    let focused = ""
    try {
      h.render(OverviewPage, {})
      await h.flush()
      let view = h.render(OverviewPage, {})
      assert.equal(view.props.tabIndex, -1)
      nodes(view, node => node.type === ImpactView)[0].props.closePR(pr)
      const modal = nodes(h.render(OverviewPage, {}), node => typeof node.type === "function" && node.type.name === "ClosePRDialog")[0]
      Object.defineProperty(globalThis, "document", { configurable: true, value: {
        activeElement: { isConnected: true, matches: () => disabled, focus() { focused = "opener" } },
        querySelector: (selector: string) => selector === "main" ? { focus() { focused = "page" } } : null,
      } })
      const dialog = h.render(modal.type as React.FunctionComponent<any>, modal.props) as React.ReactElement<any>
      assert.equal(dialog.type, AlertDialog)
      assert.equal(dialog.props.open, true)
      const content = nodes(dialog, node => node.type === AlertDialogContent)[0]
      assert.match(text(nodes(content, node => node.type === AlertDialogTitle)[0]), /Close PR #7/)
      dialog.props.onOpenChange(false)
      assert.equal(nodes(h.render(OverviewPage, {}), node => node.type === modal.type).length, 0)
      let prevented = false
      content.props.onCloseAutoFocus({ preventDefault() { prevented = true } })
      assert.equal(prevented, true)
      assert.equal(focused, disabled ? "page" : "opener")
    } finally {
      h.cleanup()
      globalThis.fetch = originalFetch
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument)
      else Reflect.deleteProperty(globalThis, "document")
      b.cleanup()
    }
  })
}

test("long advisory IDs show five and expand with a localized +N more control", () => {
  const h = harness()
  const props = { text: "IDs: " + Array.from({ length: 8 }, (_, i) => `CVE-2026-${1000 + i}`).join(", ") }
  try {
    let view = h.render(Reason, props)
    assert.match(text(view), /\+3 more/)
    assert.doesNotMatch(text(view), /CVE-2026-1005/)
    nodes(view, node => is(node, "button"))[0].props.onClick()
    view = h.render(Reason, props)
    assert.match(text(view), /CVE-2026-1007/)
    assert.doesNotMatch(text(view), /\+3 more/)
  } finally { h.cleanup() }
})

test("run headings, Session and bug types localize, and unknown bug types keep their names", () => {
  const b = browser("/", { ola_lang: "zh" })
  const h = harness()
  try {
    assert.match(text(h.render(TopBar, { runId: "fixture", status: "connecting" })), /运行 fixture/)
    assert.equal(nodes(h.render(TopBar, { runId: "fixture", status: "completed" }), node => is(node, "button")).length, 0)
    const scan = h.render(LandingPage, { sessionId: "fixture", activeRuns: [], onStarted() {}, startRun: async () => ({ runId: "new", status: "queued" as const }) })
    assert.match(text(scan), /会话/)
    assert.doesNotMatch(text(scan), /Session/)
    const tracker = h.render(TrackerModal, { repo: "owner/repo", tracker: { category: "sqli", url: "https://github.com/a/b/blob/main/tracker.json", rows: [] }, onClose() {} })
    assert.equal(tracker.props.title, "SQL 注入 (§1.1)")
    const unknown = h.render(TrackerModal, { repo: "owner/repo", tracker: { category: "custom-type", url: "https://github.com/a/b/blob/main/tracker.json", rows: [] }, onClose() {} })
    assert.equal(unknown.props.title, "custom-type")
  } finally { h.cleanup(); b.cleanup() }
})

test("finding reason cells span the actual table columns for scan and fix views", () => {
  for (const canPost of [false, true]) for (const hasFix of [false, true]) {
    const html = markup(<FindingsPanel runId="fixture" canPost={canPost} onPosted={() => {}}
      initialCheck={{ repo: "owner/repo", matches: {} }} findings={[{ id: "one", category: "sqli", severity: "P1", reason: "Check", ...(hasFix ? { fixSummary: "Bind" } : {}) }]} />)
    assert.match(html, new RegExp(`colSpan="${3 + Number(canPost) * 2 + Number(hasFix)}"`))
    assert.match(html, /<table.*<thead[ >].*<tbody[ >]/)
  }
})

test("fix provider choices follow capabilities and disable pending drivers", () => {
  const b = browser()
  const h = harness()
  try {
    const view = h.render(ProviderSelect, { value: "codex", fix: true, onChange() {} })
    const options = nodes(view, node => node.type === "option")
    const codex = options.find(node => node.props.value === "codex")
    assert.ok(codex)
    assert.equal(Boolean(codex.props.disabled), false)
    const antigravity = options.find(node => node.props.value === "antigravity")
    assert.ok(antigravity)
    assert.equal(Boolean(antigravity.props.disabled), false)
    const qoder = options.find(node => node.props.value === "qoder")
    assert.ok(qoder)
    assert.equal(Boolean(qoder.props.disabled), false)
  } finally { h.cleanup(); b.cleanup() }
})
