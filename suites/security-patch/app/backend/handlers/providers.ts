import { join } from "node:path"
import { PROVIDERS } from "../../shared/providers.ts"
import { readFile, stat } from "node:fs/promises"
import type { Context } from "hono"

export async function loginFileExists(path?: string): Promise<boolean> {
  return path ? await stat(path).then(info => info.isFile(), () => false) : false
}

export async function qoderLoginExists(path?: string): Promise<boolean> {
  return Boolean(path && await loginFileExists(join(path, "user")) && await loginFileExists(join(path, "machine_id")))
}

// How a Codex login pays. Reads only auth_mode, never a key or token.
async function codexAuth(path: string): Promise<"subscription" | "api-key" | undefined> {
  try {
    const mode = (JSON.parse(await readFile(path, "utf8")) as { auth_mode?: unknown }).auth_mode
    return mode === "chatgpt" ? "subscription" : mode === "apikey" ? "api-key" : undefined
  } catch {
    return undefined
  }
}

export async function handleProviders(
  c: Context,
  deps: { authMode: string, credentialsHostPath?: string, codexAuthHostPath?: string, antigravityAuthHostPath?: string, qoderAuthHostPath?: string, hasApiKey?: boolean, hasOpenaiKey?: boolean },
): Promise<Response> {
  const claude = deps.authMode !== "oauth" || await loginFileExists(deps.credentialsHostPath)
  const codex = await loginFileExists(deps.codexAuthHostPath)
  const codexMode = codex ? await codexAuth(deps.codexAuthHostPath!) : undefined
  const antigravity = await loginFileExists(deps.antigravityAuthHostPath)
  const qoder = await qoderLoginExists(deps.qoderAuthHostPath)
  const availability = {
    claude: claude || deps.hasApiKey
      // apiKey: a subscription host that also has ANTHROPIC_API_KEY offers both logins per run.
      ? { available: true, auth: claude && deps.authMode === "oauth" ? "subscription" : "api-key", ...(claude && deps.authMode === "oauth" && deps.hasApiKey ? { apiKey: true } : {}) }
      : { available: false, reason: "No Claude login on this host. Run `claude auth login`." },
    codex: codex || deps.hasOpenaiKey
      // apiKey: OPENAI_API_KEY exists, so a run may use it. Without a login file it is the only login.
      ? { available: true, ...(codexMode ? { auth: codexMode } : codex ? {} : { auth: "api-key" }), ...(deps.hasOpenaiKey ? { apiKey: true } : {}) }
      : { available: false, reason: "No Codex login on this host. Run `codex login`." },
    qoder: qoder ? { available: true }
      : { available: false, reason: "No Qoder login on this host. Run `qodercli` to log in or set OLA_AGENT_QODER_AUTH_PATH." },
    antigravity: antigravity
      ? { available: true }
      : { available: false, reason: "No Antigravity login on this host. Run `agy` or log in." },
  }
  return c.json(Object.fromEntries(Object.entries(PROVIDERS).map(([id, provider]) => [id,
    provider.unavailableReason ? { available: false, reason: provider.unavailableReason }
      : availability[provider.auth as keyof typeof availability],
  ])))
}
