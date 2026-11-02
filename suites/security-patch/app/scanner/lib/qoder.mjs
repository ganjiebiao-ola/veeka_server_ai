import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { agentSpawn, agentEnv, AGENT_HOME } from "./agent-user.mjs";
import { agentFs, copyFiles, dropReadOnlyHome, keepReadOnlyHome, readOnlyHome, writeArtifact } from "./agent-fs.mjs";
import { redact } from "./redact.mjs";

function failureMessage(detail) {
  return /not logged in|\/login|\bauth|unauthori[sz]ed|machine.?id|\b401\b/i.test(detail)
    ? `Qoder authentication failed in the scanner container; log in with qodercli on the host and check OLA_AGENT_QODER_AUTH_PATH (machine_id may bind the login to the host). ${detail}` : detail;
}

const AUTH = ".qoder/.auth";
const positive = n => typeof n === "number" && Number.isFinite(n) && n > 0;

export function mapEvent(event) {
  if (event.type === "system" && event.subtype === "init") {
    return { type: "system", subtype: "init", session_id: event.session_id, model: event.model };
  }
  if (event.type === "assistant" || event.type === "user") {
    const content = (event.message?.content ?? []).map(block =>
      block.type === "tool_use" && block.name === "mcp__artifacts__write_artifact" ? { ...block, name: "write_artifact" } : block);
    // Qoder bills in credits and reports zero tokens. Each API reply carries its own credits on its last chunk;
    // earlier chunks of the same id report 0 and must not mark the id as counted.
    const credits = event.type === "assistant" ? event.message?.usage?.credits : undefined;
    return { type: event.type, message: { content,
      ...(positive(credits) ? { id: event.message.id, usage: { credits } } : {}) } };
  }
  if (event.type === "result") {
    // The turn total also covers credits no streamed reply carried (subagents), so it corrects the round.
    return event.subtype === "success" && !event.is_error
      ? { type: "result", subtype: "success", num_turns: event.num_turns ?? 1,
        ...(positive(event.total_credits) ? { usage: { credits: event.total_credits } } : {}) }
      : { type: "result", subtype: "error", is_error: true,
        result: failureMessage([event.result, ...(event.errors ?? [])].filter(Boolean).join(" ") || "Qoder turn failed") };
  }
}

export function qoderArgs({ options, mode, artifactsDir, skillPath, configDir, mcpConfigPath }) {
  // Only the agent-owned config dir supplies settings, so a repo's .qoder hooks never load.
  const args = ["-p", "-o", "stream-json", "--config-dir", configDir, "--setting-sources", "user"];
  if (options.model) args.push("--model", options.model);
  if (options.resume) args.push("--resume", options.resume);
  if (mode === "workspace-write") args.push("--dangerously-skip-permissions");
  else {
    // --tools removes every other built-in (Agent, Monitor, NotebookEdit...); --allowed-tools alone does not.
    args.push("--permission-mode", "dont_ask", "--tools", "Read,Grep,Glob",
      "--allowed-tools", "Read,Grep,Glob,mcp__artifacts__write_artifact",
      "--disallowed-tools", "Write,Edit,NotebookEdit,Bash,Monitor,WebFetch,WebSearch,Task,Agent,mcp_call,mcp_get,mcp_list",
      "--mcp-config", mcpConfigPath, "--strict-mcp-config", "--allowed-mcp-server-names", "artifacts");
  }
  for (const dir of [options.cwd, "/workspace/related", artifactsDir, ...(skillPath ? [dirname(skillPath)] : [])]) {
    args.push("--add-dir", dir);
  }
  return args;
}

export async function* queryNative(request) {
  const { options, mode, signal, persistOutput, onModelInfo } = request;
  if (mode === "workspace-write" && (options.cwd !== "/workspace/repo" || process.platform !== "linux" || !existsSync("/.dockerenv"))) throw new Error("Qoder fixes require the scanner container workspace");
  let prompt = "";
  for await (const message of request.prompt) prompt += message.message.content;
  if (request.skillPath) prompt = `Read the skill at ${request.skillPath}.\n${prompt}`;
  const home = request.env?.HOME || AGENT_HOME;
  let configDir = join(home, ".qoder");
  let mcpConfigPath, runHome;
  let cwd = options.cwd;
  if (mode === "workspace-write") agentFs.mkdirSync(configDir, { recursive: true });
  else {
    runHome = readOnlyHome(home, options.resume, [[AUTH, /^(user|machine_id|dynamic-.*\.json)$/]]);
    configDir = join(runHome, ".qoder");
    mcpConfigPath = join(configDir, "artifacts-mcp.json");
    agentFs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const artifactContextPath = `${request.artifactsDir}/artifact-tool-context.json`;
    writeArtifact(artifactContextPath, JSON.stringify({ artifactsDir: request.artifactsDir, provider: "qoder",
      reviewNotesFile: request.reviewNotesFile, scanInventory: request.scanInventory }));
    agentFs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { artifacts: {
      command: process.execPath,
      args: [fileURLToPath(new URL("./artifact-server.mjs", import.meta.url)), artifactContextPath],
    } } }));
    // Never load hooks or MCP configuration from the untrusted repository.
    cwd = join(runHome, "scan-cwd");
    agentFs.mkdirSync(cwd, { recursive: true });
  }
  const args = qoderArgs({ ...request, configDir, mcpConfigPath });
  const command = request.command ?? ["qodercli"];
  const names = ["PATH", "HOME", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"];
  const env = { ...agentEnv(Object.fromEntries(names.filter(k => request.env?.[k]).map(k => [k, request.env[k]]))),
    ...(runHome ? { HOME: runHome } : {}) };
  // Print mode accepts stdin, avoiding the per-argument limit for large scan prompts.
  const child = agentSpawn(command[0], [...command.slice(1), ...args], { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let spawnError;
  const closed = new Promise(resolve => {
    child.once("error", error => { spawnError = error; });
    child.once("close", resolve);
  });
  child.stdin.on("error", error => { if (error.code !== "EPIPE") spawnError = error; });
  child.stdin.end(prompt);
  const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } };
  // Wait for every tool result before interrupting, so artifact writes finish.
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
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8000); });
  try {
    onModelInfo?.({ model: options.model });
    // Bun never ends stdout after a failed spawn, so the readline loop is closed by hand.
    const lines = createInterface({ input: child.stdout });
    child.once("error", () => lines.close());
    for await (const line of lines) {
      if (paused || !line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === "system" && event.subtype === "init") {
        if (event.model) onModelInfo?.({ model: event.model });
        if (runHome) keepReadOnlyHome(event.session_id, runHome);
      }
      const message = mapEvent(event);
      const text = (message?.message?.content ?? []).filter(block => block.type === "text").map(block => block.text).join("\n");
      if (text) persistOutput?.(redact(text));
      // A read-only turn that Qoder cut short is a partial scan, so it must not export as complete.
      if (mode !== "workspace-write" && (event.subtype === "permission_denied" || event.permission_denials?.length)) {
        const tool = event.tool_name ?? event.permission_denials?.[0]?.tool_name;
        failure = `Qoder denied ${tool ?? "an action"}: outside the permitted tools and paths`;
      }
      if (message?.type === "result") {
        completed = message.subtype === "success" && !failure;
        if (message.subtype !== "success") failure = message.result;
        if (failure) Object.assign(message, { subtype: "error", is_error: true, result: failure });
        else if (event.result) persistOutput?.(redact(event.result));
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
    if (signal?.aborted) throw new Error("Qoder run cancelled");
    if (paused) return;
    if (failure || !completed) {
      throw new Error(failure ? redact(failure) : failureMessage(redact(stderr || "Qoder exited without a completed turn")));
    }
  } finally {
    request.pauseSignal?.removeEventListener("abort", pause);
    clearTimeout(pauseTimer);
    clearTimeout(killTimer);
    signal?.removeEventListener("abort", kill);
    kill();
    await closed;
    // The container's copy-back reads the agent's login, so a token refreshed here goes there.
    if (runHome) {
      copyFiles(join(runHome, AUTH), join(home, AUTH), /^user$/);
      dropReadOnlyHome(runHome);
    }
  }
}
