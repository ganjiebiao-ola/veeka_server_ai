import { scanCoverage } from "../tracker/coverage.ts"
import type { TrackerStore } from "../tracker/store.ts"
import type { Context } from "hono"
import { GitHubClient, operatorToken } from "../tracker/client.ts"
import { resolveTracker, trackerForUrl, trackerRepos } from "../tracker/repos.ts"
import { confirming, ignoreRows, needsHumanRows, loadPick, reopenRows, queuedBatches, refreshReadRows, streamPick } from "../tracker/pick.ts"
import type { PickClient } from "../tracker/pick.ts"
import { handleStartRun, heldRows, trackerStoreFor } from "./runs.ts"
import { openBatchPR } from "../orchestrator/batch_pr.ts"
import { overview } from "../tracker/overview.ts"
import { CLOSE_REASONS, CLOSE_STEPS, NOTE_MAX, closeStep } from "../tracker/close_pr.ts"
import type { ClosePRClient, CloseReason, CloseStep } from "../tracker/close_pr.ts"
import type { OverviewClient } from "../tracker/overview.ts"
import type { BatchPRClient } from "../orchestrator/batch_pr.ts"
import type { RunHandlersDeps } from "./runs.ts"
import { validPickedIds } from "../../shared/types.ts"
import { CATEGORIES } from "../tracker/rows.ts"
import type { StartRunRequest } from "../../shared/types.ts"

// GET /api/trackers — the repos Pick and Overview can switch between. The first is the default.
export function handleTrackers(c: Context): Response {
  const repos = trackerRepos()
  return c.json({ repos, removable: repos })
}

// Reads once until a write or reset, so one request never downloads the tracker files twice for the same state.
function readOnce(store: TrackerStore): TrackerStore & { reset(): void } {
  let files: ReturnType<TrackerStore["read"]> | undefined
  return {
    reset: () => { files = undefined },
    read: () => {
      const reading = files ??= store.read()
      reading.catch(() => { if (files === reading) files = undefined })
      return reading
    },
    write: async (file, rows, message) => {
      try { return await store.write(file, rows, message) }
      finally { files = undefined }
    },
  }
}

export async function handlePick(c: Context, deps: RunHandlersDeps, confirm = false, suppliedClient?: PickClient): Promise<Response> {
  let repo: string
  let body: Partial<StartRunRequest> & { repo?: string } = {}
  let ignorePRs: number[]
  try {
    if (confirm) body = await c.req.json()
    repo = resolveTracker(confirm ? body.repo : c.req?.query?.("repo"))
    const ignored = confirm ? (body.ignorePRs === undefined ? [] : body.ignorePRs) : c.req?.queries?.("ignorePR") ?? []
    if (!Array.isArray(ignored) || ignored.some(value => confirm
      ? !Number.isSafeInteger(value) || Number(value) < 1
      : typeof value !== "string" || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))) {
      throw new Error("ignorePRs must contain positive PR numbers")
    }
    ignorePRs = ignored.map(Number)
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400)
  }
  if (confirm && confirming.has(repo)) return c.json({ error: "Pick confirmation in progress" }, 409)
  if (confirm) confirming.add(repo)
  try {
    const client = suppliedClient ?? new GitHubClient(repo, await operatorToken(deps.getGhToken))
    const trackerStore = await trackerStoreFor(repo, deps)
    if (!confirm) {
      const readStore = readOnce(trackerStore)
      const readingPRs = client.openPRs?.(undefined, true)
      // Observe early failures while row refresh runs. Pick still reports the failure below.
      void readingPRs?.catch(() => {})
      // Reuse only an unchanged, successful refresh within this GET.
      if (await syncRows(client, readStore, repo, deps) !== 0) readStore.reset()
      const acceptsStream = c.req?.header?.("Accept")?.includes("text/event-stream") || c.req?.query?.("stream") === "1"
      if (!acceptsStream) return c.json({ repoUrl: `https://github.com/${repo}`, ...await loadPick(client, readStore, ignorePRs, readingPRs) })
      const repoUrl = `https://github.com/${repo}`
      const encoder = new TextEncoder()
      let cancelled = false
      const stream = new ReadableStream({
        async start(controller) {
          try {
            await streamPick(client, readStore, update => {
              if (cancelled) return
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ repoUrl, ...update })}\n\n`))
            }, ignorePRs, readingPRs)
          } catch (error) {
            if (!cancelled) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ repoUrl, type: "error", error: (error as Error).message })}\n\n`))
            }
          } finally {
            if (!cancelled) {
              try { controller.close() } catch {}
            }
          }
        },
        cancel() {
          cancelled = true
        },
      })
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
        },
      })
    }
    if (typeof body.sessionId !== "string" || !body.sessionId.trim()) return c.json({ error: "sessionId required" }, 400)
    if (!validPickedIds(body.pickedIds) || !body.pickedIds.length) return c.json({ error: "select one or more unique row ids" }, 400)
    const response = await handleStartRun(c, deps, {
      sessionId: body.sessionId, repoUrl: `https://github.com/${repo}`,
      skill: "ola-security-audit", mode: "fix",
      provider: body.provider, reviewProvider: body.reviewProvider, reviewModel: body.reviewModel, reviewEffort: body.reviewEffort, language: body.language,
      ...(body.authMode !== undefined ? { authMode: body.authMode } : {}),
      model: body.model ?? "opus", effort: body.effort ?? "high", pickedIds: body.pickedIds, ignorePRs,
      ...(body.note !== undefined ? { note: body.note } : {}),
      ...(body.smokeSeconds !== undefined ? { smokeSeconds: body.smokeSeconds } : {}),
    }, ignoringPRs(client, ignorePRs))
    // Run validation also serves /runs. Map its GitHub failure here for the Pick API.
    if (response.status === 400) {
      const failure = await response.clone().json().catch(() => null) as { error?: string } | null
      if (failure?.error?.startsWith("tracker GitHub")) return c.json(failure, 502)
    }
    return response
  } catch (error) {
    return c.json({ error: (error as Error).message }, 502)
  } finally {
    if (confirm) confirming.delete(repo)
  }
}

function ignoringPRs(client: PickClient, ignorePRs: number[]): PickClient {
  return new Proxy(client, { get(target, key) {
    if (key === "ignorePRs") return ignorePRs
    const value = Reflect.get(target, key, target)
    return typeof value === "function" ? value.bind(target) : value
  } })
}

// GET /api/overview — every bug type with row counts, open suite PRs, and needs-human rows.
// Rows follow closed and merged PRs, and rows whose run ended reopen. GitHub errors never block the page.
async function syncRows(client: PickClient, trackerStore: TrackerStore, repo: string, deps: { store: RunHandlersDeps["store"], runsRootDir: string }): Promise<number | undefined> {
  try { return await refreshReadRows(client, trackerStore, repo, await heldRows(deps)) }
  catch (error) { console.warn(`[pick] row refresh skipped: ${(error as Error).message}`) }
}

export async function handleOverview(c: Context, deps: Pick<RunHandlersDeps, "store" | "runsRootDir" | "createTrackerStore" | "getGhToken">, suppliedClient?: OverviewClient): Promise<Response> {
  let repo: string
  try { repo = resolveTracker(c.req?.query?.("repo")) } catch (error) { return c.json({ error: (error as Error).message }, 400) }
  try {
    const categories = c.req?.queries?.("category") ?? []
    const severities = c.req?.queries?.("severity") ?? []
    if (categories.length > CATEGORIES.length || categories.some(value => !CATEGORIES.includes(value))) return c.json({ error: "Invalid bug type filter" }, 400)
    if (severities.length > 3 || severities.some(value => !["P0", "P1", "P2"].includes(value))) return c.json({ error: "Invalid priority filter" }, 400)
    const client = suppliedClient ?? new GitHubClient(repo, await operatorToken(deps.getGhToken))
    // The full PR list is the slowest read, so it runs alongside the row refresh. overview() reports its failure.
    const readingDetails = client.impactPRs?.()
    void readingDetails?.catch(() => {})
    const trackerStore = readOnce(await trackerStoreFor(repo, deps))
    if (await syncRows(client, trackerStore, repo, deps) !== 0) trackerStore.reset()
    const data = await overview(client, trackerStore, repo, { categories, severities }, deps.runsRootDir, readingDetails)
    const repository = deps.store.listRepos?.().find(item => item.repo === repo)
    const runs = []
    if (deps.store.listAllRuns) for (let offset = 0; ; offset += 200) {
      const page = deps.store.listAllRuns(200, offset)
      runs.push(...page)
      if (page.length < 200) break
    }
    data.coverage = scanCoverage(repo, runs, deps.runsRootDir, repository?.profile, repository?.override)
    return c.json(data)
  } catch (error) {
    return c.json({ error: (error as Error).message }, 502)
  }
}

// POST /api/pick/ignore {repo, ids, reason} — set open rows to ignored, with the reason, in their tracking issue.
// POST /api/pick/needs-human {repo, ids, reason} — set open rows aside for an owner decision.
// POST /api/pick/reopen {repo, ids} — set ignored or needs-human rows back to open.
export async function handleRowChange(c: Context, deps: Pick<RunHandlersDeps, "store" | "runsRootDir" | "createTrackerStore" | "getGhToken">, action: "ignore" | "needs-human" | "reopen", suppliedClient?: PickClient): Promise<Response> {
  let repo: string
  let body: { repo?: string, ids?: unknown, reason?: unknown }
  try {
    body = await c.req.json()
    repo = resolveTracker(body.repo)
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400)
  }
  // Shares the pick lock, so an ignore and a pick never write the same rows at once.
  if (confirming.has(repo)) return c.json({ error: "Pick confirmation in progress" }, 409)
  confirming.add(repo)
  try {
    const client = suppliedClient ?? new GitHubClient(repo, await operatorToken(deps.getGhToken))
    const trackerStore = await trackerStoreFor(repo, deps)
    const changed = action === "reopen"
      ? await reopenRows(client, trackerStore, repo, body.ids)
      : await (action === "ignore" ? ignoreRows : needsHumanRows)(client, trackerStore, repo, body.ids, body.reason, await heldRows(deps))
    return c.json({ changed })
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400)
  } finally {
    confirming.delete(repo)
  }
}

// POST /api/overview/prs/:number/close {repo, step, reason?, note?} — one step of closing a suite PR.
// The Overview calls the steps in CLOSE_STEPS order and shows each one's result.
export async function handleClosePR(c: Context, deps: Pick<RunHandlersDeps, "store" | "runsRootDir" | "createTrackerStore" | "getGhToken">, suppliedClient?: ClosePRClient): Promise<Response> {
  let repo: string
  let body: { repo?: string, step?: string, reason?: string, note?: unknown }
  try {
    body = await c.req.json()
    repo = resolveTracker(body.repo)
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400)
  }
  const number = Number(c.req.param("number"))
  if (!Number.isInteger(number) || number < 1) return c.json({ error: "invalid PR number" }, 400)
  if (!CLOSE_STEPS.includes(body.step as CloseStep)) return c.json({ error: "invalid step" }, 400)
  if (body.reason !== undefined && !Object.hasOwn(CLOSE_REASONS, body.reason)) return c.json({ error: "invalid reason" }, 400)
  if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > NOTE_MAX)) return c.json({ error: `note must be text of at most ${NOTE_MAX} characters` }, 400)
  try {
    const client = suppliedClient ?? new GitHubClient(repo, await operatorToken(deps.getGhToken))
    const trackerStore = await trackerStoreFor(repo, deps)
    await closeStep(client, trackerStore, repo, number, body.step as CloseStep, body.reason as CloseReason | undefined, await heldRows(deps), body.note as string | undefined)
    return c.json({ ok: true })
  } catch (error) {
    return c.json({ error: (error as Error).message }, 502)
  }
}

// After a picked fix run completes: open its PR, then start the next batch of the same pick.
// A batch that opens no PR ends the chain, and its later rows stay in Pick.
export async function finishBatch(deps: RunHandlersDeps, runId: string, suppliedClient?: BatchPRClient): Promise<string | undefined> {
  const queued = queuedBatches.get(runId)
  queuedBatches.delete(runId)
  // The batch PR goes to the repo the run scanned, which must still be a configured tracker.
  const run = deps.store.getRun(runId)
  const repo = run && trackerForUrl(run.repoUrl)
  if (!repo) throw new Error(`run ${runId} is not on a configured tracker repository`)
  const client = suppliedClient ?? new GitHubClient(repo, await operatorToken(deps.getGhToken))
  const trackerStore = await trackerStoreFor(repo, deps)
  const pr = await openBatchPR(deps, runId, client, trackerStore, repo)
  if (!pr || !queued) return
  const [ids, ...rest] = queued.rest
  let result: { runId?: string, error?: string } = {}
  let status = 0
  const c = { json: (value: typeof result, code = 200) => { result = value; status = code; return new Response() } } as unknown as Context
  await handleStartRun(c, deps, { ...queued.body, pickedIds: ids }, ignoringPRs(client, queued.body.ignorePRs ?? []))
  if (status !== 201 || !result.runId) {
    console.warn(`[pick] ${runId}: next batch did not start: ${result.error ?? status}`)
    return
  }
  // handleStartRun queues nothing for a single batch, so carry the rest over.
  if (rest.length) queuedBatches.set(result.runId, { ...queued, rest })
  return result.runId
}

export function recordBatchError(deps: Pick<RunHandlersDeps, "store" | "bus">, runId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  if (deps.store.getRun(runId)) deps.store.setRunError(runId, message)
  deps.bus.publish(runId, { type: "push_result", ok: false, error: message })
}
