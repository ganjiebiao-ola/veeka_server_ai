import { posix } from "node:path"
import { LINE_WINDOW } from "../eval/score.ts"
import schema from "../../skill/ola-security-audit/findings.schema.json" with { type: "json" }
import { scrub } from "./scrub.ts"

export const CATEGORIES = schema.items.properties.category.enum
export const STATUSES = ["open", "in progress", "fixed", "ignored", "needs human"] as const
const LEGACY_STATUSES = {
  candidate: "open", deferred: "open", picked: "in progress", "in PR": "in progress",
  "false positive": "ignored", "won't fix": "ignored",
} as const
export type Status = typeof STATUSES[number]
export const SEVERITIES = ["P0", "P1", "P2", ""] as const
export type Row = {
  id: string, category: string, file: string, lines: number[],
  severity: string, status: Status | keyof typeof LEGACY_STATUSES, reason: string, date: string, pr: string,
  /** misc only: the bug type, kebab-case. A type that keeps showing up can become its own category. */
  kind?: string,
}
export const isVendorRow = (row: Pick<Row, "category" | "kind">): boolean =>
  row.category === "vendor-cve" || row.category === "misc" && row.kind === "vendor-cve"
export const START = "<!-- security-patch:rows -->"
export const END = "<!-- /security-patch:rows -->"
const OLD_HEADER = "| id | file:line | subsystem | severity | status | reason | batch | PR |"

const OLD_HEADER_7 = "| File | Status | Severity | Subsystem | Reason | Batch | PR |"
const HEADER = "| File | Status | Severity | Date | Reason | PR |"
const MISC_HEADER = "| File | Type | Status | Severity | Date | Reason | PR |"
// Most pressing first. Fixed rows are folded below the active rows.
const STATUS_ORDER: Status[] = ["open", "in progress", "needs human", "ignored", "fixed"]
export const coreStatus = (status: Row["status"]): Status => Object.hasOwn(LEGACY_STATUSES, status)
  ? LEGACY_STATUSES[status as keyof typeof LEGACY_STATUSES] : status as Status

/** Today as dd-mm-yyyy (UTC), the date a row is added. */
export function today(now = new Date()): string {
  return now.toISOString().slice(0, 10).split("-").reverse().join("-")
}
const dateKey = (date: string): string => date.split("-").reverse().join("")

// Same normalization as eval/score.ts, whose helper is private.
export function normalizedPath(file: string): string {
  const path = posix.normalize(file.replaceAll("\\", "/")
    .replace(/^\/workspace\/repo\//, "").replace(/^(?:\/|\.\/)+/, ""))
  if (path === "." || path === ".." || path.startsWith("../") ||
    path.startsWith("/") || /^[a-z]:/i.test(path)) throw new Error("file must be a relative path within the repo")
  return path
}

export function validateRow(row: Row): void {
  if (!CATEGORIES.includes(row.category) || (!(STATUSES as readonly string[]).includes(row.status) && !Object.hasOwn(LEGACY_STATUSES, row.status)) ||
    !(SEVERITIES as readonly string[]).includes(row.severity) || !/^\d{2}-\d{2}-\d{4}$/.test(row.date) ||
    !row.id || !row.file || !row.lines.length ||
    !row.lines.every(line => Number.isSafeInteger(line) && line > 0) ||
    ![row.id, row.file, row.reason, row.pr].every(value => typeof value === "string") ||
    (row.category === "misc" ? !/^([a-z0-9]+(-[a-z0-9]+)*)?$/.test(row.kind ?? "") || (row.kind ?? "").length > 40 : row.kind)) {
    throw new Error("invalid tracker row")
  }
  validateRowId(row.id)
  normalizedPath(row.file)
}

export function validateRowId(id: string): void {
  const seed = /^pr([1-9]\d*):(.+)$/.exec(id)
  if (seed) {
    if (!Number.isSafeInteger(Number(seed[1]))) throw new Error("invalid tracker row id")
    normalizedPath(seed[2])
  } else if (!/^[a-f0-9]+$/i.test(id)) throw new Error("invalid tracker row id")
}

function bounds(body: string): [number, number] {
  const start = body.indexOf(START)
  const end = body.indexOf(END)
  if (start < 0 || end < start + START.length ||
    body.indexOf(START, start + START.length) !== -1 || body.indexOf(END, end + END.length) !== -1) {
    throw new Error("tracker body requires exactly one ordered marker pair")
  }
  return [start + START.length, end]
}

export function encode(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll("|", "&#124;").replaceAll("\r", "&#13;").replaceAll("\n", "&#10;")
}
// Reasons can hold text from the scanned repo. Keep markdown links, images and @mentions inert.
export function inert(value: string): string {
  return value.replaceAll("[", "&#91;").replaceAll("]", "&#93;").replaceAll("(", "&#40;").replaceAll(")", "&#41;").replaceAll("@", "&#64;")
}
function decode(value: string): string {
  return value.replaceAll("&#91;", "[").replaceAll("&#93;", "]").replaceAll("&#40;", "(").replaceAll("&#41;", ")").replaceAll("&#64;", "@")
    .replaceAll("&#10;", "\n").replaceAll("&#13;", "\r").replaceAll("&#124;", "|")
    .replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&")
}

// A reason line break shows as <br> in the table, and a known label at a line start is bold.
// encode escapes "<" in the text itself, so every raw tag in a reason cell is ours and parses back.
// Same list as LABEL in frontend/src/components/Reason.tsx.
const LABELS = /(^|&#10;)(Verdict|Evidence|Severity|Fix|Advisories|IDs|Trees|Ignored|Earlier reason):/g
function cellBreaks(value: string): string {
  return value.replace(LABELS, "$1<b>$2:</b>").replaceAll("&#10;", "<br>")
}
function uncellBreaks(value: string): string {
  return value.replaceAll("<br>", "&#10;").replace(/<b>(Verdict|Evidence|Severity|Fix|Advisories|IDs|Trees|Ignored|Earlier reason):<\/b>/g, "$1:")
}

export function renderRows(rows: Row[], repo = "owner/repo"): string {
  rows = rows.map(row => {
    validateRow(row)
    return { ...row, status: coreStatus(row.status), pr: row.status === "false positive" ? "" : row.pr }
  })
  const misc = rows.some(row => row.category === "misc")
  const kinds = [...new Set(rows.map(row => row.kind || "untyped"))].map(kind => [kind, rows.filter(row => (row.kind || "untyped") === kind).length] as const)
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1)).map(([kind, count]) => `\`${kind}\` ${count}`)
  const counts = STATUS_ORDER.map(status => [status, rows.filter(row => row.status === status).length] as const)
    .filter(([, count]) => count).map(([status, count]) => `${status}: ${count}`)
  const ordered = [...rows].sort((a, b) => STATUS_ORDER.indexOf(coreStatus(a.status)) - STATUS_ORDER.indexOf(coreStatus(b.status)) ||
    SEVERITIES.indexOf(a.severity as never) - SEVERITIES.indexOf(b.severity as never) ||
    (dateKey(a.date) < dateKey(b.date) ? -1 : dateKey(a.date) > dateKey(b.date) ? 1 : 0) ||
    (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.lines[0] - b.lines[0])
  const line = (row: Row) => {
    // A vendor label is a checked package@version. Scrubbing it would redact versions such as 1.2.3.4 as an IP.
    const file = isVendorRow(row) ? row.file : scrub(row.file)[0]
    const label = encode(`${posix.basename(file)}:${row.lines[0]}`).replaceAll("[", "&#91;").replaceAll("]", "&#93;")
    const path = file.split("/").map(part => encodeURIComponent(part).replaceAll("(", "%28").replaceAll(")", "%29")).join("/")
    const id = encodeURIComponent(row.id).replaceAll("-", "%2D")
    const site = isVendorRow(row)
      ? `<code>${encode(file)}</code><!-- id:${id} lines:${row.lines.join(",")} package:${encodeURIComponent(file)} -->`
      : `[${label}](https://github.com/${repo}/blob/main/${path}#L${row.lines[0]})<br><sub>${encode(posix.dirname(file))}</sub><!-- id:${id} lines:${row.lines.join(",")} -->`
    return `| ${[site, ...(misc ? [encode(row.kind ?? "")] : []), ...[row.status, row.severity, row.date].map(encode), cellBreaks(inert(encode(scrub(row.reason)[0]))), encode(row.pr)].join(" | ")} |`
  }
  const table = (lines: string[]) => misc
    ? `${MISC_HEADER}\n| --- | --- | --- | --- | --- | --- | --- |\n${lines.join("\n")}\n`
    : `${HEADER}\n| --- | --- | --- | --- | --- | --- |\n${lines.join("\n")}\n`
  const open = ordered.filter(row => row.status !== "fixed").map(line)
  // Fixed rows need no action, so each PR folds into one collapsed line (muchen).
  const groups = new Map<string, Row[]>()
  for (const row of ordered.filter(row => row.status === "fixed")) groups.set(row.pr, [...groups.get(row.pr) ?? [], row])
  const prNumber = (pr: string) => Number(/#(\d+)/.exec(pr)?.[1] ?? Infinity)
  const fixed = [...groups].sort(([a], [b]) => prNumber(a) - prNumber(b) || (a < b ? -1 : a > b ? 1 : 0)).map(([pr, group]) => {
    const name = encode(scrub(/^\[([^\]]*)\]/.exec(pr)?.[1] ?? pr)[0]) || "No PR"
    return `<details><summary>Fixed · ${name} · ${group.length} finding${group.length === 1 ? "" : "s"}</summary>\n\n${table(group.map(line))}\n</details>\n`
  })
  return `\n**${rows.length} findings**${counts.length ? " · " + counts.join(" · ") : ""}\n\n${misc ? `Types: ${kinds.join(" · ")}\n\n` : ""}${open.length || !rows.length ? table(open) : ""}${fixed.length ? "\n" + fixed.join("\n") : ""}`
}

export function parseRows(body: string, category: string): Row[] {
  const [start, end] = bounds(body)
  const rows: Row[] = []
  let misc = false
  let columns: number | undefined
  for (const raw of body.slice(start, end).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith("|")) {
      if (line.includes("<!-- id:")) throw new Error("invalid tracker table")
      continue
    }
    if ([HEADER, MISC_HEADER, OLD_HEADER, OLD_HEADER_7].includes(line)) {
      misc = line === MISC_HEADER
      columns = line.split("|").length - 2
      continue
    }
    if (/^\|[\s|:-]+$/.test(line)) continue
    const cells = line.replace(/\\[\\|]/g, escape => escape === "\\|" ? "&#124;" : escape)
      .split("|").slice(1, -1).map(value => value.trim())
    if (!line.endsWith("|") || columns !== undefined && cells.length !== columns) throw new Error("invalid tracker table")
    const kind = misc ? decode(cells.splice(1, 1)[0] ?? "") : undefined
    let row: Row
    if (cells.length === 8) {
      const site = /^(.*):(\d+)(?: <!-- lines:([\d,]+) -->)?$/.exec(cells[1])
      if (!site) throw new Error("invalid tracker site")
      const [id, , , severity, status, reason, , pr] = cells.map(decode)
      // Old formats have no date. They were added to the issue before this change, so stamp the migration day.
      row = { id, category, file: decode(site[1]), lines: (site[3] ?? site[2]).split(",").map(Number), severity, status: status as Status, reason, date: today(), pr }
    } else if (cells.length === 7 || cells.length === 6) {
      const site = /<!-- id:(\S+) lines:([\d,]+)(?: package:(\S+))? -->/.exec(cells[0])
      const file = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/blob\/main\/(.*?)#L\d+/.exec(cells[0])
      if (!site || (!file && !(isVendorRow({ category, kind }) && site[3]))) throw new Error("invalid tracker site")
      const [status, severity, date, reason, pr] = cells.length === 6
        ? cells.slice(1).map(uncellBreaks).map(decode)
        : [cells[1], cells[2], today(), cells[4], cells[6]].map(uncellBreaks).map(decode)
      row = { id: decodeURIComponent(site[1]), category, file: site[3] ? decodeURIComponent(site[3]) : file![1].split("/").map(decodeURIComponent).join("/"), lines: site[2].split(",").map(Number), severity, status: status as Status, reason, date, pr }
    } else throw new Error("invalid tracker table")
    if (category === "misc") row.kind = kind ?? ""
    validateRow(row)
    row.status = coreStatus(row.status)
    if (rows.some(existing => existing.id === row.id)) throw new Error("duplicate tracker row id")
    rows.push(row)
  }
  return rows
}

export function replaceRows(body: string, rows: Row[], repo = "owner/repo"): string {
  const [start, end] = bounds(body)
  return body.slice(0, start) + renderRows(rows, repo) + body.slice(end)
}

export function upsert(rows: Row[], row: Row): Row[] {
  validateRow(row)
  const index = rows.findIndex(existing => existing.id === row.id)
  return index === -1 ? [...rows, row] : rows.map((existing, i) => i === index ? row : existing)
}

export function isDuplicate(rows: Row[], finding: { id: string, category: string, file: string, line: number }): boolean {
  return rows.some(row => row.id === finding.id ||
    (row.category === finding.category && normalizedPath(row.file) === normalizedPath(finding.file) &&
      row.lines.some(line => Math.abs(line - finding.line) <= LINE_WINDOW)))
}
