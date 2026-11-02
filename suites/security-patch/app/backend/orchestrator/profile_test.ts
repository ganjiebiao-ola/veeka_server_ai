import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "bun:test"
import { deepStrictEqual as assertEquals } from "node:assert/strict"
import type { Context } from "hono"
import { Store } from "../store/repo.ts"
import { handleSetProfile } from "../handlers/repos.ts"
import { importProfile, profileData } from "./profile.ts"

const detected = { language: "php", php: "7.2", framework: "phalcon", sources: [{ field: "php" as const, value: "7.2", file: "deploy/deploy_fpm.sh" }] }

test("profile data keeps valid fields and refuses invalid values", () => {
  assertEquals(profileData(detected), detected)
  assertEquals(profileData({ ...detected, sources: [...detected.sources, { field: "shell", value: "x", file: "y" }] }), detected)
  assertEquals(profileData({ ...detected, php: "7.2; rm -rf" }), undefined)
  assertEquals(profileData({ ...detected, framework: "Phalcon<script>" }), undefined)
  assertEquals(profileData("nope"), undefined)
})

test("a scan saves the detected profile, and the operator override stays separate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-profile-"))
  const store = await Store.open(`${dir}/test.sqlite`)
  const put = async (body: unknown) => {
    let status = 200
    await handleSetProfile({ req: { json: () => Promise.resolve(body) }, json: (_: unknown, s = 200) => { status = s; return new Response() } } as unknown as Context, { store })
    return status
  }
  try {
    assertEquals(await put({ url: "https://github.com/a/b", php: "7.2" }), 404)
    store.touchRepo("a/b", "https://github.com/a/b", "")
    await writeFile(join(dir, "profile.json"), JSON.stringify(detected))
    importProfile("r1", dir, store, "https://github.com/A/B")
    assertEquals(store.listRepos()[0].profile, detected)
    assertEquals(store.listRepos()[0].override, null)

    assertEquals(await put({ url: "https://github.com/a/b", php: "8.1", framework: "Laravel" }), 200)
    assertEquals(store.listRepos()[0].override, { php: "8.1", framework: "laravel" })
    assertEquals(store.listRepos()[0].profile, detected)
    assertEquals(await put({ url: "https://github.com/a/b", php: "eight" }), 400)
    assertEquals(await put({ url: "https://github.com/a/b", php: "", framework: "" }), 200)
    assertEquals(store.profileOverride("a/b"), null)
  } finally {
    store.close()
    await rm(dir, { recursive: true })
  }
})
