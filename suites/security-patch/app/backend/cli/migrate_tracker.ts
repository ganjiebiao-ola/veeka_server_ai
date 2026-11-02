import { GitHubClient, operatorToken, type Issue } from "../tracker/client.ts"
import { parseRows, type Row } from "../tracker/rows.ts"
import { GitHubTrackerStore, retryTracker, type TrackerStore } from "../tracker/store.ts"

type LegacyClient = { legacyTrackingIssues(): Promise<(Issue & { category: string })[]> }

function counts(rows: Row[]): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {}
  for (const row of rows) {
    const statuses = result[row.category] ??= {}
    statuses[row.status] = (statuses[row.status] ?? 0) + 1
  }
  return result
}

export async function migrate(client: LegacyClient, store: TrackerStore, force = false) {
  const issues = await client.legacyTrackingIssues()
  const byCategory = new Map<string, Row[]>()
  for (const issue of issues) {
    if (byCategory.has(issue.category)) throw new Error("duplicate legacy category")
    byCategory.set(issue.category, parseRows(issue.body ?? "", issue.category))
  }
  const existing = await store.read()
  if (!force && existing.some(file => byCategory.has(file.category))) throw new Error("tracker file already exists; use --force")
  for (const [category, rows] of byCategory) {
    await retryTracker(store, async fresh => {
      const file = fresh.find(item => item.category === category)
      if (file && !force) throw new Error("tracker file already exists; use --force")
      await store.write(file ?? { category, rows: [], log: [], url: "" }, rows, "Import legacy tracker")
    })
  }
  const before = counts([...byCategory.values()].flat())
  const after = counts((await store.read()).flatMap(file => file.rows))
  const matches = new Set([...Object.keys(before), ...Object.keys(after)])
  return { before, after, matches: [...matches].every(category => {
    const statuses = new Set([...Object.keys(before[category] ?? {}), ...Object.keys(after[category] ?? {})])
    return [...statuses].every(status => before[category]?.[status] === after[category]?.[status])
  }) }
}

export async function run(args: string[]) {
  const force = args.includes("--force")
  const positional = args.filter(arg => arg !== "--force")
  if (positional.length !== 1 || args.filter(arg => arg === "--force").length > 1 || !/^[\w.-]+\/[\w.-]+$/.test(positional[0])) throw new Error("usage: migrate_tracker <owner/repo> [--force]")
  const [repo] = positional
  const token = await operatorToken()
  const result = await migrate(new GitHubClient(repo, token), new GitHubTrackerStore(repo, token), force)
  console.log(JSON.stringify({ before: result.before, after: result.after }))
  if (!result.matches) throw new Error("tracker counts differ")
}

if (import.meta.main) {
  try { await run(process.argv.slice(2)) }
  catch { console.error("tracker migration failed"); process.exitCode = 1 }
}
