import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../bridge.mjs", import.meta.url), "utf8");
const guard = source.slice(source.indexOf("const SHELL_WORD"), source.indexOf("// Restore summarized thinking"));
const canUseTool = new Function("reviewNotesFile", "MODE", `${guard}\nreturn canUseTool;`)(null, "fix");

for (const command of [
  'git "push" origin main', "git 'push' origin main", 'git pu"sh" origin main',
  "gh --repo owner/repo pr merge 1", "gh -R owner/repo pr merge 1", "gh --repo=owner/repo pr merge 1",
  "git push origin main", "git -C /workspace/repo push origin main", "git -c a=b push",
  "git -C '/workspace/my repo' -c a=b --no-pager push", "git --git-dir=/tmp/repo push",
  "rm -rf x", "rm -fr x", "rm -r -f x", "rm -f -r x", "rm -Rfv x",
  "rm --recursive -f x", "rm -r x -f", "echo ok; rm -fr x",
  "gh api repos/owner/repo", "gh pr create", "gh pr merge", "gh pr edit", "gh pr close",
  "gh pr ready", "gh repo create", "gh release create",
]) {
  test(`Bash denies ${command}`, async () => {
    assert.equal((await canUseTool("Bash", { command })).behavior, "deny");
  });
}

for (const command of [
  "git commit -m 'msg'", "git -C /workspace/repo commit", "php vendor/bin/phpunit", "rm one-file.php", "gh pr view 1",
  "git status", "git diff", "git log", "git add file", "git commit -m fix",
  "git -C /workspace/repo commit -m fix", "git -c a=b commit -m fix",
  "rm file", "rm -f file", "rm -r directory", "gh pr view", "gh issue view",
]) {
  test(`Bash allows ${command}`, async () => {
    assert.equal((await canUseTool("Bash", { command })).behavior, "allow");
  });
}

test("the bridge hands the OpenAI key to the Codex driver only", async () => {
  assert.equal(source.split("\n").filter(line => line.includes("OPENAI_API_KEY")).length, 1);
  assert.match(source, /queryNative\(\{[^]*?env: \{ \.\.\.agentEnv, OPENAI_API_KEY: process\.env\.OPENAI_API_KEY \},/);
  const { agentEnv } = await import("./agent-user.mjs");
  const previous = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, CODEX_API_KEY: process.env.CODEX_API_KEY };
  process.env.OPENAI_API_KEY = "FAKE_OPENAI_KEY";
  process.env.CODEX_API_KEY = "FAKE_CODEX_KEY";
  try {
    // The Claude SDK env, checks, semgrep, vendor and push all build their env from agentEnv().
    const env = agentEnv();
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.CODEX_API_KEY, undefined);
    for (const file of ["checks", "semgrep", "vendor", "profile", "push"]) {
      assert.match(readFileSync(new URL(`./${file}.mjs`, import.meta.url), "utf8"), /env: agentEnv\(\)/);
    }
  } finally {
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});

test("the agent options use the scrubbed environment and the agent-user spawn", () => {
  assert.match(source, /const agentEnv = makeAgentEnv\(process\.env\)/);
  assert.match(source, /env: agentEnv/);
  assert.match(source, /spawnClaudeCodeProcess: .*=> \{\s*const child = agentSpawn\(/);
  assert.match(source, /env: agentEnv/);
});
