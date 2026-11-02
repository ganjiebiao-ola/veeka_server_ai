import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { ConfirmDialog } from "./ConfirmDialog"
import { Button } from "@/components/ui/button"
import { NativeSelect } from "@/components/ui/native-select"

// Lists the repos the server knows, and removes one the dev no longer wants.
// It sits in the page header, so it has no visible label.
export function TrackerSelect(props: { value: string | null; onChange: (repo: string) => void }) {
  const { t } = useI18n();
  const [list, setList] = useState<{ repos: string[]; removable: string[] }>({ repos: [], removable: [] });
  const [error, setError] = useState("")
  const [removing, setRemoving] = useState(false)
  const removingRef = useRef(false)
  const [removeRepo, setRemoveRepo] = useState<string | null>(null)
  const load = () =>
    fetch("/api/trackers")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: { repos: string[]; removable?: string[] }) => ({ repos: body.repos, removable: body.removable ?? [] }));
  useEffect(() => {
    let alive = true;
    load().then((next) => { if (alive) setList(next); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  if (list.repos.length === 0 && !error) return null;
  const current = list.repos.find((r) => r.toLowerCase() === props.value?.toLowerCase()) ?? list.repos[0];
  const remove = async (repo: string) => {
    if (removingRef.current) return
    removingRef.current = true
    setRemoveRepo(null)
    setRemoving(true)
    setError("")
    try {
      const res = await fetch(`/api/repos?url=${encodeURIComponent(`https://github.com/${repo}`)}`, { method: "DELETE" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const next = await load()
      setList(next)
      props.onChange(next.repos[0] ?? "")
    } catch (e) { setError(t("repo.remove_failed", { msg: (e as Error).message })) }
    finally { removingRef.current = false; setRemoving(false) }
  };
  return (
    <div className="flex w-full min-w-0 flex-col gap-1 sm:w-96">
    <div className="flex min-w-0 items-center gap-2">
      <NativeSelect className="bg-background" aria-label={t("term.repo")} value={current} onChange={(e) => props.onChange(e.target.value)}>
        {list.repos.map((r) => <option key={r} value={r}>{r}</option>)}
      </NativeSelect>
      <Button type="button" variant="outline" className="disabled:pointer-events-auto disabled:cursor-not-allowed" title={t("repo.remove_title")}
        disabled={removing || !list.removable.includes(current)} onClick={() => setRemoveRepo(current)}>
        {t("common.remove")}
      </Button>
    </div>
    {error && <p role="alert" className="text-xs text-red-700 dark:text-red-400">{error}</p>}
    {removeRepo && <ConfirmDialog message={t("repo.remove_confirm", { repo: removeRepo })} confirmLabel={t("common.remove")}
      onCancel={() => setRemoveRepo(null)} onConfirm={() => void remove(removeRepo)} />}
    </div>
  );
}
