import { test } from "bun:test"
import assert from "node:assert/strict"
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import type { Context } from "hono"
import type { RunScannerArgs } from "../docker/controller.ts"
import { Store } from "../store/repo.ts"
import { handleRunArtifact, handleStartRun } from "./runs.ts"
import { loadRepoContext, relatedRepoDirs, relatedRepoIds } from "./repo_context.ts"
import type { RunInput } from "./repo_context.ts"

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "repo-context-"))
  const write = async (path: string, content: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  await write("workspace.yaml", "repo_catalog:\n  org: <github-org>\n  repos: []\n")
  await write("workspace.local.yaml", "repositories:\n  - id: other\n    path: repos/other\n  - id: target\n    path: repos/target\n")
  await write("repos/target/.git/config", '[remote "origin"]\n\turl = git@github.com:acme/target.git\n')
  await write("repos/other/.git/config", '[remote "origin"]\n\turl = https://github.com/acme/other\n')
  return { root, write }
}

test("repo context matches the mounted repo by its origin, with safety defaults and no rules", async () => {
  const { root, write } = await fixture()
  try {
    const paths = [
      "agent-instructions/security-defaults.md", "team-context/security-defaults.team.md",
      "team-context/mounted-repos/target.md",
      "knowledge/maps/target/architecture.md", "knowledge/maps/target/services/api.md",
      "knowledge/bug-fixes/target/sqli.md", "knowledge/bug-fixes/target.md",
    ]
    for (const path of paths) await write(path, `reference: ${path}`)
    for (const path of ["team-context/mounted-repos/other.md", "knowledge/maps/other.md",
      "knowledge/maps/other/architecture.md", "knowledge/bug-fixes/other/sqli.md", "knowledge/maps/overview.md",
      "rules/testing.md", "rules/.env", "rules/credentials.json"]) await write(path, "unrelated content")

    const documents = await loadRepoContext("git@github.com:ACME/Target.git", root)
    assert.deepEqual(documents.map(doc => doc.path).sort(), paths.sort())
    assert.ok(documents.every(doc => doc.content === `reference: ${doc.path}`))
    const otherOwner = await loadRepoContext("https://github.com/someone/target", root)
    assert.deepEqual(otherOwner.map(doc => doc.path).sort(), [
      "agent-instructions/security-defaults.md", "team-context/security-defaults.team.md",
    ].sort())
  } finally { await rm(root, { recursive: true }) }
})

test("missing and invalid workspace sources do not fail repo context", async () => {
  const { root, write } = await fixture()
  try {
    assert.deepEqual(await loadRepoContext("acme/target", root), [])
    await write("team-context/mounted-repos/target.md", "entry point: app/main.py")
    assert.equal((await loadRepoContext("acme/target", root))[0]?.content, "entry point: app/main.py")
    await write("workspace.local.yaml", "repositories: [")
    assert.deepEqual(await loadRepoContext("acme/target", root), [])
    await write("workspace.local.yaml", "repositories:\n  - id: target\n    path: ../outside\n")
    assert.deepEqual(await loadRepoContext("acme/target", root), [])
    await rm(join(root, "workspace.yaml"))
    assert.deepEqual(await loadRepoContext("acme/target", root), [])
    assert.deepEqual(await loadRepoContext("acme/target", join(root, "missing")), [])
    await write("workspace.yaml", "")
    await write("workspace.local.yaml", "repositories: invalid\n")
    assert.deepEqual(await loadRepoContext("acme/target", root), [])
  } finally { await rm(root, { recursive: true }) }
})

test("repo context rejects symlink files and directories", async () => {
  const { root, write } = await fixture()
  const outside = await mkdtemp(join(tmpdir(), "repo-context-outside-"))
  try {
    await write("other/context.md", "other repository context")
    await writeFile(join(outside, "outside.md"), "outside context")
    await mkdir(join(root, "team-context/mounted-repos"), { recursive: true })
    await symlink(join(root, "other/context.md"), join(root, "team-context/mounted-repos/target.md"))
    await mkdir(join(root, "knowledge/maps"), { recursive: true })
    await symlink(outside, join(root, "knowledge/maps/target"))
    await mkdir(join(root, "rules"))
    await symlink(join(outside, "outside.md"), join(root, "rules/outside.md"))
    const inputs: RunInput[] = []
    assert.deepEqual(await loadRepoContext("acme/target", root, undefined, inputs), [])
    assert.deepEqual(inputs.map(input => [input.path, input.reason]), [
      ["team-context/mounted-repos/target.md", "symlink"], ["knowledge/maps/target", "symlink"],
    ])
  } finally {
    await rm(root, { recursive: true })
    await rm(outside, { recursive: true })
  }
})

test("repo context scrubs credentials before creating the artifact", async () => {
  const { root, write } = await fixture()
  const fakeKey = "sk-" + "X".repeat(32)
  const fakePassword = ["fixture", "password", "value"].join("-")
  try {
    await write("team-context/mounted-repos/target.md", `api_key=${fakeKey}\npostgres://user:${fakePassword}@localhost/test`)
    const documents = await loadRepoContext("acme/target", root)
    assert.equal(documents.length, 1)
    assert.ok(!documents[0].content.includes(fakeKey))
    assert.ok(!documents[0].content.includes(fakePassword))
    assert.match(documents[0].content, /已脱敏/)
  } finally { await rm(root, { recursive: true }) }
})

test("input records scrub secrets from included and dropped paths", async () => {
  const { root, write } = await fixture()
  const fakeKey = "sk-" + "X".repeat(32)
  const fakeConfigured = "fixture-configured-secret"
  const previousConfigured = process.env.OLA_AGENT_TEST_SECRET
  try {
    process.env.OLA_AGENT_TEST_SECRET = fakeConfigured
    const paths = [
      `knowledge/maps/target/a-${fakeKey}.md`,
      `knowledge/maps/target/b-${fakeConfigured}.md`,
      `knowledge/maps/target/c-${fakeKey}.md`,
      `knowledge/maps/target/d-${fakeKey}.md`,
      `knowledge/maps/target/z-${fakeKey}.md`,
    ]
    await write(paths[0], "included")
    await write(paths[1], "configured")
    await write(paths[2], "x".repeat(16 * 1024 + 1))
    await symlink(join(root, "missing.md"), join(root, paths[3]))
    for (let i = 0; i < 5; i++) await write(`knowledge/maps/target/m-${i}.md`, "m".repeat(15 * 1024))
    await write(paths[4], "z".repeat(15 * 1024))
    const inputs: RunInput[] = []
    await loadRepoContext("acme/target", root, undefined, inputs)
    const record = JSON.stringify(inputs)
    assert.ok(!record.includes(fakeKey))
    assert.ok(!record.includes(fakeConfigured))
    for (const [i, reason] of [undefined, undefined, "file-too-large", "symlink", "context-budget"].entries()) {
      const path = paths[i].replace(fakeKey, "«已脱敏:openai-style-key»").replace(fakeConfigured, "«已脱敏:配置值»")
      assert.deepEqual(inputs.find(input => input.path === path), {
        path, source: "workspace", size: (await lstat(join(root, paths[i]))).size,
        ...(reason ? { reason } : {}),
      })
    }
  } finally {
    if (previousConfigured === undefined) delete process.env.OLA_AGENT_TEST_SECRET
    else process.env.OLA_AGENT_TEST_SECRET = previousConfigured
    await rm(root, { recursive: true })
  }
})

test("repo context bounds file size and total JSON size without truncating documents", async () => {
  const { root, write } = await fixture()
  try {
    await write("team-context/mounted-repos/target.md", "entry point: app/main.py")
    await write("knowledge/maps/target/too-large.md", "x".repeat(16 * 1024 + 1))
    for (let i = 0; i < 10; i++) await write(`knowledge/maps/target/map-${i}.md`, "m".repeat(15 * 1024))
    const documents = await loadRepoContext("acme/target", root)
    assert.equal(documents[0].path, "team-context/mounted-repos/target.md")
    assert.ok(JSON.stringify(documents).length <= 64 * 1024)
    assert.ok(documents.length > 1 && documents.length < 11)
    assert.ok(documents.slice(1).every(doc => doc.content.length === 15 * 1024))
  } finally { await rm(root, { recursive: true }) }
})

test("run start delivers context through artifacts to scan, fix and smoke runs, never to generic runs", async () => {
  const { root, write } = await fixture()
  const store = await Store.open(join(root, "test.sqlite"))
  const previousRoot = process.env.OLA_AGENT_CONTEXT_ROOT
  const launches: RunScannerArgs[] = []
  const contexts: unknown[] = []
  const deps = {
    store, runsRootDir: join(root, "runs"), workspacesRoot: root, maxConcurrent: 10, scannerImage: "test", getGhToken: async () => "fixture",
    activeRuns: new Map(), bus: { publish() {} },
    controller: { runScanner(args: RunScannerArgs) {
      launches.push(args)
      const path = join(args.artifactsHostDir, "repo-context.json")
      contexts.push(existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined)
      const inputs = JSON.parse(readFileSync(join(args.artifactsHostDir, "inputs.json"), "utf8")) as RunInput[]
      if (args.env.LOCAL_WORKSPACE) assert.deepEqual(inputs, [
        { path: "prompt.txt", source: "human", size: Buffer.byteLength("inspect the workspace") },
      ])
      else {
        assert.ok(inputs.some(input => input.path === "team-context/mounted-repos/target.md" && input.source === "workspace" && !input.reason))
        assert.ok(inputs.some(input => input.path === "skill/ola-security-audit/SKILL.md" && input.source === "suite" && input.size > 0))
      }
      throw new Error("fixture scanner launch stopped")
    } },
  }
  const previousDev = process.env.OLA_DEV
  process.env.OLA_DEV = "1"
  try {
    await write("team-context/mounted-repos/target.md", "Entry point: app/main.py")
    process.env.OLA_AGENT_CONTEXT_ROOT = root
    const base = { sessionId: "s1", repoUrl: "https://github.com/acme/target", skill: "ola-security-audit",
      model: "haiku", effort: "low", mode: "fix" }
    for (const body of [base, { ...base, mode: "scan" }, { ...base, smokeSeconds: 1 },
      { sessionId: "s1", prompt: "inspect the workspace", workspaceHostDir: root,
        model: "haiku", effort: "low", mode: "fix" }]) {
      const c = {
        req: { json: async () => body }, json: (value: unknown, status = 200) => Response.json(value, { status }),
      } as unknown as Context
      const response = await handleStartRun(c, deps as never, undefined, undefined, "skill" in body && body.mode === "fix" ? { from: "old", done: [], bundled: false } : undefined)
      assert.equal(response.status, 500)
      assert.equal((await response.json()).error, "fixture scanner launch stopped")
    }
    assert.equal(launches.length, 4)
    const context = [{ path: "team-context/mounted-repos/target.md", content: "Entry point: app/main.py" }]
    assert.deepEqual(contexts, [context, context, context, undefined])
    assert.ok(launches.every(args => !JSON.stringify(args.env).includes("app/main.py")))
  } finally {
    if (previousDev === undefined) delete process.env.OLA_DEV
    else process.env.OLA_DEV = previousDev

    if (previousRoot === undefined) delete process.env.OLA_AGENT_CONTEXT_ROOT
    else process.env.OLA_AGENT_CONTEXT_ROOT = previousRoot
    store.close()
    await rm(root, { recursive: true })
  }
})

test("inputs.json records included files and every context drop reason before the scanner starts", async () => {
  const { root, write } = await fixture()
  const store = await Store.open(join(root, "test.sqlite"))
  const previousRoot = process.env.OLA_AGENT_CONTEXT_ROOT
  let artifactsDir = ""
  try {
    process.env.OLA_AGENT_CONTEXT_ROOT = root
    await write("team-context/mounted-repos/target.md", "entry point")
    for (let i = 0; i < 10; i++) await write(`knowledge/maps/target/map-${i}.md`, "m".repeat(15 * 1024))
    await write("knowledge/maps/target/too-large.md", "x".repeat(16 * 1024 + 1))
    const link = "knowledge/maps/target/link.md"
    await symlink(join(root, "team-context/mounted-repos/target.md"), join(root, link))
    const dangling = "knowledge/maps/target/dangling.md"
    await symlink(join(root, "missing.md"), join(root, dangling))
    const directoryLink = "knowledge/bug-fixes/target"
    await mkdir(join(root, "knowledge/bug-fixes"), { recursive: true })
    await symlink(join(root, "knowledge/maps/target"), join(root, directoryLink))
    await write("runs/old/artifacts/repo-context.json", JSON.stringify([{ path: "operator-note.md", content: "Review café" }]))
    await write("runs/old/artifacts/findings.json", "[]")
    const body = { sessionId: "s1", repoUrl: "https://github.com/acme/target", skill: "ola-security-audit",
      model: "haiku", effort: "low", mode: "fix" }
    const c = {
      req: { json: async () => body }, json: (value: unknown, status = 200) => Response.json(value, { status }),
    } as unknown as Context
    const response = await handleStartRun(c, {
      store, runsRootDir: join(root, "runs"), maxConcurrent: 1, scannerImage: "test", getGhToken: async () => "fixture",
      activeRuns: new Map(), bus: { publish() {} },
      controller: { runScanner(args: RunScannerArgs) {
        artifactsDir = args.artifactsHostDir
        assert.ok(existsSync(join(artifactsDir, "inputs.json")))
        throw new Error("fixture scanner launch stopped")
      } },
    } as never, undefined, undefined, { from: "old", done: [], bundled: false })
    assert.equal(response.status, 500)
    assert.equal((await response.json()).error, "fixture scanner launch stopped")
    const inputs = JSON.parse(readFileSync(join(artifactsDir, "inputs.json"), "utf8")) as RunInput[]
    const entry = (path: string) => inputs.find(input => input.path === path)
    assert.deepEqual(entry("operator-note.md"), { path: "operator-note.md", source: "human", size: Buffer.byteLength("Review café") })
    assert.deepEqual(entry("findings.json"), { path: "findings.json", source: "repo", size: 2 })
    assert.deepEqual(entry("team-context/mounted-repos/target.md"), { path: "team-context/mounted-repos/target.md", source: "workspace", size: 11 })
    assert.deepEqual(entry("knowledge/maps/target/too-large.md"), {
      path: "knowledge/maps/target/too-large.md", source: "workspace", size: 16 * 1024 + 1, reason: "file-too-large",
    })
    for (const path of [link, dangling, directoryLink]) assert.deepEqual(entry(path), {
      path, source: "workspace", size: (await lstat(join(root, path))).size, reason: "symlink",
    })
    for (let i = 0; i < 10; i++) assert.deepEqual(entry(`knowledge/maps/target/map-${i}.md`), {
      path: `knowledge/maps/target/map-${i}.md`, source: "workspace", size: 15 * 1024,
      ...(i >= 4 ? { reason: "context-budget" } : {}),
    })
    for (const name of ["SKILL.md", "applies-to.json"]) assert.deepEqual(entry(`skill/ola-security-audit/${name}`), {
      path: `skill/ola-security-audit/${name}`, source: "suite",
      size: (await lstat(new URL(`../../skill/ola-security-audit/${name}`, import.meta.url))).size,
    })
    assert.equal(new Set(inputs.map(input => input.path)).size, inputs.length)
    const documents = JSON.parse(readFileSync(join(artifactsDir, "repo-context.json"), "utf8"))
    assert.ok(JSON.stringify(documents).length <= 64 * 1024)
    assert.deepEqual(documents.map((document: { path: string }) => document.path),
      inputs.filter(input => !input.reason && ["workspace", "human"].includes(input.source)).map(input => input.path))
    const artifactContext = {
      req: { param: (name: string) => name === "id" ? artifactsDir.split("/").at(-2) : "inputs" },
      json: (value: unknown, status = 200) => Response.json(value, { status }),
    } as unknown as Context
    const artifact = await handleRunArtifact(artifactContext, { runsRootDir: join(root, "runs") })
    assert.equal(artifact.status, 200)
    assert.equal(artifact.headers.get("Content-Type"), "application/json")
    assert.deepEqual(await artifact.json(), inputs)
  } finally {
    if (previousRoot === undefined) delete process.env.OLA_AGENT_CONTEXT_ROOT
    else process.env.OLA_AGENT_CONTEXT_ROOT = previousRoot
    store.close()
    await rm(root, { recursive: true })
  }
})


test("batch guidance is redacted, reserved within the context limit, and works without workspace files", async () => {
  const { root, write } = await fixture()
  const fakeConfigured = ["fixture", "operator", "secret"].join("-")
  const previous = process.env.TEST_OPERATOR_SECRET
  process.env.TEST_OPERATOR_SECRET = fakeConfigured
  try {
    const note = `  Use parameter binding. ${fakeConfigured}  `
    const expected = { path: "operator-note.md", content: "Use parameter binding. «已脱敏:配置值»" }
    assert.deepEqual(await loadRepoContext("acme/target", root, "  "), [])
    assert.deepEqual(await loadRepoContext("acme/target", join(root, "missing"), note), [expected])
    for (let i = 0; i < 10; i++) await write(`knowledge/maps/target/map-${i}.md`, "m".repeat(15 * 1024))
    const documents = await loadRepoContext("acme/target", root, note)
    assert.deepEqual(documents[0], expected)
    assert.equal(documents.filter(document => document.path === "operator-note.md").length, 1)
    assert.ok(JSON.stringify(documents).length <= 64 * 1024)
    assert.ok(documents.length > 1)
  } finally {
    if (previous === undefined) delete process.env.TEST_OPERATOR_SECRET
    else process.env.TEST_OPERATOR_SECRET = previous
    await rm(root, { recursive: true })
  }
})

test("related repos come only from the human part of the notes file", () => {
  const notes = [
    "## Related repos", "", "- other", "- `client-app`", "* third", "- ../escape", "- other", "",
    "## Other notes", "- not-a-repo",
    "<!-- security-patch:auth -->", "## Related repos", "- injected", "<!-- /security-patch:auth -->",
  ].join("\n")
  assert.deepEqual(relatedRepoIds(notes), ["other", "client-app", "third"])
  assert.deepEqual(relatedRepoIds("No section here."), [])
})

test("related repo dirs resolve listed mounts and skip the repo itself and missing ones", async () => {
  const { root, write } = await fixture()
  const targets = join(root, "targets")
  try {
    assert.deepEqual(await relatedRepoDirs("acme/target", root, targets), [])
    await write("targets/acme__target.md", "## Related repos\n- other\n- target\n- absent\n")
    const dirs = await relatedRepoDirs("https://github.com/acme/target", root, targets)
    assert.deepEqual(dirs.map(dir => dir.id), ["other"])
    assert.ok(dirs[0].dir.endsWith("/repos/other"))
    assert.deepEqual(await relatedRepoDirs("local:/repo", root, targets), [])
  } finally { await rm(root, { recursive: true }) }
})
