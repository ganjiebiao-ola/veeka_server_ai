import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { agentSpawn, agentEnv, AGENT_HOME } from "./agent-user.mjs";
import { agentFs, copyFiles, dropReadOnlyHome, keepReadOnlyHome, readOnlyHome, writeArtifact } from "./agent-fs.mjs";
import { redact } from "./redact.mjs";

const SCAN_AGENT = "scanner";
const LOGIN = [".gemini/antigravity-cli", /^antigravity-oauth-token$/];
// A custom agent with an explicit tool list has no write or shell tools at all. The MCP tools
// (call_mcp_tool, list_resources, read_resource) are added by agy whenever a server is configured.
const SCAN_AGENT_DEFINITION = `---
name: ${SCAN_AGENT}
description: Read-only security scanner
tools:
  - view_file
  - list_dir
  - grep_search
  - find_by_name
excludeDefaultComponents: true
---
Read-only code auditor. Follow the user's instructions.
`;

const TOOLS = {
  run_command: ["Bash", p => ({ command: p.CommandLine })],
  write_file: ["Write", p => ({ file_path: p.Path })],
  edit_file: ["Edit", p => ({ file_path: p.Path })],
  read_file: ["Read", p => ({ file_path: p.Path })],
  view_file: ["Read", p => ({ file_path: p.AbsolutePath })],
  grep_search: ["Grep", p => ({ pattern: p.Query, path: p.SearchPath })],
  find_by_name: ["Glob", p => ({ pattern: p.Pattern, path: p.SearchDirectory })],
  list_dir: ["Glob", p => ({ path: p.DirectoryPath })],
  call_mcp_tool: ["write_artifact", p => ({ path: p.Arguments?.path })],
};

// agy reports usage for the whole conversation, so a resumed turn includes the turns before it.
const conversationUsage = new Map();

export function mapEvent(event, texts = new Map()) {
  if (event.event === "init") {
    return { type: "system", subtype: "init", session_id: event.conversation_id };
  }
  if (event.event === "step_update") {
    const step = event.step_update;
    if (step?.step_type === "agent_response") {
      const text = (texts.get(step.step_index) ?? "") + (step.text_delta ?? "");
      if (step.state === "ACTIVE") { texts.set(step.step_index, text); return; }
      texts.delete(step.step_index);
      return text.trim() ? { type: "assistant", message: { content: [{ type: "text", text }] } } : undefined;
    }
    if (step?.step_type !== "tool") return;
    const id = `tool-${step.step_index}`;
    if (step.state === "ACTIVE") {
      const name = step.tool_name ?? step.tool_info?.name;
      const [mapped, input] = TOOLS[name] ?? [name, p => p];
      return { type: "assistant", message: { content: [
        { type: "tool_use", id, name: mapped, input: input(step.tool_info?.parameters ?? {}) },
      ] } };
    }
    if (step.state === "DONE" || step.state === "ERROR") {
      const error = step.tool_info?.error?.message;
      return { type: "user", message: { content: [
        { type: "tool_result", tool_use_id: id, content: error ?? "", is_error: step.state === "ERROR" },
      ] } };
    }
    return;
  }
  if (event.event === "result") {
    const res = event.result ?? {};
    if (res.status === "SUCCESS") {
      const u = res.usage ?? {};
      return { type: "result", subtype: "success", num_turns: 1, usage: {
        input_tokens: u.input_tokens ?? 0,
        cache_read_input_tokens: u.cache_read_tokens ?? 0,
        cache_creation_input_tokens: 0,
        output_tokens: u.output_tokens ?? 0,
      } };
    }
    return { type: "result", subtype: "error", is_error: true,
      result: res.error || res.response || "Antigravity turn failed" };
  }
}

export function antigravityArgs({ options, mode, artifactsDir, skillPath }) {
  const args = ["--output-format", "stream-json"];
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  if (mode === "workspace-write") args.push("--dangerously-skip-permissions");
  else {
    // Outside the workspace agy denies reads and ends the turn. The workspace is an empty directory
    // (see queryNative), so each allowed root needs its own grant.
    const reads = [options.cwd, "/workspace/related", artifactsDir, ...(skillPath ? [dirname(skillPath)] : [])];
    args.push("--agent", SCAN_AGENT, "--settings", JSON.stringify({ permissions: {
      allow: [...reads.map(root => `read_file(${root})`), "mcp(artifacts/write_artifact)"],
      deny: ["write_file(/)", "command(*)"],
    } }));
  }
  if (options.resume) args.push("--conversation", options.resume);
  return args;
}

export async function* queryNative(request) {
  const { options, mode, signal, persistOutput, onModelInfo } = request;
  // Workspace-write is only authorized inside the scanner container.
  if (mode === "workspace-write" && (options.cwd !== "/workspace/repo" || process.platform !== "linux" || !existsSync("/.dockerenv"))) throw new Error("Antigravity fixes require the scanner container workspace");
  let prompt = "";
  for await (const message of request.prompt) prompt += message.message.content;
  if (request.skillPath) prompt = `Read the skill at ${request.skillPath}.\n${prompt}`;
  let cwd = options.cwd;
  const home = request.env?.HOME || AGENT_HOME;
  let runHome;
  if (mode !== "workspace-write") {
    // agy runs hooks and MCP servers from the workspace's .agents and .agent folders, and the repo is
    // untrusted. Those commands would run as the agent user, which owns the login copy. A neutral
    // workspace never loads them.
    runHome = readOnlyHome(home, options.resume, [LOGIN]);
    const configDir = join(runHome, ".gemini", "config");
    const artifactContextPath = `${request.artifactsDir}/artifact-tool-context.json`;
    writeArtifact(artifactContextPath, JSON.stringify({ artifactsDir: request.artifactsDir, provider: "antigravity",
      reviewNotesFile: request.reviewNotesFile, scanInventory: request.scanInventory }));
    agentFs.mkdirSync(join(configDir, "agents"), { recursive: true, mode: 0o700 });
    agentFs.writeFileSync(join(configDir, "agents", `${SCAN_AGENT}.md`), SCAN_AGENT_DEFINITION);
    agentFs.writeFileSync(join(configDir, "mcp_config.json"), JSON.stringify({ mcpServers: { artifacts: {
      command: process.execPath,
      args: [fileURLToPath(new URL("./artifact-server.mjs", import.meta.url)), artifactContextPath],
    } } }));
    cwd = join(runHome, "scan-cwd");
    agentFs.mkdirSync(cwd, { recursive: true });
  }
  const args = antigravityArgs(request);
  const command = request.command ?? ["agy"];
  const names = ["PATH", "HOME", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"];
  const env = { ...agentEnv(Object.fromEntries(names.filter(k => request.env?.[k]).map(k => [k, request.env[k]]))),
    ...(runHome ? { HOME: runHome } : {}) };
  // agy treats piped stdin as the prompt. `-p -` would send the two characters "-".
  const child = agentSpawn(command[0], [...command.slice(1), ...args], { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let spawnError;
  const closed = new Promise(resolve => {
    child.once("error", error => { spawnError = error; });
    child.once("close", resolve);
  });
  child.stdin.on("error", error => { if (error.code !== "EPIPE") spawnError = error; });
  child.stdin.end(prompt);
  const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } };
  // Pause stops agy only between tools, so a write_artifact call is never cut off. agy answers SIGINT
  // with an "interrupted" error result and exits.
  const pendingTools = new Set();
  let paused = false, pauseTimer, killTimer;
  const pause = () => {
    if (!request.pauseSignal?.aborted || paused || pendingTools.size) return;
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
  let conversationId = options.resume;
  const texts = new Map();
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8000); });
  try {
    onModelInfo?.({ model: options.model, effort: options.effort });
    // Bun never ends stdout after a failed spawn, so the readline loop is closed by hand.
    const lines = createInterface({ input: child.stdout });
    child.once("error", () => lines.close());
    for await (const line of lines) {
      if (paused || !line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.event === "init") {
        conversationId = event.conversation_id;
        if (runHome) keepReadOnlyHome(conversationId, runHome);
      }
      if (event.event === "result" && event.result?.status === "SUCCESS" && conversationId) {
        const previous = conversationUsage.get(conversationId) ?? {};
        const total = event.result.usage ?? {};
        event.result.usage = Object.fromEntries(Object.entries(total).map(([key, value]) => [key, Math.max(0, value - (previous[key] ?? 0))]));
        conversationUsage.set(conversationId, total);
      }
      const message = mapEvent(event, texts);
      const text = message?.type === "assistant" && message.message.content[0].type === "text" ? message.message.content[0].text : "";
      if (text) persistOutput?.(redact(text));
      let deniedMessage;
      if (event.event === "result" && event.result?.denied_actions?.length) {
        const denied = event.result.denied_actions.map(action => action.action).join(", ");
        deniedMessage = `Antigravity denied ${denied}: outside the permitted tools and paths`;
        yield { type: "error", message: deniedMessage };
      }
      if (message?.type === "result") {
        // A read-only turn that agy cut short is a partial scan, so it must not export as complete.
        completed = message.subtype === "success" && !(deniedMessage && mode !== "workspace-write");
        if (message.subtype !== "success") failure = message.result;
        else if (!completed) failure = deniedMessage;
        else if (event.result?.response) persistOutput?.(redact(event.result.response));
      }
      for (const block of message?.message?.content ?? []) {
        if (block.type === "tool_use") pendingTools.add(block.id);
        if (block.type === "tool_result") pendingTools.delete(block.tool_use_id);
      }
      if (message) yield JSON.parse(redact(JSON.stringify(message)));
      pause();
    }
    await closed;
    if (spawnError) throw spawnError;
    if (signal?.aborted) throw new Error("Antigravity run cancelled");
    if (paused) return;
    if (failure || !completed) throw new Error(redact(failure || stderr || "Antigravity exited without a completed turn"));
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
