import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
import type { PRRecord } from "./store.ts"

export type Outcome = "full" | "partial" | "rejected" | "unknown" | "open" | "excluded"
export type ImpactPR = { number: number, title: string, url: string, state: "open" | "closed" | "merged", head: string, base: string, ref: string }
export type CommitEvidence = { pushed: string[], merged: string[], pushedPatch?: string, mergedPatch?: string }
const CANONICAL_REASONS: Record<string, string> = { "test pr": "test PR", "bad fix": "bad fix", superseded: "replaced by a newer PR", "replaced by a newer pr": "replaced by a newer PR" }
export const closeReason = (reason?: string) => reason === undefined ? undefined : CANONICAL_REASONS[reason.trim().toLowerCase()] ?? reason

export function classifyAdoption(pr: Pick<ImpactPR, "state">, record: PRRecord = {}, evidence?: CommitEvidence): Outcome {
  if (pr.state === "closed" && ["test PR", "replaced by a newer PR"].includes(closeReason(record.closeReason) ?? "")) return "excluded"
  if (pr.state === "open") return "open"
  if (pr.state === "closed") return "rejected"
  if (!record.pushedSha || !evidence || !evidence.pushed.length || !evidence.merged.length) return "unknown"
  return (!evidence.pushedPatch || evidence.pushedPatch === evidence.mergedPatch) && evidence.pushed.length === evidence.merged.length && [...evidence.pushed].sort().every((id, i) => id === [...evidence.merged].sort()[i]) ? "full" : "partial"
}

const GIT_TIMEOUT_MS = 30_000
const FETCH_TIMEOUT_MS = 60_000
const FAILURE_TTL_MS = 10 * 60_000
const failures = new Map<string, number>()

class GitTimeout extends Error {}

async function git(dir: string, args: string[], token?: string, input?: string, timeout = GIT_TIMEOUT_MS): Promise<string> {
  const process = Bun.spawn(["git", "-C", dir, "-c", "core.hooksPath=/dev/null", ...args], {
    timeout,
    env: { ...globalThis.process.env, GIT_TERMINAL_PROMPT: "0", ...(token ? { SECPATCH_READ_TOKEN: token } : {}) },
    stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "ignore",
  })
  const output = await new Response(process.stdout).text()
  if (await process.exited !== 0) throw process.signalCode ? new GitTimeout("adoption git timed out") : new Error("adoption commit evidence unavailable")
  return output
}

// Compare patches rather than hashes: a rebase rewrites hashes, and base merges add no fix patch.
const inflight = new Map<string, Promise<Map<number, CommitEvidence>>>()

// A caller that joins an in-flight fetch gets its PR set; the cache files cover the rest on the next load.
export function mergedEvidence(repo: string, token: string, prs: ImpactPR[], records: Record<string, PRRecord>, cacheDir: string): Promise<Map<number, CommitEvidence>> {
  const running = inflight.get(repo)
  if (running) return running
  const promise = collectEvidence(repo, token, prs, records, cacheDir).finally(() => inflight.delete(repo))
  inflight.set(repo, promise)
  return promise
}

async function collectEvidence(repo: string, token: string, prs: ImpactPR[], records: Record<string, PRRecord>, cacheDir: string): Promise<Map<number, CommitEvidence>> {
  await mkdir(cacheDir, { recursive: true })
  const result = new Map<number, CommitEvidence>()
  const pending: { pr: ImpactPR, path: string, key: string }[] = []
  for (const pr of prs.filter(pr => pr.state === "merged" && records[pr.number]?.pushedSha)) {
    const key = createHash("sha256").update(`${repo}:${pr.number}:${records[pr.number].pushedSha}`).digest("hex")
    const path = join(cacheDir, `${key}.json`)
    try {
      const value = JSON.parse(await readFile(path, "utf8"))
      if (!Array.isArray(value.pushed) || !Array.isArray(value.merged) || ![...value.pushed, ...value.merged].every(id => /^[a-f0-9]{40}$/.test(id))) throw new Error("invalid cache")
      result.set(pr.number, value)
    } catch { if (Date.now() - (failures.get(key) ?? -Infinity) >= FAILURE_TTL_MS) pending.push({ pr, path, key }) }
  }
  if (!pending.length) return result
  const dir = await mkdtemp(join(cacheDir, "objects-"))
  try {
    await git(dir, ["init", "--bare", "-q"])
    const refsOf = ({ pr }: { pr: ImpactPR }) => [pr.base, pr.head, records[pr.number].pushedSha!]
    const fetch = (refs: string[]) => git(dir, ["-c", "credential.helper=", "-c", 'credential.https://github.com.helper=!f() { test "$1" = get && echo username=x-access-token && echo "password=$SECPATCH_READ_TOKEN"; }; f',
      "fetch", "-q", "--no-tags", `https://github.com/${repo}.git`, ...refs], token, undefined, FETCH_TIMEOUT_MS)
    const fail = ({ key }: { key: string }) => { failures.set(key, Date.now()) }
    const valid = pending.filter(item => refsOf(item).every(sha => /^[a-f0-9]{40}$/.test(sha)))
    for (const item of pending) if (!valid.includes(item)) fail(item)
    const fetched: typeof pending = []
    try {
      await fetch([...new Set(valid.flatMap(refsOf))])
      fetched.push(...valid)
    } catch (error) {
      // One unfetchable commit fails the whole batch, so retry per PR. A timeout means GitHub is unreachable.
      if (error instanceof GitTimeout) valid.forEach(fail)
      else for (const item of valid) {
        try { await fetch(refsOf(item)); fetched.push(item) } catch { fail(item) }
      }
    }
    const patches = new Map<string, string>()
    const list = async (base: string, head: string) => {
      const commits = (await git(dir, ["rev-list", "--reverse", "--no-merges", `${base}..${head}`])).trim().split("\n").filter(Boolean)
      const ids: string[] = []
      for (const sha of commits) {
        let id = patches.get(sha)
        if (id === undefined) {
          const patch = await git(dir, ["show", "--format=", "--unified=0", "--binary", "--no-ext-diff", "--no-textconv", sha])
          id = (await git(dir, ["patch-id", "--stable"], undefined, patch)).trim().split(/\s/)[0] ?? ""
          patches.set(sha, id)
        }
        if (id) ids.push(id)
      }
      return ids
    }
    for (const { pr, path, key } of fetched) {
      try {
        const patchId = async (head: string) => (await git(dir, ["patch-id", "--stable"], undefined,
          await git(dir, ["diff", "--unified=0", "--binary", "--no-ext-diff", "--no-textconv", `${pr.base}...${head}`]))).trim().split(/\s/)[0] ?? ""
        const evidence = { pushed: await list(pr.base, records[pr.number].pushedSha!), merged: await list(pr.base, pr.head),
          pushedPatch: await patchId(records[pr.number].pushedSha!), mergedPatch: await patchId(pr.head) }
        result.set(pr.number, evidence)
        await writeFile(path, JSON.stringify(evidence), { mode: 0o600 })
      } catch { failures.set(key, Date.now()) }
    }
  } catch { /* Missing objects or GitHub access must remain unknown. */ }
  finally { await rm(dir, { recursive: true, force: true }) }
  return result
}
