import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPush } from "./push.mjs";
import { agentEnv as makeAgentEnv } from "./agent-user.mjs";

// Fake agent bundle step: writes a file, runs no git.
const dir = mkdtempSync(join(tmpdir(), "ola-push-unit-"));
const io = { url: "https://github.com/o/r.git", base: "b".repeat(40), artifactsDir: dir,
  bundle: () => { const f = join(dir, `x-${Math.random()}.bundle`); writeFileSync(f, "bundle"); return f; } };
const record = (calls) => (cmd, args, opts) => { calls.push({ cmd, args, opts }); return args.includes("rev-parse") ? "a".repeat(40) : ""; };

test("runPush fetches the base and bundle into a fresh repo, then pushes to the clone URL", () => {
  const calls = [];
  assert.deepEqual(runPush("/repo", "ola-codesec/fix-abc", record(calls), {}, io), { ok: true, sha: "a".repeat(40) });
  const lines = calls.map(c => c.args.join(" "));
  assert.match(lines[0], /^init -q --bare /);
  assert.match(lines[1], new RegExp(`fetch -q --no-tags --depth=1 ${io.url} ${io.base}$`));
  assert.match(lines[2], /fetch -q --no-tags .*in\.bundle HEAD:refs\/heads\/push$/);
  assert.match(lines[3], new RegExp(`push -q ${io.url} refs/heads/push:refs/heads/ola-codesec/fix-abc$`));
  assert.ok(!lines.some(l => l.includes("/repo ")), "root never runs git in the agent's repo");
});

test("runPush gives GH_TOKEN only to the push children, and the agent env lacks it", () => {
  const calls = [];
  const env = { PATH: "/bin", GH_TOKEN: "test.placeholder" };
  assert.deepEqual(runPush("/repo", "br", record(calls), env, io), { ok: true, sha: "a".repeat(40) });
  assert.ok(calls.every(c => c.opts.env.GIT_CONFIG_VALUE_0 === "/dev/null"), "hooks stay off for root");
  assert.equal(calls[1].opts.env.SECPATCH_GIT_TOKEN, "test.placeholder");
  assert.match(calls[3].args.join(" "), /-c credential\.helper= -c credential\.https:\/\/github\.com\.helper=!f\(\)/);
  assert.doesNotMatch(calls.map(c => c.args.join(" ")).join("\n"), /test.placeholder/);
  assert.equal(env.SECPATCH_GIT_TOKEN, undefined);
  const bridge = readFileSync(new URL("../bridge.mjs", import.meta.url), "utf8");
  const agentEnv = makeAgentEnv(env);
  assert.equal(agentEnv.GH_TOKEN, undefined);
  assert.equal(agentEnv.SECPATCH_GIT_TOKEN, undefined);
  assert.match(bridge, /runPush\(REPO_DIR, cmd\.branch, undefined, process\.env, \{ base: batchBase\(\) \}\)/);
});

test("runPush refuses a bundle that is a symlink", () => {
  const target = join(dir, "target");
  writeFileSync(target, "x");
  const link = join(dir, "link.bundle");
  symlinkSync(target, link);
  const calls = [];
  const r = runPush("/repo", "br", record(calls), {}, { ...io, bundle: () => link });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0);
});

test("runPush captures stderr on failure", () => {
  const fakeExec = () => { const e = new Error("x"); e.stderr = "remote: Permission denied"; throw e; };
  const r = runPush("/repo", "br", fakeExec, {}, io);
  assert.equal(r.ok, false);
  assert.match(r.error, /Permission denied/);
});
