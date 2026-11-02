import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { test, spyOn } from "bun:test"
import { deepStrictEqual as assertEquals } from "node:assert/strict"
import { ScannerRun } from "./scanner.ts";
import type { Finding, RunEvent } from "../../shared/types.ts";

// Minimal fakes — we only exercise handleBridgeEvent, not the docker handle.
function makeScanner(mode: "fix" | "scan" = "fix", repoUrl = "https://github.com/Owner/Repo.git", includeP2 = false) {
  const published: RunEvent[] = [];
  const findings: Finding[] = [];
  const statusCalls: Array<{ status: string; stopReason?: string }> = [];
  const vendor: unknown[] = []
  const store = {
    getRun: (_id: string) => ({ status: statusCalls.at(-1)?.status ?? "scanning", mode, repoUrl, includeP2 }),
    updateRunStatus: (_id: string, status: string, opts?: { stopReason?: string }) => { statusCalls.push({ status, ...opts }); },
    setRunPhase: () => {},
    addUsage: () => {},
    saveVendor: (_id: string, data: unknown) => { vendor.push(data) },
    insertFinding: (_id: string, finding: Finding) => { findings.push(finding); },
  };
  const bus = { publish: (_id: string, ev: RunEvent) => { published.push(ev); } };
  const deps = {
    controller: {} as never, bus: bus as never, store: store as never,
  };
  const scanner = new ScannerRun("run-1", deps) as unknown as {
    handleBridgeEvent(e: unknown): void;
    onExit(code: number): Promise<void>;
    artifactsDir: string;
  };
  return { scanner, published, statusCalls, findings, vendor };
}

for (const mode of ["fix", "scan"] as const) {
  test(`run_finished (${mode}) marks the run completed`, () => {
    const { scanner, statusCalls, published } = makeScanner(mode);
    scanner.handleBridgeEvent({ kind: "run_finished" });
    assertEquals(statusCalls.some((c) => c.status === "completed"), true);
    assertEquals(published.find((e) => e.type === "run_finished"), { type: "run_finished", status: "completed" });
  });
}

test("a scan quota stop remains stopped when its container exits with code 1", async () => {
  const { scanner, statusCalls, published } = makeScanner("scan")
  scanner.handleBridgeEvent({ kind: "run_stopped", reason: "quota" })
  await scanner.onExit(1)
  assertEquals(statusCalls.map(call => call.status), ["stopped"])
  assertEquals(published.find(event => event.type === "run_finished"),
    { type: "run_finished", status: "stopped", error: "stopped at quota" })
})

test("push_result frame is relayed as an SSE push_result event", () => {
  const { scanner, published } = makeScanner();
  scanner.handleBridgeEvent({ kind: "push_result", ok: true, branch: "ola-codesec/fix-abc" });
  const ev = published.find((e) => e.type === "push_result");
  assertEquals(ev?.ok, true);
  assertEquals(ev?.branch, "ola-codesec/fix-abc");
});

test("push_result frame resolves a pending pushToBranch", async () => {
  const { scanner } = makeScanner();
  const s = scanner as any;
  // Fake container handle: stdin.write is a no-op so pushToBranch parks a
  // pending resolver instead of erroring on a missing handle.
  s.handle = { stdin: { write: (_x: Uint8Array) => Promise.resolve() } };
  const p = s.pushToBranch("ola-codesec/fix-abc", 5000);
  s.handleBridgeEvent({ kind: "push_result", ok: true, branch: "ola-codesec/fix-abc" });
  const res = await p;
  assertEquals(res.ok, true);
  assertEquals(res.branch, "ola-codesec/fix-abc");
});

test("pushes wait five minutes by default and clear the deadline on a result", async () => {
  const { scanner } = makeScanner()
  const s = scanner as any
  s.handle = { stdin: { write: async () => {} } }
  const timer = spyOn(globalThis, "setTimeout")
  const clear = spyOn(globalThis, "clearTimeout")
  try {
    const result = s.pushToBranch("security/slow")
    assertEquals(timer.mock.calls[0][1], 5 * 60_000)
    assertEquals(await s.pushToBranch("security/duplicate"), { ok: false, error: "push already in progress" })
    s.handleBridgeEvent({ kind: "push_result", ok: true, branch: "security/slow" })
    assertEquals((await result).ok, true)
    assertEquals(clear.mock.calls.length, 1)
  } finally { timer.mockRestore(); clear.mockRestore() }
})

test("container exit resolves a pending push immediately and rejects further pushes", async () => {
  const { scanner } = makeScanner()
  const s = scanner as any
  s.handle = { stdin: { write: async () => {} } }
  const result = s.pushToBranch("security/test")
  await s.onExit(137)
  assertEquals(await result, { ok: false, error: "scanner exited with code 137 before reporting the push result — check the remote branch before retrying" })
  assertEquals((await s.pushToBranch("security/test")).error, "scanner container is gone — download the patch instead")
})

test("a push deadline reports the uncertain remote branch", async () => {
  const { scanner } = makeScanner()
  const s = scanner as any
  s.handle = { stdin: { write: async () => {} } }
  const result = await s.pushToBranch("security/test", 1)
  assertEquals(result.ok, false)
  assertEquals(result.pending, true)
  assertEquals(result.error, "push result not received after 0s — remote branch security/test may exist, check before retrying")
})

test("a closed stdin resolves a pending push without waiting for its deadline", async () => {
  const { scanner } = makeScanner()
  const s = scanner as any
  s.handle = { stdin: { write: async () => { throw new Error("fixture closed") } } }
  assertEquals(await s.pushToBranch("security/test"), { ok: false, error: "stdin closed" })
})


test("run end imports findings before publishing completion in all modes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"));
  const row = {
    id: "a".repeat(64), category: "api-no-auth", severity: "P0", file: "api.ts",
    line: 1, snippet: "serve(handler)", fix_summary: "", status: "candidate", reason: "No auth",
  };
  try {
    await writeFile(`${dir}/findings.json`, JSON.stringify([row]));
    for (const mode of ["scan", "fix"] as const) {
      const { scanner, findings, published } = makeScanner(mode);
      scanner.artifactsDir = dir;
      scanner.handleBridgeEvent({ kind: "run_finished" });
      assertEquals(findings[0].id, row.id);
      assertEquals(findings[0].reason, row.reason);
      assertEquals(published.some((e) => e.type === "run_finished" && e.status === "completed"), true);
      const exitOnly = makeScanner(mode);
      exitOnly.scanner.artifactsDir = dir;
      await exitOnly.scanner.onExit(0);
      assertEquals(exitOnly.findings[0].id, row.id);
    }
    for (const bad of [null, "{", "{}"]) {
      if (bad === null) await rm(`${dir}/findings.json`);
      else await writeFile(`${dir}/findings.json`, bad);
      const { scanner, findings, statusCalls } = makeScanner();
      scanner.artifactsDir = dir;
      scanner.handleBridgeEvent({ kind: "run_finished" });
      assertEquals(findings.length, 0);
      assertEquals(statusCalls.some((c) => c.status === "completed"), true);
    }
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("the container's cloning status ends the prepare step and starts the clone step, with start times", () => {
  const { scanner, published, statusCalls } = makeScanner("scan");
  scanner.handleBridgeEvent({ kind: "scanner_status", status: "cloning" });
  assertEquals(statusCalls.at(-1)?.status, "cloning");
  assertEquals(published.map((e) => e.type === "run_status" ? `status:${e.status}` : e.type === "step_started" || e.type === "step_completed" ? `${e.type}:${e.step}` : e.type),
    ["status:cloning", "step_completed:prepare", "step_started:ingest"]);
  const started = published.find((e) => e.type === "step_started");
  assertEquals(typeof (started as { ts?: number }).ts, "number");
  scanner.handleBridgeEvent({ kind: "clone_done", branch: "main" });
  // clone_done also closes "prepare", for runs that never report "cloning" (local workspace runs).
  assertEquals(published.filter((e) => e.type === "step_completed").map((e) => (e as { step: string }).step), ["prepare", "prepare", "ingest"]);
  scanner.handleBridgeEvent({ kind: "scanner_status", status: "scanning" });
  const scan = published.find((e) => e.type === "step_started" && e.step === "scan") as { ts?: number };
  assertEquals(typeof scan.ts, "number");
});

test("output that arrives after a user stop cannot change the aborted end state", async () => {
  const { scanner, published, statusCalls } = makeScanner("scan");
  const inner = scanner as unknown as { handle: unknown; deps: { controller: unknown } };
  inner.handle = { containerName: "test" };
  inner.deps.controller = { stopGraceful: () => Promise.resolve() };
  await (scanner as unknown as { stop(): Promise<void> }).stop();
  assertEquals(statusCalls.at(-1)?.status, "aborted");
  const seen = published.length;
  // The container was still starting: its "cloning" line, then a failure, arrive after the stop.
  scanner.handleBridgeEvent({ kind: "scanner_status", status: "cloning" });
  scanner.handleBridgeEvent({ kind: "scanner_failed", error: "killed" });
  scanner.handleBridgeEvent({ kind: "scanner_status", status: "scanning" });
  assertEquals(statusCalls.map((c) => c.status), ["aborted"]);
  assertEquals(published.length, seen);
});

test("a batch phase frame marks the steps up to the commit done and starts review, live and in replay", async () => {
  const { scanner, published } = makeScanner();
  scanner.handleBridgeEvent({ kind: "phase", phase: "review" });
  const steps = (events: RunEvent[]) => events.flatMap((e) => e.type === "step_started" || e.type === "step_completed" ? [`${e.type}:${e.step}`] : []);
  const expected = ["step_completed:scan", "step_completed:classify", "step_completed:fix", "step_completed:commit", "step_started:review"];
  assertEquals(steps(published), expected);
  assertEquals(published.find(e => e.type === "run_phase"), { type: "run_phase", phase: "review" });
  const { replayEvents } = await import("../events/replay.ts");
  const replayed: RunEvent[] = [];
  const source = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify({ kind: "phase", phase: "checks" }) + "\n")); c.close(); } });
  for await (const line of replayEvents(source)) replayed.push(JSON.parse(line));
  assertEquals(replayed.find(e => e.type === "run_phase"), { type: "run_phase", phase: "checks" });
  assertEquals(steps(replayed), ["step_completed:prepare", "step_completed:ingest", ...expected]);
});

test("stderr.log keeps whole lines and drops a secret split across two chunks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-stderr-"))
  try {
    const { scanner } = makeScanner("scan")
    scanner.artifactsDir = dir
    // Built at runtime so the repo secret scan never sees a token-shaped literal.
    const secret = ["ab", "cd"].join("").repeat(8)
    const chunks = [`clone failed: ${secret.slice(0, 10)}`, `${secret.slice(10)} rejected\nexit 128`]
    const stream = new ReadableStream<Uint8Array>({
      start(c) { for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk)); c.close() },
    })
    await (scanner as unknown as { drainStderr(s: ReadableStream<Uint8Array>, secrets: string[]): Promise<void> }).drainStderr(stream, [secret])
    const log = await Bun.file(join(dir, "stderr.log")).text()
    assertEquals(log.includes(secret), false)
    assertEquals(log, "clone failed: «已脱敏:配置值» rejected\nexit 128\n")
  } finally {
    await rm(dir, { recursive: true })
  }
})


test("stderr.log is not written through a symlink", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-stderr-"))
  try {
    await writeFile(join(dir, "target"), "original")
    await symlink(join(dir, "target"), join(dir, "stderr.log"))
    const { scanner } = makeScanner("scan")
    scanner.artifactsDir = dir
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("boom\n")); c.close() } })
    await (scanner as unknown as { drainStderr(s: ReadableStream<Uint8Array>): Promise<void> }).drainStderr(stream)
    assertEquals(await readFile(join(dir, "target"), "utf8"), "original")
  } finally {
    await rm(dir, { recursive: true })
  }
})

test("scan completion imports vendor artifacts on bridge completion and container exit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vendor-completion-"))
  const data = {
    trees: [{ path: "lib/vendor", mode: "committed", lock: "missing", metadataSource: "installed.json", evidence: ["tracked"], mismatches: [], audit: "completed", packages: [{ name: "example/lib", version: "1.0" }] }],
    advisories: [{ package: "example/lib", version: "1.0", trees: ["lib/vendor"], advisoryId: "PKSA-example",
      cve: null, title: "Example", severity: "high", link: null }], errors: [],
  }
  try {
    await writeFile(join(dir, "vendor.json"), JSON.stringify(data))
    await writeFile(join(dir, "findings.json"), "[]")
    for (const completion of ["bridge", "exit"] as const) {
      for (const mode of ["scan", "fix"] as const) {
        const { scanner, vendor, findings } = makeScanner(mode, "")
        scanner.artifactsDir = dir
        if (completion === "bridge") scanner.handleBridgeEvent({ kind: "run_finished" })
        else await scanner.onExit(0)
        assertEquals(vendor, mode === "scan" ? [data] : [])
        assertEquals(findings.map(finding => finding.category), mode === "scan" ? ["vendor-cve"] : [])
      }
    }
  } finally { await rm(dir, { recursive: true }) }
})

test("an event that throws does not stop the stdout reader", async () => {
  const { scanner, statusCalls } = makeScanner();
  const s = scanner as unknown as { handleBridgeEvent(e: unknown): void, consumeStdout(stream: ReadableStream<Uint8Array>): Promise<void> };
  const handle = s.handleBridgeEvent.bind(s);
  s.handleBridgeEvent = (e) => { if ((e as { kind: string }).kind === "bad") throw new Error("bad event"); handle(e) };
  const lines = [{ kind: "bad" }, { kind: "run_finished" }].map((e) => JSON.stringify(e) + "\n").join("");
  const error = spyOn(console, "error").mockImplementation(() => {});
  try { await s.consumeStdout(new Response(lines).body!) } finally { error.mockRestore() }
  assertEquals(statusCalls.some((c) => c.status === "completed"), true);
});


test("phase usage reconciles Claude rounds, includes Codex tokens, and persists locally", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-usage-"))
  const { scanner, published } = makeScanner()
  scanner.artifactsDir = dir
  const send = (phase: string, provider: string, message: unknown) =>
    scanner.handleBridgeEvent({ kind: "sdk_message", phase, provider, message })
  try {
    const estimate = { type: "assistant", message: { id: "fix-1", content: [], usage: { input_tokens: 100, output_tokens: 1 } } }
    send("fix", "claude", estimate)
    send("fix", "claude", estimate)
    send("fix", "claude", { type: "result", usage: {
      input_tokens: 200, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 20,
    } })
    send("fix", "claude", { type: "result", usage: { input_tokens: 10, output_tokens: 5 } })
    send("review", "codex", { type: "result", usage: { input_tokens: 2500, cache_read_input_tokens: 10000, output_tokens: 750 } })
    send("checks", "claude", { type: "result", usage: { input_tokens: 30, output_tokens: 2 } })
    const record = JSON.parse(await readFile(join(dir, "usage.json"), "utf8"))
    assertEquals(record.phaseUsage, {
      fix: { inputTokens: 210, outputTokens: 55, cacheReadTokens: 1000, cacheCreateTokens: 20 },
      review: { inputTokens: 2500, outputTokens: 750, cacheReadTokens: 10000, cacheCreateTokens: 0 },
      checks: { inputTokens: 30, outputTokens: 2, cacheReadTokens: 0, cacheCreateTokens: 0 },
    })
    assertEquals(record.usage, { inputTokens: 2740, outputTokens: 807, cacheReadTokens: 11000, cacheCreateTokens: 20, })
    assertEquals(published.filter(e => e.type === "usage_delta").map(e => e.phase), ["fix", "fix", "fix", "review", "checks"])
  } finally { await rm(dir, { recursive: true }) }
})

for (const includeP2 of [false, true]) {
  test(`scan import filters P2 and strips advice, including stopped runs (includeP2=${includeP2})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "scan-output-"));
    const rows = ["P0", "P1", "P2"].map((severity, index) => ({
      id: String(index + 1).repeat(64), category: "sqli", severity, file: "a.php", line: index + 1,
      snippet: "query($input)", fix_summary: "Bind input", status: "candidate",
      reason: "Evidence: input reaches query\nFix: Bind input",
    }));
    try {
      await writeFile(join(dir, "findings.json"), JSON.stringify(rows));
      for (const mode of ["scan", "fix"] as const) {
        for (const kind of ["run_finished", "run_stopped"] as const) {
          const { scanner, findings } = makeScanner(mode, "", includeP2);
          scanner.artifactsDir = dir;
          scanner.handleBridgeEvent({ kind });
          assertEquals(findings.map(row => row.severity), mode === "scan" && !includeP2 ? ["P0", "P1"] : ["P0", "P1", "P2"]);
          assertEquals(findings.every(row => row.fixSummary === (mode === "scan" ? "" : "Bind input")), true);
          assertEquals(findings.every(row => row.reason === (mode === "scan" ? "Evidence: input reaches query" : rows[0].reason)), true);
        }
      }
    } finally { await rm(dir, { recursive: true }); }
  });
}

for (const reason of ["pause", "quota"] as const) {
  test(`scanner stores the ${reason} stop reason`, () => {
    const { scanner, statusCalls } = makeScanner("scan");
    scanner.handleBridgeEvent({ kind: "run_stopped", reason });
    assertEquals(statusCalls[0].stopReason, reason === "pause" ? "user_pause" : "quota");
  });
}
