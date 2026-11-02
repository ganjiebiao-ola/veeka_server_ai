import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import type { RunSummary } from "../types/events";
import { displayModelInfo, isNamedBranch, displayProvider, shortRepo, PROVIDERS, reviewSettings } from "../types/events";
import { scopeLabel, scopeShort } from "../components/ReportView";
import { fmtCredits, fmtDuration, fmtTokens } from "../components/RunFacts";
import { RunStatusLabel } from "../components/RunStatusLabel";
import { Page } from "../components/Page";
import { ChevronLeft, ChevronRight, Star } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge, runStatusVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Pagination, PaginationContent, PaginationEllipsis, PaginationItem } from "@/components/ui/pagination";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export interface HistoryPageProps {
  onOpenRun: (runId: string) => void;
}

export function HistoryPage(props: HistoryPageProps) {
  const { t, label, lang } = useI18n();
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState("");
  const [mode, setMode] = useState("");
  const [starred, setStarred] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [starring, setStarring] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(false);
  const request = useRef(0);
  const starPending = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const showScope = mode === "scan";

  const load = async () => {
    const current = ++request.current;
    setRefreshing(true);
    try {
      const query = new URLSearchParams({ limit: String(pageSize), offset: String((page - 1) * pageSize) });
      if (status) query.set("status", status);
      if (mode) query.set("mode", mode);
      if (starred) query.set("starred", "1");
      const r = await fetch(`/api/runs?${query}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json() as { runs: RunSummary[]; total: number };
      if (current !== request.current) return;
      const lastPage = Math.max(1, Math.ceil(j.total / pageSize));
      if (page > lastPage) { setPage(lastPage); return; }
      setRuns(j.runs);
      setTotal(j.total ?? j.runs.length);
      setError(null);
    } catch (e) {
      if (current === request.current) setError((e as Error).message);
    } finally {
      if (current === request.current) setRefreshing(false);
    }
  };

  useEffect(() => {
    void load();
    return () => { request.current++; };
  }, [page, pageSize, status, mode, starred]);

  // Phones get a narrower page window so the pager stays on one line.
  useLayoutEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia("(max-width: 639px)");
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  // The table scrolls in its own box on wide screens and with the page on phones: bring the new page's first row into view.
  const goTo = (next: number) => {
    setPage(next);
    const box = scroller.current;
    if (!box) return;
    box.scrollTop = 0;
    if (box.getBoundingClientRect().top < 0) box.scrollIntoView();
  };

  const toggleStar = async (run: RunSummary) => {
    if (starPending.current) return;
    starPending.current = true;
    setStarring(run.runId);
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(run.runId)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ starred: !run.starred }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { starPending.current = false; setStarring(null); }
  };

  return <Page>
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">{t("history.title")}</h1>
      <Button variant="outline" onClick={() => void load()} disabled={refreshing || !!starring}>
        {refreshing ? t("common.refreshing") : t("common.refresh")}
      </Button>
    </header>
    <Tabs value={starred ? "starred" : "all"} onValueChange={value => { setStarred(value === "starred"); goTo(1); }}>
      <TabsList aria-label={t("history.title")}>
        <TabsTrigger value="all" disabled={!!starring}>{t("history.all_runs")}</TabsTrigger>
        <TabsTrigger value="starred" disabled={!!starring}>{t("history.starred")}</TabsTrigger>
      </TabsList>
      <TabsContent value={starred ? "starred" : "all"} className="flex min-w-0 flex-col gap-4 pt-2">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,220px))] gap-3">
          <Label className="min-w-0 flex-col items-stretch gap-1.5"><span>{t("term.status")}</span>
            <NativeSelect className="bg-background font-normal" disabled={!!starring} value={status} onChange={e => { setStatus(e.target.value); goTo(1); }}>
              <option value="">{t("common.all")}</option>
              {["connecting", "queued", "cloning", "scanning", "completed", "failed", "aborted", "stopped"].map(value => <option key={value} value={value}>{value === "scanning" ? t("history.running") : label("run_status", value)}</option>)}
            </NativeSelect>
          </Label>
          <Label className="min-w-0 flex-col items-stretch gap-1.5"><span>{t("term.mode")}</span>
            <NativeSelect className="bg-background font-normal" disabled={!!starring} value={mode} onChange={e => { setMode(e.target.value); goTo(1); }}>
              <option value="">{t("common.all")}</option>
              {["scan", "fix"].map(value => <option key={value} value={value}>{label("mode", value)}</option>)}
            </NativeSelect>
          </Label>
        </div>
        {error && <Alert variant="destructive" role="alert"><AlertDescription>{t("common.failed_to_load", { msg: error })}</AlertDescription></Alert>}
        {refreshing && !runs && <p role="status" className="text-sm text-muted-foreground">{t("common.loading")}</p>}
        {runs && !runs.length && <p role="status" className="py-12 text-center text-muted-foreground">{t(status || mode || starred ? "history.no_match" : "history.empty")}</p>}
        {/* The wrapper scrolls both ways so the sticky header has a vertical scroller to stick to.
            Its fixed height keeps the pager in place across pages whose rows differ in height. */}
        {runs && runs.length > 0 && <div ref={scroller} className="h-[70vh] scroll-mt-16 overflow-auto rounded-lg border bg-card aria-busy:opacity-60 [&_[data-slot=table-container]]:overflow-visible max-sm:h-auto max-sm:overflow-visible max-sm:rounded-none max-sm:border-0 max-sm:bg-transparent" aria-busy={refreshing}>
          <Table className="max-sm:block">
            <TableHeader className="sticky top-0 z-20 bg-card max-sm:sr-only"><TableRow>
              <TableHead>{t("term.run_number")}</TableHead><TableHead>{t("term.repo")}</TableHead><TableHead>{t("term.mode")}</TableHead>
              {showScope && <TableHead>{t("term.scope")}</TableHead>}
              <TableHead>{t("term.model")}</TableHead><TableHead>{t("term.status")}</TableHead><TableHead className="text-right">{t("term.tokens")}</TableHead><TableHead className="text-right">{t("term.duration")}</TableHead><TableHead>{t("history.starred")}</TableHead>
            </TableRow></TableHeader>
            <TableBody className="max-sm:block">{runs.map(r => {
              const review = reviewSettings(r);
              const info = displayModelInfo(r, t("common.unspecified"), t("common.requested"));
              const scope = r.mode === "scan" ? scopeShort(t, r.skill, r.categories, r.mode) : undefined;
              return <TableRow key={r.runId} className="relative has-[a:focus-visible]:outline-2 has-[a:focus-visible]:-outline-offset-2 has-[a:focus-visible]:outline-ring max-sm:mb-3 max-sm:block max-sm:rounded-lg max-sm:border max-sm:bg-card max-sm:p-3 max-sm:last:border!">
                <TableCell className={cell} data-label={t("term.run_number")}>
                  {/* The link's ::after covers the whole row so any click on it opens the run. */}
                  <a className="font-medium text-primary underline-offset-4 outline-none after:absolute after:inset-0 hover:underline" href={`/runs/${encodeURIComponent(r.runId)}`}
                    onKeyDown={e => { if (e.key === " ") { e.preventDefault(); props.onOpenRun(r.runId); } }}
                    onClick={e => { if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) { e.preventDefault(); props.onOpenRun(r.runId); } }}>
                    #{r.runNumber}
                  </a><span className={secondary}>{fmtTime(r.startedAt)}</span>
                </TableCell>
                <TableCell className={`${cell} font-medium`} data-label={t("term.repo")}>{shortRepo(r.repoUrl)}{isNamedBranch(r.branch) && <code className={`${secondary} font-mono font-normal`}>{r.branch}</code>}</TableCell>
                <TableCell className={cell} data-label={t("term.mode")}>{label("mode", r.mode)}{!showScope && scope && <span className={secondary}>{scope}</span>}</TableCell>
                {showScope && <TableCell className={cell} data-label={t("term.scope")} title={scopeLabel(t, r.skill, r.categories, r.mode)}>{scope ?? "—"}</TableCell>}
                <TableCell className={cell} data-label={t("term.model")} title={info.reportedId}>{r.mode === "fix" && `${t("role.fix")}: `}{info.model}<span className={secondary}>{displayProvider(r, t)}{PROVIDERS[r.provider ?? "claude"].efforts.length > 0 && ` · ${label("effort", info.effort)}`}</span>
                  {r.mode === "fix" && <span className={secondary}>{t("run.review_provider", { provider: PROVIDERS[review.provider].label })} · {review.model}{PROVIDERS[review.provider].efforts.length > 0 && ` · ${label("effort", review.effort)}`}</span>}
                </TableCell>
                <TableCell className={cell} data-label={t("term.status")}><Badge variant={runStatusVariant(r.status)}><RunStatusLabel run={r} /></Badge></TableCell>
                <TableCell className={`${cell} text-right tabular-nums max-sm:text-left`} data-label={t("term.tokens")} title={tokensTooltip(r, t)}>{totalTokens(r, t)}</TableCell>
                <TableCell className={`${cell} text-right tabular-nums max-sm:text-left`} data-label={t("term.duration")}>{fmtDuration(r.startedAt, r.finishedAt, lang)}</TableCell>
                <TableCell className={cell} data-label={t("history.starred")}><Button type="button" variant="ghost" size="icon-sm" className="relative z-10" aria-pressed={!!r.starred}
                  aria-label={t(r.starred ? "history.unstar" : "history.star", { number: r.runNumber })} disabled={!!starring || refreshing}
                  onClick={() => void toggleStar(r)}><Star aria-hidden="true" className={r.starred ? "fill-amber-400 text-amber-500" : "text-muted-foreground"} /></Button></TableCell>
              </TableRow>;
            })}</TableBody>
          </Table>
        </div>}
        {runs && total > 0 && <Pagination aria-label={t("history.pagination")} className="flex-wrap items-center gap-x-4 gap-y-3">
          <PaginationContent>
            <PaginationItem><Button variant="ghost" size="icon" aria-label={t("history.previous")} disabled={page === 1 || !!starring} onClick={() => goTo(page - 1)}><ChevronLeft aria-hidden="true" /></Button></PaginationItem>
            {pageItems(page, pages, narrow ? 0 : 1).map((n, i) => n === "gap"
              ? <PaginationItem key={`gap-${i}`}><PaginationEllipsis /></PaginationItem>
              : <PaginationItem key={n}><Button variant={n === page ? "outline" : "ghost"} size="icon" className="w-auto min-w-9 px-2 tabular-nums" aria-label={t("history.page", { page: n, pages })} aria-current={n === page ? "page" : undefined}
                disabled={!!starring} onClick={() => goTo(n)}>{n}</Button></PaginationItem>)}
            <PaginationItem><Button variant="ghost" size="icon" aria-label={t("history.next")} disabled={page >= pages || !!starring} onClick={() => goTo(page + 1)}><ChevronRight aria-hidden="true" /></Button></PaginationItem>
          </PaginationContent>
          <div className="flex items-center gap-3">
            <div className="w-32"><NativeSelect className="bg-background" aria-label={t("history.page_size")} disabled={!!starring} value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); goTo(1); }}>
              {[10, 50, 100].map(size => <option key={size} value={size}>{t("history.per_page", { n: size })}</option>)}
            </NativeSelect></div>
            <Label className="font-normal whitespace-nowrap">{t("history.go_to")}
              <Input type="number" inputMode="numeric" min={1} max={pages} className="w-16" disabled={!!starring} onKeyDown={e => {
                const value = e.currentTarget.value;
                const n = Math.round(Number(value));
                if (e.key !== "Enter" || !value.trim() || !Number.isFinite(n)) return;
                goTo(Math.min(Math.max(n, 1), pages));
                e.currentTarget.value = "";
              }} />
            </Label>
          </div>
          <span role="status" className="sr-only">{t("history.page", { page, pages })}</span>
        </Pagination>}
      </TabsContent>
    </Tabs>
  </Page>;
}

// First and last page, a window around the current one, and a gap only where it hides two or more pages.
function pageItems(page: number, pages: number, siblings: number): (number | "gap")[] {
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  if (pages <= 2 * siblings + 5) return range(1, pages);
  const start = Math.max(Math.min(page - siblings, pages - 2 * siblings - 2), 3);
  const end = Math.min(Math.max(page + siblings, 2 * siblings + 3), pages - 2);
  return [1, start > 3 ? "gap" : 2, ...range(start, end), end < pages - 2 ? "gap" : pages - 1, pages];
}

const secondary = "block text-[13px] font-normal text-muted-foreground";
// Under 640px each row is a card: the cell's data-label becomes a left column beside its value.
const cell = "align-top whitespace-normal max-sm:grid max-sm:grid-cols-[minmax(5rem,30%)_minmax(0,1fr)] max-sm:gap-x-3 max-sm:gap-y-1 max-sm:px-0 max-sm:py-1.5 max-sm:[overflow-wrap:anywhere] max-sm:before:col-start-1 max-sm:before:row-span-3 max-sm:before:font-normal max-sm:before:text-muted-foreground max-sm:before:content-[attr(data-label)] max-sm:[&>*]:col-start-2";

function fmtTime(ts?: number): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${mo}/${da} ${hh}:${mm}`;
}

// Qoder runs show credits, Qoder's billing unit; a mixed fix run shows both.
function totalTokens(r: RunSummary, t: (key: string, params?: Record<string, string>) => string): string {
  const tokens = fmtTokens(r.usage);
  const credits = r.provider === "qoder" || r.usage?.credits ? t("run.facts_credits", { n: fmtCredits(r.usage?.credits) }) : "";
  if (r.provider === "qoder") return tokens === "—" ? credits : `${credits} · ${tokens}`;
  return credits ? `${tokens} · ${credits}` : tokens;
}

function tokensTooltip(r: RunSummary, t: (key: string, params?: Record<string, number>) => string): string {
  const u = r.usage;
  if (!u || fmtTokens(u) === "—") return "";
  return t("history.tokens_title", { in: u.inputTokens, out: u.outputTokens, read: u.cacheReadTokens, write: u.cacheCreateTokens });
}
