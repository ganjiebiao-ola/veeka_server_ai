import { recordPR, type TrackerStore } from "./store.ts"
import { GitHubClient } from "./client.ts"
import { refreshRows } from "./pick.ts"
import type { PickClient } from "./pick.ts"

// Closing a suite PR from the Overview. GitHub has no transaction across calls, so each step runs on
// its own request, in this order, and first reads GitHub to skip work already done. A retry is safe.
export const CLOSE_STEPS = ["comment", "close", "branch", "rows"] as const
export type CloseStep = typeof CLOSE_STEPS[number]
export const CLOSE_REASONS = { test: "test PR", "bad-fix": "bad fix", replaced: "replaced by a newer PR", superseded: "replaced by a newer PR" } as const
export type CloseReason = keyof typeof CLOSE_REASONS
const MARKER = "Closed from the security-patch app."
export const NOTE_MAX = 500

export type SuitePRInfo = { state: "open" | "closed", merged: boolean, ref: string, sameRepo: boolean }
export interface ClosePRClient extends PickClient {
  listComments(number: number): Promise<string[]>
  suitePR(number: number): Promise<SuitePRInfo>
  commentPR(number: number, body: string): Promise<void>
  closePR(number: number): Promise<void>
  deleteBranch(ref: string): Promise<void>
}

export async function closeStep(client: ClosePRClient, store: TrackerStore, repo: string, number: number, step: CloseStep, reason?: CloseReason, held?: Set<string>, note = ""): Promise<void> {
  const pr = await client.suitePR(number)
  if (!GitHubClient.SUITE_BRANCH.test(pr.ref)) throw new Error(`PR #${number} is not a suite PR`)
  if (pr.merged) throw new Error(`PR #${number} is merged`)
  if (step === "comment") {
    if (pr.state !== "open" || (await client.listComments(number)).some(body => body.startsWith(MARKER))) return
    const why = [reason && `${CLOSE_REASONS[reason]}.`, note.trim()].filter(Boolean).join(" ")
    await client.commentPR(number, why ? `${MARKER} Reason: ${why}` : MARKER)
  } else if (step === "close") {
    if (pr.state === "open") await client.closePR(number)
    // Saved after the close so a PR closed later on GitHub is not counted as closed from here.
    const files = await store.read()
    const categories = files.filter(file => file.rows.some(row => row.pr.includes(`[PR #${number}]`)) || file.prs?.[number]).map(file => file.category)
    const savedReason = files.map(file => file.prs?.[number]?.closeReason).find(Boolean)
    const closeReason = reason ? CLOSE_REASONS[reason] : savedReason === "superseded" ? CLOSE_REASONS.replaced : savedReason ?? "bad fix"
    const rowIds = [...new Set(files.flatMap(file => [...file.prs?.[number]?.rowIds ?? [], ...file.rows.filter(row => row.pr.includes(`[PR #${number}]`)).map(row => row.id)]))]
    if (categories.length) await recordPR(store, number, { closeReason, ...(rowIds.length ? { rowIds } : {}) }, categories, `PR #${number} closed: ${closeReason}`)
  } else if (step === "branch") {
    // Deleting the branch of an open PR also closes it, with no comment. Close first.
    if (pr.state === "open") throw new Error(`PR #${number} is still open`)
    if (pr.sameRepo) await client.deleteBranch(pr.ref)
  } else {
    await refreshRows(client, store, repo, held)
  }
}
