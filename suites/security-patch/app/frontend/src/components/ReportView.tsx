import { VULN_CATEGORIES } from "../types/events";
import { useEffect, useRef, useState } from "react";
import type React from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useI18n } from "../i18n";
import { ChevronRight } from "lucide-react";
import { Badge, severityVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// Marker the scanner bridge writes on its own line just above the final
// self-contained summary. Keep in sync with scanner/bridge.mjs SUMMARY_MARKER
// and SKILL.md §3 Step G.
export const SUMMARY_MARKER = "<!-- OLA:FINAL-SUMMARY -->";

/** Split a live assistant stream into { summary, log }:
 *   - log     = full text with every marker stripped (so the raw comment never
 *               shows as literal text in the streaming <pre>).
 *   - summary = everything after the LAST marker ("" if none present yet). */
export function splitSummary(text: string, marker = SUMMARY_MARKER): { summary: string; log: string } {
  const idx = text.lastIndexOf(marker);
  // No marker yet (or an old marker-less security-review run): the whole
  // stream IS the log; summary stays empty so callers can fall back to it.
  if (idx < 0) return { summary: "", log: text.trim() };
  // Split ON the last marker so the summary tail is NOT left duplicated in the
  // log (log = process narration before the marker; summary = after it).
  return { summary: text.slice(idx + marker.length).trim(), log: text.slice(0, idx).trim() };
}

export type ScopeInfo = { skill: string; categories: string[]; mode?: "scan" | "fix" };

// Category scoping only exists for ola-security-audit: empty categories on THAT
// skill = the full audit; on any other skill (old security-review
// runs / generic) categories don't apply at all, so an empty array must NOT be read as
// "full audit". Keep skill + categories together everywhere scope shows.
type T = (key: string, params?: Record<string, string | number>) => string;

export function scopeLabel(t: T, skill: string | undefined, categories: string[] | null | undefined, mode?: "scan" | "fix"): string {
  if (mode === "fix") return "";
  if (skill && skill !== "ola-security-audit") return t(skill === "security-review" ? "scope.review" : "scope.not_applicable");
  return categories && categories.length > 0 ? t("scope.scoped", { types: categories.map(value => {
    const translated = t(`category.${value}`)
    return translated === `category.${value}` ? value : translated
  }).join(", ") }) : t("scope.full", { count: VULN_CATEGORIES.length })
}

// Short label for dense contexts (History table cell).
export function scopeShort(t: T, skill: string | undefined, categories: string[] | null | undefined, mode?: "scan" | "fix"): string {
  if (mode === "fix") return "";
  if (skill && skill !== "ola-security-audit") return skill === "security-review" ? t("scope.review") : "—";
  return t(categories && categories.length > 0 ? "scope.short_scoped" : "scope.short_full");
}

// True only for a genuinely narrowed ola-security-audit scan (warrants a warning
// tone so it isn't mistaken for a complete audit).
export function isScopedScan(skill: string | undefined, categories: string[] | null | undefined, mode?: "scan" | "fix"): boolean {
  if (mode === "fix") return false;
  return (!skill || skill === "ola-security-audit") && !!categories && categories.length > 0;
}

export interface ReportViewProps {
  runId: string;
  text: string;
  /** Streaming: scan still running, show raw stream to skip markdown re-parse. */
  streaming?: boolean;
  /** Initial open state. Default open=true; set false to collapse by default. */
  defaultOpen?: boolean;
  /** Header label. Default: the audit report title. */
  title?: string;
  /** Which artifact the download link points at. Default "report". */
  downloadKind?: "report" | "response" | "activity";
}

export function ReportView({
  runId,
  text,
  streaming,
  defaultOpen = true,
  title,
  downloadKind = "report",
}: ReportViewProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(defaultOpen);
  // A live stream follows its newest text while the reader stays at the bottom.
  const stream = useRef<HTMLPreElement>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    if (streaming && atBottom.current && stream.current) stream.current.scrollTop = stream.current.scrollHeight;
  }, [text, streaming]);

  if (!text) {
    return (
      <Card className="gap-0 py-0">
        <p className="p-5 text-center text-sm text-muted-foreground">{t(streaming ? "report.streaming" : "report.none")}</p>
      </Card>
    );
  }

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <header className={cn("flex items-center justify-between gap-3 bg-muted/50 py-2 pr-3 pl-4", open && "border-b")}>
        <button
          type="button"
          className="group flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          title={t(open ? "report.collapse" : "report.expand")}
        >
          <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform group-aria-expanded:rotate-90" />
          <span className="text-[13px] font-semibold whitespace-nowrap group-hover:text-primary">{title ?? t("report.audit")}</span>
          {!open ? (
            <span data-testid="report-preview" className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{previewLine(text)}</span>
          ) : null}
        </button>
        <Button asChild variant="outline" size="sm">
          <a
            href={`/api/runs/${encodeURIComponent(runId)}/artifacts/${downloadKind}`}
            target="_blank"
            rel="noopener noreferrer"
            title={downloadKind === "response" ? "summary.md" : downloadKind === "activity" ? "activity.md" : "report.md"}
          >
            {t("report.download")}
          </a>
        </Button>
      </header>
      {open ? (
        <article className="px-4 py-4 sm:px-5">
          {streaming ? (
            <pre ref={stream} className="m-0 max-h-[60vh] overflow-y-auto font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]"
              onScroll={(e) => { const el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
              {text}
              <span className="ml-0.5 inline-block animate-pulse text-primary motion-reduce:animate-none" aria-hidden="true">▍</span>
            </pre>
          ) : (
            <div className="markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents} skipHtml>
                {text}
              </ReactMarkdown>
            </div>
          )}
        </article>
      ) : null}
    </Card>
  );
}

// First non-empty line, max 80 chars. Used as a collapsed preview so the
// user can still tell at a glance what the report is about.
function previewLine(text: string): string {
  const line = text.split(SUMMARY_MARKER).join("").split("\n").find((l) => l.trim().length > 0) ?? "";
  const trimmed = line.replace(/^#+\s*/, "").trim();
  return trimmed.length > 80 ? trimmed.slice(0, 80) + "…" : trimmed;
}

function extractNodeText(node: React.ReactNode): string {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractNodeText).join("");
  if (typeof node === "object" && "props" in node && (node as { props?: { children?: React.ReactNode } }).props) {
    return extractNodeText((node as { props: { children?: React.ReactNode } }).props.children);
  }
  return "";
}

const severityCell = "w-[88px] min-w-[88px] text-center whitespace-nowrap";

/** Only https URLs may become links or loaded media. Hostile report text must not reach other schemes. */
export const isHttps = (url: string | null | undefined) => /^https:\/\//i.test(url ?? "");
/** PR links come from GitHub only. */
export const githubUrl = (url: string | null | undefined) => /^https:\/\/github\.com\//i.test(url ?? "") ? url! : undefined;

export const markdownComponents: Components = {
  a({ href, children }) {
    if (href?.startsWith("#")) return <a href={href}>{children}</a>;
    if (!isHttps(href)) return <>{children}</>;
    return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
  },
  // Never load report images: they leak the viewer's IP and can GET same-origin routes.
  img({ alt }) {
    return <>{alt}</>;
  },
  table({ children, ...props }) {
    return (
      <div className="mt-3 mb-4 max-w-full overflow-x-auto rounded-md border bg-card shadow-xs">
        <table {...props}>{children}</table>
      </div>
    );
  },
  td({ children, ...props }) {
    const raw = extractNodeText(children).trim();
    const match = raw.match(/^(?:[🔴🟡🟠🔵]\s*)?(P[012])(?:\s*[\u7ea7])?$/i);
    if (match) {
      const lvl = match[1].toUpperCase();
      return (
        <td {...props} className={severityCell}>
          <Badge variant={severityVariant(lvl)}>{lvl}</Badge>
        </td>
      );
    }
    return <td {...props}>{children}</td>;
  },
  th({ children, ...props }) {
    const raw = extractNodeText(children).trim().toLowerCase();
    const isSeverity = /^(severity|\u4e25\u91cd|\u4e25\u91cd\u7ea7\u522b|\u4e25\u91cd\u5ea6|\u7b49\u7ea7)$/i.test(raw);
    return (
      <th {...props} className={isSeverity ? severityCell : undefined}>
        {children}
      </th>
    );
  },
};
