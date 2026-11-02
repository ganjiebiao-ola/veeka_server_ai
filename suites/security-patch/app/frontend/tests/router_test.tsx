import { test } from "bun:test"
import assert from "node:assert/strict"
import { navigate, usePath, useRepoParam } from "../src/router"
import { browser, harness } from "./render"

test("navigation and Back synchronize the path and repository, and unmount removes listeners", async () => {
  const b = browser("/pick?repo=owner/repo")
  const keys = ["addEventListener", "removeEventListener", "dispatchEvent", "PopStateEvent"] as const
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const listeners = new Set<() => void>()
  const pushes: string[] = []
  const storage = new Map<string, string>()
  let events = 0
  const values = {
    addEventListener(type: string, listener: () => void) {
      assert.equal(type, "popstate")
      listeners.add(listener)
    },
    removeEventListener(type: string, listener: () => void) {
      assert.equal(type, "popstate")
      listeners.delete(listener)
    },
    dispatchEvent(event: Event) {
      assert.equal(event.type, "popstate")
      events++
      listeners.forEach(listener => listener())
      return true
    },
    PopStateEvent: Event,
  }
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  sessionStorage.getItem = key => storage.get(key) ?? null
  sessionStorage.setItem = (key, value) => { storage.set(key, value) }
  history.pushState = (_data, _unused, url) => {
    pushes.push(String(url))
    history.replaceState(null, "", url)
  }
  const h = harness()
  function Probe() {
    const path = usePath()
    const [repo, choose] = useRepoParam()
    return { path, repo, choose }
  }
  try {
    let state = h.render(Probe, {})
    assert.equal(state.path, "/pick")
    assert.equal(state.repo, "owner/repo")
    await h.flush()
    assert.equal(listeners.size, 2)
    state.choose("other/repo +")
    state = h.render(Probe, {})
    assert.equal(state.repo, "other/repo +")
    assert.equal(location.search, "?repo=other%2Frepo%20%2B")
    assert.equal(storage.get("secpatch.repo"), "other/repo +")
    navigate("/overview")
    state = h.render(Probe, {})
    assert.equal(state.path, "/overview")
    assert.equal(state.repo, "other/repo +")
    navigate("/overview")
    assert.deepEqual(pushes, ["/overview"])
    assert.equal(events, 2)
    history.replaceState(null, "", "/pick?repo=owner/repo")
    dispatchEvent(new PopStateEvent("popstate"))
    state = h.render(Probe, {})
    assert.equal(state.path, "/pick")
    assert.equal(state.repo, "owner/repo")
    h.cleanup()
    assert.equal(listeners.size, 0)
  } finally {
    h.cleanup()
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    b.cleanup()
  }
})

test("repository selection still updates the URL when tab storage is blocked", async () => {
  const b = browser("/overview")
  const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")!
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get() { throw new Error("Blocked") } })
  const h = harness()
  function Probe() { return useRepoParam() }
  try {
    const [repo, choose] = h.render(Probe, {})
    assert.equal(repo, null)
    await h.flush()
    choose("owner/repo")
    assert.equal(h.render(Probe, {})[0], "owner/repo")
    assert.equal(location.pathname, "/overview")
    assert.equal(location.search, "?repo=owner%2Frepo")
  } finally {
    h.cleanup()
    Object.defineProperty(globalThis, "sessionStorage", original)
    b.cleanup()
  }
})
