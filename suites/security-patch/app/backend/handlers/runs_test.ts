import { join } from "node:path"
import { tmpdir } from "node:os"
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { test } from "bun:test"
import { deepStrictEqual as assertEquals } from "node:assert/strict"
import { Store } from "../store/repo.ts";
import type { RunScannerArgs } from "../docker/controller.ts";
import type { Context } from "hono";
import { handleResumeRun, handleStartRun, handleGetRun, handleListAllRuns, handleListRuns, handleStopRun, handleActiveRuns, handleRunArtifact, providerSelection } from "./runs.ts";
import { displayModelInfo } from "../../frontend/src/types/events.ts";
import type { RunSummary } from "../../shared/types.ts";
import { parseEventsLog } from "../../frontend/src/hooks/useRunEvents.ts";

// --- category validation --------------------------------------------------

test("artifact downloads stream UTF-8 bytes and reject missing files and directories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const runId = "artifact-test"
  const path = join(dir, runId, "artifacts", "working.patch")
  const c = {
    req: { param: (name: string) => name === "id" ? runId : "patch" },
    json: (body: unknown, status = 200) => Response.json(body, { status }),
  } as unknown as Context
  try {
    assertEquals((await handleRunArtifact(c, { runsRootDir: dir })).status, 404)
    await mkdir(join(dir, runId, "artifacts"), { recursive: true })
    const body = "résumé\n"
    await writeFile(path, body)
    const response = await handleRunArtifact(c, { runsRootDir: dir })
    assertEquals(response.status, 200)
    assertEquals(response.headers.get("Content-Length"), String(Buffer.byteLength(body)))
    assertEquals(response.headers.get("Cache-Control"), "no-store")
    assertEquals(await response.text(), body)
    await rm(path)

    const eventsPath = join(dir, runId, "artifacts", "events.jsonl")
    const eventsContent = '{"type":"tool_invoked","tool":"Bash"}\n'
    await writeFile(eventsPath, eventsContent)
    const cEvents = {
      req: { param: (name: string) => name === "id" ? runId : "events" },
      json: (b: unknown, status = 200) => Response.json(b, { status }),
    } as unknown as Context
    const eventsResp = await handleRunArtifact(cEvents, { runsRootDir: dir })
    assertEquals(eventsResp.status, 200)
    assertEquals(await eventsResp.text(), eventsContent)
    await rm(eventsPath)

    await mkdir(path)
    assertEquals((await handleRunArtifact(c, { runsRootDir: dir })).status, 400)
  } finally { await rm(dir, { recursive: true }) }
})

test("historical replay maps real bridge frames and preserves raw artifact downloads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const runId = "replay-test"
  const path = join(dir, runId, "artifacts", "events.jsonl")
  const context = (replay: boolean) => ({
    req: {
      param: (name: string) => name === "id" ? runId : "events",
      query: (name: string) => replay && name === "replay" ? "1" : undefined,
    },
    json: (body: unknown, status = 200) => Response.json(body, { status }),
  } as unknown as Context)
  try {
    assertEquals((await handleRunArtifact(context(true), { runsRootDir: dir })).status, 404)
    await mkdir(join(dir, runId, "artifacts"), { recursive: true })
    for (const end of ["completed", "failed", "stopped"]) {
      const frames = [
        { kind: "sdk_message", message: { type: "assistant", message: { content: {} } } },
        { kind: "indexing_started", dirs: ["app"] },
        { kind: "sdk_message", message: { type: "assistant", message: { content: [
          { type: "tool_use", id: "index-write", name: "Write", input: { file_path: "app/CLAUDE.md" } },
        ] } } },
        { kind: "indexing_done", degraded: true },
        { kind: "round_started", round: 1 },
        { kind: "sdk_message", ts: 1234, message: { type: "assistant", message: { content: [
          { type: "thinking", thinking: "Check the affected code" },
          { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "pwd" } },
        ] } } },
        { kind: "sdk_message", message: { type: "user", message: { content: [
          { type: "tool_result", tool_use_id: "bash-1", content: "/workspace/repo", is_error: false },
        ] } } },
        ...(end === "failed" ? [{ kind: "scanner_failed", error: "fixture failure" }] : []),
        ...(end === "stopped" ? [{ kind: "run_stopped", reason: "quota" }] : []),
        { kind: "run_finished" },
      ]
      const text = "malformed line\nnull\n" + frames.map(frame => JSON.stringify({ runId, ...frame })).join("\n")
      await writeFile(path, text)
      const raw = await handleRunArtifact(context(false), { runsRootDir: dir })
      assertEquals(await raw.text(), text)
      const response = await handleRunArtifact(context(true), { runsRootDir: dir })
      assertEquals(response.status, 200)
      assertEquals(response.headers.get("Content-Type"), "application/x-ndjson; charset=utf-8")
      assertEquals(response.headers.get("Content-Length"), null)
      const replay = parseEventsLog(await response.text(), "fix")
      assertEquals(replay.timeline.filter(entry => "thinking" in entry), [{ thinking: "Check the affected code", ts: 1234 }])
      assertEquals(replay.timeline.filter(entry => "tool" in entry), [{ tool: 0 }, { tool: 1 }])
      assertEquals(replay.toolLog.map(tool => tool.tool), ["Write", "Bash"])
      assertEquals(replay.toolLog[1].input, { command: "pwd" })
      assertEquals(replay.toolLog[1].ts, 1234)
      assertEquals(replay.toolLog[1].ok, true)
      assertEquals(replay.toolLog[1].summary, "/workspace/repo")
      // events.jsonl has no clone frames, so a scan frame must close prepare and ingest.
      assertEquals(replay.steps.filter(step => ["prepare", "ingest"].includes(step.name)).map(step => step.status), ["completed", "completed"])
      assertEquals(replay.steps.find(step => step.name === "fix")?.status, "pending")
      assertEquals(replay.steps.find(step => step.name === "scan")?.status, end === "completed" ? "completed" : "in_progress")
      assertEquals(replay.steps.find(step => step.name === "report")?.status, end === "completed" ? "completed" : "pending")
    }
  } finally {
    await rm(dir, { recursive: true })
  }
})
// The category checks all return before any dep is touched, so a fake Context
// that just captures (status, body) is enough — deps are never dereferenced.
function runStart(body: unknown, deps: object = {}): Promise<{ status: number; error?: string }> {
  let status = 0;
  let payload: { error?: string } = {};
  const c = {
    req: { json: () => Promise.resolve(body) },
    json: (obj: { error?: string }, s = 200) => { payload = obj; status = s; return new Response(); },
  } as unknown as Context;
  return handleStartRun(c, deps as never).then(() => ({ status, error: payload.error }), (e) => ({ status: -1, error: String(e) }));
}

const validBase = {
  sessionId: "s1", repoUrl: "https://github.com/a/b",
  skill: "ola-security-audit", model: "haiku", effort: "low",
  mode: "scan",
};

test("handleStartRun rejects the removed audit-only mode", async () => {
  const { status, error } = await runStart({ ...validBase, mode: "audit-only" });
  assertEquals(status, 400);
  assertEquals(error, "mode must be one of scan|fix");
});

test("handleStartRun refuses a repo run without GH_TOKEN", async () => {
  const { status, error } = await runStart(validBase);
  assertEquals(status, 400);
  assertEquals(error, "GH_TOKEN is not set. Add a GitHub token with repo scope in Keys settings.");
});

test("handleStartRun rejects non-array categories (no silent full-scan)", async () => {
  const { status } = await runStart({ ...validBase, categories: "sqli" });
  assertEquals(status, 400);
});

test("handleStartRun rejects unknown category tokens", async () => {
  const { status, error } = await runStart({ ...validBase, categories: ["sqli", "bogus"] });
  assertEquals(status, 400);
  assertEquals((error ?? "").includes("bogus"), true);
});

test("handleStartRun rejects the removed security-review skill", async () => {
  const { status, error } = await runStart({ ...validBase, skill: "security-review" });
  assertEquals(status, 400);
  assertEquals(error, "skill must be one of ola-security-audit");
});

// Per-run auth channel selection. The invariants that matter:
//   - oauth with a credentials file gets the subscription login ONLY. Claude Code
//     prefers an API key, so passing one would bill the key instead;
//   - api-key gets the key ONLY, with no subscription credentials mount;
//   - oauth without a credentials file (settings mode) keeps the host provider env;
//   - relay carries the relay endpoint ONLY — no API key, and crucially no
//     subscription credentials mount, so a relay run can never read the
//     OAuth credentials file.
const authDeps = {
  anthropicApiKey: "sk-" + "official",
  anthropicBaseUrl: "https://official.example",
  anthropicAuthToken: "mock" + "-token",
  anthropicModel: "claude-x",
  relayBaseUrl: "https://litellm.example",
  relayAuthToken: "sk-vk",
  relayModel: "glm-5.2",
  credentialsHostPath: "/host/.credentials.json",
};

test("providerSelection oauth mounts the subscription login and passes no key or token", () => {
  const got = providerSelection("oauth", authDeps);
  assertEquals(got.env, { ANTHROPIC_MODEL: "claude-x" });
  assertEquals(got.credentialsHostPath, "/host/.credentials.json");
});

test("providerSelection api-key passes the key and mounts no subscription login", () => {
  const got = providerSelection("api-key", authDeps);
  assertEquals(got.env.ANTHROPIC_API_KEY, "sk-" + "official");
  assertEquals(got.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assertEquals(got.credentialsHostPath, undefined);
});

test("providerSelection oauth in settings mode keeps the host provider env", () => {
  const got = providerSelection("oauth", { ...authDeps, credentialsHostPath: undefined });
  assertEquals(got.env.ANTHROPIC_API_KEY, "sk-" + "official");
  assertEquals(got.env.ANTHROPIC_AUTH_TOKEN, "mock" + "-token");
  assertEquals(got.credentialsHostPath, undefined);
});

test("providerSelection relay uses relay endpoint and mounts no subscription credentials", () => {
  const got = providerSelection("relay", authDeps);
  assertEquals(got.env.ANTHROPIC_BASE_URL, "https://litellm.example");
  assertEquals(got.env.ANTHROPIC_AUTH_TOKEN, "sk-vk");
  assertEquals(got.env.ANTHROPIC_MODEL, "glm-5.2");
  assertEquals(got.env.ANTHROPIC_API_KEY, undefined);
  assertEquals(got.credentialsHostPath, undefined);
});

function launchResponse(body: { error?: string }, status = 200): Response {
  if (status === 500) assertEquals(body.error, "test scanner launch stopped")
  return new Response()
}

// A relay run names a gateway model, so the provider's alias list must not
// apply to it. The id still has to survive the `docker run -e` charset.
test("relay runs accept a gateway model id and reject malformed ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"));
  const store = await Store.open(`${dir}/test.sqlite`);
  const launches: RunScannerArgs[] = [];
  const deps = {
    store, runsRootDir: dir, maxConcurrent: 10, scannerImage: "test", getGhToken: async () => "fixture",
    activeRuns: new Map(), bus: { publish: () => {} },
    relayBaseUrl: "https://litellm.example", relayAuthToken: "sk-vk",
    controller: { runScanner: (args: RunScannerArgs) => {
      launches.push(args);
      throw new Error("test scanner launch stopped");
    } },
  };
  const start = async (body: unknown) => {
    let status = 0;
    const c = {
      req: { json: () => Promise.resolve(body) },
      json: (obj: { error?: string }, s = 200) => { status = s; return launchResponse(obj, s) },
    } as unknown as Context;
    await handleStartRun(c, deps as never);
    return status;
  };
  try {
    // 500: the fake scanner launch stops the run after the env is built.
    assertEquals(await start({ ...validBase, authMode: "relay", model: "glm-5.2" }), 500);
    assertEquals(launches.at(-1)?.env.MODEL, "glm-5.2");
    // No OLA_AGENT_RELAY_MODEL here, so the gateway model comes from the request.
    assertEquals(launches.at(-1)?.env.ANTHROPIC_MODEL, undefined);

    for (const model of ["", "bad id", "x".repeat(200)]) {
      assertEquals(await start({ ...validBase, authMode: "relay", model }), 400);
    }
    assertEquals(await start({ ...validBase, authMode: "relay", model: "gw-one", reviewProvider: "claude", reviewModel: "gw-one" }), 500);
    assertEquals(launches.at(-1)?.env.MODEL, "gw-one");
    assertEquals(launches.at(-1)?.env.REVIEW_MODEL, "gw-one");
    for (const reviewModel of [null, 3, [], "", "bad id", "x".repeat(200)]) {
      assertEquals(await start({ ...validBase, authMode: "relay", model: "gw-one", reviewProvider: "claude", reviewModel }), 400);
    }
    assertEquals(await start({ ...validBase, authMode: "relay", model: "gw-one", reviewProvider: "codex", reviewModel: "gw-one" }), 400);
    assertEquals(await start({ ...validBase, reviewProvider: "claude", reviewModel: "gw-one" }), 400);
    // The subscription channel still refuses a raw gateway id.
    assertEquals(await start({ ...validBase, model: "glm-5.2" }), 400);
  } finally {
    store.close();
    await rm(dir, { recursive: true });
  }
});

test("Scan maxSubagents: validated, saved, and passed to the scanner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"));
  const store = await Store.open(`${dir}/test.sqlite`);
  const launches: RunScannerArgs[] = [];
  const deps = {
    store, runsRootDir: dir, maxConcurrent: 10, scannerImage: "test", getGhToken: async () => "fixture",
    activeRuns: new Map(), bus: { publish: () => {} },
    controller: { runScanner: (args: RunScannerArgs) => {
      launches.push(args);
      throw new Error("test scanner launch stopped");
    } },
  };
  const start = async (body: unknown) => {
    let status = 0;
    let payload: { runId?: string, error?: string } = {};
    const c = {
      req: { json: () => Promise.resolve(body) },
      json: (obj: typeof payload, s = 200) => { payload = obj; status = s; return launchResponse(obj, s) },
    } as unknown as Context;
    await handleStartRun(c, deps as never);
    return { status, runId: payload.runId };
  };
  const scan = { ...validBase, mode: "scan" };
  const previousDev = process.env.OLA_DEV
  process.env.OLA_DEV = "1"
  try {
    // 500: the fake scanner launch stops the run after the env is built.
    const three = await start({ ...scan, maxSubagents: 3 });
    assertEquals(three.status, 500);
    assertEquals(launches.at(-1)?.env.MAX_SUBAGENTS, "3");
    assertEquals(store.getRun(three.runId!)?.maxSubagents, 3);

    // 0 and omitted both keep Agent and Task blocked. The env key stays out, and a scan run still saves 0.
    for (const body of [{ ...scan, maxSubagents: 0 }, scan]) {
      const none = await start(body);
      assertEquals(none.status, 500);
      assertEquals(launches.at(-1)?.env.MAX_SUBAGENTS, undefined);
      assertEquals(store.getRun(none.runId!)?.maxSubagents, 0);
    }

    for (const includeP2 of [undefined, false, true]) {
      const result = await start({ ...scan, includeP2 });
      assertEquals(result.status, 500);
      assertEquals(launches.at(-1)?.env.INCLUDE_P2, String(includeP2 === true));
      assertEquals(store.getRun(result.runId!)?.includeP2, includeP2 === true);
    }
    for (const includeP2 of [null, "true", 1]) {
      assertEquals((await start({ ...scan, includeP2 })).status, 400);
    }

    for (const maxSubagents of [4, -1, 1.5, "two", null]) {
      assertEquals((await start({ ...scan, maxSubagents })).status, 400);
    }
    // Rejected, not dropped: the cap only applies to Claude scan runs.
    assertEquals((await start({ ...validBase, mode: "fix", maxSubagents: 1 })).status, 400);
    assertEquals((await start({ ...scan, maxSubagents: 1, provider: "codex", model: "gpt-6.1-sol" })).status, 400);
  } finally {
    if (previousDev === undefined) delete process.env.OLA_DEV
    else process.env.OLA_DEV = previousDev

    store.close();
    await rm(dir, { recursive: true });
  }
});

test("handleStartRun rejects invalid commit SHA values", async () => {
  for (const commitSha of [123, {}, "abc123", "g".repeat(40), "a".repeat(39), "a".repeat(41), "--help"]) {
    const { status } = await runStart({ ...validBase, commitSha });
    assertEquals(status, 400);
  }
});

test("handleStartRun rejects commit SHA on a local workspace run", async () => {
  const { status } = await runStart({
    ...validBase, prompt: "Review", commitSha: "a".repeat(40),
  });
  assertEquals(status, 400);
});


test("a generic run with an empty model needs an ANTHROPIC_MODEL to pick one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"));
  const body = { sessionId: "s1", prompt: "Review", workspaceHostDir: dir, model: "", effort: "low", mode: "fix" };
  const noModel = "model is required: no ANTHROPIC_MODEL is set to pick one";
  assertEquals(await runStart(body, { workspacesRoot: dir }), { status: 400, error: noModel });
  assertEquals(await runStart({ ...body, authMode: "relay" }, { workspacesRoot: dir, relayBaseUrl: "https://relay.test", relayAuthToken: "x", anthropicModel: "gw" }), { status: 400, error: noModel });
  // With a model to fall back to, the run gets past the check.
  assertEquals((await runStart(body, { workspacesRoot: dir, anthropicModel: "gw" })).error === noModel, false);
  await rm(dir, { recursive: true });
});

test("handleStartRun stores optional SHA and passes it to the scanner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"));
  const store = await Store.open(`${dir}/test.sqlite`);
  const launches: RunScannerArgs[] = [];
  const codexAuthHostPath = `${dir}/fake-codex-auth.json`;
  await writeFile(codexAuthHostPath, "{}");
  const deps = {
    store, runsRootDir: dir, maxConcurrent: 10, scannerImage: "test", getGhToken: async () => "fixture", codexAuthHostPath,
    activeRuns: new Map(), bus: { publish: () => {} },
    controller: { runScanner: (args: RunScannerArgs) => {
      launches.push(args);
      throw new Error("test scanner launch stopped");
    } },
  };
  try {
    await mkdir(join(dir, "old", "artifacts"), { recursive: true })
    for (const mode of ["scan", "fix"] as const) {
      for (const provider of ["claude", "codex"]) {
        for (const commitSha of [undefined, "", " A" + "A".repeat(39) + " "]) {
          let payload: { runId?: string, error?: string } = {};
          let status = 0;
          const c = {
            req: { json: () => Promise.resolve({ ...validBase, mode, commitSha, language: commitSha === undefined ? undefined : commitSha === "" ? "zh" : "en", provider, model: provider === "claude" ? "haiku" : "gpt-6.1-sol", reviewProvider: "codex", reviewModel: "gpt-6.1-sol", reviewEffort: "xhigh" }) },
            json: (obj: typeof payload, s = 200) => { payload = obj; status = s; return launchResponse(obj, s) },
          } as unknown as Context;
          await handleStartRun(c, deps as never, undefined, undefined, mode === "fix" ? { from: "old", done: [], bundled: false } : undefined);
          assertEquals(status, 500);
          const expected = commitSha?.trim().toLowerCase() || undefined;
          assertEquals(launches.at(-1)?.env.COMMIT_SHA, expected);
          assertEquals(launches.at(-1)?.env.EVENTS_LOG, "1");
          assertEquals(launches.at(-1)?.env.MODE, mode);
          assertEquals(launches.at(-1)?.env.OUTPUT_LANGUAGE, commitSha?.trim() ? "en" : "zh");
          assertEquals(store.getRun(payload.runId!)?.language, commitSha?.trim() ? "en" : "zh");
          assertEquals((launches.at(-1)?.env as unknown as Record<string, unknown>).MAX_BUDGET_USD, undefined);
          assertEquals((launches.at(-1)?.env as unknown as Record<string, unknown>).MAX_TURNS, undefined);
          assertEquals(launches.at(-1)?.env.PROVIDER, provider);
          assertEquals(launches.at(-1)?.env.REVIEW_PROVIDER, "codex");
          assertEquals(launches.at(-1)?.env.REVIEW_MODEL, "gpt-6.1-sol");
          assertEquals(launches.at(-1)?.env.REVIEW_EFFORT, "xhigh");
          assertEquals(store.getRun(payload.runId!)?.reviewModel, "gpt-6.1-sol");
          assertEquals(store.getRun(payload.runId!)?.reviewEffort, "xhigh");
          assertEquals(launches.at(-1)?.env.REVIEW_PROVIDER_COMMAND, '["codex"]');
          assertEquals(store.getRun(payload.runId!)?.provider, provider);
          assertEquals(store.getRun(payload.runId!)?.reviewProvider, "codex");
          assertEquals(store.getRun(payload.runId!)?.mode, mode);
          assertEquals(store.getRun(payload.runId!)?.commitSha, expected);
        }
      }
    }
  } finally {
    store.close();
    await rm(dir, { recursive: true });
  }
});

test("handleStartRun validates pickedIds before starting", async () => {
  for (const pickedIds of [null, "pr1:x.php", ["bad"], [123], ["A".repeat(64)], ["pr1:x y"], ["pr1:x,y"], ["pr1:" + "x".repeat(297)], ["a".repeat(64), "a".repeat(64)], Array.from({ length: 51 }, (_, i) => `pr${i}:x.php`)]) {
    assertEquals((await runStart({ ...validBase, mode: "fix", pickedIds })).status, 400);
  }
  assertEquals((await runStart({ ...validBase, mode: "scan", pickedIds: ["a".repeat(64)] })).status, 400);
  assertEquals((await runStart({ ...validBase, prompt: "Fix", pickedIds: [] })).status, 403);
});

test("fix requests without picked rows are rejected before launching", async () => {
  for (const pickedIds of [undefined, []]) {
    const result = await runStart({ ...validBase, mode: "fix", pickedIds })
    assertEquals(result.status, 400)
    assertEquals(result.error, "fix runs require pickedIds or a resume")
  }
})

test("pickedIds accepts the exact length and count boundaries", async () => {
  const { validPickedIds } = await import("../../shared/types.ts")
  assertEquals(validPickedIds(["pr1:" + "x".repeat(296)]), true)
  assertEquals(validPickedIds(Array.from({ length: 51 }, (_, i) => `pr${i}:app/x.php`)), true)
})

test("provider validation rejects unavailable and unknown providers", async () => {
  for (const body of [
    { provider: "unknown" }, { reviewProvider: "unknown" },
    { provider: {} }, { reviewProvider: [] }, { provider: "__proto__" },
  ]) assertEquals((await runStart({ ...validBase, ...body })).status, 400)
})

test("handleStartRun rejects the relay channel and a missing OpenAI key for a Codex run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"));
  const codexAuthHostPath = `${dir}/codex-auth.json`;
  await writeFile(codexAuthHostPath, "{}");
  try {
    for (const reviewProvider of ["claude", "codex"]) {
      const deps = { codexAuthHostPath, anthropicApiKey: "test.api.key", relayBaseUrl: "https://relay.invalid", relayAuthToken: "test.relay.token" };
      const start = (authMode: string, extra: object = {}) => runStart({ ...validBase, provider: "codex", reviewProvider, authMode, model: "gpt-6.1-sol" }, { ...deps, ...extra });
      assertEquals(await start("relay", { openaiApiKey: "test.openai.key" }), { status: 400, error: "Codex runs require oauth or api-key authMode" });
      // The Anthropic key does not stand in for the OpenAI key.
      assertEquals(await start("api-key"), { status: 400, error: "OPENAI_API_KEY is not set on this server" });
    }
  } finally { await rm(dir, { recursive: true }); }
});

// The Codex login file reaches the container only for runs that use codex.
test("codex auth mount follows the run and review provider", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"));
  const store = await Store.open(`${dir}/test.sqlite`);
  const launches: RunScannerArgs[] = [];
  const codexAuthHostPath = `${dir}/fake-codex-auth.json`;
  await writeFile(codexAuthHostPath, "{}");
  const deps = {
    store, runsRootDir: dir, maxConcurrent: 10, scannerImage: "test", getGhToken: async () => "fixture", codexAuthHostPath,
    anthropicApiKey: "test.api.key", openaiApiKey: "test.openai.key", relayBaseUrl: "https://relay.invalid", relayAuthToken: "test.relay.token",
    activeRuns: new Map(), bus: { publish: () => {} },
    controller: { runScanner: (args: RunScannerArgs) => { launches.push(args); throw new Error("test scanner launch stopped"); } },
  };
  const start = async (extra: object, d: object = deps) => {
    let status = 0;
    let error = "";
    const c = {
      req: { json: () => Promise.resolve({ ...validBase, mode: "scan", ...extra }) },
      json: (obj: { error?: string }, s = 200) => { error = obj.error ?? ""; status = s; return launchResponse(obj, s) },
    } as unknown as Context;
    await handleStartRun(c, d as never);
    return { status, error };
  };
  try {
    // mounted: the login file reaches the container. key: the OpenAI key does, as env only.
    for (const [extra, mounted, key] of [
      [{}, false, false],
      [{ provider: "claude", reviewProvider: "claude" }, false, false],
      [{ reviewProvider: "codex" }, true, false],
      [{ provider: "codex", model: "gpt-6.1-sol" }, true, false],
      [{ provider: "codex", reviewProvider: "codex", model: "gpt-6.1-sol", authMode: "oauth" }, true, false],
      [{ reviewProvider: "codex", authMode: "api-key" }, true, false],
      [{ reviewProvider: "codex", authMode: "relay", model: "gateway/model" }, true, false],
      [{ provider: "codex", model: "gpt-6.1-sol", authMode: "api-key" }, false, true],
      [{ provider: "codex", reviewProvider: "codex", model: "gpt-6.1-sol", authMode: "api-key" }, false, true],
      [{ provider: "codex", reviewProvider: "claude", model: "gpt-6.1-sol", authMode: "api-key" }, false, true],
    ] as const) {
      launches.length = 0;
      assertEquals((await start(extra)).status, 500);
      assertEquals(launches[0].codexAuthHostPath, mounted ? codexAuthHostPath : undefined);
      assertEquals(launches[0].env.CODEX_HOME, mounted || key ? "/root/.codex" : undefined);
      assertEquals(launches[0].env.OPENAI_API_KEY, key ? "test.openai.key" : undefined);
    }
    // A Codex review falls back to the key when the host has no login file. A Codex main run still needs authMode api-key.
    for (const codexAuthHostPath of [`${dir}/missing.json`, undefined]) {
      launches.length = 0;
      assertEquals((await start({ reviewProvider: "codex" }, { ...deps, codexAuthHostPath })).status, 500);
      assertEquals(launches[0].codexAuthHostPath, undefined);
      assertEquals(launches[0].env.OPENAI_API_KEY, "test.openai.key");
      assertEquals(launches[0].env.CODEX_HOME, "/root/.codex");
    }
    assertEquals((await start({ provider: "codex", model: "gpt-6.1-sol" }, { ...deps, codexAuthHostPath: undefined })).status, 400);
    // A login file in apikey mode with OPENAI_API_KEY set: an api-key run uses the env key and does not mount the file.
    await writeFile(codexAuthHostPath, JSON.stringify({ auth_mode: "apikey" }));
    launches.length = 0;
    assertEquals((await start({ provider: "codex", model: "gpt-6.1-sol", authMode: "api-key" })).status, 500);
    assertEquals(launches[0].codexAuthHostPath, undefined);
    assertEquals(launches[0].env.OPENAI_API_KEY, "test.openai.key");
    await writeFile(codexAuthHostPath, "{}");
    // An API-key run needs no login file on the host.
    launches.length = 0;
    assertEquals((await start({ provider: "codex", model: "gpt-6.1-sol", authMode: "api-key" }, { ...deps, codexAuthHostPath: undefined })).status, 500);
    assertEquals(launches[0].env.OPENAI_API_KEY, "test.openai.key");
    // Missing login file: clear 400 that names the env var, no launch.
    launches.length = 0;
    for (const d of [{ ...deps, codexAuthHostPath: `${dir}/missing.json`, openaiApiKey: undefined }, { ...deps, codexAuthHostPath: undefined, openaiApiKey: undefined }]) {
      const { status, error } = await start({ reviewProvider: "codex" }, d);
      assertEquals(status, 400);
      assertEquals(error.includes("OLA_AGENT_CODEX_AUTH_PATH"), true);
    }
    assertEquals(launches.length, 0);
    // A claude-only run does not need the file.
    assertEquals((await start({}, { ...deps, codexAuthHostPath: `${dir}/missing.json` })).status, 500);
  } finally { store.close(); await rm(dir, { recursive: true }); }
});

test("antigravity auth mount follows the run and review provider", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"));
  const store = await Store.open(`${dir}/test.sqlite`);
  const launches: RunScannerArgs[] = [];
  const antigravityAuthHostPath = `${dir}/antigravity-token.json`;
  await writeFile(antigravityAuthHostPath, "{}");
  const deps = {
    store, runsRootDir: dir, maxConcurrent: 10, scannerImage: "test", getGhToken: async () => "fixture", antigravityAuthHostPath,
    anthropicApiKey: "test.api.key", relayBaseUrl: "https://relay.invalid", relayAuthToken: "test.relay.token",
    activeRuns: new Map(), bus: { publish: () => {} },
    controller: { runScanner: (args: RunScannerArgs) => { launches.push(args); throw new Error("test scanner launch stopped"); } },
  };
  const start = async (extra: object, d: object = deps) => {
    let status = 0;
    let error = "";
    const c = {
      req: { json: () => Promise.resolve({ ...validBase, mode: "scan", ...extra }) },
      json: (obj: { error?: string }, s = 200) => { error = obj.error ?? ""; status = s; return launchResponse(obj, s) },
    } as unknown as Context;
    await handleStartRun(c, d as never);
    return { status, error };
  };
  try {
    for (const [extra, mounted] of [
      [{}, false],
      [{ provider: "claude", reviewProvider: "claude" }, false],
      [{ reviewProvider: "antigravity" }, true],
      [{ provider: "antigravity", model: "gemini-3.8-flash" }, true],
      [{ provider: "antigravity", reviewProvider: "antigravity", model: "gemini-3.8-flash", authMode: "oauth" }, true],
    ] as const) {
      launches.length = 0;
      assertEquals((await start(extra)).status, 500);
      assertEquals(launches[0].antigravityAuthHostPath, mounted ? antigravityAuthHostPath : undefined);
    }
    // Missing login file: clear 400 that names the env var, no launch.
    launches.length = 0;
    for (const d of [{ ...deps, antigravityAuthHostPath: `${dir}/missing.json` }, { ...deps, antigravityAuthHostPath: undefined }]) {
      const { status, error } = await start({ reviewProvider: "antigravity" }, d);
      assertEquals(status, 400);
      assertEquals(error.includes("OLA_AGENT_ANTIGRAVITY_AUTH_PATH"), true);
    }
    assertEquals(launches.length, 0);
  } finally { store.close(); await rm(dir, { recursive: true }); }
});

test("antigravity run and resume reject api-key and relay authMode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"));
  const store = await Store.open(`${dir}/test.sqlite`);
  const antigravityAuthHostPath = `${dir}/antigravity-token.json`;
  await writeFile(antigravityAuthHostPath, "{}");
  const launches: RunScannerArgs[] = [];
  const deps = {
    store, runsRootDir: dir, maxConcurrent: 10, scannerImage: "test", getGhToken: async () => "fixture", antigravityAuthHostPath,
    anthropicApiKey: "test.api.key", relayBaseUrl: "https://relay.invalid", relayAuthToken: "test.relay.token",
    activeRuns: new Map(), bus: { publish: () => {} },
    controller: { runScanner: (args: RunScannerArgs) => { launches.push(args); throw new Error("test scanner launch stopped"); } },
  };
  const error = "Antigravity runs require oauth authMode";
  const request = { ...validBase, provider: "antigravity", model: "gemini-3.8-flash" } as const;
  try {
    store.ensureSession("s1");
    store.createRun({ ...request, runId: "old", branch: "main", authMode: "oauth" } as never);
    store.updateRunStatus("old", "stopped");
    await mkdir(`${dir}/old/artifacts`, { recursive: true });
    await writeFile(`${dir}/old/artifacts/checkpoint.json`, '{"done":[],"bundled":false}');
    for (const authMode of ["api-key", "relay"]) {
      assertEquals(await runStart({ ...request, authMode }, deps), { status: 400, error });
      let payload: { error?: string } = {};
      let status = 0;
      const c = { req: { param: () => "old", text: async () => JSON.stringify({ authMode }) },
        json: (obj: { error?: string }, s = 200) => { payload = obj; status = s; return new Response(); } } as unknown as Context;
      await handleResumeRun(c, deps as never);
      assertEquals({ status, error: payload.error }, { status: 400, error });
    }
    assertEquals(launches.length, 0);
  } finally { store.close(); await rm(dir, { recursive: true }); }
});

test("History and Detail return reported model and effort without changing Resume inputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const store = await Store.open(`${dir}/history.sqlite`)
  const capture = (query: Record<string, string> = {}) => {
    let payload: unknown
    const c = { req: { param: () => "codex", query: (name: string) => query[name] }, json: (value: unknown) => {
      payload = value
      return new Response()
    } } as unknown as Context
    return { c, payload: () => payload }
  }
  try {
    store.ensureSession("codex")
    for (const [runId, provider, model] of [["codex", "codex", ""], ["relay", "claude", "gateway/gpt-test"], ["legacy", "claude", "sonnet"]] as const) {
      store.createRun({ runId, provider, sessionId: "codex", repoUrl: "https://github.com/a/b", branch: "main",
        skill: "ola-security-audit", model, effort: "medium", mode: "scan" })
    }
    await mkdir(`${dir}/codex/artifacts`, { recursive: true })
    await writeFile(`${dir}/codex/artifacts/model-info.json`, JSON.stringify({ model: "gpt-test", effort: "xhigh" }))
    const deps = { store, runsRootDir: dir }
    for (const handler of [handleListAllRuns, handleListRuns]) {
      const call = capture()
      await handler(call.c, deps)
      const runs = (call.payload() as { runs: RunSummary[] }).runs
      assertEquals(runs.map(r => [r.runId, r.runNumber]), [["legacy", 3], ["relay", 2], ["codex", 1]])
      assertEquals(runs.find(r => r.runId === "codex")?.modelInfo, { model: "gpt-test", effort: "xhigh" })
      assertEquals(runs.find(r => r.runId === "relay")?.model, "gateway/gpt-test")
      assertEquals(runs.find(r => r.runId === "legacy")?.modelInfo, undefined)
    }
    const call = capture()
    await handleGetRun(call.c, deps)
    const run = call.payload() as RunSummary
    assertEquals(run.runId, "codex")
    assertEquals(run.runNumber, 1)
    const page = capture({ limit: "1", offset: "1" })
    await handleListAllRuns(page.c, deps)
    assertEquals((page.payload() as { runs: RunSummary[] }).runs.map(r => r.runNumber), [2])
    const farPage = capture({ limit: "1", offset: "100001" })
    await handleListAllRuns(farPage.c, deps)
    assertEquals(farPage.payload(), { runs: [], limit: 1, offset: 100001, total: 3 })
    assertEquals(run.model, "")
    assertEquals(run.effort, "medium")
    assertEquals(run.modelInfo, { model: "gpt-test", effort: "xhigh" })
    assertEquals(store.getRun("codex")?.model, "")
    assertEquals(displayModelInfo({ provider: "codex", model: "", effort: "medium", modelInfo: run.modelInfo }, "Unspecified"), { model: "gpt-test", effort: "xhigh" })
    assertEquals(displayModelInfo({ provider: "codex", model: "", effort: "medium" }, "Unspecified"), { model: "Codex · Unspecified", effort: "Unspecified" })
    assertEquals(displayModelInfo({ model: "sonnet", effort: "medium" }, "Unspecified"), { model: "Claude Sonnet 5.5 · Requested", effort: "medium" })
    assertEquals(displayModelInfo({ model: "gateway/gpt-test", effort: "high" }, "Unspecified"), { model: "gateway/gpt-test · Requested", effort: "high" })
    for (const body of ["{", "null", JSON.stringify({ model: 12, effort: {} }), JSON.stringify({ model: "bad model", effort: "bad effort" })]) {
      await writeFile(`${dir}/codex/artifacts/model-info.json`, body)
      await handleGetRun(call.c, deps)
      assertEquals((call.payload() as RunSummary).modelInfo, undefined)
    }
  } finally {
    store.close()
    await rm(dir, { recursive: true })
  }
})

test("handleStartRun rejects invalid smoke seconds", async () => {
  for (const smokeSeconds of [0, 31, 1.5, "30", null]) {
    const result = await runStart({ ...validBase, smokeSeconds })
    assertEquals(result.status, 400)
    assertEquals(result.error, "smokeSeconds must be a whole number from 1 to 30")
  }
})

test("dev controls require OLA_DEV=1 while normal scan defaults remain available", async () => {
  const previousDev = process.env.OLA_DEV
  try {
    for (const value of [undefined, "0", "1"]) {
      if (value === undefined) delete process.env.OLA_DEV
      else process.env.OLA_DEV = value
      for (const controls of [{ smokeSeconds: 1 }, { smokeSeconds: 30 }, { maxSubagents: 1 }, { maxSubagents: 3 }]) {
        const result = await runStart({ ...validBase, ...controls })
        assertEquals(result.status, 400)
        assertEquals(result.error, value === "1"
          ? "GH_TOKEN is not set. Add a GitHub token with repo scope in Keys settings."
          : "smokeSeconds and maxSubagents > 0 require dev mode (OLA_DEV=1)")
      }
      for (const controls of [{}, { maxSubagents: 0 }]) {
        assertEquals((await runStart({ ...validBase, ...controls })).error,
          "GH_TOKEN is not set. Add a GitHub token with repo scope in Keys settings.")
      }
    }
  } finally {
    if (previousDev === undefined) delete process.env.OLA_DEV
    else process.env.OLA_DEV = previousDev
  }
})

test("handleStartRun passes smoke seconds and defaults to zero", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const store = await Store.open(`${dir}/test.sqlite`)
  let launch: RunScannerArgs | undefined
  const deps = {
    store, runsRootDir: dir, maxConcurrent: 10, scannerImage: "test", getGhToken: async () => "fixture",
    activeRuns: new Map(), bus: { publish: () => {} },
    controller: { runScanner: (args: RunScannerArgs) => { launch = args; throw new Error("test scanner launch stopped") } },
  }
  const previousDev = process.env.OLA_DEV
  process.env.OLA_DEV = "1"
  try {
    for (const smokeSeconds of [undefined, 1, 30]) {
      let status = 0
      const c = {
        req: { json: () => Promise.resolve({ ...validBase, ...(smokeSeconds !== undefined ? { smokeSeconds } : {}) }) },
        json: (body: { error?: string }, code = 200) => { status = code; return launchResponse(body, code) },
      } as unknown as Context
      await handleStartRun(c, deps as never)
      assertEquals(status, 500)
      assertEquals(launch?.env.SMOKE_SECONDS, String(smokeSeconds ?? 0))
    }
  } finally {
    if (previousDev === undefined) delete process.env.OLA_DEV
    else process.env.OLA_DEV = previousDev

    store.close()
    await rm(dir, { recursive: true })
  }
})

test("handleStopRun stops an active run and refuses finished or unknown runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const store = await Store.open(`${dir}/stop.sqlite`)
  const call = async (id: string, activeRuns: Map<string, never>) => {
    let status = 200
    const c = { req: { param: () => id }, json: (_: unknown, s = 200) => { status = s; return new Response() } } as unknown as Context
    await handleStopRun(c, { store, activeRuns })
    return status
  }
  try {
    store.ensureSession("s1")
    for (const runId of ["live", "done"]) {
      store.createRun({ runId, sessionId: "s1", repoUrl: "https://github.com/a/b", branch: "main",
        skill: "ola-security-audit", model: "haiku", effort: "low", mode: "scan" })
    }
    store.updateRunStatus("live", "scanning")
    store.updateRunStatus("done", "completed")
    let stops = 0
    const fake = { stop: () => { stops++; return Promise.resolve() } }
    const active = new Map([["live", fake], ["done", fake]]) as unknown as Map<string, never>
    assertEquals(await call("missing", active), 404)
    assertEquals(await call("done", active), 409)
    assertEquals(await call("live", new Map<string, never>()), 409)
    assertEquals(stops, 0)
    assertEquals(await call("live", active), 200)
    assertEquals(stops, 1)
  } finally {
    store.close()
    await rm(dir, { recursive: true })
  }
})

test("handleActiveRuns lists unfinished runs that have a live scanner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const store = await Store.open(`${dir}/active.sqlite`)
  try {
    store.ensureSession("s1")
    for (const runId of ["live", "orphan", "done"]) {
      store.createRun({ runId, sessionId: "s1", repoUrl: "https://github.com/a/b", branch: "main",
        skill: "ola-security-audit", model: "haiku", effort: "low", mode: "scan" })
    }
    store.updateRunStatus("live", "scanning")
    store.updateRunStatus("orphan", "scanning")   // a backend restart left this row, with no scanner
    store.updateRunStatus("done", "completed")
    const fake = {} as never
    let payload: { runs: Array<{ runId: string; status: string }> } = { runs: [] }
    const c = { json: (value: unknown) => { payload = value as typeof payload; return new Response() } } as unknown as Context
    handleActiveRuns(c, { store, activeRuns: new Map([["live", fake], ["done", fake]]) })
    assertEquals(payload.runs.map((r) => [r.runId, r.status]), [["live", "scanning"]])
  } finally {
    store.close()
    await rm(dir, { recursive: true })
  }
})

// The Scan page override reaches the scanner only on scans. Fix runs get only the PHP version, for vendor upgrades.
test("scan runs pass the profile override and fix runs pass the PHP version", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"));
  const store = await Store.open(`${dir}/test.sqlite`);
  const launches: RunScannerArgs[] = [];
  const deps = {
    store, runsRootDir: dir, maxConcurrent: 10, scannerImage: "test", getGhToken: async () => "fixture",
    activeRuns: new Map(), bus: { publish: () => {} },
    controller: { runScanner: (args: RunScannerArgs) => { launches.push(args); throw new Error("test scanner launch stopped"); } },
  };
  const start = (body: unknown) => handleStartRun({
    req: { json: () => Promise.resolve(body) },
    json: launchResponse,
  } as unknown as Context, deps as never);
  try {
    await start({ ...validBase, mode: "scan" });
    assertEquals(launches.at(-1)?.env.PROFILE_OVERRIDE, undefined);
    store.setProfileOverride("a/b", { php: "7.2", framework: "" });
    await start({ ...validBase, mode: "scan" });
    assertEquals(launches.at(-1)?.env.PROFILE_OVERRIDE, '{"php":"7.2","framework":""}');
    const c = { json: launchResponse } as unknown as Context
    await handleStartRun(c, deps as never, { ...validBase, mode: "fix", skill: "ola-security-audit", effort: "low" }, undefined, { from: "old", done: [], bundled: false })
    assertEquals(launches.at(-1)?.env.PROFILE_OVERRIDE, undefined);
    assertEquals(launches.at(-1)?.env.REPO_PHP, "7.2");
    store.setProfileOverride("a/b", { php: "", framework: "" });
    store.saveProfile("a/b", { language: "php", php: "8.1", framework: "", sources: [] });
    await handleStartRun(c, deps as never, { ...validBase, mode: "fix", skill: "ola-security-audit", effort: "low" }, undefined, { from: "old", done: [], bundled: false })
    assertEquals(launches.at(-1)?.env.REPO_PHP, "8.1");
    await start({ ...validBase, mode: "scan" });
    assertEquals(launches.at(-1)?.env.REPO_PHP, undefined);
  } finally {
    store.close();
    await rm(dir, { recursive: true });
  }
});

test("scan runs default to four hours and accept a timeout override including zero", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const store = await Store.open(`${dir}/test.sqlite`)
  const previous = process.env.OLA_AGENT_RUN_TIMEOUT_SECONDS
  let launch: (RunScannerArgs & { timeoutMs?: number }) | undefined
  let launchCount = 0
  const deps = {
    store, runsRootDir: dir, maxConcurrent: 10, scannerImage: "test", getGhToken: async () => "fixture", activeRuns: new Map(), bus: { publish() {} },
    controller: { runScanner(args: RunScannerArgs) { launch = args; launchCount++; throw new Error("fixture launch stopped") } },
  }
  try {
    for (const [setting, expected] of [[undefined, 14400000], ["60", 60000], ["0", undefined]] as const) {
      if (setting === undefined) delete process.env.OLA_AGENT_RUN_TIMEOUT_SECONDS
      else process.env.OLA_AGENT_RUN_TIMEOUT_SECONDS = setting
      assertEquals(await runStart(validBase, deps), { status: 500, error: "fixture launch stopped" })
      assertEquals(launch?.timeoutMs, expected)
    }
    for (const setting of [undefined, "60", "bad"]) {
      if (setting === undefined) delete process.env.OLA_AGENT_RUN_TIMEOUT_SECONDS
      else process.env.OLA_AGENT_RUN_TIMEOUT_SECONDS = setting
      const before = launchCount
      const c = { json: (body: { error?: string }) => { assertEquals(body.error, "fixture launch stopped"); return new Response() } } as unknown as Context
      await handleStartRun(c, deps as never, {
        ...validBase, mode: "fix", skill: "ola-security-audit", effort: "low",
      }, undefined, { from: "old", done: [], bundled: false })
      assertEquals(launchCount, before + 1)
      assertEquals(launch?.timeoutMs, undefined)
    }
    for (const setting of ["", "bad", "-1", "1.5"]) {
      process.env.OLA_AGENT_RUN_TIMEOUT_SECONDS = setting
      assertEquals((await runStart(validBase, deps)).error, "OLA_AGENT_RUN_TIMEOUT_SECONDS must be a non-negative whole number")
    }
  } finally {
    if (previous === undefined) delete process.env.OLA_AGENT_RUN_TIMEOUT_SECONDS
    else process.env.OLA_AGENT_RUN_TIMEOUT_SECONDS = previous
    store.close()
    await rm(dir, { recursive: true })
  }
})

test("the artifact route refuses a symlinked report and hides host paths in errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const runId = "symlink-test"
  const c = {
    req: { param: (name: string) => name === "id" ? runId : "report" },
    json: (body: unknown, status = 200) => Response.json(body, { status }),
  } as unknown as Context
  try {
    await mkdir(join(dir, runId, "artifacts"), { recursive: true })
    await writeFile(join(dir, "id_ed25519"), "PRIVATE KEY")
    await symlink(join(dir, "id_ed25519"), join(dir, runId, "artifacts", "report.md"))
    const response = await handleRunArtifact(c, { runsRootDir: dir })
    assertEquals(response.status, 400)
    assertEquals((await response.text()).includes("PRIVATE KEY"), false)
    // An unreadable file returns a generic error without the host path.
    await rm(join(dir, runId, "artifacts", "report.md"))
    await writeFile(join(dir, runId, "artifacts", "report.md"), "x", { mode: 0o000 })
    await chmod(join(dir, runId, "artifacts", "report.md"), 0o000)
    if (process.getuid?.() !== 0) {
      const unreadable = await handleRunArtifact(c, { runsRootDir: dir })
      assertEquals(unreadable.status, 500)
      assertEquals(await unreadable.json(), { error: "artifact unreadable" })
    }
  } finally { await rm(dir, { recursive: true }) }
})

test("non-generic runs need a GitHub repo and pass the canonical URL to the scanner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"));
  const store = await Store.open(`${dir}/test.sqlite`);
  const launches: RunScannerArgs[] = [];
  const deps = {
    store, runsRootDir: dir, maxConcurrent: 10, scannerImage: "test", getGhToken: async () => "fixture", activeRuns: new Map(), bus: { publish: () => {} },
    controller: { runScanner: (args: RunScannerArgs) => { launches.push(args); throw new Error("test scanner launch stopped") } },
  };
  try {
    for (const repoUrl of ["https://github.com@evil.example/x", "https://user@github.com/o/r", "https://evil.example/o/r",
      "https://github.com.evil.example/o/r", "http://localhost/o/r", "file:///etc/o/r"]) {
      assertEquals((await runStart({ ...validBase, repoUrl }, deps)).status, 400, repoUrl);
    }
    for (const repoUrl of ["git@github.com:Owner/Repo.git", "https://github.com/owner/repo.git", "https://github.com/owner/repo"]) {
      assertEquals((await runStart({ ...validBase, repoUrl }, deps)).status, 500, repoUrl);
      assertEquals(launches.at(-1)?.env.REPO_URL, "https://github.com/owner/repo");
    }
  } finally {
    store.close();
    await rm(dir, { recursive: true });
  }
});

test("a symlink inside an allowed workspace root cannot point the mount outside it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"));
  try {
    const root = join(dir, "root");
    await mkdir(join(root, "real"), { recursive: true });
    await mkdir(join(dir, "outside"));
    await symlink(join(dir, "outside"), join(root, "link"));
    const body = { sessionId: "s1", prompt: "Review", model: "", effort: "low", mode: "fix" };
    assertEquals((await runStart({ ...body, workspaceHostDir: join(root, "link") }, { workspacesRoot: root })).status, 403);
    // An allowed directory gets past the allowlist to the model check.
    assertEquals((await runStart({ ...body, workspaceHostDir: join(root, "real") }, { workspacesRoot: root })).status, 400);
  } finally { await rm(dir, { recursive: true }) }
});


test("saved run details read local phase usage and reject invalid or linked usage records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-usage-"))
  const runId = "phase-usage-test"
  const artifacts = join(dir, runId, "artifacts")
  const usage = { inputTokens: 2500, cacheReadTokens: 10000, cacheCreateTokens: 0, outputTokens: 750 }
  const run = { runId, mode: "fix", status: "completed", repoUrl: "local:/fixture", provider: "codex", usage: { ...usage } }
  const store = { getRun: () => run, attempts: () => [] } as unknown as Store
  const c = { req: { param: () => runId }, json: (body: unknown) => Response.json(body) } as unknown as Context
  const get = async () => (await handleGetRun(c, { store, runsRootDir: dir })).json()
  try {
    await mkdir(artifacts, { recursive: true })
    const record = { usage, phaseUsage: { fix: usage } }
    await writeFile(join(artifacts, "usage.json"), JSON.stringify({ ...record, usage: { ...record.usage, estCostUsd: "ignored", costPartial: true } }))
    const saved = await get()
    assertEquals(saved.usage, usage)
    assertEquals(saved.phaseUsage, record.phaseUsage)
    for (const invalid of ["invalid json", JSON.stringify({ ...record, phaseUsage: { bogus: usage } }),
      JSON.stringify({ ...record, usage: { ...usage, inputTokens: -1 } })]) {
      await writeFile(join(artifacts, "usage.json"), invalid)
      assertEquals((await get()).phaseUsage, undefined)
    }
    await rm(join(artifacts, "usage.json"))
    await writeFile(join(dir, "outside.json"), JSON.stringify(record))
    await symlink(join(dir, "outside.json"), join(artifacts, "usage.json"))
    assertEquals((await get()).phaseUsage, undefined)
  } finally { await rm(dir, { recursive: true }) }
})


test("handleStartRun rejects unsupported output languages", async () => {
  for (const language of ["cn", "English", "", null, 1, {}]) {
    assertEquals(await runStart({ ...validBase, language }), { status: 400, error: 'language must be "en" or "zh"' })
  }
})


test("fix gating follows canFix metadata for each provider", async () => {
  const { PROVIDERS } = await import("../../shared/types.ts")
  for (const provider of ["claude", "codex"] as const) {
    const original = PROVIDERS[provider].canFix
    try {
      PROVIDERS[provider].canFix = false
      assertEquals(await runStart({ ...validBase, provider, mode: "fix" }),
        { status: 400, error: "provider does not support fix runs" })
    } finally { PROVIDERS[provider].canFix = original }
  }
})

test("review settings are validated against the review provider before launch", async () => {
  for (const reviewProvider of ["claude", "codex", "antigravity"]) {
    for (const reviewModel of [null, 3, [], "unknown", ...(reviewProvider === "claude" ? ["gpt-6.1-sol", "fable"] : ["sonnet"])]) {
      const result = await runStart({ ...validBase, reviewProvider, reviewModel })
      assertEquals(result, { status: 400, error: "invalid reviewModel for review provider" })
    }
    for (const reviewEffort of [null, [], 3, "unknown", ...(reviewProvider === "claude" ? [] : ["max"])]) {
      assertEquals(await runStart({ ...validBase, reviewProvider, reviewEffort }), { status: 400, error: "invalid reviewEffort for review provider" })
    }
  }
})

test("qoder auth mount follows the run and review provider", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"));
  const store = await Store.open(`${dir}/test.sqlite`);
  const launches: RunScannerArgs[] = [];
  const qoderAuthHostPath = `${dir}/qoder-token.json`;
  await mkdir(qoderAuthHostPath);
  await writeFile(`${qoderAuthHostPath}/user`, "fixture-user");
  await writeFile(`${qoderAuthHostPath}/machine_id`, "fixture-machine");
  const deps = {
    store, runsRootDir: dir, maxConcurrent: 10, scannerImage: "test", getGhToken: async () => "fixture", qoderAuthHostPath,
    anthropicApiKey: "test.api.key", relayBaseUrl: "https://relay.invalid", relayAuthToken: "test.relay.token",
    activeRuns: new Map(), bus: { publish: () => {} },
    controller: { runScanner: (args: RunScannerArgs) => { launches.push(args); throw new Error("test scanner launch stopped"); } },
  };
  const start = async (extra: object, d: object = deps) => {
    let status = 0;
    let error = "";
    const c = {
      req: { json: () => Promise.resolve({ ...validBase, mode: "scan", ...extra }) },
      json: (obj: { error?: string }, s = 200) => { error = obj.error ?? ""; status = s; return launchResponse(obj, s) },
    } as unknown as Context;
    await handleStartRun(c, d as never);
    return { status, error };
  };
  try {
    for (const [extra, mounted] of [
      [{}, false],
      [{ provider: "claude", reviewProvider: "claude" }, false],
      [{ reviewProvider: "qoder" }, true],
      [{ provider: "qoder", model: "Qwen3.8-Flash", effort: undefined }, true],
      [{ provider: "qoder", reviewProvider: "qoder", model: "Qwen3.8-Flash", authMode: "oauth" }, true],
    ] as const) {
      launches.length = 0;
      assertEquals((await start(extra)).status, 500);
      assertEquals(launches[0].qoderAuthHostPath, mounted ? qoderAuthHostPath : undefined);
    }
    // Missing login file: clear 400 that names the env var, no launch.
    launches.length = 0;
    for (const d of [{ ...deps, qoderAuthHostPath: `${dir}/missing.json` }, { ...deps, qoderAuthHostPath: undefined }]) {
      const { status, error } = await start({ reviewProvider: "qoder" }, d);
      assertEquals(status, 400);
      assertEquals(error.includes("OLA_AGENT_QODER_AUTH_PATH"), true);
    }
    assertEquals(launches.length, 0);
  } finally { store.close(); await rm(dir, { recursive: true }); }
});

test("qoder reviewers and fixers launch without an effort", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"));
  const store = await Store.open(`${dir}/test.sqlite`);
  const launches: RunScannerArgs[] = [];
  const qoderAuthHostPath = `${dir}/qoder-token.json`;
  await mkdir(qoderAuthHostPath);
  await writeFile(`${qoderAuthHostPath}/user`, "fixture-user");
  await writeFile(`${qoderAuthHostPath}/machine_id`, "fixture-machine");
  const deps = {
    store, runsRootDir: dir, maxConcurrent: 10, scannerImage: "test", getGhToken: async () => "fixture", qoderAuthHostPath,
    activeRuns: new Map(), bus: { publish: () => {} },
    controller: { runScanner: (args: RunScannerArgs) => { launches.push(args); throw new Error("test scanner launch stopped"); } },
  };
  try {
    await mkdir(join(dir, "old", "artifacts"), { recursive: true })
    for (const extra of [
      { reviewProvider: "qoder", reviewModel: "Qwen3.8-Flash", reviewEffort: "" },
      { reviewProvider: "qoder", reviewModel: "Qwen3.8-Flash" },
      { provider: "qoder", model: "Qwen3.8-Flash", effort: undefined, reviewProvider: "claude", reviewModel: "haiku", reviewEffort: "low" },
    ]) {
      let payload: { runId?: string, error?: string } = {};
      let status = 0;
      const c = {
        req: { json: () => Promise.resolve({ ...validBase, mode: "fix", ...extra }) },
        json: (obj: typeof payload, s = 200) => { payload = obj; status = s; return launchResponse(obj, s) },
      } as unknown as Context;
      await handleStartRun(c, deps as never, undefined, undefined, { from: "old", done: [], bundled: false });
      assertEquals({ status, error: payload.error }, { status: 500, error: payload.error });
      const env = launches.at(-1)!.env;
      assertEquals(env.PROVIDER, extra.provider ?? "claude");
      assertEquals(env.REVIEW_PROVIDER, extra.reviewProvider);
      assertEquals(env.REVIEW_EFFORT, extra.reviewProvider === "qoder" ? undefined : "low");
      assertEquals(store.getRun(payload.runId!)?.reviewEffort, extra.reviewProvider === "qoder" ? undefined : "low");
    }
    assertEquals(await runStart({ ...validBase, reviewProvider: "qoder", reviewEffort: "high" }, deps), { status: 400, error: "invalid reviewEffort for review provider" });
  } finally { store.close(); await rm(dir, { recursive: true }); }
});

test("qoder run and resume reject api-key and relay authMode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"));
  const store = await Store.open(`${dir}/test.sqlite`);
  const qoderAuthHostPath = `${dir}/qoder-token.json`;
  await mkdir(qoderAuthHostPath);
  await writeFile(`${qoderAuthHostPath}/user`, "fixture-user");
  await writeFile(`${qoderAuthHostPath}/machine_id`, "fixture-machine");
  const launches: RunScannerArgs[] = [];
  const deps = {
    store, runsRootDir: dir, maxConcurrent: 10, scannerImage: "test", getGhToken: async () => "fixture", qoderAuthHostPath,
    anthropicApiKey: "test.api.key", relayBaseUrl: "https://relay.invalid", relayAuthToken: "test.relay.token",
    activeRuns: new Map(), bus: { publish: () => {} },
    controller: { runScanner: (args: RunScannerArgs) => { launches.push(args); throw new Error("test scanner launch stopped"); } },
  };
  const error = "Qoder runs require oauth authMode";
  const request = { ...validBase, provider: "qoder", model: "Qwen3.8-Flash" } as const;
  try {
    store.ensureSession("s1");
    store.createRun({ ...request, runId: "old", branch: "main", authMode: "oauth" } as never);
    store.updateRunStatus("old", "stopped");
    await mkdir(`${dir}/old/artifacts`, { recursive: true });
    await writeFile(`${dir}/old/artifacts/checkpoint.json`, '{"done":[],"bundled":false}');
    for (const authMode of ["api-key", "relay"]) {
      assertEquals(await runStart({ ...request, authMode }, deps), { status: 400, error });
      let payload: { error?: string } = {};
      let status = 0;
      const c = { req: { param: () => "old", text: async () => JSON.stringify({ authMode }) },
        json: (obj: { error?: string }, s = 200) => { payload = obj; status = s; return new Response(); } } as unknown as Context;
      await handleResumeRun(c, deps as never);
      assertEquals({ status, error: payload.error }, { status: 400, error });
    }
    assertEquals(launches.length, 0);
  } finally { store.close(); await rm(dir, { recursive: true }); }
});
