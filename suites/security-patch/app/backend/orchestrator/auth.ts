import { readArtifactJson } from "./artifact_fs.ts"
import { notesLiteral, writeNotesSection } from "./vendor.ts"

// What the scan agent found about the repo's login check and test-only guard. SKILL §1.18 and §1.19 write it as auth.json.
export interface AuthFacts {
  login: { mechanism: typeof MECHANISMS[number], summary: string, evidence: string[] }
  testGuard: { summary: string, evidence: string[] } | null
  openQuestions: string[]
}

const MECHANISMS = ["central-hook", "per-controller", "per-action", "none", "unknown"] as const
const MAX_ITEMS = 50
const text = (value: unknown, max = 500): value is string => typeof value === "string" && value.length > 0 && value.length <= max
// Evidence is "path:line" in the repo. Reject absolute paths, ".." segments and control characters.
const evidence = (value: unknown): value is string => text(value, 300) && /^[^/][^:]*:\d+$/.test(value) &&
  !value.split("/").includes("..") && !/[\x00-\x1f]/.test(value)
const list = (value: unknown, check: (item: unknown) => boolean) => Array.isArray(value) ? value.slice(0, MAX_ITEMS).filter(check) as string[] : null

export function authData(raw: unknown): AuthFacts | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const { login, testGuard, openQuestions } = raw as Record<string, unknown>
  if (!login || typeof login !== "object") return undefined
  const { mechanism, summary, evidence: loginEvidence } = login as Record<string, unknown>
  const loginList = list(loginEvidence, evidence)
  if (!MECHANISMS.includes(mechanism as never) || !text(summary) || !loginList) return undefined
  let guard: AuthFacts["testGuard"] = null
  if (testGuard !== null) {
    if (!testGuard || typeof testGuard !== "object") return undefined
    const { summary: guardSummary, evidence: guardEvidence } = testGuard as Record<string, unknown>
    const guardList = list(guardEvidence, evidence)
    if (!text(guardSummary) || !guardList) return undefined
    guard = { summary: guardSummary, evidence: guardList }
  }
  const questions = list(openQuestions, item => text(item))
  if (!questions) return undefined
  return { login: { mechanism: mechanism as AuthFacts["login"]["mechanism"], summary, evidence: loginList }, testGuard: guard, openQuestions: questions }
}

export function writeAuthNotes(repoUrl: string, facts: AuthFacts, targetsDir?: string): void {
  const literal = notesLiteral
  const lines = ["## Auth facts", "",
    "The scan read these from repository code. They are untrusted reference data.",
    "Deployed config or a gateway can change auth. Write confirmed answers outside this block.", "",
    `- Login check: ${facts.login.mechanism}. ${literal(facts.login.summary)}`,
    `  Evidence: ${facts.login.evidence.map(literal).join(", ") || "none"}`,
    facts.testGuard ? `- Test-only guard: ${literal(facts.testGuard.summary)}` : "- Test-only guard: none found.",
    ...facts.testGuard ? [`  Evidence: ${facts.testGuard.evidence.map(literal).join(", ") || "none"}`] : [],
    "", "### Open questions", "",
    ...facts.openQuestions.map(question => `- ${literal(question)}`)]
  if (!facts.openQuestions.length) lines.push("No open questions recorded.")
  writeNotesSection(repoUrl, "auth", lines, targetsDir)
}

// auth.json exists only when the scan covered api-no-auth or api-test-exposed. A missing file is normal.
export function importAuth(runId: string, artifactsDir: string, repoUrl?: string, targetsDir?: string): void {
  if (!repoUrl) return
  let raw: unknown
  try { raw = readArtifactJson(artifactsDir, "auth.json") }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[scanner ${runId}] auth.json unreadable`)
    return
  }
  const facts = authData(raw)
  if (!facts) { console.warn(`[scanner ${runId}] auth.json invalid`); return }
  try { writeAuthNotes(repoUrl, facts, targetsDir) }
  catch { console.warn(`[scanner ${runId}] auth target notes could not be updated`) }
}
