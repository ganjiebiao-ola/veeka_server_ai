import type { Context } from "hono"
import { operatorToken } from "../tracker/client.ts"

// What the tool needs to post findings and push PRs. Yes/no only, never secret values.
//  - githubLogin: `gh auth` or GH_TOKEN works for the issue API.
//  - push: how the scanner container pushes PR branches.
export async function handleSetup(
  c: Context,
  deps: { getGhToken?: () => Promise<string | undefined> },
  login: () => Promise<unknown> = () => operatorToken(deps.getGhToken),
): Promise<Response> {
  const githubLogin = await login().then(() => true, () => false)
  return c.json({
    githubLogin,
    push: await deps.getGhToken?.() ? "token" : null,
  })
}
