import { afterEach, expect, test } from "bun:test"
import { Hono } from "hono"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Store } from "../store/repo.ts"
import { handleDetectProfile } from "./repos.ts"

const url = "https://github.com/owner/app"
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

function tarball(): Uint8Array<ArrayBuffer> {
  const root = mkdtempSync(join(tmpdir(), "detect-fixture-"))
  try {
    mkdirSync(join(root, "owner-app-abc123/app"), { recursive: true })
    writeFileSync(join(root, "owner-app-abc123/.php-version"), "7.2\n")
    writeFileSync(join(root, "owner-app-abc123/app/Main.php"), "<?php\nuse Phalcon\\Mvc\\Application;\n")
    const tar = Bun.spawnSync(["tar", "-czf", "-", "-C", root, "owner-app-abc123"])
    if (tar.exitCode !== 0) throw new Error("tar failed")
    return new Uint8Array(tar.stdout)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

async function setup(fetch: (url: string, init?: RequestInit) => Promise<Response>) {
  const store = await Store.open(":memory:")
  store.touchRepo("owner/app", url, "release/1")
  globalThis.fetch = fetch as typeof globalThis.fetch
  const app = new Hono().post("/", c => handleDetectProfile(c, { store, getGhToken: async () => "test-token" }))
  const detect = async () => (await app.request("/", { method: "POST", body: JSON.stringify({ url }) })).json()
  return { store, detect }
}

const profileDirs = () => readdirSync(tmpdir()).filter(name => name.startsWith("repo-profile-")).length

test("detects once from the branch tarball, saves it, and cleans up", async () => {
  const bytes = tarball()
  const requests: { url: string, auth: string | null }[] = []
  const dirs = profileDirs()
  const { store, detect } = await setup(async (url, init) => {
    requests.push({ url, auth: new Headers(init?.headers).get("Authorization") })
    await Bun.sleep(20)
    return new Response(bytes)
  })
  const [first, second] = await Promise.all([detect(), detect()])
  expect(first.profile).toMatchObject({ language: "php", php: "7.2", framework: "phalcon" })
  expect(second).toEqual(first)
  expect(requests).toEqual([{ url: "https://api.github.com/repos/owner/app/tarball/release/1", auth: "Bearer test-token" }])
  expect(store.listRepos()[0].profile).toEqual(first.profile)
  expect(await detect()).toEqual(first)
  expect(requests.length).toBe(1)
  expect(profileDirs()).toBe(dirs)
})

test("keeps a profile a scan saved during detection", async () => {
  const bytes = tarball()
  const scanned = { language: "php", php: "8.1", framework: "laravel", sources: [] }
  const { store, detect } = await setup(async () => {
    store.saveProfile("owner/app", scanned)
    return new Response(bytes)
  })
  expect((await detect()).profile).toEqual(scanned)
  expect(store.listRepos()[0].profile).toEqual(scanned)
})

test("a failed download leaves the profile null", async () => {
  const { store, detect } = await setup(async () => new Response("not found", { status: 404 }))
  expect(await detect()).toEqual({ profile: null })
  expect(store.listRepos()[0].profile).toBeNull()
})

test("a corrupt tarball leaves the profile null", async () => {
  const { store, detect } = await setup(async () => new Response("not a tarball"))
  expect(await detect()).toEqual({ profile: null })
  expect(store.listRepos()[0].profile).toBeNull()
})

test("an unknown repo is 404", async () => {
  const store = await Store.open(":memory:")
  const app = new Hono().post("/", c => handleDetectProfile(c, { store }))
  expect((await app.request("/", { method: "POST", body: JSON.stringify({ url }) })).status).toBe(404)
})
