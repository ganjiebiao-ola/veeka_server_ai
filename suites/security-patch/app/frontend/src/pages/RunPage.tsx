import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ChecklistSidebar } from "../components/ChecklistSidebar";
import { ActivityArea } from "../components/ActivityArea";
import { TopBar } from "../components/TopBar";
import { RunFacts } from "../components/RunFacts";
import { RunUsage } from "../components/RunUsage";
import { RunInputs } from "../components/RunInputs";
import { RunOutcome } from "../components/RunOutcome";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { RUNS_CHANGED } from "../hooks/useActiveRuns";
import { useRunEvents } from "../hooks/useRunEvents";
import type { ScopeInfo } from "../components/ReportView";
import type { RunMode, RunSummary } from "../types/events";
import { isNamedBranch, shortRepo } from "../types/events";
import { useI18n } from "../i18n";

export interface RunPageProps {
  runId: string;
  mode: RunMode;            // checklist + start args echo
  onResumed: (runId: string) => void;
  onFinished?: () => void;
}

export function RunPage(props: RunPageProps) {
  const { t } = useI18n();
  const state = useRunEvents(props.runId, { mode: props.mode });

  // Fetch the run's skill + scoped-scan selection once so the live view can
  // always show a correct Full / Scoped / N/A banner (prevents mistaking a
  // scoped or non-audit run for a complete audit). "error" surfaces a failed
  // fetch instead of silently hiding the banner; null = still loading.
  const [scope, setScope] = useState<ScopeInfo | "error" | null>(null);
  const [meta, setMeta] = useState<RunSummary>();
  const pausingRef = useRef(false)
  const [pausing, setPausing] = useState(false)
  const stoppingRef = useRef(false)
  const [stopping, setStopping] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [actionError, setActionError] = useState("")
  useEffect(() => {
    pausingRef.current = false
    setPausing(false)
    setActionError("")
    setCancelOpen(false)
  }, [props.runId])
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/runs/${encodeURIComponent(props.runId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((m: RunSummary) => {
        if (cancelled) return;
        setScope({ mode: m.mode, skill: m.skill ?? "", categories: m.categories ?? [] });
        setMeta(m);
      })
      .catch(() => { if (!cancelled) setScope("error"); });
    return () => { cancelled = true; };
  }, [props.runId, state.reconnects]);

  const onPause = async () => {
    if (pausingRef.current || stoppingRef.current) return
    setActionError("")
    pausingRef.current = true
    setPausing(true)
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(props.runId)}/pause`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
    } catch (e) {
      pausingRef.current = false
      setPausing(false)
      setActionError(t("run.pause_failed", { msg: (e as Error).message }))
    }
  };

  const onStop = async () => {
    if (stoppingRef.current) return
    setCancelOpen(false);
    setActionError("");
    stoppingRef.current = true
    setStopping(true)
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(props.runId)}/stop`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
      dispatchEvent(new Event(RUNS_CHANGED));
    } catch (e) { setActionError(t("run.stop_failed", { msg: (e as Error).message })) }
    finally { stoppingRef.current = false; setStopping(false) }
  };

  const status = meta && ["completed", "failed", "aborted", "stopped"].includes(meta.status) ? meta.status : state.status
  const isTerminal = ["completed", "failed", "aborted", "stopped"].includes(status)

  useEffect(() => {
    if (isTerminal && props.onFinished) {
      props.onFinished();
    }
  }, [isTerminal, props.onFinished]);

  return (
    <div className="flex min-h-0 flex-col lg:h-[calc(100dvh-3.5rem)]">
      <TopBar
        runId={props.runId}
        runNumber={meta?.runNumber}
        status={status}
        mode={props.mode}
        phase={state.phase ?? meta?.phase}
        repo={meta && shortRepo(meta.repoUrl)}
        branch={meta && isNamedBranch(meta.branch) ? meta.branch : undefined}
        attempts={meta?.attempts}
        pausing={pausing}
        onPause={!isTerminal && meta?.mode === "scan" && ["queued", "cloning", "scanning"].includes(meta.status) ? onPause : undefined}
        stopping={stopping}
        onStop={!isTerminal && meta && ["queued", "cloning", "scanning"].includes(meta.status) ? () => setCancelOpen(true) : undefined}
      />
      {cancelOpen && <ConfirmDialog title={t("run.cancel_title")} message={t("run.stop_confirm")} confirmLabel={t("run.stop")} cancelLabel={t("run.keep_running")}
        onConfirm={() => void onStop()} onCancel={() => setCancelOpen(false)} />}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <ChecklistSidebar steps={state.steps} runStatus={status} />
        <main className="flex min-w-0 flex-1 flex-col gap-4 p-4 sm:p-5 lg:overflow-y-auto">
          {meta && <RunFacts meta={meta} usage={state.hasUsage ? state.usage : meta.usage} live={!isTerminal} />}
          {meta?.mode === "fix" && <RunUsage usage={Object.keys(state.phaseUsage).length ? state.phaseUsage : meta.phaseUsage} />}
          {meta && <RunInputs key={props.runId} runId={props.runId} />}
          {state.reconnecting && !isTerminal && <Alert role="status" variant="warning"><AlertDescription>{t("run.reconnecting")}</AlertDescription></Alert>}
          {state.error && !state.reconnecting && !isTerminal && <Alert role="alert" variant="destructive"><AlertDescription>{t("common.failed_to_load", { msg: state.error })}</AlertDescription></Alert>}
          {actionError && <Alert role="alert" variant="destructive"><AlertDescription>{actionError}</AlertDescription></Alert>}
          <RunOutcome meta={{ ...meta, runId: props.runId, mode: props.mode, status, error: meta?.error ?? state.error }}
            onResumed={props.onResumed} prUrl={state.prUrl} pushError={state.pushError} />
          <ActivityArea
            runId={props.runId}
            assistantText={state.assistantText}
            timeline={state.timeline}
            toolLog={state.toolLog}
            findings={state.findings}
            streaming={!isTerminal}
            scope={props.mode === "fix" ? undefined : scope}
          />
        </main>
      </div>
    </div>
  );
}
