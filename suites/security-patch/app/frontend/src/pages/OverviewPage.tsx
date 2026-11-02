import { VULN_CATEGORIES } from "../types/events";
import { ImpactView, PRReader } from "../components/lazy"
import type { Coverage, SummaryPR } from "../../../shared/impact"
import { Suspense, useEffect, useRef, useState } from "react"
import { useI18n } from "../i18n"
import { TrackerSelect } from "../components/TrackerSelect"
import { type TrackerRow } from "../components/TrackerModal"
import { useRepoParam } from "../router"
import { Page } from "../components/Page"
import { Check, ChevronDown, LoaderCircle, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"

type Overview = {
  repo: string
  prs?: SummaryPR[]
  coverage?: Coverage
  availableTypes: string[]
  types: { category: string; url: string | null; rows: TrackerRow[]; total: number; counts: Record<string, number> }[]
  openPRs: { number: number; title: string; draft: boolean; url: string }[]
  needsHuman: { id: string; category: string; url: string; file: string; lines: number[]; reason: string; severity: string }[]
  ignored?: { id: string; category: string; file: string; lines: number[]; reason: string }[]
}

export function filterOverview(data: Overview, categories: string[], priorities: string[]): Overview {
  if (!categories.length && !priorities.length) return data
  const relevantPRs = new Set<number>()
  const ignoredIds = new Set<string>()
  const types = data.types.filter(row => !categories.length || categories.includes(row.category)).map(type => {
    const rows = type.rows.filter(row => !priorities.length || priorities.includes(row.severity))
    for (const row of rows) {
      const pr = /^\[PR #(\d+)\]\(https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+\)$/.exec(row.pr)
      if (pr) relevantPRs.add(Number(pr[1]))
      if (row.status === "ignored") ignoredIds.add(row.id)
    }
    return priorities.length ? { ...type, rows, total: rows.length, counts: Object.fromEntries(["open", "in progress", "fixed", "ignored"].map(status => [status, rows.filter(row => row.status === status).length])) } : type
  }).filter(type => !priorities.length || type.total > 0)
  const visibleIds = new Set(types.flatMap(type => type.rows.map(row => row.id)))
  // A closed PR resets its rows to pr:"", so it owns them only through rowIds. A PR with no rows can match by category alone.
  const prs = data.prs?.map(pr => ({ ...pr, rowIds: pr.rowIds.filter(id => visibleIds.has(id)) }))
    .filter((pr, i) => relevantPRs.has(pr.number) || pr.rowIds.length || (!data.prs![i].rowIds.length && !priorities.length && data.prs![i].categories.some(category => categories.includes(category))))
  for (const pr of prs ?? []) relevantPRs.add(pr.number)
  return { ...data, types, prs, openPRs: data.openPRs.filter(pr => relevantPRs.has(pr.number)),
    needsHuman: data.needsHuman.filter(row => (!categories.length || categories.includes(row.category)) && (!priorities.length || priorities.includes(row.severity ?? ""))),
    ignored: data.ignored?.filter(row => priorities.length ? ignoredIds.has(row.id) : !categories.length || categories.includes(row.category)) }
}

// Same order and values as CLOSE_STEPS and CLOSE_REASONS in backend/tracker/close_pr.ts.
const CLOSE_STEPS = ["comment", "close", "branch", "rows"] as const
const CLOSE_REASONS = ["test", "bad-fix", "replaced"] as const
const NOTE_MAX = 500
type StepState = "run" | "ok" | "fail"

// Closes one suite PR, one backend call per step. Each step is safe to repeat, so Retry runs the rest again.
export function ClosePRDialog({ repo, pr, onDone }: { repo: string; pr: Overview["openPRs"][number]; onDone: (changed: boolean) => void }) {
  const { t } = useI18n()
  // Read during the first render, before the dialog takes focus.
  const [opener] = useState(() => typeof document === "undefined" ? null : document.activeElement as HTMLElement | null)
  const [reason, setReason] = useState<string>()
  const [note, setNote] = useState("")
  const [states, setStates] = useState<Partial<Record<string, StepState>>>({})
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const started = Object.keys(states).length > 0
  const done = states.rows === "ok"

  async function run() {
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    setError("")
    let next = { ...states }
    const mark = (step: string, state: StepState) => { next = { ...next, [step]: state }; setStates(next) }
    for (const step of CLOSE_STEPS) {
      if (next[step] === "ok") continue
      mark(step, "run")
      try {
        const r = await fetch(`/api/overview/prs/${pr.number}/close`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo, step, reason, note }),
        })
        const body = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`)
        mark(step, "ok")
      } catch (e) {
        mark(step, "fail")
        setError((e as Error).message)
        break
      }
    }
    submitting.current = false
    setBusy(false)
  }

  return (
    <AlertDialog open onOpenChange={open => { if (!open && !busy) onDone(started) }}>
      <AlertDialogContent onCloseAutoFocus={event => {
        // A disabled opener cannot take focus back, so the page does.
        event.preventDefault()
        if (opener?.isConnected && !opener.matches(":disabled")) opener.focus()
        else document.querySelector<HTMLElement>("main")?.focus()
      }}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("overview.close_title", { number: pr.number })}</AlertDialogTitle>
          <AlertDialogDescription className="[overflow-wrap:anywhere]">{pr.title}</AlertDialogDescription>
        </AlertDialogHeader>
        {!started ? <div className="flex min-w-0 flex-col gap-3">
          <p className="text-[13px] text-muted-foreground">{t("overview.close_explain")}</p>
          <fieldset className="min-w-0">
            <legend className="mb-2 text-[13px] font-medium">{t("overview.close_reason")}</legend>
            <div className="flex flex-wrap gap-2">
              {CLOSE_REASONS.map((key) => <Button key={key} type="button" size="sm" variant={reason === key ? "default" : "outline"} className="max-sm:h-10"
                aria-pressed={reason === key} onClick={() => setReason(reason === key ? undefined : key)}>{t(`overview.close_reason_${key}`)}</Button>)}
            </div>
          </fieldset>
          <Textarea rows={3} maxLength={NOTE_MAX} value={note} className="field-sizing-fixed resize-y"
            aria-label={t("overview.close_note")} placeholder={t("overview.close_note")} onChange={(e) => setNote(e.target.value)} />
        </div> : (
          <ol className="grid gap-2 text-[13px]">
            {CLOSE_STEPS.map((step) => <li key={step} className={cn("flex items-center gap-2", !states[step] && "text-muted-foreground")}>
              <span aria-hidden="true" className={cn("flex size-5 shrink-0 items-center justify-center rounded-full border [&>svg]:size-3.5",
                states[step] === "ok" && "border-transparent bg-emerald-700 text-white", states[step] === "fail" && "border-transparent bg-red-700 text-white")}>
                {states[step] === "ok" ? <Check /> : states[step] === "fail" ? <X /> : states[step] === "run" ? <LoaderCircle className="animate-spin" /> : null}
              </span>
              {t(`overview.close_step_${step}`)}
            </li>)}
          </ol>
        )}
        {error && <Alert role="alert" variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <AlertDialogFooter>
          {done ? <Button type="button" className="max-sm:h-10" onClick={() => onDone(true)}>{t("overview.close_done")}</Button> : <>
            <Button type="button" variant="outline" className="max-sm:h-10" disabled={busy} onClick={() => onDone(started)}>{t("overview.close_cancel")}</Button>
            <Button type="button" variant="destructive" className="max-sm:h-10" disabled={busy} onClick={() => void run()}>
              {busy ? t("common.working") : error ? t("common.retry") : t("overview.close_confirm")}
            </Button>
          </>}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function OverviewPage() {
  const { t, label } = useI18n()
  const [categories, setCategories] = useState<string[]>([])
  const [priorities, setPriorities] = useState<string[]>([])
  const [repo, setRepo] = useRepoParam()
  const repoRef = useRef(repo)
  repoRef.current = repo
  const [unfiltered, setData] = useState<Overview | null>(null)
  const data = unfiltered && filterOverview(unfiltered, categories, priorities)
  const [error, setError] = useState("")
  const [refreshing, setRefreshing] = useState(false)
  const [readingPR, setReadingPR] = useState<Overview["openPRs"][number] | null>(null)
  const [closing, setClosing] = useState<Overview["openPRs"][number] | null>(null)
  const active = useRef<AbortController | null>(null)
  const [reopening, setReopening] = useState<string | null>(null)
  const reopeningRef = useRef(false)
  const [reopenError, setReopenError] = useState("")

  async function load() {
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    const signal = controller.signal
    setRefreshing(true)
    try {
      const query = new URLSearchParams()
      if (repo) query.set("repo", repo)
      const r = await fetch(`/api/overview?${query}`, { signal })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${r.status}`)
      }
      const body = await r.json()
      if (signal.aborted) return
      setData(body)
      setError("")
    } catch (e) {
      if (signal?.aborted) return
      setError((e as Error).message)
    } finally {
      if (!signal?.aborted) setRefreshing(false)
    }
  }

  useEffect(() => {
    setData(null)
    setError("")
    setCategories([])
    setPriorities([])
    setReadingPR(null)
    setClosing(null)
    setReopenError("")
    void load()
    return () => active.current?.abort()
  }, [repo])

  // Reopen returns findings set aside for review to Pick.
  async function reopen(id: string) {
    if (reopeningRef.current) return
    reopeningRef.current = true
    setReopening(id)
    setReopenError("")
    try {
      const r = await fetch("/api/pick/reopen", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...(repo ? { repo } : {}), ids: [id] }),
      })
      const body = await r.json().catch(() => ({}))
      if (repo !== repoRef.current) return
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`)
      await load()
    } catch (e) { if (repo === repoRef.current) setReopenError((e as Error).message) }
    finally {
      reopeningRef.current = false
      setReopening(null)
    }
  }

  const filtered = categories.length > 0 || priorities.length > 0
  const header = (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{t("overview.title")}</h1>
        {data && <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
          {data.repo} · {t(filtered ? "overview.subtitle_filtered" : "overview.subtitle", { count: data.types.length, total: data.availableTypes?.length ?? data.types.length })}
        </p>}
      </div>
      <div className="flex w-full flex-wrap items-start gap-2 sm:w-auto">
        <div className="min-w-0 flex-1"><TrackerSelect value={repo} onChange={value => { setReadingPR(null); setRepo(value) }} /></div>
        <Button variant="outline" disabled={refreshing} onClick={() => void load()}>
          {refreshing ? t("common.refreshing") : t("common.refresh")}
        </Button>
      </div>
    </header>
  )

  const errorNotice = error && <Alert role="alert" variant="destructive" className="flex flex-wrap items-center justify-between gap-3">
    <span>{error}</span>
    <Button variant="outline" size="sm" onClick={() => void load()}>{t("common.retry")}</Button>
  </Alert>

  if (error && !data) {
    return (
      <Page>
        {header}
        {errorNotice}
      </Page>
    )
  }

  if (!data) {
    return (
      <Page>
        {header}
        <div role="status" aria-label={t("common.loading")} className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[0, 1, 2, 3].map(key => <Skeleton key={key} aria-hidden="true" className="h-28 rounded-xl" />)}
        </div>
      </Page>
    )
  }

  const pickHref = `/pick${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`
  const toggle = (list: string[], value: string) => list.includes(value) ? list.filter(v => v !== value) : [...list, value]

  return (
    <Page tabIndex={-1}>
      {header}
      {errorNotice}
      <section className="flex flex-wrap items-center gap-x-5 gap-y-2" aria-label={t("overview.filters")}>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-labelledby="overview-priority-label">
          <span id="overview-priority-label" className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{t("term.priority")}</span>
          {["P0", "P1", "P2"].map(priority => <Button key={priority} type="button" size="sm" variant={priorities.includes(priority) ? "default" : "outline"}
            aria-pressed={priorities.includes(priority)} onClick={() => setPriorities(toggle(priorities, priority))}>{priority}</Button>)}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="sm" variant="outline">
              {t("term.bug_types")}{categories.length > 0 && <Badge variant="secondary">{categories.length}</Badge>}<ChevronDown aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" aria-label={t("term.bug_types")}>
            {(data.availableTypes ?? data.types.map(row => row.category)).map(category => <DropdownMenuCheckboxItem key={category}
              checked={categories.includes(category)} onSelect={event => event.preventDefault()}
              onCheckedChange={() => setCategories(toggle(categories, category))}>{label("category", category)}</DropdownMenuCheckboxItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
        {filtered && <Button type="button" variant="ghost" size="sm" onClick={() => { setCategories([]); setPriorities([]) }}>{t("overview.clear_filters")}</Button>}
      </section>

      <Suspense fallback={<Skeleton aria-hidden="true" className="h-96 rounded-xl" />}>
        <ImpactView key={data.repo} rows={data.types.flatMap(type => type.rows)} prs={data.prs ?? []} categories={data.types.map(type => type.category)} coverage={data.coverage} pickHref={pickHref}
          reopen={id => void reopen(id)} reopening={reopening} readPR={pr => setReadingPR({ ...pr, draft: false })} closePR={pr => setClosing({ ...pr, draft: false })} />
      </Suspense>
      {reopenError && <Alert role="alert" variant="destructive"><AlertDescription>{reopenError}</AlertDescription></Alert>}
      <p className="text-xs text-muted-foreground">{t("overview.scan_types", { count: VULN_CATEGORIES.length })}</p>
      {closing && <ClosePRDialog repo={data.repo} pr={closing} onDone={changed => { setClosing(null); if (changed) void load() }} />}
      {readingPR && <Suspense fallback={<Skeleton aria-hidden="true" className="h-9" />}>
        <PRReader key={`${data.repo}:${readingPR.number}`} repo={data.repo} pr={readingPR} onClose={() => setReadingPR(null)} />
      </Suspense>}
    </Page>
  )
}
