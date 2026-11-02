import { retryTracker, type TrackerStore, type TrackerFile } from "./store.ts"
import { CATEGORIES, isDuplicate, normalizedPath, today, upsert, validateRow } from "./rows.ts"
import type { Row } from "./rows.ts"
import { scrub } from "./scrub.ts"

// category and kind are optional overrides for PRs whose branch name doesn't say the bug type.
export type SeedPR = { number: number, headRefName: string, state: "merged" | "open" | "closed", sites: { file: string, lines: number[] }[], category?: string, kind?: string, createdAt?: string }
const BRANCHES: [RegExp, string][] = [
  [/(^|-)sqli(-|$)/, "sqli"], [/^(cmd|command)-injection|exec-escaping/, "cmd-injection"],
  [/^(deserializ|unserialize)/, "deserialization"],
  [/hash-equals|token-compare|^loose-(token|signature)-comparison/, "signature-compare"],
  [/^creds-|^hardcoded-signature|^prod-credentials/, "hardcoded-secret"],
  [/^(ssrf|verifyimagesrv)/, "path-ssrf"], [/^(xscrypt|crypto-migration)/, "weak-hash"],
  [/loginexempt.*whitelist|^auth-gate-explicit-whitelist/, "api-no-auth"], [/^secure-random-/, "weak-random"],
  [/^log-redact/, "log-leak"], [/^deadcode/, "dead-code"], [/^cors/, "cors"],
]
export function branchCategory(branch: string): string | undefined {
  const name = branch.replace(/^security\//, "")  // real PR branches are security/<slug>
  // A security branch that fits no type goes to misc. A type that keeps showing up there can become its own.
  return BRANCHES.find(([pattern]) => pattern.test(name))?.[1] ?? (branch.startsWith("security/") ? "misc" : undefined)
}

// A seeded row is dated by the day its PR was opened, when the seed knows it.
const seedDate = (pr: SeedPR) => pr.createdAt ? today(new Date(pr.createdAt)) : today()
const seedCategory = (pr: SeedPR) => pr.category ?? branchCategory(pr.headRefName)

export function validateSeed(input: unknown): SeedPR[] {
  if (!Array.isArray(input)) throw new Error("seed requires a PR array")
  for (const pr of input) {
    if (!pr || !Number.isSafeInteger(pr.number) || pr.number < 1 ||
      typeof pr.headRefName !== "string" || !["merged", "open", "closed"].includes(pr.state) ||
      !Array.isArray(pr.sites) || !pr.sites.length ||
      (pr.category !== undefined && !CATEGORIES.includes(pr.category)) ||
      (pr.createdAt !== undefined && (typeof pr.createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(pr.createdAt) || isNaN(Date.parse(pr.createdAt)))) ||
      (pr.kind !== undefined && (seedCategory(pr) !== "misc" || typeof pr.kind !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(pr.kind) || pr.kind.length > 40))) throw new Error("invalid seed PR")
    const files = new Set<string>()
    for (const site of pr.sites) {
      if (!site || typeof site.file !== "string" || !site.file || !Array.isArray(site.lines) ||
        !site.lines.length || !site.lines.every((line: number) => Number.isSafeInteger(line) && line > 0)) throw new Error("invalid seed site")
      const file = normalizedPath(site.file)
      if (files.has(file)) throw new Error("seed PR requires one site per file")
      files.add(file)
    }
  }
  return input
}

export const emptyFile = (category: string): TrackerFile => ({ category, rows: [], log: [], url: "" })

export type TrackerComment = string | ((counts: { added: number, skipped: number }) => string)

// shortcut: process-local writes, use a shared lock if multiple backends write the same tracker.
const writes = new Map<string, Promise<unknown>>()
export function withTrackerLock<T>(repo: string, write: () => Promise<T>): Promise<T> {
  const next = (writes.get(repo) ?? Promise.resolve()).catch(() => {}).then(write)
  writes.set(repo, next)
  return next.finally(() => { if (writes.get(repo) === next) writes.delete(repo) })
}

export class Tracker {
  constructor(private store: TrackerStore, readonly repo = "owner/repo") {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("invalid tracker repository")
  }

  async update(category: string, changes: (rows: Row[]) => Row[], comment: TrackerComment, scanner = false): Promise<boolean> {
    return withTrackerLock(this.repo, () => this.updateRows(category, changes, comment, scanner))
  }

  private async updateRows(category: string, changes: (rows: Row[]) => Row[], comment: TrackerComment, scanner: boolean): Promise<boolean> {
    if (!CATEGORIES.includes(category)) throw new Error("unknown tracker category")
    return retryTracker(this.store, async files => {
      const file = files.find(file => file.category === category) ?? emptyFile(category)
      const legacy = scanner && category !== "misc"
        ? (files.find(file => file.category === "misc")?.rows ?? []).filter(row => row.kind === category).map(({ kind, ...row }) => ({ ...row, category }))
        : []
      let rows = file.rows
      let added = 0
      let skipped = 0
      for (const row of changes(file.rows)) {
        validateRow(row)
        if (row.category !== category) throw new Error("row category differs from issue")
        if (scanner && isDuplicate([...rows, ...legacy], { ...row, line: row.lines[0] })) { skipped++; continue }
        added++
        rows = upsert(rows, row)
      }
      const changed = JSON.stringify(rows) !== JSON.stringify(file.rows)
      const message = typeof comment === "function" ? comment({ added, skipped }) : comment
      const scanPrefix = scanner ? /^Scan [^:]+:/.exec(message)?.[0] : undefined
      const log = message && (!scanner || added > 0) && (!scanPrefix || !file.log.some(entry => entry.message.startsWith(scanPrefix))) ? scrub(message)[0] : ""
      if (changed || log) await this.store.write(file, rows, log)
      return changed
    })
  }

  async scan(category: string, findings: { id: string, category: string, file: string, line: number, kind?: string, severity: string, status: Row["status"], reason: string }[], comment: TrackerComment): Promise<boolean> {
    return await this.update(category, () => findings.map(finding => ({
      ...finding, lines: [finding.line], date: today(), pr: "",
    })), comment, true)
  }

  async seed(input: SeedPR[], onlyType?: string): Promise<{ unmapped: number[], changed: string[] }> {
    return withTrackerLock(this.repo, () => this.seedRows(input, onlyType))
  }

  private async seedRows(input: SeedPR[], onlyType?: string): Promise<{ unmapped: number[], changed: string[] }> {
    const prs = validateSeed(input)
    if (onlyType !== undefined && !CATEGORIES.includes(onlyType)) throw new Error("unknown seed type")
    const unmapped = prs.filter(pr => !seedCategory(pr)).map(pr => pr.number)
    const changed: string[] = []
    const seedPR = (row: { id: string }) => prs.find(pr => row.id.startsWith(`pr${pr.number}:`))
    // A misc PR with no kind keeps whatever issue its rows were promoted to.
    const keeps = (pr: SeedPR | undefined, category: string) => !pr || seedCategory(pr) === category ||
      seedCategory(pr) === "misc" && (pr.kind === undefined || pr.kind === category)
    const lands = (row: Row) => { const pr = seedPR(row); const to = pr && seedCategory(pr); return !!to && (!onlyType || onlyType === to) }
    const removals: { category: string, sources: Row[] }[] = []
    for (const category of onlyType ? [onlyType] : CATEGORIES) {
      const rows: Row[] = prs.filter(pr => seedCategory(pr) === category).flatMap(pr =>
        pr.sites.map(site => ({
          id: `pr${pr.number}:${site.file}`, category, file: site.file, lines: site.lines,
          severity: "", date: seedDate(pr), status: pr.state === "merged" ? "fixed" : pr.state === "open" ? "in progress" : "open",
          ...(category === "misc" ? { kind: pr.kind ?? "" } : {}),
          reason: "Seeded from PR", pr: `[PR #${pr.number}](https://github.com/${this.repo}/pull/${pr.number})`,
        })))
      const result = await retryTracker(this.store, async files => {
        const file = files.find(file => file.category === category) ?? emptyFile(category)
        const placed = new Map(files.flatMap(file => file.rows.map(row => [row.id, row] as const)))
        const ids = new Set(file.rows.filter(row => !keeps(seedPR(row), category) && lands(row)).map(row => row.id))
        const existing = file.rows
          .map(row => category === "misc" && !row.kind && seedPR(row)?.kind ? { ...row, kind: seedPR(row)!.kind } : row)
          .map(row => seedPR(row)?.createdAt ? { ...row, date: seedDate(seedPR(row)!) } : row)
        const elsewhere = (row: Row) => { const at = placed.get(row.id)?.category; return !!at && at !== category && (onlyType !== undefined || keeps(seedPR(row), at)) }
        const carried = (row: Row) => {
          const old = placed.get(row.id)
          if (!old || old.category === category) return row
          const { kind, ...fields } = old
          return { ...fields, category, ...(row.kind !== undefined ? { kind: row.kind } : {}), ...(seedPR(row)?.createdAt ? { date: row.date } : {}) }
        }
        const additions = rows.filter(row => !existing.some(old => old.id === row.id) && !elsewhere(row)).map(carried)
        const next = additions.reduce(upsert, existing)
        const didChange = JSON.stringify(next) !== JSON.stringify(file.rows)
        if (didChange) await this.store.write(file, next, additions.length ? scrub(`Seed: added ${additions.length} PR sites for ${category}.`)[0] : "")
        return { sources: next.filter(row => ids.has(row.id)), didChange }
      })
      if (result.sources.length) removals.push({ category, sources: result.sources })
      if (result.didChange) changed.push(category)
    }
    for (const { category, sources } of removals) {
      const didChange = await retryTracker(this.store, async files => {
        const file = files.find(file => file.category === category) ?? emptyFile(category)
        const rows = file.rows.filter(row => {
          const expected = sources.find(source => source.id === row.id)
          if (!expected || JSON.stringify(row) !== JSON.stringify(expected) || keeps(seedPR(row), category) || !lands(row)) return true
          const destination = files.find(file => file.category === seedCategory(seedPR(row)!))?.rows.find(target => target.id === row.id)
          if (!destination) return true
          const { category: sourceCategory, kind: sourceKind, date: sourceDate, ...source } = row
          const { category: targetCategory, kind: targetKind, date: targetDate, ...target } = destination
          return JSON.stringify(source) !== JSON.stringify(target) || (!seedPR(row)?.createdAt && sourceDate !== targetDate)
        })
        if (rows.length === file.rows.length) return false
        await this.store.write(file, rows, "")
        return true
      })
      if (didChange && !changed.includes(category)) changed.push(category)
    }
    return { unmapped, changed }
  }
}
