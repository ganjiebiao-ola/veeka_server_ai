import { test } from "node:test"
import assert from "node:assert/strict"
import fs, { linkSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agentFs, copyFiles, runAsAgent, writeArtifact } from "./agent-fs.mjs"

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "agent-fs-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test("agent file reads reject a repo symlink that realpath then read would accept", t => {
  const dir = fixture(t)
  const repo = join(dir, "repo")
  mkdirSync(repo)
  const target = join(repo, "target")
  const link = join(repo, "link")
  writeFileSync(target, "fixture")
  symlinkSync(target, link)
  // The old containment check accepts this path and reads its target.
  assert.equal(readFileSync(realpathSync(link), "utf8"), "fixture")
  assert.throws(() => agentFs.readFileSync(link), { code: "ELOOP" })
  assert.throws(() => agentFs.writeFileSync(link, "changed"), { code: "ELOOP" })
  assert.equal(readFileSync(target, "utf8"), "fixture")
})

test("agent file IO preserves binary bytes and enforces caps before overwriting", t => {
  const file = join(fixture(t), "bytes")
  const bytes = Buffer.from([0, 255, 128, 10])
  agentFs.writeFileSync(file, bytes, 4)
  assert.deepEqual(agentFs.readFileSync(file, undefined, 4), bytes)
  assert.throws(() => agentFs.readFileSync(file, undefined, 3), /too large/)
  assert.throws(() => agentFs.writeFileSync(file, Buffer.alloc(5), 4), /too large/)
  assert.deepEqual(readFileSync(file), bytes)
  agentFs.writeFileSync(file, "a")
  assert.equal(agentFs.readFileSync(file, "utf8"), "a")
})

test("root dispatch drops privileges and round-trips binary data and errors", async t => {
  const dir = fixture(t)
  const { execFileSync } = await import("node:child_process")
  writeFileSync(join(dir, "setpriv"), `#!/bin/sh
    test "$1" = --reuid=agent && test "$2" = --regid=agent && test "$3" = --clear-groups && test "$4" = --no-new-privs || exit 9
    test -z "$GH_TOKEN" || exit 9
    shift 4
    exec "$@"
  `, { mode: 0o755 })
  const script = `
    import assert from "node:assert/strict"
    // Exercise root's dispatch on a dev host without requiring Linux or the agent account.
    process.getuid = () => 0
    process.env.GH_TOKEN = "test.placeholder"
    process.env.PATH = ${JSON.stringify(dir)} + ":" + process.env.PATH
    const { agentFs } = await import(${JSON.stringify(new URL("./agent-fs.mjs", import.meta.url).href)})
    const dir = ${JSON.stringify(dir)}
    const file = dir + "/bytes"
    const bytes = Buffer.from([0, 255, 128, 10])
    agentFs.writeFileSync(file, bytes)
    assert.deepEqual(agentFs.readFileSync(file), bytes)
    assert.equal(agentFs.existsSync(file), true)
    assert.throws(() => agentFs.readFileSync(file, undefined, 3), /too large/)
    assert.throws(() => agentFs.readFileSync(dir + "/missing"), { code: "ENOENT" })
    agentFs.writeFileSync(file, "a")
    assert.equal(agentFs.readFileSync(file, "utf8"), "a")
  `
  execFileSync(process.execPath, ["-e", script], { stdio: "pipe" })
})

test("root artifacts reject symlinks, hardlinks and another uid before truncating", t => {
  const dir = fixture(t)
  const target = join(dir, "target")
  const link = join(dir, "link")
  writeFileSync(target, "unchanged")
  symlinkSync(target, link)
  for (const append of [false, true]) assert.throws(() => writeArtifact(link, "changed", append))
  rmSync(link)
  linkSync(target, link)
  for (const append of [false, true]) assert.throws(() => writeArtifact(link, "changed", append), /Unsafe artifact/)
  rmSync(link)
  const original = fs.fstatSync
  try {
    fs.fstatSync = fd => Object.assign(original(fd), { uid: process.getuid() + 1 })
    assert.throws(() => writeArtifact(target, "changed"), /Unsafe artifact/)
  } finally { fs.fstatSync = original }
  assert.equal(readFileSync(target, "utf8"), "unchanged")
  const file = join(dir, "events.jsonl")
  writeArtifact(file, "first\n")
  writeArtifact(file, "second\n", true)
  assert.equal(readFileSync(file, "utf8"), "first\nsecond\n")
  writeArtifact(file, "short")
  assert.equal(readFileSync(file, "utf8"), "short")
})

test("500-file walks and batched analyses spawn once each, artifact writes spawn zero times", async t => {
  const dir = fixture(t)
  const repo = join(dir, "repo")
  mkdirSync(join(repo, "vendor/example"), { recursive: true })
  const { execFileSync } = await import("node:child_process")
  execFileSync("git", ["init", "-q", repo])
  for (let i = 0; i < 500; i++) writeFileSync(join(repo, i % 2 ? `file${i}.php` : `vendor/example/file${i}.php`), "<?php echo $input;\n")
  execFileSync("git", ["-C", repo, "add", "."])
  const counter = join(dir, "spawns")
  writeFileSync(join(dir, "setpriv"), `#!/bin/sh
    test "$1" = --reuid=agent && test "$2" = --regid=agent && test "$3" = --clear-groups && test "$4" = --no-new-privs || exit 9
    test -z "$GH_TOKEN" || exit 9
    printf 'spawn\\n' >> '${counter}'
    shift 4
    exec "$@"
  `, { mode: 0o755 })
  const module = name => JSON.stringify(new URL(`./${name}.mjs`, import.meta.url).href)
  execFileSync(process.execPath, ["-e", `
    import assert from "node:assert/strict"
    import fs from "node:fs"
    process.getuid = () => 0
    process.env.GH_TOKEN = "test.placeholder"
    process.env.PATH = ${JSON.stringify(dir)} + ":" + process.env.PATH
    const { findVendorTrees, discoverVendors, readVendorSnippets, vendorTreeForPath } = await import(${module("vendor")})
    const { detectProfile, repoFiles } = await import(${module("profile")})
    const { checkVendorCalls } = await import(${module("call-check")})
    const { filterIgnoredHits } = await import(${module("semgrep")})
    const { checkedPath, writeArtifact } = await import(${module("agent-fs")})
    const repo = ${JSON.stringify(repo)}
    const count = () => fs.existsSync(${JSON.stringify(counter)}) ? fs.readFileSync(${JSON.stringify(counter)}, "utf8").trim().split("\\n").length : 0
    const once = fn => { const before = count(); fn(); assert.equal(count() - before, 1) }
    once(() => assert.deepEqual(findVendorTrees(repo), ["vendor"]))
    once(() => assert.equal(detectProfile(repo).language, "php"))
    once(() => assert.equal(repoFiles(repo).length, 250))
    once(() => assert.equal(discoverVendors(repo).trees.length, 1))
    const hits = Array.from({ length: 250 }, (_, i) => ({ path: "vendor/example/file" + (i * 2) + ".php", start: { line: 1 }, vendorTree: "vendor" }))
    once(() => assert.equal(checkVendorCalls(repo, ["vendor"], hits).length, 250))
    once(() => assert.ok(readVendorSnippets(repo, hits).every(text => text === "<?php echo $input;")))
    once(() => assert.equal(filterIgnoredHits({ results: hits }, repo).results.length, 250))
    once(() => assert.equal(checkedPath(repo + "/file1.php", [repo, "/missing"]), fs.realpathSync(repo + "/file1.php")))
    const before = count()
    const fstat = fs.fstatSync
    fs.fstatSync = fd => Object.assign(fstat(fd), { uid: 0 })
    for (let i = 0; i < 500; i++) {
      writeArtifact(${JSON.stringify(join(dir, "events.jsonl"))}, "event\\n", true)
      assert.equal(vendorTreeForPath(hits[0].path, repo, ["vendor"]), "vendor")
    }
    assert.equal(count(), before)
  `], { stdio: "pipe" })
})

test("whole-function dispatch preserves child failures", () => {
  assert.throws(() => runAsAgent(import.meta.url, "missing", [], () => ({ status: 1, stderr: Buffer.from('{"message":"denied","code":"EACCES"}') })), { code: "EACCES" })
})

test("a write killed midway leaves the old content or no file, never a partial one", async t => {
  const dir = fixture(t)
  const { spawnSync } = await import("node:child_process")
  const file = join(dir, "findings.json")
  const interrupted = () => spawnSync(process.execPath, ["--input-type=module", "-e", `
    import fs from "node:fs"
    import { agentFs } from ${JSON.stringify(new URL("./agent-fs.mjs", import.meta.url).href)}
    const write = fs.writeSync
    fs.writeSync = (fd, buffer, offset, length, position) => {
      write(fd, buffer, offset, Math.ceil(length / 2), position)
      process.kill(process.pid, "SIGKILL")
    }
    agentFs.writeFileSync(${JSON.stringify(file)}, "B".repeat(1000))
  `], { stdio: "pipe" })
  assert.equal(interrupted().signal, "SIGKILL")
  assert.equal(fs.existsSync(file), false)
  writeFileSync(file, "A".repeat(1000))
  assert.equal(interrupted().signal, "SIGKILL")
  assert.equal(readFileSync(file, "utf8"), "A".repeat(1000))
  agentFs.writeFileSync(file, "B".repeat(1000))
  assert.equal(readFileSync(file, "utf8"), "B".repeat(1000))
})

test("copyFiles copies matching non-empty regular files and skips symlinks and unchanged files", t => {
  const dir = fs.mkdtempSync(join(tmpdir(), "copy-files-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const from = join(dir, "from"), to = join(dir, "to")
  fs.mkdirSync(from)
  fs.writeFileSync(join(dir, "secret"), "secret")
  fs.symlinkSync(join(dir, "secret"), join(from, "link"))
  fs.writeFileSync(join(from, "token"), "token")
  fs.writeFileSync(join(from, "empty"), "")
  fs.writeFileSync(join(from, "other"), "other")
  copyFiles(from, to, /^(link|token|empty)$/)
  assert.deepEqual(fs.readdirSync(to), ["token"])
  const before = fs.statSync(join(to, "token")).mtimeMs
  copyFiles(from, to, /^token$/)
  assert.equal(fs.statSync(join(to, "token")).mtimeMs, before)
  copyFiles(join(dir, "missing"), to, /./)
})
