import type { ComponentProps, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";
import type { Finding } from "../types/events";
import type { TimelineEntry, ToolLogEntry } from "../hooks/useRunEvents";
import { ReportView, splitSummary, SUMMARY_MARKER, scopeLabel, isScopedScan } from "./ReportView";
import type { ScopeInfo } from "./ReportView";
import { useI18n } from "../i18n";

export interface ActivityAreaProps {
  runId: string;
  assistantText: string;
  timeline: TimelineEntry[];
  toolLog: ToolLogEntry[];
  findings: Finding[];          // reserved for future structured findings
  streaming: boolean;
  // Scope of this run: the loaded {skill, categories}, "error" if metadata
  // couldn't be read, or null while still loading.
  scope?: ScopeInfo | "error" | null;
}

// Always-on scope indicator so a scan is never mistaken for a full audit. Says
// so when the scope is unknown (not silently hidden); hidden only during the
// brief initial load.
function ScopeBanner({ scope }: { scope?: ScopeInfo | "error" | null }) {
  const { t } = useI18n();
  if (scope == null) return null;
  if (scope === "error") {
    return <Alert data-testid="scope-banner" className="py-2"><AlertDescription className="text-[13px]">{t("scope.unknown")}</AlertDescription></Alert>;
  }
  const label = scopeLabel(t, scope.skill, scope.categories, scope.mode);
  if (!label) return null;
  const scoped = isScopedScan(scope.skill, scope.categories, scope.mode);
  return (
    <Alert data-testid="scope-banner" variant={scoped ? "warning" : "default"} className="py-2">
      <AlertDescription className={cn("block text-[13px]", scoped && "font-semibold")}>
        {scoped && <span aria-hidden="true">⚠️ </span>}{t("scope.banner", { scope: label })}
      </AlertDescription>
    </Alert>
  );
}

// A card that folds open. Its content stays in the page while folded, so find-in-page
// and the list's scroll position survive.
export function FoldPanel({ title, children, className, ...props }: ComponentProps<typeof Collapsible> & { title: ReactNode }) {
  return (
    <Collapsible className={cn("group/fold min-w-0 rounded-xl border bg-card text-card-foreground shadow-sm", className)} {...props}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-xl px-4 py-3 text-left text-sm font-semibold outline-none hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/fold:rotate-90" />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent forceMount className="min-w-0 border-t data-[state=closed]:hidden">{children}</CollapsibleContent>
    </Collapsible>
  );
}

// Main column layout (top → bottom):
//   1. Summary + Activity Log — split from the assistant stream on the final
//      summary marker (scanner/bridge.mjs SUMMARY_MARKER). While streaming the
//      summary doesn't exist yet, so we show the running log + a placeholder;
//      after the run terminates the marker is in the stream and we split it.
//   2. Reasoning and tool calls, in the order they happened
// Findings table is hidden until backend emits structured finding_emitted
// events (skill-side change, future work).
export function ActivityArea(props: ActivityAreaProps) {
  const { t } = useI18n();
  const { summary, log } = splitSummary(props.assistantText, SUMMARY_MARKER);
  return (
    <section className="flex flex-col gap-4">
      <ScopeBanner scope={props.scope} />
      {props.streaming ? (
        <>
          <ReportView runId={props.runId} text={log} title={t("report.activity")} streaming />
          <Card className="p-5 text-center text-sm text-muted-foreground">{t("report.summary_pending")}</Card>
        </>
      ) : summary ? (
        <>
          <ReportView runId={props.runId} text={summary} title={t("report.summary")} downloadKind="response" />
          <ReportView runId={props.runId} text={log} title={t("report.activity")} downloadKind="activity" defaultOpen={false} />
        </>
      ) : (
        // Marker-less run (e.g. an old security-review run, or the model
        // skipped the marker): there is no separable summary, so show the whole report as
        // one panel instead of an empty "Summary" placeholder.
        <ReportView runId={props.runId} text={log} downloadKind="report" />
      )}
      <ActivityTimeline key={props.runId} timeline={props.timeline} toolLog={props.toolLog} ended={!props.streaming} />
    </section>
  );
}

const KINDS = ["reasoning", "read", "change", "run", "other"] as const;
type Kind = typeof KINDS[number];
type ToolState = "running" | "ok" | "failed" | "stopped";
// The row color says what the tool does: a left stripe and the tool name.
const STRIPE: Record<Kind, string> = {
  reasoning: "border-l-violet-300 dark:border-l-violet-500",
  read: "border-l-sky-300 dark:border-l-sky-700",
  change: "border-l-amber-300 dark:border-l-amber-700",
  run: "border-l-teal-300 dark:border-l-teal-700",
  other: "border-l-neutral-300 dark:border-l-neutral-600",
};
const TOOL_TEXT: Record<Kind, string> = {
  reasoning: "",
  read: "text-sky-700 dark:text-sky-300",
  change: "text-amber-700 dark:text-amber-300",
  run: "text-teal-700 dark:text-teal-300",
  other: "",
};
const ROW: Record<ToolState, string> = {
  running: "bg-sky-50 dark:bg-sky-950",
  failed: "border-l-red-400 bg-red-50 text-red-700 dark:border-l-red-700 dark:bg-red-950 dark:text-red-300",
  stopped: "text-muted-foreground",
  ok: "",
};
const MARK: Record<ToolState, string> = {
  ok: "font-semibold text-emerald-700 dark:text-emerald-400",
  failed: "font-semibold text-red-700 dark:text-red-400",
  running: "text-sky-700 dark:text-sky-300",
  stopped: "",
};
// Each entry is one line. A click opens it, and its text wraps in full.
const entry = "flex min-w-0 cursor-pointer list-none items-baseline gap-3 overflow-hidden rounded-sm border-l-[3px] px-2 py-1 text-xs group-open:flex-wrap [&::-webkit-details-marker]:hidden";
const oneLine = "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap group-open:whitespace-pre-wrap group-open:[overflow-wrap:anywhere]";
const chevron = <ChevronRight aria-hidden="true" className="size-3 shrink-0 self-center text-muted-foreground transition-transform group-open:rotate-90" />;

// Reasoning and tool calls in one list, in the order they happened. The list scrolls
// inside its own box, so a long run does not stretch the page. A live run follows the
// newest entry while the reader stays at the bottom.
export function ActivityTimeline({ timeline, toolLog, ended }: { timeline: TimelineEntry[]; toolLog: ToolLogEntry[]; ended: boolean }) {
  const { t } = useI18n();
  const [pageSize, setPageSize] = useState(() => {
    try {
      const saved = Number(localStorage.getItem("run.activity.pageSize"))
      if ([10, 50, 100].includes(saved)) return saved
    } catch { /* Storage may be unavailable. */ }
    return 50
  })
  // null follows the newest page, including when a live entry starts a new page.
  const [selection, setSelection] = useState<{ page: number; seen: number } | null>(null)
  // Open while live, folded once the run ends. The reader's own toggle holds until then.
  const [toggled, setToggled] = useState<{ open: boolean; ended: boolean } | null>(null)
  const open = toggled?.ended === ended ? toggled.open : !ended
  const pages = Math.max(1, Math.ceil(timeline.length / pageSize))
  const page = selection === null ? pages - 1 : Math.min(selection.page, pages - 1)
  const newest = selection === null
  const newEntries = selection === null ? 0 : Math.max(0, timeline.length - selection.seen)
  const start = page * pageSize
  const move = (target: number) => {
    setSelection(target === pages - 1 ? null : { page: target, seen: timeline.length })
  }
  const list = useRef<HTMLOListElement>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    if (!ended && newest && atBottom.current && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [timeline.length, ended, newest, pageSize]);
  if (timeline.length === 0) return null;
  return (
    <FoldPanel title={t("run.timeline", { count: timeline.length })} open={open} onOpenChange={value => setToggled({ open: value, ended })}>
      <div className="flex flex-wrap items-center gap-2 px-4 pt-3 text-[13px]">
        <Label className="font-normal">
          <span className="shrink-0">{t("run.page_size")}</span>
          <NativeSelect size="sm" className="w-20 bg-background" value={pageSize} onChange={event => {
            const size = Number(event.currentTarget.value)
            if (![10, 50, 100].includes(size)) return
            setPageSize(size)
            setSelection(null)
            try { localStorage.setItem("run.activity.pageSize", String(size)) } catch { /* Storage may be unavailable. */ }
          }}>
            {[10, 50, 100].map(size => <option key={size} value={size}>{size}</option>)}
          </NativeSelect>
        </Label>
        <Button type="button" variant="outline" size="sm" disabled={page === 0} onClick={() => move(page - 1)}>{t("run.page_prev")}</Button>
        <span className="text-muted-foreground tabular-nums">{t("run.page_indicator", { page: page + 1, pages })}</span>
        <Button type="button" variant="outline" size="sm" disabled={page === pages - 1} onClick={() => move(page + 1)}>{t("run.page_next")}</Button>
        <span role="status">{newEntries > 0 ? t("run.new_entries", { count: newEntries }) : ""}</span>
      </div>
      {/* What the row colors mean. It sits above the list, so it does not scroll away. */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 pt-3 text-[11px] text-muted-foreground">
        {KINDS.map(k => (
          <span key={k} className={cn("border-l-[3px] pl-1.5", STRIPE[k])}>{t(`run.legend_${k}`)}</span>
        ))}
        <span><span className={MARK.ok}>✓</span> {t("run.legend_ok")}</span>
        <span><span className={MARK.failed}>✗</span> {t("run.legend_failed")}</span>
        <span>■ {t("run.tool_stopped")}</span>
      </div>
      <ol ref={list} className="m-0 flex max-h-[60vh] list-none flex-col gap-1 overflow-y-auto p-4" start={start + 1}
        onScroll={(e) => { const el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
        {timeline.slice(start, start + pageSize).map((item, offset) => {
          const i = start + offset
          // Each entry shows one line. A click opens it to the full text.
          if ("thinking" in item) return (
            <li key={i} className="shrink-0"><details className="group"><summary data-kind="reasoning" className={cn(entry, "bg-muted text-foreground/70", STRIPE.reasoning)}>
              {chevron}
              <Clock ts={item.ts} />
              <span className={cn(oneLine, "flex-1")}>{item.thinking}</span>
            </summary></details></li>
          );
          const e = toolLog[item.tool];
          if (!e) return null;
          const state = stateOf(e, ended)
          const kind = kindOf(e.tool)
          const [mark, res] = e.ok !== undefined ? [e.ok ? "✓" : "✗", e.summary ?? ""] : ended ? ["■", t("run.tool_stopped")] : ["…", ""];
          return (
            <li key={i} className="shrink-0"><details className="group"><summary data-kind={kind} data-status={state} className={cn(entry, STRIPE[kind], ROW[state])}>
              {chevron}
              <Clock ts={e.ts} />
              <span className={cn("min-w-14 shrink-0 font-semibold", TOOL_TEXT[kind])}>{e.tool}</span>
              <span className={cn(oneLine, "flex-1 font-mono text-muted-foreground")}>{briefInput(e.tool, e.input)}</span>
              <span className={cn(oneLine, "max-w-[45%] font-mono text-muted-foreground group-open:max-w-none group-open:basis-full")}><span className={MARK[state]}>{mark}</span>{res && " " + res}</span>
            </summary></details></li>
          );
        })}
      </ol>
    </FoldPanel>
  );
}

// Logs saved before the bridge stamped its frames have no time. Then the entry shows none.
function Clock({ ts }: { ts?: number }) {
  if (ts === undefined) return null;
  const d = new Date(ts);
  return <time className="shrink-0 font-mono text-[11px] text-muted-foreground" dateTime={d.toISOString()}>{d.toLocaleTimeString([], { hour12: false })}</time>;
}

function kindOf(tool: string): Kind {
  if (["Read", "Grep", "Glob", "LS"].includes(tool)) return "read";
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) return "change";
  if (tool === "Bash") return "run";
  return "other";
}

// A tool with no result is running, unless the run already ended. Then it never will finish.
function stateOf(e: ToolLogEntry, ended: boolean): ToolState {
  if (e.ok === undefined) return ended ? "stopped" : "running";
  return e.ok ? "ok" : "failed";
}

function briefInput(tool: string, input?: Record<string, unknown>): string {
  if (!input) return "";
  if (tool === "Bash") return String(input.command ?? "");
  if (tool === "Read" || tool === "Write" || tool === "Edit") return String(input.file_path ?? input.path ?? "");
  if (tool === "Grep" || tool === "Glob") return String(input.pattern ?? "");
  const firstVal = Object.values(input)[0];
  return typeof firstVal === "string" ? firstVal : "";
}
