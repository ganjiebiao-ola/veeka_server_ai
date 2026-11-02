import { test } from "bun:test"
import assert from "node:assert/strict"
import React from "react"
import { RunRoute } from "../src/pages/RunRoute"
import { RunPage } from "../src/pages/RunPage"

for (const refreshFails of [false, true]) {
  test(`stream errors keep the live view and completion fetches once (refresh fails: ${refreshFails})`, async () => {
    // Run the actual component effects without adding a DOM test dependency.
    const dispatcher = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
    const originalDispatcher = dispatcher.current
    const originalFetch = globalThis.fetch
    const originalEventSource = globalThis.EventSource
    const states = new Map<Function, any[]>()
    const cleanups: (() => void)[] = []
    let slots: any[] = []
    let index = 0
    let effects: (() => void)[] = []
    let requests = 0
    let failFetch = false
    let stream: any
    const sameDeps = (a: any[], b: any[]) => a && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
    dispatcher.current = {
      useContext: (context: any) => context._currentValue,
      useState(initial: any) {
        const current = slots
        const i = index++
        if (!(i in current)) current[i] = typeof initial === "function" ? initial() : initial
        return [current[i], (value: any) => { current[i] = typeof value === "function" ? value(current[i]) : value }]
      },
      useEffect(effect: () => void | (() => void), deps: any[]) {
        const i = index++
        if (!sameDeps(slots[i], deps)) effects.push(() => {
          const cleanup = effect()
          if (cleanup) cleanups.push(cleanup)
        })
        slots[i] = deps
      },
      useCallback(callback: Function, deps: any[]) {
        const i = index++
        if (!slots[i] || !sameDeps(slots[i].deps, deps)) slots[i] = { callback, deps }
        return slots[i].callback
      },
      useRef(initial: any) {
        const i = index++
        if (!(i in slots)) slots[i] = { current: initial }
        return slots[i]
      },
    }
    globalThis.EventSource = class {
      constructor() { stream = this }
      close() {}
    } as unknown as typeof EventSource
    globalThis.fetch = (async () => {
      requests++
      return failFetch ? new Response(null, { status: 503 }) : Response.json({
        runId: "fixture", status: "scanning", mode: "scan", repoUrl: "https://github.com/example/repo",
      })
    }) as unknown as typeof fetch
    function render(component: Function, props: any) {
      if (!states.has(component)) states.set(component, [])
      slots = states.get(component)!
      index = 0
      return component(props)
    }
    async function flush() {
      for (const effect of effects.splice(0)) effect()
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    function renderLive() {
      const child = render(RunRoute, { runId: "fixture" })
      assert.equal(child.type, RunPage)
      render(child.type, child.props)
    }
    try {
      render(RunRoute, { runId: "fixture" })
      await flush()
      renderLive()
      await flush()
      assert.equal(requests, 2)
      stream.onmessage({ data: JSON.stringify({ type: "run_status", status: "scanning" }) })
      stream.onerror()
      for (let i = 0; i < 3; i++) { renderLive(); await flush() }
      assert.equal(requests, 2)
      assert.equal(states.get(RunPage)![0].status, "scanning")
      stream.onopen()
      assert.equal(states.get(RunPage)![0].error, undefined)
      failFetch = refreshFails
      stream.onmessage({ data: JSON.stringify({ type: "run_status", status: "failed" }) })
      for (let i = 0; i < 6; i++) { renderLive(); await flush() }
      assert.equal(requests, 3)
    } finally {
      for (const cleanup of cleanups) cleanup()
      dispatcher.current = originalDispatcher
      globalThis.fetch = originalFetch
      globalThis.EventSource = originalEventSource
    }
  })
}
