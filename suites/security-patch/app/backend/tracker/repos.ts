// Repos Pick and Overview can work on come from runs started by the operator, newest first.

let knownRepos: () => string[] = () => []
export function setKnownRepos(list: () => string[]) { knownRepos = list }

// "owner/repo" from a URL, an SSH remote or a bare slug. Lower case, so comparisons ignore case.
export function githubRepo(value: string): string | undefined {
  const match = /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(value.trim())
  return match && !/^\.+$/.test(match[1]) && !/^\.+$/.test(match[2]) ? `${match[1]}/${match[2]}`.toLowerCase() : undefined
}

// The first entry is the default.
export function trackerRepos(): string[] {
  const seen = new Set<string>()
  return knownRepos().filter((repo) => {
    const key = githubRepo(repo)!
    return !seen.has(key) && seen.add(key)
  })
}

// Resolve the repo a request names. No name means the default. An unlisted name throws.
export function resolveTracker(requested?: string | null): string {
  const repos = trackerRepos()
  if (!repos.length) throw new Error("no repo yet: start a scan on a GitHub repo first")
  if (!requested) return repos[0]
  const hit = repos.find(repo => githubRepo(repo) === githubRepo(requested))
  if (!hit) throw new Error(`not a configured tracker repository: ${requested}`)
  return hit
}

// The tracker a repo URL points at, if any.
export function trackerForUrl(repoUrl: string): string | undefined {
  const repo = githubRepo(repoUrl)
  return repo ? trackerRepos().find(tracker => githubRepo(tracker) === repo) : undefined
}
