import { test } from "bun:test"
import { strict as assert } from "node:assert"
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { handleSaveKeys, maskedKeys, reloadKeys } from "./keys.ts"
import { providerSelection } from "./runs.ts"

test("removing a saved GitHub token clears its cached value", async () => {
  const dir = await mkdtemp(join(tmpdir(), "key-settings-"))
  const path = join(dir, ".env")
  const keys = { ghToken: undefined as string | undefined, anthropicApiKey: "fixture.api" }
  try {
    await writeFile(path, "GH_TOKEN=fixture.saved\n")
    await reloadKeys(path, keys)
    assert.equal(keys.ghToken, "fixture.saved")
    await writeFile(path, "OTHER=preserved\n")
    await reloadKeys(path, keys)
    assert.equal(keys.ghToken, undefined)
    assert.equal(keys.anthropicApiKey, "fixture.api")
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("key updates preserve other settings, mask responses, and reach new provider selections", async () => {
  const dir = await mkdtemp(join(tmpdir(), "key-settings-"))
  const path = join(dir, ".env")
  const keys = { anthropicApiKey: "old-key", openaiApiKey: undefined as string | undefined, relayAuthToken: "old.relay" }
  const app = new Hono().put("/", c => handleSaveKeys(c, path, keys))
  const save = (body: unknown) => app.request("/", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  try {
    await writeFile(path, "OTHER=preserved\nexport ANTHROPIC_API_KEY=old-key\nANTHROPIC_API_KEY=duplicate\n", { mode: 0o644 })
    const response = await save({ anthropicApiKey: "fixture.new-1234", relayAuthToken: "relay-x.5678" })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { anthropicApiKey: "fixtur••••", openaiApiKey: null, relayAuthToken: "relay-••••", ghToken: null })
    assert.deepEqual(maskedKeys({ anthropicApiKey: "abc" }), { anthropicApiKey: "••••", openaiApiKey: null, relayAuthToken: null, ghToken: null })
    assert.equal(await readFile(path, "utf8"), "OTHER=preserved\n\nANTHROPIC_API_KEY=fixture.new-1234\nOLA_AGENT_RELAY_AUTH_TOKEN=relay-x.5678\n")
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.equal(providerSelection("api-key", keys).env.ANTHROPIC_API_KEY, "fixture.new-1234")
    assert.equal(providerSelection("relay", keys).env.ANTHROPIC_AUTH_TOKEN, "relay-x.5678")
    for (const body of [{ anthropicApiKey: "bad\nOTHER=oops" }, { anthropicApiKey: "$(touch-pwned)" }, { unknown: "abc" }, JSON.parse('{"__proto__":"abc"}')]) {
      assert.equal((await save(body)).status, 400)
    }
    assert.equal(keys.anthropicApiKey, "fixture.new-1234")
    assert.equal((await readFile(path, "utf8")).includes("OTHER=oops"), false)
    await Promise.all([save({ anthropicApiKey: "next.1234" }), save({ relayAuthToken: "next.5678" })])
    assert.match(await readFile(path, "utf8"), /ANTHROPIC_API_KEY=next.1234/)
    assert.match(await readFile(path, "utf8"), /OLA_AGENT_RELAY_AUTH_TOKEN=next.5678/)
    const openai = await save({ openaiApiKey: "sk-fix" + "ture.9999" })
    assert.equal(openai.status, 200)
    assert.equal((await openai.json()).openaiApiKey, "sk-fix••••")
    assert.match(await readFile(path, "utf8"), /^OPENAI_API_KEY=sk-fixture.9999$/m)
    assert.equal(keys.openaiApiKey, "sk-fixture.9999")
    await writeFile(path, "ANTHROPIC_API_KEY=\"manual.1234\"\nOPENAI_API_KEY=manual.openai1\n# OLA_AGENT_RELAY_AUTH_TOKEN=commented\n")
    await reloadKeys(path, keys)
    assert.deepEqual(keys, { anthropicApiKey: "manual.1234", openaiApiKey: "manual.openai1", relayAuthToken: "next.5678", ghToken: undefined })
    await reloadKeys(join(dir, "missing"), keys)
    assert.equal(keys.anthropicApiKey, "manual.1234")
    const link = join(dir, "link")
    await symlink(path, link)
    const other = new Hono().put("/", c => handleSaveKeys(c, link, keys))
    assert.equal((await other.request("/", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ anthropicApiKey: "unsafe" }) })).status, 500)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
