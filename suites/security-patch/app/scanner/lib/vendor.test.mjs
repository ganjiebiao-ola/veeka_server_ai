import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { auditVendors, discoverVendors } from "./vendor.mjs"

const pkg = { name: "example/client", version: "1.2.3" }
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "vendor-test-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (path, data) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), typeof data === "string" ? data : JSON.stringify(data))
  }
  const git = args => {
    const result = spawnSync("git", ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
  }
  git(["init", "-q"])
  write("bundles/one/vendor/composer/installed.json", [pkg])
  write("bundles/two/vendor/composer/installed.json", { packages: [pkg] })
  write("bundles/two/composer.lock", { packages: [pkg], "packages-dev": [{ name: "example/test", version: "2.0.0" }] })
  write("restored/vendor/composer/installed.json", { packages: [pkg] })
  write("restored/composer.lock", { packages: [pkg], "packages-dev": [] })
  write(".gitignore", "restored/vendor/\n")
  write("unknown/vendor/client.php", "<?php echo 1;")
  write(".github/workflows/install.yml", "steps:\n  - run: composer install --working-dir=restored\n")
  git(["add", "."])
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"])
  return { root, write, git }
}

test("discovery covers committed and ignored trees, both metadata formats, locks, and missing metadata", t => {
  const { root } = fixture(t)
  rmSync(join(root, "bundles/two/vendor/composer/installed.json"))
  const { trees, errors } = discoverVendors(root)
  assert.deepEqual(errors, ["vendor-metadata-missing: unknown/vendor"])
  assert.deepEqual(trees.map(({ path, mode, lock, metadataSource }) => ({ path, mode, lock, metadataSource })), [
    { path: "bundles/one/vendor", mode: "committed", lock: "missing", metadataSource: "installed.json" },
    { path: "bundles/two/vendor", mode: "committed", lock: "present", metadataSource: "composer.lock" },
    { path: "restored/vendor", mode: "reinstalled", lock: "present", metadataSource: "installed.json" },
    { path: "unknown/vendor", mode: "committed", lock: "missing", metadataSource: "none" },
  ])
  assert.deepEqual(trees[0].packages, [pkg])
  assert.deepEqual(trees[1].packages, [pkg, { name: "example/test", version: "2.0.0" }])
})

test("discovery reports invalid lock metadata, keeps installed.json, and excludes symlinks", t => {
  const { root, write } = fixture(t)
  write("bundles/two/composer.lock", "{")
  symlinkSync(join(root, "bundles/one/vendor"), join(root, "vendor"))
  const { trees, errors } = discoverVendors(root)
  assert.equal(trees.find(tree => tree.path === "bundles/two/vendor").lock, "invalid")
  assert.equal(trees.length, 4)
  assert.equal(errors.length, 2)
})

test("discovery does not substitute lock versions when installed.json is invalid", t => {
  const { root, write } = fixture(t)
  write("restored/vendor/composer/installed.json", "{")
  const { trees, errors } = discoverVendors(root)
  const tree = trees.find(tree => tree.path === "restored/vendor")
  assert.equal(tree.lock, "present")
  assert.equal(tree.metadataSource, "installed.json")
  assert.deepEqual(tree.packages, [])
  assert.deepEqual(errors, ["vendor-metadata-invalid: installed.json for restored/vendor", "vendor-metadata-missing: unknown/vendor"])
})

const advisory = { advisoryId: "PKSA-test-one", cve: "CVE-2022-0001", title: "Example vulnerability", severity: "high", link: "https://example.com/advisory" }
test("audit preserves each advisory and merges every copy of the package version", t => {
  const { root } = fixture(t)
  const projects = []
  const report = auditVendors(root, (command, args, options) => {
    if (command === "git") return spawnSync(command, args, options)
    assert.equal(command, "composer")
    assert.ok(args.includes("--no-plugins") && args.includes("--no-scripts") && args.includes("--locked"))
    assert.notEqual(options.cwd, root)
    assert.equal(options.timeout, 120000)
    assert.equal(options.env.COMPOSER_HOME, options.cwd)
    assert.equal(options.env.HOME, options.cwd)
    assert.equal(options.env.COMPOSER_AUTH, undefined)
    assert.deepEqual(JSON.parse(readFileSync(join(options.cwd, "composer.json"), "utf8")), {
      name: "security-patch/audit", config: { "allow-plugins": false },
    })
    const lock = JSON.parse(readFileSync(join(options.cwd, "composer.lock"), "utf8"))
    assert.deepEqual(lock.packages[0], pkg)
    assert.deepEqual(lock["packages-dev"], [])
    projects.push(options.cwd)
    return { status: 1, stdout: JSON.stringify({ advisories: { [pkg.name]: { 0: advisory, 2: { advisoryId: "PKSA-test-two", title: "Another vulnerability" } } } }) }
  })
  assert.equal(projects.length, 3)
  assert.ok(projects.every(project => !existsSync(project)))
  assert.deepEqual(Object.keys(report).sort(), ["advisories", "errors", "trees"])
  assert.equal(report.advisories.length, 2)
  assert.deepEqual(report.advisories[0], {
    package: pkg.name, version: pkg.version,
    trees: ["bundles/one/vendor", "bundles/two/vendor", "restored/vendor"], ...advisory,
  })
  assert.deepEqual(report.advisories[1], {
    package: pkg.name, version: pkg.version, trees: report.advisories[0].trees,
    advisoryId: "PKSA-test-two", cve: null, title: "Another vulnerability", severity: null, link: null,
  })
  assert.deepEqual(report.errors, ["vendor-metadata-missing: unknown/vendor", "composer-metadata-missing: unknown/vendor"])
  assert.ok(report.trees.slice(0, 3).every(tree => tree.audit === "completed"))
  assert.equal(report.trees[3].audit, "skipped")
  assert.equal(spawnSync("git", ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout, "")
})

for (const failure of [
  { status: 1, stdout: "", stderr: "network error with credentials that must not be copied" },
  { status: null, error: { code: "ETIMEDOUT" } },
  { status: null, error: { code: "ENOENT" } },
  { status: 0, stdout: "{}" },
]) {
  test(`audit records failures and keeps scanning: ${JSON.stringify(failure.status)}/${failure.stdout ?? "timeout"}`, t => {
    const { root } = fixture(t)
    let calls = 0
    const report = auditVendors(root, (command, args, options) => {
      if (command === "git") return spawnSync(command, args, options)
      calls++
      return calls === 1 ? failure : { status: 0, stdout: '{"advisories":[]}' }
    })
    assert.equal(calls, 3)
    assert.equal(report.errors.length, 3)
    assert.ok(report.errors.every(error => !error.includes("credentials")))
    assert.deepEqual(report.advisories, [])
  })
}

test("audit keeps different versions separate and merges trees even when one copy fails audit", t => {
  const { root, write } = fixture(t)
  write("restored/vendor/composer/installed.json", { packages: [{ ...pkg, version: "2.0.0" }] })
  write("restored/composer.lock", { packages: [{ ...pkg, version: "2.0.0" }], "packages-dev": [] })
  let calls = 0
  const report = auditVendors(root, (command, args, options) => {
    if (command === "git") return spawnSync(command, args, options)
    calls++
    if (calls === 1) return { status: 1, stdout: "network failed" }
    return { status: 1, stdout: JSON.stringify({ advisories: { [pkg.name]: [advisory] } }) }
  })
  assert.deepEqual(report.advisories.map(row => [row.version, row.trees]), [
    ["1.2.3", ["bundles/one/vendor", "bundles/two/vendor"]],
    ["2.0.0", ["restored/vendor"]],
  ])
})

test("audit uses installed versions and reports lock version mismatches", t => {
  const { root, write } = fixture(t)
  const installed = { ...pkg, version: "1.0.0" }
  write("restored/vendor/composer/installed.json", { packages: [installed] })
  write("restored/composer.lock", { packages: [{ ...pkg, version: "2.0.0" }], "packages-dev": [] })
  const audited = []
  const report = auditVendors(root, (command, args, options) => {
    if (command === "git") return spawnSync(command, args, options)
    const lock = JSON.parse(readFileSync(join(options.cwd, "composer.lock"), "utf8"))
    audited.push(lock.packages)
    return { status: 1, stdout: JSON.stringify({ advisories: { [pkg.name]: [advisory] } }) }
  })
  const tree = report.trees.find(tree => tree.path === "restored/vendor")
  assert.equal(tree.lock, "present")
  assert.equal(tree.metadataSource, "installed.json")
  assert.deepEqual(tree.packages, [installed])
  assert.deepEqual(audited, [[pkg], [pkg], [installed]])
  assert.ok(report.errors.includes("vendor-version-mismatch: restored/vendor, example/client: installed 1.0.0, locked 2.0.0. Using installed version"))
  assert.deepEqual(report.advisories.find(row => row.version === "1.0.0").trees, ["restored/vendor"])
})

test("install evidence distinguishes tracked reinstalls, ignored copies, and uncertain commands", t => {
  const { root, write, git } = fixture(t)
  write("restore.sh", "composer --working-dir=bundles/one install --no-dev\n")
  write("loose/vendor/composer/installed.json", [pkg])
  write(".gitignore", "restored/vendor/\nloose/\n")
  git(["add", "."])
  let data = discoverVendors(root)
  assert.equal(data.trees.find(tree => tree.path === "bundles/one/vendor").mode, "reinstalled")
  assert.ok(data.trees.find(tree => tree.path === "bundles/one/vendor").evidence.some(value => value.includes("restore.sh:1")))
  assert.equal(data.trees.find(tree => tree.path === "loose/vendor").mode, "unknown")
  write("restore.sh", "composer install --working-dir=$DEST\n")
  data = discoverVendors(root)
  assert.equal(data.trees.find(tree => tree.path === "bundles/one/vendor").mode, "unknown")
  assert.ok(data.errors.includes("vendor-install-mode-unknown: bundles/one/vendor"))
})

test("metadata reads reject external symlinks, directories, and malformed packages without losing trees", t => {
  const { root, write } = fixture(t)
  const outside = mkdtempSync(join(tmpdir(), "vendor-outside-"))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  writeFileSync(join(outside, "installed.json"), JSON.stringify([pkg]))
  rmSync(join(root, "bundles/one/vendor/composer/installed.json"))
  symlinkSync(join(outside, "installed.json"), join(root, "bundles/one/vendor/composer/installed.json"))
  write("bundles/two/vendor/composer/installed.json", { packages: [{ name: "../../escape", version: "1.0" }] })
  rmSync(join(root, "restored/vendor/composer/installed.json"))
  mkdirSync(join(root, "restored/vendor/composer/installed.json"))
  const data = discoverVendors(root)
  assert.equal(data.trees.length, 4)
  for (const path of ["bundles/one/vendor", "bundles/two/vendor", "restored/vendor"]) {
    assert.deepEqual(data.trees.find(tree => tree.path === path).packages, [])
    assert.ok(data.errors.includes(`vendor-metadata-invalid: installed.json for ${path}`))
  }
})

test("a symlinked composer directory and an external lock cannot supply metadata", t => {
  const { root } = fixture(t)
  const outside = mkdtempSync(join(tmpdir(), "vendor-outside-"))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  writeFileSync(join(outside, "installed.json"), JSON.stringify([pkg]))
  writeFileSync(join(outside, "composer.lock"), JSON.stringify({ packages: [pkg] }))
  rmSync(join(root, "bundles/two/vendor/composer"), { recursive: true })
  symlinkSync(outside, join(root, "bundles/two/vendor/composer"))
  rmSync(join(root, "bundles/two/composer.lock"))
  symlinkSync(join(outside, "composer.lock"), join(root, "bundles/two/composer.lock"))
  const data = discoverVendors(root)
  const tree = data.trees.find(tree => tree.path === "bundles/two/vendor")
  assert.equal(tree.lock, "invalid")
  assert.deepEqual(tree.packages, [])
})

for (const [code, result] of [
  ["composer-missing", { error: { code: "ENOENT" }, status: null }],
  ["composer-timeout", { error: { code: "ETIMEDOUT" }, status: null }],
  ["composer-process-or-network", { status: 1, stdout: "", stderr: "could not resolve host with private credentials" }],
  ["composer-invalid-response", { status: 0, stdout: "{}" }],
]) test(`${code} is a named coverage gap and never stops the remaining trees`, t => {
  const { root } = fixture(t)
  let calls = 0
  const data = auditVendors(root, (command, args, options) => {
    if (command === "git") {
      assert.deepEqual(args.slice(0, 4), ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null"])
      return spawnSync(command, args, options)
    }
    return ++calls === 1 ? result : { status: 0, stdout: '{"advisories":[]}' }
  })
  assert.equal(calls, 3)
  assert.ok(data.errors.includes(`${code}: bundles/one/vendor`))
  assert.equal(data.trees[0].audit, "failed")
  assert.equal(data.trees[1].audit, "completed")
  assert.ok(!JSON.stringify(data).includes("private credentials"))
})

test("PHP's own -d flag before composer is not read as the working folder", t => {
  const { root, write, git } = fixture(t)
  write("Dockerfile", "RUN php -d memory_limit=-1 /usr/bin/composer.phar install\n")
  git(["add", "."])
  const tree = discoverVendors(root).trees.find(tree => tree.path === "bundles/one/vendor")
  assert.equal(tree.mode, "unknown")
  assert.ok(tree.evidence.some(value => value.startsWith("Dockerfile:1: Composer install/update has uncertain working directory")))
})

test("caps keep vendor.json small: too many packages, too many mismatches", t => {
  const { root, write } = fixture(t)
  const many = count => Array.from({ length: count }, (_, i) => ({ name: `example/p${i}`, version: "1.0.0" }))
  write("bundles/one/vendor/composer/installed.json", many(2001))
  write("bundles/two/vendor/composer/installed.json", many(60))
  write("bundles/two/composer.lock", { packages: many(60).map(pkg => ({ ...pkg, version: "2.0.0" })), "packages-dev": [] })
  const data = discoverVendors(root)
  assert.ok(data.errors.includes("vendor-metadata-invalid: installed.json for bundles/one/vendor"))
  const two = data.trees.find(tree => tree.path === "bundles/two/vendor")
  assert.equal(two.mismatches.length, 50)
  const mismatchErrors = data.errors.filter(error => error.startsWith("vendor-version-mismatch: bundles/two/vendor"))
  assert.equal(mismatchErrors.length, 51)
  assert.equal(mismatchErrors.at(-1), "vendor-version-mismatch: bundles/two/vendor: 10 more mismatches")
})

test("the audit stops starting trees once its time budget is spent", t => {
  const { root } = fixture(t)
  const times = [0, 0]
  const now = () => times.length ? times.shift() : 1e12
  let audits = 0
  const run = (command, args, options) => {
    if (command === "git") return spawnSync(command, args, options)
    audits++
    return { status: 0, stdout: JSON.stringify({ advisories: {} }) }
  }
  const data = auditVendors(root, run, now)
  assert.equal(audits, 1)
  assert.deepEqual(data.trees.filter(tree => tree.audit === "skipped" && tree.packages.length).map(tree => tree.path),
    ["bundles/two/vendor", "restored/vendor"])
  assert.ok(data.errors.includes("composer-budget-exceeded: restored/vendor"))
})
