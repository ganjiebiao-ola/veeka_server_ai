import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { test } from "bun:test"
import { deepStrictEqual as assertEquals } from "node:assert/strict"
import type { Context } from "hono"
import { handleProviders } from "./providers.ts"

test("providers report login files, missing files and how each provider pays", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const file = `${dir}/login.json`
  await writeFile(file, "not credential JSON")
  let payload: unknown
  const c = { json: (value: unknown) => { payload = value; return new Response() } } as unknown as Context
  try {
    await handleProviders(c, { authMode: "oauth", credentialsHostPath: file, codexAuthHostPath: file, antigravityAuthHostPath: file })
    assertEquals(payload, { claude: { available: true, auth: "subscription" }, codex: { available: true }, antigravity: { available: true }, qoder: { available: false, reason: "No Qoder login on this host. Run `qodercli` to log in or set OLA_AGENT_QODER_AUTH_PATH." } })
    // A subscription host with an API key offers both Claude logins. Settings mode never splits.
    await handleProviders(c, { authMode: "oauth", credentialsHostPath: file, codexAuthHostPath: file, antigravityAuthHostPath: file, hasApiKey: true })
    assertEquals(payload, { claude: { available: true, auth: "subscription", apiKey: true }, codex: { available: true }, antigravity: { available: true }, qoder: { available: false, reason: "No Qoder login on this host. Run `qodercli` to log in or set OLA_AGENT_QODER_AUTH_PATH." } })
    for (const path of [undefined, `${dir}/missing`, dir]) {
      await handleProviders(c, { authMode: "oauth", credentialsHostPath: path, codexAuthHostPath: path, antigravityAuthHostPath: path })
      assertEquals(payload, {
        claude: { available: false, reason: "No Claude login on this host. Run `claude auth login`." },
        codex: { available: false, reason: "No Codex login on this host. Run `codex login`." },
        antigravity: { available: false, reason: "No Antigravity login on this host. Run `agy` or log in." },
        qoder: { available: false, reason: "No Qoder login on this host. Run `qodercli` to log in or set OLA_AGENT_QODER_AUTH_PATH." },
      })
      await handleProviders(c, { authMode: "oauth", credentialsHostPath: path, codexAuthHostPath: path, antigravityAuthHostPath: path, hasApiKey: true })
      assertEquals(payload, {
        claude: { available: true, auth: "api-key" },
        codex: { available: false, reason: "No Codex login on this host. Run `codex login`." },
        antigravity: { available: false, reason: "No Antigravity login on this host. Run `agy` or log in." },
        qoder: { available: false, reason: "No Qoder login on this host. Run `qodercli` to log in or set OLA_AGENT_QODER_AUTH_PATH." },
      })
    }
    for (const authMode of ["settings", "relay"]) {
      await handleProviders(c, { authMode, codexAuthHostPath: file, antigravityAuthHostPath: file, hasApiKey: true })
      assertEquals(payload, { claude: { available: true, auth: "api-key" }, codex: { available: true }, antigravity: { available: true }, qoder: { available: false, reason: "No Qoder login on this host. Run `qodercli` to log in or set OLA_AGENT_QODER_AUTH_PATH." } })
    }
    // Codex: a login file with the key offers both logins; the key alone makes Codex available as an API-key login.
    await writeFile(file, JSON.stringify({ auth_mode: "chatgpt" }))
    await handleProviders(c, { authMode: "oauth", credentialsHostPath: file, codexAuthHostPath: file, hasOpenaiKey: true })
    assertEquals((payload as Record<string, unknown>).codex, { available: true, auth: "subscription", apiKey: true })
    await writeFile(file, "not credential JSON")
    await handleProviders(c, { authMode: "oauth", credentialsHostPath: file, codexAuthHostPath: file, hasOpenaiKey: true })
    assertEquals((payload as Record<string, unknown>).codex, { available: true, apiKey: true })
    // A login file that is itself an API key plus OPENAI_API_KEY reports api-key, so the picker does not split.
    await writeFile(file, JSON.stringify({ auth_mode: "apikey" }))
    await handleProviders(c, { authMode: "oauth", credentialsHostPath: file, codexAuthHostPath: file, hasOpenaiKey: true })
    assertEquals((payload as Record<string, unknown>).codex, { available: true, auth: "api-key", apiKey: true })
    for (const path of [undefined, `${dir}/missing`, dir]) {
      await handleProviders(c, { authMode: "oauth", credentialsHostPath: file, codexAuthHostPath: path, hasOpenaiKey: true })
      assertEquals((payload as Record<string, unknown>).codex, { available: true, auth: "api-key", apiKey: true })
    }
    for (const [mode, auth] of [["chatgpt", "subscription"], ["apikey", "api-key"]]) {
      await writeFile(file, JSON.stringify({ auth_mode: mode }))
      await handleProviders(c, { authMode: "oauth", credentialsHostPath: file, codexAuthHostPath: file, antigravityAuthHostPath: file })
      assertEquals(payload, { claude: { available: true, auth: "subscription" }, codex: { available: true, auth }, antigravity: { available: true }, qoder: { available: false, reason: "No Qoder login on this host. Run `qodercli` to log in or set OLA_AGENT_QODER_AUTH_PATH." } })
    }
  } finally { await rm(dir, { recursive: true }) }
})

test("Qoder availability needs the login directory and both identity files, never an API key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qoder-auth-"))
  let payload: any
  const c = { json: (value: unknown) => { payload = value; return new Response() } } as unknown as Context
  try {
    for (const path of [undefined, `${dir}/missing`, dir]) {
      await handleProviders(c, { authMode: "oauth", qoderAuthHostPath: path, hasApiKey: true, hasOpenaiKey: true })
      assertEquals(payload.qoder.available, false)
    }
    await writeFile(`${dir}/user`, "fixture-user")
    await handleProviders(c, { authMode: "oauth", qoderAuthHostPath: dir })
    assertEquals(payload.qoder.available, false)
    await mkdir(`${dir}/machine_id`)
    await handleProviders(c, { authMode: "oauth", qoderAuthHostPath: dir })
    assertEquals(payload.qoder.available, false)
    await rm(`${dir}/machine_id`, { recursive: true })
    await writeFile(`${dir}/machine_id`, "fixture-machine")
    await handleProviders(c, { authMode: "oauth", qoderAuthHostPath: dir })
    assertEquals(payload.qoder, { available: true })
  } finally { await rm(dir, { recursive: true }) }
})
