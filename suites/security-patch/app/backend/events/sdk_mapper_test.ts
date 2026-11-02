import { test } from "bun:test";
import assert from "node:assert/strict";
import { SdkMapper } from "./sdk_mapper.ts";
import { UsageAggregator } from "../sdk_bridge/usage_aggregator.ts";

const usage = { input_tokens: 1000, output_tokens: 100 };
const assistant = (id: string) => ({ type: "assistant", message: { id, usage, content: [] } });

test("assistant messages count once and result totals correct each round", () => {
  const mapper = new SdkMapper();
  const total = new UsageAggregator();
  for (const message of [assistant("a"), assistant("a"), assistant("b"),
    { type: "result", usage: { input_tokens: 2000, output_tokens: 900 } },
    assistant("c"), { type: "result", usage }, { type: "result" }]) {
    for (const event of mapper.map(message)) if (event.type === "usage_delta") total.add(event.usage);
  }
  assert.deepEqual(total.snapshot(), { inputTokens: 3000, outputTokens: 1000, cacheReadTokens: 0, cacheCreateTokens: 0 });
});

test("Codex cached inputs remain separate from uncached inputs", () => {
  assert.deepEqual(new SdkMapper().map({ type: "turn.completed", usage: {
    input_tokens: 12500, cached_input_tokens: 10000, output_tokens: 750,
  } }), [{ type: "usage_delta", usage: {
    inputTokens: 2500, outputTokens: 750, cacheReadTokens: 10000, cacheCreateTokens: 0,
  } }]);
});

test("Qoder credits add up per reply, survive a result without usage and replay", async () => {
  const mapper = new SdkMapper();
  const total = new UsageAggregator();
  const reply = (id: string, credits: number) => ({ type: "assistant", message: { id, usage: { credits }, content: [] } });
  for (const message of [{ type: "assistant", message: { content: [] } }, reply("a", 0.5), reply("a", 0.5), reply("b", 0.25),
    { type: "result", subtype: "success" }]) {
    for (const event of mapper.map(message)) if (event.type === "usage_delta") total.add(event.usage);
  }
  assert.deepEqual(total.snapshot(), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, credits: 0.75 });
  const { replayEvents } = await import("./replay.ts");
  const event = { type: "usage_delta", usage: total.snapshot() };
  const replayed = [];
  for await (const line of replayEvents(new Response(JSON.stringify(event) + "\n").body!)) replayed.push(JSON.parse(line));
  assert.deepEqual(replayed, [event]);
});

test("Qoder chunks of one reply count once and the result total corrects the round", () => {
  const mapper = new SdkMapper();
  const total = new UsageAggregator();
  // The Qoder driver drops zero-credit chunks' id and usage, so only the last chunk of reply "a" is billed.
  for (const message of [{ type: "assistant", message: { content: [] } }, { type: "assistant", message: { content: [] } },
    { type: "assistant", message: { id: "a", usage: { credits: 0.5 }, content: [] } },
    { type: "assistant", message: { id: "b", usage: { credits: 0.25 }, content: [] } },
    { type: "result", subtype: "success", usage: { credits: 1.25 } }]) {
    for (const event of mapper.map(message)) if (event.type === "usage_delta") total.add(event.usage);
  }
  assert.deepEqual(total.snapshot(), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, credits: 1.25 });
});

test("a result without usage emits no delta", () => {
  assert.deepEqual(new SdkMapper().map({ type: "result", subtype: "error_during_execution" }), []);
});

for (const legacy of [true, false]) for (const flag of ["partialUsage", "partial_usage"]) test(`${legacy ? "legacy" : "current"} usage events replay ${flag} without cost fields`, async () => {
  const { replayEvents } = await import("./replay.ts");
  const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheCreateTokens: 0, [flag]: true };
  const event = { type: "usage_delta", phase: "fix", usage: { ...usage, ...(legacy ? { estCostUsd: "ignored", costPartial: true } : {}) } };
  const replayed = [];
  for await (const line of replayEvents(new Response(JSON.stringify(event) + "\n").body!)) replayed.push(JSON.parse(line));
  assert.deepEqual(replayed, [{ type: "usage_delta", phase: "fix", usage }]);
});
