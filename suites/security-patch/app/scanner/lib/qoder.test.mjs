import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync, rmSync, symlinkSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { qoderArgs, mapEvent, queryNative } from "./qoder.mjs";
import { providerWording } from "./artifacts.mjs";

const usage = { input_tokens: 0, output_tokens: 0, credits: 0.125, context_usage_ratio: 0.03 };
const result = (extra = {}) => ({ type: "result", subtype: "success", result: "done", usage, ...extra });
const toolUse = (id, name = "Read") => ({ type: "tool_use", id, name, input: { file_path: "/workspace/repo/a.php" } });
const message = (type, content) => ({ type, message: { content } });

test("Qoder maps init, assistant blocks, MCP calls, tool results, credits and errors", () => {
  assert.deepEqual(mapEvent({ type: "system", subtype: "init", session_id: "q-1", model: "Qwen3.8-Flash" }),
    { type: "system", subtype: "init", session_id: "q-1", model: "Qwen3.8-Flash" });
  const assistant = message("assistant", [{ type: "text", text: "hello" }, toolUse("read"), toolUse("artifact", "mcp__artifacts__write_artifact")]);
  const mapped = mapEvent({ ...assistant, message: { ...assistant.message, id: "reply-1", usage } });
  assert.equal(mapped.message.content[2].name, "write_artifact");
  assert.deepEqual([mapped.message.id, mapped.message.usage], ["reply-1", { credits: 0.125 }]);
  const partial = mapEvent({ ...assistant, message: { ...assistant.message, id: "reply-1", usage: { input_tokens: 0 } } });
  assert.deepEqual([partial.message.id, partial.message.usage], [undefined, undefined]);
  assert.equal(mapped.message.content[1].input.file_path, "/workspace/repo/a.php");
  const response = message("user", [{ type: "tool_result", tool_use_id: "read", content: "content", is_error: false }]);
  assert.deepEqual(mapEvent(response), response);
  assert.deepEqual(mapEvent(result()), { type: "result", subtype: "success", num_turns: 1 });
  assert.match(mapEvent(result({ subtype: "error_during_execution", errors: ["turn failed"], result: "" })).result, /turn failed/);
  assert.equal(mapEvent({ type: "stream_event" }), undefined);
});

test("Qoder bills a reply once, on its positive chunk, and reports the turn total on the result", () => {
  const chunk = credits => mapEvent({ type: "assistant", message: { id: "reply-1", content: [], usage: { input_tokens: 0, credits } } });
  const chunks = [chunk(0), chunk(0), chunk(0.5)];
  assert.deepEqual(chunks.map(m => [m.message.id, m.message.usage]), [[undefined, undefined], [undefined, undefined], ["reply-1", { credits: 0.5 }]]);
  assert.deepEqual(mapEvent(result({ total_credits: 1.25 })).usage, { credits: 1.25 });
  for (const total_credits of [0, undefined, Number.NaN]) assert.equal(mapEvent(result({ total_credits })).usage, undefined);
});

test("Qoder read-only args restrict tools and MCP, add roots, resume, and omit effort", () => {
  const request = { options: { cwd: "/workspace/repo", model: "Qwen3.8-Flash", resume: "q-1", effort: "high" },
    mode: "read-only", artifactsDir: "/workspace/artifacts", skillPath: "/skill/audit/SKILL.md",
    configDir: "/home/agent/.qoder", mcpConfigPath: "/home/agent/.qoder/artifacts-mcp.json" };
  const args = qoderArgs(request);
  const value = flag => args[args.indexOf(flag) + 1];
  assert.equal(value("--permission-mode"), "dont_ask");
  assert.equal(value("--tools"), "Read,Grep,Glob");
  assert.equal(value("--setting-sources"), "user");
  assert.equal(value("--allowed-tools"), "Read,Grep,Glob,mcp__artifacts__write_artifact");
  for (const name of ["Write", "Edit", "NotebookEdit", "Bash", "Monitor", "WebFetch", "WebSearch", "Task", "Agent", "mcp_call"]) assert.ok(value("--disallowed-tools").split(",").includes(name));
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(value("--allowed-mcp-server-names"), "artifacts");
  assert.equal(value("--mcp-config"), request.mcpConfigPath);
  assert.equal(value("--resume"), "q-1");
  assert.equal(value("--model"), "Qwen3.8-Flash");
  assert.deepEqual(args.filter((_, i) => args[i - 1] === "--add-dir"), ["/workspace/repo", "/workspace/related", "/workspace/artifacts", "/skill/audit"]);
  assert.ok(!args.includes("--effort") && !args.includes("--dangerously-skip-permissions"));
  const fix = qoderArgs({ ...request, mode: "workspace-write" });
  assert.ok(fix.includes("--dangerously-skip-permissions"));
  assert.ok(!fix.includes("--permission-mode") && !fix.includes("--tools"));
  assert.equal(fix[fix.indexOf("--setting-sources") + 1], "user");
});

function fixture(t, script) {
  const dir = mkdtempSync(join(tmpdir(), "native-qoder-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const peer = join(dir, "qodercli.mjs");
  writeFileSync(peer, `import { readFileSync, writeFileSync, existsSync } from 'node:fs';
    const emit = val => console.log(JSON.stringify(val));
    const input = readFileSync(0, 'utf8');
    writeFileSync('invocation.json', JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), input, env: Object.keys(process.env), home: process.env.HOME }));
    emit({ type: 'system', subtype: 'init', session_id: 'q-session', model: 'Qwen3.8-Flash' });
    ${script}`);
  return { dir, request: { options: { cwd: dir, model: "Qwen3.8-Flash", resume: "prior-session" }, mode: "read-only",
    env: { ...process.env, HOME: dir }, command: [process.execPath, peer], artifactsDir: dir,
    prompt: (async function* () { yield { message: { content: "scan" } }; })() } };
}
const runHomes = dir => readdirSync(dir).filter(name => name.startsWith(".readonly-")).map(name => join(dir, name));
async function collect(request, onMessage = () => {}) {
  const messages = [];
  for await (const message of queryNative(request)) { messages.push(message); onMessage(message); }
  return messages;
}

test("Qoder fake peer uses isolated cwd, stdin for large prompts, strict MCP and an env allowlist", async t => {
  const reply = { type: "assistant", message: { id: "reply-1", content: [{ type: "text", text: "findings" }], usage } };
  const { dir, request } = fixture(t, `emit(${JSON.stringify(reply)}); emit(${JSON.stringify(result())});`);
  const secrets = ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "GH_TOKEN", "GITHUB_TOKEN"];
  Object.assign(request.env, Object.fromEntries(secrets.map(key => [key, "fake-secret"])));
  const prompt = "x".repeat(256 * 1024);
  request.prompt = (async function* () { yield { message: { content: prompt } }; })();
  request.skillPath = "/skill/SKILL.md";
  const outputs = [], models = [];
  const messages = await collect({ ...request, persistOutput: text => outputs.push(text), onModelInfo: info => models.push(info) });
  assert.equal(messages[0].session_id, "q-session");
  assert.equal(messages.at(-1).usage, undefined);
  assert.deepEqual(messages.filter(m => m.message?.usage).map(m => m.message.usage), [{ credits: 0.125 }]);
  assert.deepEqual(outputs, ["findings", "done"]);
  assert.equal(models.at(-1).model, "Qwen3.8-Flash");
  const [runHome] = runHomes(dir);
  const invocation = JSON.parse(readFileSync(join(runHome, "scan-cwd", "invocation.json"), "utf8"));
  assert.equal(invocation.cwd, realpathSync(join(runHome, "scan-cwd")));
  assert.equal(invocation.home, runHome);
  assert.equal(invocation.input, `Read the skill at /skill/SKILL.md.\n${prompt}`);
  assert.ok(invocation.argv.every(arg => arg.length < 4096));
  assert.equal(invocation.argv[invocation.argv.indexOf("--resume") + 1], "prior-session");
  assert.deepEqual(invocation.env.filter(key => secrets.includes(key) || key.startsWith("ANTHROPIC_")), []);
  assert.equal(invocation.argv[invocation.argv.indexOf("--config-dir") + 1], join(runHome, ".qoder"));
  const config = JSON.parse(readFileSync(join(runHome, ".qoder", "artifacts-mcp.json"), "utf8"));
  assert.deepEqual(Object.keys(config.mcpServers), ["artifacts"]);
  assert.equal(JSON.parse(readFileSync(join(dir, "artifact-tool-context.json"), "utf8")).provider, "qoder");
});

test("Qoder read-only runs get a fresh home with only the login copies, and a refreshed token goes back", async t => {
  const { dir, request } = fixture(t, `
    writeFileSync(process.env.HOME + '/.qoder/.auth/user', 'refreshed-' + readFileSync(process.env.HOME + '/.qoder/.auth/user', 'utf8'));
    emit(${JSON.stringify(result())});`);
  const auth = join(dir, ".qoder", ".auth");
  mkdirSync(join(auth, "nested"), { recursive: true });
  for (const name of ["user", "machine_id", "dynamic-texts.json", "dynamic-texts.json.lock"]) writeFileSync(join(auth, name), name);
  // What a fixer could leave in the agent's home earlier in the same container.
  writeFileSync(join(dir, ".qoder", "settings.json"), '{"hooks":{}}');
  mkdirSync(join(dir, "scan-cwd", ".qoder"), { recursive: true });
  writeFileSync(join(dir, "scan-cwd", ".qoder", "settings.json"), '{"hooks":{}}');
  await collect(request);
  const [first] = runHomes(dir);
  assert.deepEqual(readdirSync(join(first, ".qoder")).sort(), [".auth", "artifacts-mcp.json"]);
  assert.deepEqual(readdirSync(join(first, ".qoder", ".auth")).sort(), ["dynamic-texts.json", "machine_id", "user"]);
  assert.deepEqual(readdirSync(join(first, "scan-cwd")), ["invocation.json"]);
  assert.equal(readFileSync(join(auth, "user"), "utf8"), "refreshed-user");
  assert.equal(readFileSync(join(auth, "machine_id"), "utf8"), "machine_id");
  // A resumed session keeps its home; a new review gets another one.
  await collect({ ...request, prompt: (async function* () { yield { message: { content: "again" } }; })() });
  assert.equal(runHomes(dir).length, 2);
  assert.equal(readFileSync(join(auth, "user"), "utf8"), "refreshed-refreshed-user");
  await collect({ ...request, options: { ...request.options, resume: "q-session" }, prompt: (async function* () { yield { message: { content: "resume" } }; })() });
  assert.equal(runHomes(dir).length, 2);
});

for (const scenario of ["denied-result", "denied-tool", "failed", "auth", "malformed"]) test(`Qoder fails incomplete or denied turns: ${scenario}`, async t => {
  const event = scenario === "denied-result" ? result({ permission_denials: [{ tool_name: "Write" }] })
    : result({ subtype: "error", result: scenario === "auth" ? "unauthorized: machine_id mismatch" : "turn failed" });
  const script = scenario === "denied-tool"
    ? `emit(${JSON.stringify({ type: "system", subtype: "permission_denied", tool_name: "Read" })}); emit(${JSON.stringify(result())});`
    : scenario === "malformed" ? `console.log('bad json');` : `emit(${JSON.stringify(event)});`;
  const { request } = fixture(t, script);
  await assert.rejects(collect(request), scenario.startsWith("denied") ? /Qoder denied/ : scenario === "auth" ? /authentication failed.*OLA_AGENT_QODER_AUTH_PATH/ : undefined);
});

test("Qoder ENOENT fails without hanging", { timeout: 5000 }, async t => {
  const { dir, request } = fixture(t, "");
  await assert.rejects(collect({ ...request, command: [join(dir, "missing-qodercli")] }), { code: "ENOENT" });
});

test("Qoder abort kills the peer and fails the turn", { timeout: 5000 }, async t => {
  const { request } = fixture(t, "setInterval(() => {}, 1000);");
  const abort = new AbortController();
  await assert.rejects(collect({ ...request, signal: abort.signal }, () => abort.abort()), /cancelled/);
});

test("Qoder pause waits for all parallel tool results before SIGINT and escalation", { timeout: 5000 }, async t => {
  const { dir, request } = fixture(t, `
    process.on('SIGINT', () => { writeFileSync('sigint', String(existsSync('tool-done'))); });
    process.on('SIGTERM', () => { writeFileSync('sigterm', 'yes'); process.exit(0); });
    emit(${JSON.stringify(message("assistant", [toolUse("a"), toolUse("b", "mcp__artifacts__write_artifact")]))});
    setTimeout(() => emit(${JSON.stringify(message("user", [{ type: "tool_result", tool_use_id: "a", content: "ok" }]))}), 50);
    setTimeout(() => { writeFileSync('tool-done', 'yes'); emit(${JSON.stringify(message("user", [{ type: "tool_result", tool_use_id: "b", content: "ok" }]))}); }, 200);
    setInterval(() => {}, 1000);`);
  const pause = new AbortController();
  const messages = await collect({ ...request, pauseSignal: pause.signal }, m => {
    if (m.message?.content.some(block => block.type === "tool_use")) pause.abort();
  });
  const [runHome] = runHomes(dir);
  assert.equal(readFileSync(join(runHome, "scan-cwd", "sigint"), "utf8"), "true");
  assert.equal(readFileSync(join(runHome, "scan-cwd", "sigterm"), "utf8"), "yes");
  assert.equal(messages.some(m => m.type === "result"), false);
});

test("Qoder fix cannot bypass permissions on a host checkout", async () => {
  await assert.rejects(collect({ mode: "workspace-write", options: { cwd: tmpdir() } }), /scanner container workspace/);
});

test("Qoder scan and review wording uses the artifact MCP tool", () => {
  for (const mode of ["scan", "review"]) {
    const wording = providerWording("qoder", mode, "ola-security-audit");
    assert.match(wording.tools, /mcp__artifacts__write_artifact/);
    assert.match(wording.scanWrites, /write_artifact MCP/);
    assert.doesNotMatch(wording.artifactError("Use Write for findings.json. Scan tools: Read, Glob, Grep, Skill, Write."), /Use Write|shell commands/);
  }
});

test("Qoder auth copy-back writes a refreshed token only over an unchanged host file and rejects unsafe refreshes", t => {
  const dir = mkdtempSync(join(tmpdir(), "qoder-copy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const entrypoint = readFileSync(new URL("../entrypoint.sh", import.meta.url), "utf8");
  assert.match(entrypoint, /install -m 600 \/root\/\.qoder\/\.auth\/user \/root\/\.qoder\/user\.snapshot/);
  assert.match(entrypoint, /auth_copy_back \/home\/agent\/\.qoder\/\.auth\/user \/root\/\.qoder\/\.auth\/user opaque qoder \/root\/\.qoder\/user\.snapshot/);
  assert.doesNotMatch(entrypoint, /auth_copy_back[^\n]*machine_id/);
  const start = entrypoint.indexOf("auth_copy_back() {");
  const fn = entrypoint.slice(start, entrypoint.indexOf("\n}\n", start) + 3)
    .replace('from "/opt/lib/agent-fs.mjs"', `from ${JSON.stringify(new URL("./agent-fs.mjs", import.meta.url).href)}`);
  const src = join(dir, "refresh"), dst = join(dir, "mounted"), snapshot = join(dir, "snapshot");
  const copy = () => spawnSync("bash", ["-c", `
    emit() { echo "$1"; }
    setpriv() { return 0; }
    ${fn}
    auth_copy_back "$QODER_COPY_SRC" "$QODER_COPY_DST" opaque qoder "$QODER_COPY_SNAPSHOT"
  `], { encoding: "utf8", env: { ...process.env, QODER_COPY_SRC: src, QODER_COPY_DST: dst, QODER_COPY_SNAPSHOT: snapshot } });
  writeFileSync(dst, "old-token", { mode: 0o600 });
  writeFileSync(snapshot, "old-token");
  // The container token did not change: nothing is written.
  writeFileSync(src, "old-token");
  const mtime = statSync(dst).mtimeMs;
  assert.equal(copy().status, 0);
  assert.equal(statSync(dst).mtimeMs, mtime);
  // The host refreshed its login during the run: the container's refresh must not overwrite it.
  writeFileSync(dst, "host-token");
  writeFileSync(src, "refreshed-token");
  assert.match(copy().stdout, /host login changed during the run/);
  assert.equal(readFileSync(dst, "utf8"), "host-token");
  writeFileSync(dst, "old-token");
  assert.equal(copy().status, 0);
  assert.equal(readFileSync(dst, "utf8"), "refreshed-token");
  assert.equal(statSync(dst).mode & 0o777, 0o600);
  writeFileSync(dst, "old-token");
  for (const [bytes, reason] of [["", "empty file"], ["x".repeat(65537), "over 64 KiB"]]) {
    writeFileSync(src, bytes);
    assert.match(copy().stdout, new RegExp(reason));
    assert.equal(readFileSync(dst, "utf8"), "old-token");
  }
  rmSync(src);
  symlinkSync(dst, src);
  assert.match(copy().stdout, /not a regular file/);
  assert.equal(readFileSync(dst, "utf8"), "old-token");
});
