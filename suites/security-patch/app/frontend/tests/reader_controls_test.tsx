import { test } from "bun:test"
import assert from "node:assert/strict"
import { ArtifactButtons } from "../src/components/ArtifactButtons"
import { DiagnosticReader } from "../src/components/lazy"
import { ReaderModal } from "../src/components/ReaderModal"
import { Dialog, DialogContent, DialogTitle } from "../src/components/ui/dialog"
import { harness, nodes, text, is } from "./render"

for (const patch of ["zero length", "nonzero length", "empty text", "whitespace text", "diff text", "missing", "network"]) {
  test(`artifact controls handle ${patch} patches and open the selected reader`, async () => {
    const originalFetch = globalThis.fetch
    const urls: string[] = []
    let activity: Response | undefined
    let patchResponse: Response | undefined
    globalThis.fetch = (async (input: any) => {
      const url = String(input)
      urls.push(url)
      if (url.endsWith("/activity")) {
        activity = new Response("Activity")
        return activity
      }
      if (patch === "network") throw new Error("Offline")
      patchResponse = new Response(patch === "empty text" ? "" : patch === "whitespace text" ? " \n " : "diff --git a/file b/file", {
        status: patch === "missing" ? 404 : 200,
        headers: patch.endsWith("length") ? { "Content-Length": patch === "zero length" ? "0" : "26" } : {},
      })
      return patchResponse
    }) as typeof fetch
    const h = harness()
    const props = { runId: "run/id ?", mode: "fix" as const }
    try {
      let view = h.render(ArtifactButtons, props)
      assert.equal(nodes(view, node => is(node, "button"))[1].props.disabled, undefined)
      await h.flush()
      view = h.render(ArtifactButtons, props)
      assert.deepEqual(urls, ["/api/runs/run%2Fid%20%3F/artifacts/patch", "/api/runs/run%2Fid%20%3F/artifacts/activity"])
      assert.equal(activity?.bodyUsed, true)
      const buttons = nodes(view, node => is(node, "button"))
      assert.deepEqual(buttons.map(node => text(node)), ["Full report", "Patch", "Commits"])
      const empty = ["zero length", "empty text", "whitespace text"].includes(patch)
      assert.equal(Boolean(buttons[1].props.disabled), empty)
      if (patch.endsWith("length")) assert.equal(patchResponse?.bodyUsed, true)
      if (empty) assert.match(buttons[1].props.title, /changed no code.*patch is empty/)
      for (const [index, kind] of ["report", "patch", "commits"].entries()) {
        if (kind === "patch" && empty) continue
        buttons[index].props.onClick()
        const reader = nodes(h.render(ArtifactButtons, props), node => node.type === DiagnosticReader)[0]
        assert.equal(reader.props.kind, kind)
        assert.equal(reader.props.runId, props.runId)
        assert.equal(reader.props.title, kind === "report" ? "Full report" : undefined)
        reader.props.onClose()
        assert.equal(nodes(h.render(ArtifactButtons, props), node => node.type === DiagnosticReader).length, 0)
      }
    } finally {
      h.cleanup()
      globalThis.fetch = originalFetch
    }
  })
}

for (const activity of ["missing", "network"]) {
  test(`scan shows only Report when the activity probe is ${activity}`, async () => {
    const originalFetch = globalThis.fetch
    const urls: string[] = []
    globalThis.fetch = (async (input: any) => {
      urls.push(String(input))
      if (activity === "network") throw new Error("Offline")
      return new Response(null, { status: 404 })
    }) as typeof fetch
    const h = harness()
    const props = { runId: "scan", mode: "scan" as const }
    try {
      h.render(ArtifactButtons, props)
      await h.flush()
      const buttons = nodes(h.render(ArtifactButtons, props), node => is(node, "button"))
      assert.deepEqual(urls, ["/api/runs/scan/artifacts/activity"])
      assert.deepEqual(buttons.map(node => text(node)), ["Report"])
      buttons[0].props.onClick()
      const reader = nodes(h.render(ArtifactButtons, props), node => node.type === DiagnosticReader)[0]
      assert.equal(reader.props.kind, "report")
      assert.equal(reader.props.title, "Report")
    } finally {
      h.cleanup()
      globalThis.fetch = originalFetch
    }
  })
}

test("artifact probes ignore responses after unmount", async () => {
  const originalFetch = globalThis.fetch
  const replies = new Map<string, (response: Response) => void>()
  globalThis.fetch = ((input: any) => new Promise<Response>(resolve => { replies.set(String(input), resolve) })) as typeof fetch
  const h = harness()
  const props = { runId: "gone", mode: "fix" as const }
  let unmounted = false
  try {
    h.render(ArtifactButtons, props)
    await h.flush()
    h.cleanup()
    unmounted = true
    replies.get("/api/runs/gone/artifacts/activity")!(new Response("Activity"))
    replies.get("/api/runs/gone/artifacts/patch")!(new Response("", { headers: { "Content-Length": "0" } }))
    await h.flush()
    const buttons = nodes(h.render(ArtifactButtons, props), node => is(node, "button"))
    assert.equal(text(buttons[0]), "Report")
    assert.equal(Boolean(buttons[1].props.disabled), false)
  } finally {
    if (!unmounted) h.cleanup()
    globalThis.fetch = originalFetch
  }
})

test("ReaderModal opens a labeled dialog, focuses Close, and closes on Escape, outside click and Close", () => {
  const h = harness()
  let closes = 0
  try {
    const view = h.render(ReaderModal, { title: "Patch", source: "attempt", href: "https://github.com/owner/repo", hrefLabel: "Raw patch", children: "Diff content", onClose() { closes++ } })
    assert.equal(view.type, Dialog)
    assert.equal(view.props.open, true)
    const content = nodes(view, node => node.type === DialogContent)[0]
    assert.equal(text(nodes(content, node => node.type === DialogTitle)[0]), "Patch")
    assert.match(text(content), /Patch.*attempt.*Read only.*Diff content/)
    const link = nodes(content, node => node.type === "a")[0]
    assert.equal(link.props.href, "https://github.com/owner/repo")
    assert.equal(link.props.target, "_blank")
    assert.equal(link.props.rel, "noopener noreferrer")
    assert.match(text(link), /Raw patch/)
    const close = nodes(content, node => is(node, "button"))[0]
    assert.equal(text(close), "Close")
    let focused = false
    let prevented = false
    Reflect.get(close, "ref").current = { focus() { focused = true } }
    content.props.onOpenAutoFocus({ preventDefault() { prevented = true } })
    assert.equal(prevented, true)
    assert.equal(focused, true)
    // Radix reports Escape and a click outside as onOpenChange(false).
    view.props.onOpenChange(false)
    assert.equal(closes, 1)
    close.props.onClick()
    assert.equal(closes, 2)
  } finally { h.cleanup() }
})

test("ReaderModal returns focus to its opener on close, also when opened inside a side panel", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document")
  let focused = ""
  Object.defineProperty(globalThis, "document", { configurable: true, value: { activeElement: { isConnected: true, focus() { focused = "opener" } } } })
  const h = harness()
  try {
    const view = h.render(ReaderModal, { title: "PR #7", source: "owner/repo", children: "Body", onClose() {} })
    const content = nodes(view, node => node.type === DialogContent)[0]
    let prevented = false
    content.props.onCloseAutoFocus({ preventDefault() { prevented = true } })
    assert.equal(prevented, true)
    assert.equal(focused, "opener")
  } finally {
    h.cleanup()
    if (original) Object.defineProperty(globalThis, "document", original)
    else Reflect.deleteProperty(globalThis, "document")
  }
})
