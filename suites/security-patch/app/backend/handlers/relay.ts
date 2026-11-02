import type { Context } from "hono"

// Model list for the per-run relay channel (a litellm proxy or similar).
// The browser must not call the gateway: this API has no auth layer, and the
// relay key stays on the server. So the UI asks here and gets ids only.
export async function handleRelayModels(
  c: Context,
  deps: { baseUrl?: string; authToken?: string; fetchImpl?: typeof fetch },
): Promise<Response> {
  if (!deps.baseUrl || !deps.authToken) return c.json({ configured: false, models: [] })
  const doFetch = deps.fetchImpl ?? fetch
  const url = `${deps.baseUrl.replace(/\/+$/, "")}/v1/models`
  try {
    const res = await doFetch(url, {
      headers: { Authorization: `Bearer ${deps.authToken}` },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return c.json({ configured: true, models: [], error: `relay returned ${res.status}` }, 502)
    const body = await res.json() as { data?: Array<{ id?: unknown }> }
    const models = [...new Set((body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0))].sort()
    return c.json({ configured: true, models })
  } catch (error) {
    return c.json({ configured: true, models: [], error: `relay unreachable: ${(error as Error).message}` }, 502)
  }
}
