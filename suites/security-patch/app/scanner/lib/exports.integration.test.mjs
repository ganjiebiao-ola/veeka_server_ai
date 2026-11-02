import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, readFileSync, mkdirSync, openSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExportCommands } from "./exports.mjs";

test("patch is non-empty after a commit (the fix-mode bug)", { timeout: 15000 }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "ola exp-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const art = join(root, "art");
  mkdirSync(repo); mkdirSync(art);
  const g = (cmd) => execSync(`git -C "${repo}" ${cmd}`, { stdio: "ignore" });
  execSync(`git init -q "${repo}"`);
  g(`config user.email t@t.local`); g(`config user.name t`);
  writeFileSync(join(repo, "a.txt"), "v1\n");
  g(`add -A`); g(`commit -q -m base`);
  const baseSha = execSync(`git -C "${repo}" rev-parse HEAD`).toString().trim();
  // model fix: change + COMMIT (this is why `diff HEAD` was empty before)
  writeFileSync(join(repo, "a.txt"), "v2\n");
  g(`add -A`); g(`commit -q -m fix`);

  const normalPatch = execFileSync("git", ["diff", baseSha], { cwd: repo, encoding: "utf8" });

  // Configure executable tools that must never run during artifact exports.
  const marker = join(root, "external-tool-ran");
  const tool = join(root, "external-tool");
  writeFileSync(tool, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
  for (const [key, value] of [
    ["diff.external", tool], ["diff.hostile.textconv", tool], ["core.fsmonitor", tool], ["core.hooksPath", root],
  ]) execFileSync("git", ["config", key, value], { cwd: repo });
  writeFileSync(join(repo, ".git/info/attributes"), "a.txt diff=hostile\n");

  const { patchCmd, commitsCmd } = buildExportCommands(repo, art, baseSha);
  const run = ({ cmd, args, outFile }) => {
    const stdout = openSync(outFile, "w");
    try { execFileSync(cmd, args, { cwd: repo, stdio: ["ignore", stdout, "ignore"] }); }
    finally { closeSync(stdout); }
  };
  run(patchCmd);
  run(commitsCmd);
  assert.equal(readFileSync(commitsCmd.outFile, "utf8"), execFileSync("git", ["-c", "core.fsmonitor=", "log", "--no-ext-diff", "--no-textconv", `${baseSha}..HEAD`, "--format=%H%n%s%n%b%n--END--"], { cwd: repo, encoding: "utf8" }));
  const patch = readFileSync(join(art, "working.patch"), "utf-8");
  assert.equal(patch, normalPatch);
  assert.match(patch, /-v1/);
  assert.match(patch, /\+v2/);

  // legacy diff HEAD would be empty here — prove the contrast
  const { patchCmd: legacy, commitsCmd: legacyLog } = buildExportCommands(repo, art, null);
  run(legacy);
  run(legacyLog);
  assert.equal(readFileSync(legacyLog.outFile, "utf8"), execFileSync("git", ["-c", "core.fsmonitor=", "log", "--no-ext-diff", "--no-textconv", "-n", "50", "--format=%H%n%s%n%b%n--END--"], { cwd: repo, encoding: "utf8" }));
  assert.equal(readFileSync(join(art, "working.patch"), "utf-8"), "");
  assert.equal(existsSync(marker), false);
});
