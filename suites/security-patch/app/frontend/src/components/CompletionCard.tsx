import { ExternalLink } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { RunMode } from "../types/events";
import { ArtifactButtons } from "./ArtifactButtons";
import { useI18n } from "../i18n";
import { githubUrl } from "./ReportView";

export interface CompletionCardProps {
  runId: string;
  mode: RunMode;
  status: "completed" | "failed";
  error?: string;
  prUrl?: string;
  pushError?: string;
}

// Inline result bar shown at the top of the main column after a run terminates.
// A fix run opens its batch PR by itself, so the bar links the PR once it exists.
export function CompletionCard(props: CompletionCardProps) {
  const { t } = useI18n();

  if (props.status === "failed") {
    return (
      <Alert variant="destructive" role="alert" className="border-l-4 border-l-red-700 px-5 py-4 dark:border-l-red-400">
        <h2 className="col-start-2 text-[15px] font-semibold">{t("run.failed")}</h2>
        <AlertDescription>{props.error ?? t("run.unknown_error")}</AlertDescription>
      </Alert>
    );
  }

  return (
    <Card className="flex-row flex-wrap items-center gap-3 border-l-4 border-l-emerald-600 px-5 py-4">
      <div className="flex min-w-[200px] flex-1 flex-col gap-0.5">
        <h2 className="text-[15px] font-semibold">{t("run.completed")}</h2>
        <p className="text-[13px] text-muted-foreground">{t("run.results_ready")}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <ArtifactButtons runId={props.runId} mode={props.mode} />
        {githubUrl(props.prUrl) ? (
          <Button asChild><a href={githubUrl(props.prUrl)} target="_blank" rel="noopener noreferrer">{t("run.open_pr")}<ExternalLink aria-hidden="true" /></a></Button>
        ) : props.pushError ? <span role="alert" className="max-w-80 text-xs leading-snug text-red-700 dark:text-red-400">{t("run.push_failed")}: {props.pushError}</span> : null}
      </div>
    </Card>
  );
}
