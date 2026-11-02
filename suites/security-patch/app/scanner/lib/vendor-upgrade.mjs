import { spawnSync } from "node:child_process"
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { discoverVendors } from "./vendor.mjs"

const json = path => JSON.parse(readFileSync(path, "utf8"))
const blocked = error => ({ result: "blocked", blocker: String(error.message ?? error).trim().slice(0, 500) })
const packageName = /^[a-z0-9]([_.-]?[a-z0-9]+)*\/[a-z0-9](([_.]?|-{0,2})[a-z0-9]+)*$/
const packages = lock => [...lock.packages, ...(lock["packages-dev"] ?? [])]

function contained(root, path) {
  root = realpathSync(root)
  const full = realpathSync(resolve(root, path))
  if (full !== root && !full.startsWith(root + sep)) throw new Error("Path outside repository")
  return full
}

function safeDestination(root, path) {
  const base = realpathSync(root)
  const full = resolve(root, path)
  if (!full.startsWith(base + sep)) throw new Error("Destination outside vendor tree")
  let current = base
  for (const part of relative(base, full).split(sep)) {
    current = join(current, part)
    let stat
    try { stat = lstatSync(current) } catch (error) { if (error.code === "ENOENT") continue; throw error }
    if (stat.isSymbolicLink()) throw new Error("Symlink in destination path")
    contained(base, relative(base, current))
  }
  const inspect = file => {
    const stat = lstatSync(file)
    if (stat.isSymbolicLink()) throw new Error("Symlink in destination path")
    if (stat.isDirectory()) for (const child of readdirSync(file)) inspect(join(file, child))
  }
  if (existsSync(full)) inspect(full)
  return full
}

function majorCap(version) {
  const match = /^v?(\d+)\.(\d+)(?:\.\d+)?/.exec(version)
  if (!match) throw new Error(`Unsupported installed version: ${version}`)
  return Number(match[1]) >= 1 ? `^${match[1]}.0` : `^0.${match[2]}`
}

function composer(project, args, run) {
  const result = run("composer", ["--no-scripts", "--no-plugins", "--no-interaction", ...args], {
    cwd: project, encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: project, COMPOSER: "composer.json", COMPOSER_HOME: project,
      COMPOSER_CACHE_DIR: join(project, "cache"), COMPOSER_ALLOW_SUPERUSER: "1", COMPOSER_NO_INTERACTION: "1" },
  })
  if (result.error) throw result.error
  return result
}

function audit(project, pkg, run) {
  const result = composer(project, ["audit", "--locked", "--format=json", "--abandoned=ignore"], run)
  if (![0, 1].includes(result.status)) throw new Error(result.stderr || "Composer audit failed")
  let report
  try { report = JSON.parse(result.stdout) } catch { throw new Error("Composer audit output is missing or invalid") }
  if (!report.advisories || typeof report.advisories !== "object" ||
    Object.values(report.advisories).some(rows => !rows || typeof rows !== "object")) throw new Error("Invalid Composer audit advisories")
  const rows = Object.values(report.advisories[pkg] ?? {})
  if (rows.some(row => !row || typeof row.affectedVersions !== "string" || !row.affectedVersions.trim())) throw new Error("Missing affectedVersions in Composer audit")
  if (result.status === 1 && !Object.values(report.advisories).some(rows => Object.keys(rows).length)) throw new Error("Failed Composer audit without advisories")
  return rows
}

function resolveUpgrade(options, run, apply) {
  let project
  try {
    const root = realpathSync(options.repoDir)
    const path = typeof options.tree === "string" ? options.tree : options.tree.path
    const vendor = contained(root, path)
    if (relative(root, vendor).split(sep).join("/") !== path) throw new Error("Use a repository-relative vendor tree path")
    const { trees } = discoverVendors(root, run)
    const tree = trees.find(tree => tree.path === path)
    if (!tree?.packages.length || tree.lock === "invalid" || tree.mismatches.length) throw new Error("Missing or inconsistent vendor metadata")
    const current = tree.packages.find(pkg => pkg.name === options.pkg)
    if (!current || current.version !== options.version || !packageName.test(options.pkg)) throw new Error("Target package version does not match the tree")
    const parent = dirname(vendor)
    const manifestPath = join(parent, "composer.json")
    const manifest = existsSync(manifestPath) ? json(contained(root, relative(root, manifestPath))) : {}
    const lockPath = join(parent, "composer.lock")
    const locked = existsSync(lockPath) ? packages(json(contained(root, relative(root, lockPath)))) : []
    const rootNames = [...Object.keys(manifest.require ?? {}), ...Object.keys(manifest["require-dev"] ?? {})].filter(name => name.includes("/"))
    const known = new Map([...locked, ...tree.packages].map(pkg => [pkg.name, pkg]))
    if (rootNames.some(name => !known.has(name))) throw new Error("Root package has no locked version")
    const required = [...known.values()]
    const php = options.php ?? "7.2.34"
    if (typeof php !== "string" || !/^\d+\.\d+(?:\.\d+)?$/.test(php)) throw new Error("Invalid PHP platform version")
    project = mkdtempSync(join(tmpdir(), "security-patch-upgrade-"))
    const requirements = capped => Object.fromEntries(required.map(pkg => {
      if (!packageName.test(pkg.name)) throw new Error("Invalid installed package name")
      const constraints = [pkg.name === options.pkg ? `>${options.version}` : null, `>=${pkg.version}`, capped ? majorCap(pkg.version) : null].filter(Boolean)
      const rootConstraint = manifest.require?.[pkg.name] ?? manifest["require-dev"]?.[pkg.name] ?? ""
      if (typeof rootConstraint !== "string") throw new Error("Invalid root package constraint")
      // Distribute the cap across alternatives so a root OR cannot bypass it.
      return [pkg.name, rootConstraint.split(/\s*\|\|?\s*/).map(branch => [...constraints, branch].filter(Boolean).join(", ")).join(" || ")]
    }))
    const config = { name: "security-patch/upgrade", config: { platform: { php }, "allow-plugins": false }, require: requirements(true) }
    writeFileSync(join(project, "composer.json"), JSON.stringify(config))
    writeFileSync(join(project, "composer.lock"), JSON.stringify({ packages: required, "packages-dev": [] }))
    const advisories = audit(project, options.pkg, run)
    if (!advisories.length) throw new Error("No affected-version constraints for target package")
    const rootConflict = manifest.conflict ?? {}
    if (typeof rootConflict !== "object" || Object.values(rootConflict).some(value => typeof value !== "string")) throw new Error("Invalid root conflict constraint")
    config.conflict = { ...rootConflict, [options.pkg]: [rootConflict[options.pkg], ...advisories.map(row => row.affectedVersions)].filter(Boolean).join(" || ") }
    // Root autoload paths must keep their meaning after the generated maps return to the tree.
    if (apply && tree.mode === "committed") {
      if (!existsSync(manifestPath) && existsSync(join(vendor, "autoload.php"))) throw new Error("Cannot preserve root autoload entries without composer.json")
      config.autoload = manifest.autoload ?? {}
      config["autoload-dev"] = manifest["autoload-dev"] ?? {}
      for (const autoload of [config.autoload, config["autoload-dev"]]) {
        const paths = [...Object.values(autoload["psr-4"] ?? {}), ...Object.values(autoload["psr-0"] ?? {}),
          ...(autoload.classmap ?? []), ...(autoload.files ?? [])].flat()
        for (const source of paths) {
          if (typeof source !== "string" || isAbsolute(source) || source.split(/[\\/]/).includes("..")) throw new Error("Unsupported root autoload path")
          const from = resolve(parent, source.replace(/\*.*$/, ""))
          if (!existsSync(from)) continue
          contained(root, relative(root, from))
          const to = resolve(project, relative(parent, from))
          cpSync(from, to, { recursive: true, filter: file => {
            if (file === vendor || relative(parent, file).split(sep).some(part => part.startsWith("."))) return false
            const stat = lstatSync(file)
            if (stat.isSymbolicLink()) throw new Error("Symlink in root autoload source")
            return stat.isDirectory() || /\.(php|inc|hh)$/.test(file)
          } })
        }
      }
    }

    writeFileSync(join(project, "composer.json"), JSON.stringify(config))
    rmSync(join(project, "composer.lock"))
    const result = composer(project, ["update", "--prefer-lowest", "--no-install"], run)
    if (result.status !== 0) {
      const reason = result.stderr || result.stdout || "Composer resolution failed"
      config.require = requirements(false)
      writeFileSync(join(project, "composer.json"), JSON.stringify(config))
      const uncapped = composer(project, ["update", "--prefer-lowest", "--no-install"], run)
      if (uncapped.status === 0) {
        const installed = new Map(required.map(pkg => [pkg.name, pkg.version]))
        const jump = packages(json(join(project, "composer.lock"))).find(pkg => {
          const previous = installed.get(pkg.name)
          return previous && majorCap(previous) !== majorCap(pkg.version)
        })
        if (jump) throw new Error(`fixed only in a new major: ${jump.name} ${jump.version}`)
      }
      throw new Error(reason)
    }
    const lock = json(join(project, "composer.lock"))
    const resolved = packages(lock)
    if (!resolved.every(pkg => packageName.test(pkg.name) && typeof pkg.version === "string")) throw new Error("Invalid resolved packages")
    const target = resolved.find(pkg => pkg.name === options.pkg)?.version
    if (!target || target === options.version || required.some(pkg => !resolved.some(next => next.name === pkg.name))) throw new Error("Incomplete Composer resolution")
    const remaining = audit(project, options.pkg, run)
    if (remaining.length) throw new Error(`Target package still has an advisory: ${remaining.map(row => row.advisoryId ?? row.title ?? row.affectedVersions).join(", ")}`)
    const installed = new Map(tree.packages.map(pkg => [pkg.name, pkg.version]))
    const moved = resolved.filter(pkg => installed.get(pkg.name) !== pkg.version)
      .map(pkg => ({ package: pkg.name, from: installed.get(pkg.name) ?? null, to: pkg.version }))
    if (apply) {
      if (!["committed", "reinstalled"].includes(tree.mode)) throw new Error("Vendor install mode is unknown")
      const lockPath = safeDestination(parent, "composer.lock")
      if (tree.mode === "reinstalled" && !existsSync(lockPath)) throw new Error("Reinstalled tree has no lockfile")
      if (tree.mode === "committed") {
        const install = composer(project, ["install", "--prefer-dist"], run)
        if (install.status !== 0) throw new Error(install.stderr || install.stdout || "Composer install failed")
        const generated = join(project, "vendor")
        const metadata = json(join(generated, "composer/installed.json"))
        const installedPackages = Array.isArray(metadata) ? metadata : metadata.packages
        if (!Array.isArray(installedPackages) || moved.some(pkg => !installedPackages.some(row => row.name === pkg.package && row.version === pkg.to))) throw new Error("Installed packages do not match resolved lock")
        // Validate every source and destination before replacing any package.
        for (const pkg of moved) {
          contained(generated, pkg.package)
          safeDestination(vendor, pkg.package)
        }
        safeDestination(vendor, "composer")
        safeDestination(vendor, "autoload.php")
        for (const file of ["autoload.php", "composer/installed.json"]) contained(generated, file)
        for (const pkg of moved) {
          const destination = join(vendor, pkg.package)
          rmSync(destination, { recursive: true, force: true })
          cpSync(join(generated, pkg.package), destination, { recursive: true })
        }
        cpSync(join(generated, "composer"), join(vendor, "composer"), { recursive: true })
        cpSync(join(generated, "autoload.php"), join(vendor, "autoload.php"))
      }
      if (existsSync(lockPath)) {
        const original = json(contained(root, relative(root, lockPath)))
        const dev = new Set((original["packages-dev"] ?? []).map(pkg => pkg.name))
        // A dev package that a production package now requires moves to production.
        const byName = new Map(resolved.map(pkg => [pkg.name, pkg]))
        const prod = new Set()
        const visit = name => {
          if (prod.has(name) || !byName.has(name)) return
          prod.add(name)
          for (const dep of Object.keys(byName.get(name).require ?? {})) visit(dep)
        }
        for (const pkg of resolved) if (!dev.has(pkg.name)) visit(pkg.name)
        writeFileSync(lockPath, JSON.stringify({ ...original, packages: resolved.filter(pkg => prod.has(pkg.name)),
          "packages-dev": resolved.filter(pkg => !prod.has(pkg.name)) }, null, 2) + "\n")
      }
    }
    return { result: "installs", target, moved }
  } catch (error) { return blocked(error) }
  finally { if (project) rmSync(project, { recursive: true, force: true }) }
}

export function upgradeCheck(options, run = spawnSync) { return resolveUpgrade(options, run, false) }
export function applyUpgrade(options, run = spawnSync) { return resolveUpgrade(options, run, true) }

// The backend sets REPO_PHP on fix runs, so the agent does not need to pass --php.
export function cliOptions(args, env = process.env) {
  const flags = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2], args[i * 2 + 1]]))
  return { repoDir: flags["--repo"], tree: flags["--tree"], pkg: flags["--package"], version: flags["--version"], php: flags["--php"] ?? (env.REPO_PHP || undefined) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [action, ...args] = process.argv.slice(2)
  const options = cliOptions(args)
  console.log(JSON.stringify(action === "check" ? upgradeCheck(options) : action === "apply" ? applyUpgrade(options) : blocked("Use check or apply")))
}
