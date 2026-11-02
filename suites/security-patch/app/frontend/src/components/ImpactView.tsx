import { useState } from "react"
import { ChevronRight, TriangleAlert, X } from "lucide-react"
import { impactSummary, found, inPR, isImported, prNumber, severityCounts, type Coverage, type SummaryPR } from "../../../shared/impact"
import type { TrackerRow } from "./TrackerModal"
import { Reason } from "./Reason"
import { SeverityGuide } from "./SeverityGuide"
import { useI18n } from "../i18n"
import { cn } from "@/lib/utils"
import { Badge, severityVariant } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

type Preset = { title: string, ids?: string[], category?: string, pr?: number, severity?: string[], statuses?: string[], prs?: number[], population?: "tool" | "imported" | "all" }
const priorities = ["P0", "P1", "P2"]
const statuses = ["open", "needs human", "in progress", "fixed", "ignored"]
const outcomes = ["full", "partial", "rejected", "unknown", "open"] as const
// Chart fills. Text always states the series too, so color is never the only cue.
const SEVERITY_FILL: Record<string, string> = { P0: "bg-red-700 text-white", P1: "bg-amber-500 text-black", P2: "bg-blue-700 text-white", "": "bg-neutral-400 text-black" }
const OUTCOME_FILL: Record<string, string> = { full: "bg-emerald-500", partial: "bg-amber-400", rejected: "bg-pink-400", unknown: "bg-violet-600", open: "bg-green-700", excluded: "bg-neutral-400" }
const swatch = "inline-block size-3 flex-none rounded-[3px]"
const touch = "max-sm:h-10"
const rowLink = "relative has-[[data-testid=impact-row-link]:focus-visible]:outline-2 has-[[data-testid=impact-row-link]:focus-visible]:-outline-offset-2 has-[[data-testid=impact-row-link]:focus-visible]:outline-ring"
const linkButton = "text-left font-semibold text-foreground outline-none [overflow-wrap:anywhere] after:absolute after:inset-0"
const toggle = (values: string[], value: string) => values.includes(value) ? values.filter(item => item !== value) : [...values, value]

export function ImpactView({ rows, prs, categories, coverage, pickHref, reopen, reopening, readPR, closePR }: {
  rows: TrackerRow[], prs: SummaryPR[], categories: string[], coverage?: Coverage, pickHref: string,
  reopen(id: string): void, reopening: string | null, readPR(pr: SummaryPR): void, closePR(pr: SummaryPR): void,
}) {
  const { t, label, lang } = useI18n()
  const [tab, setTab] = useState("summary")
  const [search, setSearch] = useState("")
  const [panel, setPanel] = useState<Preset | null>(null)
  const summary = impactSummary(rows, prs)
  const tool = rows.filter(found)
  const match = (value: string) => value.toLowerCase().includes(search.toLowerCase())
  const open = (preset: Preset) => setPanel(preset)
  const severityText = (counts: Record<string, number>) => [...priorities, ...(counts[""] ? [""] : [])].map(key => `${key || t("impact.unrated")} ${counts[key] ?? 0}`).join(" · ")
  const titles = ["found", "in_pr", "prs", "p0"]
  const values = [summary.found, summary.inPR, summary.prs, summary.p0.total]
  const sublines = [severityText(summary.severity), t("impact.merged_so_far", { n: summary.merged }),
    outcomes.slice(0, 3).map(key => `${t(`impact.${key}`)} ${summary.outcomes[key]}`).join(" · "),
    t("impact.p0_detail", { open: summary.p0.open, human: summary.p0.human, pr: summary.p0.inPR })]
  const number = (value: number) => value.toLocaleString(lang === "zh" ? "zh-CN" : "en")
  const lastScanAge = (time: number) => new Intl.RelativeTimeFormat(lang === "zh" ? "zh-CN" : "en", { numeric: "auto" }).format(-Math.max(0, Math.round((Date.now() - time) / 864e5)), "day")
  const coverageText = coverage ? [
    t("impact.coverage_types", { n: coverage.scanned.length, total: coverage.applicable.length }),
    ...(coverage.coveredFiles != null && coverage.consideredFiles != null ? [t("impact.coverage_files", { n: number(coverage.coveredFiles), total: number(coverage.consideredFiles) })] : []),
    coverage.lastScan ? t("impact.last_scan", { when: lastScanAge(coverage.lastScan) }) : t("impact.no_scan"),
  ].join(" · ") : t("impact.no_scan")
  const openOutcome = (outcome: typeof outcomes[number]) => open({ title: t(`impact.${outcome}`), prs: prs.filter(pr => !pr.imported && pr.outcome === outcome).map(pr => pr.number), ids: prs.filter(pr => !pr.imported && pr.outcome === outcome).flatMap(pr => pr.rowIds), population: "tool" })
  const presets: Preset[] = [
    { title: t("impact.found"), population: "tool", ids: tool.map(row => row.id) },
    { title: t("impact.in_pr"), population: "tool", ids: tool.filter(inPR).map(row => row.id) },
    { title: t("impact.prs"), population: "tool", prs: prs.filter(pr => !pr.imported && pr.outcome !== "excluded").map(pr => pr.number), ids: prs.filter(pr => !pr.imported && pr.outcome !== "excluded").flatMap(pr => pr.rowIds) },
    { title: t("impact.p0"), population: "tool", severity: ["P0"], statuses: ["open", "needs human", "in progress"] },
  ]
  const outcomeTotal = outcomes.reduce((sum, outcome) => sum + summary.outcomes[outcome], 0)
  const unscannedText = coverage?.unscanned.length ? coverage.unscanned.map(category => label("category", category)).join(" · ") : ""
  const severityKeys = [...priorities, ...(summary.severity[""] ? [""] : [])]
  return <>
    <Tabs value={tab} onValueChange={key => { setTab(key); setSearch("") }} className="gap-3">
      <TabsList variant="line" aria-label={t("overview.title")} className="w-full justify-start gap-4 rounded-none border-b p-0 group-data-[orientation=horizontal]/tabs:h-auto">
        {["summary", "types", "prs_tab"].map(key => <TabsTrigger key={key} value={key} className="h-10 flex-none px-1 group-data-[orientation=horizontal]/tabs:after:-bottom-px">{t(`impact.${key}`)}</TabsTrigger>)}
      </TabsList>
      {/* One panel whose value tracks the active tab, so Types and PRs share the table card. */}
      <TabsContent value={tab} className="flex min-w-0 flex-col gap-4">
      {tab === "summary" ? <>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">{titles.map((key, i) => <button key={key} type="button" onClick={() => open(presets[i])}
          className={cn("relative flex min-w-0 flex-col gap-1 overflow-hidden rounded-xl border bg-card p-4 text-left text-card-foreground shadow-sm transition-colors outline-none hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50",
            i === 3 && "before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-red-700")}>
          <span className="flex flex-wrap items-center justify-between gap-x-2 text-[13px] font-medium text-muted-foreground">{t(`impact.${key}`)}{i === 3 && <span className="inline-flex flex-none items-center gap-1 text-xs font-semibold text-red-700 dark:text-red-400"><TriangleAlert aria-hidden="true" className="size-3.5" />{t("impact.critical")}</span>}</span>
          <span className="text-3xl leading-tight font-bold tracking-tight tabular-nums">{number(values[i])}</span><span className="text-xs leading-snug text-muted-foreground">{sublines[i]}</span>
        </button>)}</div>
        <p className="text-[13px] text-muted-foreground"><span data-testid="impact-coverage" className="block truncate" title={`${coverageText}${unscannedText ? ` · ${t("impact.unscanned")}: ${unscannedText}` : ""}`}>{coverageText}
          {!!unscannedText && <span> · {t("impact.unscanned")}: {unscannedText}</span>}</span></p>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Card role="region" aria-labelledby="impact-funnel-title">
            <CardHeader className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
              <div><h2 id="impact-funnel-title" className="leading-none font-semibold">{t("impact.funnel")}</h2><p className="mt-1.5 text-[13px] text-muted-foreground">{t("impact.funnel_desc")}</p></div>
              <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">{severityKeys.map(key => <li key={key} className="inline-flex items-center gap-1.5">
                <span className={cn(swatch, SEVERITY_FILL[key])} aria-hidden="true" />{key || t("impact.unrated")}</li>)}<li className="inline-flex"><SeverityGuide /></li></ul>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {summary.stages.map((stage, i) => {
                const next = summary.stages[i + 1]
                const dropped = next ? rows.filter(row => stage.rowIds.includes(row.id) && !next.rowIds.includes(row.id)) : []
                const human = dropped.filter(row => row.severity === "P0" && row.status === "needs human").length
                return <div key={stage.key} className="grid items-center gap-x-4 gap-y-1 sm:grid-cols-[168px_minmax(0,1fr)]">
                  <button type="button" className="group flex items-baseline justify-between gap-2 text-left" onClick={() => open({ title: t(`impact.stage_${stage.key}`), ids: stage.rowIds, population: "tool" })}>
                    <span className="text-sm font-medium text-muted-foreground group-hover:text-foreground group-hover:underline">{t(`impact.stage_${stage.key}`)}</span><strong className="text-base font-semibold tabular-nums">{number(stage.total)}</strong>
                  </button>
                  <div className="h-6 overflow-hidden rounded-md bg-muted"><div className="flex h-full gap-0.5 overflow-hidden rounded-md bg-card" style={{ width: `${summary.found ? stage.total / summary.found * 100 : 0}%` }}>
                    {[...priorities, ...(stage.severity[""] ? [""] : [])].map(severity => stage.severity[severity] > 0 && <button key={severity} type="button"
                      className={cn("@container min-w-0 basis-0 overflow-hidden px-1 text-xs leading-6 font-semibold whitespace-nowrap hover:brightness-110", SEVERITY_FILL[severity])}
                      style={{ flexGrow: stage.severity[severity] }} title={`${severity || t("impact.unrated")} ${stage.severity[severity]}`} aria-label={`${t(`impact.stage_${stage.key}`)} ${severity || t("impact.unrated")} ${stage.severity[severity]}`}
                      onClick={() => open({ title: t(`impact.stage_${stage.key}`), ids: stage.rowIds, severity: [severity], population: "tool" })}><span className="@max-[56px]:hidden">{severity || "?"} {stage.severity[severity]}</span></button>)}
                  </div></div>
                  <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{severityText(stage.severity)}</p>
                  {next ? <button type="button" className="text-left text-xs leading-snug text-muted-foreground hover:text-foreground hover:underline" onClick={() => open({ title: t(`impact.drop_${next.key}`), ids: dropped.map(row => row.id), population: "tool" })}>
                    {t(`impact.drop_${next.key}`, { n: dropped.length })} · {severityText(severityCounts(dropped))}{human > 0 && ` · ${t("impact.human_waits", { n: human })}`}
                  </button> : <span />}
                </div>
              })}
            </CardContent>
            <CardFooter className="border-t">
              <button type="button" className="text-left text-xs leading-snug text-muted-foreground hover:text-foreground hover:underline" onClick={() => open({ title: t("impact.imported_title"), population: "imported" })}>{t("impact.imported", { n: summary.imported.total, fixed: summary.imported.fixed, progress: summary.imported.progress, open: summary.imported.open })}</button>
            </CardFooter>
          </Card>
          <Card role="region" aria-labelledby="impact-outcomes-title">
            <CardHeader>
              <h2 id="impact-outcomes-title" className="leading-none font-semibold">{t("impact.outcomes")}</h2><p className="text-[13px] text-muted-foreground">{t("impact.outcomes_desc")}</p>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="flex items-baseline gap-2"><strong className="text-3xl leading-tight font-bold tracking-tight tabular-nums">{number(outcomeTotal)}</strong><span className="text-[13px] text-muted-foreground">{t("impact.prs")}</span></p>
              <div className="flex h-6 gap-0.5 overflow-hidden rounded-md bg-muted">{outcomes.map(outcome => summary.outcomes[outcome] > 0 && <button key={outcome} type="button" className={cn("min-w-0 basis-0 hover:brightness-110", OUTCOME_FILL[outcome])} style={{ flexGrow: summary.outcomes[outcome] }}
                title={`${t(`impact.${outcome}`)} ${summary.outcomes[outcome]}`} aria-label={`${t(`impact.${outcome}`)} ${summary.outcomes[outcome]}`} onClick={() => openOutcome(outcome)} />)}</div>
              <ul className="flex flex-col">{outcomes.map(outcome => <li key={outcome} className="border-b last:border-b-0"><button type="button" data-testid="outcome-chip" onClick={() => openOutcome(outcome)}
                className="grid w-full grid-cols-[12px_minmax(0,1fr)_auto_44px] items-center gap-2 rounded-sm px-1 py-2 text-left text-sm hover:bg-accent/50">
                <span data-testid="outcome-swatch" className={cn(swatch, OUTCOME_FILL[outcome])} aria-hidden="true" />
                <span>{t(`impact.${outcome}`)}</span>
                <span className="text-right font-semibold tabular-nums">{number(summary.outcomes[outcome])}</span>
                <span className="text-right text-[13px] text-muted-foreground tabular-nums">{outcomeTotal ? Math.round(summary.outcomes[outcome] / outcomeTotal * 100) : 0}%</span></button></li>)}</ul>
              <Collapsible>
                <CollapsibleTrigger className="group inline-flex items-center gap-1.5 text-[13px] font-medium underline-offset-4 hover:underline">
                  <ChevronRight aria-hidden="true" className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />{t("impact.how_defined")}
                </CollapsibleTrigger>
                <CollapsibleContent><p className="mt-2 text-[13px] leading-normal text-muted-foreground">{t("impact.definitions")}</p></CollapsibleContent>
              </Collapsible>
            </CardContent>
          </Card>
        </div>
      </> : <Card className="gap-0 overflow-hidden py-0">
        <div className="border-b px-4 py-3">
          <Input type="search" className="max-w-xs" aria-label={t("impact.search")} placeholder={t("impact.search")} value={search} onChange={event => setSearch(event.target.value)} />
        </div>
        {tab === "types" ? <Table>
          <TableHeader><TableRow><TableHead className="px-4">{t("term.bug_types")}</TableHead>{["impact.stage_found", "finding_status.open", "finding_status.in progress", "finding_status.fixed"].map(key => <TableHead key={key} className="px-4 text-right">{t(key)}</TableHead>)}</TableRow></TableHeader>
          <TableBody>{categories.filter(category => match(`${category} ${label("category", category)}`)).map(category => {
            const categoryRows = tool.filter(row => row.category === category)
            const groups = [categoryRows, ...["open", "in progress", "fixed"].map(status => categoryRows.filter(row => row.status === status))]
            return <TableRow key={category} data-testid="impact-row" className={rowLink}>
              <TableHead scope="row" className="px-4 whitespace-normal"><button type="button" data-testid="impact-row-link" className={linkButton} onClick={() => open({ title: label("category", category), category, population: "tool" })}>{label("category", category)}</button></TableHead>
              {groups.map((group, i) => <TableCell key={i} className={cn("px-4 py-2.5 text-right tabular-nums", !group.length && "text-muted-foreground")}>{group.length}{group.length > 0 && <small className="block text-xs text-muted-foreground">{severityText(severityCounts(group))}</small>}</TableCell>)}
            </TableRow>
          })}</TableBody>
        </Table> : <Table>
          <TableHeader><TableRow><TableHead className="px-4">{t("impact.prs_tab")}</TableHead><TableHead className="px-4">{t("term.bug_types")}</TableHead><TableHead className="px-4 text-right">{t("impact.rows_label")}</TableHead><TableHead className="px-4">{t("impact.outcome")}</TableHead><TableHead className="px-4"><span className="sr-only">GitHub</span></TableHead></TableRow></TableHeader>
          {[false, true].map(imported => <TableBody key={String(imported)}>
            <TableRow className="bg-muted/50 hover:bg-muted/50"><TableHead scope="rowgroup" colSpan={5} className="h-8 px-4 text-xs text-muted-foreground">{t(imported ? "impact.imported_title" : "impact.prs")}</TableHead></TableRow>
            {prs.filter(pr => pr.imported === imported && match(`${pr.number} ${pr.title} ${pr.categories.join(" ")} ${pr.categories.map(category => label("category", category)).join(" ")}`)).map(pr => <TableRow data-testid="impact-row" className={rowLink} key={pr.number}>
              <TableCell className="min-w-[220px] px-4 whitespace-normal"><button type="button" data-testid="impact-row-link" className={linkButton} onClick={() => open({ title: `#${pr.number} ${pr.title}`, pr: pr.number, population: "all" })}>#{pr.number} {pr.title}</button></TableCell>
              <TableCell className="min-w-[200px] px-4 whitespace-normal text-muted-foreground [overflow-wrap:anywhere]">{pr.categories.map(category => label("category", category)).join(" · ") || "—"}</TableCell>
              <TableCell className="px-4 text-right tabular-nums">{pr.rowIds.length}</TableCell>
              <TableCell className="px-4">{!imported && <span className="inline-flex items-center gap-2"><span className={cn(swatch, OUTCOME_FILL[pr.outcome])} aria-hidden="true" />{t(`impact.${pr.outcome}`)}</span>}</TableCell>
              <TableCell className="px-4 text-right"><a className="relative z-10 text-[13px]" href={pr.url} target="_blank" rel="noopener noreferrer" aria-label={`GitHub PR #${pr.number}`}>GitHub ↗</a></TableCell>
            </TableRow>)}
          </TableBody>)}
        </Table>}
      </Card>}
      </TabsContent>
    </Tabs>
    {panel && <ImpactPanel key={JSON.stringify(panel)} preset={panel} rows={rows} prs={prs} pickHref={pickHref} onClose={() => setPanel(null)} reopen={reopen} reopening={reopening} readPR={readPR} closePR={closePR} />}
  </>
}

function ImpactPanel({ preset, rows, prs, pickHref, onClose, reopen, reopening, readPR, closePR }: {
  preset: Preset, rows: TrackerRow[], prs: SummaryPR[], pickHref: string, onClose(): void,
  reopen(id: string): void, reopening: string | null, readPR(pr: SummaryPR): void, closePR(pr: SummaryPR): void,
}) {
  const { t, label } = useI18n()
  const [search, setSearch] = useState("")
  const [severity, setSeverity] = useState(preset.severity ?? [])
  const [status, setStatus] = useState(preset.statuses ?? [])
  const [expanded, setExpanded] = useState<string[]>([])
  // Read during the first render, before the sheet takes focus.
  const [opener] = useState(() => typeof document === "undefined" ? null : document.activeElement as HTMLElement | null)
  const single = preset.pr ? prs.find(pr => pr.number === preset.pr) : undefined
  const visible = rows.filter(row => (!preset.ids || preset.ids.includes(row.id)) && (!preset.category || row.category === preset.category) &&
    (!preset.pr || prNumber(row) === preset.pr || prs.find(pr => pr.number === preset.pr)?.rowIds.includes(row.id)) && (preset.population === "all" || (preset.population === "imported" ? isImported(row) : !isImported(row))) &&
    (!severity.length || severity.includes(row.severity)) && (!status.length || status.includes(row.status)) &&
    `${row.file} ${row.category} ${label("category", row.category)} ${row.reason} ${row.pr}`.toLowerCase().includes(search.toLowerCase()))
  return <Sheet open onOpenChange={open => { if (!open) onClose() }}>
    <SheetContent showCloseButton={false} aria-describedby={undefined} className="w-full gap-0 sm:max-w-[480px]"
      onCloseAutoFocus={event => { event.preventDefault(); if (opener?.isConnected) opener.focus() }}>
      <SheetHeader className="flex-row items-start justify-between gap-3 border-b px-5 py-4 max-sm:px-4">
        <div className="min-w-0"><SheetTitle className="leading-snug [overflow-wrap:anywhere]">{preset.title}</SheetTitle><p className="mt-0.5 text-xs text-muted-foreground" role="status">{t("impact.rows", { n: visible.length })}</p></div>
        <div className="flex flex-none items-center gap-2">
          {single && !single.imported && <>
            <Button variant="outline" size="sm" className={touch} onClick={() => readPR(single)}>{t("impact.read_pr")}</Button>
            {single.outcome === "open" && <Button variant="outline" size="sm" className={touch} onClick={() => closePR(single)}>{t("overview.close_pr")}</Button>}
          </>}
          <Button variant="ghost" size="icon-sm" className="max-sm:size-10" aria-label={t("overview.close_tracker")} onClick={onClose}><X /></Button>
        </div>
      </SheetHeader>
      <div className="flex flex-col gap-3 border-b px-5 py-3 max-sm:px-4">
        {!!preset.prs?.length && <div className="flex flex-wrap gap-x-3 gap-y-2 text-[13px]">{prs.filter(pr => preset.prs?.includes(pr.number)).map(pr => <a key={pr.number} href={pr.url} target="_blank" rel="noopener noreferrer">PR #{pr.number} ↗</a>)}</div>}
        <Input type="search" value={search} onChange={event => setSearch(event.target.value)} aria-label={t("impact.panel_search")} placeholder={t("impact.panel_search")} />
        {[["term.severity", [...priorities, ""], severity, setSeverity], ["term.status", statuses, status, setStatus]].map(([title, choices, selected, set]) => <div role="group" aria-labelledby={`impact-filter-${title}`} className="flex flex-wrap items-center gap-1.5" key={title as string}>
          <span id={`impact-filter-${title}`} className="min-w-14 text-xs font-semibold text-muted-foreground">{t(title as string)}</span>
          {(choices as string[]).map(value => <Button key={value} type="button" size="xs" variant={(selected as string[]).includes(value) ? "default" : "outline"} className="max-sm:h-8" aria-pressed={(selected as string[]).includes(value)}
            onClick={() => (set as (values: string[]) => void)(toggle(selected as string[], value))}>{title === "term.status" ? label("finding_status", value) : value || t("impact.unrated")}</Button>)}
        </div>)}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 max-sm:px-4">
        {!visible.length && <p className="pt-4 text-sm text-muted-foreground">{t("overview.empty_filtered")}</p>}
        {visible.map(row => {
          // A row can belong to several PRs (e.g. a test PR and its replacement), so prefer the PR this panel is about, then the newest.
          const linked = prs.filter(pr => pr.number === prNumber(row) || pr.rowIds.includes(row.id)).sort((a, b) => b.number - a.number)
          const panelPRs = preset.prs ?? (preset.pr ? [preset.pr] : [])
          const pr = linked.find(pr => panelPRs.includes(pr.number)) ?? linked.find(pr => pr.number === prNumber(row)) ?? linked[0]
          const isExpanded = expanded.includes(row.id)
          return <article key={row.id} data-testid="impact-finding" className="border-b py-3">
            <button type="button" data-testid="impact-finding-toggle" aria-expanded={isExpanded} onClick={() => setExpanded(toggle(expanded, row.id))}
              className="group grid w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1 rounded-sm text-left [overflow-wrap:anywhere]">
              <Badge variant={severityVariant(row.severity)}>{row.severity || t("impact.unrated")}</Badge>
              <code className="text-xs font-semibold">{row.file}:{row.lines[0]}</code>
              <span className="col-span-full line-clamp-2 text-sm text-muted-foreground group-hover:text-foreground">{row.reason.split("\n")[0]}</span>
              <small className="col-span-full text-xs text-muted-foreground">{label("category", row.category)} · {label("finding_status", row.status)}</small>
            </button>
            {pr && <a data-testid="impact-finding-pr" className="mt-1 inline-block text-xs" href={pr.url} target="_blank" rel="noopener noreferrer">PR #{pr.number} ↗</a>}
            {isExpanded && <div className="mt-3 flex flex-col gap-2 text-[13px] [overflow-wrap:anywhere]"><code>{row.file}:{row.lines.join(",")}</code><Reason text={row.reason} />
              <div className="flex flex-wrap items-center gap-2">
                {["needs human", "ignored"].includes(row.status) && <Button variant="outline" size="sm" className={touch} disabled={reopening !== null} onClick={() => reopen(row.id)}>{reopening === row.id ? t("common.working") : t("overview.reopen")}</Button>}
                {pr && !pr.imported && <Button variant="outline" size="sm" className={touch} onClick={() => readPR(pr)}>{t("impact.read_pr")}</Button>}
                {pr?.outcome === "open" && !pr.imported && <Button variant="outline" size="sm" className={touch} onClick={() => closePR(pr)}>{t("overview.close_pr")}</Button>}
                <Button asChild variant="outline" size="sm" className={touch}><a href={pickHref}>{t("overview.pick_fixes")} →</a></Button>
              </div>
            </div>}
          </article>
        })}
      </div>
    </SheetContent>
  </Sheet>
}
