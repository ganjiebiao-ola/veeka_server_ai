import { readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { artifactPermission, providerWording } from "./artifacts.mjs";
import { agentFs, checkedPath } from "./agent-fs.mjs";

export function writeArtifactTool(args, context) {
  let permission = artifactPermission({ file_path: args?.path, content: args?.content }, context);
  if (permission.behavior !== "allow") throw new Error(permission.message);
  if (typeof args.content !== "string") throw new Error("content must be a string");
  const file = checkedPath(args.path, [context.artifactsDir], true);
  const target = join(context.artifactsDir, relative(realpathSync(context.artifactsDir), file));
  if (target !== args.path) {
    permission = artifactPermission({ file_path: target, content: args.content }, context);
    if (permission.behavior !== "allow") throw new Error(permission.message);
  }
  agentFs.writeFileSync(file, permission.updatedInput.content);
  return { content: [{ type: "text", text: "Artifact written" }] };
}

export function rpc(request, context) {
  if (request.id === undefined) return;
  const reply = result => ({ jsonrpc: "2.0", id: request.id, result });
  switch (request.method) {
    case "initialize":
      return reply({ protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: "scan-artifacts", version: "1.0.0" } });
    case "ping": return reply({});
    case "tools/list":
      return reply({ tools: [{ name: "write_artifact", description: "Write an allowed scan artifact or review notes file.",
        inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"], additionalProperties: false } }] });
    case "tools/call":
      try {
        if (request.params?.name !== "write_artifact") throw new Error("Unknown tool");
        return reply(writeArtifactTool(request.params.arguments, context));
      } catch (error) { return reply({ isError: true, content: [{ type: "text", text: providerWording(context.provider ?? "codex").artifactError(error.message) }] }); }
    default:
      return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const context = JSON.parse(readFileSync(process.argv[2], "utf8"));
  for await (const line of createInterface({ input: process.stdin })) {
    let response;
    try { response = rpc(JSON.parse(line), context); }
    catch { response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }; }
    if (response) process.stdout.write(JSON.stringify(response) + "\n");
  }
}
