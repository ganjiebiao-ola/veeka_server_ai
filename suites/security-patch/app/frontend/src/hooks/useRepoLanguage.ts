import { useEffect, useState } from "react";
import type { RepoLanguage } from "../../../shared/types";

export function useRepoLanguage(url: string) {
  const [result, setResult] = useState<{ url: string; status: "error" | "done"; data: (RepoLanguage & { language: string }) | null } | null>(null);
  useEffect(() => {
    let alive = true;
    setResult(null);
    if (!/^https?:\/\/github\.com\/[^/?#]+\/[^/?#]+\/?$/i.test(url)) return;
    const timer = setTimeout(() => {
      fetch(`/api/repos/language?url=${encodeURIComponent(url)}`)
        .then((r) => r.ok ? r.json() : Promise.reject())
        .then((data: RepoLanguage) => { if (alive) setResult({ url, status: "done", data: data?.language ? { ...data, language: data.language } : null }); })
        .catch(() => { if (alive) setResult({ url, status: "error", data: null }); });
    }, 400);
    return () => { alive = false; clearTimeout(timer); };
  }, [url]);
  if (!/^https?:\/\/github\.com\/[^/?#]+\/[^/?#]+\/?$/i.test(url)) return { status: "done" as const, data: null };
  return result?.url === url ? result : { status: "loading" as const, data: null };
}
