import { PROVIDERS, shortRepo } from "../types/events"
import type { ProviderId } from "../types/events"
import type { ProviderAvailability } from "../components/ProviderSelect"
import { ProviderSelect, choiceProvider, providerChoice, usesApiKey } from "../components/ProviderSelect"
import { useEffect, useRef, useState } from "react"
import { useDevMode } from "../hooks/useDevMode";
import { useI18n } from "../i18n"
import type { Effort } from "../types/events"
import { EFFORTS } from "./LandingPage"
import { TrackerSelect } from "../components/TrackerSelect"
import { ActiveRunBanner } from "../components/ActiveRunBanner"
import type { ActiveRun } from "../hooks/useActiveRuns"
import { useRepoParam } from "../router"
import { Reason } from "../components/Reason"
import { useRelayModels } from "../hooks/useRelayModels"
import { Page } from "../components/Page"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge, severityVariant } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect } from "@/components/ui/native-select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { Check, ChevronDown, ChevronRight, ChevronUp, Circle, LoaderCircle } from "lucide-react"

type Row = { id: string, category: string, subsystem: string, severity: string, file: string, lines: number[], status: string, reason: string }
type HiddenRow = Pick<Row, "id" | "category" | "file" | "lines" | "severity"> & Partial<Row> & { blockedBy: number[] }
type PickData = {
  repoUrl: string, rows: Row[], hidden: HiddenRow[],
  limits?: { maxFilesPerBatch: number },
}

function readIgnoredPRs(repo: string | null): number[] {
  try {
    const value = JSON.parse(localStorage.getItem(`secpatch.ignorePRs:${repo?.toLowerCase()}`) ?? "[]")
    return Array.isArray(value) ? value.filter(n => Number.isSafeInteger(n) && n > 0) : []
  } catch { return [] }
}

// Same limit as IGNORE_REASON_MAX in backend/tracker/pick.ts.
const IGNORE_REASON_MAX = 500

// Keep the row and both reasons in the tracker file for the operator to review.
// Callers mount it to ask and unmount it to close. Escape cancels unless a write is in flight.
function RowChangeDialog({ repo, ids, action, onDone }: { repo: string | null, ids: string[], action: "ignore" | "needs-human", onDone: (changed: boolean) => void }) {
  const { t } = useI18n()
  const key = action === "ignore" ? "ignore" : "needs_human"
  // Read during the first render, before the dialog takes focus.
  const [opener] = useState(() => typeof document === "undefined" ? null : document.activeElement as HTMLElement | null)
  const [reason, setReason] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const note = useRef<HTMLTextAreaElement>(null)

  async function run() {
    if (submitting.current || !reason.trim()) return
    submitting.current = true
    setBusy(true)
    setError("")
    try {
      const r = await fetch(`/api/pick/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...(repo ? { repo } : {}), ids, reason }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`)
      onDone(true)
    } catch (e) { setError((e as Error).message) }
    finally { submitting.current = false; setBusy(false) }
  }

  return <AlertDialog open onOpenChange={open => { if (!open && !busy) onDone(false) }}>
    <AlertDialogContent onOpenAutoFocus={event => {
      event.preventDefault()
      note.current?.focus()
    }} onCloseAutoFocus={event => {
      // A disabled opener cannot take focus back, so the page does.
      event.preventDefault()
      if (opener?.isConnected && !opener.matches(":disabled")) opener.focus()
      else document.querySelector<HTMLElement>("main")?.focus()
    }}>
      <AlertDialogHeader>
        <AlertDialogTitle>{t(`pick.${key}_title`, { count: ids.length })}</AlertDialogTitle>
        <AlertDialogDescription>{t(`pick.${key}_explain`)}</AlertDialogDescription>
      </AlertDialogHeader>
      <Textarea ref={note} rows={3} maxLength={IGNORE_REASON_MAX} value={reason} disabled={busy}
        aria-label={t("pick.ignore_reason")} placeholder={t("pick.ignore_reason")} onChange={e => setReason(e.target.value)} />
      {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
      <AlertDialogFooter>
        <Button type="button" variant="outline" className="max-sm:h-10" disabled={busy} onClick={() => onDone(false)}>{t("overview.close_cancel")}</Button>
        <Button type="button" className="max-sm:h-10" disabled={busy || !reason.trim()} onClick={() => void run()}>
          {busy ? t("common.working") : t(`pick.${key}_confirm`)}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
}

// Rows of one bug type in one subsystem, in the order their first row comes. Rows sort by severity first.
function groupsOf(rows: Row[]): Row[][] {
  const groups = new Map<string, Row[]>()
  for (const row of rows) {
    const key = `${row.category}\u0000${row.subsystem}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return [...groups.values()]
}

function isBlocked(row: HiddenRow, ignoredPRs: number[]) {
  return !row.blockedBy.length || row.blockedBy.some(number => !ignoredPRs.includes(number))
}

function HiddenPRRows({ rows }: { rows: HiddenRow[] }) {
  const { t, label } = useI18n()
  const [open, setOpen] = useState(false)
  return <>
    <ul className="grid gap-x-4 gap-y-1 text-[13px] lg:grid-cols-2">{(open ? rows : rows.slice(0, 3)).map(row => <li key={row.id} className="min-w-0 [overflow-wrap:anywhere]">
      {label("category", row.category)} · {row.severity || "–"} · <code className="font-semibold">{row.file}:{row.lines.slice(0, 8).join(",")}</code>
      {row.lines.length > 8 && <> <span className="text-muted-foreground">{t("common.more", { count: row.lines.length - 8 })}</span></>}
    </li>)}</ul>
    {rows.length > 3 && <Button type="button" variant="link" size="sm" className="h-auto self-start p-0" aria-expanded={open}
      onClick={() => setOpen(!open)}>{open ? t("report.collapse") : t("common.more", { count: rows.length - 3 })}</Button>}
  </>
}

function StepMarker({ state }: { state: "done" | "active" | "pending" }) {
  const Icon = state === "done" ? Check : state === "active" ? LoaderCircle : Circle
  return <span aria-hidden="true" className={cn("inline-flex size-[22px] shrink-0 items-center justify-center rounded-full [&_svg]:size-3",
    state === "done" && "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
    state === "active" && "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300 [&_svg]:animate-spin",
    state === "pending" && "bg-muted text-muted-foreground")}><Icon /></span>
}

const textLink = "text-primary underline-offset-4 hover:underline"
const field = "min-w-0 flex-col items-stretch gap-1.5"

export function PickPage(props: { sessionId: string, activeRuns: ActiveRun[], onStarted: (runId: string) => void }) {
  const { t, label, lang } = useI18n()
  const dev = useDevMode();
  const [smokeCheck, setSmokeCheck] = useState(false)
  const [providerError, setProviderError] = useState("")
  const [availability, setAvailability] = useState<ProviderAvailability>()
  useEffect(() => {
    let alive = true
    fetch("/api/providers")
      .then(async response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = await response.json() as ProviderAvailability
        if (alive) setAvailability(data)
      })
      .catch(error => { if (alive) setProviderError(error.message) })
    return () => { alive = false }
  }, [])
  const [repo, setRepo] = useRepoParam()
  const [data, setData] = useState<PickData | null>(null)
  const [ignoredPRs, setIgnoredPRs] = useState<number[]>(() => readIgnoredPRs(repo))
  const ignoredRef = useRef(ignoredPRs)
  ignoredRef.current = ignoredPRs
  const [selected, setSelected] = useState<string[]>([])
  const [note, setNote] = useState("")
  const [query, setQuery] = useState("")
  const [provider, setProvider] = useState<ProviderId>("claude")
  // The provider on the server's API key instead of its login. On by default when the server has a key.
  const [useApiKey, setUseApiKey] = useState(true)
  const relay = useRelayModels()
  const [useRelay, setUseRelay] = useState(false)
  const apiKey = !useRelay && usesApiKey(availability, provider, useApiKey)
  const authMode = useRelay ? "relay" : apiKey ? "api-key" : "oauth"
  const [reviewProvider, setReviewProvider] = useState<ProviderId>("codex")
  const [reviewModel, setReviewModel] = useState<string>(PROVIDERS.codex.defaultModel)
  const [reviewEffort, setReviewEffort] = useState<Effort>(PROVIDERS.codex.defaultEffort as Effort)
  useEffect(() => {
    if (!availability) return
    const available = (Object.keys(PROVIDERS) as ProviderId[]).filter(id => !PROVIDERS[id].unavailableReason && (availability[id]?.available === true || useRelay && id === "claude"))
    const next = available.find(id => id !== provider) ?? available[0] ?? provider
    setReviewProvider(next)
    setReviewModel(useRelay && next === "claude" ? (relay.models[0] ?? "") : PROVIDERS[next].defaultModel)
    setReviewEffort(PROVIDERS[next].defaultEffort as Effort)
  }, [availability, provider, useRelay, relay.models])
  // A relay model is a gateway name, not a ModelId.
  const [model, setModel] = useState<string>("opus")
  const [effort, setEffort] = useState<Effort>("high")
  const [loadError, setLoadError] = useState("")
  const [submitError, setSubmitError] = useState("")
  const [loading, setLoading] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const confirmingRef = useRef(false)
  const [prProgress, setPrProgress] = useState<{ checked: number, total: number } | null>(null)
  const [stepsOpen, setStepsOpen] = useState(false)
  const [rowAction, setRowAction] = useState<"ignore" | "needs-human" | null>(null)
  const [initialCount, setInitialCount] = useState<number | null>(null)
  const [totalPRs, setTotalPRs] = useState<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  function stopLoading() {
    if (abortRef.current) setLoadError(t("pick.incomplete"))
    abortRef.current?.abort()
    abortRef.current = null
    setLoading(false)
    setPrProgress(null)
  }

  async function load() {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setLoading(true)
    setLoadError("")
    setSubmitError("")
    setPrProgress(null)
    setInitialCount(null)
    setTotalPRs(null)
    try {
      const query = new URLSearchParams(repo ? { repo } : {})
      const response = await fetch(`/api/pick?${query}`, {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${response.status}`)
      }
      // The init frame has complete candidates, before PR checks remove blocked rows.
      const candidates = new Map<string, Row>()
      const capture = (event: PickData) => {
        for (const row of [...event.rows, ...(event.hidden ?? [])]) {
          if (row.status && row.status !== "needs human" && row.subsystem !== undefined && row.reason !== undefined) candidates.set(row.id, row as Row)
        }
        setData({ ...event, rows: [...candidates.values()], hidden: event.hidden ?? [] })
      }
      const update = (event: PickData) => {
        if (controller.signal.aborted) return
        capture(event)
        const rows = [...candidates.values()].filter(row => !(event.hidden ?? []).some(hidden => hidden.id === row.id && isBlocked(hidden, ignoredRef.current)))
        setSelected(prev => prev.filter(id => rows.some(row => row.id === id)))
        // Resolve the server default before restoring preferences for that repository.
        if (!repo) setRepo(shortRepo(event.repoUrl))
      }
      if (response.headers.get("content-type")?.includes("application/json")) {
        update(await response.json())
        return
      }
      if (!response.body) throw new Error("No response body")
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let complete = false
      while (true) {
        const { done, value } = await reader.read()
        if (controller.signal.aborted) return
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const chunks = buffer.split("\n\n")
        buffer = chunks.pop() ?? ""
        for (const chunk of chunks) {
          const match = chunk.match(/^data:\s*(.+)$/m)
          if (!match) continue
          const event = JSON.parse(match[1])
          if (event.type === "error") throw new Error(event.error)
          if (event.rows) {
            if (event.type === "init") setInitialCount(event.rows.length)
            // Rows drop out while open PRs are checked. Prune the selection once, at the end, so the count holds still.
            if (event.type === "done") { update(event); complete = true }
            else capture(event)
          }
          if (event.type === "progress") {
            setPrProgress({ checked: event.checkedPRs, total: event.totalPRs })
            setTotalPRs(event.totalPRs)
          } else if (event.type === "done") {
            setPrProgress(null)
          }
        }
      }
      if (!complete) throw new Error(t("pick.incomplete"))
      setLoadError("")
    } catch (e) {
      if (!controller.signal.aborted && (e as Error).name !== "AbortError") {
        setLoadError((e as Error).message)
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null
        setLoading(false)
        setPrProgress(null)
      }
    }
  }

  useEffect(() => {
    setData(null)
    setLoadError("")
    setSubmitError("")
    setQuery("")
    setSelected([])
    setNote("")
    const stored = readIgnoredPRs(repo)
    setIgnoredPRs(stored)
    void load()
    return () => {
      abortRef.current?.abort()
    }
  }, [repo])

  const candidateRows = data?.rows ?? []
  const hiddenRows = data?.hidden.filter(row => isBlocked(row, ignoredPRs)) ?? []
  const rows = candidateRows.filter(row => !hiddenRows.some(hidden => hidden.id === row.id))
  const visible = rows.filter(row => [row.id, row.category, label("category", row.category), row.subsystem, row.severity, `${row.file}:${row.lines.join(",")}`, row.status, row.reason].some(value => value.toLowerCase().includes(query.trim().toLowerCase())))
  const group = rows.find(row => selected.includes(row.id))
  const visibleIds = new Set(visible.map(row => row.id))
  const providerDown = useRelay ? relay.models.length === 0 || reviewProvider !== "claude" && availability?.[reviewProvider]?.available === false : availability?.[provider]?.available === false || availability?.[reviewProvider]?.available === false
  const canConfirm = Boolean(availability) && !loadError && !loading && selected.length > 0 && selected.every(id => visibleIds.has(id)) && !confirming && !providerDown
  const blockingPRs = [...new Set([...(data?.hidden.flatMap(row => row.blockedBy) ?? []), ...ignoredPRs])].sort((a, b) => a - b)

  // Why the Fix button is off, when the dev cannot fix that by ticking rows.
  const blocked = loading ? t("pick.wait_prs") : providerDown ? t("pick.provider_down") : null

  function togglePR(number: number) {
    const next = ignoredPRs.includes(number) ? ignoredPRs.filter(n => n !== number) : [...ignoredPRs, number]
    setIgnoredPRs(next)
    setSelected(prev => prev.filter(id => !data?.hidden.some(row => row.id === id && isBlocked(row, next))))
    try { localStorage.setItem(`secpatch.ignorePRs:${(repo ?? shortRepo(data!.repoUrl)).toLowerCase()}`, JSON.stringify(next)) } catch { /* storage blocked */ }
  }

  async function startFix() {
    if (!canConfirm || confirmingRef.current) return
    confirmingRef.current = true
    stopLoading()
    setConfirming(true)
    setSubmitError("")
    try {
      const response = await fetch("/api/pick", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: props.sessionId, pickedIds: selected, ignorePRs: ignoredPRs, model, provider, reviewProvider, reviewModel, language: lang,
          ...(PROVIDERS[provider].efforts.length ? { effort } : {}),
          ...(PROVIDERS[reviewProvider].efforts.length ? { reviewEffort } : {}), ...(repo ? { repo } : {}),
          ...(note.trim() ? { note } : {}),
          ...(authMode !== "oauth" ? { authMode } : {}),
          ...(dev && smokeCheck ? { smokeSeconds: 30 } : {}) }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${response.status}`)
      }
      const body = await response.json()
      props.onStarted(body.runId)
    } catch (e) { setSubmitError((e as Error).message) }
    finally { confirmingRef.current = false; setConfirming(false) }
  }

  return <Page tabIndex={-1}>
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("pick.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("pick.subtitle")}</p>
      </div>
    </header>
    <ActiveRunBanner runs={props.activeRuns} />
    {submitError && <Alert variant="destructive" role="alert"><AlertDescription>{submitError}</AlertDescription></Alert>}
    {providerError && <Alert variant="destructive" role="alert"><AlertDescription>{t("provider.load_failed", { msg: providerError })}</AlertDescription></Alert>}
    {loadError && <Alert variant="destructive" role="alert" className="flex flex-wrap items-center justify-between gap-3">
      <span>{loadError}</span>
      <Button type="button" variant="outline" size="sm" disabled={loading || confirming} onClick={() => void load()}>{t("common.retry")}</Button>
    </Alert>}

    <Card className="py-0">
        <Collapsible className="px-5 max-sm:px-4">
          <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md py-3 text-left text-sm font-semibold outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 [&[data-state=open]>svg]:rotate-90">
            <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform" />{t("pick.settings")}
          </CollapsibleTrigger>
          <CollapsibleContent forceMount className="flex flex-col gap-4 pt-1 pb-4 data-[state=closed]:hidden">
            <h3 className="text-sm font-semibold">{t("role.fix")}</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <ProviderSelect availability={availability} value={useRelay ? "litellm" : providerChoice(availability, provider, apiKey)} fix
                litellm={{ disabled: relay.models.length === 0, error: relay.error }}
                onChange={value => {
                  const next = choiceProvider(value)
                  setProvider(next)
                  if (next !== provider || (value === "litellm") !== useRelay) {
                    setModel(value === "litellm" ? (relay.models[0] ?? "") : next === "claude" ? "opus" : PROVIDERS[next].defaultModel)
                    setEffort((next === "claude" ? "high" : PROVIDERS[next].defaultEffort) as Effort)
                  }
                  setUseRelay(value === "litellm")
                  setUseApiKey(value.endsWith("-api-key"))
                }} />
              <Label className={field}><span>{t("term.model")}</span><NativeSelect className="bg-background font-normal" value={model} onChange={e => setModel(e.target.value)}>
                {useRelay
                  ? relay.models.map(id => <option key={id} value={id}>{id}</option>)
                  : PROVIDERS[provider].models.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.value === "fable" ? t("model.fable_label") : option.label}</option>)}
              </NativeSelect></Label>
              {PROVIDERS[provider].efforts.length > 0 && <Label className={field}><span>{t("term.effort")}</span><NativeSelect className="bg-background font-normal" value={effort} onChange={e => setEffort(e.target.value as Effort)}>
                {EFFORTS.filter(value => PROVIDERS[provider].efforts.includes(value)).map(value => <option key={value} value={value}>{t(`effort.${value}`)}</option>)}
              </NativeSelect></Label>}
            </div>
            <h3 className="text-sm font-semibold">{t("role.review")}</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <ProviderSelect availability={useRelay && availability ? { ...availability, claude: { available: true } } : availability} value={reviewProvider} review authMode={authMode} provider={provider} onChange={value => {
                const next = value as ProviderId
                setReviewProvider(next)
                setReviewModel(useRelay && next === "claude" ? (relay.models[0] ?? "") : PROVIDERS[next].defaultModel)
                setReviewEffort(PROVIDERS[next].defaultEffort as Effort)
              }} />
              <Label className={field}><span>{t("term.model")}</span><NativeSelect className="bg-background font-normal" value={reviewModel} onChange={e => setReviewModel(e.target.value)}>
                {useRelay && reviewProvider === "claude"
                  ? relay.models.map(id => <option key={id} value={id}>{id}</option>)
                  : PROVIDERS[reviewProvider].models.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.value === "fable" ? t("model.fable_label") : option.label}</option>)}
              </NativeSelect></Label>
              {PROVIDERS[reviewProvider].efforts.length > 0 && <Label className={field}><span>{t("term.effort")}</span><NativeSelect className="bg-background font-normal" value={reviewEffort} onChange={e => setReviewEffort(e.target.value as Effort)}>
                {PROVIDERS[reviewProvider].efforts.map(value => <option key={value} value={value}>{t(`effort.${value}`)}</option>)}
              </NativeSelect></Label>}
            </div>
            {dev && <div className="flex flex-col gap-1.5">
              <Label className="font-normal"><Checkbox checked={smokeCheck} onCheckedChange={checked => setSmokeCheck(checked === true)} />{t("run.smoke_check")}</Label>
              {smokeCheck && <span className="text-xs text-muted-foreground">{t("pick.smoke_note")}</span>}
            </div>}
          </CollapsibleContent>
        </Collapsible>
    </Card>

    <Card className="flex-row flex-wrap items-center gap-2 px-4 py-3">
      <TrackerSelect value={repo} onChange={setRepo} />
      {loading ? (
        <Button type="button" variant="outline" onClick={stopLoading}>
          {t("pick.stop")}
        </Button>
      ) : (
        <Button type="button" variant="outline" disabled={confirming} onClick={() => void load()}>
          {t("common.refresh")}
        </Button>
      )}
    </Card>

    {(loading || data) && <Card className="gap-0 overflow-hidden py-0">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 bg-muted/50 px-4 py-2 text-[13px]">
        <div className="flex min-w-0 items-center gap-2 font-medium [overflow-wrap:anywhere]">
          {loading ? <>
            <StepMarker state="active" />
            <span>{prProgress ? t("pick.step_prs_progress", { checked: prProgress.checked, total: prProgress.total }) : t("pick.step_issues_pending")}</span>
          </> : <>
            <StepMarker state="done" />
            <span>{t("pick.step_filter_done", { count: data?.rows.length ?? 0 })}</span>
          </>}
        </div>
        <Button type="button" variant="ghost" size="sm" aria-expanded={stepsOpen} onClick={() => setStepsOpen(o => !o)}>
          {stepsOpen ? t("pick.hide_steps") : t("pick.show_steps")}{stepsOpen ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
        </Button>
      </div>
      {stepsOpen && <ol className="flex flex-col gap-2 border-t px-4 py-3 text-[13px]">
        <li className="flex items-center gap-3">
          <StepMarker state={data ? "done" : "active"} />
          <div className="flex min-w-0 flex-col">
            <span className="font-semibold">{t("pick.step_issues_title")}</span>
            <span className="text-xs text-muted-foreground">{data ? t("pick.step_issues_done", { count: initialCount ?? data.rows.length }) : t("pick.step_issues_pending")}</span>
          </div>
        </li>
        <li className="flex items-center gap-3">
          <StepMarker state={!data ? "pending" : loading ? "active" : "done"} />
          <div className="flex min-w-0 flex-col">
            <span className="font-semibold">{t("pick.step_prs_title")}</span>
            <span className="text-xs text-muted-foreground">{!data ? t("pick.step_prs_pending") : prProgress ? t("pick.step_prs_progress", { checked: prProgress.checked, total: prProgress.total }) : t("pick.step_prs_done", { count: totalPRs ?? 0 })}</span>
          </div>
        </li>
        <li className="flex items-center gap-3">
          <StepMarker state={loading ? "pending" : "done"} />
          <div className="flex min-w-0 flex-col">
            <span className="font-semibold">{t("pick.step_filter_title")}</span>
            <span className="text-xs text-muted-foreground">{loading ? t("pick.step_filter_pending") : t("pick.step_filter_done", { count: rows.length })}</span>
          </div>
        </li>
      </ol>}
    </Card>}

    <div className="flex flex-col gap-1.5">
      <Label htmlFor="pick-note">{t("pick.note")}</Label>
      <Textarea id="pick-note" className="bg-background" rows={3} maxLength={1000} value={note} disabled={confirming}
        placeholder={t("pick.note_hint")} aria-describedby="pick-note-count" onChange={e => setNote(e.target.value)} />
      <span id="pick-note-count" className="self-end text-xs text-muted-foreground tabular-nums">{t("pick.note_count", { count: note.length.toLocaleString(lang), max: (1000).toLocaleString(lang) })}</span>
    </div>

    <div className="flex flex-col gap-1.5">
      <Label htmlFor="pick-search">{t("common.search_findings")}</Label>
      <Input id="pick-search" className="bg-background" type="search" value={query} onChange={e => setQuery(e.target.value)} />
    </div>

    {data && blockingPRs.length > 0 && <Collapsible className="rounded-xl border bg-card text-card-foreground shadow-sm">
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-xl px-4 py-3 text-left text-sm font-semibold outline-none hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 [&[data-state=open]>svg]:rotate-90">
        <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform" />{t("pick.hidden", { count: hiddenRows.length })}
      </CollapsibleTrigger>
      <CollapsibleContent forceMount className="flex flex-col gap-4 border-t p-4 data-[state=closed]:hidden">
        <p className="text-[13px] text-muted-foreground">{t("pick.hidden_explain")}</p>
        {blockingPRs.map(number => <section key={number} className="flex flex-col gap-2 border-t pt-3">
          <h3 className="text-sm font-semibold"><a className={textLink} href={`https://github.com/${shortRepo(data.repoUrl)}/pull/${number}`} target="_blank" rel="noopener noreferrer">PR #{number}</a></h3>
          <Label className="font-normal"><Checkbox checked={ignoredPRs.includes(number)} disabled={confirming}
            onCheckedChange={() => togglePR(number)} />{t("pick.ignore_pr", { number })}</Label>
          <HiddenPRRows key={repo} rows={hiddenRows.filter(row => row.blockedBy.includes(number))} />
        </section>)}
      </CollapsibleContent>
    </Collapsible>}
    {data?.limits && <p role="status" className="text-[13px] text-muted-foreground">{t("pick.limits", { files: data.limits.maxFilesPerBatch })}</p>}

    {!data && loading ? <p role="status" className="py-12 text-center text-muted-foreground">{t("pick.loading")}</p> : data && <div className="rounded-xl border bg-card shadow-sm">
      {/* Fixed columns: long paths and reasons wrap inside their cells instead of widening the page.
          A phone scrolls the table sideways so the reason column stays readable. */}
      <Table className="table-fixed max-sm:min-w-[600px] [&_td]:whitespace-normal [&_td]:[overflow-wrap:anywhere] [&_th]:whitespace-normal">
        <TableHeader><TableRow className="hover:bg-transparent">
          <TableHead className="w-12">{t("pick.col_pick")}</TableHead>
          <TableHead className="w-16 sm:w-[10%]">{t("term.severity")}</TableHead>
          <TableHead className="w-[25%]">{t("term.file_lines")}</TableHead>
          <TableHead className="w-20 sm:w-[12%]">{t("term.status")}</TableHead>
          <TableHead>{t("term.reason_rec")}</TableHead>
        </TableRow></TableHeader>
        {groupsOf(visible).map(rows => {
          const ids = rows.map(row => row.id)
          const picked = ids.filter(id => selected.includes(id)).length
          return <TableBody key={ids[0]}>
            <TableRow className="border-t bg-muted/50 hover:bg-muted/50">
              <TableCell><Checkbox aria-label={t("pick.group_label", { category: label("category", rows[0].category), subsystem: rows[0].subsystem || "—" })}
                checked={picked === ids.length ? true : picked > 0 ? "indeterminate" : false} disabled={confirming}
                onCheckedChange={() => setSelected(picked > 0 ? selected.filter(id => !ids.includes(id))
                  : [...(group?.category === rows[0].category ? selected : []), ...ids])} /></TableCell>
              <TableCell colSpan={4}>
                <span className="font-semibold">{label("category", rows[0].category)}</span>
                <span className="text-muted-foreground"> · {rows[0].subsystem || "—"}</span>
                <span className="ml-3 text-xs text-muted-foreground">{t(ids.length === 1 ? "pick.group_count_one" : "pick.group_count", { count: ids.length })}</span>
              </TableCell>
            </TableRow>
            {rows.map(row => <TableRow key={row.id} className="cursor-pointer" data-state={selected.includes(row.id) ? "selected" : undefined} onClick={e => {
              if ((e.target as HTMLElement).closest("a, button, input, select, textarea, label") || confirming) return
              setSelected(selected.includes(row.id) ? selected.filter(id => id !== row.id) : group?.category === row.category ? [...selected, row.id] : [row.id])
            }}>
              <TableCell><Checkbox aria-label={t("pick.row_label", { id: row.id })} checked={selected.includes(row.id)}
                disabled={confirming}
                // A tick in another bug type moves the pick there. One run fixes one bug type.
                onCheckedChange={checked => setSelected(checked !== true ? selected.filter(id => id !== row.id) : group?.category === row.category ? [...selected, row.id] : [row.id])} /></TableCell>
              <TableCell>{row.severity ? <Badge variant={severityVariant(row.severity)}>{row.severity}</Badge> : "—"}</TableCell>
              {/* File name first, its folder below: long vendor paths wrap instead of widening the table. */}
              <TableCell title={row.file}><code className="text-xs font-semibold">{row.file.split("/").pop()}:{row.lines.slice(0, 6).join(",")}</code>
                {row.lines.length > 6 && <span className="text-muted-foreground"> {t("pick.more_lines", { count: row.lines.length - 6 })}</span>}
                {row.file.includes("/") && <span className="block text-xs text-muted-foreground">{row.file.slice(0, row.file.lastIndexOf("/"))}</span>}</TableCell>
              <TableCell>{label("finding_status", row.status)}</TableCell>
              <TableCell><Reason text={row.reason} /></TableCell>
            </TableRow>)}
          </TableBody>
        })}
      </Table>
      {!loading && !visible.length && <p className="py-12 text-center text-muted-foreground">{t(!rows.length && hiddenRows.length ? "pick.all_hidden" : "pick.no_eligible")}</p>}
    </div>}

    {/* On a phone the wrapped bar would cover most of the list, so it stays in the flow there. */}
    <footer className="sticky bottom-4 z-20 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card px-5 py-3 text-card-foreground shadow-md max-sm:static max-sm:p-3">
      <div className="flex min-w-0 flex-col gap-0.5 [overflow-wrap:anywhere] max-sm:w-full">
        <span className="text-[13px] font-semibold">
          {selected.length > 0 && group
            ? t("pick.selected_info", { count: selected.length, category: label("category", group.category) })
            : blocked ?? t("pick.none_selected")}
        </span>
        {selected.length > 0 && blocked && <span className="text-xs text-muted-foreground">{blocked}</span>}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={loading || confirming || !selected.length || !selected.every(id => visibleIds.has(id))} onClick={() => setRowAction("ignore")}>
          {t("pick.btn_ignore", { count: selected.length })}
        </Button>
        <Button type="button" variant="outline" disabled={loading || confirming || !selected.length || !selected.every(id => visibleIds.has(id))} onClick={() => setRowAction("needs-human")}>
          {t("pick.btn_needs_human", { count: selected.length })}
        </Button>
        <Button type="button" disabled={!canConfirm} onClick={() => void startFix()}>
          {confirming ? t("common.working") : t("pick.btn_confirm", { count: selected.length })}
        </Button>
      </div>
    </footer>
    {rowAction && <RowChangeDialog repo={repo} ids={selected} action={rowAction} onDone={changed => {
      setRowAction(null)
      if (!changed) return
      // Drop the rows here. A reload takes seconds.
      setData(d => d && { ...d, rows: d.rows.filter(row => !selected.includes(row.id)) })
      setSelected([])
    }} />}
  </Page>
}
