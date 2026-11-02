import { useCallback, useEffect, useState } from "react";
import { RunPage } from "./RunPage";
import { RunDetailPage } from "./RunDetailPage";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Page } from "../components/Page";
import { navigate } from "../router";
import type { RunStatus, RunSummary } from "../types/events";
import { useI18n } from "../i18n";

const FINISHED: ReadonlySet<RunStatus> = new Set(["completed", "failed", "aborted", "stopped"]);

// One URL per run. A running run gets the live view. A finished run gets the saved view.
// Render this with key={runId}: a resumed run changes the id and must start from "loading".
export function RunRoute(props: { runId: string }) {
  const { t } = useI18n();
  const [meta, setMeta] = useState<RunSummary | null>(null);
  const [error, setError] = useState("")
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/runs/${encodeURIComponent(props.runId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((m: RunSummary) => { if (!cancelled) setMeta(m); })
      .catch(e => { if (!cancelled) setError(e.message) });
    return () => { cancelled = true; };
  }, [props.runId, retry]);

  const resumed = (runId: string) => navigate(`/runs/${encodeURIComponent(runId)}`);
  const onFinished = useCallback(() => {
    fetch(`/api/runs/${encodeURIComponent(props.runId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((m: RunSummary) => setMeta(m))
      .catch(() => {});
  }, [props.runId]);

  if (error) return (
    <Page>
      <a className="self-start text-sm text-muted-foreground hover:text-foreground" href="/history" onClick={(e) => { e.preventDefault(); navigate("/history"); }}>← {t("history.title")}</a>
      <Alert role="alert" variant="destructive" className="flex flex-wrap items-center justify-between gap-3">
        <span>{error === "404" ? t("run.not_found", { id: props.runId }) : t("common.failed_to_load", { msg: error })}</span>
        <Button type="button" variant="outline" size="sm" className="text-foreground" onClick={() => { setError(""); setRetry(n => n + 1) }}>{t("common.retry")}</Button>
      </Alert>
    </Page>
  );
  if (meta === null) return <Page><p role="status" className="py-12 text-center text-muted-foreground">{t("common.loading")}</p></Page>;
  return FINISHED.has(meta.status)
    ? <RunDetailPage runId={props.runId} onBack={() => navigate("/history")} onResumed={resumed} />
    : <RunPage runId={props.runId} mode={meta.mode} onResumed={resumed} onFinished={onFinished} />;
}
