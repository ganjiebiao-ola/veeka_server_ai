import type { Context } from "hono"
import type { Store } from "../store/repo.ts"
import { githubRepo } from "../tracker/repos.ts"
import { FRAMEWORK, PHP_VERSION, profileData } from "../orchestrator/profile.ts"
import { GitHubClient, operatorToken } from "../tracker/client.ts"
import { detectProfile } from "../../scanner/lib/profile.mjs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RepoLanguage, RepoProfile } from "../../shared/types.ts"

const languageCache = new Map<string, { expires: number, value: RepoLanguage }>()

export async function handleRepoLanguage(c: Context, deps: { getGhToken?: () => Promise<string | undefined>, client?: (repo: string) => Promise<Pick<GitHubClient, "languages">> } = {}): Promise<Response> {
  const repo = githubRepo(c.req.query("url") ?? "")
  if (!repo) return c.json({ error: "url must be a GitHub repository" }, 400)
  const cached = languageCache.get(repo)
  if (cached && cached.expires > Date.now()) return c.json(cached.value)
  try {
    const client = await (deps.client ? deps.client(repo) : new GitHubClient(repo, await operatorToken(deps.getGhToken)))
    const entries = Object.entries(await client.languages())
    const total = entries.reduce((sum, [, bytes]) => sum + bytes, 0)
    const top = entries.reduce<[string, number] | undefined>((best, entry) => !best || entry[1] > best[1] ? entry : best, undefined)
    const value: RepoLanguage = total && top ? { language: top[0], share: Math.round(top[1] / total * 100) } : { language: null, share: 0 }
    languageCache.set(repo, { expires: Date.now() + 5 * 60_000, value })
    return c.json(value)
  } catch {
    return c.json({ error: "could not read the repo languages. Check gh auth login or GH_TOKEN." }, 502)
  }
}

// GET /api/repos — repos the dev has started runs on, newest first, with the branch last used.
export function handleListRepos(c: Context, deps: { store: Store }): Response {
  return c.json({ repos: deps.store.listRepos() })
}

export async function handleAddRepo(c: Context, deps: { store: Store }): Promise<Response> {
  const body = await c.req.json().catch(() => null) as { url?: unknown; branch?: unknown } | null
  const url = typeof body?.url === "string" ? body.url.trim() : ""
  const repo = githubRepo(url)
  if (!repo) return c.json({ error: "url must be a GitHub repository" }, 400)
  if (body?.branch !== undefined && typeof body.branch !== "string") return c.json({ error: "invalid branch" }, 400)
  const branch = (body?.branch as string | undefined)?.trim() ?? ""
  if (branch && (branch === "@" || branch.startsWith("-") || /[\x00-\x20\x7f~^:?*\\\[]|\.\.|@\{|^\/|\/\/|\/$|\.$|(?:^|\/)\.|\.lock(?:\/|$)/.test(branch))) {
    return c.json({ error: "invalid branch" }, 400)
  }
  deps.store.touchRepo(repo, url, branch)
  return c.json({ ok: true, repo })
}

const detections = new Map<string, Promise<RepoProfile | null>>()
const MAX_TARBALL_BYTES = 200 * 1024 * 1024
type DetectDeps = { store: Store, getGhToken?: () => Promise<string | undefined> }

// POST /api/repos/detect {url} — the added repo's profile, detected once from its GitHub tarball.
// A saved profile is returned as it is. A failed detection returns null, and the first scan detects it.
export async function handleDetectProfile(c: Context, deps: DetectDeps): Promise<Response> {
  const body = await c.req.json().catch(() => null) as { url?: unknown } | null
  const repo = githubRepo(typeof body?.url === "string" ? body.url : "")
  if (!repo) return c.json({ error: "url must be a GitHub repository" }, 400)
  const row = deps.store.listRepos().find(r => r.repo === repo)
  if (!row) return c.json({ error: "unknown repo: add it first" }, 404)
  if (row.profile) return c.json({ profile: row.profile })
  let detection = detections.get(repo)
  if (!detection) {
    detection = detectFromTarball(repo, row.branch, deps).finally(() => detections.delete(repo))
    detections.set(repo, detection)
  }
  return c.json({ profile: await detection })
}

async function detectFromTarball(repo: string, branch: string, deps: DetectDeps): Promise<RepoProfile | null> {
  const dir = await mkdtemp(join(tmpdir(), "repo-profile-"))
  try {
    const signal = AbortSignal.timeout(60_000)
    const ref = branch ? `/${branch.split("/").map(encodeURIComponent).join("/")}` : ""
    const response = await fetch(`https://api.github.com/repos/${repo}/tarball${ref}`, {
      signal, headers: { Authorization: `Bearer ${await operatorToken(deps.getGhToken)}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    })
    if (!response.ok || !response.body) throw new Error(`tarball request failed (${response.status})`)
    const chunks: Uint8Array<ArrayBuffer>[] = []
    let size = 0
    const reader = response.body.getReader()
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      const chunk = read.value
      size += chunk.length
      if (size > MAX_TARBALL_BYTES) throw new Error("tarball is over 200 MB")
      chunks.push(chunk)
    }
    const tar = Bun.spawn(["tar", "-xzf", "-", "-C", dir, "--strip-components=1", "--no-same-owner"], { stdin: new Blob(chunks), stdout: "ignore", stderr: "ignore", signal })
    if (await tar.exited !== 0) throw new Error("tar could not extract the tarball")
    // The backend extracted these files itself, and its image has no agent user to switch to.
    const profile = profileData(detectProfile(dir, false))
    if (!profile) throw new Error("invalid profile")
    // A scan that saved a profile meanwhile wins.
    const saved = deps.store.listRepos().find(r => r.repo === repo)
    if (!saved || saved.profile) return saved?.profile ?? null
    deps.store.saveProfile(repo, profile)
    return profile
  } catch (error) {
    console.warn(`[profile ${repo}] detection failed: ${(error as Error).name === "TimeoutError" ? "timed out" : (error as Error).message}`)
    return null
  } finally { await rm(dir, { recursive: true, force: true }) }
}

// PUT /api/repos/profile {url, php, framework} — the operator's PHP version and framework for the next scans.
// Empty fields keep the detected value. Both empty clears the override.
export async function handleSetProfile(c: Context, deps: { store: Store }): Promise<Response> {
  const body = await c.req.json().catch(() => null) as { url?: unknown; php?: unknown; framework?: unknown } | null
  const repo = githubRepo(typeof body?.url === "string" ? body.url : "")
  if (!repo) return c.json({ error: "url must be a GitHub repository" }, 400)
  const php = typeof body?.php === "string" ? body.php.trim() : ""
  const framework = typeof body?.framework === "string" ? body.framework.trim().toLowerCase() : ""
  if (php && !PHP_VERSION.test(php)) return c.json({ error: "php must look like 7.2" }, 400)
  if (framework && !FRAMEWORK.test(framework)) return c.json({ error: "framework must be lower-case letters, digits or dashes" }, 400)
  if (!deps.store.setProfileOverride(repo, { php, framework })) return c.json({ error: "unknown repo: start a scan on it first" }, 404)
  return c.json({ ok: true })
}

// DELETE /api/repos?url=<repo url> — forget a repo. Its past runs stay in History.
export function handleRemoveRepo(c: Context, deps: { store: Store }): Response {
  const repo = githubRepo(c.req.query("url") ?? "")
  if (!repo) return c.json({ error: "url must be a GitHub repository" }, 400)
  deps.store.removeRepo(repo)
  return c.json({ ok: true })
}
