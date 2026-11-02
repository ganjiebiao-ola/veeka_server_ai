import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "ola-agent.sessionId";

export function useSession(): { sessionId: string | null; error: string | null } {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<Promise<string> | null>(null)

  useEffect(() => {
    let cancelled = false;
    // Effect replay must share the request and attach a fresh, uncancelled listener.
    if (!pending.current) pending.current = (async () => {
      let cached: string | null = null
      try { cached = localStorage.getItem(STORAGE_KEY) } catch { /* storage blocked */ }
      if (cached) {
        // Touch last_seen_at on the server side; if the server has no record
        // (DB wiped) re-register a fresh session.
        const r = await fetch(`/api/sessions/${encodeURIComponent(cached)}/refresh`);
        if (r.ok) {
          return cached
        }
      }
      const r = await fetch("/api/sessions", { method: "POST" });
      if (!r.ok) throw new Error(`session bootstrap failed: ${r.status}`);
      const { sessionId: sid } = await r.json() as { sessionId: string };
      try { localStorage.setItem(STORAGE_KEY, sid) } catch { /* keep the session in this tab */ }
      return sid
    })().finally(() => { pending.current = null })
    pending.current.then(sid => { if (!cancelled) setSessionId(sid) })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true; };
  }, []);

  return { sessionId, error };
}
