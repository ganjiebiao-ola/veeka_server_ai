import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, mkdirSync, existsSync, fstatSync, closeSync } from "node:fs"
import { openArtifact } from "./agent-fs.mjs"
import { spawnSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { runInNewContext } from "node:vm"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assignFindingIds, finalizeFindingIds } from "./finding-ids.mjs"

const row = { category: "sqli", file: "src/query.ts", function: "查询", sink: 'query("用户")', snippet: " query(input) " }
const hash = inputs => createHash("sha256").update(JSON.stringify(inputs), "utf8").digest("hex")

for (const mode of ["scan"]) {
  test(`${mode} replaces model IDs with the unchanged UTF-8 hash formula`, () => {
    const first = assignFindingIds([{ ...row, id: "fake" }], mode)
    const second = assignFindingIds([{ ...row, id: "different" }], mode)
    assert.deepEqual(first, second)
    assert.equal(first[0].id, hash([row.category, row.file, row.function, row.sink]))
    assert.equal(Object.hasOwn(first[0], "function"), false)
    assert.equal(Object.hasOwn(first[0], "sink"), false)
    assert.equal(assignFindingIds([row], mode)[0].id, first[0].id)
    assert.equal(assignFindingIds([{ category: row.category, file: row.file, snippet: row.snippet }], mode)[0].id,
      hash([row.category, row.file, "", row.snippet.trim(), null]))
    assert.deepEqual(assignFindingIds([], mode), [])
  })
}

test("file finalization rewrites scan but leaves fix bytes untouched", t => {
  const dir = mkdtempSync(join(tmpdir(), "ola-ids-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, "findings.json")
  for (const mode of ["scan", "fix"]) {
    const input = JSON.stringify([{ ...row, id: "picked-id" }]) + " ".repeat(1000)
    writeFileSync(path, input)
    finalizeFindingIds(path, mode)
    const output = readFileSync(path, "utf8")
    if (mode === "fix") assert.equal(output, input)
    else assert.deepEqual(JSON.parse(output), assignFindingIds([{ ...row, id: "picked-id" }], mode))
  }
  assert.equal(assignFindingIds([row], "fix")[0], row)
  const target = join(dir, "target.json")
  writeFileSync(target, "[]")
  rmSync(path)
  symlinkSync(target, path)
  assert.throws(() => finalizeFindingIds(path, "scan"))
  assert.equal(readFileSync(target, "utf8"), "[]")
})


test("degraded rows use line numbers only when function and sink are missing", () => {
  const degraded = { category: row.category, file: row.file, snippet: row.snippet }
  const ids = assignFindingIds([1, 2].map(line => ({ ...degraded, line })), "scan")
  assert.notEqual(ids[0].id, ids[1].id)
  assert.equal(ids[0].id, hash([row.category, row.file, "", row.snippet.trim(), 1]))
  for (const fields of [{ function: row.function }, { sink: row.sink }, row]) {
    const rows = assignFindingIds([1, 2].map(line => ({ ...degraded, ...fields, line })), "scan")
    assert.equal(rows[0].id, rows[1].id)
  }
})

test("finalization writes compact JSON and rejects oversized output before writing", t => {
  const dir = mkdtempSync(join(tmpdir(), "ola-ids-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, "findings.json")
  const limit = 5 * 1024 * 1024
  const rows = [{ ...row, detail: "é".repeat(100) }]
  const expected = JSON.stringify(assignFindingIds(rows, "scan"))
  rows[0].detail += "x".repeat(limit - Buffer.byteLength(expected))
  writeFileSync(path, JSON.stringify(rows))
  finalizeFindingIds(path, "scan")
  const output = readFileSync(path)
  assert.equal(output.length, limit)
  assert.equal(output.toString(), JSON.stringify(assignFindingIds(rows, "scan")))
  rows[0].detail += "x"
  const input = JSON.stringify(rows)
  assert.ok(Buffer.byteLength(input) < limit)
  writeFileSync(path, input)
  assert.throws(() => finalizeFindingIds(path, "scan"), /too large/)
  assert.equal(readFileSync(path, "utf8"), input)
})

test("finalization rejects FIFO without blocking", t => {
  const dir = mkdtempSync(join(tmpdir(), "ola-ids-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, "findings.json")
  assert.equal(spawnSync("mkfifo", [path]).status, 0)
  assert.throws(() => finalizeFindingIds(path, "scan"), /not a regular file/)
})

const bridge = readFileSync(new URL("../bridge.mjs", import.meta.url), "utf8")
const finalization = bridge.slice(bridge.indexOf("async function writeFinalArtifacts()"), bridge.indexOf("\nlet exiting = false;"))

for (const kind of ["invalid JSON", "directory", "symlink", "cleanup failure"]) {
  test(`${kind} findings do not break bridge finalization`, async t => {
    const dir = mkdtempSync(join(tmpdir(), "ola-ids-"))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, "findings.json")
    const target = join(dir, "target.json")
    if (kind === "directory") {
      mkdirSync(path)
      writeFileSync(join(path, "nested"), "invalid")
    } else if (kind === "symlink") {
      writeFileSync(target, "[]")
      symlinkSync(target, path)
    } else writeFileSync(path, "invalid")
    mkdirSync(join(dir, ".git"))
    const diagnostics = []
    const exports = []
    let snapshots = 0
    await runInNewContext(finalization + "\nwriteFinalArtifacts()", {
      MODE: "scan", ARTIFACTS_DIR: dir, REPO_DIR: dir, finalizeFindingIds, existsSync,
      rmSync: kind === "cleanup failure" ? () => { throw new Error("denied") } : rmSync,
      diag: message => diagnostics.push(message),
      writeReportSnapshot: () => snapshots++, writeFileSync, join, openArtifact, closeSync,
      reportChunks: ["report"], SUMMARY_MARKER: "SUMMARY", lastAssistantText: "report", SCOPE_HEADER: "",
      readBaseSha: () => null,
      buildExportCommands: () => ({
        patchCmd: { cmd: "patch", args: [], outFile: join(dir, "working.patch") },
        commitsCmd: { cmd: "commits", args: [], outFile: join(dir, "commits.log") },
      }),
      agentEnv: {}, agentSpawn: (cmd, args, options) => {
        assert.ok(fstatSync(options.stdio[1]).isFile())
        exports.push(cmd)
        const child = new EventEmitter()
        process.nextTick(() => child.emit("exit", 0))
        return child
      },
      exiting: false, setTimeout, clearTimeout,
    })
    assert.equal(existsSync(path), kind === "cleanup failure")
    assert.equal(snapshots, 1)
    assert.equal(readFileSync(join(dir, "response.md"), "utf8"), "report\n")
    assert.deepEqual(exports, ["patch", "commits"])
    assert.ok(diagnostics.includes("findings.json ID finalization failed"))
    if (kind === "symlink") assert.equal(readFileSync(target, "utf8"), "[]")
    if (kind === "cleanup failure") assert.ok(diagnostics.some(message => message.includes("cleanup failed: denied")))
  })
}
