// Pure helper for the batch PR push. No SDK / process-global deps so they
// can be unit-tested with `bun test`.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { agentFs } from "./agent-fs.mjs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentEnv, agentSpawnSync } from "./agent-user.mjs";

// Same github.com-only helper as entrypoint.sh remote_git. It reads the token
// from SECPATCH_GIT_TOKEN, which only the push children get.
const TOKEN_AUTH = ["-c", "credential.helper=",
  "-c", 'credential.https://github.com.helper=!f() { test "$1" = get && echo username=x-access-token && echo "password=$SECPATCH_GIT_TOKEN"; }; f'];

// The agent user writes the commits since base as a git bundle. Returns the bundle path or throws.
function agentBundle(repoDir, base, artifactsDir) {
  const file = join(artifactsDir, `push-${randomBytes(6).toString("hex")}.bundle`);
  const r = agentSpawnSync("git", ["-C", repoDir, "bundle", "create", file, `${base}..HEAD`], { encoding: "utf8", env: agentEnv() });
  if (r.status !== 0) throw new Error(`bundle failed: ${r.stderr ?? ""}`);
  return file;
}

// Push the agent's commits to a NEW remote branch. Returns {ok, error}; never throws —
// git failures (no write access, non-fast-forward, etc.) are captured and
// surfaced to the UI. Uses GH_TOKEN
// from the bridge's own env (the agent's env never has it).
// Root never runs git in repoDir: the agent user owns it and could plant config there
// (ext:: pushurl, hooks, include.path) that runs as root. Root fetches the agent's bundle into a
// fresh root-owned repo and pushes from there to the clone URL, never to a remote the repo names.
export function runPush(repoDir, branch, run = execFileSync, env = process.env,
  { url = env.REPO_URL, base = "", artifactsDir = "/workspace/artifacts", bundle = agentBundle } = {}) {
  const token = env.GH_TOKEN;
  const auth = token ? TOKEN_AUTH : [];
  const gitEnv = { ...env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null",
    ...(token ? { SECPATCH_GIT_TOKEN: token } : {}) };
  let work, file;
  try {
    if (!url || !base) throw new Error("push needs the clone URL and base commit");
    file = bundle(repoDir, base, artifactsDir);
    work = mkdtempSync(join(tmpdir(), "secpatch-push-")); // mode 0700, root only
    writeFileSync(join(work, "in.bundle"), agentFs.readFileSync(file), { mode: 0o600 });
    const git = (...args) => run("git", ["-C", join(work, "r"), "-c", "transfer.fsckObjects=true", ...args],
      { stdio: ["ignore", "ignore", "pipe"], env: gitEnv });
    run("git", ["init", "-q", "--bare", join(work, "r")], { stdio: ["ignore", "ignore", "pipe"], env: gitEnv });
    git(...auth, "fetch", "-q", "--no-tags", "--depth=1", url, base);
    git("fetch", "-q", "--no-tags", join(work, "in.bundle"), "HEAD:refs/heads/push");
    git(...auth, "push", "-q", url, `refs/heads/push:refs/heads/${branch}`);
    const sha = String(run("git", ["-C", join(work, "r"), "rev-parse", "refs/heads/push"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: gitEnv })).trim();
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("invalid pushed commit");
    return { ok: true, sha };
  } catch (e) {
    const raw = e?.stderr ? String(e.stderr) : String(e?.message ?? e);
    return { ok: false, error: raw.slice(0, 500) };
  } finally {
    if (work) rmSync(work, { recursive: true, force: true });
    if (file) try { agentFs.unlinkSync(file) } catch { /* gone or not ours to remove */ }
  }
}
