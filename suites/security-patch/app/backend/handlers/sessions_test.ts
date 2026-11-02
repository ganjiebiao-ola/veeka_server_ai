import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp, rm } from "node:fs/promises"
import { test } from "bun:test"
import assert from "node:assert/strict"
import { Hono } from "hono"
import { Store } from "../store/repo.ts"
import { handleRefreshSession } from "./sessions.ts"

test("session refresh refuses bad ids and unknown sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const store = await Store.open(`${dir}/t.sqlite`)
  try {
    const app = new Hono().get("/api/sessions/:id/refresh", (c) => handleRefreshSession(c, { store }))
    const id = crypto.randomUUID()
    const status = async (sid: string) => (await app.request(`/api/sessions/${sid}/refresh`)).status
    assert.equal(await status("not-a-uuid"), 400)
    assert.equal(await status(id), 404)
    store.ensureSession(id)
    assert.equal(await status(id), 200)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
