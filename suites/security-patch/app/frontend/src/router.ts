import { useEffect, useState } from "react";

// Real URLs without a router dependency: the app has five flat paths and no nested layouts.
export function navigate(path: string) {
  if (path !== location.pathname) history.pushState(null, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const sync = () => setPath(location.pathname);
    addEventListener("popstate", sync);
    return () => removeEventListener("popstate", sync);
  }, []);
  return path;
}

// The repo a page works on lives in the URL (?repo=owner/name), so a link keeps it. Null means the server default.
// The last repo is also kept for this tab, so Pick and Overview keep it when the dev switches tabs.
const LAST_REPO = "secpatch.repo";
function remember(repo: string | null): string | null {
  try { if (repo) sessionStorage.setItem(LAST_REPO, repo); else return sessionStorage.getItem(LAST_REPO); } catch { /* storage blocked */ }
  return repo;
}
export function useRepoParam(): [string | null, (repo: string) => void] {
  const read = () => remember(new URLSearchParams(location.search).get("repo"));
  const [repo, setRepo] = useState(read);
  useEffect(() => {
    const sync = () => setRepo(read());
    addEventListener("popstate", sync);
    return () => removeEventListener("popstate", sync);
  }, []);
  const choose = (next: string) => {
    history.replaceState(null, "", `${location.pathname}?repo=${encodeURIComponent(next)}`);
    remember(next);
    setRepo(next);
  };
  return [repo, choose];
}
