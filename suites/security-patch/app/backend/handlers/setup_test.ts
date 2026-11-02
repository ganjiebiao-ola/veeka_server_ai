import { test } from "bun:test"
import { deepStrictEqual as assertEquals } from "node:assert/strict"
import type { Context } from "hono"
import { handleSetup } from "./setup.ts"

test("setup reports GitHub login and push method without secret values", async () => {
  let payload: unknown
  const c = { json: (value: unknown) => { payload = value; return new Response() } } as unknown as Context
  await handleSetup(c, {}, () => Promise.reject(new Error("no login")))
  assertEquals(payload, { githubLogin: false, push: null })
  await handleSetup(c, { getGhToken: async () => "x" }, () => Promise.resolve("synthetic"))
  assertEquals(payload, { githubLogin: true, push: "token" })
})
