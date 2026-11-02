import { Fragment, useEffect, useId, useRef, useState } from "react"
import { ExternalLink } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge, runStatusVariant, severityVariant } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"
import { Page } from "../components/Page"
import { AttemptPicker } from "../components/AttemptPicker";
import { useI18n } from "../i18n"
import { ReportView, githubUrl } from "../components/ReportView";
import { RunFacts } from "../components/RunFacts";
import { RunUsage } from "../components/RunUsage";
import { RunInputs } from "../components/RunInputs";
import { ArtifactButtons, DiagnosticButtons } from "../components/ArtifactButtons";
import { RunOutcome } from "../components/RunOutcome";
import { RunStatusLabel } from "../components/RunStatusLabel";
import { ActivityTimeline, FoldPanel } from "../components/ActivityArea";
import { ChecklistSidebar } from "../components/ChecklistSidebar";
import { parseEventsLog } from "../hooks/useRunEvents";
import type { TimelineEntry, ToolLogEntry } from "../hooks/useRunEvents";
import type { Finding, RunSummary, StepProgress } from "../types/events";
import { displayBranch, isNamedBranch, shortRepo } from "../types/events";

export interface RunDetailPageProps {
  runId: string;
  onBack: () => void;
  onResumed: (runId: string) => void;
}

interface State {
  meta: RunSummary | null;
  report: string;
  summary: string;
  activity: string;   // process log (activity.md); "" when the run wasn't marker-split
  findings: Finding[];
  prUrl: string | null;
  loading: boolean;
  error: string | null;
  toolLog: ToolLogEntry[];
  timeline: TimelineEntry[];
  steps: StepProgress[];
}

export function RunDetailPage(props: RunDetailPageProps) {
  const { t } = useI18n()
  // A stopped run must stay resumable after a reload, not only from its live page (see ResumeBar).
  const [state, setState] = useState<State>({
    meta: null, report: "", summary: "", activity: "", findings: [],
    prUrl: null, loading: true, error: null,
    toolLog: [], timeline: [], steps: [],
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const metaP = fetch(`/api/runs/${encodeURIComponent(props.runId)}`).then(async (r) => {
          if (!r.ok) throw new Error(`metadata HTTP ${r.status}`);
          return await r.json() as RunSummary;
        });
        const [meta, reportR, respR, activityR, findR, pushR, eventsR] = await Promise.all([
          metaP,
          fetch(`/api/runs/${encodeURIComponent(props.runId)}/artifacts/report`),
          fetch(`/api/runs/${encodeURIComponent(props.runId)}/artifacts/response`),
          fetch(`/api/runs/${encodeURIComponent(props.runId)}/artifacts/activity`),
          fetch(`/api/runs/${encodeURIComponent(props.runId)}/findings`),
          // push.json is written when a fix run opens its batch PR. Other runs never push,
          // so they skip the request instead of logging a 404.
          metaP.then((m) => m.mode === "fix" ? fetch(`/api/runs/${encodeURIComponent(props.runId)}/artifacts/push`) : null),
          fetch(`/api/runs/${encodeURIComponent(props.runId)}/artifacts/events?replay=1`),
        ]);
        const report = reportR.ok ? await reportR.text() : "";
        const summary = respR.ok ? await respR.text() : "";
        // activity.md exists only for marker-split runs; absent (404) → "" → the
        // render below falls back to a single full report.
        const activity = activityR.ok ? await activityR.text() : "";
        const findings = findR.ok ? ((await findR.json() as { findings: Finding[] }).findings)                : [];
        // Older push.json files have the number only.
        const push = pushR?.ok ? await pushR.json() as { pr?: number; prUrl?: string } : null;
        const repo = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(meta.repoUrl)?.[1];
        const prUrl = push?.prUrl ?? (push?.pr && repo ? `https://github.com/${repo}/pull/${push.pr}` : null);
        const events = eventsR.ok
          ? parseEventsLog(await eventsR.text(), meta.mode)
          : parseEventsLog("", meta.mode);
        if (cancelled) return;
        setState((s) => ({
          ...s, meta, report, summary, activity, findings, prUrl,
          toolLog: events.toolLog, timeline: events.timeline, steps: events.steps, loading: false, error: null,
        }));
      } catch (e) {
        if (!cancelled) setState((s) => ({ ...s, loading: false, error: (e as Error).message }));
      }
    })();
    return () => { cancelled = true; };
  }, [props.runId]);

  const back = <a className="self-start text-sm text-muted-foreground hover:text-foreground" href="/history" onClick={(e) => { e.preventDefault(); props.onBack(); }}>← {t("history.title")}</a>
  if (state.loading) return <Page><p role="status" className="py-12 text-center text-muted-foreground">{t("common.loading")}</p></Page>;
  if (state.error)   return (
    <Page>
      {back}
      <Alert role="alert" variant="destructive"><AlertDescription>{t("common.failed_to_load", { msg: state.error })}</AlertDescription></Alert>
    </Page>
  );

  const meta = state.meta!;
  const canPost = meta.mode === "scan" && meta.status === "completed" && /^https?:\/\/github\.com\//i.test(meta.repoUrl);
  // Findings waiting to be posted are the next step, so they go above the long report.
  const postFirst = canPost && state.findings.some((f) => !f.posted);
  const findingsPanel = (
    <FindingsPanel findings={state.findings} runId={meta.runId} canPost={canPost}
      onPosted={(findings) => setState((s) => ({ ...s, findings }))} />
  );
  return (
    <div className="flex w-full flex-col lg:min-h-[calc(100dvh-3.5rem)] lg:flex-row">
      {state.steps.length > 0 && <ChecklistSidebar steps={state.steps} runStatus={meta.status} />}
      <div className="min-w-0 flex-1">
        <Page>
          {back}
          <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
            <div className="flex min-w-0 flex-col items-start gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-3">
                <h1 className="text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]" title={meta.repoUrl}>
                  {shortRepo(meta.repoUrl)} <span className="font-normal text-muted-foreground">{t("run.number", { number: meta.runNumber })}</span> {isNamedBranch(meta.branch) ? <code className="text-lg font-medium">{meta.branch}</code> : <span className="font-normal text-muted-foreground">{displayBranch(meta.branch, t)}</span>}
                </h1>
                <Badge variant={runStatusVariant(meta.status)}><RunStatusLabel run={meta} /></Badge>
              </div>
              <AttemptPicker runId={meta.runId} attempts={meta.attempts} />
            </div>
          </header>
          <RunFacts meta={meta} />
          {meta.mode === "fix" && <RunUsage usage={meta.phaseUsage} />}
          <RunInputs runId={meta.runId} />
          <RunOutcome meta={meta} onResumed={props.onResumed} prUrl={state.prUrl ?? undefined} />

          {meta.status !== "completed" && <div className="flex flex-wrap items-center gap-2">
            <ArtifactButtons runId={meta.runId} mode={meta.mode} />
            {githubUrl(state.prUrl) ? (
              <Button asChild>
                <a href={githubUrl(state.prUrl)} target="_blank" rel="noopener noreferrer">{t("run.open_pr")}<ExternalLink aria-hidden="true" /></a>
              </Button>
            ) : null}
          </div>}
          <div className="flex flex-wrap items-center gap-2">
            <DiagnosticButtons runId={meta.runId} />
          </div>

          {/* Marker-split runs: Summary (response.md) on top, process-only Activity
              Log (activity.md) collapsed below — no overlap. Marker-less / legacy
              runs have no activity.md, so show the single full report instead. */}
          {postFirst && findingsPanel}
          {state.activity ? (
            <>
              <ReportView runId={meta.runId} text={state.summary} title={t("report.summary")} downloadKind="response" streaming={false} />
              <ReportView runId={meta.runId} text={state.activity} title={t("report.activity")} downloadKind="activity" defaultOpen={false} streaming={false} />
            </>
          ) : (
            <ReportView runId={meta.runId} text={state.report} downloadKind="report" streaming={false} />
          )}

          <ActivityTimeline timeline={state.timeline} toolLog={state.toolLog} ended />
          {!postFirst && findingsPanel}
        </Page>
      </div>
    </div>
  );
}


// New findings come first: they are the ones still to post.
const TAG_ORDER = ["new", "similar", "tracked", "posted"] as const
const SEVERITY_ORDER = ["P0", "P1", "P2"]

type TrackedMatch = { kind: "tracked" | "similar"; url: string; file: string; line: number; status: string };

// What a finding is to GitHub. Only "new" starts selected.
// A scan marks every finding "candidate", so false positives are the dev's call: untick them.
export function findingTag(f: Finding, match?: TrackedMatch): "posted" | "tracked" | "similar" | "new" {
  if (f.posted) return "posted";
  return match?.kind ?? "new";
}

// A completed scan of a GitHub repo can post findings to the repo's tracker files.
// The panel first asks the backend which findings GitHub already tracks, then selects only the new ones.
export function FindingsPanel({ findings, runId, canPost, onPosted, initialCheck }: {
  findings: Finding[];
  runId: string;
  canPost: boolean;
  onPosted: (findings: Finding[]) => void;
  initialCheck?: { repo: string; matches: Record<string, TrackedMatch> };  // tests only: skips the fetch
}) {
  const { t, label } = useI18n()
  const unposted = findings.filter((f) => !f.posted);
  const [check, setCheck] = useState<
    { state: "loading" } | { state: "ok"; repo: string; matches: Record<string, TrackedMatch> } | { state: "failed"; error: string }
  >(initialCheck ? { state: "ok", ...initialCheck } : { state: "loading" });
  const matches = check.state === "ok" ? check.matches : {};
  const tagOf = (f: Finding) => findingTag(f, matches[f.id]);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(initialCheck ? unposted.filter((f) => findingTag(f, initialCheck.matches[f.id]) === "new").map((f) => f.id) : []));
  const [query, setQuery] = useState("")
  const shown = findings.filter((f) => [f.id, f.category, label("category", f.category), f.subsystem, f.severity, `${f.file ?? ""}${f.line ? `:${f.line}` : ""}`, f.snippet, f.fixSummary, f.status, f.reason].some(value => value?.toLowerCase().includes(query.trim().toLowerCase()))).sort((a, b) =>
    TAG_ORDER.indexOf(tagOf(a)) - TAG_ORDER.indexOf(tagOf(b)) || SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
  const shownUnposted = shown.filter((f) => !f.posted);
  // A hidden row never posts, so the button count matches what the dev can see.
  const postIds = shownUnposted.filter((f) => ticked.has(f.id)).map((f) => f.id);
  const newIds = () => shownUnposted.filter((f) => tagOf(f) === "new").map((f) => f.id);
  const [posting, setPosting] = useState(false);
  const postingRef = useRef(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!canPost || initialCheck || unposted.length === 0) return;
    let alive = true;
    fetch(`/api/runs/${encodeURIComponent(runId)}/post`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({})) as { repo?: string; matches?: Record<string, TrackedMatch>; error?: string };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        return { repo: body.repo ?? "", matches: body.matches ?? {} };
      })
      .then(({ repo, matches }) => {
        if (!alive) return;
        setCheck({ state: "ok", repo, matches });
        setTicked(new Set(unposted.filter((f) => findingTag(f, matches[f.id]) === "new").map((f) => f.id)));
      })
      .catch((e: Error) => {
        if (!alive) return;
        // Without the check, fall back to every unposted finding.
        setCheck({ state: "failed", error: e.message });
        setTicked(new Set(unposted.map((f) => f.id)));
      });
    return () => { alive = false; };
    // Run once per run. Posting reloads findings but the matches stay valid.
  }, [canPost, runId]);

  // Scan runs fix nothing, so their table has no Fix column.
  const hasFix = findings.some((f) => f.fixSummary);
  const toggle = (id: string, on: boolean) => setTicked((prev) => {
    const next = new Set(prev);
    if (on) next.add(id); else next.delete(id);
    return next;
  });
  const post = async () => {
    // Block another click before React renders the disabled button.
    if (postingRef.current) return
    postingRef.current = true
    setPosting(true);
    setResult(null);
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/post`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: postIds }),
      });
      const body = await res.json().catch(() => ({})) as { added?: number; skipped?: number; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      const reload = await fetch(`/api/runs/${encodeURIComponent(runId)}/findings`);
      if (reload.ok) onPosted((await reload.json() as { findings: Finding[] }).findings);
      setTicked(new Set());
      setResult({ ok: true, text: t("detail.post_done", { added: body.added ?? 0, skipped: body.skipped ?? 0 }) });
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      postingRef.current = false
      setPosting(false);
    }
  };

  const showPost = canPost && unposted.length > 0;
  const count = (tag: ReturnType<typeof findingTag>) => unposted.filter((f) => tagOf(f) === tag).length;
  const searchId = useId()
  const tag = (f: Finding) => {
    const kind = tagOf(f);
    const match = matches[f.id];
    if (kind === "posted") return <span className="text-muted-foreground">{t("detail.posted")}</span>;
    if ((kind === "tracked" || kind === "similar") && match) {
      const params = { file: match.file, line: match.line, status: match.status };
      return (
        <Badge asChild variant={kind === "similar" ? "paused" : "secondary"}>
          <a href={match.url} target="_blank" rel="noreferrer" title={t(`detail.tag_${kind}_title`, params)}>
            {t(`detail.tag_${kind}`, params)}
          </a>
        </Badge>
      );
    }
    return check.state === "ok" ? <Badge variant="success">{t("detail.tag_new")}</Badge> : null;
  };

  return (
    <FoldPanel title={t("detail.findings", { count: findings.length })} defaultOpen={findings.length > 0}>
      <div className="flex flex-col gap-3 p-4">
        {findings.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{t("detail.no_findings")}</p>
        ) : (
          <>
            {showPost && (
              <>
                <p className="text-[13px] text-muted-foreground">{t("detail.post_hint")}</p>
                {check.state === "loading" && <Alert role="status" variant="info"><AlertDescription>{t("detail.check_loading")}</AlertDescription></Alert>}
                {check.state === "failed" && <Alert role="status" variant="warning"><AlertDescription>{t("detail.check_failed", { msg: check.error })}</AlertDescription></Alert>}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {check.state === "ok" && <span className="text-[13px] text-muted-foreground">{(["new", "tracked", "similar"] as const).filter((k) => count(k) > 0).map((k) => t(`detail.count_${k}`, { count: count(k) })).join(" · ")}</span>}
                    <Button type="button" variant="outline" size="sm" disabled={posting || check.state !== "ok"} onClick={() => setTicked(new Set(newIds()))}>{t("detail.select_new")}</Button>
                    <Button type="button" variant="outline" size="sm" disabled={posting} onClick={() => setTicked(new Set(shownUnposted.map((f) => f.id)))}>{t("detail.select_all")}</Button>
                    <Button type="button" variant="outline" size="sm" disabled={posting} onClick={() => setTicked(new Set())}>{t("detail.select_none")}</Button>
                  </div>
                  <Button type="button" disabled={posting || check.state === "loading" || postIds.length === 0} onClick={() => void post()}>
                    {posting ? t("detail.posting") : t("detail.post_selected", { count: postIds.length })}
                  </Button>
                </div>
              </>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={searchId}>{t("common.search_findings")}</Label>
              <Input id={searchId} type="search" value={query} onChange={e => setQuery(e.target.value)} />
            </div>
            {result && <Alert role={result.ok ? "status" : "alert"} variant={result.ok ? "info" : "destructive"}><AlertDescription>{result.text}</AlertDescription></Alert>}
            <Table>
              <TableHeader>
                <TableRow>
                  {canPost && <TableHead className="w-px whitespace-normal">{t("detail.select_findings")}</TableHead>}
                  {canPost && <TableHead>{t("detail.col_github")}</TableHead>}
                  <TableHead>{t("term.severity")}</TableHead><TableHead>{t("term.bug_type")}</TableHead><TableHead>{t("term.location")}</TableHead>{hasFix && <TableHead>{t("term.fix")}</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((f) => {
                  // Unticked rows dim, but their GitHub tag stays readable.
                  const off = canPost && !f.posted && !ticked.has(f.id) && "[&>td:not([data-tag])]:opacity-55";
                  return <Fragment key={f.id}>
                  <TableRow data-severity={f.severity} className={cn("[&>td]:align-top [&>td]:whitespace-normal", off, f.reason && "border-b-0 [&>td]:pb-0")}>
                    {canPost && (
                      <TableCell>
                        {!f.posted && (
                          <Checkbox aria-label={`${label("category", f.category)} ${f.file ?? ""}${f.line ? `:${f.line}` : ""}`}
                            checked={ticked.has(f.id)} disabled={posting || check.state === "loading"} onCheckedChange={(on) => toggle(f.id, on === true)} />
                        )}
                      </TableCell>
                    )}
                    {canPost && <TableCell data-tag>{tag(f)}</TableCell>}
                    <TableCell><Badge variant={severityVariant(f.severity)}>{f.severity}</Badge></TableCell>
                    <TableCell>{label("category", f.category)}</TableCell>
                    <TableCell className="[overflow-wrap:anywhere]"><code className="text-xs">{f.file ?? ""}{f.line ? `:${f.line}` : ""}</code></TableCell>
                    {hasFix && <TableCell>{f.fixSummary || "—"}</TableCell>}
                  </TableRow>
                  {/* Why the agent flagged it, so the dev can untick false positives before posting. */}
                  {f.reason && (
                    <TableRow className={cn(off)}>
                      <TableCell colSpan={(canPost ? 2 : 0) + 3 + (hasFix ? 1 : 0)} className="pt-0.5 text-xs whitespace-normal text-muted-foreground [overflow-wrap:anywhere]">{f.reason}</TableCell>
                    </TableRow>
                  )}
                  </Fragment>;
                })}
              </TableBody>
            </Table>
            {shown.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{t("detail.no_match")}</p>}
          </>
        )}
      </div>
    </FoldPanel>
  );
}
