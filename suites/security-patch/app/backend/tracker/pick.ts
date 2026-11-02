import { retryTracker, storeRows, TrackerConflict, type TrackerStore } from "./store.ts"
import type { OpenPR, PRState } from "./client.ts"
import { CATEGORIES, isVendorRow, normalizedPath, upsert } from "./rows.ts"
import type { Row } from "./rows.ts"
import { scrub } from "./scrub.ts"
import { Tracker, emptyFile, withTrackerLock } from "./tracker.ts"
import { validPickedIds } from "../../shared/types.ts"
import type { StartRunRequest, HiddenPickRow, PickLimits } from "../../shared/types.ts"

export const DEFAULT_PICK_LIMIT = 10
// PR size v1 (plan "PRs"). maxLines is enforced by the fix agent, the backend can only count files.
export const BATCH = { maxFiles: 10, maxLines: 400 }
export interface PickClient {
  openPRFiles(onBatch?: (files: string[], checkedPRs: number, totalPRs: number) => void): Promise<string[]>
  openPRs?(onBatch?: (prs: OpenPR[], checkedPRs: number, totalPRs: number) => void, useCache?: boolean): Promise<OpenPR[]>
  ignorePRs?: number[]
  prStates?(numbers: number[]): Promise<Map<number, PRState>>
  prState(number: number): Promise<"open" | "merged" | "closed">
}
export type PickRow = Row & { subsystem: string }
export const subsystem = (row: Pick<Row, "category" | "kind" | "file">): string => isVendorRow(row)
  ? row.file.split("@")[0] : normalizedPath(row.file).split("/").slice(0, 2).join("/")
const severity = (row: Row): number => ({ P0: 0, P1: 1, P2: 2 }[row.severity] ?? 3)
export function candidates(rows: Row[], files: string[]): PickRow[] {
  const touched = new Set(files.map(normalizedPath))
  return rows.filter(row => ["open", "candidate", "deferred"].includes(row.status) && !touched.has(normalizedPath(row.file)) &&
    // ponytail: tree paths containing commas are unsupported because the Trees list is comma-joined.
    // An open PR in the tree, its lockfile or its patch log overlaps.
    !(isVendorRow(row) && (row.reason.match(/Trees:\s*([^\n]+)/)?.[1] ?? "").split(",").some(raw => {
      let tree: string
      try { tree = normalizedPath(raw.trim().replace(/`/g, "")).replace(/\/+$/, "") } catch { return false }
      if (!tree) return false
      const parent = tree.split("/").slice(0, -1).join("/")
      const lock = `${parent}/composer.lock`.replace(/^\//, "")
      const log = `${parent}/VENDOR_PATCHES.md`.replace(/^\//, "")
      return files.some(file => normalizedPath(file).startsWith(`${tree}/`) || normalizedPath(file) === lock || normalizedPath(file) === log)
    })))
    .map(row => ({ ...row, subsystem: subsystem(row) }))
    .sort((a, b) => severity(a) - severity(b) || a.category.localeCompare(b.category) || a.subsystem.localeCompare(b.subsystem) || a.id.localeCompare(b.id))
}
export function suggested(rows: Row[]): string[] {
  const first = rows[0]
  return first ? rows.filter(row => row.category === first.category && subsystem(row) === subsystem(first))
    .slice(0, DEFAULT_PICK_LIMIT).map(row => row.id) : []
}
// ponytail: process-local queue, a restart drops it and the rows stay in Pick for the next click.
export const queuedBatches = new Map<string, { body: Partial<StartRunRequest>, rest: string[][] }>()
// shortcut: process-local lock, use a shared lock if the backend runs on multiple servers.
export const confirming = new Set<string>()
// Rows of one pick share a bug type, so a batch is a run of whole files.
export function batches<T extends Row>(rows: T[], maxFiles = BATCH.maxFiles): T[][] {
  const files = [...new Set(rows.map(row => normalizedPath(row.file)))]
  return Array.from({ length: Math.ceil(files.length / maxFiles) }, (_, i) => {
    const chunk = new Set(files.slice(i * maxFiles, (i + 1) * maxFiles))
    return rows.filter(row => chunk.has(normalizedPath(row.file)))
  })
}
type PickResult = { rows: PickRow[], suggestedIds: string[], hidden: HiddenPickRow[], limits: PickLimits }
function pickResult(pending: Row[], prs: OpenPR[], files: string[], ignorePRs: number[]): PickResult {
  const blocking = prs.filter(pr => !ignorePRs.includes(pr.number))
  const rows = candidates(pending, [...files, ...blocking.flatMap(pr => pr.files)])
  const offered = new Set(rows.map(row => row.id))
  const hidden = pending.filter(row => !offered.has(row.id))
    .map(({ id, category, file, lines, severity }) => ({ id, category, file, lines, severity, blockedBy: [] as number[] }))
  for (const pr of blocking) {
    const available = new Set(candidates(pending, pr.files).map(row => row.id))
    for (const row of hidden) if (!available.has(row.id)) row.blockedBy.push(pr.number)
  }
  return { rows, suggestedIds: suggested(rows), hidden,
    limits: { maxFilesPerBatch: BATCH.maxFiles } }
}

async function prFiles(client: PickClient, onBatch?: (prs: OpenPR[], files: string[], checked: number, total: number) => void, useCache = false, readingPRs?: Promise<OpenPR[]>) {
  if (client.openPRs) {
    const prs = readingPRs ? await readingPRs : await client.openPRs((prs, checked, total) => onBatch?.(prs, [], checked, total), useCache)
    if (readingPRs) onBatch?.(prs, [], prs.length, prs.length)
    return { prs, files: [] as string[] }
  }
  const files = await client.openPRFiles((files, checked, total) => onBatch?.([], files, checked, total))
  return { prs: [] as OpenPR[], files }
}

export async function loadPick(client: PickClient, store: TrackerStore, ignorePRs: number[] = client.ignorePRs ?? [], readingPRs?: Promise<OpenPR[]>): Promise<PickResult> {
  const pending = storeRows(await store.read())
    .filter(row => ["open", "candidate", "deferred"].includes(row.status))
  if (!pending.length) return pickResult([], [], [], ignorePRs)
  const { prs, files } = await prFiles(client, undefined, true, readingPRs)
  return pickResult(pending, prs, files, ignorePRs)
}

export type PickStreamUpdate = PickResult & (
  | { type: "init" }
  | { type: "progress"; checkedPRs: number; totalPRs: number }
  | { type: "done" }
)

export async function streamPick(
  client: PickClient,
  store: TrackerStore,
  onUpdate: (update: PickStreamUpdate) => void,
  ignorePRs: number[] = client.ignorePRs ?? [],
  readingPRs?: Promise<OpenPR[]>,
): Promise<PickResult> {
  const pending = storeRows(await store.read())
    .filter(row => ["open", "candidate", "deferred"].includes(row.status))
  onUpdate({ type: "init", ...pickResult(pending, [], [], ignorePRs) })
  const allPRs: OpenPR[] = []
  const allFiles: string[] = []
  const result = await prFiles(client, (prs, files, checkedPRs, totalPRs) => {
    allPRs.push(...prs)
    allFiles.push(...files)
    onUpdate({ type: "progress", ...pickResult(pending, allPRs, allFiles, ignorePRs), checkedPRs, totalPRs })
  }, true, readingPRs)
  const final = pickResult(pending, result.prs, result.files, ignorePRs)
  onUpdate({ type: "done", ...final })
  return final
}
export async function preparePick(client: PickClient, store: TrackerStore, repo: string, ids: unknown, ignorePRs: number[] = client.ignorePRs ?? []) {
  if (!validPickedIds(ids) || !ids.length || new Set(ids).size !== ids.length) throw new Error("select one or more unique row ids")
  const [trackerFiles, { prs, files }] = await Promise.all([store.read(), prFiles(client)]).catch(() => { throw new Error("tracker GitHub request failed") })
  const allRows = storeRows(trackerFiles)
  const rows = pickResult(allRows.filter(row => ["open", "candidate", "deferred"].includes(row.status)), prs, files, ignorePRs).rows
  const picked = rows.filter(row => ids.includes(row.id))
  if (picked.length !== ids.length) throw new Error("selection changed or overlaps an open PR, reload Pick")
  const first = picked[0]
  if (picked.some(row => row.category !== first.category)) throw new Error("select one bug type")
  // Later batches stay in Pick, so a backend restart never strands them as `in progress`.
  const [batch, ...rest] = batches(picked)
  const now = batch.map(row => row.id)
  return { picked: batch, rest: rest.map(b => b.map(row => row.id)), mark: (runId?: string) => new Tracker(store, repo).update(first.category, fresh => {
    const selected = pickResult(fresh.filter(row => now.includes(row.id) && ["open", "candidate", "deferred"].includes(row.status)), prs, files, ignorePRs).rows
    if (selected.length !== now.length) throw new Error("selection changed or overlaps an open PR, reload Pick")
    return selected.map(({ subsystem, ...row }) => ({ ...row, status: "in progress" as const, pr: "" }))
  }, `Picked ${now.length} row(s) for a fix${runId ? ` (run ${runId})` : ""}`) }
}

export async function confirmPick(client: PickClient, store: TrackerStore, repo: string, ids: unknown): Promise<void> {
  await (await preparePick(client, store, repo, ids)).mark()
}

export const IGNORE_REASON_MAX = 500
const logReason = (reason: string) => scrub(reason.trim())[0].slice(0, 100)
const EARLIER = "\nEarlier reason: "
// " · " is the separator from before line breaks.
// The table trims a trailing space, so an empty earlier reason ends at the colon.
const EARLIER_RE = /^(?:Ignored|Needs human): [\s\S]*?(?:\n| · )Earlier reason:(?: ([\s\S]*))?$/

// Ignore from Pick instead of delete: a deleted row comes back on the next scan, an ignored one stays.
// The row keeps the earlier reason after the new one, so Reopen can put it back. No issue comment, so they never pile up.
export async function ignoreRows(client: PickClient, store: TrackerStore, repo: string, ids: unknown, reason: unknown, held?: Set<string>): Promise<number> {
  if (typeof reason !== "string" || !reason.trim() || reason.length > IGNORE_REASON_MAX) throw new Error(`reason must be text of 1 to ${IGNORE_REASON_MAX} characters`)
  if (/[\r\n]| · Earlier reason:/.test(reason)) throw new Error("reason must be a single line without ' · Earlier reason:'")
  return await changeRows(client, store, repo, ids, row => ["open", "candidate", "deferred"].includes(row.status) && !held?.has(row.id), "is not open",
    row => ({ ...row, status: "ignored", reason: `Ignored: ${reason.trim()}${EARLIER}${row.reason}`, pr: "" }),
    n => `Ignored ${n} row(s): ${logReason(reason)}`)
}

export async function needsHumanRows(client: PickClient, store: TrackerStore, repo: string, ids: unknown, reason: unknown, held?: Set<string>): Promise<number> {
  if (typeof reason !== "string" || !reason.trim() || reason.length > IGNORE_REASON_MAX) throw new Error(`reason must be text of 1 to ${IGNORE_REASON_MAX} characters`)
  if (/[\r\n]| · Earlier reason:/.test(reason)) throw new Error("reason must be a single line without ' · Earlier reason:'")
  return await changeRows(client, store, repo, ids, row => ["open", "candidate", "deferred"].includes(row.status) && !held?.has(row.id), "is not open",
    row => ({ ...row, status: "needs human", reason: `Needs human: ${reason.trim()}${EARLIER}${row.reason}`, pr: "" }),
    n => `Needs human for ${n} row(s): ${logReason(reason)}`)
}

// Reopen restores the earlier reason for rows set aside by the operator.
export async function reopenRows(client: PickClient, store: TrackerStore, repo: string, ids: unknown): Promise<number> {
  return await changeRows(client, store, repo, ids, row => ["ignored", "needs human"].includes(row.status), "is not ignored or needs human",
    row => ({ ...row, status: "open", // Without the separator the text may be the agent's own, so keep it.
    reason: (match => match ? match[1] ?? "" : row.reason)(EARLIER_RE.exec(row.reason)), pr: "" }),
    n => `Reopened ${n} row(s)`)
}

async function changeRows(client: PickClient, store: TrackerStore, repo: string, ids: unknown, allowed: (row: Row) => boolean, refusal: string,
  change: (row: Row) => Row, message: (count: number) => string): Promise<number> {
  if (!validPickedIds(ids) || !ids.length || new Set(ids).size !== ids.length) throw new Error("select one or more unique row ids")
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("invalid tracker repository")
  return withTrackerLock(repo, async () => {
    const files = await store.read()
    const rows = storeRows(files).filter(row => ids.includes(row.id))
    if (rows.length !== ids.length) throw new Error("selection changed, reload the page")
    const refused = rows.find(row => !allowed(row))
    if (refused) throw new Error(`${refused.file}:${refused.lines[0]} ${refusal}, reload the page`)
    for (const category of new Set(rows.map(row => row.category))) {
      await retryTracker(store, async fresh => {
        const file = fresh.find(file => file.category === category) ?? emptyFile(category)
        const selected = rows.filter(row => row.category === category)
        const targets = file.rows.filter(row => selected.some(target => target.id === row.id))
        if (targets.length !== selected.length) throw new Error("selection changed, reload the page")
        const refused = targets.find(row => !allowed(row))
        if (refused) throw new Error(`${refused.file}:${refused.lines[0]} ${refusal}, reload the page`)
        await store.write(file, file.rows.map(row => targets.includes(row) ? change(row) : row), message(targets.length))
      })
    }
    return rows.length
  })
}

// Rows follow their PR: merged → fixed, closed unmerged → open with no PR. One write per changed issue.
// held: the picked rows a run or queued batch still works on. A row "in progress" with no PR
// and not held lost its run (it failed, was stopped for good, or the app restarted), so it reopens.
const readRefreshes = new Map<string, { at: number, pending: Promise<number> }>()
export function refreshReadRows(client: PickClient, store: TrackerStore, repo: string, held?: Set<string>): Promise<number> {
  const previous = readRefreshes.get(repo)
  if (previous && Date.now() - previous.at < 60_000) return previous.pending
  const pending = refreshRows(client, store, repo, held)
  readRefreshes.set(repo, { at: Date.now(), pending })
  return pending
}

export async function refreshRows(client: PickClient, store: TrackerStore, repo: string, held?: Set<string>): Promise<number> {
  return withTrackerLock(repo, () => refreshTrackerRows(client, store, repo, held))
}

async function refreshTrackerRows(client: PickClient, store: TrackerStore, repo: string, held?: Set<string>): Promise<number> {
  let changed = 0
  let files = await store.read()
  const promoted = new Set<string>()
  const misc = files.find(file => file.category === "misc")
  if (misc && held && !confirming.has(repo)) {
    const categories = new Set(misc.rows.filter(row => !held.has(row.id)).map(row => row.kind).filter((kind): kind is string => !!kind && kind !== "misc" && CATEGORIES.includes(kind)))
    const copied = new Map<string, Map<string, Row>>()
    const moved = await retryTracker(store, async current => {
      const source = current.find(file => file.category === "misc")
      const selected = (source?.rows ?? []).filter(row => !!row.kind && categories.has(row.kind) && !held.has(row.id))
      const retained = new Set<string>()
      for (const category of categories) {
        const target = current.find(file => file.category === category) ?? emptyFile(category)
        const previous = copied.get(category) ?? new Map<string, Row>()
        const rows = selected.filter(row => row.kind === category).map(({ kind, ...row }) => ({ ...row, category }))
        // Only replace our own earlier copy; independent destination edits remain authoritative.
        let next = target.rows.filter(row => !previous.has(row.id) || JSON.stringify(row) !== JSON.stringify(previous.get(row.id)) ||
          !source?.rows.some(source => source.id === row.id) || rows.some(source => source.id === row.id))
        const updates = rows.filter(row => {
          const existing = next.find(old => old.id === row.id)
          const prior = previous.get(row.id)
          if (existing && prior && JSON.stringify(existing) !== JSON.stringify(prior) && JSON.stringify(row) !== JSON.stringify(prior)) retained.add(row.id)
          return !existing || !!prior && JSON.stringify(existing) === JSON.stringify(prior)
        })
        next = updates.reduce(upsert, next)
        if (JSON.stringify(next) !== JSON.stringify(target.rows)) {
          const saved = await store.write(target, next, "")
          for (const row of saved.rows) if (updates.some(update => update.id === row.id)) previous.set(row.id, row)
          copied.set(category, previous)
          changed++
        }
      }
      const freshFiles = await store.read()
      const fresh = freshFiles.find(file => file.category === "misc")
      if (!fresh) return selected
      const remaining = fresh.rows.filter(row => {
        const expected = selected.find(source => source.id === row.id)
        if (!expected || retained.has(row.id)) return true
        const destination = freshFiles.find(file => file.category === expected.kind)?.rows.find(target => target.id === row.id)
        // ponytail: a refresh after exhausted retries can drop a newer misc source edit. Track copies across refreshes when several backends write (phase 3).
        if (!destination || JSON.stringify(row) !== JSON.stringify(expected) || held.has(row.id)) throw new TrackerConflict("promotion source changed")
        return false
      })
      if (remaining.length !== fresh.rows.length) { await store.write(fresh, remaining, ""); changed++ }
      return selected
    })
    for (const row of moved) promoted.add(row.id)
    files = await store.read()
  }
  const number = (row: Row) => Number(/\[PR #(\d+)\]/.exec(row.pr)?.[1])
  const numbers = [...new Set(files.flatMap(file => file.rows)
    .filter(row => !promoted.has(row.id) && ["in progress", "in PR"].includes(row.status)).map(number).filter(Boolean))]
  const states = client.prStates ? await client.prStates(numbers)
    : new Map(await Promise.all(numbers.map(async n => [n, await client.prState(n)] as const)))
  const update = (row: Row): Row => {
    if (promoted.has(row.id) || !["in progress", "in PR"].includes(row.status)) return row
    const n = number(row)
    if (!n) return held && !held.has(row.id) ? { ...row, status: "open", pr: "" } : row
    const state = states.get(n)
    return state === "merged" ? { ...row, status: "fixed" } : state === "closed" ? { ...row, status: "open", pr: "" } : row
  }
  for (const snapshot of files) {
    if (snapshot.rows.every(row => update(row) === row)) continue
    await retryTracker(store, async fresh => {
      const file = fresh.find(file => file.category === snapshot.category)
      if (!file) return
      const rows = file.rows.map(update)
      if (rows.every((row, i) => row === file.rows[i])) return
      await store.write(file, rows, "")
      changed++
    })
  }
  return changed
}
