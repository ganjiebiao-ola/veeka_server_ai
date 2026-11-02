import { GitHubTrackerStore } from "../tracker/store.ts"
import { readFile } from "node:fs/promises"
import { operatorToken } from "../tracker/client.ts"
import { Tracker, validateSeed } from "../tracker/tracker.ts"
import { CATEGORIES } from "../tracker/rows.ts"

export async function run(args: string[]): Promise<void> {
  const options = new Map<string, string>()
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (!["--input", "--repo", "--only-type"].includes(key) || options.has(key)) throw new Error("invalid seed option")
    const value = args[++i]
    if (!value || value.startsWith("--")) throw new Error("seed option requires a value")
    options.set(key, value)
  }
  const path = options.get("--input")
  if (!path) throw new Error("required: --input <PRs.json> [--only-type sqli] --repo owner/repo")
  const repo = options.get("--repo")
  if (!repo) throw new Error("required: --repo owner/repo")
  const onlyType = options.get("--only-type")
  if (onlyType && !CATEGORIES.includes(onlyType)) throw new Error("unknown seed type")
  const prs = validateSeed(JSON.parse(await readFile(path, "utf8")))
  const store = new GitHubTrackerStore(repo, await operatorToken())
  console.log(JSON.stringify(await new Tracker(store, repo).seed(prs, onlyType)))
}

if (import.meta.main) {
  try { await run(process.argv.slice(2)) }
  catch {
    // Do not echo input, credential output, or remote response bodies.
    console.error("tracker seed failed. Check input, options, repository, and operator authentication.")
    process.exitCode = 1
  }
}
