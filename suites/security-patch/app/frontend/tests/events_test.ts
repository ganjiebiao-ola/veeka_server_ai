import { test } from "bun:test";
import { deepStrictEqual as assertEquals } from "node:assert/strict";
import { buildInitialRunState, parseEventsLog, reduceRunEvent } from "../src/hooks/useRunEvents.ts";

test("derived state remains complete without retaining raw events", () => {
  let state = buildInitialRunState()
  for (let i = 0; i < 2100; i++) {
    state = reduceRunEvent(state, { type: "thinking_emitted", text: String(i), ts: i })
  }
  state = reduceRunEvent(state, { type: "tool_invoked", tool: "Read", input: { file_path: "a.ts" }, ts: 3000 })
  state = reduceRunEvent(state, { type: "tool_completed", tool: "Read", ok: true, summary: "Read source", ts: 3010 })
  state = reduceRunEvent(state, { type: "assistant_text", text: "First" })
  state = reduceRunEvent(state, { type: "assistant_text", text: "Second" })
  const finding = { id: "one", category: "sqli", severity: "P1" as const }
  state = reduceRunEvent(state, { type: "finding_emitted", finding })
  assertEquals("events" in state, false)
  assertEquals(state.timeline.length, 2101)
  assertEquals(state.timeline[0], { thinking: "0", ts: 0 })
  assertEquals(state.timeline.at(-1), { tool: 0 })
  assertEquals(state.toolLog[0], { ts: 3000, tool: "Read", input: { file_path: "a.ts" }, ok: true, summary: "Read source", durationMs: 10 })
  assertEquals(state.assistantText, "First\n\nSecond")
  assertEquals(state.findings, [finding])
})

test("parseEventsLog handles empty and whitespace input", () => {
  const res1 = parseEventsLog("");
  assertEquals(res1.toolLog, []);
  assertEquals(res1.timeline, []);
  assertEquals(res1.steps.length, 4);
  assertEquals(res1.steps.every(step => step.status === "pending"), true);

  const res2 = parseEventsLog("  \n\n  ");
  assertEquals(res2.toolLog, []);
  assertEquals(res2.timeline, []);
  assertEquals(res2.steps.length, 4);
  assertEquals(res2.steps.every(step => step.status === "pending"), true);
});

test("parseEventsLog parses tool invocations and matches tool completions", () => {
  const jsonl = [
    JSON.stringify({ type: "tool_invoked", tool: "Bash", input: { command: "ls -la" } }),
    JSON.stringify({ type: "tool_completed", tool: "Bash", ok: true, summary: "total 0" }),
    JSON.stringify({ type: "tool_invoked", tool: "Read", input: { file_path: "foo.txt" } }),
  ].join("\n");

  const { toolLog } = parseEventsLog(jsonl);
  assertEquals(toolLog.length, 2);
  assertEquals(toolLog[0].tool, "Bash");
  assertEquals(toolLog[0].input, { command: "ls -la" });
  assertEquals(toolLog[0].ok, true);
  assertEquals(toolLog[0].summary, "total 0");
  assertEquals(toolLog[1].tool, "Read");
  assertEquals(toolLog[1].input, { file_path: "foo.txt" });
  assertEquals(toolLog[1].ok, undefined);
});

test("parseEventsLog keeps reasoning and tool calls in the order they happened", () => {
  const jsonl = [
    JSON.stringify({ type: "thinking_emitted", text: "Analyzing repository structure...", ts: 1000 }),
    JSON.stringify({ type: "tool_invoked", tool: "Bash", input: { command: "pwd" } }),
    JSON.stringify({ type: "thinking_emitted", text: "Found the relevant vulnerability site." }),
  ].join("\n");

  const { timeline } = parseEventsLog(jsonl);
  assertEquals(timeline, [
    { thinking: "Analyzing repository structure...", ts: 1000 },
    { tool: 0 },
    // Logs saved before the bridge stamped its frames have no time.
    { thinking: "Found the relevant vulnerability site.", ts: undefined },
  ]);
});

test("parseEventsLog safely ignores unrelated events and malformed JSON lines", () => {
  const jsonl = [
    "not-a-json-line",
    JSON.stringify({ type: "step_started", step: "scan" }),
    JSON.stringify({ type: "thinking_emitted", text: "Valid reasoning" }),
    "{ malformed json",
    JSON.stringify({ type: "assistant_text", text: "Report chunk" }),
  ].join("\n");

  const { toolLog, timeline } = parseEventsLog(jsonl);
  assertEquals(toolLog.length, 0);
  assertEquals(timeline, [{ thinking: "Valid reasoning", ts: undefined }]);
});

test("parseEventsLog tracks step progression and mode", () => {
  const jsonl = [
    JSON.stringify({ type: "step_started", step: "prepare" }),
    JSON.stringify({ type: "step_completed", step: "prepare", status: "completed" }),
    JSON.stringify({ type: "step_started", step: "scan" }),
  ].join("\n");

  const { steps } = parseEventsLog(jsonl, "scan");
  assertEquals(steps.find((s) => s.name === "prepare")?.status, "completed");
  assertEquals(steps.find((s) => s.name === "scan")?.status, "in_progress");
  assertEquals(steps.find((s) => s.name === "report")?.status, "pending");
  // Old Audit runs fall back to the scan steps instead of crashing.
  assertEquals(parseEventsLog(jsonl, "audit-only" as never).steps.map((s) => s.name), ["prepare", "ingest", "scan", "report"]);
});

test("historical failures and completion statuses do not complete unobserved steps", () => {
  for (const status of ["failed", "stopped", "completed"]) {
    const { steps } = parseEventsLog([
      JSON.stringify({ type: "step_completed", step: "prepare", status: "completed" }),
      JSON.stringify({ type: "step_started", step: "scan" }),
      JSON.stringify({ type: "run_status", status }),
    ].join("\n"), "fix");
    assertEquals(steps.find(step => step.name === "prepare")?.status, "completed");
    assertEquals(steps.find(step => step.name === "scan")?.status, "in_progress");
    assertEquals(steps.find(step => step.name === "fix")?.status, "pending");
    assertEquals(steps.find(step => step.name === "report")?.status, "pending");
  }
});


test("phase usage accumulates token corrections separately", () => {
  let state = buildInitialRunState("fix")
  const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 500, cacheCreateTokens: 10 }
  state = reduceRunEvent(state, { type: "usage_delta", phase: "fix", usage })
  state = reduceRunEvent(state, { type: "usage_delta", phase: "fix", usage: { ...usage, inputTokens: -50 } })
  state = reduceRunEvent(state, { type: "usage_delta", phase: "review", usage: { ...usage } })
  state = reduceRunEvent(state, { type: "usage_delta", phase: "checks", usage: { ...usage } })
  assertEquals(state.hasUsage, true)
  assertEquals(state.phaseUsage.fix, { inputTokens: 50, outputTokens: 40, cacheReadTokens: 1000, cacheCreateTokens: 20 })
})

test("run usage sums tokens across deltas", () => {
  const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreateTokens: 0 }
  let state = reduceRunEvent(buildInitialRunState("fix"), { type: "usage_delta", phase: "review", usage: { ...usage } })
  state = reduceRunEvent(state, { type: "usage_delta", phase: "review", usage })
  assertEquals(state.phaseUsage.review?.inputTokens, 200)
})

test("legacy usage deltas ignore removed cost fields", () => {
  const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 500, cacheCreateTokens: 10 };
  const legacy = { ...usage, estCostUsd: "ignored", costPartial: true };
  const event = JSON.parse(JSON.stringify({ type: "usage_delta", phase: "fix", usage: legacy }));
  const state = reduceRunEvent(buildInitialRunState("fix"), event);
  assertEquals(state.usage, usage);
  assertEquals(state.phaseUsage.fix, usage);
});

for (const legacy of [true, false]) for (const flag of ["partialUsage", "partial_usage"]) test(`${legacy ? "legacy" : "current"} ${flag} persists across token deltas`, () => {
  const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 500, cacheCreateTokens: 10 };
  const event = JSON.parse(JSON.stringify({ type: "usage_delta", phase: "fix",
    usage: { ...usage, [flag]: true, ...(legacy ? { estCostUsd: "ignored", costPartial: true } : {}) } }));
  let state = reduceRunEvent(buildInitialRunState("fix"), { type: "usage_delta", phase: "fix", usage });
  state = reduceRunEvent(state, event);
  state = reduceRunEvent(state, { type: "usage_delta", phase: "fix", usage });
  const expected = { inputTokens: 300, outputTokens: 60, cacheReadTokens: 1500, cacheCreateTokens: 30, [flag]: true };
  assertEquals(state.usage, expected);
  assertEquals(state.phaseUsage.fix, expected);
  state = reduceRunEvent(state, { type: "usage_delta", phase: "review", usage });
  assertEquals(state.usage[flag as "partialUsage" | "partial_usage"], true);
  assertEquals(state.phaseUsage.review, usage);
});
