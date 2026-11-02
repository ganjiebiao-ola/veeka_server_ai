import { test } from "bun:test"
import assert from "node:assert/strict"
import { replayEvents } from "../../backend/events/replay"
import { buildInitialRunState, reduceRunEvent } from "../src/hooks/useRunEvents"
import { RunUsage } from "../src/components/RunUsage"
import { RunFacts } from "../src/components/RunFacts"
import { RunPage } from "../src/pages/RunPage"
import { RunDetailPage } from "../src/pages/RunDetailPage"
import type { RunSummary } from "../src/types/events"
import { browser, harness, nodes, text, is } from "./render"

const usage = { inputTokens: 2500, outputTokens: 750, cacheReadTokens: 10000, cacheCreateTokens: 0 }
const phaseUsage = { fix: { ...usage }, review: usage, checks: { ...usage } }

for (const lang of ["en", "zh"] as const) test(`phase table shows tokens (${lang})`, () => {
  const env = browser("/run/fixture", { ola_lang: lang })
  const h = harness()
  try {
    const view = h.render(RunUsage, { usage: phaseUsage })
    const rows = nodes(view, node => is(node, "tbody"))[0]
    const cells = nodes(rows, node => is(node, "td")).map(cell => text(cell))
    assert.deepEqual(cells, ["2500", "10000", "750", "2500", "10000", "750", "2500", "10000", "750"])
    assert.ok(text(view).includes(lang === "en" ? "Review" : "审查"))
    const missing = h.render(RunUsage, {})
    assert.equal(nodes(missing, node => is(node, "td") && text(node) === "—").length, 9)
    assert.ok(!text(missing).includes("$0"))
    const meta = { mode: "fix", model: "gpt-test", effort: "high", provider: "codex", usage } as RunSummary
    const facts = text(h.render(RunFacts, { meta }))
    assert.ok(facts.includes("—"))
    assert.ok(!facts.includes("$0"))
    assert.ok(!facts.includes("≥"))
  } finally { h.cleanup(); env.cleanup() }
})

for (const saved of [false, true]) test(`${saved ? "saved" : "live"} run page displays its phase record`, async () => {
  const env = browser()
  const h = harness()
  const originalFetch = globalThis.fetch
  const originalEventSource = globalThis.EventSource
  let stream: any
  globalThis.EventSource = class {
    constructor() { stream = this }
    close() {}
  } as unknown as typeof EventSource
  const meta = { runId: "fixture", runNumber: 1, mode: "fix", status: saved ? "completed" : "scanning",
    repoUrl: "local:/fixture", phaseUsage, usage } as RunSummary
  globalThis.fetch = (async input => String(input).endsWith("/fixture") ? Response.json(meta) : new Response(null, { status: 404 })) as typeof fetch
  try {
    const component = saved ? RunDetailPage : RunPage
    const props = { runId: "fixture", mode: "fix" as const, onBack() {}, onResumed() {} }
    h.render(component, props)
    await h.flush()
    const view = h.render(component, props)
    assert.deepEqual(nodes(view, node => node.type === RunUsage)[0].props.usage, phaseUsage)
    assert.deepEqual(nodes(view, node => node.type === RunFacts)[0].props.usage ?? meta.usage, usage)
    if (!saved) {
      stream.onopen()
      for (const [phase, usage] of Object.entries(phaseUsage)) {
        stream.onmessage({ data: JSON.stringify({ type: "usage_delta", phase, usage }) })
      }
      const updated = h.render(component, props)
      assert.deepEqual(nodes(updated, node => node.type === RunUsage)[0].props.usage, phaseUsage)
      assert.equal(nodes(updated, node => node.type === RunFacts)[0].props.usage.inputTokens, 7500)
    }
  } finally { h.cleanup(); globalThis.fetch = originalFetch; globalThis.EventSource = originalEventSource; env.cleanup() }
})

for (const provider of ["qoder", "claude"] as const) test(`Qoder usage shows credits when ${provider} is the main provider`, () => {
  const env = browser("/run/fixture", { ola_lang: "en" })
  const h = harness()
  try {
    const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 }
    const runUsage = provider === "qoder" ? { ...zero, credits: 1.844 } : { ...usage, credits: 0.5 }
    const facts = text(h.render(RunFacts, { meta: { mode: "fix", provider, reviewProvider: "qoder", model: "Qwen3.8-Flash", effort: "medium", usage: runUsage } as RunSummary }))
    if (provider === "qoder") {
      assert.match(facts, /1\.84 credits/)
      assert.ok(!facts.includes("tokens") && !facts.includes("effort"))
    } else assert.match(facts, /13\.3k tokens · 0\.50 credits/)
    assert.ok(!facts.includes("$"))
    const empty = text(h.render(RunFacts, { meta: { mode: "scan", provider: "qoder", model: "Qwen3.8-Flash", usage: zero } as RunSummary }))
    assert.match(empty, /— credits/)
    const table = h.render(RunUsage, { usage: { fix: { ...zero, credits: 1.5 }, review: undefined } })
    assert.deepEqual(nodes(table, node => is(node, "td")).map(cell => text(cell)), ["0", "0", "0", "1.50", "—", "—", "—", "—", "—", "—", "—", "—"])
  } finally { h.cleanup(); env.cleanup() }
})

test("live usage deltas add up Qoder credits", () => {
  let state = buildInitialRunState("scan")
  for (const credits of [0.25, 0.5]) state = reduceRunEvent(state, { type: "usage_delta", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, credits } })
  assert.equal(state.usage.credits, 0.75)
})

for (const flag of ["partialUsage", "partial_usage"]) test(`saved legacy ${flag} usage remains a lower bound`, () => {
  const env = browser("/run/fixture", { ola_lang: "en" })
  const h = harness()
  const meta = JSON.parse(JSON.stringify({ runId: "legacy", mode: "fix", status: "completed", provider: "codex",
    usage: { ...usage, [flag]: true }, phaseUsage: { fix: { ...usage, [flag]: true } } })) as RunSummary
  try {
    const facts = h.render(RunFacts, { meta })
    assert.match(text(facts), /≥ 13\.3k/)
    assert.ok(nodes(facts, node => typeof node.props.title === "string" && node.props.title.includes("last request")).length)
    const table = h.render(RunUsage, { usage: meta.phaseUsage })
    assert.deepEqual(nodes(table, node => is(node, "td")).slice(0, 3).map(text), ["≥ 2500*", "≥ 10000*", "≥ 750*"])
    assert.equal(nodes(table, node => node.type === "span" && node.props.title?.includes("last request")).length, 3)
  } finally { h.cleanup(); env.cleanup() }
})

for (const legacy of [true, false]) for (const flag of ["partialUsage", "partial_usage"]) test(`replayed ${legacy ? "legacy" : "current"} ${flag} tokens display as partial`, async () => {
  const event = { type: "usage_delta", phase: "fix", usage: { ...usage, [flag]: true,
    ...(legacy ? { estCostUsd: 1, costPartial: true } : {}) } };
  let state = buildInitialRunState("fix");
  for await (const line of replayEvents(new Response(JSON.stringify(event) + "\n").body!)) {
    state = reduceRunEvent(state, JSON.parse(line));
  }
  const env = browser("/run/fixture", { ola_lang: "en" });
  const h = harness();
  try {
    const facts = h.render(RunFacts, { meta: { mode: "fix", provider: "codex" } as RunSummary, usage: state.usage });
    assert.match(text(facts), /≥ 13\.3k/);
    const table = h.render(RunUsage, { usage: state.phaseUsage });
    assert.deepEqual(nodes(table, node => is(node, "td")).slice(0, 3).map(text), ["≥ 2500*", "≥ 10000*", "≥ 750*"]);
  } finally { h.cleanup(); env.cleanup() }
});
