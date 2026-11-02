import { test } from "bun:test"
import { strict as assert } from "node:assert"
import { CLOSE_STEPS, closeStep } from "./close_pr.ts"
import type { SuitePRInfo } from "./close_pr.ts"

function fakeClient(pr: SuitePRInfo, failDelete = false) {
  const calls: string[] = []
  const comments: string[] = []
  const client = {
    async suitePR() { return { ...pr } },
    async listComments() { return [...comments] },
    async commentPR(_: number, body: string) { calls.push("comment"); comments.push(body) },
    async closePR() { calls.push("close"); pr.state = "closed" },
    async deleteBranch(ref: string) { if (failDelete) throw new Error("tracker GitHub request failed (500)"); calls.push(`delete ${ref}`) },

    async openPRFiles() { return [] }, async prState() { return "closed" as const },
  }
  const store = { async read() { calls.push("rows"); return [] }, async write(): Promise<never> { throw new Error("unexpected write") } }
  return { client, store, calls, comments }
}

const suite = (): SuitePRInfo => ({ state: "open", merged: false, ref: "security/log-leak-cli-tasks-280038f9", sameRepo: true })

test("close steps run in order and post the reason", async () => {
  const { client, store, calls, comments } = fakeClient(suite())
  for (const step of CLOSE_STEPS) await closeStep(client, store, "a/b", 7, step, "test")
  assert.deepEqual(calls, ["comment", "close", "rows", "delete security/log-leak-cli-tasks-280038f9", "rows"])
  assert.deepEqual(comments, ["Closed from the security-patch app. Reason: test PR."])
})

test("the typed note follows the chip, or stands alone", async () => {
  const both = fakeClient(suite())
  await closeStep(both.client, both.store, "a/b", 7, "comment", "bad-fix", undefined, "  breaks login  ")
  assert.deepEqual(both.comments, ["Closed from the security-patch app. Reason: bad fix. breaks login"])
  const noteOnly = fakeClient(suite())
  await closeStep(noteOnly.client, noteOnly.store, "a/b", 7, "comment", undefined, undefined, "dup of #9")
  assert.deepEqual(noteOnly.comments, ["Closed from the security-patch app. Reason: dup of #9"])
})

test("a retry after a failed step skips the steps already done", async () => {
  const pr = suite()
  const first = fakeClient(pr, true)
  await closeStep(first.client, first.store, "a/b", 7, "comment")
  await closeStep(first.client, first.store, "a/b", 7, "close")
  await assert.rejects(closeStep(first.client, first.store, "a/b", 7, "branch"), /500/)
  const retry = fakeClient(pr)
  retry.comments.push(...first.comments)
  for (const step of CLOSE_STEPS) await closeStep(retry.client, retry.store, "a/b", 7, step)
  assert.deepEqual(retry.calls, ["rows", "delete security/log-leak-cli-tasks-280038f9", "rows"])
})

test("non-suite, merged and still-open PRs are refused", async () => {
  const feature = fakeClient({ ...suite(), ref: "feature/x" })
  const merged = fakeClient({ ...suite(), merged: true, state: "closed" })
  const open = fakeClient(suite())
  await assert.rejects(closeStep(feature.client, feature.store, "a/b", 7, "comment"), /not a suite PR/)
  await assert.rejects(closeStep(merged.client, merged.store, "a/b", 7, "close"), /merged/)
  await assert.rejects(closeStep(open.client, open.store, "a/b", 7, "branch"), /still open/)
})

test("the close reason is saved only after the close succeeds", async () => {
  const file = { category: "sqli", url: "", log: [], rows: [], prs: { 7: { rowIds: ["a"] } } } as never
  const writes: unknown[] = []
  const { client } = fakeClient(suite())
  const store = { async read() { return [file] }, async write(next: unknown) { writes.push(next); return next } } as never
  await closeStep(client, store, "a/b", 7, "comment", "test")
  assert.equal(writes.length, 0)
  await closeStep({ ...client, async closePR() { throw new Error("tracker GitHub request failed (500)") } }, store, "a/b", 7, "close", "test").catch(() => {})
  assert.equal(writes.length, 0)
  await closeStep(client, store, "a/b", 7, "close", "test")
  assert.equal(writes.length, 1)
  assert.equal((writes[0] as { prs: Record<number, { closeReason: string }> }).prs[7].closeReason, "test PR")
})
