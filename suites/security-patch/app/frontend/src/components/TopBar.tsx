import { Badge, runStatusVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RunStatusLabel } from "./RunStatusLabel";
import type { RunMode, RunStatus, RunSummary } from "../types/events";
import { useI18n } from "../i18n";
import { AttemptPicker } from "./AttemptPicker";

export interface TopBarProps {
  runId: string;
  runNumber?: number
  status: RunStatus;
  mode?: RunMode;
  phase?: RunSummary["phase"];
  // Shown once the run details load.
  repo?: string;
  branch?: string;
  attempts?: RunSummary["attempts"];
  onStop?: () => void;   // set only while the run can still stop
  onPause?: () => void;
  pausing?: boolean
  stopping?: boolean
}

export function TopBar(props: TopBarProps) {
  const { t } = useI18n();
  return (
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b bg-background px-4 py-3 sm:px-6">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        {props.repo && (
          <span data-testid="run-repo" className="truncate text-[15px] font-semibold">
            {props.repo} {props.runNumber != null && <span className="font-normal text-muted-foreground">{t("run.number", { number: props.runNumber })}</span>} {props.branch && <code className="font-medium text-muted-foreground">{props.branch}</code>}
          </span>
        )}
        <Badge variant={runStatusVariant(props.status)}><RunStatusLabel run={{ status: props.status, mode: props.mode ?? "scan", phase: props.phase }} /></Badge>
        <h1 className="font-mono text-xs font-normal whitespace-nowrap text-muted-foreground" title={props.runId}>{t("run.title", { id: props.runId.slice(0, 8) })}</h1>
        <AttemptPicker runId={props.runId} attempts={props.attempts} />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        {props.onPause && <Button type="button" variant="outline" size="sm" disabled={props.pausing || props.stopping} onClick={props.onPause}>{t(props.pausing ? "run.pausing" : "run.pause")}</Button>}
        {props.onStop && props.mode === "fix" && <span className="max-w-md text-sm text-muted-foreground">{t("run.fix_cancel_note")}</span>}
        {props.onStop && <Button type="button" variant="destructive" size="sm" disabled={props.stopping} onClick={props.onStop}>{t("run.stop")}</Button>}
      </div>
    </header>
  );
}
