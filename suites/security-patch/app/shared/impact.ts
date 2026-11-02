export type ImpactRow = { id: string, category: string, severity: string, status: string, reason: string, pr: string }
export type Outcome = "full" | "partial" | "rejected" | "unknown" | "open" | "excluded"
export type SummaryPR = { number: number, title: string, url: string, outcome: Outcome, imported: boolean, rowIds: string[], categories: string[] }
export const isImported = (row: Pick<ImpactRow, "id">) => /^pr[1-9]\d*:/.test(row.id)
export const prNumber = (row: Pick<ImpactRow, "pr">) => Number(/\[PR #(\d+)\]/.exec(row.pr)?.[1]) || undefined
// ponytail: every ignored row counts as a false positive, because the tracker stores false positive and won't fix as one status. Add an ignore kind if won't-fix ignores grow.
export const isFalsePositive = (row: ImpactRow) => row.status === "false positive" || row.status === "ignored"
export const inPR = (row: ImpactRow) => !!prNumber(row)
export const picked = (row: ImpactRow) => ["in progress", "fixed"].includes(row.status) || inPR(row)
export const found = (row: ImpactRow) => !isImported(row) && !isFalsePositive(row)
export const severityCounts = (rows: ImpactRow[]) => Object.fromEntries(["P0", "P1", "P2", ""].map(severity => [severity, rows.filter(row => row.severity === severity).length]))
export const stageTests = { found, picked, inPR, merged: (row: ImpactRow) => row.status === "fixed" }
export type Stage = keyof typeof stageTests

export function impactSummary(rows: ImpactRow[], prs: SummaryPR[]) {
  const tool = rows.filter(found)
  const stages = (Object.keys(stageTests) as Stage[]).map(key => {
    const stageRows = tool.filter(stageTests[key])
    return { key, total: stageRows.length, severity: severityCounts(stageRows), rowIds: stageRows.map(row => row.id) }
  })
  const outstanding = tool.filter(row => row.severity === "P0" && ["open", "needs human", "in progress"].includes(row.status))
  const human = outstanding.filter(row => row.status === "needs human").length
  const p0InPR = outstanding.filter(row => row.status !== "needs human" && inPR(row)).length
  const imported = rows.filter(isImported)
  const countedPRs = prs.filter(pr => !pr.imported && pr.outcome !== "excluded")
  return {
    found: stages[0].total, inPR: stages[2].total, merged: stages[3].total, prs: countedPRs.length,
    severity: stages[0].severity,
    p0: { total: outstanding.length, rowIds: outstanding.map(row => row.id), open: outstanding.length - human - p0InPR,
      human, inPR: p0InPR },
    stages,
    outcomes: Object.fromEntries(["full", "partial", "rejected", "unknown", "open"].map(outcome => [outcome, countedPRs.filter(pr => pr.outcome === outcome).length])),
    imported: { total: imported.length, fixed: imported.filter(row => row.status === "fixed").length,
      progress: imported.filter(row => row.status === "in progress").length, open: imported.filter(row => row.status === "open").length },
  }
}
export type ImpactSummary = ReturnType<typeof impactSummary>
export type Coverage = { applicable: string[], scanned: string[], unscanned: string[], coveredFiles: number | null, consideredFiles: number | null, lastScan: number | null }
