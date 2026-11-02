import { test } from "node:test"
import assert from "node:assert/strict"
import { redact } from "./redact.mjs"

test("redact removes OpenAI and Codex key values in plain and JSON-escaped form", () => {
  // Not token-shaped, so only the named-variable path can catch them.
  const env = { OPENAI_API_KEY: ["openai", '"fixture'].join(""), CODEX_API_KEY: ["codex-", "fixture-value"].join("") }
  assert.equal(redact(`bad key ${env.OPENAI_API_KEY} and ${env.CODEX_API_KEY}`, env), "bad key [REDACTED] and [REDACTED]")
  assert.equal(redact(JSON.stringify({ message: env.OPENAI_API_KEY }), env), '{"message":"[REDACTED]"}')
})
