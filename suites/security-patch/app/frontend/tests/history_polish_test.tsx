import { test } from "bun:test";
import assert from "node:assert/strict";
import { HistoryPage } from "../src/pages/HistoryPage";
import { Tabs, TabsTrigger } from "../src/components/ui/tabs";
import { PaginationContent, PaginationEllipsis, PaginationItem } from "../src/components/ui/pagination";
import { browser, harness, nodes, text, is } from "./render";

const run = { runId: "run-1", runNumber: 215, mode: "fix", status: "completed", starred: false,
  provider: "claude", reviewProvider: "codex", reviewModel: "gpt-6.1-sol", reviewEffort: "xhigh", repoUrl: "https://github.com/a/b", model: "sonnet", effort: "high" };

test("History requests numbered pages, sizes and filters on the server and reloads after starring", async () => {
  const b = browser("/history");
  const original = globalThis.fetch;
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  let starred = false;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    calls.push({ url, init });
    if (init?.method === "PATCH") {
      starred = JSON.parse(String(init.body)).starred;
      return Response.json({ starred });
    }
    return Response.json({ total: 215, runs: [{ ...run, mode: url.searchParams.get("mode") || "fix", starred }] });
  }) as typeof fetch;
  const h = harness();
  const props = { onOpenRun() {} };
  const render = () => h.render(HistoryPage, props);
  const button = (label: string) => nodes(render(), node => is(node, "button") && text(node) === label)[0];
  const choose = async (index: number, value: string) => {
    nodes(render(), node => is(node, "select"))[index].props.onChange({ target: { value } });
    render(); await h.flush(); render();
  };
  try {
    render(); await h.flush(); let view = render();
    assert.equal(calls[0].url.search, "?limit=10&offset=0");
    assert.match(text(view), /Page 1 of 22/);
    assert.match(text(view), /Review: Codex · gpt-6.1-sol · Extra high/);
    const cells = nodes(view, node => is(node, "td"));
    assert(cells.every(cell => cell.props["data-label"]));
    assert(!nodes(view, node => is(node, "th")).some(node => text(node) === "Effort" || text(node) === "Scope"));
    nodes(render(), node => is(node, "button") && node.props["aria-label"] === "Next")[0].props.onClick(); render(); await h.flush(); view = render();
    assert.equal(calls.at(-1)!.url.searchParams.get("offset"), "10");
    assert.match(text(view), /Page 2 of 22/);
    const page3 = nodes(view, node => is(node, "button") && node.props["aria-label"] === "Page 3 of 22")[0];
    page3.props.onClick(); render(); await h.flush(); render();
    assert.equal(calls.at(-1)!.url.searchParams.get("offset"), "20");
    for (const size of ["50", "100", "10"]) {
      await choose(2, size);
      assert.equal(calls.at(-1)!.url.searchParams.get("limit"), size);
      assert.equal(calls.at(-1)!.url.searchParams.get("offset"), "0");
    }
    const statuses = nodes(nodes(render(), node => is(node, "select"))[0], node => node.type === "option");
    assert.equal(text(statuses.find(node => node.props.value === "scanning")), "Running");
    assert(!statuses.some(node => ["Scanning", "Fixing", "Reviewing", "Checks"].includes(text(node))));
    await choose(0, "scanning");
    assert.equal(calls.at(-1)!.url.searchParams.get("status"), "scanning");
    assert.equal(calls.at(-1)!.url.searchParams.has("mode"), false);
    await choose(0, "completed"); await choose(1, "scan");
    assert.equal(calls.at(-1)!.url.searchParams.get("status"), "completed");
    assert.equal(calls.at(-1)!.url.searchParams.get("mode"), "scan");
    assert(nodes(render(), node => is(node, "th")).some(node => text(node) === "Scope"));
    assert(nodes(render(), node => node.type === TabsTrigger).some(node => node.props.value === "starred" && text(node) === "Starred"));
    nodes(render(), node => node.type === Tabs)[0].props.onValueChange("starred"); render(); await h.flush(); render();
    assert.equal(calls.at(-1)!.url.searchParams.get("starred"), "1");
    const star = nodes(render(), node => is(node, "button") && node.props["aria-label"] === "Star run 215")[0];
    star.props.onClick(); await h.flush(); view = render();
    const mutation = calls.find(call => call.init?.method === "PATCH")!;
    assert.equal(mutation.url.pathname, "/api/runs/run-1");
    assert.equal(mutation.init?.body, '{"starred":true}');
    assert.equal(nodes(view, node => is(node, "button") && node.props["aria-label"] === "Unstar run 215")[0].props["aria-pressed"], true);
  } finally { h.cleanup(); globalThis.fetch = original; b.cleanup(); }
});

test("History announces star errors and ignores stale page responses", async () => {
  const b = browser("/history");
  const original = globalThis.fetch;
  const pending: Array<(r: Response) => void> = [];
  globalThis.fetch = ((input: any, init?: RequestInit) => init?.method === "PATCH"
    ? Promise.resolve(new Response(null, { status: 503 }))
    : new Promise<Response>(resolve => pending.push(resolve))) as typeof fetch;
  const h = harness();
  const props = { onOpenRun() {} };
  const render = () => h.render(HistoryPage, props);
  try {
    assert.equal(nodes(render(), node => node.props.role === "status").length, 0);
    await h.flush();
    assert.match(text(render()), /Loading/);
    nodes(render(), node => is(node, "select"))[1].props.onChange({ target: { value: "scan" } });
    render(); await h.flush();
    pending[1](Response.json({ total: 1, runs: [{ ...run, runId: "new", mode: "scan" }] }));
    await h.flush();
    pending[0](Response.json({ total: 1, runs: [{ ...run, runId: "stale" }] }));
    await h.flush();
    let view = render();
    assert.equal(nodes(view, node => node.type === "a")[0].props.href, "/runs/new");
    nodes(view, node => is(node, "button") && node.props["aria-label"] === "Star run 215")[0].props.onClick();
    await h.flush(); view = render();
    assert.match(text(nodes(view, node => node.props.role === "alert")[0]), /503/);
    assert.equal(nodes(view, node => is(node, "button") && node.props["aria-label"] === "Star run 215")[0].props.disabled, false);
  } finally { h.cleanup(); globalThis.fetch = original; b.cleanup(); }
});

test("History shows Qoder usage in credits without effort", async () => {
  const b = browser("/history");
  const original = globalThis.fetch;
  const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
  globalThis.fetch = (async (_input: any) => Response.json({ total: 2, runs: [
    { ...run, runId: "q", runNumber: 2, mode: "scan", provider: "qoder", model: "Qwen3.8-Flash", effort: "medium", usage: { ...zero, credits: 1.844 } },
    { ...run, runId: "c", runNumber: 1, reviewProvider: "qoder", usage: { ...zero, inputTokens: 1200, credits: 0.5 } },
  ] })) as typeof fetch;
  const h = harness();
  try {
    h.render(HistoryPage, { onOpenRun() {} }); await h.flush();
    const cells = nodes(h.render(HistoryPage, { onOpenRun() {} }), node => is(node, "td") && node.props["data-label"] === "Tokens").map(text);
    assert.deepEqual(cells, ["1.84 credits", "1.2k · 0.50 credits"]);
    const models = nodes(h.render(HistoryPage, { onOpenRun() {} }), node => is(node, "td") && node.props["data-label"] === "Model").map(text);
    assert.ok(!models[0].includes("Medium") && !models[0].includes("medium"), models[0]);
  } finally { h.cleanup(); b.cleanup(); globalThis.fetch = original; }
});

test("History pager windows pages with ellipses, stays usable while loading, resets the scroll and jumps with Go to", async () => {
  const b = browser("/history");
  const original = globalThis.fetch;
  const originalMedia = globalThis.matchMedia;
  let narrow = false;
  globalThis.matchMedia = (() => ({ matches: narrow, addEventListener() {}, removeEventListener() {} })) as any;
  const pending: Array<{ url: URL; resolve: (r: Response) => void }> = [];
  globalThis.fetch = ((input: any) => new Promise<Response>(resolve => pending.push({ url: new URL(String(input), "http://localhost"), resolve }))) as typeof fetch;
  const answer = async (total: number) => { pending.at(-1)!.resolve(Response.json({ total, runs: total ? [run] : [] })); await h.flush(); };
  const h = harness();
  const props = { onOpenRun() {} };
  const render = () => h.render(HistoryPage, props);
  const items = () => nodes(nodes(render(), node => node.type === PaginationContent)[0], node => node.type === PaginationItem).map(item => {
    if (nodes(item, node => node.type === PaginationEllipsis).length) return "…";
    const button = nodes(item, node => is(node, "button"))[0];
    return (text(button) || button.props["aria-label"]) + (button.props["aria-current"] ? "*" : "") + (button.props.disabled ? "(off)" : "");
  });
  const goTo = async (value: string) => {
    nodes(render(), node => is(node, "input") && node.props.type === "number")[0].props.onKeyDown({ key: "Enter", currentTarget: { value } });
    render(); await h.flush();
  };
  const offset = () => pending.at(-1)!.url.searchParams.get("offset");
  try {
    render(); await h.flush(); await answer(390);
    assert.deepEqual(items(), ["Previous(off)", "1*", "2", "3", "4", "5", "…", "39", "Next"]);
    assert.deepEqual(nodes(nodes(render(), node => is(node, "select") && node.props["aria-label"] === "Runs per page")[0], node => node.type === "option").map(text), ["10 / page", "50 / page", "100 / page"]);
    const scroller = (nodes(render(), node => node.props["aria-busy"] !== undefined)[0] as any).ref;
    let intoView = 0;
    scroller.current = { scrollTop: 900, getBoundingClientRect: () => ({ top: -40 }), scrollIntoView: () => intoView++ };
    await goTo("17");
    assert.equal(offset(), "160");
    assert.equal(scroller.current.scrollTop, 0);
    assert.equal(intoView, 1);
    // The old rows stay on screen without a loading line that would shift the pager under the pointer.
    assert.doesNotMatch(text(render()), /Loading/);
    assert.deepEqual(items(), ["Previous", "1", "…", "16", "17*", "18", "…", "39", "Next"]);
    await answer(390);
    await goTo("999");
    assert.equal(offset(), "380");
    await answer(390);
    assert.deepEqual(items(), ["Previous", "1", "…", "35", "36", "37", "38", "39*", "Next(off)"]);
    const requests = pending.length;
    await goTo("abc"); await goTo("");
    assert.equal(pending.length, requests);
    await goTo("0");
    assert.equal(offset(), "0");
    await answer(390);
    narrow = true;
    h.cleanup(); h.replayEffects(); render(); await h.flush(); await answer(390);
    await goTo("17"); await answer(390);
    assert.deepEqual(items(), ["Previous", "1", "…", "17*", "…", "39", "Next"]);
    nodes(render(), node => is(node, "select"))[0].props.onChange({ target: { value: "failed" } });
    render(); await h.flush(); await answer(0);
    assert.equal(nodes(render(), node => node.type === PaginationContent).length, 0);
  } finally { h.cleanup(); globalThis.fetch = original; globalThis.matchMedia = originalMedia; b.cleanup(); }
});

test("History moves back a page when unstarring the last row on the Starred tab's last page", async () => {
  const b = browser("/history");
  const original = globalThis.fetch;
  const calls: URL[] = [];
  let starred = 11;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    if (init?.method === "PATCH") { starred--; return Response.json({ starred: false }); }
    const url = new URL(String(input), "http://localhost");
    calls.push(url);
    const offset = Number(url.searchParams.get("offset"));
    return Response.json({ total: starred, runs: offset < starred ? [{ ...run, starred: true }] : [] });
  }) as typeof fetch;
  const h = harness();
  const props = { onOpenRun() {} };
  const render = () => h.render(HistoryPage, props);
  try {
    render(); await h.flush();
    nodes(render(), node => node.type === Tabs)[0].props.onValueChange("starred"); render(); await h.flush();
    nodes(render(), node => is(node, "button") && node.props["aria-label"] === "Next")[0].props.onClick(); render(); await h.flush();
    assert.equal(calls.at(-1)!.searchParams.get("offset"), "10");
    nodes(render(), node => is(node, "button") && node.props["aria-label"] === "Unstar run 215")[0].props.onClick();
    await h.flush(); render(); await h.flush();
    assert.equal(calls.at(-1)!.searchParams.get("offset"), "0");
    assert.match(text(render()), /Page 1 of 1/);
  } finally { h.cleanup(); globalThis.fetch = original; b.cleanup(); }
});
