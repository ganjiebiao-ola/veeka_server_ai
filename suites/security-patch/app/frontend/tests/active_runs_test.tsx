import { test } from "bun:test"
import assert from "node:assert/strict"
import { useActiveRuns, RUNS_CHANGED } from "../src/hooks/useActiveRuns"
import { ActiveRunBanner } from "../src/components/ActiveRunBanner"
import { AttemptPicker } from "../src/components/AttemptPicker"
import { browser, harness, nodes, text, is } from "./render"

test("active runs poll visible tabs, refresh on events and path changes, and clean up on unmount", async () => {
  const b = browser()
  const originals = new Map(["document", "setInterval", "clearInterval"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const originalFetch = globalThis.fetch
  const events = new EventTarget()
  const visibility = { hidden: false }
  const intervals = new Map<number, () => void>()
  let intervalId = 0
  let requests = 0
  let reply: () => Promise<Response> = async () => Response.json({ runs: [run] })
  const run = { runId: "active", repoUrl: "https://github.com/owner/repo", status: "scanning", mode: "scan" }
  Object.defineProperty(globalThis, "document", { configurable: true, value: visibility })
  globalThis.setInterval = ((callback: () => void, delay: number) => {
    assert.equal(delay, 4000)
    intervals.set(++intervalId, callback)
    return intervalId
  }) as unknown as typeof setInterval
  globalThis.clearInterval = ((id: number) => { intervals.delete(id) }) as unknown as typeof clearInterval
  globalThis.addEventListener = events.addEventListener.bind(events)
  globalThis.removeEventListener = events.removeEventListener.bind(events)
  globalThis.fetch = (async (input: any) => {
    assert.equal(input, "/api/runs/active")
    requests++
    return reply()
  }) as unknown as typeof fetch
  function Probe({ path }: { path: string }) { return useActiveRuns(path) }
  const h = harness()
  let unmounted = false
  try {
    assert.deepEqual(h.render(Probe, { path: "/" }), [])
    await h.flush()
    assert.deepEqual(h.render(Probe, { path: "/" }), [run])
    assert.equal(requests, 1)
    assert.equal(intervals.size, 1)
    await h.flush()
    assert.equal(requests, 1)
    visibility.hidden = true
    intervals.get(1)!()
    await h.flush()
    assert.equal(requests, 1)
    visibility.hidden = false
    intervals.get(1)!()
    await h.flush()
    assert.equal(requests, 2)
    events.dispatchEvent(new Event(RUNS_CHANGED))
    await h.flush()
    assert.equal(requests, 3)

    for (const failure of ["HTTP", "network", "JSON"]) {
      reply = async () => {
        if (failure === "network") throw new Error("Offline")
        return new Response("invalid JSON", { status: failure === "HTTP" ? 503 : 200 })
      }
      intervals.get(1)!()
      await h.flush()
      assert.deepEqual(h.render(Probe, { path: "/" }), [run])
    }

    let finish!: (response: Response) => void
    reply = () => new Promise<Response>(resolve => { finish = resolve })
    events.dispatchEvent(new Event(RUNS_CHANGED))
    const oldReply = finish
    reply = async () => Response.json({ runs: [] })
    h.render(Probe, { path: "/pick" })
    await h.flush()
    assert.equal(intervals.has(1), false)
    assert.equal(intervals.size, 1)
    oldReply(Response.json({ runs: [run] }))
    await h.flush()
    assert.deepEqual(h.render(Probe, { path: "/pick" }), [])
    const beforeEvent = requests
    events.dispatchEvent(new Event(RUNS_CHANGED))
    await h.flush()
    assert.equal(requests, beforeEvent + 1)

    reply = () => new Promise<Response>(resolve => { finish = resolve })
    intervals.get(2)!()
    h.cleanup()
    unmounted = true
    assert.equal(intervals.size, 0)
    const beforeUnmount = requests
    events.dispatchEvent(new Event(RUNS_CHANGED))
    assert.equal(requests, beforeUnmount)
    finish(Response.json({ runs: [run] }))
    await h.flush()
    assert.deepEqual(h.render(Probe, { path: "/pick" }), [])
  } finally {
    if (!unmounted) h.cleanup()
    globalThis.fetch = originalFetch
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    b.cleanup()
  }
})

test("active runs start empty on failure and recover on the next refresh", async () => {
  const b = browser()
  const originalFetch = globalThis.fetch
  const events = new EventTarget()
  globalThis.addEventListener = events.addEventListener.bind(events)
  globalThis.removeEventListener = events.removeEventListener.bind(events)
  let failed = true
  globalThis.fetch = (async () => {
    if (failed) throw new Error("Offline")
    return Response.json({ runs: [{ runId: "recovered", status: "queued", mode: "fix", repoUrl: "repo" }] })
  }) as unknown as typeof fetch
  const h = harness()
  function Probe() { return useActiveRuns("/") }
  try {
    h.render(Probe, {})
    await h.flush()
    assert.deepEqual(h.render(Probe, {}), [])
    failed = false
    events.dispatchEvent(new Event(RUNS_CHANGED))
    await h.flush()
    assert.equal(h.render(Probe, {})[0].runId, "recovered")
  } finally {
    h.cleanup()
    globalThis.fetch = originalFetch
    b.cleanup()
  }
})

for (const component of ["banner", "attempts"]) {
  test(`${component} hides empty state and navigates to an encoded run ID`, () => {
    const b = browser()
    const originals = new Map(["dispatchEvent", "PopStateEvent"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
    const paths: string[] = []
    let dispatched = 0
    history.pushState = (_data, _unused, path) => { paths.push(String(path)) }
    Object.defineProperty(globalThis, "PopStateEvent", { configurable: true, value: Event })
    Object.defineProperty(globalThis, "dispatchEvent", { configurable: true, value: (event: Event) => {
      assert.equal(event.type, "popstate")
      dispatched++
      return true
    } })
    const h = harness()
    const runs = [
      { runId: "first", status: "scanning" as const, repoUrl: "https://github.com/owner/repo", mode: "scan" },
      { runId: "next/run ?#", status: "stopped" as const, repoUrl: "https://github.com/owner/other", mode: "fix" },
    ]
    try {
      if (component === "banner") {
        assert.equal(h.render(ActiveRunBanner, { runs: [] }), null)
        const single = h.render(ActiveRunBanner, { runs: [runs[1]] })
        assert.match(text(single), /owner\/other.*Paused/)
        assert.doesNotMatch(text(single), /more are active/)
        const view = h.render(ActiveRunBanner, { runs: [runs[1], runs[0]] })
        assert.equal(view?.props.role, "status")
        assert.match(text(view), /1 more are active/)
        nodes(view, node => is(node, "button"))[0].props.onClick()
      } else {
        assert.equal(h.render(AttemptPicker, { runId: "first" }), null)
        assert.equal(h.render(AttemptPicker, { runId: "first", attempts: [] }), null)
        assert.equal(h.render(AttemptPicker, { runId: "first", attempts: [runs[0]] }), null)
        const view = nodes(h.render(AttemptPicker, { runId: "first", attempts: runs }), node => is(node, "select"))[0]
        assert.equal(view.props.value, "first")
        assert.equal(view.props["aria-label"], "Attempts")
        const options = nodes(view, node => node.type === "option")
        assert.deepEqual(options.map(node => node.props.value), ["first", "next/run ?#"])
        assert.match(text(options[0]), /1 of 2.*first.*Scanning/)
        assert.match(text(options[1]), /2 of 2.*next\/run.*Paused/)
        view.props.onChange({ target: { value: runs[1].runId } })
      }
      assert.deepEqual(paths, ["/runs/next%2Frun%20%3F%23"])
      assert.equal(dispatched, 1)
    } finally {
      h.cleanup()
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
      b.cleanup()
    }
  })
}
