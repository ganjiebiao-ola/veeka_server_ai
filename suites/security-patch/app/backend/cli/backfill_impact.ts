import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { GitHubClient, operatorToken } from "../tracker/client.ts"
import { GitHubTrackerStore, recordPR, type PRRecord, type TrackerStore } from "../tracker/store.ts"
import { closeReason, type ImpactPR } from "../tracker/adoption.ts"
import { CATEGORIES } from "../tracker/rows.ts"
import { prNumber } from "../../shared/impact.ts"
import { readArtifact } from "../orchestrator/artifact_fs.ts"

export function commentReason(comments: string[]): string {
  const comment = [...comments].reverse().find(body => body.startsWith("Closed from the security-patch app."))
  return closeReason(/Reason:\s*(test PR|bad fix|superseded|replaced by a newer PR)(?:\.|\s|$)/i.exec(comment ?? "")?.[1]) ?? "bad fix"
}
export type BackfillChange = { number: number, categories: string[], record: PRRecord }
export async function backfillImpact(store: TrackerStore, client: { impactPRs(): Promise<ImpactPR[]>, listComments(number: number): Promise<string[]> }, runsRoot: string, dryRun = true) {
  const files = await store.read()
  const prs = (await client.impactPRs()).filter(pr => GitHubClient.SUITE_BRANCH.test(pr.ref))
  let directories: string[] = []
  try { directories = await readdir(runsRoot) } catch {}
  const changes: BackfillChange[] = [], missing: string[] = []
  for (const pr of prs) {
    const record = Object.assign({}, ...files.map(file => file.prs?.[pr.number] ?? {})) as PRRecord
    const categories = files.filter(file => file.rows.some(row => prNumber(row) === pr.number) || file.prs?.[pr.number]).map(file => file.category)
    if (!categories.length) {
      const category = [...CATEGORIES].sort((a, b) => b.length - a.length).find(category => pr.ref.startsWith(`security/${category}-`))
      if (category && files.some(file => file.category === category)) categories.push(category)
    }
    if (!categories.length) { missing.push(`PR #${pr.number}: no tracker category`); continue }
    const update: PRRecord = {}
    const suffix = pr.ref.slice(-8)
    const matches = directories.filter(dir => dir.replaceAll("-", "").startsWith(suffix))
    if (!record.rowIds && matches.length === 1) {
      try {
        const findings = JSON.parse(readArtifact(join(runsRoot, matches[0], "artifacts"), "findings.json"))
        const ids = new Set(files.flatMap(file => file.rows.map(row => row.id)))
        const rowIds = findings.filter((finding: any) => finding.status === "fixed" && ids.has(finding.id)).map((finding: any) => finding.id) as string[]
        if (rowIds.length) update.rowIds = [...new Set(rowIds)]
      } catch {}
    }
    if (pr.state === "open" && !record.pushedSha) {
      if (matches.length === 1) {
        try {
          const log = readArtifact(join(runsRoot, matches[0], "artifacts"), "commits.log")
          const sha = /^([a-f0-9]{40})\r?\n/.exec(log)?.[1]
          if (sha) update.pushedSha = sha
        } catch {}
      }
      if (!update.pushedSha) missing.push(`PR #${pr.number}: missing or ambiguous local commits.log`)
    }
    if (pr.state === "closed" && !record.closeReason) update.closeReason = commentReason(await client.listComments(pr.number))
    if (Object.keys(update).length) changes.push({ number: pr.number, categories, record: update })
  }
  if (!dryRun) for (const change of changes) await recordPR(store, change.number, change.record, change.categories,
    `Impact backfill PR #${change.number}: ${change.record.closeReason ?? change.record.pushedSha ?? "row links"}`)
  const rows = files.flatMap(file => file.rows)
  return { dryRun, open: prs.filter(pr => pr.state === "open").length, closed: prs.filter(pr => pr.state === "closed").length,
    imported: { byId: rows.filter(row => /^pr[1-9]\d*:/.test(row.id)).length, seededReason: rows.filter(row => /Seeded from PR/.test(row.reason)).length,
      seededWithoutId: rows.filter(row => /Seeded from PR/.test(row.reason) && !/^pr[1-9]\d*:/.test(row.id)).length }, changes, missing }
}

export async function run(args: string[]) {
  const dryRun = args.includes("--dry-run")
  if (dryRun === args.includes("--write")) throw new Error("choose --dry-run or --write")
  const value = (key: string) => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1] }
  const repo = value("--repo"), runs = value("--runs")
  if (!repo || !runs) throw new Error("required: --repo owner/repo --runs path --dry-run")
  const token = await operatorToken()
  console.log(JSON.stringify(await backfillImpact(new GitHubTrackerStore(repo, token), new GitHubClient(repo, token), runs, dryRun), null, 2))
}
if (import.meta.main) run(process.argv.slice(2)).catch(() => {
  console.error("Impact backfill failed: check GitHub read access, repo, and local run path. No credentials or remote response bodies are logged.")
  process.exitCode = 1
})
