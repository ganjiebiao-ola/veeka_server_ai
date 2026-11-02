import { expect, test } from "bun:test"
import { Hono } from "hono"
import { handleRepoLanguage } from "./repos.ts"

test("selects the largest language, rounds its share, and caches by repo", async () => {
  let calls = 0
  const app = new Hono().get("/", c => handleRepoLanguage(c, { client: async repo => {
    expect(repo).toBe("language-test/plurality")
    calls++
    return { languages: async () => ({ TypeScript: 2, JavaScript: 2, CSS: 1 }) }
  } }))
  const first = await app.request("/?url=https://github.com/Language-Test/Plurality")
  expect(first.status).toBe(200)
  expect(await first.json()).toEqual({ language: "TypeScript", share: 40 })
  const second = await app.request("/?url=language-test/plurality")
  expect(await second.json()).toEqual({ language: "TypeScript", share: 40 })
  expect(calls).toBe(1)
})

test("rounds shares and returns an empty result", async () => {
  const app = new Hono().get("/", c => handleRepoLanguage(c, { client: async repo => ({
    languages: async (): Promise<Record<string, number>> => repo.endsWith("empty") ? {} : { Go: 2, Rust: 1 },
  }) }))
  expect(await (await app.request("/?url=language-test/rounding")).json()).toEqual({ language: "Go", share: 67 })
  expect(await (await app.request("/?url=language-test/empty")).json()).toEqual({ language: null, share: 0 })
})

test("rejects a non-GitHub URL", async () => {
  const app = new Hono().get("/", c => handleRepoLanguage(c))
  const response = await app.request("/?url=https://gitlab.com/owner/repo")
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: "url must be a GitHub repository" })
})

test("rejects dot-only repository components", async () => {
  const app = new Hono().get("/api/repos/language", c => handleRepoLanguage(c))
  const response = await app.request("/api/repos/language?url=https://github.com/../user")
  expect(response.status).toBe(400)
})

test("refreshes languages after five minutes", async () => {
  const originalNow = Date.now
  let now = 1_000
  Date.now = () => now
  try {
    let calls = 0
    const app = new Hono().get("/", c => handleRepoLanguage(c, { client: async () => ({
      languages: async () => { calls++; return { Go: 1 } },
    }) }))
    await app.request("/?url=language-test/expiry")
    now += 5 * 60_000 - 1
    await app.request("/?url=language-test/expiry")
    expect(calls).toBe(1)
    now++
    await app.request("/?url=language-test/expiry")
    expect(calls).toBe(2)
  } finally { Date.now = originalNow }
})

test("does not cache GitHub failures", async () => {
  let calls = 0
  const app = new Hono().get("/", c => handleRepoLanguage(c, { client: async () => ({ languages: async () => {
    if (++calls === 1) throw new Error("failed")
    return { Go: 1 }
  } }) }))
  const response = await app.request("/?url=language-test/failure")
  expect(response.status).toBe(502)
  expect(await response.json()).toEqual({ error: "could not read the repo languages. Check gh auth login or GH_TOKEN." })
  expect(await (await app.request("/?url=language-test/failure")).json()).toEqual({ language: "Go", share: 100 })
  expect(calls).toBe(2)
})
