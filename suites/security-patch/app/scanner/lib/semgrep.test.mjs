import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterIgnoredHits, runSemgrep, runVendorSemgrep } from "./semgrep.mjs";
import { findVendorTrees, vendorTreeForPath } from "./vendor.mjs";

const hit = (line, category = "sqli") => ({ path: "test.php", start: { line }, extra: { metadata: { category } } });
test("ignore markers require a matching category and reason on the sink line or previous line", () => {
  const source = [
    '<?php // security-patch: ignore sqli — trusted input',
    '$db->query($sql);',
    '$db->query($sql); // security-patch: ignore sqli — trusted input',
    '$db->query($sql);',
    '$db->query($sql);',
    '// security-patch: ignore sqli —',
    '$db->query($sql);',
    '// security-patch: ignore cmd-injection — constant command',
    '$db->query($sql);',
    '$text = "// security-patch: ignore sqli — text";',
    '$db->query($sql);',
    '/* // security-patch: ignore sqli — block comment */',
    '$db->query($sql);',
  ].join('\n');
  const report = { results: [2, 3, 4, 5, 7, 9, 11, 13].map((n) => hit(n)), errors: [] };
  const filtered = filterIgnoredHits(report, "/repo", [], () => source);
  assert.deepEqual(filtered.results.map((h) => h.start.line), [5, 7, 9, 11, 13]);
  assert.deepEqual(filtered.errors, []);
  assert.deepEqual(filterIgnoredHits(report, "/repo", ["deserialization"], () => source).results, []);
  assert.throws(() => filterIgnoredHits({ results: [{ ...hit(1), path: "../outside.php" }] }, "/repo"));
});

test("strings across lines and heredoc text cannot act as ignore markers", () => {
  const source = [
    '<?php $text = "',
    '// security-patch: ignore sqli — string text',
    '";',
    "$text = <<<'TEXT'",
    '// security-patch: ignore sqli — heredoc text',
    'TEXT;',
    '// security-patch: ignore sqli — actual comment',
    '$db->query($sql);',
  ].join('\n');
  const results = filterIgnoredHits({ results: [2, 3, 5, 6, 8].map((n) => hit(n)) }, "/repo", [], () => source).results;
  assert.deepEqual(results.map((h) => h.start.line), [2, 3, 5, 6]);
});

test("inline HTML markers do not suppress PHP sinks", () => {
  const source = '// security-patch: ignore sqli — HTML text\n<?php query($sql);\n// security-patch: ignore sqli — PHP comment\nquery($sql); ?>\n// security-patch: ignore sqli — more HTML\n<?php query($sql);';
  assert.deepEqual(filterIgnoredHits({ results: [2, 4, 6].map((n) => hit(n)) }, "/repo", [], () => source).results.map((h) => h.start.line), [2, 6]);
});

for (const [kind, result] of [
  ["exit error", { status: 2 }],
  ["timeout", { error: Object.assign(new Error(), { code: "ETIMEDOUT" }) }],
  ["maxBuffer overflow", { error: Object.assign(new Error(), { code: "ENOBUFS" }) }],
  ["malformed JSON", { status: 0, stdout: "{" }],
  ["invalid report", { status: 0, stdout: "{}" }],
  ["spawn exception", null],
]) {
  test(`pre-pass continues after ${kind}`, (t) => {
    const original = childProcess.spawnSync;
    childProcess.spawnSync = () => { if (!result) throw new Error("spawn failed"); return result; };
    syncBuiltinESMExports();
    t.after(() => { childProcess.spawnSync = original; syncBuiltinESMExports(); });
    const logs = [];
    t.mock.method(console, "error", (line) => logs.push(line));
    const report = runSemgrep("/repo", "/rules");
    assert.deepEqual(report.results, []);
    assert.deepEqual(report.errors, [{ pass: "app", rule: null, path: null,
      message: "Semgrep pre-pass failed. Continue with your own source search." }]);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].split("\n").length, 1);
  });
}

function fixture(t, body) {
  const root = mkdtempSync(join(tmpdir(), "semgrep-vendor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  mkdirSync(repo);
  mkdirSync(join(repo, "vendor"));
  writeFileSync(join(repo, "vendor/client.php"), "<?php query($sql);");
  writeFileSync(join(repo, "app.php"), "<?php query($sql);");
  const log = join(root, "calls.jsonl");
  writeFileSync(join(root, "semgrep"), `#!${process.execPath}
    const { appendFileSync } = require("node:fs");
    const args = process.argv.slice(2);
    appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
    const vendor = args.includes("--no-git-ignore");
    ${body}
  `, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = root + ":" + previousPath;
  t.after(() => { process.env.PATH = previousPath; });
  return { repo, log };
}

const appHit = { ...hit(1), check_id: "sql", path: "app.php", end: { line: 1, col: 12 } };
const vendorHit = { ...appHit, path: "vendor/client.php" };

test("vendor pass keeps app arguments and hits, targets only trees, marks and deduplicates vendor hits", t => {
  const { repo, log } = fixture(t, `
    const results = vendor ? ${JSON.stringify([vendorHit, { ...vendorHit, end: { col: 12, line: 1 } }, appHit])} : ${JSON.stringify([appHit])};
    console.log(JSON.stringify({ results, errors: [], paths: { scanned: results.map(hit => hit.path) } }));
  `);
  const app = runSemgrep(repo, "/rules", "sqli");
  const before = structuredClone(app);
  const report = runVendorSemgrep(repo, "/rules", "sqli", ["vendor"], app);
  const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls[0], ["scan", "--config", "/rules", "--json", "--metrics=off", "--disable-version-check", "--timeout", "5", "."]);
  assert.deepEqual(calls[1], ["scan", "--config", "/rules", "--json", "--metrics=off", "--disable-version-check", "--timeout", "5",
    "--x-ignore-semgrepignore-files", "--no-git-ignore", "--exclude", "node_modules", "--exclude", "build", "--exclude", "dist", "--", "./vendor"]);
  assert.deepEqual(app, before);
  assert.deepEqual(report.results, [appHit, { ...vendorHit, vendorTree: "vendor" }]);
  assert.deepEqual(report.paths.scanned, ["app.php", "vendor/client.php"]);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(runSemgrep(repo, "/rules", "sqli", ["app.php"]).results, [appHit]);
  assert.deepEqual(JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1)).slice(-3), ["--timeout", "5", "app.php"]);
});

test("app hits from vendor paths stay app hits and duplicates from the vendor pass are dropped", t => {
  const { repo } = fixture(t, `console.log(JSON.stringify({ results: [${JSON.stringify(vendorHit)}], errors: [] }));`);
  const app = runSemgrep(repo, "/rules");
  assert.deepEqual(runVendorSemgrep(repo, "/rules", "", ["vendor"], app).results, [vendorHit]);
});

for (const failure of ["exit", "crash", "invalid JSON", "timeout"]) {
  test(`vendor ${failure} preserves app hits and errors`, async t => {
    const { repo } = fixture(t, `
      if (vendor) {
        ${failure === "exit" ? "process.exit(2);" : failure === "crash" ? 'process.kill(process.pid, "SIGKILL");' : failure === "invalid JSON" ? 'console.log("{"); process.exit(0);' : 'while (true) {}'}
      }
      console.log(JSON.stringify({ results: [${JSON.stringify(appHit)}], errors: [] }));
    `);
    const app = runSemgrep(repo, "/rules");
    app.errors.push({ pass: "app", rule: "sql", path: "app.php", message: "Timeout" });
    const before = structuredClone(app);
    let run = runVendorSemgrep;
    if (failure === "timeout") {
      const source = readFileSync(new URL("./semgrep.mjs", import.meta.url), "utf8");
      assert.match(source, /timeout: 120000/);
      const script = join(repo, "../short-timeout.mjs");
      // Exercise a real process timeout without waiting two minutes.
      writeFileSync(script, source.replace("timeout: 120000", "timeout: 50")
        .replace('"./vendor.mjs"', JSON.stringify(new URL("./vendor.mjs", import.meta.url).href)).replace('"./agent-user.mjs"', JSON.stringify(new URL("./agent-user.mjs", import.meta.url).href)).replace('"./agent-fs.mjs"', JSON.stringify(new URL("./agent-fs.mjs", import.meta.url).href)));
      run = (await import(script)).runVendorSemgrep;
    }
    const report = run(repo, "/rules", "", ["vendor"], app);
    assert.deepEqual(report.results, [appHit]);
    assert.deepEqual(app, before);
    assert.deepEqual(report.errors, [...app.errors, { pass: "vendor", rule: null, path: null,
      message: "Semgrep pre-pass failed. Continue with your own source search." }]);
  });
}

test("both passes normalize Semgrep rule errors, absolute paths, and pathless errors", t => {
  const { repo } = fixture(t, `console.log(JSON.stringify({ results: [], errors: [
    { type: "Timeout", rule_id: "sql", path: process.cwd() + "/" + (vendor ? "vendor/client.php" : "app.php"), message: "Rule timed out\\nretry" },
    { type: "ParseError", check_id: "parse", location: { path: "./app.php" } },
    { type: "InvalidRuleSchemaError" },
    { type: "ParseError", path: "../outside.php" }
  ] }));`);
  const app = runSemgrep(repo, "/rules");
  const report = runVendorSemgrep(repo, "/rules", "", ["vendor"], app);
  assert.deepEqual(report.errors, ["app", "vendor"].flatMap(pass => [
    { pass, rule: "sql", path: pass === "app" ? "app.php" : "vendor/client.php", message: "Rule timed out retry", retried: true },
    { pass, rule: "parse", path: "app.php", message: "ParseError" },
    { pass, rule: null, path: null, message: "InvalidRuleSchemaError" },
    { pass, rule: null, path: null, message: "ParseError" },
  ]));
});

test("an empty vendor inventory adds no Semgrep process", () => {
  const report = { results: [appHit], errors: [] };
  assert.equal(runVendorSemgrep("/repo", "/rules", "", [], report), report);
});

test("a nonzero pass keeps Semgrep file errors without accepting its partial hits", t => {
  const { repo } = fixture(t, `
    console.log(JSON.stringify({ results: [${JSON.stringify(appHit)}], errors: [
      { type: "ParseError", path: "app.php", rule_id: "sql", message: "Cannot parse file" }
    ] }));
    process.exitCode = 2;
  `);
  for (const pass of ["app", "vendor"]) {
    const report = pass === "app" ? runSemgrep(repo, "/rules")
      : runVendorSemgrep(repo, "/rules", "", ["vendor"], { results: [], errors: [] });
    assert.deepEqual(report.results, []);
    assert.deepEqual(report.errors, [
      { pass, rule: "sql", path: "app.php", message: "Cannot parse file" },
      { pass, rule: null, path: null, message: "Semgrep pre-pass failed. Continue with your own source search." },
    ]);
  }
});

test("vendor discovery finds tracked, reinstalled, empty, and nested trees, skipping .git and symlinks", t => {
  const { repo } = fixture(t, 'console.log(JSON.stringify({ results: [], errors: [] }));');
  const git = (...args) => childProcess.execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  mkdirSync(join(repo, "tracked/vendor"), { recursive: true });
  writeFileSync(join(repo, "tracked/vendor/tracked.php"), "<?php");
  git("add", ".");
  unlinkSync(join(repo, "tracked/vendor/tracked.php"));
  // The index still names a committed tree even when its working copy is missing.
  rmSync(join(repo, "tracked"), { recursive: true });
  for (const path of ["ignored/vendor", "empty/vendor", "vendor/package/vendor", ".git/vendor", "vendor-name"]) {
    mkdirSync(join(repo, path), { recursive: true });
  }
  writeFileSync(join(repo, ".git/info/exclude"), "ignored/\n");
  symlinkSync(join(repo, "vendor"), join(repo, "linked"));
  symlinkSync(join(repo, "vendor"), join(repo, "vendor-name/vendor"));
  assert.deepEqual(findVendorTrees(repo), ["empty/vendor", "ignored/vendor", "tracked/vendor", "vendor", "vendor/package/vendor"]);
  assert.equal(vendorTreeForPath("./vendor/package/vendor/file.php", repo, findVendorTrees(repo)), "vendor/package/vendor");
  assert.equal(vendorTreeForPath("vendor-name/file.php", repo, ["vendor"]), undefined);
  assert.equal(vendorTreeForPath("../vendor/file.php", repo, ["vendor"]), undefined);
});

test("the vendor pass leaves git status empty", t => {
  const { repo } = fixture(t, `console.log(JSON.stringify({ results: vendor ? [${JSON.stringify(vendorHit)}] : [${JSON.stringify(appHit)}], errors: [] }));`);
  const git = (...args) => childProcess.execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=test", "-c", "user.email=test@example.local", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  mkdirSync(join(repo, "ignored/vendor"), { recursive: true });
  writeFileSync(join(repo, "ignored/vendor/reinstalled.php"), "<?php");
  writeFileSync(join(repo, ".git/info/exclude"), "ignored/\n");
  assert.equal(git("status", "--porcelain"), "");
  const trees = findVendorTrees(repo);
  assert.deepEqual(trees, ["ignored/vendor", "vendor"]);
  const report = runVendorSemgrep(repo, "/rules", "", trees, runSemgrep(repo, "/rules"));
  assert.equal(report.results.length, 2);
  assert.equal(git("status", "--porcelain"), "");
});

for (const pass of ["app", "vendor"]) {
  for (const outcome of ["cleared", "uncleared", "failure"]) {
    test(`${pass} retries only timed out files once: ${outcome}`, t => {
      const target = pass === "app" ? appHit : vendorHit;
      const timeout = { type: "Timeout", rule_id: "sql", path: target.path, message: "Rule timed out" };
      const recovered = { ...target, check_id: "recovered" };
      const filtered = { ...target, check_id: "other-category", extra: { metadata: { category: "deserialization" } } };
      const { repo, log } = fixture(t, `
        const retry = args[args.indexOf("--timeout") + 1] === "0";
        if (retry && ${JSON.stringify(outcome)} === "failure") process.exit(2);
        const results = retry ? ${JSON.stringify([target, recovered, filtered])} : ${JSON.stringify([target])};
        const errors = !retry || ${JSON.stringify(outcome)} === "uncleared" ? [${JSON.stringify(timeout)}] : [];
        console.log(JSON.stringify({ results, errors, paths: { scanned: [${JSON.stringify(target.path)}] } }));
      `);
      const report = pass === "app" ? runSemgrep(repo, "/rules", "sqli")
        : runVendorSemgrep(repo, "/rules", "sqli", ["vendor"], { results: [appHit], errors: [] });
      const expected = outcome === "failure" ? [target] : [target, recovered];
      assert.deepEqual(report.results, pass === "app" ? expected : [appHit, ...expected.map(hit => ({ ...hit, vendorTree: "vendor" }))]);
      assert.deepEqual(report.errors, outcome === "cleared" ? [] : [{
        pass, rule: "sql", path: target.path, message: "Rule timed out", retried: true,
      }]);
      const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[1], [
        "scan", "--config", "/rules", "--json", "--metrics=off", "--disable-version-check", "--timeout", "0",
        ...(pass === "vendor" ? ["--x-ignore-semgrepignore-files", "--no-git-ignore", "--exclude", "node_modules", "--exclude", "build", "--exclude", "dist", "--"] : []),
        `./${target.path}`,
      ]);
    });
  }
}

test("vendor discovery disables repository fsmonitor and hooks", t => {
  const { repo } = fixture(t, 'console.log(JSON.stringify({ results: [], errors: [] }));');
  const git = (...args) => childProcess.execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("add", ".");
  const marker = join(repo, "../fsmonitor-ran");
  const monitor = join(repo, "../fsmonitor");
  writeFileSync(monitor, `#!/bin/sh\ntouch '${marker}'\nprintf '\\0'\n`, { mode: 0o755 });
  git("config", "core.fsmonitor", monitor);
  git("config", "core.hooksPath", join(repo, "../hooks"));
  assert.deepEqual(findVendorTrees(repo), ["vendor"]);
  assert.throws(() => readFileSync(marker), { code: "ENOENT" });
});

for (const pass of ["app", "vendor"]) {
  for (const stage of ["main", "retry"]) {
    test(`${pass} ${stage} kills a process that ignores SIGTERM`, { timeout: 20000 }, t => {
      const target = pass === "app" ? "app.php" : "vendor/client.php";
      const { repo, log } = fixture(t, `
        const retry = args[args.indexOf("--timeout") + 1] === "0";
        if (${JSON.stringify(stage)} === "main" || retry) {
          process.on("SIGTERM", () => {});
          require("node:fs").writeFileSync(process.cwd() + "/../semgrep.pid", String(process.pid));
          setInterval(() => {}, 1000);
        } else console.log(JSON.stringify({ results: [], errors: [{ type: "Timeout", rule_id: "sql", path: ${JSON.stringify(target)} }] }));
      `);
      const source = readFileSync(new URL("./semgrep.mjs", import.meta.url), "utf8");
      assert.match(source, /timeout: 120000/);
      assert.match(source, /timeout: 60000/);
      const script = join(repo, "../short-timeout.mjs");
      writeFileSync(script, source.replace("timeout: 120000", `timeout: ${stage === "retry" ? 5000 : 500}`).replace("timeout: 60000", "timeout: 500")
        .replace('"./vendor.mjs"', JSON.stringify(new URL("./vendor.mjs", import.meta.url).href)).replace('"./agent-user.mjs"', JSON.stringify(new URL("./agent-user.mjs", import.meta.url).href)).replace('"./agent-fs.mjs"', JSON.stringify(new URL("./agent-fs.mjs", import.meta.url).href)));
      let output;
      try {
        output = childProcess.execFileSync(process.execPath, ["--eval", `
        import { runSemgrep, runVendorSemgrep } from ${JSON.stringify(script)};
        const report = ${pass === "app" ? `runSemgrep(${JSON.stringify(repo)}, "/rules")`
          : `runVendorSemgrep(${JSON.stringify(repo)}, "/rules", "", ["vendor"], { results: [], errors: [] })`};
        console.log(JSON.stringify(report));
        `], { encoding: "utf8", timeout: 15000, killSignal: "SIGKILL" });
        const pid = Number(readFileSync(join(repo, "../semgrep.pid"), "utf8"));
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      } finally {
        try { process.kill(Number(readFileSync(join(repo, "../semgrep.pid"), "utf8")), "SIGKILL"); } catch {}
      }
      const report = JSON.parse(output);
      assert.deepEqual(report.results, []);
      assert.equal(report.errors.length, 1);
      assert.equal(report.errors[0].pass, pass);
      if (stage === "retry") assert.equal(report.errors[0].retried, true);
      const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(calls.length, stage === "retry" ? 2 : 1);
    });
  }
}
