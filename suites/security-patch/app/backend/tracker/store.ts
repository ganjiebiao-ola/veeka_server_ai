import { CATEGORIES, coreStatus, isVendorRow, validateRow, validateRowId, type Row } from "./rows.ts"
import { scrub } from "./scrub.ts"
import { forgetOperatorToken } from "./client.ts"

export class TrackerConflict extends Error {}
export type PRRecord = { pushedSha?: string, closeReason?: string, rowIds?: string[] }
export type TrackerFile = { category: string, rows: Row[], log: { at: string, message: string }[], sha?: string, url: string, prs?: Record<string, PRRecord> }
export interface TrackerStore {
  read(): Promise<TrackerFile[]>
  write(file: TrackerFile, rows: Row[], message: string): Promise<TrackerFile>
}

export function serializeTracker(repo: string, file: TrackerFile): string {
  const rows = [...file.rows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  return `{\n  "version": 1,\n  "repo": ${JSON.stringify(repo)},\n  "category": ${JSON.stringify(file.category)},\n  "rows": [${rows.length ? "\n" + rows.map(row => "    " + JSON.stringify(row)).join(",\n") + "\n  " : ""}],\n  "log": ${JSON.stringify(file.log)},\n  "prs": ${JSON.stringify(file.prs ?? {})}\n}\n`
}

function validRowId(id: unknown): boolean {
  if (typeof id !== "string") return false
  try { validateRowId(id); return true } catch { return false }
}

export class GitHubTrackerStore implements TrackerStore {
  constructor(private businessRepo: string, private token: string,
    private trackerRepo = process.env.OLA_AGENT_TRACKER_REPO || "olaola-chat/security-patch-tracker",
    private branch = "main") {
    this.businessRepo = businessRepo.toLowerCase()
    for (const repo of [businessRepo, trackerRepo]) {
      if (!/^(?!\.+\/)[\w.-]+\/(?!\.+$)[\w.-]+$/.test(repo)) throw new Error("invalid tracker repository")
    }
  }

  private path(category: string): string {
    if (!CATEGORIES.includes(category)) throw new Error("invalid tracker category")
    return `${this.directory()}/${category}.json`
  }

  // One org owns every tracked repo, so the repo name alone is unique.
  private directory(): string {
    return `trackers/${this.businessRepo.split("/")[1]}`
  }

  private url(category: string): string {
    return `https://github.com/${this.trackerRepo}/blob/main/${this.path(category)}`
  }

  private headers() {
    return { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" }
  }

  async read(): Promise<TrackerFile[]> {
    const [owner, name] = this.trackerRepo.split("/")
    const directory = this.directory()
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST", signal: AbortSignal.timeout(15_000), headers: this.headers(), body: JSON.stringify({ query: `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { object(expression: ${JSON.stringify(`${this.branch}:${directory}`)}) { ... on Tree { entries { name object { ... on Blob { text oid } } } } } } }` }),
    })
    if (response.status === 401) forgetOperatorToken()
    if (!response.ok) throw new Error(`tracker GitHub request failed (${response.status})`)
    const result = await response.json() as { errors?: unknown[], data?: { repository?: { object: { entries: { name: string, object: { text?: string, oid?: string } | null }[] } | null } | null } }
    if (result.errors?.length || !result.data?.repository) throw new Error("tracker GitHub GraphQL request failed")
    return (result.data.repository.object?.entries ?? []).filter(entry => entry.name.endsWith(".json")).map(entry => {
      const category = entry.name.slice(0, -5)
      this.path(category)
      if (typeof entry.object?.text !== "string" || !entry.object.oid) throw new Error("invalid tracker file")
      const data = JSON.parse(entry.object.text)
      if (data.version !== 1 || data.repo !== this.businessRepo || data.category !== category || !Array.isArray(data.rows) || !Array.isArray(data.log) ||
        !data.log.every((item: any) => item && typeof item.at === "string" && typeof item.message === "string")) throw new Error("invalid tracker file")
      if (data.prs !== undefined && (!data.prs || typeof data.prs !== "object" || Array.isArray(data.prs) ||
        !Object.entries(data.prs).every(([number, raw]) => {
          const pr = raw as PRRecord
          return /^[1-9]\d*$/.test(number) && pr && typeof pr === "object" &&
            (pr.pushedSha === undefined || /^[a-f0-9]{40}$/.test(pr.pushedSha)) &&
            (pr.closeReason === undefined || typeof pr.closeReason === "string") &&
            (pr.rowIds === undefined || Array.isArray(pr.rowIds) && pr.rowIds.every(validRowId))
        }))) throw new Error("invalid tracker PR metadata")
      const ids = new Set<string>()
      for (const row of data.rows) {
        validateRow(row)
        if (row.category !== category) throw new Error("invalid tracker row category")
        if (ids.has(row.id)) throw new Error("duplicate tracker row id")
        ids.add(row.id)
        row.status = coreStatus(row.status)
      }
      return { category, rows: data.rows, log: data.log, sha: entry.object.oid, url: this.url(category), ...(data.prs ? { prs: data.prs } : {}) }
    })
  }

  async write(file: TrackerFile, rows: Row[], message: string): Promise<TrackerFile> {
    const clean = (value: string) => scrub(value, [this.token])[0]
    const safeRows = rows.map(row => {
      const version = isVendorRow(row) ? /^([a-z0-9_.-]+\/[a-z0-9_.-]+)@([^\s/@]+)$/i.exec(row.file) : null
      // Preserve version literals, but never an exact operator credential.
      const file = version ? `${clean(version[1])}@${version[2].replaceAll(this.token, "«已脱敏:配置值»")}` : clean(row.file)
      return { id: row.id, category: row.category, file, lines: row.lines, severity: row.severity,
        status: coreStatus(row.status), reason: clean(row.reason), date: row.date, pr: clean(row.pr),
        ...(row.kind !== undefined ? { kind: clean(row.kind) } : {}) }
    })
    const ids = new Set<string>()
    for (const row of safeRows) {
      validateRow(row)
      if (row.category !== file.category) throw new Error("invalid tracker row category")
      if (clean(row.id) !== row.id) throw new Error(`unsafe tracker row id in ${row.category} at line ${row.lines[0]}`)
      if (ids.has(row.id)) throw new Error("duplicate tracker row id")
      ids.add(row.id)
    }
    for (const pr of Object.values(file.prs ?? {})) {
      if (pr.rowIds && !pr.rowIds.every(id => validRowId(id) && clean(id) === id)) throw new Error("invalid tracker PR metadata")
    }
    const safeMessage = clean(message)
    const log = file.log.map(entry => ({ at: clean(entry.at), message: clean(entry.message) }))
    if (safeMessage) log.push({ at: new Date().toISOString(), message: safeMessage })
    const prs = Object.fromEntries(Object.entries(file.prs ?? {}).map(([number, pr]) => [number, { ...pr, ...(pr.closeReason ? { closeReason: clean(pr.closeReason) } : {}) }]))
    const next: TrackerFile = { category: file.category, rows: safeRows, log, prs, url: this.url(file.category) }
    const response = await fetch(`https://api.github.com/repos/${this.trackerRepo}/contents/${this.path(file.category)}`, {
      method: "PUT", signal: AbortSignal.timeout(15_000), headers: this.headers(), body: JSON.stringify({ message: safeMessage || `Update ${file.category}`, content: Buffer.from(serializeTracker(this.businessRepo, next)).toString("base64"), branch: this.branch, ...(file.sha ? { sha: file.sha } : {}) }),
    })
    if (response.status === 401) forgetOperatorToken()
    if (response.status === 409) throw new TrackerConflict("tracker write conflict")
    if (response.status === 422) {
      const error = await response.json().catch(() => null) as { message?: string, errors?: { message?: string, code?: string, field?: string }[] } | null
      if (/sha|does not match/i.test(error?.message ?? "") || error?.errors?.some(item => /sha/i.test(`${item.field ?? ""} ${item.message ?? ""}`))) throw new TrackerConflict("tracker write conflict")
    }
    if (!response.ok) throw new Error(`tracker GitHub request failed (${response.status})`)
    const result = await response.json() as { content?: { sha?: string } }
    if (!result.content?.sha) throw new Error("invalid tracker write response")
    return { ...next, sha: result.content.sha }
  }
}

export async function retryTracker<T>(store: TrackerStore, operation: (files: TrackerFile[]) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(await store.read()) }
    catch (error) { if (!(error instanceof TrackerConflict) || attempt >= 2) throw error }
  }
}

export function storeRows(files: TrackerFile[]): Row[] {
  const rows = new Map<string, Row>()
  for (const file of files) {
    for (const row of file.rows) {
      const existing = rows.get(row.id)
      if (!existing || existing.category === "misc" && row.category !== "misc") {
        rows.set(row.id, { ...row, status: coreStatus(row.status) })
      }
    }
  }
  return [...rows.values()]
}

export async function recordPR(store: TrackerStore, number: number, record: PRRecord, categories: string[], message: string): Promise<void> {
  await retryTracker(store, async files => {
    for (const file of files.filter(file => categories.includes(file.category))) {
      const previous = file.prs?.[number] ?? {}
      const next = { ...previous, ...record }
      if (JSON.stringify(previous) === JSON.stringify(next)) continue
      await store.write({ ...file, prs: { ...file.prs, [number]: next } }, file.rows, message)
    }
  })
}
