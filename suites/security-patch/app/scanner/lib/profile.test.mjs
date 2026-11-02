import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { applies, applyOverride, appliesLine, detectProfile, phpMatches, scanCategories } from "./profile.mjs"

function repo(t, files) {
  const root = mkdtempSync(join(tmpdir(), "profile-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), content)
  }
  return root
}

test("pa-oversea files give PHP 7.2 and Phalcon, and vendor trees and docs do not count", t => {
  const profile = detectProfile(repo(t, {
    ".github/workflows/php_lint.yml": "run: docker run --rm php:7.2-cli php -v\n",
    "deploy/deploy_fpm.sh": "sudo systemctl reload php7.2-fpm\n",
    "deploy/nginx/nginx_settings.conf": "fastcgi_pass unix:/run/php/php7.2-fpm.sock;\n",
    "app/ImeeApplication.php": "<?php\nuse Phalcon\\Mvc\\Application;\n",
    "cli/libs/workerman/linux/README.md": "PHP 5.3 or Higher\n",
    "app/vendor/acme/Dockerfile": "FROM php:8.1-fpm\n",
    "app/vendor/acme/Kernel.php": "<?php\nuse Illuminate\\Foundation\\Application;\n",
  }))
  assert.equal(profile.language, "php")
  assert.equal(profile.php, "7.2")
  assert.equal(profile.framework, "phalcon")
  assert.deepEqual(profile.sources.map(s => s.file).sort(), [
    ".github/workflows/php_lint.yml", "app/ImeeApplication.php", "deploy/deploy_fpm.sh", "deploy/nginx/nginx_settings.conf",
  ])
})

test("no version source or disagreeing sources leave the PHP version empty for the operator", t => {
  assert.equal(detectProfile(repo(t, { "index.php": "<?php\n" })).php, "")
  const split = detectProfile(repo(t, { "index.php": "<?php\n", "Dockerfile": "FROM php:7.4-fpm\n", "deploy.sh": "apt install php8.1-cli\n" }))
  assert.equal(split.php, "")
  assert.deepEqual(split.sources.map(s => s.value).sort(), ["7.4", "8.1"])
})

test("composer gives the framework, and the lowest required PHP only without an exact source", t => {
  const composer = { require: { php: "^7.4 || ^8.0", "laravel/framework": "^8.0" } }
  assert.deepEqual(detectProfile(repo(t, { "composer.json": JSON.stringify(composer) })),
    { language: "php", php: "7.4", framework: "laravel", sources: [
      { field: "php", value: "7.4", file: "composer.json" }, { field: "framework", value: "laravel", file: "composer.json" }] })
  const pinned = detectProfile(repo(t, { "composer.json": JSON.stringify({ ...composer, config: { platform: { php: "8.1.2" } } }) }))
  assert.equal(pinned.php, "8.1")
})

test("a repo with no PHP files and no composer.json is not PHP", t => {
  assert.equal(detectProfile(repo(t, { "main.go": "package main\n", "Dockerfile": "FROM php:7.2\n" })).language, "")
})

test("operator values win, and invalid values are ignored", () => {
  const detected = { language: "php", php: "", framework: "phalcon", sources: [] }
  assert.deepEqual(applyOverride(detected, '{"php":"7.2"}'), { ...detected, php: "7.2", override: { php: "7.2", framework: "" } })
  assert.equal(applyOverride(detected, '{"php":"7.2; rm"}'), detected)
  assert.equal(applyOverride(detected, "not json"), detected)
  assert.equal(applyOverride(detected, undefined), detected)
})

test("PHP ranges and frameworks decide which types apply", () => {
  assert.ok(phpMatches("<8", "7.2"))
  assert.ok(!phpMatches("<8", "8.1"))
  assert.ok(phpMatches(">=7.0 <8", "7.4"))
  assert.ok(phpMatches("<8", ""))
  assert.throws(() => phpMatches("<eight", "7.2"))
  assert.ok(!applies({ framework: "phalcon" }, { php: "7.2", framework: "laravel" }))
  assert.ok(applies({ framework: "phalcon" }, { php: "7.2", framework: "" }))
})

test("the scan drops types that do not apply and keeps the selection otherwise", () => {
  const rules = { sqli: { php: "any", framework: "any" }, "loose-compare": { php: "<8", framework: "any" } }
  assert.equal(scanCategories("", { php: "8.1", framework: "" }, rules), "sqli")
  assert.equal(scanCategories("", { php: "7.2", framework: "" }, rules), "")
  assert.equal(scanCategories("", { php: "", framework: "" }, rules), "")
  assert.equal(scanCategories("loose-compare", { php: "8.1", framework: "" }, rules), null)
})

test("applies-to.json covers every bug type and matches the Applies to line in SKILL.md", () => {
  const skillDir = new URL("../../skill/ola-security-audit/", import.meta.url)
  const rules = JSON.parse(readFileSync(new URL("applies-to.json", skillDir), "utf8"))
  const types = readFileSync(new URL("../../shared/types.ts", import.meta.url), "utf8")
  const tokens = [...types.match(/VULN_CATEGORIES = \[([^\]]*)\]/)[1].matchAll(/"([^"]+)"/g)].map(m => m[1])
  assert.deepEqual(Object.keys(rules).sort(), [...tokens].sort())
  const mirror = readFileSync(new URL("../../frontend/src/types/events.ts", import.meta.url), "utf8")
  assert.deepEqual([...mirror.match(/VULN_CATEGORIES = \[([^\]]*)\]/)[1].matchAll(/"([^"]+)"/g)].map(m => m[1]), tokens, "frontend VULN_CATEGORIES must mirror shared/types.ts")
  const skill = readFileSync(new URL("SKILL.md", skillDir), "utf8")
  for (const token of tokens) {
    const section = skill.match(new RegExp(`\\| \`${token}\` \\| §(1\\.\\d+) \\|`))?.[1]
    assert.ok(section, `${token} is missing from the §0.3 table`)
    const block = skill.split(new RegExp(`^### ${section.replace(".", "\\.")} `, "m"))[1]?.split(/^### /m)[0] ?? ""
    assert.ok(block.includes(`- ${appliesLine(rules[token])}\n`), `§${section} Applies to line does not match applies-to.json for ${token}`)
    phpMatches(rules[token].php, "7.2")
  }
})
