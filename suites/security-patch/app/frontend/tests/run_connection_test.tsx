import { test } from "bun:test"
import assert from "node:assert/strict"
import { useRunEvents } from "../src/hooks/useRunEvents"
import { RunPage } from "../src/pages/RunPage"
import { RunRoute } from "../src/pages/RunRoute"
import { ConfirmDialog } from "../src/components/ConfirmDialog"
import { TopBar } from "../src/components/TopBar"
import { browser, harness, nodes, text, is } from "./render"

test("Cancel run reports a network failure without an unhandled rejection", async () => {
  const b = browser()
  const originalFetch = globalThis.fetch
  const alertDescriptor = Object.getOwnPropertyDescriptor(globalThis, "alert")
  const alerts: string[] = []
  Object.defineProperty(globalThis, "alert", { configurable: true, value: (message: string) => alerts.push(message) })
  globalThis.fetch = (async (_input: any, init?: RequestInit) => {
    if (init?.method === "POST") throw new Error("Network lost")
    return Response.json({ runId: "fixture", runNumber: 12, mode: "scan", status: "scanning", repoUrl: "https://github.com/owner/repo" })
  }) as typeof fetch
  const h = harness()
  const props = { runId: "fixture", mode: "scan" as const, onResumed() {} }
  try {
    h.render(RunPage, props)
    await h.flush()
    const view = h.render(RunPage, props)
    assert.equal(nodes(view, node => node.type === TopBar)[0].props.runNumber, 12)
    await nodes(view, node => node.type === TopBar)[0].props.onStop()
    const dialog = nodes(h.render(RunPage, props), node => node.type === ConfirmDialog)[0]
    assert.equal(dialog.props.confirmLabel, "Cancel run")
    assert.equal(dialog.props.cancelLabel, "Keep running")
    await dialog.props.onConfirm()
    await h.flush()
    assert.equal(alerts.length, 0)
    const notice = nodes(h.render(RunPage, props), node => node.props.role === "alert")[0]
    assert.match(text(notice), /Network lost/)
  } finally {
    h.cleanup()
    globalThis.fetch = originalFetch
    if (alertDescriptor) Object.defineProperty(globalThis, "alert", alertDescriptor)
    else Reflect.deleteProperty(globalThis, "alert")
    b.cleanup()
  }
})

for (const status of ["completed", "failed", "stopped", "aborted"]) {
  test(`run stream waits for the final ${status} frame and keeps its error`, async () => {
    let stream: any
    let closes = 0
    class Stream {
      constructor() { stream = this }
      close() { closes++ }
    }
    const h = harness()
    function Probe() { return useRunEvents("fixture", { EventSourceCtor: Stream as unknown as typeof EventSource }) }
    try {
      h.render(Probe, {})
      await h.flush()
      stream.onopen()
      stream.onerror()
      stream.onmessage({ data: JSON.stringify({ type: "run_status", status }) })
      assert.equal(closes, 0)
      stream.onmessage({ data: JSON.stringify({ type: "run_finished", status, error: "final reason" }) })
      const state = h.render(Probe, {})
      assert.equal(state.status, status)
      assert.equal(state.error, "final reason")
      assert.equal(state.reconnecting, false)
      assert.equal(closes, 1)
    } finally { h.cleanup() }
  })
}

test("a rejected event stream shows an error instead of promising a reconnect", async () => {
  const originalFetch = globalThis.fetch
  const originalStream = globalThis.EventSource
  let stream: any
  // EventSource enters CLOSED after a non-retryable HTTP response, including 404.
  globalThis.EventSource = class {
    readyState = 2
    constructor() { stream = this }
    close() {}
  } as unknown as typeof EventSource
  globalThis.fetch = (async () => Response.json({ status: "scanning", repoUrl: "https://github.com/owner/repo" })) as unknown as typeof fetch
  const h = harness()
  const props = { runId: "fixture", mode: "scan" as const, onResumed() {} }
  try {
    h.render(RunPage, props)
    await h.flush()
    stream.onerror()
    const view = h.render(RunPage, props)
    assert.match(text(view), /Failed to load: event stream closed/)
    assert.doesNotMatch(text(view), /Reconnecting/)
  } finally { h.cleanup(); globalThis.fetch = originalFetch; globalThis.EventSource = originalStream }
})

test("reconnect replays rebuild report, timeline, findings and tokens once", async () => {
  let stream: any
  class Stream {
    constructor() { stream = this }
    close() {}
  }
  const h = harness()
  function Probe() { return useRunEvents("fixture", { EventSourceCtor: Stream as unknown as typeof EventSource }) }
  try {
    h.render(Probe, {})
    await h.flush()
    stream.onopen()
    const replay = () => {
      for (const event of [
        { type: "run_status", status: "scanning" },
        { type: "assistant_text", text: "Report" },
        { type: "thinking_emitted", text: "Thinking", ts: 1 },
        { type: "tool_invoked", tool: "Read", input: {}, ts: 2 },
        { type: "finding_emitted", finding: { id: "one" } },
        { type: "usage_delta", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0 } },
      ]) stream.onmessage({ data: JSON.stringify(event) })
    }
    replay()
    const before = h.render(Probe, {})
    stream.onerror()
    assert.equal(h.render(Probe, {}).reconnecting, true)
    stream.onopen()
    replay()
    const after = h.render(Probe, {})
    assert.equal("events" in after, false)
    assert.deepEqual(after.timeline, before.timeline)
    assert.deepEqual(after.toolLog, before.toolLog)
    assert.deepEqual(after.findings, before.findings)
    assert.equal(after.assistantText, "Report")
    assert.equal(after.reconnecting, false)
    assert.equal(after.reconnects, 1)
  } finally { h.cleanup() }
})

test("live view announces reconnecting and fetches status again when the stream reopens", async () => {
  const originalFetch = globalThis.fetch
  const originalStream = globalThis.EventSource
  let stream: any
  let status = "scanning"
  let requests = 0
  let finished = 0
  globalThis.EventSource = class {
    constructor() { stream = this }
    close() {}
  } as unknown as typeof EventSource
  globalThis.fetch = (async () => {
    requests++
    return Response.json({ runId: "fixture", mode: "scan", status, repoUrl: "https://github.com/owner/repo" })
  }) as unknown as typeof fetch
  const h = harness()
  const props = { runId: "fixture", mode: "scan" as const, onResumed() {}, onFinished() { finished++ } }
  try {
    h.render(RunPage, props)
    await h.flush()
    stream.onopen()
    stream.onmessage({ data: JSON.stringify({ type: "run_status", status }) })
    stream.onerror()
    assert.match(text(h.render(RunPage, props)), /Reconnecting/)
    status = "completed"
    stream.onopen()
    h.render(RunPage, props)
    await h.flush()
    const view = h.render(RunPage, props)
    await h.flush()
    assert.equal(requests, 2)
    assert.equal(finished, 1)
    assert.equal(nodes(view, node => node.type === TopBar)[0].props.onStop, undefined)
  } finally {
    h.cleanup()
    globalThis.fetch = originalFetch
    globalThis.EventSource = originalStream
  }
})

for (const failure of [404, 500, "network"] as const) {
  test(`run route distinguishes ${failure} and lets the user retry`, async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      if (failure === "network") throw new Error("Network lost")
      return new Response("Unavailable", { status: failure })
    }) as unknown as typeof fetch
    const h = harness()
    try {
      h.render(RunRoute, { runId: "fixture" })
      await h.flush()
      const view = h.render(RunRoute, { runId: "fixture" })
      assert.match(text(view), failure === 404 ? /Run not found/ : /Failed to load/)
      if (failure !== 404) assert.doesNotMatch(text(view), /Run not found/)
      assert.equal(nodes(view, node => is(node, "button") && text(node) === "Retry").length, 1)
    } finally { h.cleanup(); globalThis.fetch = originalFetch }
  })
}
