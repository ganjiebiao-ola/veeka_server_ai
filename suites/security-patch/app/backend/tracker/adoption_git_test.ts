import { test, expect, spyOn } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mergedEvidence, classifyAdoption } from "./adoption.ts"

test("base merge and rebase remain full, owner edits are partial, merged evidence is permanent", async () => {
  const root = await mkdtemp(join(tmpdir(), "adoption-git-")), repo = join(root, "repo"), cache = join(root, "cache")
  await mkdir(repo)
  const git = (...args: string[]) => {
    const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
    if (p.exitCode) throw new Error(p.stderr.toString())
    return p.stdout.toString().trim()
  }
  const originalSpawn = Bun.spawn
  let fetches = 0
  try {
    git("init", "-q", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.test")
    await writeFile(join(repo, "fix.php"), "before\n"); git("add", "."); git("commit", "-qm", "base")
    git("checkout", "-qb", "fix")
    await writeFile(join(repo, "fix.php"), "after\n"); git("commit", "-qam", "fix")
    const pushedSha = git("rev-parse", "HEAD")
    git("checkout", "-q", "main")
    await writeFile(join(repo, "other.php"), "base update\n"); git("add", "."); git("commit", "-qm", "base update")
    const base = git("rev-parse", "HEAD")
    git("checkout", "-q", "fix"); git("merge", "--no-ff", "-qm", "Update branch", "main")
    const mergedHead = git("rev-parse", "HEAD")
    git("checkout", "-qb", "rebased", pushedSha); git("rebase", "main")
    const rebaseHead = git("rev-parse", "HEAD")
    await writeFile(join(repo, "fix.php"), "owner edit\n"); git("commit", "-qam", "edit")
    const editedHead = git("rev-parse", "HEAD")
    Bun.spawn = ((cmd: string[], options: any) => {
      const args = cmd.map(arg => arg === "https://github.com/a/b.git" ? repo : arg)
      if (args.includes("fetch")) fetches++
      return originalSpawn(args, options)
    }) as typeof Bun.spawn
    const prs = [mergedHead, rebaseHead, editedHead].map((head, i) => ({ number: i + 1, state: "merged" as const, head, base, title: "Fix", url: "", ref: "" }))
    const records = Object.fromEntries(prs.map(pr => [pr.number, { pushedSha }]))
    const evidence = await mergedEvidence("a/b", "", prs, records, cache)
    expect(prs.map(pr => classifyAdoption(pr, records[pr.number], evidence.get(pr.number)))).toEqual(["full", "full", "partial"])
    expect(fetches).toBe(1)
    expect([...(await mergedEvidence("a/b", "", prs, records, cache))]).toEqual([...evidence])
    expect(fetches).toBe(1)
  } finally { Bun.spawn = originalSpawn; await rm(root, { recursive: true, force: true }) }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "adoption-fail-")), repo = join(root, "repo")
  await mkdir(repo)
  const git = (...args: string[]) => {
    const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
    if (p.exitCode) throw new Error(p.stderr.toString())
    return p.stdout.toString().trim()
  }
  git("init", "-q", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.test")
  await writeFile(join(repo, "fix.php"), "before\n"); git("add", "."); git("commit", "-qm", "base")
  const base = git("rev-parse", "HEAD")
  await writeFile(join(repo, "fix.php"), "after\n"); git("commit", "-qam", "fix")
  const head = git("rev-parse", "HEAD")
  const originalSpawn = Bun.spawn
  const calls: { args: string[], timeout?: number }[] = []
  const hook = (rewrite?: (args: string[], options: any) => string[]) => {
    Bun.spawn = ((cmd: string[], options: any) => {
      const args = cmd.map(arg => arg === "https://github.com/a/b.git" ? repo : arg)
      calls.push({ args, timeout: options.timeout })
      return originalSpawn(rewrite && args.includes("fetch") ? rewrite(args, options) : args, options)
    }) as typeof Bun.spawn
  }
  const fetches = () => calls.filter(call => call.args.includes("fetch")).length
  const merged = (number: number) => ({ number, state: "merged" as const, head, base, title: "Fix", url: "", ref: "" })
  const cleanup = async () => { Bun.spawn = originalSpawn; await rm(root, { recursive: true, force: true }) }
  return { root, base, head, hook, fetches, calls, merged, cleanup, cache: join(root, "cache") }
}

test("a hung git call is killed at its timeout and the PR stays unknown", async () => {
  const f = await fixture()
  try {
    f.hook((_, options) => { options.timeout = 100; return ["sleep", "5"] })
    const started = Date.now()
    const records = { 101: { pushedSha: f.head } }
    const evidence = await mergedEvidence("a/b", "", [f.merged(101)], records, f.cache)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(evidence.size).toBe(0)
    expect(f.fetches()).toBe(1)
    expect(f.calls.every(call => call.timeout! > 0)).toBe(true)
  } finally { await f.cleanup() }
})

test("a failure is cached for ten minutes instead of refetching on every load", async () => {
  const f = await fixture()
  const now = spyOn(Date, "now")
  try {
    f.hook()
    const records = { 102: { pushedSha: "c".repeat(40) } }
    const prs = [f.merged(102)]
    expect((await mergedEvidence("a/b", "", prs, records, f.cache)).size).toBe(0)
    const first = f.fetches()
    expect(first).toBeGreaterThan(0)
    await mergedEvidence("a/b", "", prs, records, f.cache)
    expect(f.fetches()).toBe(first)
    const later = Date.now() + 11 * 60_000
    now.mockImplementation(() => later)
    await mergedEvidence("a/b", "", prs, records, f.cache)
    expect(f.fetches()).toBeGreaterThan(first)
  } finally { now.mockRestore(); await f.cleanup() }
})

test("one unfetchable commit leaves the other merged PRs classified", async () => {
  const f = await fixture()
  try {
    f.hook()
    const records = { 103: { pushedSha: f.head }, 104: { pushedSha: "d".repeat(40) } }
    const prs = [f.merged(103), f.merged(104)]
    const evidence = await mergedEvidence("a/b", "", prs, records, f.cache)
    expect(classifyAdoption(prs[0], records[103], evidence.get(103))).toBe("full")
    expect(classifyAdoption(prs[1], records[104], evidence.get(104))).toBe("unknown")
  } finally { await f.cleanup() }
})

test("concurrent evidence requests for one repo share a single fetch", async () => {
  const f = await fixture()
  try {
    f.hook()
    const records = { 105: { pushedSha: f.head } }
    const prs = [f.merged(105)]
    const [a, b] = await Promise.all([mergedEvidence("a/b", "", prs, records, f.cache), mergedEvidence("a/b", "", prs, records, f.cache)])
    expect(b).toBe(a)
    expect(f.fetches()).toBe(1)
    await rm(f.cache, { recursive: true, force: true })
    await mergedEvidence("a/b", "", prs, records, f.cache)
    expect(f.fetches()).toBe(2)
  } finally { await f.cleanup() }
})
