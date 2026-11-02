import { afterAll, beforeAll, test } from "bun:test"
import { strict as assert } from "node:assert"
import { Hono } from "hono"
import { BIND_HOST, buildApp, urlOrigin } from "./server.ts"
import { Store } from "../store/repo.ts"
import { setKnownRepos } from "../tracker/repos.ts"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { RunScannerArgs } from "../docker/controller.ts"

let store: Store
let app: Hono

beforeAll(async () => {
  store = await Store.open(":memory:")
  app = await buildApp({ store, controller: { sweepOrphans: async () => [] } as never })
})

afterAll(() => {
  setKnownRepos(() => [])
  store.close()
})

test("the backend defaults to loopback and allows an explicit compose bind", () => {
  assert.equal(BIND_HOST, process.env["OLA_AGENT_BIND_HOST"] || "127.0.0.1")
  const script = 'import { BIND_HOST } from "./cli/server.ts"\nconsole.log(BIND_HOST)'
  for (const [setting, expected] of [["", "127.0.0.1"], ["0.0.0.0", "0.0.0.0"]]) {
    const result = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, OLA_AGENT_BIND_HOST: setting },
    })
    assert.equal(result.exitCode, 0, result.stderr.toString())
    assert.equal(result.stdout.toString().trim(), expected)
  }
})

test("Hono parses text/plain JSON without a content-type guard", async () => {
  const unguarded = new Hono()
  unguarded.post("/", async c => c.json(await c.req.json()))
  const response = await unguarded.request("/", {
    method: "POST", headers: { "Content-Type": "text/plain" }, body: '{"sessionId":"s1"}',
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { sessionId: "s1" })
})

test("every non-GET request rejects foreign origins before handlers run", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
    for (const origin of ["https://attacker.invalid", "http://localhost:32089", "null"]) {
      const response = await app.request("/api/sessions", { method, headers: { Origin: origin } })
      assert.equal(response.status, 403, `${method} ${origin}`)
      if (method !== "HEAD") assert.deepEqual(await response.json(), { error: "Origin is not allowed" })
    }
  }
})

test("cross-site no-cors JSON cannot reach run or pick handlers", async () => {
  for (const path of ["/api/runs", "/api/pick", "/api/pick/needs-human"]) {
    const response = await app.request(path, {
      method: "POST", headers: { Origin: "https://attacker.invalid", "Content-Type": "text/plain" }, body: "{}",
    })
    assert.equal(response.status, 403)
  }
})

test("Needs human route reaches the row handler", async () => {
  const response = await app.request("/api/pick/needs-human", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{",
  })
  assert.equal(response.status, 400)
  assert.equal(typeof (await response.json()).error, "string")
})

test("JSON bodies require application/json even without Origin", async () => {
  for (const path of ["/api/runs", "/api/pick", "/api/pick/needs-human", "/api/repos", "/api/repos/profile"]) {
    for (const contentType of [undefined, "text/plain", "application/x-www-form-urlencoded", "application/jsonp"]) {
      const headers = contentType ? { "Content-Type": contentType } : undefined
      const response = await app.request(path, { method: path.endsWith("profile") ? "PUT" : "POST", headers, body: "{}" })
      assert.equal(response.status, 415, `${path} ${contentType}`)
    }
  }
  const response = await app.request("/api/runs", {
    method: "POST", headers: { Origin: "http://localhost:32088", "Content-Type": "application/json; charset=utf-8" }, body: "{}",
  })
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: "sessionId required" })
})

test("POST repos saves and updates a repo without starting a run", async () => {
  const request = (body: unknown, origin?: string) => app.request("/api/repos", {
    method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body),
  })
  let response = await request({ url: "  https://github.com/Example/Project.git  ", branch: "  feature/test  " })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, repo: "example/project" })
  assert.deepEqual(store.listRepos().find(r => r.repo === "example/project"), {
    repo: "example/project", url: "https://github.com/Example/Project.git", branch: "feature/test", profile: null, override: null,
  })
  response = await request({ url: "https://github.com/example/project", branch: "main" })
  assert.equal(response.status, 200)
  assert.equal(store.listRepos().filter(r => r.repo === "example/project").length, 1)
  assert.equal(store.listRepos().find(r => r.repo === "example/project")?.branch, "main")
  for (const body of [{ url: "https://example.com/a/b" }, { url: "https://github.com/a/b", branch: "bad..branch" }, { url: "https://github.com/a/b", branch: 42 }]) {
    assert.equal((await request(body)).status, 400)
  }
  assert.equal((await request({ url: "https://github.com/a/b" }, "https://attacker.invalid")).status, 403)
})

test("local UI origins and empty CLI POSTs still work", async () => {
  for (const origin of [undefined, "http://localhost:32088", "http://127.0.0.1:32088"]) {
    const response = await app.request("/api/sessions", {
      method: "POST", headers: origin ? { Origin: origin } : { "Content-Type": "application/x-www-form-urlencoded" }, body: "",
    })
    assert.equal(response.status, 201)
    assert.equal(typeof (await response.json()).sessionId, "string")
  }
  const response = await app.request("/api/runs/missing/stop", { method: "POST", body: "" })
  assert.equal(response.status, 404)
})

test("Host checks block DNS rebinding for reads and writes", async () => {
  for (const host of ["attacker.invalid:37018", "localhost.attacker.invalid", "127.0.0.1.attacker.invalid", "attacker.invalid@localhost"]) {
    for (const method of ["GET", "POST"]) {
      const response = await app.request("/api/health", { method, headers: { Host: host } })
      assert.equal(response.status, 403, `${method} ${host}`)
    }
  }
  for (const host of ["localhost", "127.0.0.1:37018", "LOCALHOST:37018"]) {
    const response = await app.request("/api/health", { headers: { Host: host } })
    assert.equal(response.status, 200, host)
  }
  const response = await app.request("http://attacker.invalid/api/health")
  assert.equal(response.status, 403)
})

test("configured origins replace defaults and accept proxy requests", async () => {
  const previous = process.env["OLA_AGENT_UI_ORIGINS"]
  try {
    process.env["OLA_AGENT_UI_ORIGINS"] = " https://ui.example.test , http://127.0.0.1:32088 "
    const configured = await buildApp({ store, controller: { sweepOrphans: async () => [] } as never })
    const allowed = await configured.request("/api/sessions", {
      method: "POST", headers: { Host: "localhost:37018", Origin: "https://ui.example.test" },
    })
    assert.equal(allowed.status, 201)
    const denied = await configured.request("/api/sessions", {
      method: "POST", headers: { Origin: "http://localhost:32088" },
    })
    assert.equal(denied.status, 403)
  } finally {
    if (previous === undefined) delete process.env["OLA_AGENT_UI_ORIGINS"]
    else process.env["OLA_AGENT_UI_ORIGINS"] = previous
  }
})

test("the boot log shows only the origin of a provider base URL", () => {
  assert.equal(urlOrigin("https://user:pw@relay.example:8443/v1/key-123?token=x"), "https://relay.example:8443")
  assert.equal(urlOrigin("not a url"), "(invalid URL)")
})

test("key settings require a trusted origin and immediately update provider availability", async () => {
  const dir = await mkdtemp(join(tmpdir(), "server-key-"))
  const old = process.env.OLA_AGENT_ENV_PATH
  process.env.OLA_AGENT_ENV_PATH = join(dir, ".env")
  const body = JSON.stringify({ anthropicApiKey: "fixture.key-1234" })
  try {
    const isolated = await buildApp({ store, controller: { sweepOrphans: async () => [] } as never })
    const request = (origin?: string) => isolated.request("/api/setup/keys", { method: "PUT", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body })
    assert.equal((await request()).status, 403)
    assert.equal((await request("https://attacker.invalid")).status, 403)
    const response = await request("http://localhost:32088")
    assert.equal(response.status, 200)
    assert.equal((await response.json()).anthropicApiKey, "fixtur••••")
    assert.match(await readFile(process.env.OLA_AGENT_ENV_PATH!, "utf8"), /ANTHROPIC_API_KEY=fixture.key-1234/)
    assert.equal((await (await isolated.request("/api/providers")).json()).claude.available, true)
    assert.equal((await isolated.request("/api/setup/keys")).headers.get("Cache-Control"), "no-store")
    await writeFile(process.env.OLA_AGENT_ENV_PATH!, "ANTHROPIC_API_KEY=manual-key-5678\n")
    assert.equal((await (await isolated.request("/api/setup/keys")).json()).anthropicApiKey, "manual••••")
    const codexBefore = (await (await isolated.request("/api/providers")).json()).codex
    const saved = await isolated.request("/api/setup/keys", { method: "PUT", headers: { "Content-Type": "application/json", Origin: "http://localhost:32088" }, body: JSON.stringify({ openaiApiKey: "sk-fix" + "ture.key-1234" }) })
    assert.equal((await saved.json()).openaiApiKey, "sk-fix••••")
    const codexAfter = (await (await isolated.request("/api/providers")).json()).codex
    assert.equal(codexAfter.available && codexAfter.apiKey, true)
    assert.equal(codexBefore.apiKey, undefined)
  } finally {
    if (old === undefined) delete process.env.OLA_AGENT_ENV_PATH; else process.env.OLA_AGENT_ENV_PATH = old
    await rm(dir, { recursive: true, force: true })
  }
})


test("quoted blank saved GitHub tokens use the environment fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "github-keys-"))
  const names = ["OLA_AGENT_ENV_PATH", "GH_TOKEN"] as const
  const previous = names.map(name => process.env[name])
  process.env.OLA_AGENT_ENV_PATH = join(dir, ".env")
  process.env.GH_TOKEN = "env.fallback"
  try {
    await writeFile(process.env.OLA_AGENT_ENV_PATH, 'GH_TOKEN="   "\n')
    const isolated = await buildApp({ store, controller: { sweepOrphans: async () => [] } as never })
    const response = await isolated.request("/api/setup/keys")
    assert.equal(response.status, 200)
    assert.equal((await response.json()).ghToken, "env.fa••••")
  } finally {
    for (const [index, name] of names.entries()) {
      if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]
    }
    await rm(dir, { recursive: true, force: true })
  }
})

test("saved GitHub tokens reach the next GitHub calls and run without a restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "github-keys-"))
  const names = ["OLA_AGENT_ENV_PATH", "GH_TOKEN", "OLA_AGENT_GH_TOKEN"] as const
  const previous = names.map(name => process.env[name])
  const originalFetch = globalThis.fetch
  const isolatedStore = await Store.open(":memory:")
  const launches: RunScannerArgs[] = []
  const calls: { kind: string, authorization: string | null }[] = []
  process.env.OLA_AGENT_ENV_PATH = join(dir, ".env")
  process.env.GH_TOKEN = "fixture.environment"
  process.env.OLA_AGENT_GH_TOKEN = "fixture.alias"
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input)
    const query = init?.body ? JSON.parse(String(init.body)).query ?? "" : ""
    const kind = query.includes("object(expression:") ? "tracker" : url.endsWith("/languages") ? "languages" : "github"
    calls.push({ kind, authorization: new Headers(init?.headers).get("Authorization") })
    if (kind === "languages") return Response.json({ PHP: 100 })
    if (url.endsWith("/graphql")) return Response.json({ data: { repository: kind === "tracker"
      ? { object: null } : { pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } })
    return Response.json([])
  }) as typeof fetch
  try {
    isolatedStore.touchRepo("fixture/github-keys", "https://github.com/fixture/github-keys", "main")
    const isolated = await buildApp({ store: isolatedStore, controller: {
      sweepOrphans: async () => [],
      runScanner: (args: RunScannerArgs) => { launches.push(args); throw new Error("fixture launch stopped") },
    } as never })
    const save = (ghToken: string) => isolated.request("/api/setup/keys", {
      method: "PUT", headers: { Origin: "http://localhost:32088", "Content-Type": "application/json" },
      body: JSON.stringify({ ghToken }),
    })
    for (const [index, expected] of ["fixture.environment", "fixture.alias", "fixture.saved-one", "fixture.saved-two"].entries()) {
      if (index === 1) delete process.env.GH_TOKEN
      if (index >= 2) {
        process.env.GH_TOKEN = "fixture.environment"
        const response = await save(expected)
        assert.equal(response.status, 200)
        assert.equal((await response.text()).includes(expected), false)
        assert.match(await readFile(process.env.OLA_AGENT_ENV_PATH!, "utf8"), new RegExp(`GH_TOKEN=${expected}`))
      }
      const keysResponse = await isolated.request("/api/setup/keys")
      assert.equal(keysResponse.headers.get("Cache-Control"), "no-store")
      const keysBody = await keysResponse.text()
      assert.equal(keysBody.includes(expected), false)
      assert.equal(JSON.parse(keysBody).ghToken, "fixtur••••")
      assert.deepEqual(await (await isolated.request("/api/setup")).json(), { githubLogin: true, push: "token" })
      calls.length = 0
      assert.equal((await isolated.request(`/api/repos/language?url=https://github.com/fixture/token-${index}`)).status, 200)
      assert.equal((await isolated.request("/api/overview?repo=fixture/github-keys")).status, 200)
      for (const kind of ["tracker", "languages", "github"]) {
        assert.ok(calls.some(call => call.kind === kind))
      }
      assert.ok(calls.every(call => call.authorization === `Bearer ${expected}`))
      const response = await isolated.request("/api/runs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "github-keys", repoUrl: "https://github.com/fixture/github-keys", skill: "ola-security-audit", model: "haiku", effort: "low", mode: "scan" }),
      })
      assert.equal(response.status, 500)
      assert.equal(launches.length, index + 1)
      assert.equal(launches.at(-1)?.env.GH_TOKEN, expected)
      assert.equal(launches[0].env.GH_TOKEN, "fixture.environment")
    }
    assert.equal((await save("bad\nSETTING=value")).status, 400)
    assert.equal((await save("bad$(command)")).status, 400)
    assert.equal((await (await isolated.request("/api/setup/keys")).json()).ghToken, "fixtur••••")
  } finally {
    globalThis.fetch = originalFetch
    for (const [index, name] of names.entries()) {
      if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]
    }
    setKnownRepos(() => store.listRepos().map(repo => repo.repo))
    isolatedStore.close()
    for (const launch of launches) await rm(dirname(launch.artifactsHostDir), { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
})

test("health exposes developer controls only when OLA_DEV is 1", async () => {
  const previous = process.env["OLA_DEV"];
  try {
    for (const value of [undefined, "0", "1"]) {
      if (value === undefined) delete process.env["OLA_DEV"];
      else process.env["OLA_DEV"] = value;
      const response = await app.request("/api/health");
      assert.deepEqual(await response.json(), { status: "ok", dev: value === "1" });
    }
  } finally {
    if (previous === undefined) delete process.env["OLA_DEV"];
    else process.env["OLA_DEV"] = previous;
  }
});

test("the run PATCH route persists stars and enforces the JSON boundary", async () => {
  store.ensureSession("star-route");
  store.createRun({ runId: "star-route", sessionId: "star-route", repoUrl: "https://github.com/a/b", branch: "main",
    skill: "ola-security-audit", model: "sonnet", effort: "high", mode: "scan" });
  const response = await app.request("/api/runs/star-route", {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: '{"starred":true}',
  });
  assert.equal(response.status, 200);
  assert.equal(store.getRun("star-route")?.starred, true);
  const rejected = await app.request("/api/runs/star-route", {
    method: "PATCH", headers: { "Content-Type": "text/plain" }, body: '{"starred":false}',
  });
  assert.equal(rejected.status, 415);
  assert.equal(store.getRun("star-route")?.starred, true);
});
