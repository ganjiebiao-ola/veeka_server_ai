import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A scan with MAX_SUBAGENTS=2: two starts pass, the third is denied, a subagent Write is denied.
// The SDK runs these through the PreToolUse hook, because canUseTool never sees Agent or Task.
const SUBAGENT_CALLS = `[
  ["Agent", { subagent_type: "Explore", prompt: "one" }],
  ["Task", { subagent_type: "Explore", prompt: "two" }],
  ["Agent", { subagent_type: "Explore", prompt: "three" }],
  ["Write", { file_path: ARTIFACTS_DIR + "/findings.json", content: "[]" }, "sub-1"],
  ["Write", { file_path: ARTIFACTS_DIR + "/findings.json", content: "[]" }],
]`;

for (const stop of ["SIGTERM", "SIGINT", "shutdown", "SDK failure", "main failure", "normal", "normal scan", "normal scan budget", "normal scan errors", "normal scan failure", "normal scan subagents", "normal shutdown", "normal slow export", "SIGTERM with SDK messages", "SIGTERM during export"]) {
  test(`bridge preserves partial artifacts on ${stop}`, { timeout: 20000 }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "ola-partial-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const repo = join(root, "repo");
    const artifacts = join(root, "artifacts");
    mkdirSync(repo);
    mkdirSync(artifacts);
    const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString().trim();
    git("init", "-q");
    git("config", "user.name", "test");
    git("config", "user.email", "test@example.local");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "fix.txt"), "before\n");
    // A scan runs only on a PHP repo.
    writeFileSync(join(repo, "composer.json"), "{}\n");
    git("add", ".");
    git("commit", "-qm", "base");
    writeFileSync(join(artifacts, "base.json"), JSON.stringify({ sha: git("rev-parse", "HEAD") }));
    writeFileSync(join(repo, "fix.txt"), "after\n");
    git("add", ".");
    git("commit", "-qm", "partial fix");
    const commit = git("rev-parse", "HEAD");

    const completes = ["normal", "normal scan", "normal scan budget", "normal scan errors", "normal scan failure", "normal scan subagents", "normal shutdown", "normal slow export", "SIGTERM with SDK messages", "SIGTERM during export"].includes(stop);
    const report = completes ? "Activity\n<!-- OLA:FINAL-SUMMARY -->\nSummary" : "Partial report";
    const errorFiles = stop === "normal scan errors"
      ? [...Array.from({ length: 51 }, (_, i) => `app/error-${i}.php`), "vendor/error.php"] : [];
    const coverage = stop === "normal scan failure"
      ? "## Not covered by Semgrep\n\n- app pass: Semgrep pre-pass failed. Continue with your own source search."
      : errorFiles.length ? "## Not covered by Semgrep\n\n" + errorFiles.map(path => `- ${JSON.stringify(path)}`).join("\n") : "";
    const vendorCoverage = stop === "normal scan errors"
      ? '## Vendor coverage gaps\n\n- "vendor-install-mode-unknown: vendor"\n- "vendor-metadata-missing: vendor"\n- "composer-metadata-missing: vendor"\n\n' : "";
    const expectedReport = (coverage ? coverage + "\n\n" : "") + vendorCoverage + report + "\n";
    const exportCalls = join(root, "export-calls.jsonl");
    const exportPids = join(root, "export-pids.jsonl");
    const bin = join(root, "bin");
    mkdirSync(bin);
    const realGit = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(join(bin, "git"), `#!${process.execPath}
      const { appendFileSync } = require("node:fs");
      const { execFileSync } = require("node:child_process");
      const args = process.argv.slice(2);
      appendFileSync(${JSON.stringify(exportCalls)}, JSON.stringify(args) + "\\n");
      if (args.includes("ls-files")) {
        process.stdout.write(execFileSync(${JSON.stringify(realGit)}, args));
        process.exit(0);
      }
      appendFileSync(${JSON.stringify(exportPids)}, process.pid + "\\n");
      ${stop === "SIGTERM during export" ? `
      process.stdout.write("started\\n");
      setInterval(() => {}, 1000);
      ` : `setTimeout(() => {
        process.stdout.write(execFileSync(${JSON.stringify(realGit)}, args));
      }, ${stop === "normal slow export" ? 1800 : 0});`}
    `, { mode: 0o755 });
    writeFileSync(join(bin, "semgrep"), `#!${process.execPath}
      console.log(JSON.stringify({ results: [], errors: [] }));
    `, { mode: 0o755 });
    const lateMessage = join(root, "late-message");
    if (stop.startsWith("normal scan")) {
      const results = stop === "normal scan budget"
        ? Array.from({ length: 205 }, (_, i) => ({
          check_id: i < 200 ? "rule-" + i : "rule-" + "x".repeat(80000), path: "fix.txt",
          start: { line: 1 }, extra: { metadata: { category: "sqli" }, message: "large ignored field" },
        }))
        : Array.from({ length: 2089 }, (_, i) => ({
          check_id: "rule-" + (i % 3), path: "file-" + (i % 100) + ".txt",
          start: { line: 5 - (Math.floor(i / 100) % 5) },
          extra: { metadata: { category: i % 2 ? "xss" : "sqli" }, message: "large ignored field" },
        }));
      for (const hit of results) {
        if (hit.path !== "fix.txt") writeFileSync(join(repo, hit.path), "source\n");
      }
      writeFileSync(join(repo, ".git/info/exclude"), "file-*.txt\nvendor/\n");
      if (errorFiles.length) {
        mkdirSync(join(repo, "vendor"));
        writeFileSync(join(repo, "vendor/error.php"), "<?php");
      }
      const errors = errorFiles.map(path => ({ path, rule_id: "sql", type: "Timeout", message: "Rule timed out" }));
      writeFileSync(join(bin, "semgrep"), `#!${process.execPath}
        ${stop === "normal scan failure" ? "process.exit(2);" : ""}
        const vendor = process.argv.includes("--no-git-ignore");
        const errors = ${JSON.stringify(errors)}.filter(error => vendor === error.path.startsWith("vendor/"));
        process.stdout.write(JSON.stringify({ results: vendor ? [] : ${JSON.stringify(results)}, errors }));
      `, { mode: 0o755 });
    }

    if (stop === "normal shutdown") {
      writeFileSync(join(artifacts, "repo-context.json"), JSON.stringify([
        { path: "operator-note.md", content: "Use parameter binding." },
      ]))
    }
    if (stop === "normal scan") {
      writeFileSync(join(artifacts, "repo-context.json"), JSON.stringify([
        { path: "security-defaults.md", content: "Bind every query." },
      ]))
    }

    // Run the real bridge with a deterministic SDK stream and temporary paths.
    let source = readFileSync(new URL("../bridge.mjs", import.meta.url), "utf8");
    source = source.replace('import { query } from "@anthropic-ai/claude-agent-sdk";', `
      async function* query({ prompt, options }) {
        ${stop === "normal shutdown" ? `
          const messages = []
          for await (const message of prompt) messages.push(message)
          writeFileSync(ARTIFACTS_DIR + "/note-prompt.json", JSON.stringify(messages))
        ` : ""}
        writeFileSync(ARTIFACTS_DIR + "/findings.json", JSON.stringify([{
          id: "picked-id", category: "sqli", severity: "P1", file: "fix.txt", line: 1, snippet: "query(input)",
          function: "run", sink: "query(input)", status: "candidate", fix_summary: "", reason: "unbound input"
        }]));
        ${stop.startsWith("normal scan") ? `
          const messages = [];
          for await (const message of prompt) messages.push(message);
          ${stop === "normal scan" ? `writeFileSync(ARTIFACTS_DIR + "/note-prompt.json", JSON.stringify(messages));` : ""}
          const decisions = [];
          const hook = options.hooks?.PreToolUse?.[0];
          const decide = async (tool, input, agentId) => hook
            ? ((await Promise.all(hook.hooks.map((fn) => fn({ tool_name: tool, tool_input: input, agent_id: agentId }, "id", {})))).some((out) => out.hookSpecificOutput?.permissionDecision === "deny") ? "deny" : "allow")
            : (await options.canUseTool(tool, input)).behavior;
          for (const [tool, input, agentId] of ${stop === "normal scan subagents" ? SUBAGENT_CALLS : `[
            ["Write", { file_path: ARTIFACTS_DIR + "/findings.json", content: "[]" }],
            ["Write", { file_path: REPO_DIR + "/fix.txt", content: "edited" }],
            ["Write", { file_path: ARTIFACTS_DIR + "/findings.json", content: '[{"status":"fixed"}]' }],
            ["Edit", { file_path: REPO_DIR + "/fix.txt" }],
            ["Bash", { command: "git commit -am fix" }],
            ["AskUserQuestion", {}],
            ["Agent", { subagent_type: "Explore", prompt: "scan another directory" }],
            ["Task", { subagent_type: "Explore", prompt: "scan another directory" }],
            ["Bash", { command: "printf %s '[]' | sha256sum" }],
            ["Bash", { command: "printf %s '[]' | sha256sum; touch fix.txt" }],
            ["Bash", { command: "printf %s '[]'$(touch fix.txt)'' | sha256sum" }],
            ["Write", { file_path: ARTIFACTS_DIR + "/auth.json", content: '{"login":{}}' }],
            ["Write", { file_path: ARTIFACTS_DIR + "/auth.json", content: "[]" }],
            ["WebFetch", { url: "https://example.test/api" }],
          ]`}) decisions.push(await decide(tool, input, agentId));
          writeFileSync(ARTIFACTS_DIR + "/request.json", JSON.stringify({
            model: options.model, effort: options.effort, messages, decisions,
            disallowedTools: options.disallowedTools,
          }));
        ` : ""}
        yield { type: "assistant", message: { content: [{ type: "text", text: ${JSON.stringify(report)} }] } };
        ${stop === "SIGTERM with SDK messages" ? 'const terminated = new Promise((resolve) => process.once("SIGTERM", resolve));' : ""}
        yield { type: "test_ready" };
        ${stop === "SIGTERM with SDK messages" ? `
          await terminated;
          writeFileSync(${JSON.stringify(lateMessage)}, "SDK resumed after SIGTERM");
          yield { type: "assistant", message: { content: [{ type: "text", text: "Late activity\\n<!-- OLA:FINAL-SUMMARY -->\\nLate summary" }] } };
          await new Promise(() => {});
        ` : stop === "SDK failure" ? 'throw new Error("SDK failed");' : completes ? "" : 'await new Promise(() => {});'}
      }
    `);
    source = source.replaceAll('"/workspace/repo"', JSON.stringify(repo));
    source = source.replaceAll('"/workspace/artifacts"', JSON.stringify(artifacts));
    for (const name of ["exports", "push", "vendor", "call-check", "semgrep", "fix-loop", "checks", "resume", "finding-ids", "redact", "artifacts", "smoke", "profile", "agent-user", "agent-fs"]) {
      source = source.replaceAll(`"./lib/${name}.mjs"`, JSON.stringify(new URL(`./${name}.mjs`, import.meta.url).href));
    }
    if (stop === "main failure") {
      source = source.replace('let result = skipFix ? { ok: true } : await runOneRound(round, round1Prompt);', 'throw new Error("main failed");');
    }
    source = source.replaceAll('"../shared/providers.json"', JSON.stringify(new URL('../../shared/providers.json', import.meta.url).href))
    source = source.replace('"../skill/ola-security-audit/findings.schema.json"', JSON.stringify(new URL("../../skill/ola-security-audit/findings.schema.json", import.meta.url).href));
    const script = join(root, "bridge.mjs");
    writeFileSync(script, source);
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MODEL: "sonnet", EFFORT: "", MAX_SUBAGENTS: stop === "normal scan subagents" ? "2" : "", EVENTS_LOG: "1", PROMPT_FILE: "", CATEGORIES: "", MODE: stop === "normal shutdown" ? "fix" : "scan" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    t.after(() => child.kill("SIGKILL"));
    const exited = once(child, "exit");
    let stderr = "";
    child.stderr.on("data", (data) => { stderr += data; });
    if (stop !== "main failure") {
      if (stop === "SIGTERM during export") {
        while (true) {
          try {
            if (readFileSync(join(artifacts, "working.patch"), "utf8") === "started\n") break;
          } catch {}
          await delay(10);
        }
      } else await new Promise((resolve, reject) => {
        let output = "";
        child.stdout.on("data", (data) => {
          output += data;
          const ready = stop.startsWith("normal") ? '"kind":"run_finished"' : '"type":"test_ready"';
          if (output.includes(ready)) resolve();
        });
        child.once("error", reject);
        child.once("exit", () => reject(new Error(`bridge exited before ready: ${stderr}`)));
      });
      assert.equal(readFileSync(join(artifacts, "report.md"), "utf8"), expectedReport);
    }
    if (stop === "SIGINT") child.kill(stop);
    if (stop.startsWith("SIGTERM")) child.kill("SIGTERM");
    if (stop === "shutdown" || stop === "normal shutdown") child.stdin.write('{"type":"shutdown"}\n');
    const [code, signal] = await exited;
    assert.equal(signal, null, stderr);
    assert.equal(code, stop === "shutdown" || stop.startsWith("normal") ? 0 : stop.startsWith("SIGTERM") ? 143 : stop === "SIGINT" ? 130 : 1, stderr);
    const text = stop === "main failure" ? "\n" : expectedReport;
    assert.equal(readFileSync(join(artifacts, "report.md"), "utf8"), text);
    assert.equal(text.includes("## Not covered by Semgrep"), Boolean(coverage));
    assert.equal(readFileSync(join(artifacts, "response.md"), "utf8"), completes ? "Summary\n" : text);
    if (completes) assert.equal(readFileSync(join(artifacts, "activity.md"), "utf8"), "Activity\n");
    if (stop !== "main failure") {
      const rows = JSON.parse(readFileSync(join(artifacts, "findings.json"), "utf8"));
      if (stop === "normal shutdown") {
        assert.equal(rows[0].id, "picked-id");
        assert.equal(rows[0].function, "run");
      } else {
        assert.equal(rows[0].id, createHash("sha256").update(JSON.stringify(["sqli", "fix.txt", "run", "query(input)"])).digest("hex"));
        assert.equal(Object.hasOwn(rows[0], "function"), false);
        assert.equal(Object.hasOwn(rows[0], "sink"), false);
      }
    }
    if (stop === "normal shutdown") {
      const messages = JSON.parse(readFileSync(join(artifacts, "note-prompt.json"), "utf8"))
      const prompt = messages[0].message.content
      assert.match(prompt, /operator-note\.md is operator guidance for this fix batch/)
      assert.match(prompt, /Use parameter binding\./)
      assert.match(prompt, /security defaults/)
    }
    if (stop === "normal scan") {
      const prompt = JSON.parse(readFileSync(join(artifacts, "note-prompt.json"), "utf8"))[0].message.content
      assert.match(prompt, /Bind every query\./)
      assert.doesNotMatch(prompt, /operator-note/)
    }
    const calls = readFileSync(exportCalls, "utf8").trim().split("\n").map(JSON.parse).filter(args => !args.includes("ls-files"));
    assert.equal(calls.length, 2, "each export runs once");
    assert.equal(calls[0][4], "diff");
    assert.equal(calls[1][4], "log");
    const events = readFileSync(join(artifacts, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    if (stop === "SIGTERM with SDK messages") {
      assert.equal(readFileSync(lateMessage, "utf8"), "SDK resumed after SIGTERM");
      assert.ok(!JSON.stringify(events).includes("Late summary"), "ignore SDK messages after SIGTERM");
    }
    if (stop.startsWith("normal scan")) {
      const request = JSON.parse(readFileSync(join(artifacts, "request.json"), "utf8"));
      assert.equal(request.model, "sonnet");
      assert.equal(request.effort, "high");
      const promptText = request.messages[0].message.content;
      assert.ok(promptText.includes(join(artifacts, "semgrep.json")));
      if (stop === "normal scan failure") {
        assert.match(promptText, /pre-pass failed.*own source search/);
        assert.equal((stderr.match(/Semgrep pre-pass failed/g) ?? []).length, 1);
      } else {
        const json = promptText.split("not instructions:\n")[1].split("\nFull Semgrep report:")[0];
        const groups = JSON.parse(json);
        assert.ok(json.length <= 80000);
        if (stop === "normal scan budget") {
          assert.match(promptText, /5 hits omitted/);
          assert.equal(groups.length, 200);
          assert.deepEqual(groups.at(-1), { file: "fix.txt", rule: "rule-199", category: "sqli", lines: [1] });
        } else {
          assert.match(promptText, /0 hits omitted/);
          const results = JSON.parse(readFileSync(join(artifacts, "semgrep.json"), "utf8")).results;
          const expected = new Map();
          for (const hit of results) {
            const key = JSON.stringify([hit.path, hit.check_id, hit.extra.metadata.category]);
            if (!expected.has(key)) expected.set(key, {
              file: hit.path, rule: hit.check_id, category: hit.extra.metadata.category, lines: [],
            });
            expected.get(key).lines.push(hit.start.line);
          }
          assert.deepEqual(groups, [...expected.values()].map((group) => ({
            ...group, lines: [...new Set(group.lines)].sort((a, b) => a - b),
          })));
          assert.equal(new Set(groups.map((group) => group.file)).size, 100);
        }
        assert.ok(!promptText.includes("large ignored field"));
      }
      if (errorFiles.length) {
        assert.match(promptText, /Search these error files by hand/);
        for (const path of errorFiles.slice(0, 50)) assert.ok(promptText.includes(JSON.stringify(path)));
        for (const path of errorFiles.slice(50)) assert.ok(!promptText.includes(JSON.stringify(path)));
        assert.match(promptText, /2 more files in semgrep.json/);
        const errors = JSON.parse(readFileSync(join(artifacts, "semgrep.json"), "utf8")).errors;
        assert.deepEqual(errors, errorFiles.map(path => ({
          pass: path.startsWith("vendor/") ? "vendor" : "app", rule: "sql", path, message: "Rule timed out", retried: true,
        })));
        for (const path of errorFiles) assert.ok(text.includes(JSON.stringify(path)));
      }
      if (stop === "normal scan subagents") {
        // Cap 2: two parallel-safe starts pass, the third and a subagent Write do not.
        assert.deepEqual(request.decisions, ["allow", "allow", "deny", "deny", "allow"]);
        assert.ok(!request.disallowedTools.includes("Agent"));
        assert.ok(!request.disallowedTools.includes("Task"));
        assert.ok(request.disallowedTools.includes("Edit"));
        assert.ok(request.disallowedTools.includes("WebFetch") && request.disallowedTools.includes("WebSearch"));
        assert.match(request.messages[0].message.content, /^\/ola-security-audit scan.* max-subagents=2/);
      } else {
        assert.deepEqual(request.decisions, ["allow", "deny", "deny", "deny", "deny", "deny", "deny", "deny", "deny", "deny", "deny", "allow", "deny", "deny"]);
        assert.ok(request.disallowedTools.includes("Agent"));
        assert.ok(request.disallowedTools.includes("Task"));
        assert.ok(!request.messages[0].message.content.includes("max-subagents"));
      }
      assert.match(request.messages[0].message.content, /^\/ola-security-audit scan/);
      if (stop === "normal scan") assert.match(request.messages[0].message.content, /"category":"sqli"/);
      assert.equal(JSON.parse(readFileSync(join(artifacts, "semgrep.json"), "utf8")).results.length, stop === "normal scan failure" ? 0 : stop === "normal scan budget" ? 205 : 2089);
      assert.equal(git("status", "--porcelain"), "");
    }
    const failures = events.filter((event) => event.kind === "scanner_failed");
    assert.equal(failures.length, ["SDK failure", "main failure", "SIGINT"].includes(stop) ? 1 : 0);
    if (stop.startsWith("SIGTERM")) assert.equal(events.filter((event) => event.kind === "run_finished").length, 0);
    if (completes && !stop.startsWith("SIGTERM")) assert.equal(events.filter((event) => event.kind === "run_finished").length, 1);
    if (stop === "SIGTERM during export") {
      assert.equal((stderr.match(/export exited with SIGKILL/g) ?? []).length, 2);
      for (const name of ["working.patch", "commits.log"]) {
        assert.equal(readFileSync(join(artifacts, name), "utf8"), "started\n");
      }
      const pids = readFileSync(exportPids, "utf8").trim().split("\n").map(Number);
      assert.equal(pids.length, 2);
      for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      return;
    }
    assert.equal(readFileSync(join(artifacts, "working.patch"), "utf8"), git("diff", git("rev-parse", "HEAD~1")) + "\n");
    assert.equal(readFileSync(join(artifacts, "commits.log"), "utf8"), git("log", "HEAD~1..HEAD", "--format=%H%n%s%n%b%n--END--") + "\n");
    assert.match(readFileSync(join(artifacts, "working.patch"), "utf8"), /\+after/);
    assert.ok(readFileSync(join(artifacts, "commits.log"), "utf8").includes(commit));
  });
}
