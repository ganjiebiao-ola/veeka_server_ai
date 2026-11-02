import { test } from "bun:test"
import { strict as assert } from "node:assert"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GitHubClient, operatorToken } from "./client.ts"
import { GitHubTrackerStore } from "./store.ts"

test("tracker uses an explicit token before the gh login", async () => {
  const dir = await mkdtemp(join(tmpdir(), "operator-token-"))
  try {
    await writeFile(join(dir, "gh"), "#!/bin/sh\nprintf fixture-gh-login\n")
    await chmod(join(dir, "gh"), 0o755)
    const script = 'import { operatorToken } from "./tracker/client.ts"; console.log(await operatorToken())'
    for (const [ghToken, alias, expected] of [
      ["fixture-explicit", "fixture-alias", "fixture-explicit"],
      ["", "fixture-alias", "fixture-alias"],
      ["", "", "fixture-gh-login"],
    ]) {
      const result = Bun.spawnSync([process.execPath, "-e", script], {
        cwd: new URL("..", import.meta.url).pathname,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, HOME: dir, GH_TOKEN: ghToken, OLA_AGENT_GH_TOKEN: alias, GITHUB_TOKEN: "" },
      })
      assert.equal(result.exitCode, 0)
      assert.equal(result.stdout.toString().trim(), expected)
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("the selected token authenticates tracker-file and PR reads", async () => {
  const originalFetch = globalThis.fetch
  const originalToken = process.env.GH_TOKEN
  const seen: string[] = []
  process.env.GH_TOKEN = "fixture.fine-grained"
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get("Authorization") ?? "")
    if (String(input).endsWith("/graphql")) {
      return Response.json({ data: { repository: { object: { entries: [] } } } })
    }
    return Response.json({ state: "open", merged_at: null })
  }) as typeof fetch
  try {
    const token = await operatorToken()
    const store = new GitHubTrackerStore("fixture/repo", token, "fixture/tracker")
    const client = new GitHubClient("fixture/repo", token)
    assert.deepEqual(await store.read(), [])
    assert.equal(await client.prState(123), "open")
    assert.deepEqual(seen, ["Bearer fixture.fine-grained", "Bearer fixture.fine-grained"])
  } finally {
    globalThis.fetch = originalFetch
    if (originalToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = originalToken
  }
})

test("the gh login token is read once until GitHub answers 401", async () => {
  const dir = await mkdtemp(join(tmpdir(), "operator-token-"))
  try {
    await writeFile(join(dir, "gh"), `#!/bin/sh\necho x >> "${dir}/calls"\nprintf fixture-gh-login\n`)
    await chmod(join(dir, "gh"), 0o755)
    const script = `import { GitHubClient, operatorToken } from "./tracker/client.ts"
      const tokens = [await operatorToken(), await operatorToken()]
      globalThis.fetch = async () => new Response("{}", { status: 401 })
      await new GitHubClient("fixture/repo", tokens[0]).languages().catch(() => {})
      tokens.push(await operatorToken())
      console.log(tokens.join(","))`
    const result = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, HOME: dir, GH_TOKEN: "", OLA_AGENT_GH_TOKEN: "", GITHUB_TOKEN: "" },
    })
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout.toString().trim(), "fixture-gh-login,fixture-gh-login,fixture-gh-login")
    assert.equal((await Bun.file(join(dir, "calls")).text()).trim().split("\n").length, 2)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
