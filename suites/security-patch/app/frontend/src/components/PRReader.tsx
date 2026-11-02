import { useEffect, useRef, useState, type ComponentProps } from "react"
import ReactMarkdown, { defaultUrlTransform } from "react-markdown"
import remarkGfm from "remark-gfm"
import type { PRDetail } from "../../../shared/pr"
import { useI18n } from "../i18n"
import { ReaderModal } from "./ReaderModal"
import { githubUrl, isHttps, markdownComponents } from "./ReportView"
import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

type BadgeVariant = NonNullable<ComponentProps<typeof Badge>["variant"]>

const SECTIONS = ["description", "files", "activity"] as const
const safeHref = (url: string | null | undefined) => isHttps(url) ? url! : undefined

export function diffLines(patch: string) {
  let oldLine = 0
  let newLine = 0
  return patch.replace(/\n$/, "").split("\n").map(text => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      return { kind: "hunk", text, oldLine: null, newLine: null }
    }
    if (text.startsWith("-")) return { kind: "removed", text, oldLine: oldLine++, newLine: null }
    if (text.startsWith("+")) return { kind: "added", text, oldLine: null, newLine: newLine++ }
    if (text.startsWith(" ")) return { kind: "context", text, oldLine: oldLine++, newLine: newLine++ }
    return { kind: "meta", text, oldLine: null, newLine: null }
  })
}

const LINE_KIND: Record<string, string> = {
  added: "bg-emerald-50 dark:bg-emerald-950/70",
  removed: "bg-red-50 dark:bg-red-950/70",
  hunk: "bg-sky-50 py-1 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
  meta: "text-muted-foreground",
}
const columns = "grid-cols-[4ch_4ch_minmax(0,1fr)] sm:grid-cols-[5ch_5ch_minmax(0,1fr)]"

export function DiffView({ patch }: { patch: string }) {
  const { t } = useI18n()
  return <div className="bg-background font-mono text-xs leading-[1.7] sm:text-[13px]" role="region" aria-label={t("pr.diff")}>
    <div className={cn("grid border-b py-1 text-xs text-muted-foreground [&>span]:text-center", columns)}><span>{t("pr.before")}</span><span>{t("pr.after")}</span></div>
    <pre className="m-0 font-[inherit]"><code className="font-[inherit] text-[length:inherit]">{diffLines(patch).map((line, index) =>
      <span key={index} data-kind={line.kind} className={cn("grid min-w-0", columns, LINE_KIND[line.kind])}>
        <span className="border-r pr-[1ch] text-right text-muted-foreground select-none" aria-hidden="true">{line.oldLine}</span>
        <span className="border-r pr-[1ch] text-right text-muted-foreground select-none" aria-hidden="true">{line.newLine}</span>
        <span className="min-w-0 px-[1ch] whitespace-pre-wrap [overflow-wrap:anywhere] [tab-size:4]">{line.text}</span>
        {"\n"}
      </span>)}</code></pre>
  </div>
}

// GitHub check, status and review results. The label text always carries the meaning too.
function resultVariant(result: string): BadgeVariant {
  if (["success", "approved"].includes(result)) return "success"
  if (["failure", "error", "changes_requested"].includes(result)) return "failed"
  if (["queued", "in_progress", "pending", "action_required", "timed_out"].includes(result)) return "paused"
  return "secondary"
}
const STATE_VARIANT: Record<string, BadgeVariant> = { open: "success", merged: "default", closed: "failed", draft: "secondary" }
const added = "text-emerald-700 dark:text-emerald-400"
const removed = "text-red-700 dark:text-red-400"
const fold = "group flex w-full items-center gap-x-3 gap-y-2 text-left"
const chevron = <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
const external = "text-xs"

export function PRContent({ data, repo }: { data: PRDetail, repo: string }) {
  const { t, label, lang } = useI18n()
  const [section, setSection] = useState<typeof SECTIONS[number]>("description")
  const root = useRef<HTMLDivElement>(null)
  const date = (value: string | null) => value ? new Date(value).toLocaleString(lang === "zh" ? "zh-CN" : "en") : t("common.unspecified")
  const choose = (next: typeof SECTIONS[number]) => {
    setSection(next)
    root.current?.closest("[data-slot=reader-body]")?.scrollTo(0, 0)
  }
  const markdown = (text: string | null | undefined) => <div className="markdown-body">
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents} skipHtml urlTransform={url => {
      const safe = defaultUrlTransform(url)
      return safe && !/^(?:[a-z][a-z\d+.-]*:|#)/i.test(safe) ? new URL(safe, `https://github.com/${repo}/blob/${data.head.sha}/`).href : safe
    }}>{text ?? ""}</ReactMarkdown>
  </div>
  const unavailable = (key: keyof PRDetail["unavailable"]) => data.unavailable[key] &&
    <Alert role="alert" variant="destructive"><AlertDescription>{t("pr.unavailable", { section: t(`pr.${key}`), error: data.unavailable[key]! })}</AlertDescription></Alert>
  const state = data.merged ? "merged" : data.state === "closed" ? "closed" : data.draft ? "draft" : "open"
  const discussion = [
    ...data.comments.map(comment => ({ ...comment, kind: "comment" as const })),
    ...data.reviews.map(review => ({ ...review, kind: "review" as const })),
    ...data.reviewComments.map(comment => ({ ...comment, kind: "inline" as const })),
  ].sort((a, b) => Date.parse(a.kind === "review" ? a.submitted_at ?? "" : a.created_at) - Date.parse(b.kind === "review" ? b.submitted_at ?? "" : b.created_at))
  const empty = "text-sm text-muted-foreground"

  return <div ref={root} className="flex min-w-0 flex-col gap-3">
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-muted-foreground">
      <Badge variant={STATE_VARIANT[state]}>{t(`pr.state.${state}`)}</Badge>
      <span>{t("pr.author", { author: data.user?.login ?? t("common.unspecified") })}</span>
      <span>{t("pr.files_count", { count: data.changed_files })}</span>
      <span className={added}>+{data.additions} {t("pr.additions")}</span>
      <span className={removed}>−{data.deletions} {t("pr.deletions")}</span>
    </div>
    <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]"><code>{data.head.ref}</code> → <code>{data.base.ref}</code> · <code>{data.head.sha.slice(0, 8)}</code></p>
    <p className="text-xs text-muted-foreground">{t("pr.updated", { date: date(data.updated_at) })}</p>
    <Tabs value={section} onValueChange={value => choose(value as typeof SECTIONS[number])} className="gap-3">
      <div className="sticky -top-4 z-10 border-b bg-background sm:-top-6">
        <TabsList variant="line" aria-label={t("pr.sections")} className="flex-wrap justify-start gap-1 p-0 group-data-[orientation=horizontal]/tabs:h-auto">
          {SECTIONS.map(key => <TabsTrigger key={key} value={key} className="h-10 flex-none px-2 sm:px-3 group-data-[orientation=horizontal]/tabs:after:-bottom-px">
            {t(`pr.${key}`)}{key === "files" && <Badge variant="secondary">{data.changed_files}</Badge>}</TabsTrigger>)}
        </TabsList>
      </div>
      {/* One panel whose value tracks the active section, so its id never changes. */}
      <TabsContent value={section} tabIndex={0} className="flex min-w-0 flex-col gap-3">
      {section === "description" && <article className="mx-auto w-full max-w-[78ch]">
        {data.body ? markdown(data.body) : <p className={empty}>{t("pr.no_description")}</p>}
      </article>}
      {section === "files" && <>
        {unavailable("files")}
        {!data.unavailable.files && data.files.length < data.changed_files && <Alert role="alert" variant="warning"><AlertDescription>{t("pr.partial_files", { loaded: data.files.length, total: data.changed_files })}</AlertDescription></Alert>}
        {!data.unavailable.files && !data.files.length && <p className={empty}>{t("pr.no_files")}</p>}
        {data.files.map(file => <Collapsible key={file.filename} data-testid="pr-file" className="overflow-clip rounded-lg border">
          <CollapsibleTrigger className={cn(fold, "flex-wrap bg-muted/50 px-3 py-3 hover:bg-accent sm:px-4")}>
            {chevron}
            <span className="min-w-0 flex-1 basis-[calc(100%-28px)] font-mono text-[13px] [overflow-wrap:anywhere] sm:basis-0">{file.filename}</span>
            <span className="flex gap-2 font-mono text-xs max-sm:ml-7"><span className={added}>+{file.additions}</span><span className={removed}>−{file.deletions}</span></span>
            <span className="text-xs text-muted-foreground">{label("pr.file", file.status)}</span>
          </CollapsibleTrigger>
          {/* Mounted while closed so the whole PR renders up front, as the native <details> did. */}
          <CollapsibleContent forceMount className="border-t data-[state=closed]:hidden">
            {file.previous_filename && <p className="px-4 py-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">{t("pr.renamed_from", { name: file.previous_filename })}</p>}
            {file.patch ? <DiffView patch={file.patch} /> : <Alert variant="warning" className="m-3 w-auto"><AlertDescription>{t("pr.no_patch")}</AlertDescription></Alert>}
            {githubUrl(file.blob_url) && <a className={cn(external, "block border-t px-4 py-2")} href={githubUrl(file.blob_url)} target="_blank" rel="noopener noreferrer">{t("pr.view_file")} ↗</a>}
          </CollapsibleContent>
        </Collapsible>)}
      </>}
      {section === "activity" && <>
        <section className="mb-5 flex flex-col gap-3">
          <h3 className="text-base font-semibold">{t("pr.checks")}</h3>
          {unavailable("checks")}{unavailable("statuses")}
          {!data.unavailable.checks && !data.unavailable.statuses && !data.checks.length && !data.statuses.length && <p className={empty}>{t("pr.no_checks")}</p>}
          {data.checks.map(check => <Collapsible key={check.id} className="rounded-lg border px-3 py-3 text-sm [overflow-wrap:anywhere] sm:px-4">
            <CollapsibleTrigger className={fold}>{chevron}<span className="min-w-0 flex-1">{check.name}</span><ResultBadge result={check.conclusion ?? check.status} label={label("pr.result", check.conclusion ?? check.status)} /></CollapsibleTrigger>
            <CollapsibleContent forceMount className="mt-3 flex flex-col gap-2 data-[state=closed]:hidden">
              {check.output?.title && <h4 className="font-medium">{check.output.title}</h4>}
              {markdown([check.output?.summary, check.output?.text].filter(Boolean).join("\n\n"))}
              {githubUrl(check.html_url) && <a className={external} href={githubUrl(check.html_url)} target="_blank" rel="noopener noreferrer">{t("pr.view_check")} ↗</a>}
            </CollapsibleContent>
          </Collapsible>)}
          {data.statuses.map(status => <div key={status.id} className="flex flex-col gap-2 rounded-lg border px-3 py-3 text-sm [overflow-wrap:anywhere] sm:px-4">
            <div className="flex items-center justify-between gap-3"><span>{status.context}</span><ResultBadge result={status.state} label={label("pr.result", status.state)} /></div>
            {status.description && <p>{status.description}</p>}
            {safeHref(status.target_url) && <a className={external} href={safeHref(status.target_url)} target="_blank" rel="noopener noreferrer">{t("pr.view_check")} ↗</a>}
          </div>)}
        </section>
        <section className="mb-5 flex flex-col gap-3">
          <h3 className="text-base font-semibold">{t("pr.discussion")}</h3>
          {unavailable("comments")}{unavailable("reviews")}{unavailable("reviewComments")}
          {!data.unavailable.comments && !data.unavailable.reviews && !data.unavailable.reviewComments && !discussion.length && <p className={empty}>{t("pr.no_discussion")}</p>}
          <ol className="flex flex-col gap-3">
            {discussion.map(entry => <li key={`${entry.kind}-${entry.id}`} className="flex min-w-0 flex-col items-start gap-2 rounded-lg border p-3 sm:p-4" id={`pr-${entry.kind}-${entry.id}`}>
              <header className="mb-1 flex w-full flex-wrap items-center gap-x-3 gap-y-2 text-sm">
                <strong>{entry.user?.login ?? t("common.unspecified")}</strong>
                {entry.kind === "review" && <ResultBadge result={entry.state.toLowerCase()} label={label("pr.review", entry.state)} />}
                <time className="ml-auto text-xs text-muted-foreground" dateTime={(entry.kind === "review" ? entry.submitted_at : entry.created_at) ?? undefined}>{date(entry.kind === "review" ? entry.submitted_at : entry.created_at)}</time>
              </header>
              {entry.kind === "inline" && <>
                <p className="max-w-full [overflow-wrap:anywhere]"><code>{entry.path}{entry.line ?? entry.original_line ? `:${entry.line ?? entry.original_line}` : ""}</code></p>
                {entry.in_reply_to_id && <a href={`#pr-inline-${entry.in_reply_to_id}`} className={external}>{t("pr.reply_to", { number: entry.in_reply_to_id })}</a>}
                {entry.diff_hunk && <Collapsible data-testid="pr-comment-context" className="w-full overflow-clip rounded-md border">
                  <CollapsibleTrigger className={cn(fold, "bg-muted/50 px-3 py-2 text-[13px] text-muted-foreground")}>{chevron}{t("pr.code_context")}</CollapsibleTrigger>
                  <CollapsibleContent forceMount className="border-t data-[state=closed]:hidden"><DiffView patch={entry.diff_hunk} /></CollapsibleContent>
                </Collapsible>}
              </>}
              {entry.body && <div className="w-full min-w-0">{markdown(entry.body)}</div>}
              {githubUrl(entry.html_url) && <a className={external} href={githubUrl(entry.html_url)} target="_blank" rel="noopener noreferrer">{t("pr.view_comment")} ↗</a>}
            </li>)}
          </ol>
        </section>
      </>}
      </TabsContent>
    </Tabs>
  </div>
}

function ResultBadge({ result, label }: { result: string, label: string }) {
  return <Badge variant={resultVariant(result)} data-result={result}>{label}</Badge>
}

// The last load of each PR. A reopen shows it at once and refetches behind it, since checks
// and reviews change. ponytail: unbounded, fine for the few suite PRs a session opens.
const loaded = new Map<string, PRDetail>()

export function PRReader({ repo, pr, onClose }: {
  repo: string, pr: { number: number, title: string, url: string }, onClose: () => void,
}) {
  const { t } = useI18n()
  const key = `${repo}:${pr.number}`
  const [data, setData] = useState<PRDetail | null>(() => loaded.get(key) ?? null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const active = useRef<AbortController | null>(null)
  async function load() {
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    setLoading(true)
    setError("")
    try {
      const query = new URLSearchParams({ repo })
      const response = await fetch(`/api/overview/prs/${pr.number}?${query}`, { signal: controller.signal })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${response.status}`)
      }
      const body = await response.json()
      if (!controller.signal.aborted) { loaded.set(key, body); setData(body) }
    } catch (error) {
      if (!controller.signal.aborted) setError((error as Error).message)
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }
  useEffect(() => {
    void load()
    return () => active.current?.abort()
  }, [repo, pr.number])
  return <ReaderModal title={`#${pr.number} ${data?.title ?? pr.title}`} source={repo} href={githubUrl(pr.url)} onClose={onClose}>
    <div className="mb-3 flex justify-end"><Button type="button" variant="outline" size="sm" className="max-sm:h-10" disabled={loading} onClick={() => void load()}>{t(loading ? "common.refreshing" : "common.refresh")}</Button></div>
    {error && <Alert role="alert" variant="destructive" className="mb-3 flex flex-wrap items-center justify-between gap-3"><span>{data && <strong>{t("pr.stale")} </strong>}{error}</span><Button type="button" variant="outline" size="sm" className="max-sm:h-10" onClick={() => void load()}>{t("common.retry")}</Button></Alert>}
    {!data && loading && <p className="py-12 text-center text-muted-foreground" role="status">{t("common.loading")}</p>}
    {data && <PRContent data={data} repo={repo} />}
  </ReaderModal>
}
