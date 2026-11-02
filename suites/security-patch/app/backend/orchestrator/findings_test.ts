import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { test } from "bun:test"
import { strict as assert } from "node:assert";
import schema from "../../skill/ola-security-audit/findings.schema.json" with { type: "json" };
import { importFindings, isFindingRow, matchTracked, postFindings } from "./findings.ts";
import { VULN_CATEGORIES } from "../../shared/types.ts";
import { finalizeFindingIds } from "../../scanner/lib/finding-ids.mjs";
import type { Finding } from "../../shared/types.ts";
import type { TrackerFile, TrackerStore } from "../tracker/store.ts";
import type { Row } from "../tracker/rows.ts";
import { Store } from "../store/repo.ts"

class MemoryStore implements TrackerStore {
  files: TrackerFile[] = []
  async read() { return structuredClone(this.files) }
  async write(file: TrackerFile, rows: Row[], message: string) {
    const next = { ...file, rows: structuredClone(rows), log: [...file.log, ...(message ? [{ at: "now", message }] : [])], sha: "sha", url: `https://example.test/${file.category}.json` }
    this.files = [...this.files.filter(current => current.category !== file.category), next]
    return next
  }
}

const row = {
  id: "a".repeat(64), category: "sqli", severity: "P0", file: "src/query.ts",
  line: 3, snippet: "query(input)", fix_summary: "Use parameters",
  status: "candidate", reason: "Input reaches query",
};

test("findings schema accepts every category and rejects invalid fields", () => {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.type, "array");
  assert.equal(schema.items.type, "object");
  assert.equal(schema.items.additionalProperties, false);
  assert.deepEqual(schema.items.required.sort(), Object.keys(row).sort());
  assert.deepEqual(schema.items.properties.category.enum, [...VULN_CATEGORIES, "deps-gadget", "vendor-cve", "api-retired", "misc"]);
  for (const category of schema.items.properties.category.enum) {
    assert.equal(isFindingRow({ ...row, category, ...(category === "misc" ? { kind: "idor" } : {}) }), true);
  }
  // kind is required on misc rows and forbidden elsewhere.
  assert.equal(isFindingRow({ ...row, category: "misc" }), false);
  assert.equal(isFindingRow({ ...row, kind: "idor" }), false);
  for (const kind of ["IDOR", "a b", "-x", "x".repeat(41), ""]) assert.equal(isFindingRow({ ...row, category: "misc", kind }), false, kind);
  for (const status of schema.items.properties.status.enum) {
    assert.equal(isFindingRow({ ...row, status }), true);
  }
  for (const key of Object.keys(row)) {
    const missing: Record<string, unknown> = { ...row };
    delete missing[key];
    assert.equal(isFindingRow(missing), false, key);
    assert.equal(isFindingRow({ ...row, [key]: null }), false, key);
  }
  for (const invalid of [
    null, [], "bad", { ...row, id: "unstable" }, { ...row, category: "unknown" },
    { ...row, severity: "P3" }, { ...row, status: "confirmed" },
    { ...row, line: 0 }, { ...row, line: 1.5 }, { ...row, line: "3" },
    { ...row, file: "" }, { ...row, extra: true },
    { ...row, id: "a".repeat(64) + "\n" },
    JSON.parse(JSON.stringify(row).replace(/}$/, ",\"__proto__\":{}}")),
  ]) assert.equal(isFindingRow(invalid), false);
});

test("unsafe finding paths cannot overwrite valid findings on re-import", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ola-findings-"))
  const store = await Store.open(join(dir, "store.sqlite"))
  const warn = console.warn
  const warnings: unknown[][] = []
  console.warn = (...args) => { warnings.push(args) }
  try {
    store.ensureSession("session")
    store.createRun({ runId: "scan", sessionId: "session", repoUrl: "https://github.com/owner/repo", branch: "main",
      skill: "ola-security-audit", model: "haiku", effort: "low", mode: "scan" })
    writeFileSync(join(dir, "findings.json"), JSON.stringify([row]))
    importFindings("scan", dir, store)
    const before = store.listFindings("scan")
    const paths = ["../outside.ts", "src/../../outside.ts", "src/../query.ts", "src\\..\\query.ts", "C:/outside.ts",
      ".", "src/\u0000query.ts", "src/\nquery.ts", "src/\u007fquery.ts"]
    // The agent runs in /workspace/repo, so normalizedPath strips that prefix.
    assert.equal(isFindingRow({ ...row, file: "/workspace/repo/src/query.ts" }), true)
    for (const file of paths) {
      assert.equal(isFindingRow({ ...row, file }), false, JSON.stringify(file))
      writeFileSync(join(dir, "findings.json"), JSON.stringify([{ ...row, file, status: "fixed" }]))
      assert.deepEqual(importFindings("scan", dir, store), [])
      assert.deepEqual(store.listFindings("scan"), before)
    }
    assert.equal(warnings.length, paths.length)
    const updated = { ...row, status: "fixed", fix_summary: "Bind input" }
    writeFileSync(join(dir, "findings.json"), JSON.stringify([updated]))
    importFindings("scan", dir, store)
    importFindings("scan", dir, store)
    const stored = store.listFindings("scan")
    assert.equal(stored.length, 1)
    assert.equal(stored[0].status, "fixed")
    assert.equal(stored[0].fixSummary, updated.fix_summary)
  } finally {
    console.warn = warn
    store.close()
    rmSync(dir, { recursive: true })
  }
})

for (const kind of ["symlink", "oversized", "FIFO", "directory"]) {
  test(`findings ingestion warns and rejects a ${kind}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "ola-agent-"));
    const path = `${dir}/findings.json`;
    const warnings: unknown[][] = [];
    const warn = console.warn;
    let inserted = 0;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      if (kind === "symlink") {
        const target = `${dir}/outside.json`;
        writeFileSync(target, JSON.stringify([row]));
        mkdirSync(`${dir}/artifacts`);
        symlinkSync(target, `${dir}/artifacts/findings.json`);
      } else if (kind === "oversized") {
        writeFileSync(path, JSON.stringify([row]) + " ".repeat(5 * 1024 * 1024));
      } else if (kind === "FIFO") {
        const result = Bun.spawnSync(["mkfifo", path]);
        assert.equal(result.exitCode, 0);
      } else {
        mkdirSync(path);
      }
      assert.doesNotThrow(() => importFindings("run-1", kind === "symlink" ? `${dir}/artifacts` : dir, {
        insertFinding: () => { inserted++; },
      }));
      assert.equal(inserted, 0);
      assert.deepEqual(warnings, [["[scanner run-1] findings.json missing, unreadable, or invalid"]]);
    } finally {
      console.warn = warn;
      rmSync(dir, { recursive: true });
    }
  });
}

test("findings ingestion warns for missing/bad files and imports valid rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "ola-agent-"));
  const findings: Finding[] = [];
  const warnings: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  const store = { insertFinding: (runId: string, finding: Finding) => {
    assert.equal(runId, "run-1");
    findings.push(finding);
  } };
  try {
    importFindings("run-1", dir, store);
    for (const bad of ["{", "{}", "null"]) {
      writeFileSync(`${dir}/findings.json`, bad);
      importFindings("run-1", dir, store);
    }
    assert.equal(warnings.length, 4);
    assert.equal(findings.length, 0);
    writeFileSync(`${dir}/findings.json`, JSON.stringify([{}, row, { ...row, id: "b".repeat(64), status: "fixed" }]));
    importFindings("run-1", dir, store);
    assert.equal(warnings.length, 5);
    assert.equal(findings.length, 2);
    assert.equal(findings[0].fixSummary, row.fix_summary);
    assert.equal(findings[1].status, "fixed");
    writeFileSync(`${dir}/findings.json`, JSON.stringify([{ ...row, id: "c".repeat(64), verdict: "CONFIRMED", function: "f" }]));
    importFindings("run-1", dir, store);
    assert.equal(warnings.length, 5);
    assert.equal(findings.length, 3);
    assert.equal(Object.hasOwn(findings[2], "verdict"), false);
    writeFileSync(`${dir}/findings.json`, "[]");
    importFindings("run-1", dir, store);
    assert.equal(warnings.length, 5);
    writeFileSync(`${dir}/findings.json`, JSON.stringify([row]));
    importFindings("run-1", dir, { insertFinding: () => { throw new Error("storage unavailable"); } });
    assert.equal(warnings.length, 6);
  } finally {
    console.warn = warn;
    rmSync(dir, { recursive: true });
  }
});

test("tool-finalized scan findings import with stable IDs", () => {
  const dir = mkdtempSync(join(tmpdir(), "ola-agent-"));
  const path = `${dir}/findings.json`;
  try {
    const imported: Finding[] = [];
    for (const id of ["model-1", "model-2"]) {
      writeFileSync(path, JSON.stringify([{ ...row, id, function: "query", sink: "query(input)" }]));
      finalizeFindingIds(path, "scan");
      imported.push(...importFindings("scan", dir, { insertFinding: () => {} }));
    }
    assert.equal(imported.length, 2);
    assert.equal(imported[0].id, imported[1].id);
    assert.equal(isFindingRow(JSON.parse(readFileSync(path, "utf8"))[0]), true);
    writeFileSync(path, JSON.stringify([row]));
    finalizeFindingIds(path, "fix");
    assert.equal(importFindings("fix", dir, { insertFinding: () => {} })[0].id, row.id);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("findings ingestion accepts core and legacy artifact statuses", () => {
  const dir = mkdtempSync(join(tmpdir(), "ola-agent-"))
  try {
    for (const status of schema.items.properties.status.enum) {
      writeFileSync(`${dir}/findings.json`, JSON.stringify([{ ...row, status }]))
      const stored: Finding[] = []
      const imported = importFindings("run-1", dir, { insertFinding: (_runId, finding) => { stored.push(finding) } })
      assert.equal(imported.length, 1)
      assert.equal(stored[0].status, status)
    }
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("posting keeps ignored findings and false positives ignored and posts other findings open", async () => {
  const store = new MemoryStore();
  const findings: Finding[] = (["ignored", "candidate", "fixed", "false positive"] as const).map((status, i) => ({
    ...row, id: String(i + 1).repeat(64), severity: "P2", category: "sqli", file: `vendor/file-${i}.php`,
    status, reason: "vendor vendor: evidence",
  }));
  assert.deepEqual(await postFindings("scan", "owner/repo", findings, store), { added: 4, skipped: 0 });
  assert.deepEqual(store.files[0].rows.map(row => [row.file, row.status]).sort(), [
    ["vendor/file-0.php", "ignored"], ["vendor/file-1.php", "open"], ["vendor/file-2.php", "open"], ["vendor/file-3.php", "ignored"],
  ]);
});

test("tracked matching accepts promoted types in both legacy misc and destination files", async () => {
  for (const category of ["tls-verify-off", "vendor-cve"]) {
    const finding: Finding = { ...row, category, severity: "P0", status: "candidate", file: category === "vendor-cve" ? "example/client@1.2.3" : row.file }
    const legacy = { id: row.id, category: "misc", kind: category, file: finding.file!, lines: [row.line],
      severity: row.severity, status: "in progress" as const, reason: "Owner review", date: "01-01-2026", pr: "[PR #7](x)" }
    const destination = { ...legacy, id: "b".repeat(64), category, kind: undefined, file: "other/file.php" }
    const store = new MemoryStore()
    store.files = [
      { category: "misc", rows: [legacy], log: [], url: "https://example.test/misc.json" },
      { category, rows: [destination], log: [], url: `https://example.test/${category}.json` },
    ]
    for (const input of [finding, { ...finding, category: "misc", kind: category }]) {
      const matches = await matchTracked([input], store)
      assert.deepEqual(matches[finding.id], { kind: "tracked", url: "https://example.test/misc.json", file: legacy.file, line: row.line, status: "in progress" })
    }
  }
})
