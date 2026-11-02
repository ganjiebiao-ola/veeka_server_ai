import { test } from "bun:test"
import assert from "node:assert/strict"
import { useSession } from "../src/hooks/useSession"
import { browser, harness } from "./render"

for (const cached of [false, true]) for (const outcome of ["success", "HTTP", "network"]) {
  test(`session effect replay shares one pending creation after ${cached ? "an expired cache" : "no cache"}, with ${outcome}`, async () => {
    const b = browser("/", cached ? { "ola-agent.sessionId": "expired" } : {})
    const originalFetch = globalThis.fetch
    const pending: { finish: (response: Response) => void, fail: (error: Error) => void }[] = []
    globalThis.fetch = ((input: any, init?: RequestInit) => {
      if (init?.method !== "POST") return Promise.resolve(new Response(null, { status: 404 }))
      assert.equal(input, "/api/sessions")
      return new Promise<Response>((finish, fail) => pending.push({ finish, fail }))
    }) as typeof fetch
    const h = harness()
    function Probe() { return useSession() }
    try {
      h.render(Probe, {})
      await h.flush()
      h.replayEffects()
      await h.flush()
      assert.equal(pending.length, 1)
      assert.deepEqual(h.render(Probe, {}), { sessionId: null, error: null })
      if (outcome === "network") pending[0].fail(new Error("Offline"))
      else pending[0].finish(outcome === "HTTP" ? new Response(null, { status: 503 }) : Response.json({ sessionId: "created" }))
      await h.flush()
      assert.deepEqual(h.render(Probe, {}), { sessionId: outcome === "success" ? "created" : null,
        error: outcome === "success" ? null : outcome === "HTTP" ? "session bootstrap failed: 503" : "Offline" })
      if (outcome !== "success") {
        h.replayEffects()
        await h.flush()
        assert.equal(pending.length, 2)
        pending[1].finish(Response.json({ sessionId: "retry" }))
        await h.flush()
        assert.equal(h.render(Probe, {}).sessionId, "retry")
      }
    } finally {
      h.cleanup()
      globalThis.fetch = originalFetch
      b.cleanup()
    }
  })
}

for (const failure of ["access", "read", "write"] as const) {
  test(`session bootstrap tolerates storage ${failure} failures`, async () => {
    const b = browser()
    if (failure === "access") Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("Blocked") } })
    else localStorage[failure === "read" ? "getItem" : "setItem"] = () => { throw new Error("Blocked") }
    const originalFetch = globalThis.fetch
    const requests: string[] = []
    globalThis.fetch = (async (input: any, init: RequestInit) => {
      requests.push(`${init.method} ${input}`)
      return Response.json({ sessionId: "fixture" }, { status: 201 })
    }) as typeof fetch
    const h = harness()
    function Probe() { return useSession() }
    try {
      h.render(Probe, {})
      await h.flush()
      assert.deepEqual(h.render(Probe, {}), { sessionId: "fixture", error: null })
      assert.deepEqual(requests, ["POST /api/sessions"])
    } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
  })
}

for (const cachedValid of [true, false]) {
  test(`session ${cachedValid ? "reuses a refreshed cache" : "registers again after the cache expires"}`, async () => {
    const b = browser("/", { "ola-agent.sessionId": "cached/id ?" })
    const originalFetch = globalThis.fetch
    const requests: [string, string][] = []
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input)
      requests.push([url, init?.method ?? "GET"])
      if (url.endsWith("/refresh")) return new Response(null, { status: cachedValid ? 204 : 404 })
      return Response.json({ sessionId: "new-session" }, { status: 201 })
    }) as unknown as typeof fetch
    const h = harness()
    function Probe() { return useSession() }
    try {
      assert.deepEqual(h.render(Probe, {}), { sessionId: null, error: null })
      await h.flush()
      assert.deepEqual(h.render(Probe, {}), { sessionId: cachedValid ? "cached/id ?" : "new-session", error: null })
      assert.deepEqual(requests, cachedValid ? [["/api/sessions/cached%2Fid%20%3F/refresh", "GET"]]
        : [["/api/sessions/cached%2Fid%20%3F/refresh", "GET"], ["/api/sessions", "POST"]])
      assert.equal(b.storage.get("ola-agent.sessionId"), cachedValid ? "cached/id ?" : "new-session")
    } finally {
      h.cleanup()
      globalThis.fetch = originalFetch
      b.cleanup()
    }
  })
}

for (const failure of ["bootstrap", "refresh"]) {
  test(`session reports a ${failure} failure without exposing a session`, async () => {
    const b = browser("/", failure === "refresh" ? { "ola-agent.sessionId": "cached" } : {})
    const originalFetch = globalThis.fetch
    let requests = 0
    globalThis.fetch = (async () => {
      requests++
      if (failure === "refresh") throw new Error("Offline")
      return new Response(null, { status: 503 })
    }) as unknown as typeof fetch
    const h = harness()
    function Probe() { return useSession() }
    try {
      h.render(Probe, {})
      await h.flush()
      assert.deepEqual(h.render(Probe, {}), { sessionId: null, error: failure === "refresh" ? "Offline" : "session bootstrap failed: 503" })
      assert.equal(requests, 1)
    } finally {
      h.cleanup()
      globalThis.fetch = originalFetch
      b.cleanup()
    }
  })
}

for (const outcome of ["cached", "created", "error"]) {
  test(`session ignores a late ${outcome} result after unmount`, async () => {
    const b = browser("/", outcome === "cached" ? { "ola-agent.sessionId": "cached" } : {})
    const originalFetch = globalThis.fetch
    let finish!: (response: Response) => void
    globalThis.fetch = (() => new Promise<Response>(resolve => { finish = resolve })) as unknown as typeof fetch
    const h = harness()
    function Probe() { return useSession() }
    try {
      h.render(Probe, {})
      await h.flush()
      h.cleanup()
      finish(outcome === "error" ? new Response(null, { status: 503 }) : Response.json({ sessionId: "late-session" }))
      await h.flush()
      assert.deepEqual(h.render(Probe, {}), { sessionId: null, error: null })
    } finally {
      h.cleanup()
      globalThis.fetch = originalFetch
      b.cleanup()
    }
  })
}
