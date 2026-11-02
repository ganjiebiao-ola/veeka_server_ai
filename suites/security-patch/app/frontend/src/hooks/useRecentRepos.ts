import { useEffect, useRef, useState } from "react";
import type { ProfileOverride, RepoProfile } from "../../../shared/types";
import { useI18n } from "../i18n"

export function repoKey(value: string): string {
  const match = /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(value.trim())
  return match && !/^\.+$/.test(match[1]) && !/^\.+$/.test(match[2]) ? `${match[1]}/${match[2]}`.toLowerCase() : value.trim().toLowerCase().replace(/\/+$/, "")
}

export interface RecentRepo { url: string; branch: string; profile?: RepoProfile | null; override?: ProfileOverride | null }

async function fetchRepos(): Promise<RecentRepo[]> {
  const response = await fetch("/api/repos")
  if (!response.ok) throw new Error(String(response.status))
  return (await response.json() as { repos: RecentRepo[] }).repos
}

// Repos the server remembers from past run starts, newest first. The server adds them itself.
// The commit SHA is not kept: it changes every scan.
export function useRecentRepos() {
  const { t } = useI18n()
  const [repos, setRepos] = useState<RecentRepo[]>([]);
  const [error, setError] = useState("")
  const [loadStatus, setLoadStatus] = useState<"loading" | "error" | "done">("loading")
  const [removing, setRemoving] = useState(false)
  const removingRef = useRef(false)
  const [detecting, setDetecting] = useState<string[]>([])
  useEffect(() => {
    let alive = true;
    fetchRepos()
      .then((repos) => { if (alive) { setRepos(repos); setLoadStatus("done") } })
      .catch((e) => { if (alive) { setError(t("repo.load_failed", { msg: (e as Error).message })); setLoadStatus("error") } });
    return () => { alive = false; };
  }, []);
  return {
    repos,
    error,
    loadStatus,
    removing,
    reload: async () => { setRepos(await fetchRepos()); setError(""); setLoadStatus("done") },
    detecting,
    // An added repo's profile, before its first scan. A failure leaves it null.
    detect: async (url: string) => {
      setDetecting(list => [...list, url])
      try {
        const res = await fetch("/api/repos/detect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) })
        const profile = res.ok ? (await res.json() as { profile: RepoProfile | null }).profile : null
        if (profile) setRepos(list => list.map(r => r.url === url ? { ...r, profile } : r))
      } catch { /* the first scan detects it */ }
      finally { setDetecting(list => list.filter(u => u !== url)) }
    },
    forget: async (url: string) => {
      if (removingRef.current) return
      removingRef.current = true
      setRemoving(true)
      setError("")
      try {
        const res = await fetch(`/api/repos?url=${encodeURIComponent(url)}`, { method: "DELETE" })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        setRepos(list => list.filter(r => r.url !== url))
      } catch (e) { setError(t("repo.remove_failed", { msg: (e as Error).message })) }
      finally { removingRef.current = false; setRemoving(false) }
    },
    // The Scan page saved a new PHP version or framework. An empty override clears it.
    setOverride: (url: string, override: ProfileOverride) =>
      setRepos((list) => list.map((r) => r.url === url ? { ...r, override: override.php || override.framework ? override : null } : r)),
  };
}
