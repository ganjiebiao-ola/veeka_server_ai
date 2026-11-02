import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPush } from "./push.mjs";

const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString().trim();

// A clone of a local bare remote with one commit pushed, one more commit on top.
function fixture(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  const artifacts = join(root, "artifacts");
  mkdirSync(artifacts);
  execFileSync("git", ["init", "-q", "--bare", remote]);
  execFileSync("git", ["init", "-q", repo]);
  git(repo, "config", "user.email", "t@t.local"); git(repo, "config", "user.name", "t");
  git(repo, "remote", "add", "origin", remote);
  writeFileSync(join(repo, "f.txt"), "hi\n");
  git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "c1");
  git(repo, "push", "-q", "origin", "HEAD:refs/heads/main");
  const base = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "f.txt"), "fixed\n");
  git(repo, "commit", "-q", "-am", "fix");
  return { root, repo, remote, artifacts, base, io: { url: remote, base, artifactsDir: artifacts } };
}

test("runPush pushes the agent's commits to a new branch on a local bare remote", { timeout: 15000 }, () => {
  const f = fixture("ola-push-");
  const r = runPush(f.repo, "ola-codesec/fix-test", undefined, process.env, f.io);
  assert.deepEqual(r, { ok: true, sha: git(f.repo, "rev-parse", "HEAD") });
  assert.equal(git(f.remote, "rev-parse", "ola-codesec/fix-test"), git(f.repo, "rev-parse", "HEAD"));
});

test("runPush ignores a pushurl, remote and hook planted in the agent's repo config", { timeout: 15000 }, () => {
  const f = fixture("ola-push-evil-");
  const proof = join(f.root, "ran-as-root");
  const evil = `ext::sh -c "touch ${proof}"`;
  git(f.repo, "config", "protocol.ext.allow", "always");
  git(f.repo, "config", "remote.origin.pushurl", evil);
  git(f.repo, "config", "url.ext::sh -c touch.insteadOf", f.remote);
  git(f.repo, "config", "include.path", join(f.root, "none"));
  const hook = join(f.repo, ".git", "hooks", "pre-push");
  writeFileSync(hook, `#!/bin/sh\ntouch ${proof}\n`, { mode: 0o755 });
  const r = runPush(f.repo, "br", undefined, process.env, f.io);
  assert.deepEqual(r, { ok: true, sha: git(f.repo, "rev-parse", "HEAD") });
  assert.equal(existsSync(proof), false, "planted command ran");
  assert.equal(git(f.remote, "rev-parse", "br"), git(f.repo, "rev-parse", "HEAD"));
});

test("runPush returns error when there is no clone URL", { timeout: 15000 }, () => {
  const f = fixture("ola-push-nourl-");
  const r = runPush(f.repo, "br", undefined, {}, { ...f.io, url: undefined });
  assert.equal(r.ok, false);
});

test("runPush's credential helper answers github.com only, from the child's env", { timeout: 15000 }, () => {
  const fill = (host) => {
    let out = "";
    // Run the real credential args with `credential fill` in place of each git command.
    runPush("/repo", "br", (cmd, args, opts) => {
      if (!args.includes("push")) return "";
      const auth = args.slice(args.indexOf("credential.helper=") - 1, args.indexOf("push"));
      out = execFileSync("git", [...auth, "credential", "fill"],
        { ...opts, stdio: "pipe", encoding: "utf8", input: `protocol=https\nhost=${host}\n\n`,
          env: { ...opts.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" } });
      return "";
    }, { PATH: process.env.PATH, HOME: tmpdir(), GH_TOKEN: "test.placeholder" },
    { url: "https://github.com/o/r.git", base: "b".repeat(40), artifactsDir: tmpdir(),
      bundle: () => { const p = join(mkdtempSync(join(tmpdir(), "ola-b-")), "x.bundle"); writeFileSync(p, "b"); return p; } });
    return out;
  };
  assert.match(fill("github.com"), /^username=x-access-token\npassword=test.placeholder$/m);
  assert.doesNotMatch(fill("evil.example"), /test.placeholder/);
});
