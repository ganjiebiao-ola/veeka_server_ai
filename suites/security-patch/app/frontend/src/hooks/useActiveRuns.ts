import { useEffect, useState } from "react";

// Fire this after a run starts or stops, so the Run tab updates now, not at the next 4 s check.
export const RUNS_CHANGED = "ola-runs-changed";

export interface ActiveRun { runId: string; status: string; repoUrl: string; mode: string; phase?: "fix" | "review" | "checks" }

// Runs still going, from the server, newest first. It re-checks on every page change and every 4 s.
// The server is the source of truth, so every browser tab agrees.
export function useActiveRuns(path: string): ActiveRun[] {
  const [runs, setRuns] = useState<ActiveRun[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/runs/active")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((body: { runs: ActiveRun[] }) => { if (alive) setRuns(body.runs); })
        .catch(() => {});
    load();
    const id = setInterval(() => { if (!document.hidden) load(); }, 4000);
    addEventListener(RUNS_CHANGED, load);
    return () => { alive = false; clearInterval(id); removeEventListener(RUNS_CHANGED, load); };
  }, [path]);
  return runs;
}
