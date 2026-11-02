import { readArtifactJson } from "./artifact_fs.ts"
import { githubRepo } from "../tracker/repos.ts"
import type { ProfileSource, RepoProfile } from "../../shared/types.ts"

export const PHP_VERSION = /^\d+\.\d+$/
export const FRAMEWORK = /^[a-z0-9-]{1,30}$/
const MAX_SOURCES = 50

const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max

export function profileData(raw: unknown): RepoProfile | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const { language, php, framework, sources } = raw as Record<string, unknown>
  if (!text(language, 20) || !(php === "" || (text(php, 10) && PHP_VERSION.test(php))) ||
    !(framework === "" || (text(framework, 30) && FRAMEWORK.test(framework))) || !Array.isArray(sources)) return undefined
  const checked = sources.slice(0, MAX_SOURCES).filter((s): s is ProfileSource => !!s && typeof s === "object" &&
    (s.field === "php" || s.field === "framework") && text(s.value, 30) && text(s.file, 300))
  return { language, php, framework, sources: checked.map(({ field, value, file }) => ({ field, value, file })) }
}

// Saves the scan's detected profile on the repo's row. The operator override stays as it is.
export function importProfile(runId: string, artifactsDir: string, store: { saveProfile(repo: string, profile: RepoProfile): void }, repoUrl?: string): void {
  const repo = githubRepo(repoUrl ?? "")
  if (!repo) return
  try {
    const profile = profileData(readArtifactJson(artifactsDir, "profile.json"))
    if (!profile) throw new Error("invalid profile")
    store.saveProfile(repo, profile)
  } catch {
    console.warn(`[scanner ${runId}] profile.json missing, unreadable, or invalid`)
  }
}
