import { useEffect, useState } from "react";

const KEY = "ola_last_run";

// The last run the dev started or opened. It lives in the browser, so the Run tab can still open the
// run after it ends. `latest` is the run on screen, else the newest active one.
export function useLastRun(latest: string | undefined): string | undefined {
  const [last, setLast] = useState<string | undefined>(() => {
    try { return localStorage.getItem(KEY) ?? undefined; } catch { return undefined; }
  });
  useEffect(() => {
    if (!latest || latest === last) return;
    setLast(latest);
    try { localStorage.setItem(KEY, latest); } catch { /* storage blocked: the tab forgets the run on reload */ }
  }, [latest]);
  return latest ?? last;
}
