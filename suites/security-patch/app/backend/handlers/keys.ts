import { constants } from "node:fs"
import { open } from "node:fs/promises"
import type { Context } from "hono"

type Keys = { anthropicApiKey?: string, openaiApiKey?: string, relayAuthToken?: string, ghToken?: string }
const names = { anthropicApiKey: "ANTHROPIC_API_KEY", openaiApiKey: "OPENAI_API_KEY", relayAuthToken: "OLA_AGENT_RELAY_AUTH_TOKEN", ghToken: "GH_TOKEN" } as const
let pending = Promise.resolve()
const line = (envName: string) => new RegExp(`^\\s*(?:export\\s+)?${envName}\\s*=`)

export function maskedKeys(keys: Keys) {
  const mask = (value?: string) => value ? `${value.length > 6 ? value.slice(0, 6) : ""}••••` : null
  return { anthropicApiKey: mask(keys.anthropicApiKey), openaiApiKey: mask(keys.openaiApiKey), relayAuthToken: mask(keys.relayAuthToken), ghToken: mask(keys.ghToken) }
}

// Manual .env edits reach new runs without a restart. Missing provider keys keep their startup values.
export async function reloadKeys(path: string, keys: Keys): Promise<void> {
  await pending
  let current: string
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { current = await file.readFile("utf8") } finally { await file.close() }
  } catch { return }
  const lines = current.split(/\r?\n/)
  for (const [name, envName] of Object.entries(names)) {
    const found = lines.filter(l => line(envName).test(l)).pop()
    if (found !== undefined) keys[name as keyof Keys] = found.slice(found.indexOf("=") + 1).trim().replace(/^(["'])(.*)\1$/, "$2").trim() || undefined
    else if (name === "ghToken") keys.ghToken = undefined
  }
}

export async function handleSaveKeys(c: Context, path: string, keys: Keys): Promise<Response> {
  let body: unknown
  try { body = await c.req.json() } catch { return c.json({ error: "Invalid request" }, 400) }
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "Invalid request" }, 400)
  const entries = Object.entries(body)
  if (!entries.length || entries.some(([name, value]) => !Object.hasOwn(names, name) || typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,512}$/.test(value))) {
    return c.json({ error: "Keys must contain only letters, numbers, dots, underscores, or hyphens" }, 400)
  }
  const save = pending.then(async () => {
    const file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    try {
      await file.chmod(0o600)
      const current = await file.readFile("utf8")
      let lines = current.split(/\r?\n/)
      for (const [name, value] of entries) {
        const envName = names[name as keyof typeof names]
        lines = lines.filter(l => !line(envName).test(l))
        lines.push(`${envName}=${value}`)
      }
      const updated = lines.join("\n").replace(/^\n+/, "") + "\n"
      const written = await file.write(updated, 0, "utf8")
      if (written.bytesWritten !== Buffer.byteLength(updated)) throw new Error("Incomplete write")
      await file.truncate(Buffer.byteLength(updated))
      await file.sync()
      for (const [name, value] of entries) keys[name as keyof Keys] = value as string
    } finally { await file.close() }
  })
  pending = save.catch(() => {})
  try { await save } catch { return c.json({ error: "Could not save keys" }, 500) }
  return c.json(maskedKeys(keys))
}
