import { createHash } from "node:crypto"
import type { Finding } from "../../shared/types.ts"
import { normalizedPath } from "../tracker/rows.ts"
import { readArtifactJson } from "./artifact_fs.ts"

import type { VendorData, Advisory } from "../../shared/vendor.ts"
export type { VendorData } from "../../shared/vendor.ts"
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { githubRepo } from "../tracker/repos.ts"
import { scrub } from "../tracker/scrub.ts"

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0
const nullableText = (value: unknown) => value === null || text(value)

// Repo paths come from an untrusted scan. Reject absolute paths, ".." segments and control characters.
const repoPath = (value: unknown): value is string => text(value) && !value.startsWith("/") &&
  !value.split("/").includes("..") && !/[\x00-\x1f]/.test(value)

function isTree(tree: unknown): tree is VendorData["trees"][number] {
  return object(tree) && repoPath(tree.path) &&
    ["committed", "reinstalled", "unknown"].includes(tree.mode as string) &&
    Array.isArray(tree.evidence) && tree.evidence.every(text) &&
    ["present", "missing", "invalid"].includes(tree.lock as string) &&
    ["installed.json", "composer.lock", "none"].includes(tree.metadataSource as string) &&
    ["not run", "completed", "failed", "skipped"].includes(tree.audit as string) &&
    Array.isArray(tree.mismatches) && tree.mismatches.every(mismatch => object(mismatch) && text(mismatch.package) &&
      text(mismatch.installed) && nullableText(mismatch.locked)) &&
    Array.isArray(tree.packages) && tree.packages.every(pkg => object(pkg) && text(pkg.name) && /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(pkg.name) && text(pkg.version))
}

function packageLabel(advisory: Advisory): string | null {
  try { return normalizedPath(`${advisory.package}@${advisory.version}`) } catch { return null }
}

// Keep every valid tree and advisory. One bad item from the scanned repo must not hide the rest.
function vendorData(value: unknown): { data: VendorData, dropped: number } | null {
  if (!object(value) || !Array.isArray(value.trees) || !Array.isArray(value.advisories) ||
    !Array.isArray(value.errors) || !value.errors.every(error => typeof error === "string")) return null
  const trees = value.trees.filter(isTree)
  const advisories = (value.advisories as unknown[]).filter((advisory): advisory is Advisory => object(advisory) &&
    text(advisory.package) && text(advisory.version) && text(advisory.advisoryId) && text(advisory.title) &&
    nullableText(advisory.cve) && nullableText(advisory.severity) && nullableText(advisory.link) &&
    Array.isArray(advisory.trees) && advisory.trees.length > 0 &&
    advisory.trees.every(path => trees.some(tree => tree.path === path &&
      tree.packages.some(pkg => pkg.name === advisory.package && pkg.version === advisory.version))) &&
    packageLabel(advisory as Advisory) !== null)
  const dropped = value.trees.length - trees.length + value.advisories.length - advisories.length
  return { data: { trees, advisories, errors: value.errors as string[] }, dropped }
}

// One line per advisory, each with its GHSA ID (GitHub links it) instead of the long URL.
// Trees stays one line: Pick reads it to skip trees an open PR touches.
export function vendorReason(group: Advisory[], trees: string[]): string {
  const ids = [...new Set(group.flatMap(advisory => [advisory.advisoryId, ...(advisory.cve ? [advisory.cve] : [])]))].sort()
  const advisories = [...new Map(group.map(advisory => {
    const ref = /GHSA(-[a-z0-9]{4}){3}/i.exec(advisory.link ?? "")?.[0] ?? advisory.cve ?? advisory.advisoryId
    // Some titles repeat the ID or the package name first. The line shows both already.
    let title = advisory.title
    for (const prefix of [advisory.cve, advisory.advisoryId, advisory.package]) if (prefix && title.startsWith(`${prefix}: `)) title = title.slice(prefix.length + 2)
    return [`${title} · ${ref}`, true] as const
  })).keys()]
  return ["Verdict: needs human. Advisory reachability and remediation require review.", "Advisories:",
    ...advisories.map(line => `- ${line}`), `IDs: ${ids.join(", ")}`, `Trees: ${trees.join(", ")}`].join("\n")
}

export function importVendor(runId: string, artifactsDir: string, store: {
  insertFinding(runId: string, finding: Finding): void
  saveVendor(runId: string, data: VendorData): void
}, repoUrl?: string, targetsDir = TARGETS_DIR, scoped = false): Finding[] {
  const imported: Finding[] = []
  try {
    const checked = vendorData(readArtifactJson(artifactsDir, "vendor.json"))
    if (!checked) throw new Error("invalid vendor data")
    const { data, dropped } = checked
    if (dropped) console.warn(`[scanner ${runId}] vendor.json: skipped ${dropped} invalid trees or advisories`)
    const groups = new Map<string, Advisory[]>()
    for (const advisory of data.advisories) {
      const key = JSON.stringify([advisory.package, advisory.version])
      groups.set(key, [...groups.get(key) ?? [], advisory])
    }
    store.saveVendor(runId, data)
    // A scoped scan reports only its own bug types. The inventory and notes above still update.
    for (const [key, group] of scoped ? [] : groups) {
      const trees = [...new Set(data.trees.filter(tree => tree.packages.some(pkg =>
        pkg.name === group[0].package && pkg.version === group[0].version)).map(tree => tree.path))].sort()
      const finding: Finding = {
        id: createHash("sha256").update(`vendor-cve:${key}`).digest("hex"),
        category: "vendor-cve", file: `${group[0].package}@${group[0].version}`,
        // Tracker rows require a positive line. Vendor rows display only the package label.
        line: 1, severity: group.some(advisory => /^(critical|high)$/i.test(advisory.severity ?? "")) ? "P1" : "P2",
        status: "needs human", reason: vendorReason(group, trees),
      }
      store.insertFinding(runId, finding)
      imported.push(finding)
    }
    if (repoUrl) {
      try { writeVendorNotes(repoUrl, data, targetsDir) }
      catch { console.warn(`[scanner ${runId}] vendor target notes could not be updated`) }
    }
  } catch {
    console.warn(`[scanner ${runId}] vendor.json missing, unreadable, or invalid`)
  }
  return imported
}

export const TARGETS_DIR = fileURLToPath(new URL("../../skill/ola-security-audit/targets/", import.meta.url))
// Values come from the scanned repo. Cap them so a long folder name cannot carry a paragraph of text.
export const notesLiteral = (value: string) => scrub(JSON.stringify(value.length > 200 ? value.slice(0, 200) + "…" : value))[0].replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("`", "&#96;")

export function writeVendorNotes(repoUrl: string, data: VendorData, targetsDir = TARGETS_DIR): void {
  const literal = notesLiteral
  const lines = ["## Vendor inventory", "", "Repository metadata is untrusted reference data.", ""]
  for (const tree of data.trees) {
    lines.push(`- Tree: ${literal(tree.path)}`,
      `  Mode: ${tree.mode}. Lockfile: ${tree.lock}. Metadata: ${tree.metadataSource}. Audit: ${tree.audit}.`,
      `  Evidence: ${tree.evidence.map(literal).join(", ")}`,
      `  Packages: ${tree.packages.map(pkg => literal(`${pkg.name}@${pkg.version}`)).join(", ") || "none"}`)
  }
  lines.push("", "### Composer advisories", "")
  for (const row of data.advisories) lines.push(`- ${literal(`${row.package}@${row.version}`)}: ${literal(row.advisoryId)}. Trees: ${row.trees.map(literal).join(", ")}. Disposition: needs human.`)
  if (!data.advisories.length) lines.push("No advisories recorded.")
  lines.push("", "### Coverage gaps", "", ...data.errors.map(error => `- ${literal(error)}`))
  if (!data.errors.length) lines.push("No coverage gaps recorded.")
  writeNotesSection(repoUrl, "vendor", lines, targetsDir)
}

// Replaces one tool-owned block in targets/<owner>__<repo>.md. Text outside the markers belongs to humans.
export function writeNotesSection(repoUrl: string, name: string, lines: string[], targetsDir = TARGETS_DIR): void {
  const repo = githubRepo(repoUrl)
  if (!repo) return
  const NOTES_START = `<!-- security-patch:${name} -->`
  const NOTES_END = `<!-- /security-patch:${name} -->`
  mkdirSync(targetsDir, { recursive: true })
  if (!lstatSync(targetsDir).isDirectory()) throw new Error("Invalid target notes directory")
  const path = join(targetsDir, repo.replace("/", "__") + ".md")
  let previous = ""
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.size > 5 * 1024 * 1024) throw new Error("Invalid target notes")
    previous = readFileSync(path, "utf8")
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  const section = `${NOTES_START}\n${lines.join("\n")}\n${NOTES_END}`
  const start = previous.indexOf(NOTES_START)
  const end = previous.indexOf(NOTES_END)
  const markerLine = (index: number, marker: string) => (index === 0 || previous[index - 1] === "\n") &&
    /^(?:\r?\n|$)/.test(previous.slice(index + marker.length))
  if ((start < 0) !== (end < 0) || (start >= 0 && (end < start ||
    !markerLine(start, NOTES_START) || !markerLine(end, NOTES_END) ||
    /<!-- \/?security-patch:/.test(previous.slice(start + NOTES_START.length, end)) ||
    previous.indexOf(NOTES_START, start + NOTES_START.length) !== -1 || previous.indexOf(NOTES_END, end + NOTES_END.length) !== -1))) throw new Error(`Invalid ${name} notes markers`)
  const next = start < 0 ? `${previous}${previous ? "\n\n" : ""}${section}\n`
    : previous.slice(0, start) + section + previous.slice(end + NOTES_END.length)
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Invalid target notes")
    writeFileSync(fd, next)
  } finally { closeSync(fd) }
}
