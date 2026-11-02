import { test } from "bun:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { importVendor, vendorReason, writeVendorNotes, type VendorData } from "./vendor.ts"
import { matchTracked, postFindings } from "./findings.ts"
import { Store } from "../store/repo.ts"
import type { Row } from "../tracker/rows.ts"
import type { TrackerFile, TrackerStore } from "../tracker/store.ts"

class MemoryStore implements TrackerStore {
  files: TrackerFile[] = []
  async read() { return structuredClone(this.files) }
  async write(file: TrackerFile, rows: Row[], message: string) {
    const next = { ...file, rows: structuredClone(rows), log: [...file.log, ...(message ? [{ at: "now", message }] : [])], sha: "sha", url: `https://example.test/${file.category}.json` }
    this.files = [...this.files.filter(current => current.category !== file.category), next]
    return next
  }
}

function sample(): VendorData {
  return {
    trees: ["lib/vendor", "tools/vendor"].map((path, index) => ({
      path, mode: index ? "reinstalled" : "committed", lock: index ? "present" : "missing",
      evidence: ["git tracking and install scripts checked"], metadataSource: "installed.json", mismatches: [], audit: "completed",
      packages: [{ name: "example/client", version: "1.2.3" }],
    })),
    advisories: [
      { package: "example/client", version: "1.2.3", trees: ["lib/vendor"], advisoryId: "PKSA-one",
        cve: "CVE-2024-0001", title: "Example advisory", severity: "medium", link: null },
      { package: "example/client", version: "1.2.3", trees: ["lib/vendor", "tools/vendor"], advisoryId: "PKSA-two",
        cve: null, title: "Another advisory", severity: "high", link: "https://example.com/advisory" },
    ], errors: ["One tree could not be audited"],
  }
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "vendor-test-"))
  const store = await Store.open(join(dir, "store.sqlite"))
  store.ensureSession("session")
  store.createRun({ runId: "scan", sessionId: "session", repoUrl: "https://github.com/owner/repo", branch: "main",
    skill: "ola-security-audit", model: "haiku", effort: "low", mode: "scan" })
  return { dir, store, close() { store.close(); rmSync(dir, { recursive: true }) } }
}

test("vendor import groups advisories across trees, persists run data, and posts idempotent vendor-cve rows", async () => {
  const { dir, store, close } = await setup()
  try {
    const data = sample()
    writeFileSync(join(dir, "vendor.json"), JSON.stringify(data))
    const findings = importVendor("scan", dir, store)
    assert.equal(findings.length, 1)
    assert.equal(findings[0].category, "vendor-cve")
    assert.equal(findings[0].kind, undefined)
    assert.equal(findings[0].file, "example/client@1.2.3")
    assert.equal(findings[0].severity, "P1")
    assert.equal(findings[0].status, "needs human")
    // One line per advisory with a short reference, then IDs and Trees on their own lines.
    assert.equal(findings[0].reason?.split("\n").slice(0, 4).join("\n"),
      "Verdict: needs human. Advisory reachability and remediation require review.\nAdvisories:\n- Example advisory · CVE-2024-0001\n- Another advisory · PKSA-two")
    assert.ok(findings[0].reason?.includes("\nIDs: CVE-2024-0001, PKSA-one, PKSA-two\n"))
    assert.ok(findings[0].reason?.endsWith("Trees: lib/vendor, tools/vendor"))
    assert.deepEqual(store.getVendor("scan"), data)
    data.advisories.reverse()
    data.advisories[0].trees.reverse()
    writeFileSync(join(dir, "vendor.json"), JSON.stringify(data))
    assert.equal(importVendor("scan", dir, store)[0].id, findings[0].id)
    assert.equal(store.listFindings("scan").length, 1)
    const trackerStore = new MemoryStore()
    assert.deepEqual(await postFindings("scan", "owner/repo", findings, trackerStore), { added: 1, skipped: 0 })
    const row = trackerStore.files[0].rows[0]
    assert.equal(row.kind, undefined)
    assert.equal(row.status, "open")
    assert.equal(row.pr, "")
    assert.equal(row.file, findings[0].file)
    // Preserve human status and reason when a later scan finds the same version.
    trackerStore.files[0].rows = [{ ...row, status: "ignored", reason: "Accepted by owner" }]
    assert.deepEqual(await postFindings("later", "owner/repo", findings, trackerStore), { added: 0, skipped: 1 })
    assert.deepEqual(await postFindings("legacy", "owner/repo", [{ ...findings[0], category: "misc", kind: "vendor-cve" }], trackerStore), { added: 0, skipped: 1 })
    assert.equal(trackerStore.files[0].rows[0].reason, "Accepted by owner")
    assert.deepEqual(trackerStore.files[0].log.map(entry => entry.message), ["Scan scan: added 1, skipped 0 known."])
    const matches = await matchTracked(findings, trackerStore)
    assert.equal(matches[findings[0].id].kind, "tracked")
    data.trees[0].packages.push({ name: "example/client", version: "2.0.0" })
    data.advisories.push({ ...data.advisories[0], version: "2.0.0", trees: [data.trees[0].path] })
    writeFileSync(join(dir, "vendor.json"), JSON.stringify(data))
    const versions = importVendor("scan", dir, store)
    assert.equal(versions.length, 2)
    assert.notEqual(versions[0].id, versions[1].id)
    assert.deepEqual(await postFindings("new-version", "owner/repo", versions, trackerStore), { added: 1, skipped: 1 })
  } finally { close() }
})

for (const severity of ["critical", "high", "medium", "low", "unknown", null]) {
  test(`vendor severity ${severity} maps without P0`, async () => {
    const { dir, store, close } = await setup()
    try {
      const data = sample()
      data.advisories = [{ ...data.advisories[0], severity }]
      writeFileSync(join(dir, "vendor.json"), JSON.stringify(data))
      assert.equal(importVendor("scan", dir, store)[0].severity, severity === "critical" || severity === "high" ? "P1" : "P2")
    } finally { close() }
  })
}

test("missing, malformed, and unsafe vendor artifacts log without importing rows or throwing", async () => {
  const { dir, store, close } = await setup()
  const warn = console.warn
  const warnings: unknown[][] = []
  console.warn = (...args) => { warnings.push(args) }
  try {
    for (const contents of [null, "{", "{}", JSON.stringify({ ...sample(), errors: [1] })]) {
      if (contents !== null) writeFileSync(join(dir, "vendor.json"), contents)
      assert.deepEqual(importVendor("scan", dir, store), [])
    }
    rmSync(join(dir, "vendor.json"))
    writeFileSync(join(dir, "outside.json"), JSON.stringify(sample()))
    symlinkSync(join(dir, "outside.json"), join(dir, "vendor.json"))
    assert.deepEqual(importVendor("scan", dir, store), [])
    assert.equal(warnings.length, 5)
    assert.ok(warnings.every(args => args[0] === "[scanner scan] vendor.json missing, unreadable, or invalid"))
    assert.deepEqual(store.listFindings("scan"), [])
    assert.equal(store.getVendor("scan"), null)
  } finally { console.warn = warn; close() }
})

test("bad trees and advisories from the scanned repo are skipped, and the rest still import", async () => {
  const { dir, store, close } = await setup()
  const warn = console.warn
  const warnings: unknown[][] = []
  console.warn = (...args) => { warnings.push(args) }
  try {
    const data = sample()
    const bad = (path: string) => ({ ...data.trees[0], path })
    data.trees.push(bad("../outside"), bad("/abs/vendor"), bad("ctl\u0001/vendor"))
    // Names that a Linux folder allows but normalizedPath rejects must not hide other rows.
    data.trees.push(bad("a\\b/vendor"), bad("c:/vendor"))
    data.trees.push({ ...data.trees[0], path: "odd/vendor", packages: [{ name: "example/odd", version: "dev-x/../../.." }] })
    data.advisories.push(null as never, { ...data.advisories[0], trees: ["unknown/vendor"] },
      { ...data.advisories[0], package: "example/odd", version: "dev-x/../../..", trees: ["odd/vendor"] })
    writeFileSync(join(dir, "vendor.json"), JSON.stringify(data))
    const rows = importVendor("scan", dir, store)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].file, "example/client@1.2.3")
    assert.deepEqual(store.getVendor("scan")?.trees.map(tree => tree.path),
      ["lib/vendor", "tools/vendor", "a\\b/vendor", "c:/vendor", "odd/vendor"])
    assert.equal(warnings.length, 1)
    assert.match(String(warnings[0][0]), /skipped 6 invalid trees or advisories/)
  } finally { console.warn = warn; close() }
})

test("vendor data keeps trees without advisories and lists every installed copy", async () => {
  const { dir, store, close } = await setup()
  try {
    const data = sample()
    data.advisories = [data.advisories[0]]
    writeFileSync(join(dir, "vendor.json"), JSON.stringify(data))
    assert.ok(importVendor("scan", dir, store)[0].reason?.endsWith("Trees: lib/vendor, tools/vendor"))
    data.advisories = []
    writeFileSync(join(dir, "vendor.json"), JSON.stringify(data))
    assert.deepEqual(importVendor("scan", dir, store), [])
    assert.deepEqual(store.getVendor("scan"), data)
  } finally { close() }
})

test("target notes preserve human text and replace inventory with package versions and coverage gaps", async () => {
  const { dir, store, close } = await setup()
  try {
    const path = join(dir, "owner__repo.md")
    writeFileSync(path, "Owner notes stay here.\n")
    const data = sample()
    writeFileSync(join(dir, "vendor.json"), JSON.stringify(data))
    assert.equal(importVendor("scan", dir, store, "https://github.com/owner/repo", dir).length, 1)
    const { readFileSync } = await import("node:fs")
    let notes = readFileSync(path, "utf8")
    assert.ok(notes.startsWith("Owner notes stay here.\n"))
    for (const text of ["example/client@1.2.3", "lib/vendor", "tools/vendor", "Lockfile: missing", "Lockfile: present",
      "git tracking and install scripts checked", "One tree could not be audited", "needs human"]) assert.ok(notes.includes(text), text)
    data.errors = ["composer-missing: tools/vendor"]
    writeVendorNotes("owner/repo", data, dir)
    notes = readFileSync(path, "utf8")
    assert.equal(notes.split("## Vendor inventory").length, 2)
    assert.ok(!notes.includes("One tree could not be audited"))
    assert.ok(notes.includes("composer-missing: tools/vendor"))
    writeVendorNotes("local:/repo", data, dir)
    assert.equal(readFileSync(path, "utf8"), notes)
  } finally { close() }
})

test("target notes reject symlinks and malformed markers", async () => {
  const { dir, close } = await setup()
  try {
    const path = join(dir, "owner__repo.md")
    const outside = join(dir, "outside.md")
    writeFileSync(outside, "Keep me")
    symlinkSync(outside, path)
    assert.throws(() => writeVendorNotes("owner/repo", sample(), dir))
    rmSync(path)
    writeFileSync(path, "<!-- security-patch:vendor -->")
    assert.throws(() => writeVendorNotes("owner/repo", sample(), dir))
  } finally { close() }
})

test("target notes refuse inline or overlapping markers without changing human text", () => {
  const dir = mkdtempSync(join(tmpdir(), "vendor-notes-"))
  const path = join(dir, "owner__repo.md")
  const start = "<!-- security-patch:vendor -->"
  const end = "<!-- /security-patch:vendor -->"
  try {
    for (const previous of [
      `Human example: ${start}\nKeep this decision.\n${end}\n`,
      `${start}\nKeep this decision.\n${end} is an example.\n`,
      `${start}\n<!-- security-patch:auth -->\nKeep auth facts.\n<!-- /security-patch:auth -->\n${end}\n`,
      `${start}\n<!-- security-patch:auth -->\nKeep auth facts.\n${end}\n<!-- /security-patch:auth -->\n`,
    ]) {
      writeFileSync(path, previous)
      assert.throws(() => writeVendorNotes("owner/repo", sample(), dir), /Invalid vendor notes markers/)
      assert.equal(readFileSync(path, "utf8"), previous)
    }
    // Keep both human regions and the neighboring section byte for byte, including CRLF.
    const before = "Human notes.\r\n<!-- security-patch:auth -->\r\nAuth facts.\r\n<!-- /security-patch:auth -->\r\n"
    const after = "\r\nHuman decisions stay.\r\n"
    writeFileSync(path, `${before}${start}\r\nOld inventory.\r\n${end}${after}`)
    writeVendorNotes("owner/repo", sample(), dir)
    const next = readFileSync(path, "utf8")
    assert.ok(next.startsWith(`${before}${start}\n`))
    assert.ok(next.endsWith(`${end}${after}`))
    assert.ok(!next.includes("Old inventory."))
  } finally { rmSync(dir, { recursive: true }) }
})

test("vendor reasons strip the package prefix and use the GHSA ID from the link", () => {
  const advisory = { package: "guzzlehttp/psr7", version: "1.3.0", trees: ["app/libs/vendor"], advisoryId: "PKSA-x", cve: "CVE-2022-24775",
    title: "guzzlehttp/psr7: CRLF injection via URI host component", severity: null, link: "https://github.com/guzzle/psr7/security/advisories/GHSA-vm85-hxw5-5432" }
  assert.equal(vendorReason([advisory, advisory], ["app/libs/vendor"]), ["Verdict: needs human. Advisory reachability and remediation require review.",
    "Advisories:", "- CRLF injection via URI host component · GHSA-vm85-hxw5-5432", "IDs: CVE-2022-24775, PKSA-x", "Trees: app/libs/vendor"].join("\n"))
})

test("vendor reasons drop a CVE that the title repeats", () => {
  const advisory = { package: "symfony/yaml", version: "4.4.0", trees: ["v"], advisoryId: "PKSA-y", cve: "CVE-2026-1",
    title: "CVE-2026-1: Unbounded recursion", severity: null, link: null }
  assert.ok(vendorReason([advisory], ["v"]).includes("\n- Unbounded recursion · CVE-2026-1\n"))
})

test("a scoped scan saves the vendor inventory but creates no vendor-cve rows", async () => {
  const { dir, store, close } = await setup()
  try {
    const data = sample()
    writeFileSync(join(dir, "vendor.json"), JSON.stringify(data))
    assert.deepEqual(importVendor("scan", dir, store, undefined, undefined, true), [])
    assert.deepEqual(store.listFindings("scan"), [])
    assert.deepEqual(store.getVendor("scan"), data)
  } finally {
    close()
  }
})
