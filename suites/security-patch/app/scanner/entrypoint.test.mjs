import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const entrypoint = readFileSync(new URL("./entrypoint.sh", import.meta.url), "utf8");
// Execute the real clone and baseline code with temp paths, without container
// auth setup or the SDK bridge. All git operations use a local repository.
const cloneBlock = entrypoint.slice(entrypoint.indexOf("# --- 2. clone"), entrypoint.indexOf("# --- 3. start"));

test("Codex Docker sandbox reads files but blocks source writes and network sockets", {
  skip: process.env.CODEX_SANDBOX_TEST !== "1", timeout: 20000,
}, () => {
  const policy = fileURLToPath(new URL("../backend/docker/codex-seccomp.json", import.meta.url));
  const apparmor = process.env.CODEX_SANDBOX_APPARMOR === "1";
  const result = spawnSync("docker", ["run", "--rm", "--network", "none", "--security-opt", `seccomp=${policy}`,
    ...(apparmor ? ["--security-opt", "apparmor=security-patch-codex-test"] : []),
    "--entrypoint", "/bin/sh", "ola-agent-scanner:test", "-c", `
    set -eu
    ${apparmor ? `/usr/bin/python3 -c 'assert open("/proc/self/attr/current").read().strip() == "security-patch-codex-test (enforce)"'` : ""}
    codex=/usr/local/bin/codex
    printf 'sandbox fixture\\n' > /workspace/repo/probe.txt
    "$codex" -s read-only sandbox -- /bin/cat /workspace/repo/probe.txt
    if "$codex" -s read-only sandbox -- /bin/sh -c 'echo changed > /workspace/repo/probe.txt'; then exit 1; fi
    test "$(cat /workspace/repo/probe.txt)" = 'sandbox fixture'
    /usr/bin/python3 -c 'import socket; socket.socket().close()'
    if "$codex" -s read-only sandbox -- /usr/bin/python3 -c 'import socket; socket.socket()'; then exit 1; fi
    /usr/bin/python3 -c 'import ctypes; lib = ctypes.CDLL(None, use_errno=True); assert lib.mount(b"none", b"/workspace", b"tmpfs", 0, None) == -1; assert ctypes.get_errno() == 1; assert lib.unshare(0x40000000) == -1; assert ctypes.get_errno() == 1'
  `], { encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "sandbox fixture\n");
  assert.match(result.stderr, /Read-only file system/);
  assert.match(result.stderr, /Operation not permitted/);
});

// Regression for the credential gap: the model runs as "agent", root keeps the token and the key.
test("agent user cannot read the bridge environ or the SSH key", {
  skip: process.env.CODEX_SANDBOX_TEST !== "1", timeout: 30000,
}, () => {
  const probe = `
    import { agentSpawnSync } from "/opt/lib/agent-user.mjs"
    import { spawn } from "node:child_process"
    import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
    const bridge = spawn("sleep", ["30"], { env: { GH_TOKEN: "secret.token" }, stdio: "ignore" })
    mkdirSync("/root/.ssh", { recursive: true }); chmodSync("/root/.ssh", 0o700)
    writeFileSync("/root/.ssh/id_ed25519", "secret-key", { mode: 0o600 })
    const as = (cmd, ...args) => agentSpawnSync(cmd, args, { encoding: "utf8" })
    const uid = as("id", "-u").stdout.trim()
    if (!uid || uid === "0") throw new Error("model runs as uid " + uid)
    for (const file of ["/proc/" + bridge.pid + "/environ", "/proc/1/environ", "/root/.ssh/id_ed25519", "/root/.ssh/known_hosts"]) {
      const r = as("cat", file)
      if (r.status === 0 || /secret-/.test(r.stdout)) throw new Error("agent read " + file)
    }
    if (!/CapEff:\\s+0+\\n/.test(as("cat", "/proc/self/status").stdout)) throw new Error("agent keeps capabilities")
    bridge.kill()
    console.log("isolated")`;
  const result = spawnSync("docker", ["run", "--rm", "--entrypoint", "bun", "ola-agent-scanner:test", "-e", probe], { encoding: "utf8", timeout: 25000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "isolated");
});

test("agent filesystem denies a parent swap after root's containment check", {
  skip: process.env.CODEX_SANDBOX_TEST !== "1", timeout: 30000,
}, () => {
  const probe = `
    import assert from "node:assert/strict"
    import { agentFs, checkedPath } from "/opt/lib/agent-fs.mjs"
    import { readVendorSnippets } from "/opt/lib/vendor.mjs"
    import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs"
    mkdirSync("/root/.ssh", { recursive: true }); chmodSync("/root/.ssh", 0o700)
    writeFileSync("/root/.ssh/id_ed25519", "root-only-fixture", { mode: 0o600 })
    for (const root of ["/workspace/repo", "/workspace/artifacts"]) {
      mkdirSync(root, { recursive: true }); chmodSync(root, 0o1777)
      mkdirSync(root + "/swap"); writeFileSync(root + "/swap/id_ed25519", "safe")
      const source = realpathSync(root + "/swap/id_ed25519")
      assert.ok(source.startsWith(realpathSync(root) + "/"))
      renameSync(root + "/swap", root + "/old")
      symlinkSync("/root/.ssh", root + "/swap")
      // This is the former realpath-then-read leak, triggered without timing luck.
      assert.equal(readFileSync(source, "utf8"), "root-only-fixture")
      assert.throws(() => agentFs.readFileSync(source))
      assert.throws(() => agentFs.writeFileSync(source, "changed"))
      assert.throws(() => checkedPath(source, [root]))
      assert.deepEqual(readVendorSnippets(root, [{ path: "swap/id_ed25519", start: { line: 1 } }]), [null])
    }
    assert.equal(readFileSync("/root/.ssh/id_ed25519", "utf8"), "root-only-fixture")
    const file = "/workspace/artifacts/binary"
    const bytes = Buffer.from([0, 255, 128, 10])
    agentFs.writeFileSync(file, bytes)
    assert.deepEqual(agentFs.readFileSync(file), bytes)
    assert.equal(checkedPath(file, ["/workspace/artifacts"]), file)
    assert.throws(() => agentFs.readFileSync(file, undefined, 3), /too large/)
    console.log("contained")`;
  const result = spawnSync("docker", ["run", "--rm", "--entrypoint", "bun", "ola-agent-scanner:test", "-e", probe], { encoding: "utf8", timeout: 25000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.stdout.trim(), "contained");
});

const ownerStart = entrypoint.indexOf("# Restore the bind mount");
const ownerSetup = entrypoint.slice(ownerStart, entrypoint.indexOf("# Hand the workspace"));

test("local workspace exit restores its recorded owner and WORKSPACE_CHOWN takes precedence", () => {
  assert.ok(ownerStart >= 0);
  for (const override of ["", "2000:3000"]) {
    const result = spawnSync("bash", ["-c", `
      stat() { test "$*" = "-c %u:%g /workspace/repo" || exit 9; echo 1234:5678; }
      chown() { echo "chown $*"; }
      setpriv() { echo stopped; }
      fail() { exit 1; }
      ${ownerSetup}
      chown -R agent:agent /workspace/repo
      exit 7
    `], { env: { ...process.env, LOCAL_WORKSPACE: "1", WORKSPACE_CHOWN: override }, encoding: "utf8" });
    assert.equal(result.status, 7, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), ["chown -R agent:agent /workspace/repo", "stopped",
      `chown -hR ${override || "1234:5678"} /workspace/repo`]);
  }
});

test("local workspace owner restore changes real ownership without following symlinks", {
  skip: process.env.CODEX_SANDBOX_TEST !== "1", timeout: 30000,
}, () => {
  const script = `
    set -eu
    for owner in original override; do
      mkdir -p /workspace/repo
      echo fixture > /workspace/repo/file
      echo private > /tmp/private-file
      ln -sf /tmp/private-file /workspace/repo/link
      chown -hR 12000:13000 /workspace/repo
      export LOCAL_WORKSPACE=1 WORKSPACE_CHOWN=""
      expected=12000:13000
      if [ "$owner" = override ]; then export WORKSPACE_CHOWN=14000:15000; expected=$WORKSPACE_CHOWN; fi
      bash -c '${ownerSetup}
        chown -R agent:agent /workspace/repo
        exit 7
      ' || test "$?" = 7
      test "$(stat -c %u:%g /workspace/repo)" = "$expected"
      test "$(stat -c %u:%g /workspace/repo/file)" = "$expected"
      test "$(stat -c %u:%g /tmp/private-file)" = 0:0
    done
    echo restored
  `;
  const result = spawnSync("docker", ["run", "--rm", "--entrypoint", "bash", "ola-agent-scanner:test", "-c", script], { encoding: "utf8", timeout: 25000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.stdout.trim(), "restored");
});

const share = entrypoint.slice(entrypoint.indexOf("# Share only named inputs"), entrypoint.indexOf("if [ -f /root/.claude/.credentials.json"));

test("carried auth evidence uses the writable output permissions and leaves private files alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "ola-carried-auth-"));
  try {
    for (const name of ["auth.json", "findings.json", "resume-checkpoint.json", "private.json"]) {
      writeFileSync(join(dir, name), "{}", { mode: 0o600 });
    }
    const result = spawnSync("bash", ["-c", `
      set -eu
      chown() { echo "chown $*"; }
      chgrp() { echo "chgrp $*"; }
      fail() { echo "$1" >&2; exit 1; }
      ${share.replaceAll("/workspace/artifacts", '"$ARTIFACTS"')}
    `], { env: { ...process.env, ARTIFACTS: dir }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    for (const name of ["auth.json", "findings.json"]) {
      assert.ok(result.stdout.includes(`chown agent ${join(dir, name)}\n`));
      assert.equal(statSync(join(dir, name)).mode & 0o777, 0o660);
    }
    assert.equal(statSync(join(dir, "resume-checkpoint.json")).mode & 0o777, 0o640);
    assert.equal(statSync(join(dir, "private.json")).mode & 0o777, 0o600);
    assert.ok(!result.stdout.includes("private.json"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("agent can read run inputs and update carried outputs without reading private artifacts", {
  skip: process.env.CODEX_SANDBOX_TEST !== "1", timeout: 30000,
}, () => {
  const script = `
    set -eu
    fail() { echo "$1" >&2; exit 1; }
    mkdir -p /workspace/artifacts
    chmod 1777 /workspace/artifacts
    inputs='picked.json repo-context.json prompt.txt resume-checkpoint.json resume-report.md checks.json'
    outputs='auth.json findings.json review-1.json review-2.json resume.bundle'
    for name in $inputs $outputs run-info.json private.json; do
      echo fixture > /workspace/artifacts/$name
      chown 12000:12000 /workspace/artifacts/$name
      chmod 600 /workspace/artifacts/$name
    done
    ${share}
    test "$(stat -c %u /workspace/artifacts/checks.json)" = 0
    agent() { setpriv --reuid=agent --regid=agent --clear-groups --no-new-privs "$@"; }
    for name in $inputs $outputs; do
      agent cat /workspace/artifacts/$name >/dev/null
      setpriv --reuid=12000 --regid=12000 --clear-groups cat /workspace/artifacts/$name >/dev/null
      test "$(stat -c %a /workspace/artifacts/$name)" != 666
    done
    for name in $outputs; do
      agent sh -c 'echo updated > "$1"' sh /workspace/artifacts/$name
      test "$(cat /workspace/artifacts/$name)" = updated
      agent sh -c 'echo replaced > "$1.tmp" && mv "$1.tmp" "$1"' sh /workspace/artifacts/$name
      test "$(cat /workspace/artifacts/$name)" = replaced
    done
    for name in $inputs run-info.json private.json; do
      if agent sh -c 'echo changed > "$1"' sh /workspace/artifacts/$name 2>/dev/null; then exit 1; fi
    done
    for name in run-info.json private.json; do
      if agent cat /workspace/artifacts/$name 2>/dev/null; then exit 1; fi
      test "$(stat -c %a /workspace/artifacts/$name)" = 600
    done
    echo shared
  `;
  const result = spawnSync("docker", ["run", "--rm", "--entrypoint", "bash", "ola-agent-scanner:test", "-c", script], { encoding: "utf8", timeout: 25000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.stdout.trim(), "shared");
});

test("entrypoint installs the run's repo notes readable by the agent and skips a symlink", {
  skip: process.env.CODEX_SANDBOX_TEST !== "1", timeout: 30000,
}, () => {
  const start = entrypoint.indexOf("# The backend copies the scanned repo's current notes")
  const install = entrypoint.slice(start, entrypoint.indexOf("\nfi\n", start) + 4)
  const script = `
    set -eu
    fail() { echo "$1" >&2; exit 1; }
    notes=/root/.claude/skills/ola-security-audit/targets
    test ! -e "$notes"
    mkdir -p /workspace/artifacts
    ln -s /etc/shadow /workspace/artifacts/target-notes.md
    REPO_URL=https://github.com/acme/shop.git
    ${install}
    test ! -e "$notes/acme__shop.md"
    rm /workspace/artifacts/target-notes.md
    echo "## Related repos" > /workspace/artifacts/target-notes.md
    chown 12000:12000 /workspace/artifacts/target-notes.md
    chmod 600 /workspace/artifacts/target-notes.md
    ${install}
    setpriv --reuid=agent --regid=agent --clear-groups --no-new-privs cat /home/agent/.claude/skills/ola-security-audit/targets/acme__shop.md
  `;
  const result = spawnSync("docker", ["run", "--rm", "--entrypoint", "bash", "ola-agent-scanner:test", "-c", script], { encoding: "utf8", timeout: 25000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.stdout.trim(), "## Related repos");
});

test("bridge discovers agent-owned vendors and runs Composer as agent without safe.directory", {
  skip: process.env.CODEX_SANDBOX_TEST !== "1", timeout: 30000,
}, () => {
  const probe = `
    import assert from 'node:assert/strict'
    import { execFileSync } from 'node:child_process'
    import { mkdirSync, writeFileSync } from 'node:fs'
    import { agentEnv, agentSpawnSync } from '/opt/lib/agent-user.mjs'
    import { repoFiles } from '/opt/lib/profile.mjs'
    import { auditVendors, findVendorTrees } from '/opt/lib/vendor.mjs'
    const repo = '/workspace/repo'
    mkdirSync(repo + '/sdk/vendor/composer', { recursive: true })
    writeFileSync(repo + '/sdk/vendor/composer/installed.json', JSON.stringify([{ name: 'example/client', version: '1.2.3' }]))
    writeFileSync(repo + '/tracked.php', '<?php')
    writeFileSync(repo + '/.gitignore', 'ignored.php')
    writeFileSync(repo + '/ignored.php', '<?php')
    execFileSync('chown', ['-R', 'agent:agent', repo])
    const git = (...args) => {
      const r = agentSpawnSync('git', ['-C', repo, ...args], { env: agentEnv(), encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
    }
    git('init', '-q'); git('add', '.')
    const root = Bun.spawnSync(['git', '-C', repo, 'ls-files'])
    assert.notEqual(root.exitCode, 0)
    assert.match(root.stderr.toString(), /dubious ownership/)
    assert.deepEqual(findVendorTrees(repo), ['sdk/vendor'])
    assert.ok(repoFiles(repo).includes('tracked.php'))
    assert.ok(!repoFiles(repo).includes('ignored.php'))
    mkdirSync('/tmp/audit-bin')
    writeFileSync('/tmp/audit-bin/composer', '#!/bin/sh\\n[ "$(id -u)" = 10001 ] && [ -z "$GH_TOKEN" ] && [ -r composer.lock ] && touch probe || exit 2\\nprintf \\'%s\\n\\' \\'{"advisories":{"example/client":[{"advisoryId":"test","title":"test"}]}}\\'\\nexit 1\\n', { mode: 0o755 })
    process.env.PATH = '/tmp/audit-bin:' + process.env.PATH
    const report = auditVendors(repo)
    assert.deepEqual(report.errors, [])
    assert.equal(report.trees[0].mode, 'committed')
    assert.equal(report.trees[0].audit, 'completed')
    assert.equal(report.advisories[0].advisoryId, 'test')
    console.log('audited')`;
  const result = spawnSync("docker", ["run", "--rm", "--entrypoint", "bun", "ola-agent-scanner:test", "-e", probe], { encoding: "utf8", timeout: 25000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.stdout.trim(), "audited");
});

// Regression: root push must not run config or hooks the agent planted in the repo it owns.
test("root push ignores an ext:: pushurl, remote config and hook planted in the agent's repo", {
  skip: process.env.CODEX_SANDBOX_TEST !== "1", timeout: 40000,
}, () => {
  const probe = `
    import { runPush } from "/opt/lib/push.mjs"
    import { execFileSync } from "node:child_process"
    import { existsSync, mkdirSync, chmodSync, writeFileSync } from "node:fs"
    const run = (cmd, args, env = process.env) => execFileSync(cmd, args, { stdio: "pipe", env }).toString().trim()
    const agent = (...args) => run("setpriv", ["--reuid=agent", "--regid=agent", "--clear-groups", ...args], { ...process.env, HOME: "/home/agent" })
    const git = (...args) => agent("git", "-C", "/workspace/repo", ...args)
    // The remote stands in for GitHub: owned by the agent only so the test can seed it.
    run("git", ["config", "--global", "safe.directory", "*"])
    run("git", ["init", "-q", "--bare", "/tmp/remote.git"])
    mkdirSync("/workspace/repo", { recursive: true }); mkdirSync("/workspace/artifacts", { recursive: true })
    chmodSync("/workspace/artifacts", 0o1777)
    run("chown", ["-R", "agent:agent", "/workspace/repo", "/tmp/remote.git"])
    agent("git", "init", "-q", "/workspace/repo")
    git("config", "user.email", "t@t.local"); git("config", "user.name", "t")
    writeFileSync("/workspace/repo/f.txt", "hi\\n"); git("add", "-A"); git("commit", "-q", "-m", "c1")
    git("push", "-q", "/tmp/remote.git", "HEAD:refs/heads/main")
    const base = git("rev-parse", "HEAD")
    writeFileSync("/workspace/repo/f.txt", "fixed\\n"); git("commit", "-q", "-am", "fix")
    // What a hostile model could write: all of it runs code if root reads this repo's config.
    git("config", "protocol.ext.allow", "always")
    git("config", "remote.origin.pushurl", 'ext::sh -c "touch /tmp/proof"')
    git("config", "core.fsmonitor", "touch /tmp/proof")
    git("config", "core.sshCommand", "touch /tmp/proof")
    writeFileSync("/workspace/repo/.git/hooks/pre-push", "#!/bin/sh\\ntouch /tmp/proof\\n", { mode: 0o755 })
    const r = runPush("/workspace/repo", "br", undefined, { ...process.env, REPO_URL: "/tmp/remote.git" }, { base })
    if (!r.ok) throw new Error("push failed: " + r.error)
    if (existsSync("/tmp/proof")) throw new Error("planted command ran as root")
    if (run("git", ["-C", "/tmp/remote.git", "rev-parse", "br"]) !== git("rev-parse", "HEAD")) throw new Error("branch not pushed")
    console.log("contained")`;
  const result = spawnSync("docker", ["run", "--rm", "--entrypoint", "bun", "ola-agent-scanner:test", "-e", probe], { encoding: "utf8", timeout: 35000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.stdout.trim(), "contained");
});

// The real auth_copy_back function from entrypoint.sh, run in the image (needs jq, setpriv, the agent user).
test("Codex auth copy-back takes a valid refresh and refuses anything else", {
  skip: process.env.CODEX_SANDBOX_TEST !== "1", timeout: 40000,
}, () => {
  const start = entrypoint.indexOf("auth_copy_back() {");
  const fn = entrypoint.slice(start, entrypoint.indexOf("\n}\n", start) + 3);
  const script = [
    "emit() { echo \"LOG: $1\"; }", fn,
    "mkdir -p /root/.codex /home/agent/.codex",
    "dst=/root/.codex/auth.json; src=/home/agent/.codex/auth.json",
    "orig='{\"auth_mode\":\"chatgpt\",\"tokens\":{\"refresh_token\":\"old\"}}'",
    "try() { # name, writer command for the agent copy, expected: copied|kept",
    "  printf '%s' \"$orig\" > $dst; chmod 640 $dst; rm -rf $src; eval \"$2\"",
    "  chown -hR agent:agent /home/agent/.codex; chmod 700 /home/agent/.codex",
    "  auth_copy_back $src $dst \"$(jq -c keys $dst)\" codex",
    "  if [ \"$(cat $dst)\" = \"$orig\" ]; then got=kept; else got=copied; fi",
    "  echo \"$1 $got $(stat -c %a $dst)\"; }",
    "try valid \"echo '{\\\"auth_mode\\\":\\\"chatgpt\\\",\\\"tokens\\\":{\\\"refresh_token\\\":\\\"new\\\"}}' > $src\"",
    "try same \"printf '%s' \\\"$orig\\\" > $src\"",
    "try symlink \"printf '%s' '{\\\"auth_mode\\\":\\\"x\\\"}' > /tmp/real.json; ln -s /tmp/real.json $src\"",
    "try nonjson \"echo not json > $src\"",
    "try array \"echo '[1]' > $src\"",
    "try newkey \"echo '{\\\"auth_mode\\\":\\\"x\\\",\\\"extra\\\":1}' > $src\"",
    "try big \"{ echo '{\\\"auth_mode\\\":\\\"'; head -c 70000 /dev/zero | tr '\\\\0' a; echo '\\\"}'; } > $src\"",
    "try missing \"true\"",
  ].join("\n");
  const result = spawnSync("docker", ["run", "--rm", "--entrypoint", "bash", "ola-agent-scanner:test", "-c", script], { encoding: "utf8", timeout: 35000 });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n");
  assert.deepEqual(lines.filter(l => !l.startsWith("LOG:")), [
    "valid copied 640", "same kept 640", "symlink kept 640", "nonjson kept 640", "array kept 640", "newkey kept 640", "big kept 640", "missing kept 640"]);
  for (const reason of ["not a regular file", "not a JSON object", "new top-level keys", "over 64 KiB"]) {
    assert.ok(lines.some(l => l.includes(`copy-back skipped: ${reason}`)), reason);
  }
});

test("Codex sandbox preflight stops blocked runs before auth and checks Fix reviewers only", t => {
  const root = mkdtempSync(join(tmpdir(), "ola-sandbox-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = join(root, "calls.txt");
  const codex = join(root, "codex");
  writeFileSync(codex, `#!/bin/sh\nprintf '%s\\n' "$@" > '${calls}'\nexit "${'${PREFLIGHT_EXIT:-0}'}"\n`, { mode: 0o755 });
  writeFileSync(join(root, "timeout"), '#!/bin/sh\n[ "$1" = 10s ] || exit 2\nshift\nexec "$@"\n', { mode: 0o755 });
  const preflight = entrypoint.slice(0, entrypoint.indexOf("# --- 1. configure git auth"))
    .replaceAll("/usr/local/bin/codex", codex);
  for (const [provider, mode, reviewer, checked] of [
    ["codex", "scan", "claude", true],
    ["claude", "fix", "codex", true],
    ["claude", "scan", "codex", false],
  ]) {
    for (const exit of [0, 1, 124]) {
      rmSync(calls, { force: true });
      const result = spawnSync("bash", ["-c", preflight], {
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, PROVIDER: provider, MODE: mode, REVIEW_PROVIDER: reviewer, PREFLIGHT_EXIT: String(exit) },
        encoding: "utf8",
      });
      assert.equal(result.status, checked && exit ? 1 : 0, result.stderr);
      if (checked) {
        assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["-s", "read-only", "sandbox", "--", "/bin/true"]);
        if (exit) {
          const event = JSON.parse(result.stdout);
          assert.equal(event.kind, "scanner_failed");
          assert.match(event.error, /Codex read-only sandbox preflight failed/);
        }
      } else assert.equal(result.stdout, "");
    }
  }
});

test("entrypoint checks out an old exact SHA with full history and keeps shallow branch cloning", { timeout: 20000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "ola-sha-"));
  const source = join(root, "source");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  mkdirSync(join(workspace, "artifacts"));
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "-q", "--initial-branch=main", source);
    git("-C", source, "config", "user.email", "test@example.invalid");
    git("-C", source, "config", "user.name", "Test");
    writeFileSync(join(source, "a.txt"), "baseline\n");
    git("-C", source, "add", "a.txt");
    git("-C", source, "commit", "-q", "-m", "baseline");
    const sha = git("-C", source, "rev-parse", "HEAD");
    const history = Array.from({ length: 50 }, (_, i) => {
      const message = `commit ${i}\n`;
      return `commit refs/heads/main\nmark :${i + 1}\ncommitter Test <test@example.invalid> 1700000000 +0000\ndata ${message.length}\n${message}from ${i ? `:${i}` : sha}\n\n`;
    }).join("");
    execFileSync("git", ["-C", source, "fast-import", "--quiet"], { input: history, stdio: ["pipe", "pipe", "pipe"] });
    git("-C", source, "branch", "feature");
    git("-C", source, "branch", "master");
    const script = `set -u\nset -o pipefail\nrun_id=test\nbranch="${'${BRANCH:-}'}"\nstatus() { :; }\nemit() { :; }\nemitj() { :; }\nfail() { echo "$1" >&2; exit 1; }\n` +
      cloneBlock.replaceAll("/workspace", workspace).replaceAll("/tmp/clone.err", join(root, "clone.err"));
    const run = (commitSha, branch = "") => spawnSync("bash", ["-c", script], {
      env: { ...process.env, REPO_URL: `file://${source}`, COMMIT_SHA: commitSha, BRANCH: branch, LOCAL_WORKSPACE: "" },
      encoding: "utf8",
    });
    let result = run(sha.toUpperCase(), "nonexistent");
    assert.equal(result.status, 0, result.stderr);
    const repo = join(workspace, "repo");
    assert.equal(git("-C", repo, "rev-parse", "HEAD"), sha);
    assert.equal(git("-C", repo, "rev-parse", "--is-shallow-repository"), "false");
    assert.equal(git("-C", source, "rev-list", "--count", `${sha}..main`), "50");
    assert.deepEqual(JSON.parse(readFileSync(join(workspace, "artifacts/base.json"), "utf8")), { sha, branch: "nonexistent" });
    result = run(sha);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(join(workspace, "artifacts/base.json"), "utf8")).branch, "main");
    result = run("", "feature");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git("-C", repo, "rev-parse", "--abbrev-ref", "HEAD"), "feature");
    assert.equal(git("-C", repo, "rev-parse", "--is-shallow-repository"), "true");
    assert.equal(git("-C", repo, "rev-list", "--count", "HEAD"), "50");
    result = run("");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git("-C", repo, "rev-parse", "--abbrev-ref", "HEAD"), "main");
    git("-C", source, "checkout", "-q", "master");
    git("-C", source, "branch", "-D", "main");
    result = run("");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git("-C", repo, "rev-parse", "--abbrev-ref", "HEAD"), "master");
    for (const invalid of ["--help", "f".repeat(40)]) {
      result = run(invalid);
      assert.notEqual(result.status, 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a local workspace run records the baseline of a git workspace without a cloned branch", () => {
  const root = mkdtempSync(join(tmpdir(), "ola-local-"));
  const workspace = join(root, "workspace");
  const repo = join(workspace, "repo");
  mkdirSync(join(workspace, "artifacts"), { recursive: true });
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "-q", "--initial-branch=main", repo);
    git("-C", repo, "config", "user.email", "test@example.invalid");
    git("-C", repo, "config", "user.name", "Test");
    writeFileSync(join(repo, "fixture.php"), "<?php\n");
    git("-C", repo, "add", "fixture.php");
    git("-C", repo, "commit", "-q", "-m", "fixture");
    const script = `set -u\nset -o pipefail\nrun_id=test\nbranch=""\nstatus() { :; }\nemit() { :; }\nemitj() { :; }\nfail() { echo "$1" >&2; exit 1; }\n` +
      cloneBlock.replaceAll("/workspace", workspace);
    const result = spawnSync("bash", ["-c", script], {
      env: { ...process.env, LOCAL_WORKSPACE: "1" }, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(workspace, "artifacts/base.json"), "utf8")),
      { sha: git("-C", repo, "rev-parse", "HEAD"), branch: "" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("repository auth uses GH_TOKEN and nothing else", t => {
  const root = mkdtempSync(join(tmpdir(), "ola-auth-choice-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const auth = entrypoint.slice(entrypoint.indexOf("# Root-only credential dirs"), entrypoint.indexOf("# --- pre-set git identity"))
    .replaceAll("/root/.ssh", join(root, "ssh")).replaceAll("/root/.codex", join(root, "codex"));
  const run = (token, url = "https://github.com/owner/repo") => spawnSync("bash", ["-c", `set -u\nemit() { echo "$1"; }\nfail() { echo "$1" >&2; exit 1; }\n${auth}`], {
    env: { ...process.env, HOME: root, GH_TOKEN: token, REPO_URL: url, LOCAL_WORKSPACE: "" }, encoding: "utf8",
  });
  const token = run("fixture-token");
  assert.equal(token.status, 0, token.stderr);
  assert.match(token.stdout, /auth: GH_TOKEN env/);
  assert.equal(run("fixture-token", "https://evil.example/repo").status, 1);
  const none = run("");
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /auth: none/);
});

test("GH_TOKEN auth refuses non-github REPO_URL and writes no credentials file", t => {
  const root = mkdtempSync(join(tmpdir(), "ola-token-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const auth = entrypoint.slice(entrypoint.indexOf('  emit "auth: GH_TOKEN'), entrypoint.indexOf('\nelse\n  emit "auth: none'));
  assert.doesNotMatch(entrypoint, /git-credentials|credential\.helper ['"]?store/);
  const remoteGit = entrypoint.slice(entrypoint.indexOf("  remote_git() {"), entrypoint.indexOf("  clone_branch() {"));
  // git credential fill shows what the clone/fetch helper gives each host.
  const fill = `printf 'protocol=https\\nhost=%s\\n\\n' "$FILL_HOST" | GIT_TERMINAL_PROMPT=0 remote_git credential fill`;
  for (const url of ["https://github.com/owner/repo.git", "https://github.com@evil.example/x", "https://evil.example/owner/repo", "http://github.com/owner/repo", ""]) {
    for (const host of ["github.com", "evil.example"]) {
      const result = spawnSync("bash", ["-c", `set -u\nunset repo_url\nemit() { :; }\nfail() { echo "$1" >&2; exit 1; }\n${auth}\n${remoteGit}\n${fill}`], {
        cwd: root, env: { ...process.env, HOME: root, GH_TOKEN: "test.placeholder", REPO_URL: url, FILL_HOST: host, GIT_ASKPASS: "", SSH_ASKPASS: "" }, encoding: "utf8",
      });
      if (url.startsWith("https://github.com/")) {
        if (host === "github.com") {
          assert.equal(result.status, 0, result.stderr);
          assert.match(result.stdout, /^username=x-access-token\npassword=test.placeholder$/m);
        } else assert.doesNotMatch(result.stdout, /test.placeholder/);
      } else {
        assert.equal(result.status, 1, url);
        assert.match(result.stderr, /GH_TOKEN auth requires REPO_URL to start with https:\/\/github\.com\//);
        assert.equal(result.stdout, "");
      }
    }
    assert.deepEqual(readdirSync(root), []);
  }
});
