import { lstat, readFile, readdir, realpath } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { githubRepo } from "../tracker/repos.ts"
import { scrub } from "../tracker/scrub.ts"
import { TARGETS_DIR } from "../orchestrator/vendor.ts"

// shortcut: Include files up to 16 KiB within 64K JSON characters, add retrieval when this drops needed context.
const MAX_CONTEXT_CHARS = 64 * 1024
const MAX_FILE_BYTES = 16 * 1024

const WORKSPACE_ROOT = () => process.env.OLA_AGENT_CONTEXT_ROOT || fileURLToPath(new URL("../../../../..", import.meta.url))

export interface RunInput {
  path: string
  source: "repo" | "workspace" | "human" | "suite"
  size: number
  reason?: "file-too-large" | "context-budget" | "symlink"
}

export async function loadRepoContext(
  repoUrl: string,
  root = WORKSPACE_ROOT(),
  note?: string,
  inputs: RunInput[] = [],
): Promise<{ path: string, content: string }[]> {
  const documents: { path: string, content: string }[] = []
  const secrets = Object.entries(process.env)
    .filter(([key, value]) => value && /TOKEN|PASSWORD|SECRET|API_KEY/.test(key))
    .map(([, value]) => value!)
  if (note?.trim()) {
    documents.push({ path: "operator-note.md", content: scrub(note.trim(), secrets)[0] })
    inputs.push({ path: "operator-note.md", source: "human", size: Buffer.byteLength(note.trim()) })
  }
  try {
    root = await realpath(root)
    // workspace.yaml marks a workspace root. Without it there is no workspace context.
    await lstat(join(root, "workspace.yaml"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[repo-context] workspace root unavailable")
    return documents
  }
  const repo = await mountedRepoId(root, githubRepo(repoUrl))
  let chars = JSON.stringify(documents).length
  async function collect(path: string): Promise<void> {
    const absolute = join(root, path)
    try {
      const info = await lstat(absolute)
      const input: RunInput = { path: scrub(path, secrets)[0], source: "workspace", size: info.size }
      // Reject symlinks, including parent directories, before reading reference content.
      if (info.isSymbolicLink() || await realpath(absolute) !== absolute) {
        inputs.push({ ...input, reason: "symlink" })
        return
      }
      if (info.isDirectory()) {
        const entries = await readdir(absolute, { withFileTypes: true })
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (!entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink() || (entry.isFile() && entry.name.endsWith(".md")))) {
            await collect(join(path, entry.name))
          }
        }
      } else if (info.isFile() && path.endsWith(".md")) {
        if (info.size > MAX_FILE_BYTES) {
          inputs.push({ ...input, reason: "file-too-large" })
          return
        }
        const content = scrub(await readFile(absolute, "utf8"), secrets)[0]
        const document = { path, content }
        const size = JSON.stringify(document).length + 1
        if (chars + size <= MAX_CONTEXT_CHARS) {
          documents.push(document)
          inputs.push(input)
          chars += size
        } else {
          inputs.push({ ...input, reason: "context-budget" })
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[repo-context] context source unavailable: ${path}`)
    }
  }

  await collect("agent-instructions/security-defaults.md")
  await collect("team-context/security-defaults.team.md")
  if (repo) {
    await collect(`team-context/mounted-repos/${repo}.md`)
    for (const category of ["maps", "bug-fixes"]) {
      await collect(`knowledge/${category}/${repo}.md`)
      await collect(`knowledge/${category}/${repo}`)
    }
  }
  return documents
}

// The id of the repo mounted in workspace.local.yaml whose origin is the run's repo. Reads the mount's
// .git/config as a file (no includes, no git hooks), so a mount that is a worktree or has no origin never matches.
async function mountedRepoId(root: string, target: string | undefined): Promise<string | undefined> {
  if (!target) return
  for (const mount of await workspaceMounts(root)) {
    const git = Bun.spawn(["git", "config", "--file", join(mount.dir, ".git", "config"), "--get", "remote.origin.url"], { stdout: "pipe", stderr: "ignore" })
    const origin = (await new Response(git.stdout).text()).trim()
    if (await git.exited === 0 && githubRepo(origin) === target) return mount.id
  }
}

const MOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// The repos mounted in workspace.local.yaml, each inside the workspace root.
async function workspaceMounts(root: string): Promise<{ id: string, dir: string }[]> {
  let mounts: unknown
  try {
    mounts = (Bun.YAML.parse(await readFile(join(root, "workspace.local.yaml"), "utf8")) as { repositories?: unknown } | null)?.repositories
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[repo-context] workspace.local.yaml unreadable")
    return []
  }
  if (!Array.isArray(mounts)) return []
  return (mounts as { id?: unknown, path?: unknown }[]).flatMap(mount => {
    if (typeof mount?.id !== "string" || !MOUNT_ID.test(mount.id) || typeof mount.path !== "string") return []
    const dir = join(root, mount.path)
    return dir.startsWith(`${root}/`) ? [{ id: mount.id, dir }] : []
  })
}

// Mount IDs a human lists under "## Related repos" in the repo notes file, as "- <id>" lines.
// Tool blocks come from the scanned repo, so a heading inside one never counts.
export function relatedRepoIds(notes: string): string[] {
  const human = notes.replace(/<!-- security-patch:([a-z-]+) -->[\s\S]*?<!-- \/security-patch:\1 -->/g, "")
  const ids: string[] = []
  let inSection = false
  for (const line of human.split("\n")) {
    if (/^#{1,6}\s/.test(line)) { inSection = /^##\s+Related repos\s*$/i.test(line); continue }
    const id = inSection ? /^\s*[-*]\s+`?([^`\s]+)`?\s*$/.exec(line)?.[1] : undefined
    if (id && MOUNT_ID.test(id) && !ids.includes(id)) ids.push(id)
  }
  return ids
}

// Host folders of the related repos, for read-only caller search (SKILL §0.6). Unknown or missing mounts are skipped.
export async function relatedRepoDirs(repoUrl: string, root = WORKSPACE_ROOT(), targetsDir = TARGETS_DIR): Promise<{ id: string, dir: string }[]> {
  const repo = githubRepo(repoUrl)
  if (!repo) return []
  let notes: string
  try { notes = await readFile(join(targetsDir, repo.replace("/", "__") + ".md"), "utf8") }
  catch { return [] }
  const ids = relatedRepoIds(notes)
  if (!ids.length) return []
  try { root = await realpath(root) } catch { return [] }
  const self = await mountedRepoId(root, repo)
  const mounts = await workspaceMounts(root)
  const dirs: { id: string, dir: string }[] = []
  for (const id of ids) {
    const mount = mounts.find(mount => mount.id === id)
    if (!mount || id === self) continue
    try { if ((await lstat(mount.dir)).isDirectory() && await realpath(mount.dir) === mount.dir) dirs.push(mount) }
    catch { /* not checked out on this machine */ }
  }
  return dirs
}
