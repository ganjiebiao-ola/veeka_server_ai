// Check step for a batch fix: lint, rescan, PHPUnit against a baseline, and a new test.
// Every command goes through exec, so tests can fake it.
import { agentEnv, agentSpawnSync } from "./agent-user.mjs";
import { existsSync, lstatSync, readFileSync } from "node:fs"
import { runAsAgent } from "./agent-fs.mjs"
import { dirname, join } from "node:path"
import { findVendorTrees, vendorTreeForPath } from "./vendor.mjs"

export function exec(cmd, args, { cwd, timeout = 120000 } = {}) {
  // Lint and tests run repo code the model wrote, so they run as the agent user too.
  const r = agentSpawnSync(cmd, args, { cwd, encoding: "utf-8", maxBuffer: 16 * 1024 * 1024, timeout, env: agentEnv() });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

export const isTestFile = (file) => /(^|\/)tests?\//i.test(file) && /(Test|_test)\.php$/.test(file);
const lines = (text) => text.split("\n").map((line) => line.trim()).filter(Boolean);

// All PHPUnit files under tests/, repo-relative.
export function testFiles(repo, run = exec) {
  const r = run("git", ["-C", repo, "ls-files", "--", "tests", "test"]);
  return r.ok ? lines(r.out).filter(isTestFile) : [];
}

// Runs one test file from the tests dir, with its bootstrap when present.
export function phpunit(repo, file, run = exec) {
  const dir = file.split("/")[0];
  const args = ["--do-not-cache-result", ...(run("test", ["-f", `${repo}/${dir}/bootstrap.php`]).ok ? ["--bootstrap", "bootstrap.php"] : []), file.slice(dir.length + 1)];
  return run("timeout", ["60", "phpunit", ...args], { cwd: `${repo}/${dir}`, timeout: 70000 });
}

// Test files that pass on the base commit. DB and Redis tests fail offline, so they drop out here.
export function baselineTests(repo, base, run = exec) {
  const tree = "/tmp/ola-base";
  if (!run("git", ["-C", repo, "worktree", "add", "--detach", tree, base]).ok) return new Set();
  try {
    return new Set(testFiles(tree, run).filter((file) => phpunit(tree, file, run).ok));
  } finally {
    run("git", ["-C", repo, "worktree", "remove", "--force", tree]);
  }
}

export function patchLog(repo, base, changed, run = exec) {
  if (process.getuid?.() === 0 && run === exec) return runAsAgent(import.meta.url, "patchLog", [repo, base, changed])
  // A nested tree's log sits inside the outer tree, but it is a log, not a vendor patch.
  const files = changed.filter(file => file.split("/").includes("vendor") && file.split("/").at(-1) !== "VENDOR_PATCHES.md")
  if (!files.length) return { name: "patch log", command: "VENDOR_PATCHES.md covers vendor patches", ok: true, output: "" }
  let logPath
  try {
    const trees = findVendorTrees(repo)
    const missing = []
    const readPackages = text => {
      const data = JSON.parse(text)
      const rows = Array.isArray(data) ? data : [...data.packages, ...(data["packages-dev"] ?? [])]
      if (!Array.isArray(rows)) throw new Error("Invalid installed.json")
      return new Map(rows.map(pkg => [pkg.name, pkg.version]))
    }
    for (const tree of trees) {
      const touched = files.filter(file => vendorTreeForPath(file, repo, trees) === tree)
      if (!touched.length) continue
      logPath = join(dirname(tree), "VENDOR_PATCHES.md")
      let log = ""
      // A symlinked log points outside the commit, so it never counts as an entry.
      try { if (!lstatSync(join(repo, logPath)).isSymbolicLink()) log = readFileSync(join(repo, logPath), "utf8") } catch (error) { if (error.code !== "ENOENT") throw error }
      const entries = log.split("\n").filter(line => line.trim().startsWith("|")).map(line => line.trim().slice(1, -1).split("|").map(cell => cell.trim())).filter(cells => cells.length === 6 && cells.every(Boolean))
      const metadata = existsSync(join(repo, tree, "composer/installed.json")) ? `${tree}/composer/installed.json`
        : join(dirname(tree), "composer.lock")
      const after = existsSync(join(repo, metadata)) ? readPackages(readFileSync(join(repo, metadata), "utf8")) : new Map()
      let before
      if (changed.includes(metadata)) {
        const old = run("git", ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "-C", repo, "show", `${base}:${metadata}`])
        if (old.ok) before = readPackages(old.out)
      }
      const upgraded = name => {
        const normalize = version => {
          const match = /^v?(\d+(?:\.\d+){0,3})$/.exec(version ?? "")
          return match ? match[1].split(".").map(BigInt) : null
        }
        const previous = normalize(before?.get(name))
        const next = normalize(after.get(name))
        if (!previous || !next) return false
        for (let i = 0; i < Math.max(previous.length, next.length); i++) {
          const left = previous[i] ?? 0n
          const right = next[i] ?? 0n
          if (left !== right) return right > left
        }
        return false
      }
      for (const file of touched) {
        const name = file.slice(tree.length + 1).split("/").slice(0, 2).join("/")
        const owners = file === metadata ? [...after.keys()].filter(pkg => before?.get(pkg) !== after.get(pkg)) : [name]
        if (!owners.length) owners.push(name)
        if (owners.some(pkg => !upgraded(pkg) && !entries.some(cells => cells[0] === tree && cells[1] === pkg))) missing.push(`${file} (expected ${logPath})`)
      }
    }
    for (const file of files) if (!vendorTreeForPath(file, repo, trees)) {
      const parts = file.split("/")
      missing.push(`${file} (expected ${join(parts.slice(0, parts.lastIndexOf("vendor")).join("/"), "VENDOR_PATCHES.md")})`)
    }
    return { name: "patch log", command: "VENDOR_PATCHES.md covers vendor patches", ok: !missing.length,
      output: missing.map(file => `Missing patch log entry: ${file}`).join("\n") }
  } catch (error) {
    return { name: "patch log", command: "VENDOR_PATCHES.md covers vendor patches", ok: false, output: `Cannot verify vendor patch log${logPath ? ` ${logPath}` : ""}: ${error.message}` }
  }
}

// fixed: [{ file, line, category }] from findings.json. semgrep(files) returns hits with path, start.line, category.
export function runChecks({ repo, base, baseline, fixed, semgrep, run = exec }) {
  const changed = run("git", ["-C", repo, "diff", "--name-only", "-z", "--diff-filter=AMR", base]).out.split("\0").filter(Boolean);
  const php = changed.filter((file) => file.endsWith(".php"));
  const patchChanged = run("git", ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "-C", repo, "diff", "--name-only", "-z", "--no-renames", base]).out.split("\0").filter(Boolean)
  const checks = [patchLog(repo, base, patchChanged, run)]

  const lint = php.map((file) => ({ file, ...run("php", ["-l", `${repo}/${file}`]) })).filter((r) => !r.ok);
  checks.push({ name: "lint", command: `php -l (${php.length} files)`, ok: !lint.length, output: lint.map((r) => r.out).join("\n") });

  const tests = changed.filter(isTestFile);
  const toRun = [...new Set([...baseline, ...tests])];
  const executed = new Set()
  const failed = toRun.filter(file => {
    if (!tests.includes(file)) return !phpunit(repo, file, run).ok
    const temp = run("mktemp", [])
    const log = temp.ok ? temp.out.trim() : ""
    try {
      const result = phpunit(repo, file, (cmd, args, options) => run(cmd,
        log && cmd === "timeout" ? [...args.slice(0, -1), "--log-junit", log, args.at(-1)] : args, options))
      if (log) {
        // Count testcases once each. PHPUnit logs an empty TestCase as a fake "Warning" test, so skip those.
        const count = run("php", ["-r", "$xml = @simplexml_load_file($argv[1]); if ($xml === false) exit(1); echo count($xml->xpath('//testcase[not(warning)]'));", log])
        if (count.ok && /^\d+$/.test(count.out.trim()) && Number(count.out.trim()) > 0) executed.add(file)
      }
      return !result.ok
    } finally {
      if (log) run("rm", ["-f", log])
    }
  })
  const missing = tests.filter(file => !executed.has(file))
  const beforeFix = []
  if (tests.length) {
    const temp = run("mktemp", ["-d", "/tmp/ola-before-fix.XXXXXX"])
    if (!temp.ok || !temp.out.trim()) beforeFix.push("Cannot create base worktree directory.")
    else {
      const directory = temp.out.trim()
      const tree = `${directory}/repo`
      try {
        if (!run("git", ["-C", repo, "worktree", "add", "--detach", tree, base]).ok) beforeFix.push("Cannot create base worktree.")
        else for (const file of tests) {
          const target = `${tree}/${file}`
          // A symlinked folder in the base commit must not send the copy outside the worktree.
          const root = run("realpath", ["--", tree]).out.trim()
          const parent = run("realpath", ["-m", "--", dirname(target)]).out.trim()
          if (!root || !(parent === root || parent.startsWith(`${root}/`))) beforeFix.push(`Test path leaves the base worktree: ${file}`)
          else if (!run("mkdir", ["-p", dirname(target)]).ok || !run("cp", ["-P", "--remove-destination", "--", `${repo}/${file}`, target]).ok) {
            beforeFix.push(`Cannot copy test to base: ${file}`)
          } else if (phpunit(tree, file, run).ok) beforeFix.push(`Passes before the fix: ${file}`)
        }
      } finally {
        try { if (!run("git", ["-C", repo, "worktree", "remove", "--force", tree]).ok) beforeFix.push("Cannot remove base worktree.") }
        finally { if (!run("rmdir", [directory]).ok) beforeFix.push("Cannot remove base worktree directory.") }
      }
    }
  }
  const testErrors = [...missing.map(file => `No PHPUnit tests ran: ${file}`), ...beforeFix]
  checks.push({ name: "new test", command: "PHPUnit tests run on HEAD and fail on base for each added or changed test file", ok: tests.length > 0 && !testErrors.length,
    output: testErrors.length ? testErrors.join("\n") : tests.length ? tests.join("\n") : "The batch adds no test." })
  checks.push({ name: "phpunit", command: `phpunit (${toRun.length} offline files)`, ok: !failed.length, output: failed.length ? `Failed: ${failed.join(", ")}` : "" });

  // A fixed site is still there when a hit of its type in the same file has the same source line.
  let hits = [];
  let rescanError = "";
  try { if (php.length) hits = semgrep(php); }
  catch (error) { rescanError = String(error?.message ?? error); }
  const source = (ref, file) => run("git", ["-C", repo, "show", `${ref}:${file}`]).out.split("\n");
  const left = fixed.filter((f) => {
    const before = source(base, f.file)[f.line - 1]?.trim();
    return before && hits.some((hit) => hit.path === f.file && hit.category === f.category && source("HEAD", hit.path)[hit.line - 1]?.trim() === before);
  });
  checks.push({ name: "rescan", command: `semgrep (${php.length} files)`, ok: !rescanError && !left.length, output: rescanError || left.map((f) => `Still found: ${f.file}:${f.line} (${f.category})`).join("\n") });
  // Keep every test path. Other outputs keep the tail, which holds the error.
  return checks.map((check) => ({ ...check, output: check.name === "new test" ? check.output : check.output.slice(-2000) }));
}
