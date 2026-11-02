import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { codexArgs, mapEvent, queryNative } from "./codex.mjs";

const usage = { input_tokens: 100, cached_input_tokens: 30, cache_write_input_tokens: 5,
  output_tokens: 20, reasoning_output_tokens: 8 };

test("native JSONL maps thread, exact usage and failed turns", () => {
  assert.equal(mapEvent({ type: "thread.started", thread_id: "thread-1" }).session_id, "thread-1");
  assert.deepEqual(mapEvent({ type: "turn.completed", usage }).usage, {
    input_tokens: 70, cache_read_input_tokens: 30, cache_creation_input_tokens: 5, output_tokens: 20,
  });
  assert.deepEqual(mapEvent({ type: "turn.failed", error: { message: "quota exceeded" } }), {
    type: "result", subtype: "error", is_error: true, result: "quota exceeded",
  });
});

test("native arguments select sandbox, model, effort, resume and artifact tool", () => {
  const args = codexArgs({ options: { cwd: "/workspace/repo", model: "gpt-test", effort: "high", resume: "thread-1" },
    mode: "read-only", prompt: "Use Write for findings.json", artifactsDir: "/workspace/artifacts", artifactContextPath: "/workspace/artifacts/artifact-tool-context.json",
    skillPath: "/root/.claude/skills/audit/SKILL.md" });
  assert.ok(args.includes('model_reasoning_effort="high"'));
  assert.ok(args.includes("gpt-test"));
  assert.ok(args.includes('default_permissions="scanner"'));
  const filesystem = args.find(arg => arg.startsWith("permissions.scanner.filesystem="));
  assert.deepEqual(Bun.TOML.parse(filesystem).permissions.scanner.filesystem, {
    ":minimal": "read", "/opt": "read", "/workspace/repo": "read", "/workspace/related": "read",
    "/workspace/artifacts": "read", "/root/.claude/skills/audit": "read",
  });
  assert.ok(!args.includes("-s"));
  assert.ok(args.includes('mcp_servers.artifacts.command=' + JSON.stringify(process.execPath)));
  const config = Bun.TOML.parse(args.flatMap((arg, index) => arg === "-c" ? [args[index + 1]] : []).join("\n"));
  assert.deepEqual(config.mcp_servers, { artifacts: {
    command: process.execPath,
    args: [new URL("./artifact-server.mjs", import.meta.url).pathname, "/workspace/artifacts/artifact-tool-context.json"],
    tools: { write_artifact: { approval_mode: "approve" } },
  } });
  assert.equal(config.approval_policy, undefined);
  assert.deepEqual(args.slice(-3, -1), ["resume", "thread-1"]);
  assert.equal(args.at(-1), "-");
  assert.ok(!args.includes("--add-dir"));
  const fix = codexArgs({ options: { cwd: "/workspace/repo" }, mode: "workspace-write", prompt: "fix", artifactsDir: "/workspace/artifacts" });
  assert.deepEqual(fix, ["exec", "--json", "-c", "shell_environment_policy.ignore_default_excludes=false", "-s", "workspace-write", "--add-dir", "/workspace/artifacts", "--add-dir", "/workspace/repo/.git", "-"]);
});

for (const scenario of ["success", "retry", "failed", "truncated", "exit", "exit-incomplete", "malformed"])
test(`native subprocess consumes JSONL with piped stdin: ${scenario}`, async t => {
  const dir = mkdtempSync(join(tmpdir(), "native-codex-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, "peer.mjs");
  writeFileSync(script, `
    import { readFileSync } from 'node:fs';
    if (!readFileSync(0, 'utf8').startsWith('scan')) throw new Error('stdin must contain prompt');
    const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
    emit({ type: 'thread.started', thread_id: 'native-thread-${scenario}' });
    for (const text of ['interim', 'final answer']) emit({ type: 'item.completed', item: { type: 'agent_message', text } });
    if (${JSON.stringify(scenario)} === 'retry') emit({ type: 'error', message: 'stream disconnected; retrying' });
    if (${JSON.stringify(scenario)} === 'failed') emit({ type: 'turn.failed', error: { message: 'quota exceeded' } });
    else if (${JSON.stringify(scenario)} === 'malformed') process.stdout.write('broken JSON\\n');
    else if (${JSON.stringify(scenario)} !== 'truncated' && ${JSON.stringify(scenario)} !== 'exit-incomplete') emit({ type: 'turn.completed', usage: ${JSON.stringify(usage)} });
    if (${JSON.stringify(scenario)}.startsWith('exit')) process.exitCode = 2;
  `);
  const outputs = [], messages = [];
  const run = async () => {
    for await (const message of queryNative({ options: { cwd: dir, model: "gpt-test", effort: "high" },
      prompt: (async function* () { yield { message: { content: "scan" } }; })(), mode: "read-only",
      env: { ...process.env, HOME: dir }, command: [process.execPath, script], artifactsDir: dir,
      persistOutput: text => outputs.push(text),
    })) messages.push(message);
  };
  if (["success", "retry", "exit"].includes(scenario)) {
    await run();
    assert.equal(outputs.at(-1), "final answer");
    assert.equal(messages[0].session_id, `native-thread-${scenario}`);
    assert.equal(messages.at(-1).usage.input_tokens, 70);
    assert.equal(messages.filter(message => message.type === "result").length, 1);
    if (scenario === "retry") assert.deepEqual(messages.find(message => message.type === "error"), {
      type: "error", message: "stream disconnected; retrying",
    });
  } else await assert.rejects(run, scenario === "failed" ? /quota exceeded/ : undefined);
});

test("resumed thread usage is a delta and fresh threads keep their own totals", async t => {
  const dir = mkdtempSync(join(tmpdir(), "native-usage-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, "peer.mjs");
  writeFileSync(script, `
    import { readFileSync } from 'node:fs';
    const { thread, usage } = JSON.parse(readFileSync(0, 'utf8').split('\\n')[0]);
    console.log(JSON.stringify({ type: 'thread.started', thread_id: thread }));
    console.log(JSON.stringify({ type: 'turn.completed', usage }));
  `);
  const run = async (thread, totals, resume) => {
    let result;
    for await (const message of queryNative({ options: { cwd: dir, resume }, mode: "read-only",
      prompt: (async function* () { yield { message: { content: JSON.stringify({ thread, usage: totals }) } }; })(),
      env: { ...process.env, HOME: dir }, command: [process.execPath, script], artifactsDir: dir,
    })) if (message.type === "result") result = message;
    return result.usage;
  };
  const thread = `usage-${dir}`;
  const first = await run(thread, usage);
  assert.deepEqual(await run(`${thread}-review`, usage), first);
  const next = await run(thread, { input_tokens: 180, cached_input_tokens: 50, cache_write_input_tokens: 8,
    output_tokens: 35 }, thread);
  assert.deepEqual(next, { input_tokens: 60, cache_read_input_tokens: 20, cache_creation_input_tokens: 3, output_tokens: 15 });
  assert.equal(first.input_tokens + next.input_tokens, 130);
});

for (const resume of [undefined, "large-prompt-thread"])
test(`large prompt goes through stdin (${resume ? "resume" : "new"})`, async t => {
  const dir = mkdtempSync(join(tmpdir(), "native-prompt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, "peer.mjs");
  const prompt = "Use Write for findings.json\n" + "x".repeat(256 * 1024);
  writeFileSync(join(dir, "expected"), `Read the skill at /skill/SKILL.md.\n${prompt.replace(/\bWrite\b/g, "write_artifact")}\nUse the write_artifact MCP tool with path and content for all artifact writes. The sandbox has no writable roots.`);
  writeFileSync(script, `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    assert.equal(process.argv.at(-1), '-');
    assert.ok(process.argv.every(arg => arg.length < 4096));
    assert.equal(readFileSync(0, 'utf8'), readFileSync('expected', 'utf8'));
    console.log(JSON.stringify({ type: 'turn.completed', usage: ${JSON.stringify(usage)} }));
  `);
  for await (const message of queryNative({ options: { cwd: dir, resume }, mode: "read-only",
    prompt: (async function* () { yield { message: { content: prompt } }; })(), skillPath: "/skill/SKILL.md",
    env: { ...process.env, HOME: dir }, command: [process.execPath, script], artifactsDir: dir,
  })) void message;
});

test("read-only Codex gets a fresh CODEX_HOME with only the login copy, a resume keeps it, a refreshed login goes back", async t => {
  const dir = mkdtempSync(join(tmpdir(), "native-home-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".codex"));
  writeFileSync(join(dir, ".codex", "auth.json"), '{"v":1}');
  // What a fixer could leave in the agent's home earlier in the same container.
  writeFileSync(join(dir, ".codex", "config.toml"), 'notify = ["touch", "/tmp/notify-ran"]');
  writeFileSync(join(dir, ".gitconfig"), "[core]\n\tfsmonitor = touch /tmp/fsmonitor-ran");
  const script = join(dir, "peer.mjs");
  writeFileSync(script, `
    import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
    const auth = process.env.CODEX_HOME + '/auth.json';
    const seen = { home: process.env.HOME, codexHome: process.env.CODEX_HOME, files: readdirSync(process.env.CODEX_HOME), auth: readFileSync(auth, 'utf8') };
    writeFileSync(auth, '{"v":2}');
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'home-thread' }));
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(seen) } }));
    console.log(JSON.stringify({ type: 'turn.completed', usage: ${JSON.stringify(usage)} }));
  `);
  const run = async resume => {
    let seen;
    for await (const message of queryNative({ options: { cwd: dir, resume }, mode: "read-only",
      prompt: (async function* () { yield { message: { content: "scan" } }; })(),
      env: { ...process.env, HOME: dir, CODEX_HOME: join(dir, ".codex") }, command: [process.execPath, script], artifactsDir: dir,
    })) if (message.type === "assistant") seen = JSON.parse(message.message.content[0].text);
    return seen;
  };
  const first = await run();
  assert.match(first.home, /\/\.readonly-[^/]+$/);
  assert.equal(first.codexHome, join(first.home, ".codex"));
  assert.deepEqual(first.files, ["auth.json"]);
  assert.equal(first.auth, '{"v":1}');
  assert.equal(readFileSync(join(dir, ".codex", "auth.json"), "utf8"), '{"v":2}');
  assert.equal((await run("home-thread")).home, first.home);
  assert.notEqual((await run()).home, first.home);
});

test("real Codex sandbox permits fix commits only with the generated .git grant", {
  skip: process.env.CODEX_SANDBOX_TEST !== "1", timeout: 30000,
}, () => {
  const args = codexArgs({ options: { cwd: "/workspace/repo" }, mode: "workspace-write",
    artifactsDir: "/workspace/artifacts" }).slice(2, -1);
  const sandboxMode = args[args.indexOf("-s") + 1];
  const writableRoots = args.flatMap((arg, index) => arg === "--add-dir" ? [args[index + 1]] : []);
  assert.equal(sandboxMode, "workspace-write");
  assert.deepEqual(writableRoots, ["/workspace/artifacts", "/workspace/repo/.git"]);
  // 0.159.3's sandbox subcommand only consumes config overrides, not -s/--add-dir.
  const sandboxArgs = ["-c", `sandbox_mode=${JSON.stringify(sandboxMode)}`, "-c",
    `sandbox_workspace_write.writable_roots=${JSON.stringify(writableRoots)}`];
  const result = spawnSync("docker", ["run", "--rm", "--network", "none", "--security-opt",
    `seccomp=${new URL("../../backend/docker/codex-seccomp.json", import.meta.url).pathname}`,
    ...(process.env.CODEX_SANDBOX_APPARMOR === "1" ? ["--security-opt", "apparmor=security-patch-codex-test"] : []),
    "--entrypoint", "/bin/sh", "ola-agent-scanner:test", "-c", `
      set -eu
      test "$(/usr/local/bin/codex --version)" = "codex-cli 0.159.3"
      cd /workspace/repo
      git init -q
      git config user.email test@example.com
      git config user.name Test
      echo before > file
      git add file
      git commit -qm baseline
      base=$(git rev-parse HEAD)
      chown -R agent:agent /workspace
      setpriv --reuid=agent --regid=agent --clear-groups --no-new-privs /usr/local/bin/codex -c 'sandbox_mode="workspace-write"' -c 'sandbox_workspace_write.writable_roots=[]' sandbox -- /bin/sh -c 'set -eu; echo after > file; if git add file; then exit 1; fi'
      setpriv --reuid=agent --regid=agent --clear-groups --no-new-privs /usr/local/bin/codex "$@" sandbox -- /bin/sh -c 'echo after > file && git add file && git commit -qm fix && git bundle create /workspace/artifacts/resume.bundle HEAD'
      test "$(git -c safe.directory=/workspace/repo rev-parse HEAD)" != "$base"
      git -c safe.directory=/workspace/repo bundle verify /workspace/artifacts/resume.bundle
    `, "test", ...sandboxArgs], { encoding: "utf8", timeout: 25000 });
  assert.equal(result.status, 0, result.stderr);
});

test("real read-only profile reads allowed roots but hides copied login files", {
  skip: process.env.CODEX_SANDBOX_TEST !== "1", timeout: 30000,
}, () => {
  const args = codexArgs({ options: { cwd: "/workspace/repo" }, mode: "read-only",
    artifactsDir: "/workspace/artifacts", artifactContextPath: "/workspace/artifacts/context.json",
    skillPath: "/root/.claude/skills/ola-security-audit/SKILL.md" }).slice(2, -1);
  const result = spawnSync("docker", ["run", "--rm", "--network", "none", "--security-opt",
    `seccomp=${new URL("../../backend/docker/codex-seccomp.json", import.meta.url).pathname}`,
    ...(process.env.CODEX_SANDBOX_APPARMOR === "1" ? ["--security-opt", "apparmor=security-patch-codex-test"] : []),
    "--entrypoint", "/bin/sh", "ola-agent-scanner:test", "-c", `
      set -eu
      test "$(/usr/local/bin/codex --version)" = "codex-cli 0.159.3"
      mkdir -p /home/agent/.codex /workspace/related /workspace/unrelated
      echo fixture > /home/agent/.codex/auth.json
      echo fixture > /home/agent/.claude/.credentials.json
      echo fixture > /workspace/repo/source
      echo fixture > /workspace/related/source
      echo fixture > /workspace/artifacts/findings.json
      echo fixture > /workspace/unrelated/source
      chown -R agent:agent /home/agent/.codex /home/agent/.claude /workspace
      cd /workspace/repo
      setpriv --reuid=agent --regid=agent --clear-groups --no-new-privs /bin/sh -c '
          set -eu
          cat /workspace/repo/source /workspace/related/source /workspace/artifacts/findings.json /workspace/unrelated/source /root/.claude/skills/ola-security-audit/SKILL.md > /dev/null
          test -w /workspace/repo/source
          test -w /workspace/artifacts/findings.json
      '
      setpriv --reuid=agent --regid=agent --clear-groups --no-new-privs /usr/bin/test -r /home/agent/.codex/auth.json
      setpriv --reuid=agent --regid=agent --clear-groups --no-new-privs /usr/bin/test -r /home/agent/.claude/.credentials.json
      setpriv --reuid=agent --regid=agent --clear-groups --no-new-privs /usr/local/bin/codex "$@" sandbox -- /bin/sh -c '
          set -eu
          cat /workspace/repo/source /workspace/related/source /workspace/artifacts/findings.json /root/.claude/skills/ola-security-audit/SKILL.md > /dev/null
          if cat /home/agent/.codex/auth.json; then exit 1; fi
          if cat /home/agent/.claude/.credentials.json; then exit 1; fi
          if cat /workspace/unrelated/source; then exit 1; fi
          if sh -c "echo changed > /workspace/repo/source"; then exit 1; fi
          if sh -c "echo changed > /workspace/artifacts/findings.json"; then exit 1; fi
      '
    `, "test", ...args], { encoding: "utf8", timeout: 25000 });
  assert.equal(result.status, 0, result.stderr);
});

test("API-key runs hand the key to Codex as CODEX_API_KEY only, never in argv or an agent environment", async t => {
  const dir = mkdtempSync(join(tmpdir(), "native-key-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, "peer.mjs");
  writeFileSync(script, `
    const { CODEX_API_KEY, OPENAI_API_KEY } = process.env;
    console.log(JSON.stringify({ type: 'thread.started', thread_id: JSON.stringify({ CODEX_API_KEY, OPENAI_API_KEY, argv: process.argv.slice(2) }) }));
    console.log(JSON.stringify({ type: 'turn.completed', usage: ${JSON.stringify(usage)} }));
  `);
  const seen = async env => {
    for await (const message of queryNative({ options: { cwd: dir }, mode: "read-only",
      prompt: (async function* () { yield { message: { content: "scan" } }; })(),
      env, command: [process.execPath, script], artifactsDir: dir,
    })) if (message.session_id) return JSON.parse(message.session_id);
  };
  const withKey = await seen({ ...process.env, HOME: dir, OPENAI_API_KEY: "FAKE_OPENAI_KEY" });
  assert.equal(withKey.CODEX_API_KEY, "FAKE_OPENAI_KEY");
  assert.equal(withKey.OPENAI_API_KEY, undefined);
  assert.ok(!withKey.argv.join(" ").includes("FAKE_OPENAI_KEY"));
  const withoutKey = await seen({ ...process.env, HOME: dir, ANTHROPIC_API_KEY: "FAKE_CLAUDE_KEY", CODEX_API_KEY: "stray" });
  assert.equal(withoutKey.CODEX_API_KEY, undefined);
  assert.equal(withoutKey.OPENAI_API_KEY, undefined);
});

test("real Codex shell commands never see the API key", {
  skip: process.env.CODEX_SANDBOX_TEST !== "1", timeout: 30000,
}, () => {
  const policy = "shell_environment_policy.ignore_default_excludes=false";
  assert.ok(codexArgs({ options: { cwd: "/workspace/repo" }, mode: "read-only", artifactsDir: "/workspace/artifacts",
    artifactContextPath: "/workspace/artifacts/context.json" }).includes(policy));
  const result = spawnSync("docker", ["run", "--rm", "--network", "none", "--security-opt",
    `seccomp=${new URL("../../backend/docker/codex-seccomp.json", import.meta.url).pathname}`,
    ...(process.env.CODEX_SANDBOX_APPARMOR === "1" ? ["--security-opt", "apparmor=security-patch-codex-test"] : []),
    "--entrypoint", "/bin/sh", process.env.CODEX_SANDBOX_IMAGE ?? "ola-agent-scanner:test", "-c", `
      set -eu
      test "$(/usr/local/bin/codex --version)" = "codex-cli 0.159.3"
      mkdir -p /home/agent/.codex
      chown -R agent:agent /home/agent/.codex /workspace
      cd /workspace/repo
      export CODEX_HOME=/home/agent/.codex CODEX_API_KEY=sk-fixture-key-0123456789
      codex() { setpriv --reuid=agent --regid=agent --clear-groups --no-new-privs /usr/local/bin/codex "$@"; }
      # 0.159.3 inherits the key into commands unless the default excludes are on.
      codex sandbox -- /usr/bin/env | grep -q '^CODEX_API_KEY=sk-fixture-key-0123456789$'
      if codex -c ${policy} sandbox -- /usr/bin/env | grep -q 'sk-fixture-key'; then exit 1; fi
      # The agent-uid Codex process keeps the key in /proc/<pid>/environ. A sandboxed command must not reach it.
      setpriv --reuid=agent --regid=agent --clear-groups --no-new-privs /usr/bin/env CODEX_API_KEY=$CODEX_API_KEY sleep 20 &
      keyed=$!
      sleep 1
      setpriv --reuid=agent --regid=agent --clear-groups --no-new-privs /bin/cat /proc/$keyed/environ | grep -q 'sk-fixture-key'
      out=$(codex -c ${policy} sandbox -- /bin/sh -c 'cat /proc/'"$keyed"'/environ 2>/dev/null || true; echo ran')
      kill $keyed 2>/dev/null || true
      case "$out" in *sk-fixture-key*) exit 1 ;; esac
      test "$out" = ran
    `], { encoding: "utf8", timeout: 25000 });
  assert.equal(result.status, 0, result.stderr);
});

test("workspace-write cannot launch against a host checkout", async () => {
  await assert.rejects(async () => {
    for await (const message of queryNative({ mode: "workspace-write", options: { cwd: tmpdir() } })) void message;
  }, /scanner container workspace/);
});
