import schema from "../../skill/ola-security-audit/findings.schema.json" with { type: "json" };
import type { Finding } from "../../shared/types.ts";
import { readArtifactJson } from "./artifact_fs.ts"

import { storeRows, type TrackerStore } from "../tracker/store.ts"
import { Tracker } from "../tracker/tracker.ts"
import { CATEGORIES, normalizedPath, type Row } from "../tracker/rows.ts"
import { LINE_WINDOW } from "../eval/score.ts"

type FindingRow = Required<Omit<Finding, "fixSummary" | "kind">> & { fix_summary: string; kind?: string };
type Property = { type: string; enum?: string[]; pattern?: string; minLength?: number; maxLength?: number; minimum?: number };

// Read the constraints from the artifact schema so the producer and consumer
// use one contract. This schema only uses these property constraints.
export function isFindingRow(value: unknown): value is FindingRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const properties: Record<string, Property> = schema.items.properties;
  if (schema.items.required.some((key) => !Object.hasOwn(row, key))) return false;
  if (Object.keys(row).some((key) => !Object.hasOwn(properties, key))) return false;
  if (Object.hasOwn(row, "kind") !== (row.category === "misc")) return false;
  // normalizedPath strips a /workspace/repo/ prefix and turns backslashes into slashes.
  if (typeof row.file !== "string" || /[\x00-\x1f\x7f]/.test(row.file) ||
    row.file.replaceAll("\\", "/").split("/").includes("..")) return false
  try { normalizedPath(row.file) } catch { return false }
  return Object.entries(properties).every(([key, rule]) => {
    const v = row[key];
    if (!Object.hasOwn(row, key) && !schema.items.required.includes(key)) return true;
    if (rule.type === "integer") {
      return typeof v === "number" && Number.isSafeInteger(v) && v >= rule.minimum!;
    }
    return typeof v === "string" &&
      (rule.minLength === undefined || v.length >= rule.minLength) &&
      (rule.maxLength === undefined || v.length <= rule.maxLength) &&
      (!rule.enum || rule.enum.includes(v)) &&
      (!rule.pattern || new RegExp(rule.pattern).test(v));
  });
}

export function importFindings(runId: string, artifactsDir: string, store: { insertFinding(runId: string, finding: Finding): void }): Finding[] {
  const imported: Finding[] = []
  try {
    const rows = readArtifactJson(artifactsDir, "findings.json")
    if (!Array.isArray(rows)) throw new Error("expected an array");
    for (const [index, raw] of rows.entries()) {
      // The model writes this file and sometimes adds keys (e.g. "verdict"). Drop them, keep the row.
      const row = raw && typeof raw === "object" && !Array.isArray(raw)
        ? Object.fromEntries(Object.entries(raw).filter(([key]) => Object.hasOwn(schema.items.properties, key)))
        : raw;
      if (!isFindingRow(row)) {
        console.warn(`[scanner ${runId}] findings.json: invalid row ${index}`);
        continue;
      }
      try {
        const finding = { ...row, fixSummary: row.fix_summary }
        store.insertFinding(runId, finding);
        imported.push(finding)
      } catch {
        console.warn(`[scanner ${runId}] findings.json: could not store row ${index}`);
      }
    }
  } catch {
    // Do not log artifact contents. Findings can contain sensitive snippets.
    console.warn(`[scanner ${runId}] findings.json missing, unreadable, or invalid`);
  }
  return imported
}


// Post the findings the dev ticked in the Run tab as rows on the repo's GitHub tracking issues.
// Rows the issues already hold count as skipped. Errors reach the caller.
export async function postFindings(
  runId: string,
  repo: string,
  findings: Finding[],
  store: TrackerStore,
): Promise<{ added: number, skipped: number }> {
  const counts = { added: 0, skipped: 0 }
  if (!findings.length) return counts
  const tracker = new Tracker(store, repo)
  const groups = new Map<string, Finding[]>()
  for (const finding of findings) {
    const category = finding.category === "misc" && finding.kind && CATEGORIES.includes(finding.kind) ? finding.kind : finding.category
    const group = groups.get(category) ?? []
    group.push(finding)
    groups.set(category, group)
  }
  for (const [category, group] of groups) {
    let latest = { added: 0, skipped: 0 }
    await tracker.scan(category, group.map(finding => ({
      id: finding.id, category, file: finding.file!, line: finding.line!,
      severity: finding.severity, status: finding.status === "ignored" || finding.status === "false positive" ? "ignored" : "open", reason: finding.reason ?? "",
      ...(category === "misc" ? { kind: finding.kind ?? "" } : {}),
    })), ({ added, skipped }) => {
      latest = { added, skipped }
      return `Scan ${runId}: added ${added}, skipped ${skipped} known.`
    })
    counts.added += latest.added
    counts.skipped += latest.skipped
  }
  return counts
}

// A row the repo's tracking issues already hold that overlaps a finding.
//  - tracked: same id, or same bug type, file and line.
//  - similar: same bug type and file, within LINE_WINDOW lines. Posting would skip it as known.
export type TrackedMatch = { kind: "tracked" | "similar", url: string, file: string, line: number, status: string }

export async function matchTracked(
  findings: Finding[],
  store: TrackerStore,
): Promise<Record<string, TrackedMatch>> {
  const files = await store.read()
  const rows = new Map<string, { url: string, row: Row }[]>()
  for (const row of storeRows(files)) {
    const file = files.find(file => file.category === row.category)!
    const category = row.category === "misc" && row.kind && CATEGORIES.includes(row.kind) ? row.kind : row.category
    const group = rows.get(category) ?? []
    group.push({ url: file.url, row })
    rows.set(category, group)
  }
  const path = (file: string) => { try { return normalizedPath(file) } catch { return file } }
  const matches: Record<string, TrackedMatch> = {}
  for (const finding of findings) {
    const category = finding.category === "misc" && finding.kind && CATEGORIES.includes(finding.kind) ? finding.kind : finding.category
    const tracked = rows.get(category)
    const line = finding.line
    if (!tracked || !finding.file || !line) continue
    const file = path(finding.file)
    let best: TrackedMatch | undefined
    for (const { url, row } of tracked) {
      const sameFile = path(row.file) === file
      const exact = row.id === finding.id || (sameFile && row.lines.includes(line))
      const near = sameFile ? row.lines.find(other => Math.abs(other - line) <= LINE_WINDOW) : undefined
      if (!exact && near === undefined) continue
      best = { kind: exact ? "tracked" : "similar", url, file: row.file, line: exact ? row.lines[0] : near!, status: row.status }
      if (exact) break
    }
    if (best) matches[finding.id] = best
  }
  return matches
}
