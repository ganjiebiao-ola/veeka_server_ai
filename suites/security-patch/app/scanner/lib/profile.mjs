import { agentEnv, agentSpawnSync } from "./agent-user.mjs"
import { readdirSync, readFileSync } from "node:fs"
import { runAsAgent } from "./agent-fs.mjs"
import { join, relative, sep } from "node:path"

// A framework is found by its composer package, or else by the file count of a code marker.
const FRAMEWORKS = [
  ["phalcon", /^(phalcon\/|ext-phalcon$)/, /\bPhalcon\\(Mvc|Di|Db)\\/],
  ["laravel", /^laravel\/framework$/, /\bIlluminate\\Foundation\\/],
  ["symfony", /^symfony\/framework-bundle$/, /\bSymfony\\Component\\HttpKernel\\/],
  ["thinkphp", /^topthink\/framework$/, /\bthink\\App\b/],
  ["yii", /^yiisoft\/yii2$/, /\bYii::\$app\b/],
]
// Exact PHP versions in build, CI and deploy files: php:7.2-fpm images, php7.2-fpm packages, setup-php php-version.
const CONFIG = /(^|\/)(Dockerfile[^/]*|[^/]+\.(ya?ml|sh|conf|ini))$/i
const VERSION = /\bphp:(\d+\.\d+)|\bphp(\d+\.\d+)(?![\d.])|php-version['"]?\s*[:=]\s*['"]?(\d+\.\d+)/gi
const MAX_FILE_BYTES = 256 * 1024
// ponytail: the framework marker search reads at most 2000 PHP files. Sample by directory if repos outgrow it.
const MAX_CODE_FILES = 2000

const read = (repoDir, file) => {
  try {
    const text = readFileSync(join(repoDir, file), "utf8")
    return text.length > MAX_FILE_BYTES ? "" : text
  } catch { return "" }
}

// Tracked files outside vendor trees. A folder that is not a git checkout is walked instead.
// asAgent false is for a folder the caller extracted itself on a host with no agent user (the backend image).
export function repoFiles(repoDir, asAgent = true) {
  if (asAgent && process.getuid?.() === 0) return runAsAgent(import.meta.url, "repoFiles", [repoDir])
  const git = asAgent && agentSpawnSync("git", ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "ls-files", "-z"], {
    cwd: repoDir, env: agentEnv(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30000,
  })
  let files
  if (git && !git.error && git.status === 0) files = git.stdout.split("\0").filter(Boolean)
  else {
    files = []
    const walk = dir => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === ".git" || entry.isSymbolicLink()) continue
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (entry.isFile()) files.push(relative(repoDir, path).split(sep).join("/"))
      }
    }
    walk(repoDir)
  }
  return files.filter(file => !file.split("/").some(part => part === "vendor" || part === "node_modules"))
}

const lowest = constraint => (constraint.match(/\d+\.\d+/g) ?? []).sort(compare)[0] ?? ""

// The repo's language, PHP version and framework, each with the files that show it.
// Sources that disagree leave the value empty, so the operator chooses.
export function detectProfile(repoDir, asAgent = true) {
  if (asAgent && process.getuid?.() === 0) return runAsAgent(import.meta.url, "detectProfile", [repoDir])
  const files = repoFiles(repoDir, asAgent)
  const sources = []
  const add = (field, value, file) => {
    if (!sources.some(s => s.field === field && s.value === value && s.file === file)) sources.push({ field, value, file })
  }
  let composer = {}
  if (files.includes("composer.json")) {
    try { composer = JSON.parse(read(repoDir, "composer.json")) ?? {} } catch { composer = {} }
  }
  const php = files.some(file => file.endsWith(".php"))
  if (!php && !files.includes("composer.json")) return { language: "", php: "", framework: "", sources }

  const platform = composer.config?.platform?.php
  if (typeof platform === "string" && /^\d+\.\d+/.test(platform)) add("php", platform.match(/^\d+\.\d+/)[0], "composer.json")
  if (files.includes(".php-version")) {
    const pinned = read(repoDir, ".php-version").match(/^\s*(\d+\.\d+)/)
    if (pinned) add("php", pinned[1], ".php-version")
  }
  for (const file of files.filter(file => CONFIG.test(file))) {
    for (const match of read(repoDir, file).matchAll(VERSION)) add("php", match[1] ?? match[2] ?? match[3], file)
  }
  const require = { ...composer.require, ...composer["require-dev"] }
  if (!sources.length && typeof require.php === "string" && lowest(require.php)) add("php", lowest(require.php), "composer.json")
  const versions = [...new Set(sources.map(s => s.value))]

  let framework = FRAMEWORKS.find(([, pkg]) => Object.keys(require).some(name => pkg.test(name)))?.[0] ?? ""
  if (framework) add("framework", framework, "composer.json")
  else {
    const counts = new Map()
    for (const file of files.filter(file => file.endsWith(".php")).slice(0, MAX_CODE_FILES)) {
      const text = read(repoDir, file)
      for (const [name, , marker] of FRAMEWORKS) {
        if (!marker.test(text)) continue
        counts.set(name, (counts.get(name) ?? 0) + 1)
        if (counts.get(name) === 1) add("framework", name, file)
      }
    }
    framework = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ""
  }
  return { language: "php", php: versions.length === 1 ? versions[0] : "", framework, sources }
}

// Operator values from the Scan page win over detection.
export function applyOverride(profile, raw) {
  let override
  try { override = JSON.parse(raw || "{}") } catch { return profile }
  const php = typeof override?.php === "string" && /^\d+\.\d+$/.test(override.php) ? override.php : ""
  const framework = typeof override?.framework === "string" && /^[a-z0-9-]{1,30}$/.test(override.framework) ? override.framework : ""
  if (!php && !framework) return profile
  return { ...profile, php: php || profile.php, framework: framework || profile.framework, override: { php, framework } }
}

function compare(a, b) {
  const [x, y] = [a, b].map(v => v.split(".").map(Number))
  return (x[0] - y[0]) || ((x[1] ?? 0) - (y[1] ?? 0))
}

// "any", or space-separated bounds such as ">=7.0 <8".
export function phpMatches(range, version) {
  if (range === "any" || !version) return true
  return range.split(/\s+/).every(bound => {
    const [, op = "=", value] = bound.match(/^(<=|>=|<|>|=)?(\d+(?:\.\d+)?)$/) ?? []
    if (!value) throw new Error(`invalid PHP range: ${range}`)
    const d = compare(version, value)
    return { "<": d < 0, "<=": d <= 0, ">": d > 0, ">=": d >= 0, "=": d === 0 }[op]
  })
}

// An unknown version or framework matches every type.
export function applies(rule, profile) {
  const { php = "any", framework = "any" } = rule ?? {}
  if (framework !== "any" && profile.framework && profile.framework !== framework) return false
  return phpMatches(php, profile.php)
}

export const appliesLine = ({ php = "any", framework = "any" } = {}) => `Applies to: PHP ${php} · framework ${framework}`

// The categories= value for a scan: the selected types (empty = all) that apply to the profile.
// Returns the selection unchanged when nothing drops, and null when nothing is left.
export function scanCategories(selected, profile, rules) {
  const wanted = selected ? selected.split(",") : Object.keys(rules)
  const kept = wanted.filter(category => applies(rules[category], profile))
  if (!kept.length) return null
  return kept.length === wanted.length ? selected : kept.join(",")
}
