// Resume helpers. Pure, so they can be unit-tested with `bun test`.
import schema from "../../skill/ola-security-audit/findings.schema.json" with { type: "json" };
import { assignFindingIds } from "./finding-ids.mjs";

// Errors that mean "come back when quota is back", not "the run is broken".
export const isQuotaError = (message) => /rate.?limit|usage limit|\bsession limit\b|quota|credit balance|out of credits|free limit reached|lite model limit|\b429\b|overloaded|exhausted/i.test(String(message));

const scanPath = (file) => typeof file === "string" && file.length > 0 && file.length <= 4096 &&
  !/[\x00-\x1f\x7f\\]/.test(file) && !file.startsWith("/") && !file.includes(":") &&
  file.split("/").every(part => part && part !== "." && part !== "..");

export function parseScanCoverage(value) {
  if (value && !Array.isArray(value) && typeof value === "object") value = value.coveredFiles;
  if (!Array.isArray(value) || value.length > 100_000 || !value.every(scanPath)) return [];
  return [...new Set(value)];
}

function scanFindings(value) {
  if (!Array.isArray(value) || value.length > 100_000) throw new Error("invalid scan findings");
  return value.map(row => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("invalid scan finding");
    const { id, ...finding } = row;
    const properties = schema.items.properties;
    if (Object.keys(finding).some(key => !Object.hasOwn(properties, key) && key !== "function" && key !== "sink") ||
        schema.items.required.some(key => key !== "id" && !Object.hasOwn(finding, key)) ||
        finding.status !== "candidate" || !scanPath(finding.file) ||
        Object.hasOwn(finding, "kind") !== (finding.category === "misc") ||
        ["function", "sink"].some(key => Object.hasOwn(finding, key) && typeof finding[key] !== "string") ||
        Object.entries(properties).some(([key, rule]) => {
          if (key === "id" || !Object.hasOwn(finding, key)) return false;
          const v = finding[key];
          return rule.type === "integer" ? !Number.isSafeInteger(v) || v < rule.minimum :
            typeof v !== "string" || (rule.enum && !rule.enum.includes(v)) ||
            (rule.minLength !== undefined && v.length < rule.minLength) ||
            (rule.maxLength !== undefined && v.length > rule.maxLength) ||
            (rule.pattern && !new RegExp(rule.pattern).test(v));
        })) throw new Error("invalid scan finding");
    return finding;
  });
}

export function mergeScanFindings(seed, rows) {
  const findings = [...scanFindings(seed), ...scanFindings(rows)];
  const ids = assignFindingIds(findings, "scan");
  return [...new Map(findings.map((row, index) => [ids[index].id, row])).values()];
}

export function parseScanCheckpoint(checkpoint) {
  try {
    const scan = checkpoint.scan;
    return { findings: mergeScanFindings([], scan.findings), coveredFiles: parseScanCoverage(scan.coveredFiles) };
  } catch { return { findings: [], coveredFiles: [] }; }
}

// Findings the checkpoint marks done: any final status.
export function doneIds(findings) {
  return Array.isArray(findings)
    ? findings.filter((f) => f && typeof f.id === "string" && ["fixed", "false positive", "needs human"].includes(f.status)).map((f) => f.id)
    : [];
}

// Where a batch run got to. stopRun saves it in checkpoint.json and Resume carries it forward.
// phase: "fix" (fix round not finished), "review" (fix done), "checks" (review done).
// review: one entry per inspected review round, { round, notesFile, notes, fixed, reworkBase? }. reworkBase: revision before round-1 rework.
// checkFixRounds: check-step fix rounds that finished. Both limits count across the original and resumed runs.
export const REVIEW_ROUNDS = 2;
export const CHECK_ROUNDS = 2;
export const newProgress = () => ({ phase: "fix", review: [], checkFixRounds: 0, checksPassed: false });

// checkpoint.json is a file the run wrote, so read it strictly. Anything odd counts as no progress.
export function parseProgress(checkpoint) {
  const p = checkpoint?.progress;
  const out = newProgress();
  if (!["review", "checks"].includes(p?.phase)) return out;
  out.phase = p.phase;
  for (const r of Array.isArray(p.review) ? p.review.slice(0, REVIEW_ROUNDS) : []) {
    if (r?.round !== out.review.length + 1 || !Number.isInteger(r.notes) || r.notes < 0) break;
    out.review.push({ round: r.round, notesFile: `review-${r.round}.json`, notes: r.notes, fixed: r.fixed === true,
      ...(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(r.reworkBase ?? "") ? { reworkBase: r.reworkBase } : {}) });
  }
  if (out.phase === "checks") {
    out.checkFixRounds = Number.isInteger(p.checkFixRounds) ? Math.min(Math.max(p.checkFixRounds, 0), CHECK_ROUNDS) : 0;
    out.checksPassed = p.checksPassed === true;
  }
  return out;
}

// The fix round is not repeated once the checkpoint passed it or every picked row is done.
export const fixRoundDone = (progress, done, picked) =>
  progress.phase !== "fix" || (picked.length > 0 && picked.every((id) => done.includes(id)));

export function coverageOutput(coveredFiles, inventory) {
  return inventory ? { coveredFiles, consideredFiles: inventory.files, categories: inventory.categories } : coveredFiles
}
