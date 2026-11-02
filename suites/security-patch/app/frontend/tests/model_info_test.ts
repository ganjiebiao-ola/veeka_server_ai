import { test } from "bun:test"
import { deepStrictEqual as assertEquals } from "node:assert/strict"
import { displayModelInfo, displayProvider, PROVIDERS } from "../src/types/events.ts"

test("model display preserves resolved IDs and marks historical requests", () => {
  assertEquals(displayModelInfo({ model: "sonnet", effort: "medium" }, "Unspecified"),
    { model: "Claude Sonnet 5.5 · Requested", effort: "medium" })
  assertEquals(displayModelInfo({ model: "gateway/gpt-test", effort: "high" }, "Unspecified"),
    { model: "gateway/gpt-test · Requested", effort: "high" })
  assertEquals(displayModelInfo({ provider: "codex", model: "", effort: "medium" }, "Unspecified"),
    { model: "Codex · Unspecified", effort: "Unspecified" })
  assertEquals(displayModelInfo({ provider: "codex", model: "gpt-alias", effort: "medium" }, "未指定", "请求值"),
    { model: "gpt-alias · 请求值", effort: "未指定" })
  assertEquals(displayModelInfo({ provider: "codex", model: "gpt-alias", effort: "medium",
    modelInfo: { model: "gpt-exact-version", effort: "xhigh" } }, "Unspecified"),
    { model: "gpt-exact-version", effort: "xhigh" })
  assertEquals(displayModelInfo({ provider: "codex", model: "gpt-alias", effort: "medium",
    modelInfo: { model: "gpt-exact-version" } }, "Unspecified"),
    { model: "gpt-exact-version", effort: "Unspecified" })
  assertEquals(displayModelInfo({ model: "sonnet", effort: "high", modelInfo: { model: "claude-sonnet-5-5", effort: "high" } }, "Unspecified"),
    { model: "Claude Sonnet 5.5", effort: "high", reportedId: "claude-sonnet-5-5" })
  assertEquals(displayModelInfo({ model: "haiku", effort: "high", modelInfo: { model: "claude-haiku-4-5-20251001" } }, "Unspecified").model,
    "Claude Haiku 4.5")
  // A relay run is Claude through LiteLLM. A relay model named "sonnet" is not the picker alias.
  assertEquals(displayProvider({ provider: "claude", authMode: "relay" }), "Claude · LiteLLM key")
  assertEquals(displayProvider({ provider: "claude" }), "Claude · Subscription")
  assertEquals(displayProvider({ provider: "claude", authMode: "api-key" }), "Claude · API key")
  assertEquals(displayProvider({ provider: "codex", authMode: "oauth" }), "Codex")
  assertEquals(displayModelInfo({ provider: "claude", authMode: "relay", model: "sonnet", effort: "low" }, "Unspecified").model,
    "sonnet · Requested")
  assertEquals(PROVIDERS.codex.efforts, ["low", "medium", "high", "xhigh"])
  assertEquals(PROVIDERS.codex.defaultEffort, "medium")
})
