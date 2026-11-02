import { test } from "node:test";
import assert from "node:assert/strict";
import { baselineTests, isTestFile, runChecks } from "./checks.mjs";

// Fake shell: a map from "cmd args" prefixes to results.
function fake({ changed = [], lintFail = [], testsFail = [], baseTestsPass = [], testsRun = {}, missingResults = [], files = {}, tracked = [] }) {
  const calls = [];
  const reports = new Map()
  const run = (cmd, args, options) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    if (line.includes("diff --name-only")) return { ok: true, out: changed.join(args.includes("-z") ? "\0" : "\n") };
    if (line.includes("ls-files")) return { ok: true, out: tracked.join("\n") };
    if (line.includes("worktree")) return { ok: true, out: "" };
    if (cmd === "test") return { ok: true, out: "" };
    if (cmd === "mktemp") return { ok: true, out: `/tmp/checks-${args.includes("-d") ? "before-fix" : "junit"}-${calls.length}\n` }
    if (["rm", "rmdir", "mkdir", "cp"].includes(cmd)) return { ok: true, out: "" }
    if (cmd === "realpath") return { ok: true, out: `${args.at(-1)}\n` }
    if (cmd === "php" && args[0] === "-r") return reports.get(args.at(-1)) ?? { ok: false, out: "" }
    if (cmd === "php") return { ok: !lintFail.some((f) => line.endsWith(f)), out: "Parse error" };
    if (cmd === "timeout") {
      const matches = file => line.endsWith(file.split("/").slice(1).join("/"))
      if (options?.cwd.startsWith("/tmp/checks-before-fix-")) return { ok: baseTestsPass.some(matches), out: "" }
      if (args.includes("--log-junit") && !missingResults.some(matches)) {
        const count = Object.entries(testsRun).find(([file]) => matches(file))?.[1] ?? 1
        reports.set(args[args.indexOf("--log-junit") + 1], { ok: true, out: String(count) })
      }
      return { ok: !testsFail.some(matches), out: "" }
    }
    if (line.includes(" show ")) return { ok: true, out: files[args.at(-1)] ?? "" };
    return { ok: false, out: "" };
  };
  return { run, calls };
}
const byName = (checks) => Object.fromEntries(checks.map((c) => [c.name, c]));

test("a clean batch passes every check", () => {
  const { run } = fake({ changed: ["app/a.php", "tests/app/ATest.php"], files: { "base:app/a.php": "<?php\n$db->query($x);\n", "HEAD:app/a.php": "<?php\n$db->query('?', [$x]);\n" } });
  const checks = runChecks({ repo: "/r", base: "base", baseline: new Set(["tests/app/OldTest.php"]), fixed: [{ file: "app/a.php", line: 2, category: "sqli" }],
    semgrep: () => [{ path: "app/a.php", line: 2, category: "sqli" }], run });
  assert.deepEqual(checks.map((c) => [c.name, c.ok]), [["patch log", true], ["lint", true], ["new test", true], ["phpunit", true], ["rescan", true]]);
  assert.equal(byName(checks).phpunit.command, "phpunit (2 offline files)");
});

test("a syntax error fails lint", () => {
  const { run } = fake({ changed: ["app/a.php", "tests/app/ATest.php"], lintFail: ["app/a.php"] });
  const c = byName(runChecks({ repo: "/r", base: "b", baseline: new Set(), fixed: [], semgrep: () => [], run }));
  assert.equal(c.lint.ok, false);
  assert.match(c.lint.output, /Parse error/);
});

test("a batch with no new test fails", () => {
  const { run } = fake({ changed: ["app/a.php"] });
  assert.equal(byName(runChecks({ repo: "/r", base: "b", baseline: new Set(), fixed: [], semgrep: () => [], run }))["new test"].ok, false);
});

test("a plain PHP script with zero PHPUnit tests fails new test", () => {
  const file = "tests/room_vendor_unserialize_guard_test.php"
  const { run } = fake({ changed: [file], testsRun: { [file]: 0 } })
  const checks = byName(runChecks({ repo: "/r", base: "b", baseline: [], fixed: [], semgrep: () => [], run }))
  assert.equal(checks["new test"].ok, false)
  assert.ok(checks["new test"].output.includes(file))
  assert.equal(checks.phpunit.ok, true)
})

test("a test that fails on base and passes on HEAD passes and runs once per checkout", () => {
  const file = "tests/room_vendor_unserialize_guard_test.php"
  const { run, calls } = fake({ changed: [file], testsRun: { [file]: 2 } })
  const invocations = []
  const checkedRun = (cmd, args, options) => {
    if (cmd === "timeout") invocations.push({ args, options })
    return run(cmd, args, options)
  }
  const checks = byName(runChecks({ repo: "/r", base: "b", baseline: [file], fixed: [], semgrep: () => [], run: checkedRun }))
  assert.equal(checks["new test"].ok, true)
  assert.equal(checks.phpunit.ok, true)
  assert.equal(invocations.length, 2)
  assert.deepEqual(invocations[0], {
    args: ["60", "phpunit", "--do-not-cache-result", "--bootstrap", "bootstrap.php", "--log-junit", invocations[0].args.at(-2), "room_vendor_unserialize_guard_test.php"],
    options: { cwd: "/r/tests", timeout: 70000 },
  })
  assert.ok(calls.some(call => call === `rm -f ${invocations[0].args.at(-2)}`))
  const tree = invocations[1].options.cwd.slice(0, -"/tests".length)
  assert.deepEqual(invocations[1], {
    args: ["60", "phpunit", "--do-not-cache-result", "--bootstrap", "bootstrap.php", "room_vendor_unserialize_guard_test.php"],
    options: { cwd: `${tree}/tests`, timeout: 70000 },
  })
  assert.ok(calls.includes(`git -C /r worktree add --detach ${tree} b`))
  assert.ok(calls.includes(`mkdir -p ${tree}/tests`))
  assert.ok(calls.includes(`cp -P --remove-destination -- /r/${file} ${tree}/${file}`))
  assert.ok(calls.includes(`git -C /r worktree remove --force ${tree}`))
  assert.ok(calls.includes(`rmdir ${tree.slice(0, -"/repo".length)}`))
})

test("a new test that also passes on base fails new test and names the file", () => {
  const files = ["tests/app/GuardTest.php", "tests/app/TrivialTest.php"]
  const { run } = fake({ changed: files, baseTestsPass: [files[1]] })
  const checks = byName(runChecks({ repo: "/r", base: "b", baseline: [], fixed: [], semgrep: () => [], run }))
  assert.equal(checks["new test"].ok, false)
  assert.equal(checks["new test"].output, `Passes before the fix: ${files[1]}`)
  assert.equal(checks.phpunit.ok, true)
})

test("new test preserves every file that passes before the fix in long output", () => {
  const files = Array.from({ length: 30 }, (_, i) => `tests/${"guard_".repeat(10)}${i}_test.php`)
  const { run } = fake({ changed: files, baseTestsPass: files })
  const checks = byName(runChecks({ repo: "/r", base: "b", baseline: [], fixed: [], semgrep: () => [], run }))
  assert.equal(checks["new test"].ok, false)
  for (const file of files) assert.ok(checks["new test"].output.includes(`Passes before the fix: ${file}`))
})

for (const throws of [false, true]) test(`base worktree is removed when PHPUnit ${throws ? "throws" : "times out"}`, () => {
  const file = "tests/app/GuardTest.php"
  const { run, calls } = fake({ changed: [file] })
  let tree
  const checkedRun = (cmd, args, options) => {
    if (cmd === "timeout" && options.cwd !== "/r/tests") {
      tree = options.cwd.slice(0, -"/tests".length)
      if (throws) throw new Error("PHPUnit failed to start")
      return { ok: false, out: "Timed out" }
    }
    return run(cmd, args, options)
  }
  const check = () => runChecks({ repo: "/r", base: "b", baseline: [], fixed: [], semgrep: () => [], run: checkedRun })
  if (throws) assert.throws(check, /PHPUnit failed to start/)
  else assert.equal(byName(check())["new test"].ok, true)
  assert.ok(tree)
  assert.ok(calls.includes(`git -C /r worktree remove --force ${tree}`))
  assert.ok(calls.includes(`rmdir ${tree.slice(0, -"/repo".length)}`))
})

test("before-fix worktrees use unique paths distinct from the baseline worktree", () => {
  const { run, calls } = fake({ changed: ["tests/app/GuardTest.php"] })
  baselineTests("/r", "b", run)
  for (let i = 0; i < 2; i++) runChecks({ repo: "/r", base: "b", baseline: [], fixed: [], semgrep: () => [], run })
  const trees = calls.filter(call => call.includes("worktree add")).map(call => call.split(" ").at(-2))
  assert.equal(trees[0], "/tmp/ola-base")
  assert.equal(new Set(trees).size, 3)
  for (const tree of trees) assert.ok(calls.includes(`git -C /r worktree remove --force ${tree}`))
})

for (const command of ["mktemp", "worktree", "mkdir", "cp"]) test(`new test fails when base ${command} fails`, () => {
  const file = "tests/app/GuardTest.php"
  const { run, calls } = fake({ changed: [file] })
  const checkedRun = (cmd, args, options) => {
    if ((cmd === command && (cmd !== "mktemp" || args.includes("-d"))) || (command === "worktree" && args.includes("add"))) {
      return { ok: false, out: "Setup failed" }
    }
    assert.ok(cmd !== "timeout" || options.cwd === "/r/tests")
    return run(cmd, args, options)
  }
  const checks = byName(runChecks({ repo: "/r", base: "b", baseline: [], fixed: [], semgrep: () => [], run: checkedRun }))
  assert.equal(checks["new test"].ok, false)
  assert.match(checks["new test"].output, /Cannot/)
  if (command === "mkdir" || command === "cp") assert.ok(checks["new test"].output.includes(file))
  if (command !== "mktemp") {
    const directory = calls.find(call => call.startsWith("rmdir ")).slice("rmdir ".length)
    assert.ok(calls.includes(`git -C /r worktree remove --force ${directory}/repo`))
  }
})

test("every changed test needs a PHPUnit result even when another TestCase runs", () => {
  const files = ["tests/GuardTest.php", "tests/plain_test.php", "tests/MissingTest.php"]
  const { run } = fake({ changed: files, testsRun: { [files[1]]: 0 }, missingResults: [files[2]] })
  const checks = byName(runChecks({ repo: "/r", base: "b", baseline: [], fixed: [], semgrep: () => [], run }))
  assert.equal(checks["new test"].ok, false)
  for (const file of files.slice(1)) assert.ok(checks["new test"].output.includes(file))
})

test("new test reports every unexecuted file when output exceeds 2000 characters", () => {
  const files = Array.from({ length: 30 }, (_, i) => `tests/${"guard_".repeat(10)}${i}_test.php`)
  const { run } = fake({ changed: files, testsRun: Object.fromEntries(files.map(file => [file, 0])) })
  const checks = byName(runChecks({ repo: "/r", base: "b", baseline: [], fixed: [], semgrep: () => [], run }))
  assert.equal(checks["new test"].ok, false)
  for (const file of files) assert.ok(checks["new test"].output.includes(file))
})

test("a baseline test that now fails fails phpunit", () => {
  const { run } = fake({ changed: ["app/a.php", "tests/app/ATest.php"], testsFail: ["tests/app/OldTest.php"] });
  const c = byName(runChecks({ repo: "/r", base: "b", baseline: new Set(["tests/app/OldTest.php"]), fixed: [], semgrep: () => [], run }));
  assert.equal(c.phpunit.ok, false);
  assert.equal(c.phpunit.output, "Failed: tests/app/OldTest.php");
});

test("a fixed site that semgrep still finds fails the rescan", () => {
  const code = "<?php\n$db->query($x);\n";
  const { run } = fake({ changed: ["app/a.php", "tests/app/ATest.php"], files: { "b:app/a.php": code, "HEAD:app/a.php": "<?php\n// note\n$db->query($x);\n" } });
  const c = byName(runChecks({ repo: "/r", base: "b", baseline: new Set(), fixed: [{ file: "app/a.php", line: 2, category: "sqli" }],
    semgrep: () => [{ path: "app/a.php", line: 3, category: "sqli" }], run }));
  assert.equal(c.rescan.ok, false);
  assert.equal(c.rescan.output, "Still found: app/a.php:2 (sqli)");
});

test("baseline keeps only test files that pass on the base commit", () => {
  const { run, calls } = fake({ tracked: ["tests/app/ATest.php", "tests/app/DbTest.php", "tests/README.md"], testsFail: ["tests/app/DbTest.php"] });
  assert.deepEqual([...baselineTests("/r", "b", run)], ["tests/app/ATest.php"]);
  assert.ok(calls.some((c) => c.includes("worktree remove")));
  assert.equal(isTestFile("tests/pr1_source_guard_test.php"), true);
  assert.equal(isTestFile("app/ATest.php"), false);
});

test("vendor patches require matching tree and package entries, except upgrades", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { spawnSync } = await import("node:child_process")
  const repo = mkdtempSync(join(tmpdir(), "patch-log-test-"))
  const tree = "sdk/vendor"
  const metadata = `${tree}/composer/installed.json`
  const file = `${tree}/example/client/Client.php`
  const old = JSON.stringify({ packages: [{ name: "example/client", version: "1.0" }] })
  mkdirSync(join(repo, tree, "composer"), { recursive: true })
  mkdirSync(join(repo, tree, "example/client"), { recursive: true })
  writeFileSync(join(repo, metadata), old)
  writeFileSync(join(repo, file), "<?php")
  spawnSync("git", ["init", "-q"], { cwd: repo })
  spawnSync("git", ["add", "."], { cwd: repo })
  const check = (changed = [file]) => {
    const { run } = fake({ changed, files: { [`base:${metadata}`]: old } })
    return byName(runChecks({ repo, base: "base", baseline: [], fixed: [], semgrep: () => [], run }))["patch log"]
  }
  try {
    assert.equal(check().ok, false)
    assert.match(check().output, /example\/client\/Client.php/)
    assert.match(check().output, /sdk\/VENDOR_PATCHES.md/)
    writeFileSync(join(repo, "VENDOR_PATCHES.md"), "| sdk/vendor | example/client | 1.0 | TEST-1 | validate input | incompatible dependencies |\n")
    assert.equal(check().ok, false)
    assert.match(check().output, /sdk\/VENDOR_PATCHES.md/)
    writeFileSync(join(repo, "sdk/VENDOR_PATCHES.md"), "| sdk/vendor | example/client | 1.0 | TEST-1 | validate input | incompatible dependencies |\n")
    assert.equal(check().ok, true)
    for (let cell = 0; cell < 6; cell++) {
      const cells = ["sdk/vendor", "example/client", "1.0", "TEST-1", "validate input", "dependency conflict"]
      cells[cell] = ""
      writeFileSync(join(repo, "sdk/VENDOR_PATCHES.md"), `| ${cells.join(" | ")} |\n`)
      assert.equal(check().ok, false)
      assert.ok(check().output.includes(file))
    }
    writeFileSync(join(repo, "sdk/VENDOR_PATCHES.md"), "sdk/vendor example/client")
    assert.equal(check().ok, false)

    writeFileSync(join(repo, "sdk/VENDOR_PATCHES.md"), "Tree: other/vendor\nPackage: example/client\n")
    assert.equal(check().ok, false)
    writeFileSync(join(repo, "sdk/VENDOR_PATCHES.md"), "Tree: sdk/vendor\nPackage: other/client\n")
    assert.equal(check().ok, false)
    writeFileSync(join(repo, metadata), JSON.stringify({ packages: [{ name: "example/client", version: "1.1" }] }))
    assert.equal(check([file]).ok, false)
    assert.equal(check([file, metadata]).ok, true)
    assert.equal(check([metadata]).ok, true)
    writeFileSync(join(repo, metadata), old)
    writeFileSync(join(repo, "sdk/VENDOR_PATCHES.md"), "| Tree | Package |\n| other/vendor | example/client |\n| sdk/vendor | other/client |\n")
    assert.equal(check().ok, false)
    const { run } = fake({ changed: [file] })
    const deletedRun = (cmd, args) => args.includes("--diff-filter=AMR") ? { ok: true, out: "" } : run(cmd, args)
    const deleted = byName(runChecks({ repo, base: "base", baseline: [], fixed: [], semgrep: () => [], run: deletedRun }))
    assert.equal(deleted.lint.ok, true)
    assert.equal(deleted["patch log"].ok, false)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test("two vendor trees in one diff each require their own patch log", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { dirname, join } = await import("node:path")
  const { spawnSync } = await import("node:child_process")
  const repo = mkdtempSync(join(tmpdir(), "patch-log-trees-"))
  const trees = ["sdk/vendor", "tools/vendor"]
  const files = trees.map(tree => `${tree}/example/client/Client.php`)
  const entries = trees.map(tree => `| ${tree} | example/client | 1.0 | TEST | fix | reason |\n`)
  try {
    for (const file of files) {
      mkdirSync(join(repo, dirname(file)), { recursive: true })
      writeFileSync(join(repo, file), "<?php")
    }
    spawnSync("git", ["init", "-q"], { cwd: repo })
    spawnSync("git", ["add", "."], { cwd: repo })
    const { run } = fake({ changed: files })
    const check = () => byName(runChecks({ repo, base: "base", baseline: [], fixed: [], semgrep: () => [], run }))["patch log"]
    writeFileSync(join(repo, "VENDOR_PATCHES.md"), entries.join(""))
    assert.equal(check().ok, false)
    assert.match(check().output, /sdk\/VENDOR_PATCHES.md/)
    assert.match(check().output, /tools\/VENDOR_PATCHES.md/)
    writeFileSync(join(repo, "sdk/VENDOR_PATCHES.md"), entries.join(""))
    assert.equal(check().ok, false)
    assert.match(check().output, /tools\/VENDOR_PATCHES.md/)
    assert.ok(!check().output.includes("sdk/VENDOR_PATCHES.md"))
    writeFileSync(join(repo, "tools/VENDOR_PATCHES.md"), entries[1])
    assert.equal(check().ok, true)
    rmSync(join(repo, "sdk/VENDOR_PATCHES.md"))
    assert.equal(check().ok, false)
    assert.match(check().output, /sdk\/VENDOR_PATCHES.md/)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test("a nested tree's patch log is not a patch to the outer tree", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { dirname, join } = await import("node:path")
  const { spawnSync } = await import("node:child_process")
  const repo = mkdtempSync(join(tmpdir(), "patch-log-nested-"))
  const file = "vendor/a/b/vendor/example/client/Client.php"
  const log = "vendor/a/b/VENDOR_PATCHES.md"
  try {
    mkdirSync(join(repo, dirname(file)), { recursive: true })
    writeFileSync(join(repo, file), "<?php")
    writeFileSync(join(repo, log), "| vendor/a/b/vendor | example/client | 1.0 | TEST | fix | reason |\n")
    spawnSync("git", ["init", "-q"], { cwd: repo })
    spawnSync("git", ["add", "."], { cwd: repo })
    const { run } = fake({ changed: [file, log] })
    assert.equal(byName(runChecks({ repo, base: "base", baseline: [], fixed: [], semgrep: () => [], run }))["patch log"].ok, true)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

for (const mode of ["quoted path", "lock only", "no metadata"]) test(`patch log handles ${mode}`, async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { dirname, join } = await import("node:path")
  const { spawnSync } = await import("node:child_process")
  const repo = mkdtempSync(join(tmpdir(), "patch-log-regression-"))
  const tree = mode === "quoted path" ? "vendor" : "sdk/vendor"
  const file = `${tree}/example/client/Client".php`
  try {
    mkdirSync(join(repo, tree, "example/client"), { recursive: true })
    writeFileSync(join(repo, file), "<?php")
    if (mode === "quoted path") {
      mkdirSync(join(repo, tree, "composer"), { recursive: true })
      writeFileSync(join(repo, tree, "composer/installed.json"), JSON.stringify({ packages: [{ name: "example/client", version: "1.0.0" }] }))
    }
    if (mode === "lock only") writeFileSync(join(repo, "sdk/composer.lock"), JSON.stringify({ packages: [], "packages-dev": [{ name: "example/client", version: "1.0.0" }] }))
    spawnSync("git", ["init", "-q"], { cwd: repo })
    spawnSync("git", ["add", "."], { cwd: repo })
    writeFileSync(join(repo, file), "<?php // patch")
    const fallback = fake({ changed: [file] }).run
    const run = (cmd, args) => args.includes("diff")
      ? { ok: true, out: spawnSync("git", ["diff", "--name-only", ...(args.includes("-z") ? ["-z"] : [])], { cwd: repo, encoding: "utf8" }).stdout }
      : fallback(cmd, args)
    const check = () => byName(runChecks({ repo, base: "base", baseline: [], fixed: [], semgrep: () => [], run }))["patch log"]
    assert.equal(check().ok, false)
    assert.match(check().output, /Missing patch log entry/)
    writeFileSync(join(repo, dirname(tree), "VENDOR_PATCHES.md"), `| ${tree} | example/client | 1.0 | TEST | fix | reason |\n`)
    assert.equal(check().ok, true)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

for (const version of ["0.9.0", "dev-main", "v1.0.0", "unknown package"]) test(`upgrade exemption rejects ${version}`, async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { spawnSync } = await import("node:child_process")
  const repo = mkdtempSync(join(tmpdir(), "patch-version-"))
  const metadata = "sdk/vendor/composer/installed.json"
  const file = version === "unknown package" ? "sdk/vendor/custom/bundle/Client.php" : "sdk/vendor/example/client/Client.php"
  const old = JSON.stringify({ packages: [{ name: "example/client", version: "1.0.0" }] })
  try {
    mkdirSync(join(repo, metadata, ".."), { recursive: true })
    mkdirSync(join(repo, file, ".."), { recursive: true })
    writeFileSync(join(repo, file), "<?php")
    writeFileSync(join(repo, metadata), JSON.stringify({ packages: [{ name: "example/client", version: version === "unknown package" ? "1.1.0" : version }] }))
    spawnSync("git", ["init", "-q"], { cwd: repo })
    spawnSync("git", ["add", "."], { cwd: repo })
    const { run } = fake({ changed: [file, metadata], files: { [`base:${metadata}`]: old } })
    const check = byName(runChecks({ repo, base: "base", baseline: [], fixed: [], semgrep: () => [], run }))["patch log"]
    assert.equal(check.ok, false)
    assert.ok(check.output.includes(file))
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test("patch log sees a vendor file renamed out of the tree, and ignores a symlinked log", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { spawnSync } = await import("node:child_process")
  const repo = mkdtempSync(join(tmpdir(), "patch-rename-"))
  const outside = mkdtempSync(join(tmpdir(), "patch-outside-"))
  const git = (...args) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, encoding: "utf8" })
  try {
    mkdirSync(join(repo, "sdk/vendor/example/client"), { recursive: true })
    mkdirSync(join(repo, "app"))
    writeFileSync(join(repo, "sdk/vendor/example/client/Client.php"), "<?php")
    git("init", "-q"); git("add", "."); git("commit", "-qm", "base")
    git("mv", "sdk/vendor/example/client/Client.php", "app/Client.php")
    const fallback = fake({}).run
    const run = (cmd, args) => cmd === "git" && args.includes("diff")
      ? { ok: true, out: git(...args.slice(args.indexOf("diff")).map(arg => arg === "base" ? "HEAD" : arg)).stdout }
      : fallback(cmd, args)
    const check = () => byName(runChecks({ repo, base: "base", baseline: [], fixed: [], semgrep: () => [], run }))["patch log"]
    assert.equal(check().ok, false)
    assert.match(check().output, /sdk\/vendor\/example\/client\/Client.php/)
    writeFileSync(join(outside, "log.md"), "| sdk/vendor | example/client | 1.0 | TEST | move | reason |\n")
    symlinkSync(join(outside, "log.md"), join(repo, "sdk/VENDOR_PATCHES.md"))
    assert.equal(check().ok, false)
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("new test fails when a base symlink sends the copy outside the worktree", () => {
  const { run, calls } = fake({ changed: ["tests/app/FixTest.php"] })
  const outside = (cmd, args, options) => cmd === "realpath" && args.includes("-m") ? { ok: true, out: "/etc\n" } : run(cmd, args, options)
  const check = byName(runChecks({ repo: "/r", base: "b", baseline: [], fixed: [], semgrep: () => [], run: outside }))["new test"]
  assert.equal(check.ok, false)
  assert.match(check.output, /leaves the base worktree: tests\/app\/FixTest.php/)
  assert.ok(!calls.some(call => call.startsWith("cp ")))
})

for (const command of ["worktree remove", "rmdir"]) test(`new test fails when base cleanup (${command}) fails`, () => {
  const { run } = fake({ changed: ["tests/app/FixTest.php"] })
  const failing = (cmd, args, options) => [cmd, ...args].join(" ").includes(command) ? { ok: false, out: "" } : run(cmd, args, options)
  const check = byName(runChecks({ repo: "/r", base: "b", baseline: [], fixed: [], semgrep: () => [], run: failing }))["new test"]
  assert.equal(check.ok, false)
  assert.match(check.output, /Cannot remove base worktree/)
})
