import { test } from "bun:test"
import assert from "node:assert/strict"
import { decodeJsonlStream } from "./jsonl_decoder.ts"
import { deltaFromUsage } from "./usage_aggregator.ts"

test("the decoder yields only JSON objects", async () => {
  const text = `null\n5\n"x"\n[1]\nnot json\n{"kind":"a"}\n{"kind":"b"}`
  const stream = new Response(text).body!
  const kinds: unknown[] = []
  for await (const evt of decodeJsonlStream(stream)) kinds.push((evt as { kind: unknown }).kind)
  assert.deepEqual(kinds, ["a", "b"])
})

test("cached inputs are not counted twice", () => {
  assert.deepEqual(deltaFromUsage({ input_tokens: 1000, cached_input_tokens: 200, output_tokens: 10 }),
    { inputTokens: 800, outputTokens: 10, cacheReadTokens: 200, cacheCreateTokens: 0 })
})
