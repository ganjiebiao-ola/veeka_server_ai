import { mergedEvidence, type ImpactPR } from "./adoption.ts"
import type { PRRecord } from "./store.ts"
import { CATEGORIES, parseRows, replaceRows } from "./rows.ts"
import type { Row } from "./rows.ts"
import { scrub } from "./scrub.ts"
import type { PRDetail, PRFile, PRCheck, PRStatus, PRComment, PRReview } from "../../shared/pr.ts"

export type PRState = "open" | "merged" | "closed"
export type OpenPR = { number: number, headRefName: string, files: string[] }
type Connection<T> = { nodes: T[], pageInfo: { hasNextPage: boolean, endCursor: string | null } }
type ChangedFile = { path: string, changeType: string }
const impactCache = new Map<string, { expires: number, value: Promise<ImpactPR[]> }>()
const openPRCache = new Map<string, { expires: number, value: Promise<OpenPR[]> }>()
const IMPACT_PAGE_WAVE = 20
const TITLE = /^security-patch: ([a-z0-9-]+)(?: \(([2-9]|[1-9]\d+)\))?$/

// A spill writes the later page first. If the earlier write then fails, a row is on both pages and the later copy is current.
function mergePages(bodies: string[], category: string, repo: string): string {
  const rows = new Map<string, Row>()
  for (const body of bodies) for (const row of parseRows(body, category)) rows.set(row.id, row)
  return replaceRows(bodies[0], [...rows.values()], repo)
}

export type Issue = { number: number, body: string | null }

let loginToken: string | undefined
export const forgetOperatorToken = () => { loginToken = undefined }

export async function operatorToken(getGhToken?: () => Promise<string | undefined>): Promise<string> {
  const token = await getGhToken?.() || process.env["GH_TOKEN"]?.trim() || process.env["OLA_AGENT_GH_TOKEN"]?.trim()
  if (token) return token
  if (loginToken) return loginToken
  try {
    const result = Bun.spawn(["gh", "auth", "token"], { env: process.env, stdout: "pipe", stderr: "ignore" })
    const token = (await new Response(result.stdout).text()).trim()
    if (await result.exited === 0 && token) return loginToken = token
  } catch { /* gh is absent or cannot be started. */ }
  throw new Error("tracker requires gh auth or GH_TOKEN")
}

export class GitHubClient {

  constructor(readonly repo: string, private token: string) {
    if (!/^(?!\.+\/)[\w.-]+\/(?!\.+$)[\w.-]+$/.test(repo)) throw new Error("invalid tracker repository")
  }

  private async request(path: string, method = "GET", data?: unknown): Promise<unknown> {
    let response: Response
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      response = await fetch(path === "graphql" ? "https://api.github.com/graphql" : `https://api.github.com/repos/${this.repo}/${path}`, {
        method,
        signal: controller.signal,
        headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" },
        body: data === undefined ? undefined : JSON.stringify(data),
      }).catch(() => { throw new Error(controller.signal.aborted ? "tracker GitHub request timed out" : "tracker GitHub request failed") })
      if (!response.ok) {
        if (response.status === 401) forgetOperatorToken()
        await response.body?.cancel()
        throw new Error(`tracker GitHub request failed (${response.status})`)
      }
      return response.status === 204 ? null : await response.json()
    } catch (error) {
      if (controller.signal.aborted) throw new Error("tracker GitHub request timed out")
      throw error
    } finally { clearTimeout(timeout) }
  }

  async languages(): Promise<Record<string, number>> {
    return await this.request("languages") as Record<string, number>
  }

  // REST issues?labels= sometimes returns [] for a repo that has labeled issues. GraphQL returned the
  // full list on every try. This is used by the legacy import.
  private async labeledIssues(): Promise<(Issue & { title: string })[]> {
    const result: (Issue & { title: string })[] = []
    let cursor: string | null = null
    for (;;) {
      const page: { issues: Connection<Issue & { title: string }> } = await this.graphql(
        `issues(first: 100, labels: ["security-patch"], orderBy: { field: CREATED_AT, direction: DESC }, after: ${JSON.stringify(cursor)}) {
          nodes { number title body }
          pageInfo { hasNextPage endCursor }
        }`)
      result.push(...page.issues.nodes)
      if (!page.issues.pageInfo.hasNextPage) return result
      cursor = page.issues.pageInfo.endCursor
    }
  }

  // The first issue of each bug type, with the bodies of its continuation issues.
  private async trackers(): Promise<(Issue & { title: string, category: string, more: string[] })[]> {
    const issues = (await this.labeledIssues()).flatMap(issue => {
      const match = TITLE.exec(issue.title)
      return match && CATEGORIES.includes(match[1]) ? [{ ...issue, category: match[1], page: Number(match[2] ?? 1) }] : []
    })
    const result: (Issue & { title: string, category: string, more: string[] })[] = []
    for (const issue of issues.filter(issue => issue.page === 1)) {
      // Two first issues for one type: associate continuation pages with the first.
      const pages = result.some(other => other.category === issue.category) ? []
        : issues.filter(other => other.category === issue.category && other.page > 1).sort((a, b) => a.page - b.page)
      result.push({ number: issue.number, title: issue.title, body: issue.body, category: issue.category, more: pages.map(page => page.body ?? "") })
    }
    return result
  }

  async legacyTrackingIssues(): Promise<(Issue & { category: string })[]> {
    return (await this.trackers()).map(({ number, body, category, more }) => ({
      number, category, body: more.length ? mergePages([body ?? "", ...more], category, this.repo) : body,
    }))
  }

  private get cacheKey(): string { return `${this.repo}:${this.token}` }

  private async graphql<T>(fields: string): Promise<T> {
    const [owner, name] = this.repo.split("/")
    const result = await this.request("graphql", "POST", {
      query: `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} } }`,
    }) as { data?: { repository: T | null }, errors?: unknown[] }
    if (result.errors?.length || !result.data?.repository) throw new Error("tracker GitHub GraphQL request failed")
    return result.data.repository
  }

  // Only GET Pick display may reuse the snapshot.
  async openPRs(onBatch?: (prs: OpenPR[], checkedPRs: number, totalPRs: number) => void, useCache = false): Promise<OpenPR[]> {
    if (!useCache) {
      const prs = await this.readOpenPRs()
      onBatch?.(prs, prs.length, prs.length)
      return prs
    }
    let cached = openPRCache.get(this.cacheKey)
    if (!cached || cached.expires <= Date.now()) {
      const value = this.readOpenPRs()
      cached = { expires: Date.now() + 60_000, value }
      openPRCache.set(this.cacheKey, cached)
      void value.catch(() => { if (openPRCache.get(this.cacheKey)?.value === value) openPRCache.delete(this.cacheKey) })
    }
    const prs = await cached.value
    onBatch?.(prs, prs.length, prs.length)
    return prs
  }

  private async readOpenPRs(): Promise<OpenPR[]> {
    const result: OpenPR[] = []
    let cursor: string | null = null
    const fileFields = "nodes { path changeType } pageInfo { hasNextPage endCursor }"
    for (;;) {
      const page: { pullRequests: Connection<{ number: number, headRefName: string, changedFiles: number, files: Connection<ChangedFile> }> } = await this.graphql(
        `pullRequests(first: 100, states: OPEN, after: ${JSON.stringify(cursor)}) {
          nodes { number headRefName changedFiles files(first: 100) { ${fileFields} } }
          pageInfo { hasNextPage endCursor }
        }`)
      const prs = page.pullRequests.nodes
      for (const pr of prs) {
        const files = pr.files.nodes.map(file => file.path)
        // REST lists at most 3000 files. A bigger PR reads its paths by GraphQL cursor, one page at a time.
        const huge = pr.changedFiles > 3000
        let renamed = pr.files.nodes.some(file => file.changeType === "RENAMED")
        for (let info = pr.files.pageInfo; huge && info.hasNextPage;) {
          const more = await this.graphql<{ pullRequest: { files: Connection<ChangedFile> } }>(
            `pullRequest(number: ${pr.number}) { files(first: 100, after: ${JSON.stringify(info.endCursor)}) { ${fileFields} } }`)
          files.push(...more.pullRequest.files.nodes.map(file => file.path))
          renamed ||= more.pullRequest.files.nodes.some(file => file.changeType === "RENAMED")
          info = more.pullRequest.files.pageInfo
        }
        // GraphQL has no previous path for renames. Keep both paths blocking.
        const firstPage = renamed ? 1 : huge ? 31 : 2
        const lastPage = pr.files.pageInfo.hasNextPage ? Math.min(30, Math.ceil(pr.changedFiles / 100)) : 1
        const previous: string[] = []
        for (let start = firstPage; start <= lastPage; start += 4) {
          const pages = await Promise.all(Array.from({ length: Math.min(4, lastPage - start + 1) }, async (_, i) => {
            const number = start + i
            const changed = await this.request(`pulls/${pr.number}/files?per_page=100&page=${number}`) as { filename: string, previous_filename?: string }[]
            return { number, changed }
          }))
          for (const { number, changed } of pages) {
            if (number > 1 && !huge) files.push(...changed.map(file => file.filename))
            previous.push(...changed.flatMap(file => file.previous_filename ? [file.previous_filename] : []))
          }
        }
        files.push(...previous)
        result.push({ number: pr.number, headRefName: pr.headRefName, files })
      }
      if (!page.pullRequests.pageInfo.hasNextPage) return result
      cursor = page.pullRequests.pageInfo.endCursor
    }
  }

  async openPRFiles(onBatch?: (files: string[], checkedPRs: number, totalPRs: number) => void): Promise<string[]> {
    const prs = await this.openPRs(onBatch ? (prs, checked, total) => onBatch(prs.flatMap(pr => pr.files), checked, total) : undefined)
    return prs.flatMap(pr => pr.files)
  }

  // Only branches the tool opens (batch_pr.ts): security/<category>-<subsystem>-<run id, 8 hex>.
  // Hand-made security/* branches are not suite PRs.
  static readonly SUITE_BRANCH = /^security\/.+-[0-9a-f]{8}$/

  async suitePRs(): Promise<{ number: number, title: string, draft: boolean, url: string }[]> {
    const result: { number: number, title: string, draft: boolean, url: string }[] = []
    for (let page = 1; ; page++) {
      const prs = await this.request(`pulls?state=open&per_page=100&page=${page}`) as { number: number, title: string, draft?: boolean, html_url: string, head: { ref: string } }[]
      result.push(...prs.filter(pr => GitHubClient.SUITE_BRANCH.test(pr.head.ref)).map(pr => ({ number: pr.number, title: pr.title, draft: !!pr.draft, url: pr.html_url })))
      if (prs.length < 100) return result
    }
  }

  async impactPRs(): Promise<ImpactPR[]> {
    const cached = impactCache.get(this.cacheKey)
    if (cached && cached.expires > Date.now()) return cached.value
    // GraphQL cursors force one page at a time. Numbered REST pages in creation order load in parallel.
    const value = (async () => {
      const result: ImpactPR[] = []
      for (let start = 1; ; start += IMPACT_PAGE_WAVE) {
        const pages = await Promise.all(Array.from({ length: IMPACT_PAGE_WAVE }, (_, i) =>
          this.request(`pulls?state=all&sort=created&direction=asc&per_page=100&page=${start + i}`) as Promise<{ number: number, title: string, html_url: string, state: string, merged_at: string | null, head: { ref: string, sha: string }, base: { sha: string } }[]>))
        for (const page of pages) result.push(...page.map(pr => ({ number: pr.number, title: pr.title, url: pr.html_url,
          state: pr.merged_at ? "merged" as const : pr.state === "open" ? "open" as const : "closed" as const, head: pr.head.sha, base: pr.base.sha, ref: pr.head.ref })))
        if (pages.some(page => page.length < 100)) return result
      }
    })()
    impactCache.set(this.cacheKey, { expires: Date.now() + 60_000, value })
    void value.catch(() => { if (impactCache.get(this.cacheKey)?.value === value) impactCache.delete(this.cacheKey) })
    return value
  }

  adoptionEvidence(prs: ImpactPR[], records: Record<string, PRRecord>, cacheDir: string) {
    return mergedEvidence(this.repo, this.token, prs, records, cacheDir)
  }

  async prState(number: number): Promise<"open" | "merged" | "closed"> {
    const pr = await this.request(`pulls/${number}`) as { state: string, merged_at: string | null }
    return pr.merged_at ? "merged" : pr.state === "open" ? "open" : "closed"
  }

  async prStates(numbers: number[]): Promise<Map<number, PRState>> {
    const result = new Map<number, PRState>()
    const unique = [...new Set(numbers)]
    for (let i = 0; i < unique.length; i += 100) {
      const batch = unique.slice(i, i + 100)
      if (batch.some(n => !Number.isSafeInteger(n) || n < 1)) throw new Error("invalid PR number")
      const prs = await this.graphql<Record<string, { state: string }>>(
        batch.map(n => `pr${n}: pullRequest(number: ${n}) { state }`).join("\n"))
      for (const n of batch) {
        const state = prs[`pr${n}`]?.state
        if (!["OPEN", "MERGED", "CLOSED"].includes(state)) throw new Error("tracker GitHub PR state missing")
        result.set(n, state.toLowerCase() as PRState)
      }
    }
    return result
  }

  async readPR(number: number): Promise<PRDetail> {
    if (!Number.isSafeInteger(number) || number < 1) throw new Error("invalid PR number")
    const pr = await this.request(`pulls/${number}`) as PRDetail
    if (!GitHubClient.SUITE_BRANCH.test(pr.head.ref)) throw new Error(`PR #${number} is not a suite PR`)
    const pages = async <T>(path: string, collection?: string): Promise<T[]> => {
      const rows: T[] = []
      for (let page = 1; ; page++) {
        const result = await this.request(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`)
        const batch = (collection ? (result as Record<string, T[]>)[collection] : result) as T[]
        rows.push(...batch)
        if (batch.length < 100 || (path === `pulls/${number}/files` && rows.length >= 3000)) return rows
      }
    }
    const sha = encodeURIComponent(pr.head.sha)
    const unavailable: PRDetail["unavailable"] = {}
    const read = async <T>(section: keyof PRDetail["unavailable"], promise: Promise<T[]>): Promise<T[]> => {
      try { return await promise }
      catch (error) { unavailable[section] = (error as Error).message; return [] }
    }
    const [files, checks, statuses, comments, reviews, reviewComments] = await Promise.all([
      read("files", pages<PRFile>(`pulls/${number}/files`)),
      read("checks", pages<PRCheck>(`commits/${sha}/check-runs?filter=latest`, "check_runs")),
      read("statuses", pages<PRStatus>(`commits/${sha}/status`, "statuses")),
      read("comments", pages<PRComment>(`issues/${number}/comments`)),
      read("reviews", pages<PRReview>(`pulls/${number}/reviews`)),
      read("reviewComments", pages<PRComment>(`pulls/${number}/comments`)),
    ])
    const current = await this.request(`pulls/${number}`) as PRDetail
    if (current.head.sha !== pr.head.sha || current.base.sha !== pr.base.sha) throw new Error("PR changed while loading. Refresh it.")
    const { title, body, state, draft, merged, html_url, user, updated_at, head, base, additions, deletions, changed_files } = current
    return { number, title, body, state, draft, merged, html_url, user, updated_at,
      head: { ref: head.ref, sha: head.sha }, base: { ref: base.ref, sha: base.sha },
      additions, deletions, changed_files, files, checks, statuses, comments, reviews, reviewComments, unavailable }
  }

  async suitePR(number: number): Promise<{ state: "open" | "closed", merged: boolean, ref: string, sameRepo: boolean }> {
    const pr = await this.request(`pulls/${number}`) as { state: "open" | "closed", merged_at: string | null, head: { ref: string, repo: { full_name: string } | null } }
    return { state: pr.state, merged: !!pr.merged_at, ref: pr.head.ref, sameRepo: pr.head.repo?.full_name === this.repo }
  }

  async commentPR(number: number, body: string): Promise<void> {
    await this.request(`issues/${number}/comments`, "POST", { body: scrub(body, [this.token])[0] })
  }

  async closePR(number: number): Promise<void> {
    await this.request(`pulls/${number}`, "PATCH", { state: "closed" })
    impactCache.delete(this.cacheKey)
    openPRCache.delete(this.cacheKey)
  }

  // Only suite branches. GitHub answers 422 when the branch is already gone.
  async deleteBranch(ref: string): Promise<void> {
    if (!GitHubClient.SUITE_BRANCH.test(ref)) throw new Error("refusing to delete a non-suite branch")
    try {
      await this.request(`git/refs/heads/${ref.split("/").map(encodeURIComponent).join("/")}`, "DELETE")
    } catch (error) {
      if (!(error instanceof Error) || !/\((404|422)\)$/.test(error.message)) throw error
    }
  }

  async createPR(pr: { head: string, base: string, title: string, body: string, draft: boolean }): Promise<number> {
    const result = await this.request("pulls", "POST", { ...pr, body: scrub(pr.body, [this.token])[0] }) as { number: number }
    impactCache.delete(this.cacheKey)
    openPRCache.delete(this.cacheKey)
    return result.number
  }

  async listComments(number: number): Promise<string[]> {
    const comments: string[] = []
    for (let page = 1; ; page++) {
      const batch = await this.request(`issues/${number}/comments?per_page=100&page=${page}`) as { body: string }[]
      comments.push(...batch.map(comment => comment.body))
      if (batch.length < 100) return comments
    }
  }

}
