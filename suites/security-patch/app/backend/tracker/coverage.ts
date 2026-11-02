import { join } from "node:path"
import type { RunSummary } from "../../shared/types.ts"
import type { Coverage } from "../../shared/impact.ts"
import { readArtifact } from "../orchestrator/artifact_fs.ts"
import { applies, applyOverride } from "../../scanner/lib/profile.mjs"
import rules from "../../skill/ola-security-audit/applies-to.json"

export function scanCoverage(repo: string, runs: RunSummary[], runsRootDir: string, profile: unknown, override: unknown): Coverage {
  const effective = applyOverride(profile ?? { language: "", php: "", framework: "" }, JSON.stringify(override ?? {}))
  const applicable = Object.entries(rules).filter(([, rule]) => applies(rule, effective)).map(([category]) => category)
  const completed = runs.filter(run => run.mode === "scan" && run.status === "completed" && run.repoUrl.replace(/\.git$/, "").replace(/\/$/, "").toLowerCase() === `https://github.com/${repo}`.toLowerCase())
    .sort((a, b) => (b.finishedAt ?? b.startedAt ?? 0) - (a.finishedAt ?? a.startedAt ?? 0))
  const scanned = new Set<string>(), covered = new Set<string>(), considered = new Set<string>()
  let known = false
  for (const [index, run] of completed.entries()) {
    const dir = join(runsRootDir, run.runId, "artifacts")
    let coverage: any
    try { coverage = JSON.parse(readArtifact(dir, "scan-coverage.json", 16 * 1024 * 1024)) } catch {}
    const categories = coverage?.categories?.length ? coverage.categories : run.categories?.length ? run.categories : applicable
    for (const category of categories) if (applicable.includes(category)) scanned.add(category)
    const files = Array.isArray(coverage) ? coverage : coverage?.coveredFiles
    if (Array.isArray(files)) for (const file of files) if (typeof file === "string") covered.add(file)
    if (index === 0 && Array.isArray(coverage?.consideredFiles)) {
      known = true
      for (const file of coverage.consideredFiles) if (typeof file === "string") considered.add(file)
    }
  }
  return { applicable, scanned: [...scanned], unscanned: applicable.filter(category => !scanned.has(category)),
    coveredFiles: completed.length ? known ? [...covered].filter(file => considered.has(file)).length : covered.size : null, consideredFiles: known ? considered.size : null,
    lastScan: completed[0]?.finishedAt ?? completed[0]?.startedAt ?? null }
}
