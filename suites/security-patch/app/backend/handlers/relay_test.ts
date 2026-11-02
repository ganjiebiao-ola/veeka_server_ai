import { test } from "bun:test"
import { deepStrictEqual as assertEquals } from "node:assert/strict"
import type { Context } from "hono";
import { handleRelayModels } from "./relay.ts";

// The relay handler only reads (deps, fetch result), so a fake Context that
// captures (status, body) is enough.
function ctx() {
  let status = 0;
  let payload: Record<string, unknown> = {};
  const c = {
    json: (obj: Record<string, unknown>, s = 200) => { payload = obj; status = s; return new Response(); },
  } as unknown as Context;
  return { c, done: () => ({ status, payload }) };
}

test("relay models: an unconfigured channel reports configured:false", async () => {
  const r = ctx();
  await handleRelayModels(r.c, {});
  assertEquals(r.done(), { status: 200, payload: { configured: false, models: [] } });
});

test("relay models: lists ids, deduped and sorted, with the bearer key", async () => {
  const r = ctx();
  let url = "";
  let auth: string | undefined;
  const fetchImpl = ((u: string | URL | Request, init?: RequestInit) => {
    url = String(u);
    auth = (init?.headers as Record<string, string>).Authorization;
    return Promise.resolve(new Response(JSON.stringify({
      data: [{ id: "glm-5.2" }, { id: "gpt-5" }, { id: "glm-5.2" }, { notId: 1 }, { id: "" }],
    }), { status: 200 }));
  }) as unknown as typeof fetch;
  await handleRelayModels(r.c, { baseUrl: "https://litellm.example/", authToken: "sk-vk", fetchImpl });
  assertEquals(r.done(), { status: 200, payload: { configured: true, models: ["glm-5.2", "gpt-5"] } });
  assertEquals(url, "https://litellm.example/v1/models");
  assertEquals(auth, "Bearer sk-vk");
});

test("relay models: an upstream failure is a 502 and never echoes the key", async () => {
  const r = ctx();
  const fetchImpl = (() => Promise.resolve(new Response("nope", { status: 401 }))) as unknown as typeof fetch;
  await handleRelayModels(r.c, { baseUrl: "https://litellm.example", authToken: "sk-vk", fetchImpl });
  const { status, payload } = r.done();
  assertEquals(status, 502);
  assertEquals(payload.configured, true);
  assertEquals((payload.error as string).includes("401"), true);
  assertEquals(JSON.stringify(payload).includes("sk-vk"), false);
});
