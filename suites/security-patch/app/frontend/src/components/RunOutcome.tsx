import { Alert, AlertDescription } from "@/components/ui/alert";
import type { RunSummary } from "../types/events";
import { useI18n } from "../i18n";
import { CompletionCard } from "./CompletionCard";
import { ResumeBar } from "./ResumeBar";

export function RunOutcome({ meta, onResumed, prUrl, pushError }: {
  meta: Pick<RunSummary, "runId" | "mode" | "status" | "error" | "stopReason" | "attempts">;
  onResumed: (runId: string) => void;
  prUrl?: string;
  pushError?: string;
}) {
  const { t } = useI18n();
  if (meta.status === "stopped") {
    const reason = meta.stopReason ?? (meta.error === "stopped at user pause" ? "user_pause" : meta.error === "stopped at quota" ? "quota" : undefined);
    const latest = !meta.attempts || meta.attempts[meta.attempts.length - 1]?.runId === meta.runId;
    return <Alert variant="warning" className="flex flex-wrap items-center justify-between gap-3">
      <span>{t(reason ? `run.paused_${reason}` : "run.paused")}</span>
      {latest ? <span className="flex flex-wrap items-center gap-2"><ResumeBar runId={meta.runId} onResumed={onResumed} /></span> : <span>{t("run.resumed_later")}</span>}
    </Alert>;
  }
  if (meta.status === "aborted") return <Alert variant="warning"><AlertDescription>{t("run.aborted")}</AlertDescription></Alert>;
  if (meta.status !== "completed" && meta.status !== "failed") return null;
  return <CompletionCard runId={meta.runId} mode={meta.mode} status={meta.status} error={meta.error} prUrl={prUrl} pushError={pushError ?? meta.error} />;
}
