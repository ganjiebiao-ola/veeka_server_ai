import { agentEnv, agentSpawnSync } from "./agent-user.mjs"
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { runAsAgent } from "./agent-fs.mjs"
import { dirname, join, relative, resolve, sep } from "node:path"

import { tmpdir } from "node:os"

export function findVendorTrees(repoDir) {
  if (process.getuid?.() === 0) return runAsAgent(import.meta.url, "findVendorTrees", [repoDir])
  const root = realpathSync(repoDir)
  const trees = new Set()
  const tracked = agentSpawnSync("git", ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "ls-files", "-z"], {
    cwd: root, env: agentEnv(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30000,
  })
  if (tracked.error || tracked.status !== 0) throw new Error("Vendor discovery: git ls-files failed")
  for (const file of tracked.stdout.split("\0").filter(Boolean)) {
    const parts = file.split("/")
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i] === ".git") break
      const path = parts.slice(0, i + 1).join("/")
      try { if (!lstatSync(join(root, path)).isDirectory()) break }
      catch (error) { if (error.code !== "ENOENT") throw error }
      if (parts[i] === "vendor") trees.add(path)
    }
  }
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.isSymbolicLink() || !entry.isDirectory()) continue
      const path = join(dir, entry.name)
      if (entry.name === "vendor") trees.add(relative(root, path).split(sep).join("/"))
      walk(path)
    }
  }
  walk(root)
  return [...trees].sort()
}

export function vendorTreeForPath(path, repoDir, trees) {
  const root = resolve(repoDir)
  const file = relative(root, resolve(root, path)).split(sep).join("/")
  return trees.filter(tree => file.startsWith(tree + "/")).sort((a, b) => b.length - a.length)[0]
}

export function readVendorSnippets(repoDir, hits) {
  if (!hits.length) return []
  if (process.getuid?.() === 0) return runAsAgent(import.meta.url, "readVendorSnippets", [repoDir, hits])
  const root = realpathSync(repoDir)
  const sources = new Map()
  return hits.map(hit => {
    try {
      if (!sources.has(hit.path)) {
        const source = realpathSync(resolve(root, hit.path))
        if (!source.startsWith(root + sep)) throw new Error("Path outside repository")
        sources.set(hit.path, readFileSync(source, "utf8").split(/\r?\n/))
      }
      return sources.get(hit.path)[hit.start.line - 1]?.trim() ?? ""
    } catch { return null }
  })
}

const gitArgs = ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null"]
const packageName = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i
// Caps keep vendor.json under the backend's 5 MB artifact limit and bound the audit's run time.
const MAX_PACKAGES = 2000
const MAX_MISMATCHES = 50
const AUDIT_BUDGET_MS = 300000

function readContained(root, path) {
  const actual = realpathSync(path)
  if (!actual.startsWith(root + sep)) throw new Error("File outside repository")
  const stat = statSync(actual)
  if (!stat.isFile() || stat.size > 5 * 1024 * 1024) throw new Error("Invalid metadata file")
  return readFileSync(actual, "utf8")
}

function present(path) {
  try { lstatSync(path); return true }
  catch (error) { if (error.code === "ENOENT") return false; throw error }
}

function packagesFrom(data, source) {
  const packages = Array.isArray(data) && source === "installed.json" ? data
    : [...data.packages, ...(source === "composer.lock" ? data["packages-dev"] ?? [] : [])]
  const names = new Set()
  if (!packages.every(pkg => pkg && typeof pkg.name === "string" && packageName.test(pkg.name) &&
    typeof pkg.version === "string" && pkg.version.length > 0 && pkg.version.length <= 256 &&
    !/[\s\x00-\x1f]/.test(pkg.version) && !names.has(pkg.name) && names.add(pkg.name))) throw new Error("Invalid packages")
  if (packages.length > MAX_PACKAGES) throw new Error("Too many packages")
  return packages.map(({ name, version }) => ({ name, version }))
}

export function discoverVendors(repoDir, run = agentSpawnSync) {
  if (process.getuid?.() === 0 && run === agentSpawnSync) return runAsAgent(import.meta.url, "discoverVendors", [repoDir])
  const root = realpathSync(repoDir)
  const errors = []
  let paths = []
  try { paths = findVendorTrees(root) }
  catch { errors.push("vendor-discovery: tree enumeration failed") }
  const tracked = run("git", [...gitArgs, "ls-files", "-z"], {
    cwd: root, env: agentEnv(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30000,
  })
  const trackingKnown = !tracked.error && tracked.status === 0
  if (!trackingKnown) errors.push("vendor-discovery: git tracking unavailable")
  const files = trackingKnown ? tracked.stdout.split("\0").filter(Boolean) : []
  const commands = []
  const unreadable = []
  const scripts = files.filter(file => !file.split("/").includes("vendor") &&
    /(?:^|\/)(?:composer\.json|package\.json|Dockerfile[^/]*|Makefile|Jenkinsfile|\.gitlab-ci[^/]*|[^/]+\.(?:sh|bash|zsh|ps1))$|^\.github\/workflows\//.test(file))
  for (const file of scripts) {
    try {
      for (const [index, line] of readContained(root, join(root, file)).split(/\r?\n/).entries()) {
        if (/^\s*(?:#|\/\/)/.test(line)) continue
        if (/\bcomposer(?:\.phar)?\s+[^\r\n]*\b(?:install|update)\b/.test(line)) commands.push({ file, line: index + 1, text: line })
      }
    } catch { unreadable.push(file) }
  }
  const trees = paths.map(path => {
    const trackedTree = files.some(file => file.startsWith(path + "/"))
    const evidence = [trackingKnown ? `git ls-files: ${trackedTree ? "tracked" : "untracked"} vendor files` : "git tracking unavailable",
      `Checked ${scripts.length} tracked install scripts and CI files`]
    const parent = dirname(path)
    const installs = []
    const ambiguous = []
    for (const command of commands) {
      // Read -d only after the composer word, so PHP's own `php -d memory_limit=-1` is not taken as a folder.
      const afterComposer = command.text.slice(command.text.search(/\bcomposer(?:\.phar)?\b/))
      const working = /(?:--working-dir|\s-d)(?:=|\s+)['"]?([^\s'";&\\]+)/.exec(afterComposer)?.[1]
        ?? /\bcd\s+['"]?([^\s'";&\\]+)['"]?\s*&&\s*(?:php\s+)?composer/.exec(command.text)?.[1]
      // Script contents are evidence only. Never execute them or infer a variable's value.
      const target = working && !/[$`{}]/.test(working) ? relative(root, resolve(root, working)) || "." : undefined
      if (target === parent) installs.push(`${command.file}:${command.line}: Composer install/update targets ${parent}`)
      else if (!target) ambiguous.push(`${command.file}:${command.line}: Composer install/update has uncertain working directory`)
    }
    evidence.push(...installs, ...ambiguous, ...unreadable.map(file => `${file}: install evidence unreadable`))
    const mode = installs.length ? "reinstalled" : ambiguous.length || unreadable.length || !trackingKnown ? "unknown"
      : trackedTree ? "committed" : "unknown"
    if (!installs.length && !ambiguous.length) evidence.push("No matching Composer install/update command found")
    if (mode === "unknown") errors.push(`vendor-install-mode-unknown: ${path}`)
    const tree = { path, mode, evidence, lock: "missing", metadataSource: "none", packages: [], mismatches: [], audit: "not run" }
    const installed = join(root, path, "composer/installed.json")
    const lock = join(root, parent, "composer.lock")
    let hasInstalled = false
    let locked
    try { hasInstalled = present(installed) }
    catch { hasInstalled = true }
    if (hasInstalled) {
      tree.metadataSource = "installed.json"
      try { tree.packages = packagesFrom(JSON.parse(readContained(root, installed)), "installed.json") }
      catch { errors.push(`vendor-metadata-invalid: installed.json for ${path}`) }
    }
    try {
      if (present(lock)) {
        tree.lock = "invalid"
        locked = packagesFrom(JSON.parse(readContained(root, lock)), "composer.lock")
        tree.lock = "present"
        if (!hasInstalled) { tree.metadataSource = "composer.lock"; tree.packages = locked }
      }
    } catch { tree.lock = "invalid"; errors.push(`vendor-metadata-invalid: composer.lock for ${path}`) }
    if (hasInstalled && locked) {
      const versions = new Map(locked.map(pkg => [pkg.name, pkg.version]))
      for (const pkg of tree.packages) {
        const version = versions.get(pkg.name) ?? null
        if (version !== pkg.version) tree.mismatches.push({ package: pkg.name, installed: pkg.version, locked: version })
      }
      for (const mismatch of tree.mismatches.slice(0, MAX_MISMATCHES)) {
        errors.push(`vendor-version-mismatch: ${path}, ${mismatch.package}: installed ${mismatch.installed}, locked ${mismatch.locked ?? "absent"}. Using installed version`)
      }
      if (tree.mismatches.length > MAX_MISMATCHES) {
        errors.push(`vendor-version-mismatch: ${path}: ${tree.mismatches.length - MAX_MISMATCHES} more mismatches`)
        tree.mismatches = tree.mismatches.slice(0, MAX_MISMATCHES)
      }
    }
    if (tree.metadataSource === "none") errors.push(`vendor-metadata-missing: ${path}`)
    return tree
  })
  return { trees, errors }
}

export function auditVendors(repoDir, run = agentSpawnSync, now = Date.now) {
  if (process.getuid?.() === 0 && run === agentSpawnSync) return runAsAgent(import.meta.url, "auditVendors", [repoDir])
  const { trees, errors } = discoverVendors(repoDir, run)
  const advisories = new Map()
  const deadline = now() + AUDIT_BUDGET_MS
  for (const tree of trees) {
    if (!tree.packages.length) {
      tree.audit = "skipped"
      if (tree.metadataSource === "none") errors.push(`composer-metadata-missing: ${tree.path}`)
      continue
    }
    if (now() > deadline) {
      tree.audit = "skipped"
      errors.push(`composer-budget-exceeded: ${tree.path}`)
      continue
    }
    let project
    let failure = "composer-process-or-network"
    try {
      // Isolate untrusted scripts, plugins, repositories, and audit ignore settings.
      project = mkdtempSync(join(tmpdir(), "security-patch-audit-"))
      writeFileSync(join(project, "composer.json"), JSON.stringify({ name: "security-patch/audit", config: { "allow-plugins": false } }))
      writeFileSync(join(project, "composer.lock"), JSON.stringify({ packages: tree.packages, "packages-dev": [] }))
      const result = run("composer", ["--no-plugins", "--no-scripts", "--no-interaction", "audit", "--locked", "--format=json", "--abandoned=ignore"], {
        cwd: project, encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024,
        env: { ...agentEnv({ PATH: process.env.PATH }), HOME: project, COMPOSER: "composer.json", COMPOSER_HOME: project,
          COMPOSER_CACHE_DIR: join(project, "cache"), COMPOSER_NO_INTERACTION: "1" },
      })
      if (result.error || ![0, 1].includes(result.status)) {
        if (result.error?.code === "ENOENT") failure = "composer-missing"
        if (result.error?.code === "ETIMEDOUT") failure = "composer-timeout"
        throw new Error("Composer failed")
      }
      failure = result.status === 0 ? "composer-invalid-response" : "composer-process-or-network"
      const report = JSON.parse(result.stdout)
      if (!report.advisories || typeof report.advisories !== "object") throw new Error("Invalid audit report")
      const found = []
      for (const [name, rows] of Object.entries(report.advisories)) {
        if (!rows || typeof rows !== "object") throw new Error("Invalid advisory list")
        for (const row of Object.values(rows)) {
          if (!row || typeof row.advisoryId !== "string" || !row.advisoryId || typeof row.title !== "string" || !row.title ||
            ![row.cve, row.severity, row.link].every(value => value == null || typeof value === "string")) throw new Error("Invalid advisory")
          const pkg = tree.packages.find(pkg => pkg.name === name)
          if (!pkg) throw new Error("Advisory for unknown package")
          found.push({ package: name, version: pkg.version,
            trees: trees.filter(copy => copy.packages.some(other => other.name === name && other.version === pkg.version)).map(copy => copy.path),
            advisoryId: row.advisoryId, cve: row.cve ?? null, title: row.title, severity: row.severity ?? null, link: row.link ?? null })
        }
      }
      if (result.status === 1 && !found.length) throw new Error("Failed audit without advisories")
      for (const row of found) advisories.set(JSON.stringify([row.package, row.version, row.advisoryId]), row)
      tree.audit = "completed"
    } catch {
      tree.audit = "failed"
      errors.push(`${failure}: ${tree.path}`)
    } finally { if (project) rmSync(project, { recursive: true, force: true }) }
  }
  return { trees, advisories: [...advisories.values()], errors }
}
