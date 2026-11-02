import { useEffect, useState } from "react"
import type { ReactNode } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { ChevronRight } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"
import { useI18n } from "../i18n"
import { DiffView } from "./PRReader"
import { ReaderModal } from "./ReaderModal"
import type { DiagnosticKind } from "./ArtifactButtons"
import { markdownComponents } from "./ReportView"


type RunInfo = {
  image?: string, imageId?: string, appCommit?: string, startedAt?: string,
  resources?: { cpus?: number, memoryMb?: number, memorySwapMb?: number },
  mounts?: Record<string, boolean>, env?: Record<string, string>,
}
export type EventRow = { at: string, label: string, text: string, detail?: string }
type Json = Record<string, any>

const clock = (ms: number) => `+${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`
const flat = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(part => typeof part === "string" ? part : part?.text ?? "").join("\n") : ""

// events.jsonl as one row per thing a person would read. Thinking-token counters are dropped:
// they are most of the file and carry no content.
export function eventRows(text: string): { rows: EventRow[], hidden: number } {
  const rows: EventRow[] = []
  let start: number | undefined
  let hidden = 0
  for (const line of text.split("\n")) {
    let frame: Json
    try { frame = JSON.parse(line) } catch { continue }
    start ??= frame.ts
    const at = typeof frame.ts === "number" && start !== undefined ? clock(frame.ts - start) : ""
    const add = (label: string, text: string, detail?: string) => rows.push({ at, label, text, detail })
    if (frame.kind !== "sdk_message") {
      const { runId: _r, ts: _t, kind, prompt, ...rest } = frame
      add(kind, Object.entries(rest).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(" · "), prompt)
      continue
    }
    const m: Json = frame.message ?? {}
    if (m.type === "system") {
      if (m.subtype === "thinking_tokens") { hidden++; continue }
      add(`system · ${m.subtype}`, m.subtype === "init" ? [m.model, m.claude_code_version && `Claude Code ${m.claude_code_version}`, m.apiKeySource].filter(Boolean).join(" · ") : "")
    } else if (m.type === "assistant") {
      for (const block of m.message?.content ?? []) {
        if (block.type === "text") add("text", block.text)
        else if (block.type === "thinking" && block.thinking) add("thinking", block.thinking)
        else if (block.type === "tool_use") {
          const input: Json = block.input ?? {}
          add(`tool · ${block.name}`, [input.file_path, input.pattern, input.path, input.command, input.description].filter(Boolean).join(" · "), JSON.stringify(input, null, 2))
        }
      }
    } else if (m.type === "user") {
      for (const block of Array.isArray(m.message?.content) ? m.message.content : []) {
        if (block.type !== "tool_result") continue
        const body = flat(block.content)
        add(block.is_error ? "result · error" : "result", body.split("\n")[0], body)
      }
    } else if (m.type === "result") {
      add(`result · ${m.subtype}`, [m.num_turns !== undefined && `${m.num_turns} turns`].filter(Boolean).join(" · "), typeof m.result === "string" ? m.result : undefined)
    } else add(String(m.type), "")
  }
  return { rows, hidden }
}

export type PatchFile = { name: string, additions: number, deletions: number, diff: string }

// working.patch (git diff) as one entry per file. The diff starts at the first hunk, so DiffView
// numbers the lines. A file with no hunk (binary, mode change) keeps its header lines instead.
export function patchFiles(text: string): PatchFile[] {
  return text.split(/^(?=diff --git )/m).filter(chunk => chunk.startsWith("diff --git ")).map(chunk => {
    const lines = chunk.replace(/\n$/, "").split("\n")
    const hunk = lines.findIndex(line => line.startsWith("@@"))
    const body = hunk < 0 ? lines.slice(1) : lines.slice(hunk)
    const name = /^\+\+\+ b\/(.+)$/m.exec(chunk)?.[1] ?? /^--- a\/(.+)$/m.exec(chunk)?.[1] ?? lines[0].replace(/^diff --git a\/(.+?) b\/.*$/, "$1")
    return {
      name,
      additions: hunk < 0 ? 0 : body.filter(line => line.startsWith("+")).length,
      deletions: hunk < 0 ? 0 : body.filter(line => line.startsWith("-")).length,
      diff: body.join("\n"),
    }
  })
}

export type Commit = { sha: string, subject: string, body: string }

// commits.log is `git log --format=%H%n%s%n%b%n--END--`.
export function commitEntries(text: string): Commit[] {
  return text.split(/^--END--$/m).map(entry => entry.replace(/^\n+/, "").split("\n")).filter(lines => /^[0-9a-f]{40}$/.test(lines[0]))
    .map(([sha, subject = "", ...body]) => ({ sha, subject, body: body.join("\n").trim() }))
}

const pre = "m-0 max-h-[60vh] overflow-y-auto rounded-md bg-muted p-3 font-mono text-xs leading-normal whitespace-pre-wrap [overflow-wrap:anywhere]"
const markdown = (text: string, className?: string) => <div className={cn("markdown-body", className)}>
  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents} skipHtml>{text}</ReactMarkdown>
</div>

// One file, commit or document that folds open.
function Fold({ summary, defaultOpen, children }: { summary: ReactNode, defaultOpen?: boolean, children: ReactNode }) {
  return <Collapsible defaultOpen={defaultOpen} className="group/file overflow-clip rounded-lg border">
    <CollapsibleTrigger className="flex w-full flex-wrap items-center gap-x-3 gap-y-2 bg-muted/50 px-4 py-3 text-left outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50">
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/file:rotate-90" />
      {summary}
    </CollapsibleTrigger>
    <CollapsibleContent forceMount className="data-[state=closed]:hidden">{children}</CollapsibleContent>
  </Collapsible>
}

const fileName = "min-w-0 flex-1 font-mono text-[13px] [overflow-wrap:anywhere]"

function PatchView({ files }: { files: PatchFile[] }) {
  return <div className="flex flex-col gap-3">
    {files.map((file, i) => <Fold key={`${i}-${file.name}`} defaultOpen={files.length === 1} summary={<>
      <span className={fileName}>{file.name}</span>
      <span className="flex gap-2 font-mono text-xs">
        <span className="text-emerald-700 dark:text-emerald-400">+{file.additions}</span>
        <span className="text-red-700 dark:text-red-400">−{file.deletions}</span>
      </span>
    </>}>
      <DiffView patch={file.diff} />
    </Fold>)}
  </div>
}

function CommitsView({ commits }: { commits: Commit[] }) {
  return <div className="flex flex-col gap-3">
    {commits.map(commit => <Fold key={commit.sha} summary={<>
      <code className="text-xs">{commit.sha.slice(0, 8)}</code>
      <span className={fileName}>{commit.subject}</span>
    </>}>
      {commit.body && <pre className={cn(pre, "rounded-none")}>{commit.body}</pre>}
    </Fold>)}
  </div>
}

function Long({ text, detail }: { text: string, detail?: string }) {
  const full = detail ?? text
  if (full.length <= 200 && !full.includes("\n")) return <>{text}</>
  return <Collapsible className="flex flex-col gap-2">
    <CollapsibleTrigger className="text-left underline-offset-4 [overflow-wrap:anywhere] hover:underline">{text.slice(0, 200) || "…"}</CollapsibleTrigger>
    <CollapsibleContent forceMount className="data-[state=closed]:hidden"><pre className={pre}>{full}</pre></CollapsibleContent>
  </Collapsible>
}

const wrapCell = "whitespace-normal [overflow-wrap:anywhere]"

function RunInfoView({ info }: { info: RunInfo }) {
  const { t } = useI18n()
  const r = info.resources ?? {}
  const mounts = Object.entries(info.mounts ?? {}).filter(([, on]) => on).map(([name]) => name)
  const setup: [string, string | undefined][] = [
    [t("diag.image"), info.image], [t("diag.image_id"), info.imageId], [t("diag.app_commit"), info.appCommit],
    [t("diag.started"), info.startedAt && new Date(info.startedAt).toLocaleString()],
    [t("diag.resources"), [r.cpus !== undefined && `${r.cpus} CPU`, r.memoryMb !== undefined && `${r.memoryMb} MB`, r.memorySwapMb !== undefined && `swap ${r.memorySwapMb} MB`].filter(Boolean).join(" · ")],
    [t("diag.mounts"), mounts.join(", ") || t("diag.none")],
  ]
  return <div className="flex flex-col gap-6">
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{t("diag.setup")}</h3>
      <Table><TableBody>
        {setup.map(([key, value]) => <TableRow key={key}><TableHead scope="row" className="h-auto py-2 align-top">{key}</TableHead><TableCell className={cn(wrapCell, "align-top")}><code className="text-xs whitespace-pre-wrap">{value || "—"}</code></TableCell></TableRow>)}
      </TableBody></Table>
    </section>
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{t("diag.env")}</h3>
      <Table><TableBody>
        {Object.entries(info.env ?? {}).map(([key, value]) => <TableRow key={key}><TableHead scope="row" className="h-auto py-2 align-top"><code className="text-xs">{key}</code></TableHead><TableCell className={cn(wrapCell, "align-top")}><code className="text-xs whitespace-pre-wrap">{value}</code></TableCell></TableRow>)}
      </TableBody></Table>
    </section>
  </div>
}

function EventsView({ text }: { text: string }) {
  const { t } = useI18n()
  const { rows, hidden } = eventRows(text)
  return <div className="flex flex-col gap-3">
    {hidden > 0 && <p className="text-[13px] text-muted-foreground">{t("diag.hidden", { count: hidden })}</p>}
    <Table>
      <TableHeader><TableRow><TableHead>{t("diag.time")}</TableHead><TableHead>{t("diag.kind")}</TableHead><TableHead>{t("diag.detail")}</TableHead></TableRow></TableHeader>
      <TableBody>{rows.map((row, i) => <TableRow key={i} className="[&>td]:align-top">
        <TableCell><code className="text-xs">{row.at}</code></TableCell>
        <TableCell>{row.label}</TableCell>
        <TableCell className={cn(wrapCell, "w-[70%] min-w-[280px]")}><Long text={row.text} detail={row.detail} /></TableCell>
      </TableRow>)}</TableBody>
    </Table>
  </div>
}

function ContextView({ docs }: { docs: { path: string, content: string }[] }) {
  return <div className="flex flex-col gap-3">
    {docs.map((doc, i) => <Fold key={doc.path} defaultOpen={i === 0} summary={<span className={fileName}>{doc.path}</span>}>
      {markdown(doc.content, "max-w-none p-4")}
    </Fold>)}
  </div>
}

// Also reads the run report, patch and commit log, so every run file opens the same way.
export function DiagnosticReader({ runId, kind, title, onClose }: { runId: string, kind: DiagnosticKind | "report" | "patch" | "commits", title?: string, onClose: () => void }) {
  const { t } = useI18n()
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState("")
  const href = `/api/runs/${encodeURIComponent(runId)}/artifacts/${kind}`
  useEffect(() => {
    const controller = new AbortController()
    fetch(href, { signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); setText(await response.text()) })
      .catch(e => { if (!controller.signal.aborted) setError((e as Error).message) })
    return () => controller.abort()
  }, [href])
  let body: ReactNode = null
  if (text !== null) {
    try {
      body = !text.trim() ? <p className="text-[13px] text-muted-foreground">{t("diag.empty")}</p>
        : kind === "run-info" ? <RunInfoView info={JSON.parse(text)} />
        : kind === "context" ? <ContextView docs={JSON.parse(text)} />
        : kind === "events" ? <EventsView text={text} />
        : kind === "patch" ? <PatchView files={patchFiles(text)} />
        : kind === "commits" ? <CommitsView commits={commitEntries(text)} />
        : kind === "report" ? markdown(text)
        : <pre className={pre}>{text}</pre>
    } catch (e) {
      body = <Alert role="alert" variant="destructive"><AlertDescription>{(e as Error).message}</AlertDescription></Alert>
    }
  }
  return <ReaderModal title={title ?? t(`artifact.${kind}`)} source={runId.slice(0, 8)} href={href} hrefLabel={t("artifact.raw")} onClose={onClose}>
    {error && <Alert role="alert" variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    {text === null && !error && <p role="status" className="py-12 text-center text-muted-foreground">{t("common.loading")}</p>}
    {body}
  </ReaderModal>
}
