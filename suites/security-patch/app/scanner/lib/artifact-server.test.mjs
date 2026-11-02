import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { artifactPermission } from "./artifacts.mjs";
import { rpc, writeArtifactTool } from "./artifact-server.mjs";

function fixture(t) {
  const artifactsDir = mkdtempSync(join(tmpdir(), "artifact-tool-"));
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }));
  return { artifactsDir, scanInventory: { files: ["a.php"], categories: ["sqli"] } };
}

test("artifact tool writes only allowed scan paths with shared validation", t => {
  const context = fixture(t);
  for (const [name, content] of [["findings.json", '[{"status":"candidate"}]'], ["auth.json", '{}'], ["scan-coverage.json", '["a.php"]']]) {
    const path = join(context.artifactsDir, name);
    writeArtifactTool({ path, content }, context);
    assert.equal(readFileSync(path, "utf8"), artifactPermission({ file_path: path, content }, context).updatedInput.content);
  }
  for (const [name, content] of [["../escape.json", "[]"], ["report.md", "x"], ["findings.json", "{}"],
    ["findings.json", '[{"status":"fixed","file":"a.php"}]'], ["auth.json", "[]"], ["scan-coverage.json", '["../a.php"]']]) {
    const path = join(context.artifactsDir, name);
    const denied = artifactPermission({ file_path: path, content }, context);
    const result = rpc({ id: 1, method: "tools/call", params: { name: "write_artifact", arguments: { path, content } } }, context);
    assert.equal(result.result.isError, true);
    const message = result.result.content[0].text;
    assert.doesNotMatch(message, /\b(Read|Glob|Grep|Write)\b/);
    if (name === "findings.json") assert.match(message, /write_artifact/);
    else assert.equal(message, denied.message);
  }
});

test("review tool writes its notes only, and rejects symlinks", t => {
  const context = fixture(t);
  context.reviewNotesFile = join(context.artifactsDir, "review-1.json");
  writeArtifactTool({ path: context.reviewNotesFile, content: '[]' }, context);
  assert.throws(() => writeArtifactTool({ path: join(context.artifactsDir, "findings.json"), content: '[]' }, context), /review pass only reads/);
  rmSync(context.reviewNotesFile);
  const outside = join(tmpdir(), `artifact-outside-${process.pid}`);
  writeFileSync(outside, "unchanged");
  t.after(() => rmSync(outside, { force: true }));
  symlinkSync(outside, context.reviewNotesFile);
  assert.throws(() => writeArtifactTool({ path: context.reviewNotesFile, content: '[]' }, context), /outside the workspace/);
  assert.equal(readFileSync(outside, "utf8"), "unchanged");
});

test("stdio MCP initializes, lists a single tool, handles calls and ignores notifications", t => {
  const context = fixture(t);
  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "write_artifact", arguments: { path: join(context.artifactsDir, "findings.json"), content: '[]' } } },
  ].map(JSON.stringify).join("\n") + "\n";
  const contextPath = join(context.artifactsDir, "context.json");
  writeFileSync(contextPath, JSON.stringify(context));
  const child = spawnSync(process.execPath, [new URL("./artifact-server.mjs", import.meta.url).pathname, contextPath], { input, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const replies = child.stdout.trim().split("\n").map(JSON.parse);
  assert.deepEqual(replies.map(r => r.id), [1, 2, 3]);
  assert.deepEqual(replies[1].result.tools.map(t => t.name), ["write_artifact"]);
  assert.equal(replies[2].result.isError, undefined);
  assert.equal(readFileSync(join(context.artifactsDir, "findings.json"), "utf8"), '[]');
});


test("symlinks between allowed artifacts retain the target's validation", t => {
  const context = fixture(t);
  const auth = join(context.artifactsDir, "auth.json");
  writeFileSync(auth, "{}");
  symlinkSync(auth, join(context.artifactsDir, "findings.json"));
  assert.throws(() => writeArtifactTool({ path: join(context.artifactsDir, "findings.json"), content: "[]" }, context), /auth.json must be a JSON object/);
  assert.equal(readFileSync(auth, "utf8"), "{}");
});


test("Claude artifact errors retain their exact tool wording", t => {
  const context = fixture(t);
  const file_path = join(context.artifactsDir, "findings.json");
  assert.equal(artifactPermission({ file_path, content: "{}" }, context).message,
    "Use Write for findings.json with a JSON array and candidate status for every finding. Scan tools: Read, Glob, Grep, Skill, Write.");
  assert.equal(artifactPermission({ file_path, content: '[{"status":"fixed","file":"a.php"}]' }, context).message,
    "Write findings.json: finding 1 (a.php) requires candidate status. Scan tools: Read, Glob, Grep, Skill, Write.");
});
