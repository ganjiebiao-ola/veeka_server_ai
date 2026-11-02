import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { agentSpawn, agentEnv, AGENT_HOME } from "./agent-user.mjs";
import { agentFs, copyFiles, dropReadOnlyHome, keepReadOnlyHome, readOnlyHome, writeArtifact } from "./agent-fs.mjs";
import { redact } from "./redact.mjs";

const threadUsage = new Map();
const LOGIN = [".codex", /^auth\.json$/];

export function mapEvent(event) {
  if (event.type === "thread.started") return { type: "system", subtype: "init", session_id: event.thread_id };
  const item = event.item;
  if (event.type === "item.completed" && item?.type === "agent_message") {
    return { type: "assistant", message: { content: [{ type: "text", text: item.text }] } };
  }
  if (item?.type === "command_execution") {
    if (event.type === "item.started") return { type: "assistant", message: { content: [
      { type: "tool_use", id: item.id, name: "Bash", input: { command: item.command } },
    ] } };
    if (event.type === "item.completed") return { type: "user", message: { content: [
      { type: "tool_result", tool_use_id: item.id, content: item.aggregated_output ?? "", is_error: item.exit_code !== 0 },
    ] } };
  }
  if (event.type === "turn.completed") {
    const u = event.usage;
    return { type: "result", subtype: "success", num_turns: 1, usage: {
      input_tokens: Math.max(0, u.input_tokens - (u.cached_input_tokens ?? 0)),
      cache_read_input_tokens: u.cached_input_tokens ?? 0,
      cache_creation_input_tokens: u.cache_write_input_tokens ?? 0,
      output_tokens: u.output_tokens,
    } };
  }
  if (event.type === "error") return event;
  if (event.type === "turn.failed") {
    return { type: "result", subtype: "error", is_error: true,
      result: event.error?.message ?? event.message ?? "Codex turn failed" };
  }
}

export function codexArgs({ options, mode, artifactsDir, artifactContextPath, skillPath }) {
  const args = ["exec", "--json"];
  // 0.159.3 defaults ignore_default_excludes to true, so commands would inherit CODEX_API_KEY.
  args.push("-c", "shell_environment_policy.ignore_default_excludes=false");
  if (mode === "read-only") {
    const roots = [":minimal", "/opt", options.cwd, "/workspace/related", artifactsDir,
      ...(skillPath ? [dirname(skillPath)] : [])];
    const filesystem = roots.map(root => `${JSON.stringify(root)}="read"`).join(",");
    // 0.159.3's -s flag overrides named profiles and would restore full-disk reads.
    args.push("-c", 'default_permissions="scanner"', "-c", `permissions.scanner.filesystem={${filesystem}}`);
  } else args.push("-s", mode);
  if (options.model) args.push("-m", options.model);
  if (options.effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(options.effort)}`);
  if (mode === "read-only") {
    args.push("-c", `mcp_servers.artifacts.command=${JSON.stringify(process.execPath)}`,
      "-c", `mcp_servers.artifacts.args=${JSON.stringify([fileURLToPath(new URL("./artifact-server.mjs", import.meta.url)), artifactContextPath])}`,
      "-c", 'mcp_servers.artifacts.tools.write_artifact.approval_mode="approve"');
  }
  if (mode === "workspace-write") args.push("--add-dir", artifactsDir, "--add-dir", join(options.cwd, ".git"));
  if (options.resume) args.push("resume", options.resume);
  args.push("-");
  return args;
}

export async function* queryNative(request) {
  const { options, mode, signal, persistOutput, onModelInfo } = request;
  // Workspace-write is only authorized inside the scanner container.
  if (mode === "workspace-write" && (options.cwd !== "/workspace/repo" || process.platform !== "linux" || !existsSync("/.dockerenv"))) throw new Error("Codex fixes require the scanner container workspace");
  let prompt = "";
  for await (const message of request.prompt) prompt += message.message.content;
  if (mode === "read-only") prompt = prompt.replace(/\bWrite\b/g, "write_artifact") +
    "\nUse the write_artifact MCP tool with path and content for all artifact writes. The sandbox has no writable roots.";
  if (request.skillPath) prompt = `Read the skill at ${request.skillPath}.\n${prompt}`;
  const artifactContextPath = `${request.artifactsDir}/artifact-tool-context.json`;
  if (mode === "read-only") writeArtifact(artifactContextPath, JSON.stringify({ artifactsDir: request.artifactsDir,
    reviewNotesFile: request.reviewNotesFile, scanInventory: request.scanInventory }));
  const home = request.env?.HOME || AGENT_HOME;
  // A config.toml (notify, MCP servers, profiles) or .gitconfig left by a fixer must not load in a read-only run.
  const runHome = mode === "read-only" ? readOnlyHome(home, options.resume, [LOGIN]) : undefined;
  if (runHome) agentFs.mkdirSync(join(runHome, ".codex"), { recursive: true, mode: 0o700 });
  const args = codexArgs({ ...request, artifactContextPath, prompt });
  const command = request.command ?? ["codex"];
  const names = ["PATH", "HOME", "CODEX_HOME", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "CODEX_CA_CERTIFICATE", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"];
  // `codex exec` reads CODEX_API_KEY from its own environment; the key never reaches argv or a file.
  const env = { ...agentEnv(Object.fromEntries(names.filter(k => request.env?.[k]).map(k => [k, request.env[k]]))),
    ...(runHome ? { HOME: runHome, CODEX_HOME: join(runHome, ".codex") } : {}),
    ...(request.env?.OPENAI_API_KEY ? { CODEX_API_KEY: request.env.OPENAI_API_KEY } : {}) };
  const child = agentSpawn(command[0], [...command.slice(1), ...args], { cwd: options.cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let spawnError;
  const closed = new Promise(resolve => {
    child.once("error", error => { spawnError = error; });
    child.once("close", resolve);
  });
  child.stdin.on("error", error => { if (error.code !== "EPIPE") spawnError = error; });
  child.stdin.end(prompt);
  const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } };
  const pendingItems = new Set();
  let paused = false, pauseTimer, killTimer;
  const pause = () => {
    if (!request.pauseSignal?.aborted || paused || pendingItems.size) return;
    paused = true;
    try { process.kill(-child.pid, "SIGINT"); } catch { /* already exited */ }
    pauseTimer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
    }, 1000);
    killTimer = setTimeout(kill, 2000);
  };
  request.pauseSignal?.addEventListener("abort", pause, { once: true });
  pause();
  signal?.addEventListener("abort", kill, { once: true });
  if (signal?.aborted) kill();
  let stderr = "", completed = false, failure;
  let threadId = options.resume;
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8000); });
  try {
    onModelInfo?.({ model: options.model, effort: options.effort });
    for await (const line of createInterface({ input: child.stdout })) {
      if (paused) continue;
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === "item.started") pendingItems.add(event.item.id);
      if (event.type === "item.completed") pendingItems.delete(event.item.id);
      if (event.type === "thread.started") {
        threadId = event.thread_id;
        if (runHome) keepReadOnlyHome(threadId, runHome);
      }
      if (event.type === "turn.completed" && threadId) {
        // 0.159.3 emits ThreadTokenUsage.total, including turns from before resume.
        const previous = threadUsage.get(threadId) ?? {};
        const total = event.usage;
        event.usage = Object.fromEntries(Object.entries(total).map(([key, value]) => [key, Math.max(0, value - (previous[key] ?? 0))]));
        threadUsage.set(threadId, total);
      }
      const message = mapEvent(event);
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        persistOutput?.(redact(event.item.text));
      }
      if (message?.type === "result") {
        completed = message.subtype === "success";
        if (!completed) failure = message.result;
      }
      if (message) yield JSON.parse(redact(JSON.stringify(message)));
      // MCP items need their completed event too, even though mapEvent omits them.
      if (event.type === "item.completed") pause();
    }
    await closed;
    if (spawnError) throw spawnError;
    if (signal?.aborted) throw new Error("Codex run cancelled");
    if (paused) return;
    if (failure || !completed) throw new Error(redact(failure || stderr || "Codex exited without a completed turn"));
  } finally {
    request.pauseSignal?.removeEventListener("abort", pause);
    clearTimeout(pauseTimer);
    clearTimeout(killTimer);
    signal?.removeEventListener("abort", kill);
    kill();
    await closed;
    // The container's copy-back reads the agent's login, so a token refreshed here goes there.
    if (runHome) {
      copyFiles(join(runHome, LOGIN[0]), join(home, LOGIN[0]), LOGIN[1]);
      dropReadOnlyHome(runHome);
    }
  }
}
