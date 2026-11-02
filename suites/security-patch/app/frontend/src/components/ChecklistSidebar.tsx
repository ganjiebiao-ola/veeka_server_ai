import { useEffect, useId, useState } from "react";
import type { RunStatus, StepProgress, StepStatus } from "../types/events";
import { useI18n } from "../i18n";
import { fmtDuration } from "./RunFacts"
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

// Display-only states. "stopped": the step was running when its run ended.
// "skipped": the run moved past a step that never started, for example the scan on a resume.
type DisplayStatus = StepStatus | "stopped" | "skipped";

const MARKERS: Record<DisplayStatus, string> = {
  pending: "",
  in_progress: "",
  completed: "✓",
  degraded: "⚠",
  stopped: "■",
  skipped: "–",
};

const ITEM: Record<DisplayStatus, string> = {
  pending: "text-muted-foreground",
  in_progress: "bg-accent font-semibold text-foreground",
  completed: "text-foreground",
  degraded: "text-foreground",
  stopped: "font-semibold text-foreground",
  skipped: "text-muted-foreground/70",
};

const MARKER: Record<DisplayStatus, string> = {
  pending: "bg-muted text-muted-foreground",
  in_progress: "animate-spin border-[2.5px] border-sky-200 border-t-sky-600 dark:border-sky-900 dark:border-t-sky-400",
  completed: "bg-emerald-600 text-white dark:bg-emerald-500 dark:text-emerald-950",
  degraded: "bg-emerald-600 text-white dark:bg-emerald-500 dark:text-emerald-950",
  stopped: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  skipped: "bg-muted text-muted-foreground",
};

// Steps run in order, but some only report done when the run ends. Any step before the
// furthest one reached is behind the run: finished if it started, skipped if it never did.
export function displaySteps(items: StepProgress[], ended: boolean): DisplayStatus[] {
  const reached = items.reduce((last, step, index) => step.status === "pending" ? last : index, -1);
  return items.map(({ status }, index) => {
    if (index < reached) return status === "pending" ? "skipped" : status === "in_progress" ? "completed" : status;
    return ended && status === "in_progress" ? "stopped" : status;
  });
}

// The run ended without finishing. Any step still marked running will not finish.
const ENDED: ReadonlySet<RunStatus> = new Set(["failed", "aborted", "stopped"]);

export interface ChecklistSidebarProps {
  steps?: StepProgress[];
  runStatus?: RunStatus;
  initiallyCollapsed?: boolean;
}

export function ChecklistSidebar(props: ChecklistSidebarProps) {
  const { t, lang } = useI18n();
  const [collapsed, setCollapsed] = useState(props.initiallyCollapsed ?? false);
  // useRunEvents pre-seeds steps based on mode, so this list is mode-aware
  // already. We don't filter further here — render whatever was passed.
  const items = props.steps ?? [];
  const ended = props.runStatus !== undefined && ENDED.has(props.runStatus);
  const shownSteps = displaySteps(items, ended);
  const running = !ended && shownSteps.includes("in_progress");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  const done = shownSteps.filter((s) => s === "completed" || s === "degraded" || s === "skipped").length;
  const total = items.length || 1;
  const pct = Math.round((done / total) * 100);
  const progressLabelId = useId();

  return (
    <aside
      data-testid="checklist-sidebar"
      className={cn("flex min-h-0 shrink-0 flex-col overflow-hidden border-b bg-card lg:border-r lg:border-b-0", collapsed ? "lg:w-10" : "lg:w-60")}
    >
      <Button
        type="button"
        variant="ghost"
        className={cn("h-auto w-full shrink-0 justify-between rounded-none px-4 py-3 text-[13px] font-semibold text-muted-foreground hover:text-foreground",
          collapsed ? "lg:h-full lg:flex-col lg:justify-start lg:gap-3 lg:px-0 lg:py-4" : "border-b")}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className={cn(collapsed && "lg:rotate-180 lg:[writing-mode:vertical-rl]")}>
          {t("run.steps")}
          {items.length ? ` (${done}/${items.length})` : ""}
        </span>
        {collapsed ? <ChevronRight aria-hidden="true" className="max-lg:rotate-90" /> : <ChevronLeft aria-hidden="true" className="max-lg:rotate-90" />}
      </Button>
      {!collapsed ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-4">
          <ul className="flex flex-col gap-0.5">
            {items.map(({ name, status, startedAt }, index) => {
              const shown = shownSteps[index];
              return (
                <li key={name} data-status={shown} className={cn("flex items-center gap-2 rounded-md p-2 text-[13px]", ITEM[shown])}>
                  <span className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold", MARKER[shown])}>
                    {MARKERS[shown] || (shown === "pending" ? index + 1 : "")}
                  </span>
                  <span className="min-w-0 flex-1">{t(`step.${name}`)}</span>
                  {shown === "in_progress" && startedAt !== undefined && (
                    <span className="text-xs font-medium text-muted-foreground tabular-nums">{fmtDuration(0, Math.floor((now - startedAt) / 1000) * 1000, lang)}</span>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="mt-auto flex flex-col gap-2 border-t px-2 pt-4">
            <div id={progressLabelId} className="flex items-baseline gap-2 text-[13px] text-muted-foreground"><strong className="text-2xl leading-none text-foreground tabular-nums">{pct}%</strong>{t("run.complete")}</div>
            <Progress value={pct} aria-labelledby={progressLabelId} className={cn(ended && "*:data-[slot=progress-indicator]:bg-muted-foreground")} />
          </div>
        </div>
      ) : null}
    </aside>
  );
}
