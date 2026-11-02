import { test } from "bun:test"
import assert from "node:assert/strict"
import { RunInputs } from "../src/components/RunInputs"
import { browser, harness, markup, nodes, text } from "./render"

const inputs = [
  { path: "operator-note.md", source: "human", size: 12 },
  { path: "target-notes.md", source: "repo", size: 24 },
  { path: "SKILL.md", source: "suite", size: 48 },
  { path: "context.md", source: "workspace", size: 16 },
  { path: "large.md", source: "workspace", size: 16385, reason: "file-too-large" },
  { path: "budget.md", source: "workspace", size: 15360, reason: "context-budget" },
  { path: "<script>.md", source: "workspace", size: 5, reason: "symlink" },
]

for (const lang of ["en", "zh"] as const) test(`run inputs group included and dropped files by source (${lang})`, async () => {
  const originalFetch = globalThis.fetch
  const env = browser("/run/fixture", { ola_lang: lang })
  const h = harness()
  const props = { runId: "run/id" }
  globalThis.fetch = (async (url: string | URL | Request) => {
    assert.equal(String(url), "/api/runs/run%2Fid/artifacts/inputs")
    return Response.json(inputs)
  }) as typeof fetch
  try {
    h.render(RunInputs, props)
    await h.flush()
    const view = h.render(RunInputs, props)
    const groups = nodes(view, node => node.type === "section")
    assert.deepEqual(groups.map(group => text(nodes(group, node => node.type === "h3")[0])),
      lang === "en" ? ["Repository", "Workspace", "Human", "Suite"] : ["仓库", "工作区", "人工输入", "套件"])
    for (const input of inputs) {
      const group = groups[["repo", "workspace", "human", "suite"].indexOf(input.source)]
      assert.ok(text(group).includes(input.path))
      assert.ok(text(group).includes(String(input.size)))
    }
    for (const reason of lang === "en" ? ["Over 16 KiB", "Over the 64K-character context budget", "Symlink"] :
      ["超过 16 KiB", "超过 64K 字符上下文预算", "符号链接"]) assert.ok(text(view).includes(reason))
    assert.ok(text(view).includes(lang === "en" ? "Included" : "已包含"))
    assert.ok(markup(view).includes("&lt;script&gt;.md"))
  } finally {
    h.cleanup()
    env.cleanup()
    globalThis.fetch = originalFetch
  }
})

for (const [name, response, expected] of [
  ["valid record", () => Response.json(inputs), "operator-note.md"],
  ["unavailable record", () => new Response(null, { status: 404 }), "No input record available"],
] as const) test(`run inputs recover from HTTP 500 to ${name}`, async () => {
  const originalFetch = globalThis.fetch
  const env = browser("/run/fixture", { ola_lang: "en" })
  const h = harness()
  let requests = 0
  globalThis.fetch = (async () => ++requests === 1 ? new Response(null, { status: 500 }) : response()) as unknown as typeof fetch
  try {
    h.render(RunInputs, { runId: "failed" })
    await h.flush()
    assert.ok(text(h.render(RunInputs, { runId: "failed" })).includes("HTTP 500"))
    h.render(RunInputs, { runId: "recovered" })
    await h.flush()
    const view = h.render(RunInputs, { runId: "recovered" })
    assert.equal(requests, 2)
    assert.equal(nodes(view, node => node.props.role === "alert").length, 0)
    assert.ok(text(view).includes(expected))
  } finally {
    h.cleanup()
    env.cleanup()
    globalThis.fetch = originalFetch
  }
})

for (const [name, response, expected] of [
  ["old run", () => new Response(null, { status: 404 }), "No input record available"],
  ["empty record", () => Response.json([]), "No input files recorded"],
  ["invalid record", () => Response.json([{ ...inputs[0], size: -1 }]), "Invalid input record"],
  ["unknown drop reason", () => Response.json([{ ...inputs[0], reason: "unknown" }]), "Invalid input record"],
  ["failed request", () => new Response(null, { status: 500 }), "HTTP 500"],
] as const) test(`run inputs handle ${name}`, async () => {
  const originalFetch = globalThis.fetch
  const h = harness()
  globalThis.fetch = (async () => response()) as unknown as typeof fetch
  try {
    h.render(RunInputs, { runId: "fixture" })
    await h.flush()
    assert.ok(text(h.render(RunInputs, { runId: "fixture" })).includes(expected))
  } finally {
    h.cleanup()
    globalThis.fetch = originalFetch
  }
})
