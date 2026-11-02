import { test } from "bun:test";
import assert from "node:assert/strict";
import { RunOutcome } from "../src/components/RunOutcome";
import { RunStatusLabel } from "../src/components/RunStatusLabel";
import { RunFacts } from "../src/components/RunFacts";
import { TopBar } from "../src/components/TopBar";
import { RunRoute } from "../src/pages/RunRoute";
import { useI18n } from "../src/i18n";
import { NavBar } from "../src/components/NavBar";
import { RunPage } from "../src/pages/RunPage";
import { RunDetailPage } from "../src/pages/RunDetailPage";
import { LandingPage } from "../src/pages/LandingPage";
import { PickPage } from "../src/pages/PickPage";
import { ProviderSelect } from "../src/components/ProviderSelect";
import { Collapsible } from "../src/components/ui/collapsible";
import { buildInitialRunState, reduceRunEvent } from "../src/hooks/useRunEvents";
import { browser, harness, markup, nodes, text, is } from "./render";
import type { RunSummary } from "../src/types/events";

const meta: RunSummary = { runId: "run-1", runNumber: 1, sessionId: "s", repoUrl: "https://github.com/a/b", branch: "main",
  skill: "ola-security-audit", mode: "scan", status: "completed", model: "sonnet", effort: "high" };
const noResume = () => {};

for (const lang of ["en", "zh"] as const) {
  test(`mode and phase status labels, outcomes and review provider in ${lang}`, () => {
    const b = browser("/", { ola_lang: lang });
    try {
      const cases = [
        { mode: "scan", phase: undefined, expected: lang === "en" ? "Scanning" : "扫描中" },
        { mode: "fix", phase: undefined, expected: lang === "en" ? "Fixing" : "修复中" },
        { mode: "fix", phase: "review", expected: lang === "en" ? "Reviewing" : "审查中" },
        { mode: "fix", phase: "checks", expected: lang === "en" ? "Checks" : "检查中" },
      ] as const;
      for (const row of cases) assert.equal(markup(<RunStatusLabel run={{ ...meta, ...row, status: "scanning" }} />), row.expected);
      assert.equal(markup(<RunStatusLabel run={{ ...meta, status: "stopped" }} />), lang === "en" ? "Paused (resumable)" : "已暂停（可继续）");
      assert.equal(markup(<RunStatusLabel run={{ ...meta, status: "aborted" }} />), lang === "en" ? "Cancelled" : "已取消");
      for (const reason of ["user_pause", "quota"] as const) {
        const html = markup(<RunOutcome meta={{ ...meta, status: "stopped", stopReason: reason }} onResumed={noResume} />);
        assert.match(html, reason === "quota" ? lang === "en" ? /provider quota/ : /配额用尽/ : lang === "en" ? /You paused/ : /你已暂停/);
      }
      const legacy = markup(<RunOutcome meta={{ ...meta, status: "stopped", error: "stopped at quota" }} onResumed={noResume} />);
      assert.match(legacy, lang === "en" ? /provider quota/ : /配额用尽/);
      const failed = markup(<RunOutcome meta={{ ...meta, status: "failed", error: "Connection lost <detail>" }} onResumed={noResume} />);
      assert.match(failed, /role="alert"/);
      assert.match(failed, lang === "en" ? /Run failed/ : /运行失败/);
      assert.match(failed, /Connection lost &lt;detail&gt;/);
      assert.match(markup(<RunOutcome meta={meta} onResumed={noResume} />), lang === "en" ? /Run completed/ : /运行完成/);
      assert.match(markup(<RunOutcome meta={{ ...meta, status: "aborted" }} onResumed={noResume} />), lang === "en" ? /You cancelled this run/ : /你已取消此运行/);
      assert.match(markup(<RunFacts meta={{ ...meta, mode: "fix", reviewProvider: "codex" }} />), lang === "en" ? /Review: Codex/ : /审查：Codex/);
      const roles = markup(<RunFacts meta={{ ...meta, mode: "fix", reviewProvider: "antigravity", reviewModel: "gemini-4-argon", reviewEffort: "low" }} />)
      assert.match(roles, /gemini-4-argon/)
      assert.match(roles, lang === "en" ? /Review: Antigravity · gemini-4-argon · Low/ : /审查：Antigravity · gemini-4-argon · 低/)
      const header = markup(<TopBar runId="run-1" status="scanning" mode="fix" onStop={() => {}} />);
      assert.match(header, lang === "en" ? /Fix runs cannot be paused/ : /修复运行无法暂停/);
      assert.match(header, lang === "en" ? /Cancel run/ : /取消运行/);
    } finally { b.cleanup(); }
  });
}

test("phase events update the live status without needing token usage", () => {
  let state = buildInitialRunState("fix");
  state = reduceRunEvent(state, { type: "run_phase", phase: "review" });
  assert.equal(state.phase, "review");
  state = reduceRunEvent(state, { type: "run_phase", phase: "checks" });
  assert.equal(state.phase, "checks");
});

for (const status of ["completed", "stopped", "aborted", "failed"] as const) {
  test(`live and saved ${status} runs use the same outcome component`, async () => {
    const b = browser();
    const original = globalThis.fetch;
    const run = { ...meta, status, stopReason: "quota", error: status === "failed" ? "Failed fixture" : undefined };
    globalThis.fetch = (async input => String(input) === "/api/runs/run-1" ? Response.json(run) : new Response(null, { status: 404 })) as typeof fetch;
    const h = harness();
    try {
      const liveProps = { runId: "run-1", mode: "scan" as const, onResumed: noResume };
      const savedProps = { runId: "run-1", onBack() {}, onResumed: noResume };
      h.render(RunPage, liveProps); h.render(RunDetailPage, savedProps);
      await h.flush();
      for (const view of [h.render(RunPage, liveProps), h.render(RunDetailPage, savedProps)]) {
        const outcome = nodes(view, node => node.type === RunOutcome)[0];
        assert(outcome);
        assert.equal(outcome.props.meta.status, status);
        assert.equal(outcome.props.meta.stopReason, "quota");
        assert.equal(outcome.props.meta.error, run.error);
      }
    } finally { h.cleanup(); globalThis.fetch = original; b.cleanup(); }
  });
}

for (const dev of [false, true]) {
  test(`Scan and Pick show developer controls only with health.dev=${dev}`, async () => {
    const b = browser();
    const original = globalThis.fetch;
    globalThis.fetch = (async input => {
      const url = String(input);
      if (url === "/api/health") return Response.json({ dev });
      if (url === "/api/providers") return Response.json({ claude: { available: true } });
      if (url === "/api/repos") return Response.json({ repos: [] });
      if (url === "/api/relay/models") return Response.json({ configured: false, models: [] });
      return Response.json({ repoUrl: "https://github.com/a/b", rows: [], hidden: [], suggestedIds: [] });
    }) as typeof fetch;
    const h = harness();
    try {
      const scanProps = { sessionId: "s", activeRuns: [], onStarted() {}, startRun: async () => ({ runId: "new", status: "queued" as const }) };
      const pickProps = { sessionId: "s", activeRuns: [], onStarted() {} };
      h.render(LandingPage, scanProps); h.render(PickPage, pickProps);
      await h.flush();
      const scan = h.render(LandingPage, scanProps);
      const pick = h.render(PickPage, pickProps);
      for (const view of [scan, pick]) assert.equal(/Smoke check/.test(text(view)), dev);
      assert.equal(nodes(scan, node => node.props.label === "Max subagents").length, dev ? 1 : 0);
      const advanced = nodes(pick, node => node.type === Collapsible && /Fix run settings/.test(text(node)))[0];
      assert(advanced);
      assert(!advanced.props.open);
      assert.equal(nodes(advanced, node => node.type === ProviderSelect).length, 2);
    } finally { h.cleanup(); globalThis.fetch = original; b.cleanup(); }
  });
}

for (const dependency of ["repos", "providers", "language"] as const) {
  test(`Start explains pending ${dependency}`, async () => {
    const b = browser();
    const original = globalThis.fetch;
    let finish: (response: Response) => void = () => {};
    globalThis.fetch = (async input => {
      const url = String(input);
      if (url === `/api/${dependency}` || dependency === "language" && url.startsWith("/api/repos/language")) return new Promise<Response>(resolve => { finish = resolve; });
      if (url === "/api/repos") return Response.json({ repos: [{ url: meta.repoUrl, branch: "main" }] });
      if (url === "/api/providers") return Response.json({ claude: { available: true } });
      return Response.json({ configured: false, models: [] });
    }) as typeof fetch;
    const h = harness();
    const props = { sessionId: "s", activeRuns: [], onStarted() {}, startRun: async () => ({ runId: "new", status: "queued" as const }) };
    try {
      h.render(LandingPage, props); await h.flush();
      let view = h.render(LandingPage, props); await h.flush();
      view = h.render(LandingPage, props);
      const reason = nodes(view, node => node.props.id === "start-blocked")[0];
      assert(reason);
      assert.match(text(reason), dependency === "repos" ? /Loading repositories/ : dependency === "providers" ? /Loading providers/ : /Detecting repository language/);
      assert.equal(reason.props.role, "status");
      const start = nodes(view, node => is(node, "button") && text(node) === "Start scan")[0];
      assert.equal(start.props.disabled, true);
      assert.equal(start.props["aria-describedby"], "start-blocked");
    } finally { finish(Response.json({ repos: [], language: "PHP" })); h.cleanup(); globalThis.fetch = original; b.cleanup(); }
  });
}

test("Start explains an empty relay model list", async () => {
  const b = browser();
  const original = globalThis.fetch;
  globalThis.fetch = (async input => String(input) === "/api/repos" ? Response.json({ repos: [{ url: meta.repoUrl, branch: "main" }] })
    : String(input) === "/api/providers" ? Response.json({ claude: { available: true } })
    : Response.json({ configured: true, models: [] })) as typeof fetch;
  const h = harness();
  const props = { sessionId: "s", activeRuns: [], onStarted() {}, startRun: async () => ({ runId: "new", status: "queued" as const }) };
  try {
    h.render(LandingPage, props); await h.flush();
    let view = h.render(LandingPage, props);
    nodes(view, node => is(node, "select") && node.props.id === "recent-repo")[0].props.onChange({ target: { value: meta.repoUrl } });
    h.render(LandingPage, props); await h.flush();
    await new Promise(resolve => setTimeout(resolve, 420));
    view = h.render(LandingPage, props);
    nodes(view, node => node.type === ProviderSelect)[0].props.onChange("litellm");
    view = h.render(LandingPage, props);
    assert.match(text(nodes(view, node => node.props.id === "start-blocked")[0]), /No relay models/);
  } finally { h.cleanup(); globalThis.fetch = original; b.cleanup(); }
});

test("navigation labels its language group and hides the decorative brand", () => {
  const b = browser();
  try {
    const html = markup(<NavBar go={() => {}} />);
    assert.match(html, /role="group" aria-label="Language"/);
    assert.match(html, /aria-hidden="true">🛠️/);
  } finally { b.cleanup(); }
});

for (const lang of ["en", "zh"] as const) {
  test(`operator wording is consistent in ${lang}`, () => {
    const b = browser("/", { ola_lang: lang });
    const h = harness();
    function Strings() {
      const { t } = useI18n();
      return Object.fromEntries(["nav.run", "detail.post_hint", "finding_status.in progress", "overview.in_progress_hint", "keys.save_failed", "keys.openai", "landing.title", "landing.subtitle"].map(key => [key, t(key)]));
    }
    try {
      const strings = h.render(Strings, {});
      assert(!strings["landing.subtitle"].includes(strings["landing.title"]));
      assert.doesNotMatch(strings["keys.save_failed"], /characters|字母|字符/);
      if (lang === "zh") {
        assert.equal(strings["nav.run"], "运行");
        assert.match(strings["detail.post_hint"], /批量选修/);
        assert.doesNotMatch(strings["detail.post_hint"], /Pick/);
        assert.match(strings["keys.openai"], /（Codex）/);
      } else {
        assert.equal(strings["finding_status.in progress"], "In progress");
        assert.match(strings["overview.in_progress_hint"], /^In progress:/);
      }
    } finally { h.cleanup(); b.cleanup(); }
  });
}

test("loading run routes, saved runs and Pick announce their status", async () => {
  const b = browser();
  const h = harness();
  const original = globalThis.fetch;
  globalThis.fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  try {
    const route = h.render(RunRoute, { runId: "r" });
    const saved = h.render(RunDetailPage, { runId: "r", onBack() {}, onResumed: noResume });
    const pickProps = { sessionId: "s", activeRuns: [], onStarted() {} };
    h.render(PickPage, pickProps);
    await h.flush();
    const pick = h.render(PickPage, pickProps);
    for (const view of [route, saved, pick]) {
      assert(nodes(view, node => node.props.role === "status" && /Loading/.test(text(node))).length > 0);
    }
  } finally { h.cleanup(); globalThis.fetch = original; b.cleanup(); }
});
