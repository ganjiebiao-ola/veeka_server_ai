import type { Context } from "hono"
import { GitHubClient, operatorToken } from "../tracker/client.ts"
import { resolveTracker } from "../tracker/repos.ts"

export async function handleReadPR(c: Context, suppliedClient?: Pick<GitHubClient, "readPR">, getGhToken?: () => Promise<string | undefined>): Promise<Response> {
  let repo: string
  try { repo = resolveTracker(c.req.query("repo")) }
  catch (error) { return c.json({ error: (error as Error).message }, 400) }
  const raw = c.req.param("number") ?? ""
  const number = Number(raw)
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(number)) return c.json({ error: "invalid PR number" }, 400)
  try {
    const client = suppliedClient ?? new GitHubClient(repo, await operatorToken(getGhToken))
    return c.json(await client.readPR(number))
  } catch (error) {
    return c.json({ error: (error as Error).message }, 502)
  }
}
