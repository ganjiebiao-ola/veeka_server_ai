import { test } from "bun:test"
import assert from "node:assert/strict"
import { RepoProfile } from "../src/components/RepoProfile"
import { RepoSettings } from "../src/components/RepoSettings"
import { LandingPage } from "../src/pages/LandingPage"
import { browser, harness, nodes, text } from "./render"

const url = "https://github.com/owner/new-repo"
const props = { sessionId: "fixture", activeRuns: [], onStarted() {}, startRun: async () => ({ runId: "new", status: "queued" as const }) }

test("The profile shows a spinner while an added repo is detected, then the result", async () => {
  const b = browser("/")
  const originalFetch = globalThis.fetch
  let detect: RequestInit | undefined
  let finish!: (response: Response) => void
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const path = String(input)
    if (path === "/api/repos/detect") { detect = init; return new Promise<Response>(resolve => { finish = resolve }) }
    if (path === "/api/repos") return Response.json({ repos: [{ url, branch: "main", profile: null }] })
    if (path.startsWith("/api/repos/language?")) return Response.json({ language: "PHP", share: 82 })
    return Response.json(path === "/api/providers" ? { claude: { available: true } } : { models: [] })
  }) as typeof fetch
  const h = harness()
  try {
    h.render(LandingPage, props)
    await h.flush()
    h.render(LandingPage, props)
    await h.flush()
    const page = () => h.render(LandingPage, props)
    const profile = () => h.render(RepoProfile, nodes(page(), node => node.type === RepoProfile)[0].props as any)
    assert.match(text(profile()), /The first scan finds these/)
    const pending = (nodes(page(), node => node.type === RepoSettings)[0].props as any).recent.detect(url)
    assert.deepEqual(JSON.parse(String(detect?.body)), { url })
    assert.match(text(profile()), /Detecting language, PHP version and framework…/)
    finish(Response.json({ profile: { language: "php", php: "7.2", framework: "phalcon", sources: [] } }))
    await pending
    assert.match(text(profile()), /PHP 7\.2 · phalcon/)
  } finally { h.cleanup(); globalThis.fetch = originalFetch; b.cleanup() }
})
