import { readFile } from "node:fs/promises"
// bun run backend/eval/score.ts --cases cases.json --findings findings.json [--false-positives fp.json] [--json]
import { posix } from "node:path"
import schema from "../../skill/ola-security-audit/findings.schema.json" with { type: "json" }

export const LINE_WINDOW = 10

type Site = { file: string, lines: number[] }
type Case = { pr: number, category: string, sites: Site[] }
type RuledOut = { category: string, file: string, line: number, note: string }
type Finding = { category: string, file: string, line: number, status: string }
type Counts = { sitesFound: number, sitesTotal: number, casesFound: number, casesTotal: number }
type InputKind = "cases" | "findings" | "false-positives"

function normalizedPath(file: string): string {
  const path = posix.normalize(file.replaceAll("\\", "/")
    .replace(/^\/workspace\/repo\//, "").replace(/^(?:\/|\.\/)+/, ""))
  if (path === "." || path === ".." || path.startsWith("../") ||
    path.startsWith("/") || /^[a-z]:/i.test(path)) {
    throw new Error("file must be a relative path within the repo")
  }
  return path
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function line(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1
}

function file(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false
  normalizedPath(value)
  return true
}

function category(value: unknown): value is string {
  return typeof value === "string" && schema.items.properties.category.enum.includes(value)
}

function validRow(row: unknown, kind: InputKind): boolean {
  if (!object(row) || !category(row.category)) return false
  if (kind === "cases") {
    return line(row.pr) && Array.isArray(row.sites) && row.sites.length > 0 &&
      row.sites.every((site) => object(site) && file(site.file) &&
        Array.isArray(site.lines) && site.lines.length > 0 && site.lines.every(line))
  }
  if (!file(row.file) || !line(row.line)) return false
  return kind === "findings"
    ? typeof row.status === "string" && schema.items.properties.status.enum.includes(row.status)
    : typeof row.note === "string"
}

export async function readInput(path: string, kind: "cases"): Promise<Case[]>
export async function readInput(path: string, kind: "findings"): Promise<Finding[]>
export async function readInput(path: string, kind: "false-positives"): Promise<RuledOut[]>
export async function readInput(path: string, kind: InputKind): Promise<unknown[]> {
  try {
    const rows: unknown = JSON.parse(await readFile(path, "utf8"))
    if (!Array.isArray(rows)) throw new Error("expected a JSON array")
    for (const [index, row] of rows.entries()) {
      try {
        if (!validRow(row, kind)) throw new Error(`invalid ${kind} row`)
      } catch (error) {
        throw new Error(`row ${index + 1}: ${(error as Error).message}`)
      }
    }
    return rows
  } catch (error) {
    throw new Error(`${kind} file ${JSON.stringify(path)}: ${(error as Error).message}`)
  }
}

function matches(finding: Finding, category: string, site: Site): boolean {
  return finding.status !== "false positive" && finding.category === category &&
    normalizedPath(finding.file) === normalizedPath(site.file) &&
    site.lines.some((line) => Math.abs(finding.line - line) <= LINE_WINDOW)
}

export function score(cases: Case[], findings: Finding[], ruledOut: RuledOut[] = []) {
  const caseScores = cases.map((entry) => {
    const sitesFound = entry.sites.filter((site) =>
      findings.some((finding) => matches(finding, entry.category, site))
    ).length
    return {
      pr: entry.pr,
      category: entry.category,
      sitesFound,
      sitesTotal: entry.sites.length,
      fullyFound: sitesFound === entry.sites.length,
    }
  })
  const categories: Record<string, Counts> = {}
  const total: Counts = { sitesFound: 0, sitesTotal: 0, casesFound: 0, casesTotal: 0 }
  for (const entry of caseScores) {
    const counts = categories[entry.category] ??= {
      sitesFound: 0, sitesTotal: 0, casesFound: 0, casesTotal: 0,
    }
    for (const target of [counts, total]) {
      target.sitesFound += entry.sitesFound
      target.sitesTotal += entry.sitesTotal
      target.casesFound += Number(entry.fullyFound)
      target.casesTotal++
    }
  }
  // ponytail: linear scans suit small baselines, index by category/file if they grow.
  const falsePositives: Finding[] = []
  const seen = new Set<string>()
  for (const site of ruledOut) {
    const key = JSON.stringify([site.category, normalizedPath(site.file), site.line])
    if (seen.has(key)) continue
    seen.add(key)
    const finding = findings.find((finding) =>
      matches(finding, site.category, { file: site.file, lines: [site.line] })
    )
    if (finding) falsePositives.push(finding)
  }
  return {
    cases: caseScores,
    categories,
    total,
    falsePositives: { count: falsePositives.length, findings: falsePositives },
  }
}

export function formatScore(result: ReturnType<typeof score>): string {
  const rows = ["Case\tCategory\tSites found"]
  for (const entry of result.cases) {
    rows.push(`${entry.pr}\t${entry.category}\tfound ${entry.sitesFound} of ${entry.sitesTotal}`)
  }
  rows.push("", "Category\tSites found\tCases fully found")
  for (const [name, counts] of [...Object.entries(result.categories), ["TOTAL", result.total]] as [string, Counts][]) {
    rows.push(`${name}\t${counts.sitesFound}/${counts.sitesTotal}\t${counts.casesFound}/${counts.casesTotal}`)
  }
  rows.push("", `False positives: ${result.falsePositives.count}`)
  for (const finding of result.falsePositives.findings) {
    rows.push(`${finding.category}\t${finding.file}:${finding.line}\t${finding.status}`)
  }
  return rows.join("\n")
}

export async function run(args: string[]): Promise<string> {
  const options = new Map<string, string>()
  let json = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--json") {
      json = true
    } else if (["--cases", "--findings", "--false-positives"].includes(arg)) {
      const value = args[++i]
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path`)
      if (options.has(arg)) throw new Error(`duplicate option: ${arg}`)
      options.set(arg, value)
    } else {
      throw new Error(`unknown option: ${arg}`)
    }
  }
  const casesPath = options.get("--cases")
  const findingsPath = options.get("--findings")
  if (!casesPath || !findingsPath) throw new Error("required options: --cases <path> --findings <path>")
  const cases = await readInput(casesPath, "cases")
  const findings = await readInput(findingsPath, "findings")
  const fpPath = options.get("--false-positives")
  const result = score(cases, findings, fpPath ? await readInput(fpPath, "false-positives") : [])
  return json ? JSON.stringify(result, null, 2) : formatScore(result)
}

if (import.meta.main) {
  try {
    console.log(await run(process.argv.slice(2)))
  } catch (error) {
    console.error(`score: ${(error as Error).message}`)
    process.exitCode = 1
  }
}
