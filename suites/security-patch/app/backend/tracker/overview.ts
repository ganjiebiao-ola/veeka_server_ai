import { join } from "node:path"
import { impactSummary, isImported, prNumber, type SummaryPR, type ImpactSummary, type Coverage } from "../../shared/impact.ts"
import { classifyAdoption, type ImpactPR, type CommitEvidence } from "./adoption.ts"
import type { PRRecord } from "./store.ts"
import { CATEGORIES, STATUSES, type Row } from "./rows.ts"
import { storeRows, type TrackerStore } from "./store.ts"
import type { PickClient } from "./pick.ts"

export type SuitePR = { number: number, title: string, draft: boolean, url: string }
export interface OverviewClient extends PickClient {
  suitePRs(): Promise<SuitePR[]>
  impactPRs?(): Promise<ImpactPR[]>
  adoptionEvidence?(prs: ImpactPR[], records: Record<string, PRRecord>, cacheDir: string): Promise<Map<number, CommitEvidence>>
}
export type Overview = {
  repo: string,
  summary: ImpactSummary,
  prs: SummaryPR[],
  coverage?: Coverage,
  availableTypes: string[],
  types: { category: string, url: string | null, rows: Row[], total: number, counts: Record<string, number> }[],
  openPRs: SuitePR[],
  needsHuman: { id: string, category: string, url: string, file: string, lines: number[], reason: string, severity: string }[],
  ignored: { id: string, category: string, file: string, lines: number[], reason: string }[],
}
export type OverviewFilters = { categories?: string[], severities?: string[] }

// Read-only summary of every bug-type issue. It never writes to GitHub.
export async function overview(client: OverviewClient, store: TrackerStore, repo: string, filters: OverviewFilters = {}, runsRootDir?: string, readingDetails = client.impactPRs?.()): Promise<Overview> {
  const [files, openPRs] = await Promise.all([store.read(), client.suitePRs()])
  const allRows = storeRows(files)
  const needsHuman: Overview["needsHuman"] = []
  const ignored: Overview["ignored"] = []
  const relevantPRs = new Set<number>()
  const filtered = !!filters.categories?.length || !!filters.severities?.length
  const types = CATEGORIES.filter(category => !filters.categories?.length || filters.categories.includes(category)).map(category => {
    const file = files.find(file => file.category === category)
    const categoryRows = allRows.filter(row => row.category === category)
    const rows = categoryRows
      .filter(row => !filters.severities?.length || filters.severities.includes(row.severity))
    const counts = Object.fromEntries(STATUSES.map(status => [status, rows.filter(row => row.status === status).length]))
    for (const row of rows) {
      if (row.status === "needs human" && file) needsHuman.push({ id: row.id, category, url: file.url, file: row.file, lines: row.lines, reason: row.reason, severity: row.severity })
      if (row.status === "ignored") ignored.push({ id: row.id, category, file: row.file, lines: row.lines, reason: row.reason })
      const pr = Number(/\[PR #(\d+)\]/.exec(row.pr)?.[1])
      if (pr) relevantPRs.add(pr)
    }
    return { category, url: file?.url ?? null, rows, total: rows.length, counts }
  }).filter(type => !filters.severities?.length || type.total > 0)
  const visible = types.flatMap(type => type.rows)
  const records: Record<string, PRRecord> = {}
  for (const file of files) for (const [number, record] of Object.entries(file.prs ?? {})) records[number] = { ...records[number], ...record }
  const details = readingDetails ? await readingDetails : openPRs.map(pr => ({ ...pr, state: "open" as const, head: "", base: "", ref: "" }))
  const toolNumbers = new Set(allRows.filter(row => !isImported(row)).map(prNumber).filter(Boolean))
  for (const number of Object.keys(records)) toolNumbers.add(Number(number))
  const toolDetails = details.filter(pr => /^security\/.+-[0-9a-f]{8}$/.test(pr.ref) || toolNumbers.has(pr.number) || openPRs.some(open => open.number === pr.number))
  const evidence = runsRootDir && client.adoptionEvidence ? await client.adoptionEvidence(toolDetails, records, join(runsRootDir, "impact-cache")) : new Map<number, CommitEvidence>()
  const numbers = new Set([...toolDetails.map(pr => pr.number), ...visible.map(prNumber).filter((n): n is number => !!n)])
  const prs: SummaryPR[] = [...numbers].flatMap(number => {
    const rows = visible.filter(row => prNumber(row) === number || records[number]?.rowIds?.includes(row.id))
    const pr = details.find(pr => pr.number === number)
    const imported = !toolDetails.some(pr => pr.number === number) && rows.length > 0 && rows.every(isImported)
    if (filtered && !rows.length) return []
    return [{ number, title: pr?.title ?? `PR #${number}`, url: `https://github.com/${repo}/pull/${number}`,
      outcome: imported ? "excluded" : pr ? classifyAdoption(pr, records[number], evidence.get(number)) : "unknown",
      imported, rowIds: rows.map(row => row.id), categories: [...new Set([...rows.map(row => row.category), ...files.filter(file => file.prs?.[number]).map(file => file.category)])] }]
  })
  return { repo, summary: impactSummary(visible, prs), prs, availableTypes: CATEGORIES, types,
    openPRs: filtered ? openPRs.filter(pr => relevantPRs.has(pr.number)) : openPRs, needsHuman, ignored }
}
