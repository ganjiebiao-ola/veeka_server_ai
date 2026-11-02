import { lazy, Suspense } from "react";
import { PickPage } from "./pages/PickPage";
import { OverviewPage } from "./pages/OverviewPage";
import { NavBar } from "./components/NavBar";
import type { NavTarget } from "./components/NavBar";
import { LandingPage } from "./pages/LandingPage";
import { useSession } from "./hooks/useSession";
import { navigate, usePath } from "./router";
import { useActiveRuns } from "./hooks/useActiveRuns";
import { useLastRun } from "./hooks/useLastRun";
import type { StartRunRequest, StartRunResponse } from "./types/events";
import { useI18n } from "./i18n";
import { Skeleton } from "@/components/ui/skeleton";

// Run and history pages carry the markdown renderer, which the other pages do not need up front.
const RunRoute = lazy(() => import("./pages/RunRoute").then(m => ({ default: m.RunRoute })));
const HistoryPage = lazy(() => import("./pages/HistoryPage").then(m => ({ default: m.HistoryPage })));

const PATHS: Record<Exclude<NavTarget, "run">, string> = { landing: "/", pick: "/pick", overview: "/overview", history: "/history" };

export function App() {
  const { t } = useI18n();
  const { sessionId, error: sessionError } = useSession();
  const path = usePath();
  const activeRuns = useActiveRuns(path);
  const viewing = /^\/runs\/([^/]+)\/?$/.exec(path)?.[1];
  const runId = useLastRun(viewing ? decodeURIComponent(viewing) : activeRuns[0]?.runId);

  if (sessionError) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-2 px-4 py-16 text-center">
        <h1 className="text-xl font-semibold text-red-700 dark:text-red-400">{t("app.session_error")}</h1>
        <p className="[overflow-wrap:anywhere]">{sessionError}</p>
        <p className="text-muted-foreground">{t("app.session_hint")}</p>
      </div>
    );
  }
  if (!sessionId) return <div className="px-4 py-16 text-center text-muted-foreground">{t("app.starting")}</div>;

  const sid = sessionId;
  // The Run tab opens the run on screen, else the newest active run, else the last one the dev opened.
  // It has a dot only while that run is live.
  const current: NavTarget | undefined = viewing
    ? "run"
    : (Object.keys(PATHS) as Array<keyof typeof PATHS>).find(k => PATHS[k] === path);
  return <>
    <NavBar
      current={current}
      run={runId ? { live: activeRuns.some(r => r.runId === runId) } : undefined}
      go={(target: NavTarget) => navigate(target === "run" ? `/runs/${encodeURIComponent(runId!)}` : PATHS[target])}
    />
    <Suspense fallback={<Skeleton aria-hidden="true" className="mx-auto mt-6 h-96 max-w-[1760px] rounded-xl" />}>{page()}</Suspense>
  </>;

  function page() {
    const run = /^\/runs\/([^/]+)\/?$/.exec(path);
    if (run) return <RunRoute key={run[1]} runId={decodeURIComponent(run[1])} />;
    switch (path.replace(/\/$/, "")) {
      case "/overview":
        return <OverviewPage />;
      case "/pick":
        return <PickPage sessionId={sid} activeRuns={activeRuns} onStarted={runId => navigate(`/runs/${encodeURIComponent(runId)}`)} />;
      case "/history":
        return (
          <HistoryPage onOpenRun={(runId) => navigate(`/runs/${encodeURIComponent(runId)}`)} />
        );
      default:
        return (
          <LandingPage
            sessionId={sid}
            activeRuns={activeRuns}
            startRun={startRun}
            onStarted={(runId) => navigate(`/runs/${encodeURIComponent(runId)}`)}
          />
        );
    }
  }
}

async function startRun(req: StartRunRequest): Promise<StartRunResponse> {
  const r = await fetch("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    let msg = `HTTP ${r.status}`;
    try {
      const j = JSON.parse(body) as { error?: string };
      if (j.error) msg = j.error;
    } catch { /* not JSON */ }
    throw new Error(msg);
  }
  return await r.json() as StartRunResponse;
}
