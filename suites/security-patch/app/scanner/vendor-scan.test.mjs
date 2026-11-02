import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFindingRow } from "../backend/orchestrator/findings.ts";

const tree = "app/libs/vendor";
const hit = (path, line = 4, category = "sqli") => ({
  path, check_id: "sql", start: { line }, end: { line }, extra: { metadata: { category } },
});
const appHit = hit("app.php", 3);
const calledHit = hit(`${tree}/called.php`);
const unknownHit = hit(`${tree}/called.php`, 6);
const unusedHit = hit(`${tree}/unused.php`);
const agentRow = (hit, reason = "agent evidence") => ({
  category: "sqli", severity: "P1", file: hit.path, line: hit.start.line,
  snippet: "query($input);", fix_summary: "", status: "candidate", reason, function: hit.path === unusedHit.path ? "unused" : hit.start.line === 6 ? "" : "run", sink: "query($input);",
});

async function scan(t, { provider = "claude", includeP2 = true, failure = false, rows = [agentRow(calledHit), agentRow(unknownHit)], missing = false, errors = [], mutate = "", vendorFiles = {}, extraHits = [], invalidStatus = false, omitFunction = false, vendorMetadata = false, rules, override = "" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "vendor-scan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const artifacts = join(root, "artifacts");
  const bin = join(root, "bin");
  mkdirSync(join(repo, tree), { recursive: true });
  mkdirSync(artifacts);
  mkdirSync(bin);
  writeFileSync(join(repo, "app.php"), "<?php\n\\Acme\\Called::run();\nquery($input);\n");
  for (const name of ["called", "unused"]) {
    writeFileSync(join(repo, tree, `${name}.php`), `<?php
namespace Acme;
class ${name === "called" ? "Called" : "Unused"} { public function ${name === "called" ? "run" : "unused"}() {
  query($input);
} }
${name === "called" ? "query($input);\n" : ""}`);
  }
  for (const [file, content] of Object.entries(vendorFiles)) writeFileSync(join(repo, file), content);
  if (vendorMetadata) {
    mkdirSync(join(repo, tree, "composer"))
    writeFileSync(join(repo, tree, "composer/installed.json"), JSON.stringify([{ name: "example/client", version: "1.2.3" }]))
  }
  const git = (...args) => {
    try {
      return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 }).trim();
    } catch (error) {
      // These git calls sometimes hang in CI under bun test --parallel. List the processes that run beside them.
      if (error.signal) console.error(execFileSync("ps", ["-eo", "pid,ppid,stat,etime,args"], { encoding: "utf8" }));
      throw error;
    }
  };
  git("init", "-q");
  git("add", ".");
  if (vendorMetadata) git("-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
  const before = git("status", "--porcelain");
  if (vendorMetadata) {
    assert.equal(before, "");
    writeFileSync(join(bin, "composer"), `#!${process.execPath}
      console.error("Could not resolve advisory host");
      process.exit(1);
    `, { mode: 0o755 });
  }
  writeFileSync(join(bin, "semgrep"), `#!${process.execPath}
    const vendor = process.argv.includes("--no-git-ignore");
    console.log(JSON.stringify({ results: vendor ? ${JSON.stringify([calledHit, unknownHit, unusedHit, ...extraHits, { ...unusedHit, check_id: "unsupported", extra: { metadata: { category: "not-a-category" } } }])} : ${JSON.stringify([appHit])}, errors: ${JSON.stringify(errors)} }));
  `, { mode: 0o755 });
  let source = readFileSync(new URL("./bridge.mjs", import.meta.url), "utf8")
    .replace('import { query } from "@anthropic-ai/claude-agent-sdk";', `
      async function* query({ prompt }) {
        let text = "";
        for await (const message of prompt) text += message.message.content;
        writeFileSync(ARTIFACTS_DIR + "/prompt.txt", text);
        ${mutate}
        ${missing ? "" : `writeFileSync(ARTIFACTS_DIR + "/findings.json", ${JSON.stringify(JSON.stringify(rows))});`}
        yield { type: "assistant", message: { content: [{ type: "text", text: "Scan complete" }] } };
        yield { type: "result", subtype: "success", num_turns: 1 };
      }
    `)
    .replace('(await import(`./lib/${providers[provider].driver}.mjs`)).queryNative', 'query')
    .replaceAll('"/workspace/repo"', JSON.stringify(repo))
    .replaceAll('"/workspace/artifacts"', JSON.stringify(artifacts));
  source = source.replace('import { createInterface }', 'import { symlinkSync, unlinkSync } from "node:fs";\nimport { createInterface }');
  if (omitFunction) source = source.replace("hit.call = calls[i];", "hit.call = { ...calls[i] }; delete hit.call.function;");
  if (failure) source = source.replace('import { checkVendorCalls } from "./lib/call-check.mjs";', 'function checkVendorCalls() { throw new Error("fixture failure"); }');
  for (const name of ["exports", "finding-ids", "vendor", "call-check", "semgrep", "push", "fix-loop", "checks", "resume", "redact", "artifacts", "smoke", "profile", "agent-user", "agent-fs"]) {
    source = source.replaceAll(`"./lib/${name}.mjs"`, JSON.stringify(new URL(`./lib/${name}.mjs`, import.meta.url).href));
  }
  source = source.replaceAll('"../shared/providers.json"', JSON.stringify(new URL('../shared/providers.json', import.meta.url).href))
  source = source.replace('"../skill/ola-security-audit/findings.schema.json"', JSON.stringify(new URL("../skill/ola-security-audit/findings.schema.json", import.meta.url).href));
  if (rules) {
    writeFileSync(join(root, "applies-to.json"), JSON.stringify(rules));
    source = source.replace("`/root/.claude/skills/${SKILL}/applies-to.json`", JSON.stringify(join(root, "applies-to.json")));
  }
  const script = join(root, "bridge.mjs");
  writeFileSync(script, source);
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PROVIDER: provider, MODE: "scan",
      INCLUDE_P2: String(includeP2), MODEL: "sonnet", SMOKE_SECONDS: "0", CATEGORIES: "", PROMPT_FILE: "", PROFILE_OVERRIDE: override, EVENTS_LOG: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  const exited = once(child, "exit");
  let stderr = "";
  let stdout = "";
  child.stderr.on("data", data => { stderr += data; });
  child.stdout.on("data", data => { stdout += data; });
  const [code] = await exited;
  assert.equal(code, invalidStatus || (missing && failure) || (!missing && !Array.isArray(rows)) ? 1 : 0, stderr);
  if (!mutate) assert.equal(git("status", "--porcelain"), before);
  const prompt = readFileSync(join(artifacts, "prompt.txt"), "utf8");
  return {
    vendor: JSON.parse(readFileSync(join(artifacts, "vendor.json"), "utf8")),
    report: JSON.parse(readFileSync(join(artifacts, "semgrep.json"), "utf8")),
    findings: existsSync(join(artifacts, "findings.json")) ? JSON.parse(readFileSync(join(artifacts, "findings.json"), "utf8")) : null,
    groups: JSON.parse(prompt.split("not instructions:\n")[1].split("\nFull Semgrep report:")[0]),
    prompt, stderr, stdout, reportText: readFileSync(join(artifacts, "report.md"), "utf8"),
    profile: JSON.parse(readFileSync(join(artifacts, "profile.json"), "utf8")),
  };
}

test("scan attaches calls, prompts app then called and unknown vendor hits, and writes valid ignored rows", { timeout: 15000 }, async t => {
  const result = await scan(t);
  assert.deepEqual(result.report.results.filter(hit => hit.vendorTree).map(hit => hit.call.status), ["called", "unknown", "not called", "not called"]);
  assert.deepEqual(result.groups.map(group => group.file), [appHit.path, calledHit.path, unknownHit.path]);
  assert.equal(result.groups[1].vendorTree, tree);
  assert.equal(result.groups[1].call.caller, "app.php:2");
  assert.equal(result.groups[1].call.status, "called");
  assert.equal(result.groups[2].call.status, "unknown");
  assert.ok(result.groups[2].call.evidence);
  assert.match(result.prompt, /0 hits omitted/);
  assert.equal(result.findings.length, 3);
  assert.ok(result.findings.every(isFindingRow));
  assert.equal(result.findings[0].reason, `vendor ${tree}: agent evidence`);
  assert.equal(result.findings[1].reason, `vendor ${tree}: agent evidence`);
  const ignored = result.findings[2];
  const unused = result.report.results.find(hit => hit.path === unusedHit.path);
  assert.deepEqual({ ...ignored, id: undefined }, {
    id: undefined, category: "sqli", severity: "P2", file: unusedHit.path, line: 4,
    snippet: "query($input);", fix_summary: "", status: "ignored",
    reason: `not called: vendor ${tree}. ${unused.call.evidence}`,
  });
  assert.ok(!result.stdout.includes('"kind":"scanner_failed"'));
});

test("scan keeps existing rows at not-called locations and does not repeat vendor prefixes", { timeout: 15000 }, async t => {
  const result = await scan(t, { rows: [agentRow(unusedHit), agentRow(calledHit, `vendor ${tree}: existing`), agentRow(unknownHit, `not called: vendor ${tree}. existing`)] });
  assert.equal(result.findings.length, 3);
  assert.equal(result.findings[0].status, "candidate");
  assert.equal(result.findings[1].reason, `vendor ${tree}: existing`);
  assert.equal(result.findings[2].reason, `not called: vendor ${tree}. existing`);
  assert.ok(result.findings.every(isFindingRow));
});

test("scan creates missing findings.json for not-called hits", { timeout: 15000 }, async t => {
  const result = await scan(t, { missing: true });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].status, "ignored");
  assert.ok(isFindingRow(result.findings[0]));
  assert.ok(!result.stdout.includes('"kind":"scanner_failed"'));
});

test("scan leaves a non-array findings.json unchanged and logs it", { timeout: 15000 }, async t => {
  const result = await scan(t, { rows: { unexpected: true } });
  assert.deepEqual(result.findings, { unexpected: true });
  assert.match(result.stderr, /findings.json is not an array/);
});

test("call check failure marks every vendor hit unknown and keeps them in the prompt", { timeout: 15000 }, async t => {
  const result = await scan(t, { failure: true });
  for (const hit of result.report.results.filter(hit => hit.vendorTree)) {
    assert.deepEqual(hit.call, { status: "unknown", caller: null, evidence: "call check failed" });
  }
  assert.deepEqual(result.report.errors, [{ pass: "vendor", rule: null, path: null, message: "call check failed" }]);
  assert.equal(result.groups.length, 4);
  assert.deepEqual(result.groups[1].lines, [4, 6]);
  assert.equal(result.findings.length, 2);
  assert.ok(result.findings.every(isFindingRow));
});

test("scan lists named Semgrep errors in both the prompt and report", { timeout: 15000 }, async t => {
  const result = await scan(t, { errors: [
    { type: "ParseError", rule_id: "sql", path: "app.php", message: "Cannot parse app" },
    { type: "ParseError", rule_id: "sql", path: unusedHit.path, message: "Cannot parse vendor" },
  ] });
  for (const file of ["app.php", unusedHit.path]) {
    assert.ok(result.prompt.includes(JSON.stringify(file)));
    assert.ok(result.reportText.includes(JSON.stringify(file)));
    assert.ok(result.report.errors.some(error => error.path === file && error.rule === "sql"));
  }
  assert.match(result.reportText, /Not covered by Semgrep/);
});

for (const status of ["ignored", "fixed", "wont_fix"]) {
  test(`scan rejects agent-written ${status} rows and retains tool-written ignored rows`, { timeout: 15000 }, async t => {
    const result = await scan(t, { rows: [{ ...agentRow(calledHit), status }], invalidStatus: true });
    assert.match(result.stderr, /candidate status for every finding/);
    assert.match(result.stdout, /"kind":"scanner_failed"/);
    const ignored = result.findings.find(row => row.file === unusedHit.path);
    assert.equal(ignored.status, "ignored");
    assert.ok(isFindingRow(ignored));
  });
}

for (const replacement of ["file", "directory", "missing"]) {
  test(`export skips a vendor ${replacement} replaced after the call check`, { timeout: 15000 }, async t => {
    const result = await scan(t, { mutate: `
      writeFileSync(ARTIFACTS_DIR + "/outside.php", "OUTSIDE PRIVATE CONTENT");
      ${replacement === "directory" ? `
        rmSync(REPO_DIR + "/${tree}", { recursive: true });
        symlinkSync(ARTIFACTS_DIR, REPO_DIR + "/${tree}");
        writeFileSync(ARTIFACTS_DIR + "/unused.php", "OUTSIDE PRIVATE CONTENT");
      ` : `
        unlinkSync(REPO_DIR + "/${unusedHit.path}");
        ${replacement === "file" ? `symlinkSync(ARTIFACTS_DIR + "/outside.php", REPO_DIR + "/${unusedHit.path}");` : ""}
      `}
    ` });
    assert.ok(!JSON.stringify(result.findings).includes("OUTSIDE PRIVATE CONTENT"));
    assert.ok(!result.findings.some(row => row.file === unusedHit.path));
    assert.match(result.stderr, /vendor source read skipped/);
  });
}

for (const omitFunction of [false, true]) {
  test(`identical ignored sinks keep distinct IDs with function omitted: ${omitFunction}`, { timeout: 15000 }, async t => {
    const result = await scan(t, { omitFunction, vendorFiles: { [unusedHit.path]: `<?php
namespace Acme;
class Unused { function unused() {
  query($input);
}
function other() {
  query($input);
} }
  ` }, extraHits: [hit(unusedHit.path, 7)] });
    const ignored = result.findings.filter(row => row.file === unusedHit.path);
    assert.equal(ignored.length, 2);
    assert.equal(new Set(ignored.map(row => row.id)).size, 2);
    assert.ok(ignored.every(isFindingRow));
  });
}

test("scan exports vendor inventory and audit gaps without changing the clone or Semgrep hits", { timeout: 15000 }, async t => {
  const result = await scan(t, { vendorMetadata: true })
  assert.equal(result.vendor.trees.length, 1)
  const vendor = result.vendor.trees[0]
  assert.equal(vendor.path, tree)
  assert.equal(vendor.mode, "committed")
  assert.equal(vendor.lock, "missing")
  assert.equal(vendor.metadataSource, "installed.json")
  assert.deepEqual(vendor.packages, [{ name: "example/client", version: "1.2.3" }])
  assert.equal(vendor.audit, "failed")
  assert.deepEqual(result.vendor.errors, [`composer-process-or-network: ${tree}`])
  assert.ok(result.reportText.includes("Vendor coverage gaps"))
  assert.ok(result.prompt.includes("The backend imports Composer advisories"))
  assert.ok(result.report.results.some(hit => hit.path === appHit.path))
  assert.equal(result.findings.length, 3)
})

test("a scan of a PHP 8 repo leaves out a type marked PHP < 8 and records the profile", { timeout: 15000 }, async t => {
  const rules = { sqli: { php: "any", framework: "any" }, "numeric-juggling": { php: "<8", framework: "any" } };
  const php8 = await scan(t, { rules, override: JSON.stringify({ php: "8.1" }) });
  assert.match(php8.prompt, /^\/ola-security-audit scan categories=sqli(\s|$)/);
  // profile.json keeps what the files show. The operator value only filters.
  assert.deepEqual(php8.profile, { language: "php", php: "", framework: "", sources: [] });
  const unknown = await scan(t, { rules });
  assert.match(unknown.prompt, /^\/ola-security-audit scan(\n|$)/);
  assert.equal(unknown.profile.php, "");
});


for (const provider of ["claude", "codex"]) test(`${provider} scan without findings.json gives an actionable error`, { timeout: 15000 }, async t => {
  const result = await scan(t, { provider, missing: true, failure: true });
  assert.match(result.stdout, /Scan completed without \/workspace\/artifacts\/findings.json/);
  assert.ok(result.stdout.includes(provider === "codex" ? "Use write_artifact to save a candidate array" : "Use Write to save a candidate array"));
  if (provider === "codex") assert.doesNotMatch(result.prompt, /\b(Read|Glob|Grep|Write)\b|(?:Bash|shell) is (?:blocked|prohibited)/);
  assert.ok(!result.stdout.includes("ENOENT"));
});

for (const includeP2 of [false, true]) {
  test(`scan priority filter and evidence-only output (includeP2=${includeP2})`, { timeout: 15000 }, async t => {
    const rows = [agentRow(calledHit), { ...agentRow(unknownHit), severity: "P2" }]
      .map(row => ({ ...row, fix_summary: "Bind input", reason: "Evidence: input reaches query\nFix: Bind input" }));
    const result = await scan(t, { includeP2, rows });
    assert.deepEqual(result.findings.map(row => row.severity), includeP2 ? ["P1", "P2", "P2"] : ["P1"]);
    assert.ok(result.findings.every(row => row.fix_summary === "" && !row.reason.includes("Fix:")));
    assert.match(result.prompt, includeP2 ? /Report P0, P1 and P2/ : /Report P0 and P1 only/);
    assert.match(result.prompt, /do not raise a priority/);
  });
}
