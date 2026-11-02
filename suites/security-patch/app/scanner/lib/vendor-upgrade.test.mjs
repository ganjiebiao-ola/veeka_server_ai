import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { applyUpgrade, cliOptions, upgradeCheck } from "./vendor-upgrade.mjs"

const original = [{ name: "example/client", version: "1.0.0" }, { name: "example/helper", version: "1.0.0" }]
const resolved = [{ name: "example/client", version: "1.0.1" }, { name: "example/helper", version: "1.1.0" }]
const advisory = { advisoryId: "TEST-1", affectedVersions: "<1.0.1" }
const expected = { result: "installs", target: "1.0.1", moved: [
  { package: "example/client", from: "1.0.0", to: "1.0.1" },
  { package: "example/helper", from: "1.0.0", to: "1.1.0" },
] }
function write(root, file, value) {
  mkdirSync(join(root, file, ".."), { recursive: true })
  writeFileSync(join(root, file), typeof value === "string" ? value : JSON.stringify(value))
}
function fixture(reinstalled = false) {
  const repoDir = mkdtempSync(join(tmpdir(), "vendor-upgrade-test-"))
  write(repoDir, "sdk/vendor/composer/installed.json", { packages: original })
  write(repoDir, "sdk/vendor/example/client/Client.php", "old client")
  write(repoDir, "sdk/vendor/example/helper/Helper.php", "old helper")
  write(repoDir, "sdk/composer.json", { config: { platform: { php: "7.2.34" } }, autoload: { "psr-4": { "App\\": "src/" } } })
  write(repoDir, "sdk/src/Root.php", "root autoload source")
  write(repoDir, "sdk/composer.lock", { packages: original, "packages-dev": [], "content-hash": "root hash" })
  if (reinstalled) write(repoDir, "build.sh", "composer --working-dir=sdk install")
  spawnSync("git", ["init", "-q"], { cwd: repoDir })
  spawnSync("git", ["add", "."], { cwd: repoDir })
  return { repoDir, tree: "sdk/vendor", pkg: "example/client", version: "1.0.0" }
}
function fake(options = {}) {
  const calls = []
  let audits = 0
  let updates = 0
  const run = (command, args, settings) => {
    if (command === "git") return spawnSync(command, args, settings)
    calls.push({ args, settings })
    assert.equal(command, "composer")
    assert.equal(settings.timeout, 120000)
    assert.ok(args.includes("--no-scripts") && args.includes("--no-plugins"))
    assert.equal(settings.env.COMPOSER_ALLOW_SUPERUSER, "1")
    if (args.includes("audit")) {
      audits++
      if (options.badAudit === audits) return { status: 0, stdout: "garbled" }
      if (options.missingAudit === audits) return { status: 0, stdout: "{}" }
      const rows = audits === 1 || options.stillAffected ? { [options.majorOnly ? "guzzlehttp/guzzle" : "example/client"]: [advisory] } : {}
      return { status: Object.keys(rows).length ? 1 : 0, stdout: JSON.stringify({ advisories: rows }) }
    }
    if (args.includes("update")) {
      updates++
      const config = JSON.parse(readFileSync(join(settings.cwd, "composer.json")))
      if (options.majorOnly) {
        if (config.require["guzzlehttp/guzzle"].includes("^6.0")) return { status: 2, stderr: "No fixed version in range" }
        write(settings.cwd, "composer.lock", { packages: [{ name: "guzzlehttp/guzzle", version: "7.15.2" }, { name: "guzzlehttp/psr7", version: "2.13.0" }] })
        return { status: 0 }
      }
      assert.equal(config.config.platform.php, options.php ?? "7.2.34")
      const constraint = value => updates > 1 ? value.replace(", ^1.0", "") : value
      assert.equal(config.require["example/client"], constraint(options.clientConstraint ?? ">1.0.0, >=1.0.0, ^1.0"))
      assert.equal(config.require["example/helper"], constraint(options.helperConstraint ?? ">=1.0.0, ^1.0"))
      assert.equal(config.conflict["example/client"], options.clientConflict ?? "<1.0.1")
      if (options.otherConflict) assert.equal(config.conflict["example/other"], options.otherConflict)
      assert.ok(args.includes("--prefer-lowest") && args.includes("--no-install"))
      if (options.conflict) return { status: 2, stderr: "Dependency conflict: helper requires older client" }
      write(settings.cwd, "composer.lock", { packages: resolved, "packages-dev": [] })
      return { status: 0, stdout: "resolved" }
    }
    if (args.includes("install")) {
      if (options.installFailed) return { status: 1, stderr: "Download failed" }
      const config = JSON.parse(readFileSync(join(settings.cwd, "composer.json")))
      assert.deepEqual(config.autoload, { "psr-4": { "App\\": "src/" } })
      assert.equal(readFileSync(join(settings.cwd, "src/Root.php"), "utf8"), "root autoload source")
      write(settings.cwd, "vendor/example/client/Client.php", "new client")
      write(settings.cwd, "vendor/example/helper/Helper.php", "new helper")
      write(settings.cwd, "vendor/composer/installed.json", { packages: resolved })
      write(settings.cwd, "vendor/composer/autoload_psr4.php", "<?php return ['App\\\\' => [$baseDir . '/src']]")
      write(settings.cwd, "vendor/autoload.php", "generated loader")
      return { status: 0, stdout: "installed" }
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`)
  }
  return { run, calls }
}

test("upgradeCheck resolves all packages outside the repo and audits the result", () => {
  const options = fixture()
  const { run, calls } = fake()
  try {
    assert.deepEqual(upgradeCheck(options, run), expected)
    assert.equal(calls.filter(call => call.args.includes("audit")).length, 2)
    assert.ok(calls.every(call => !call.settings.cwd.startsWith(options.repoDir)))
    assert.ok(calls.every(call => !existsSync(call.settings.cwd)))
    assert.equal(readFileSync(join(options.repoDir, "sdk/vendor/example/client/Client.php"), "utf8"), "old client")
  } finally { rmSync(options.repoDir, { recursive: true, force: true }) }
})
for (const [name, settings, reason] of [
  ["conflict", { conflict: true }, /Dependency conflict/],
  ["resolved target remains affected", { stillAffected: true }, /still has an advisory: TEST-1/],
  ["invalid initial audit", { badAudit: 1 }, /audit output/],
  ["invalid final audit", { badAudit: 2 }, /audit output/],
  ["missing audit advisories", { missingAudit: 1 }, /Invalid Composer audit/],
]) test(`upgradeCheck blocks ${name}`, () => {
  const options = fixture()
  const { run, calls } = fake(settings)
  try {
    const result = upgradeCheck(options, run)
    assert.equal(result.result, "blocked")
    assert.match(result.blocker, reason)
    assert.ok(result.blocker.length <= 500)
    assert.ok(!calls.some(call => call.args.includes("install")))
  } finally { rmSync(options.repoDir, { recursive: true, force: true }) }
})
test("applyUpgrade replaces moved packages, metadata, autoload maps and adjacent lock", () => {
  const options = fixture()
  try {
    assert.deepEqual(applyUpgrade(options, fake().run), expected)
    const read = file => readFileSync(join(options.repoDir, file), "utf8")
    assert.equal(read("sdk/vendor/example/client/Client.php"), "new client")
    assert.equal(read("sdk/vendor/example/helper/Helper.php"), "new helper")
    assert.match(read("sdk/vendor/composer/autoload_psr4.php"), /App/)
    assert.equal(JSON.parse(read("sdk/vendor/composer/installed.json")).packages[0].version, "1.0.1")
    assert.equal(JSON.parse(read("sdk/composer.lock")).packages[1].version, "1.1.0")
    assert.equal(JSON.parse(read("sdk/composer.lock"))["content-hash"], "root hash")
    assert.equal(read("sdk/src/Root.php"), "root autoload source")
  } finally { rmSync(options.repoDir, { recursive: true, force: true }) }
})
test("applyUpgrade changes only the lock for reinstalled trees", () => {
  const options = fixture(true)
  const { run, calls } = fake()
  try {
    assert.deepEqual(applyUpgrade(options, run), expected)
    assert.ok(!calls.some(call => call.args.includes("install")))
    assert.equal(readFileSync(join(options.repoDir, "sdk/vendor/example/client/Client.php"), "utf8"), "old client")
    assert.equal(JSON.parse(readFileSync(join(options.repoDir, "sdk/composer.lock"))).packages[0].version, "1.0.1")
  } finally { rmSync(options.repoDir, { recursive: true, force: true }) }
})
test("a failed install leaves the committed tree untouched", () => {
  const options = fixture()
  try {
    assert.equal(applyUpgrade(options, fake({ installFailed: true }).run).result, "blocked")
    assert.equal(readFileSync(join(options.repoDir, "sdk/vendor/example/client/Client.php"), "utf8"), "old client")
    assert.equal(JSON.parse(readFileSync(join(options.repoDir, "sdk/composer.lock"))).packages[0].version, "1.0.0")
  } finally { rmSync(options.repoDir, { recursive: true, force: true }) }
})

for (const location of ["example/client", "example", "composer", "autoload.php", "../composer.lock"]) test(`applyUpgrade rejects symlink destination ${location}`, () => {
  const options = fixture()
  const outside = mkdtempSync(join(tmpdir(), "vendor-outside-"))
  try {
    write(outside, "sentinel", "untouched")
    const destination = join(options.repoDir, "sdk/vendor", location)
    rmSync(destination, { recursive: true, force: true })
    if (location === "../composer.lock") write(outside, "lock", { packages: original })
    symlinkSync(location === "../composer.lock" ? join(outside, "lock") : outside, destination)
    const result = applyUpgrade(options, fake().run)
    assert.equal(result.result, "blocked")
    assert.match(result.blocker, location === "../composer.lock" ? /metadata|Symlink/ : /Symlink/)
    assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "untouched")
    if (location !== "example") assert.equal(readFileSync(join(options.repoDir, "sdk/vendor/example/helper/Helper.php"), "utf8"), "old helper")
  } finally { rmSync(options.repoDir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) }
})

test("PHP platform ignores repo metadata and accepts an explicit override", () => {
  const options = fixture()
  try {
    write(options.repoDir, "sdk/composer.json", { config: { platform: { php: "8.4.0" } }, require: { php: ">=8.4" } })
    assert.deepEqual(upgradeCheck(options, fake().run), expected)
    assert.deepEqual(upgradeCheck({ ...options, php: "7.4.33" }, fake({ php: "7.4.33" }).run), expected)
  } finally { rmSync(options.repoDir, { recursive: true, force: true }) }
})

test("the CLI takes the PHP version from --php, else from REPO_PHP", () => {
  const args = ["--repo", "/r", "--tree", "sdk", "--package", "example/client", "--version", "1.0.1"]
  assert.equal(cliOptions(args, { REPO_PHP: "8.1" }).php, "8.1")
  assert.equal(cliOptions([...args, "--php", "7.4.33"], { REPO_PHP: "8.1" }).php, "7.4.33")
  assert.equal(cliOptions(args, { REPO_PHP: "" }).php, undefined)
  assert.equal(cliOptions(args, {}).php, undefined)
})

test("root package constraints survive resolution and conflicts leave the manifest untouched", () => {
  const options = fixture()
  try {
    const manifest = JSON.stringify({ require: { "example/client": "~1.0.0", "example/helper": "<1.1" } })
    write(options.repoDir, "sdk/composer.json", manifest)
    const settings = { clientConstraint: ">1.0.0, >=1.0.0, ^1.0, ~1.0.0", helperConstraint: ">=1.0.0, ^1.0, <1.1", conflict: true }
    assert.match(upgradeCheck(options, fake(settings).run).blocker, /Dependency conflict/)
    assert.equal(readFileSync(join(options.repoDir, "sdk/composer.json"), "utf8"), manifest)
  } finally { rmSync(options.repoDir, { recursive: true, force: true }) }
})

test("root conflict and require-dev constraints reach the resolver", () => {
  const options = fixture()
  try {
    write(options.repoDir, "sdk/composer.json", { "require-dev": { "example/helper": "<1.1" }, conflict: { "example/client": ">=1.1", "example/other": "*" } })
    const settings = { helperConstraint: ">=1.0.0, ^1.0, <1.1", clientConflict: ">=1.1 || <1.0.1", otherConflict: "*", conflict: true }
    assert.match(upgradeCheck(options, fake(settings).run).blocker, /Dependency conflict/)
  } finally { rmSync(options.repoDir, { recursive: true, force: true }) }
})

test("guzzle fixes available only in a new major are blocked without installing", () => {
  const options = fixture()
  try {
    const pkgs = [{ name: "guzzlehttp/guzzle", version: "6.3.3" }, { name: "guzzlehttp/psr7", version: "1.4.0" }]
    write(options.repoDir, "sdk/vendor/composer/installed.json", { packages: pkgs })
    write(options.repoDir, "sdk/composer.lock", { packages: pkgs })
    const { run, calls } = fake({ majorOnly: true })
    const result = applyUpgrade({ ...options, pkg: "guzzlehttp/guzzle", version: "6.3.3" }, run)
    assert.deepEqual(result, { result: "blocked", blocker: "fixed only in a new major: guzzlehttp/guzzle 7.15.2" })
    assert.equal(calls.filter(call => call.args.includes("update")).length, 2)
    assert.ok(!calls.some(call => call.args.includes("install")))
  } finally { rmSync(options.repoDir, { recursive: true, force: true }) }
})

for (const name of ["../client", "example/..", "Example/client", "example/a---b", "example/.client"]) test(`invalid package name is blocked: ${name}`, () => {
  const options = fixture()
  try {
    const pkgs = [{ name, version: "1.0.0" }]
    write(options.repoDir, "sdk/vendor/composer/installed.json", { packages: pkgs })
    write(options.repoDir, "sdk/composer.lock", { packages: pkgs })
    assert.equal(upgradeCheck({ ...options, pkg: name }, fake().run).result, "blocked")
  } finally { rmSync(options.repoDir, { recursive: true, force: true }) }
})


test("root OR constraints cannot bypass the major cap", () => {
  const options = fixture()
  try {
    write(options.repoDir, "sdk/composer.json", { require: { "example/client": "^1 || ^2" } })
    assert.deepEqual(upgradeCheck(options, fake({ clientConstraint: ">1.0.0, >=1.0.0, ^1.0, ^1 || >1.0.0, >=1.0.0, ^1.0, ^2" }).run), expected)
  } finally { rmSync(options.repoDir, { recursive: true, force: true }) }
})

test("zero-major packages retain their minor cap and new packages are allowed", () => {
  const options = fixture()
  try {
    const pkgs = [{ name: "example/client", version: "0.2.0" }, original[1]]
    write(options.repoDir, "sdk/vendor/composer/installed.json", { packages: pkgs })
    write(options.repoDir, "sdk/composer.lock", { packages: pkgs })
    const fallback = fake().run
    const run = (command, args, settings) => {
      if (command === "composer" && args.includes("update")) {
        const config = JSON.parse(readFileSync(join(settings.cwd, "composer.json")))
        assert.equal(config.require["example/client"], ">0.2.0, >=0.2.0, ^0.2")
        write(settings.cwd, "composer.lock", { packages: [{ name: "example/client", version: "0.2.1" }, original[1], { name: "example/new", version: "3.0.0" }] })
        return { status: 0 }
      }
      return fallback(command, args, settings)
    }
    const result = upgradeCheck({ ...options, version: "0.2.0" }, run)
    assert.equal(result.result, "installs")
    assert.deepEqual(result.moved.at(-1), { package: "example/new", from: null, to: "3.0.0" })
  } finally { rmSync(options.repoDir, { recursive: true, force: true }) }
})

for (const reinstalled of [true, false]) test(`apply preserves root dependencies absent from installed.json (reinstalled: ${reinstalled})`, () => {
  const options = fixture(reinstalled)
  const dev = { name: "example/dev-tool", version: "2.1.0" }
  const prod = { name: "example/root-tool", version: "3.1.0" }
  try {
    write(options.repoDir, "sdk/composer.json", { autoload: { "psr-4": { "App\\": "src/" } }, require: { [prod.name]: "^3" }, "require-dev": { [dev.name]: "^2" } })
    write(options.repoDir, "sdk/composer.lock", { packages: [...original, prod], "packages-dev": [dev] })
    const fallback = fake().run
    const run = (command, args, settings) => {
      if (command === "composer" && args.includes("update")) {
        const config = JSON.parse(readFileSync(join(settings.cwd, "composer.json")))
        assert.equal(config.require[prod.name], ">=3.1.0, ^3.0, ^3")
        assert.equal(config.require[dev.name] ?? config["require-dev"]?.[dev.name], ">=2.1.0, ^2.0, ^2")
        write(settings.cwd, "composer.lock", { packages: [...resolved, prod], "packages-dev": [dev] })
        return { status: 0 }
      }
      const result = fallback(command, args, settings)
      if (command === "composer" && args.includes("install")) {
        write(settings.cwd, "vendor/composer/installed.json", { packages: [...resolved, prod, dev] })
        write(settings.cwd, "vendor/example/root-tool/Tool.php", "root tool")
        write(settings.cwd, "vendor/example/dev-tool/Tool.php", "dev tool")
      }
      return result
    }
    assert.equal(applyUpgrade(options, run).result, "installs")
    const lock = JSON.parse(readFileSync(join(options.repoDir, "sdk/composer.lock")))
    assert.deepEqual(lock["packages-dev"], [dev])
    assert.ok(lock.packages.some(pkg => pkg.name === prod.name))
  } finally { rmSync(options.repoDir, { recursive: true, force: true }) }
})

test("apply moves a dev package to production when an upgraded production package requires it", () => {
  const options = fixture(true)
  const dev = { name: "example/dev-tool", version: "2.1.0" }
  try {
    write(options.repoDir, "sdk/composer.json", { "require-dev": { [dev.name]: "^2" } })
    write(options.repoDir, "sdk/composer.lock", { packages: original, "packages-dev": [dev] })
    const fallback = fake().run
    const run = (command, args, settings) => {
      if (command === "composer" && args.includes("update")) {
        const [client, ...rest] = resolved
        write(settings.cwd, "composer.lock", { packages: [{ ...client, require: { [dev.name]: "^2" } }, ...rest], "packages-dev": [dev] })
        return { status: 0 }
      }
      return fallback(command, args, settings)
    }
    assert.equal(applyUpgrade(options, run).result, "installs")
    const lock = JSON.parse(readFileSync(join(options.repoDir, "sdk/composer.lock")))
    assert.ok(lock.packages.some(pkg => pkg.name === dev.name))
    assert.deepEqual(lock["packages-dev"], [])
  } finally { rmSync(options.repoDir, { recursive: true, force: true }) }
})
