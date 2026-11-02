import { useRef, useState } from "react"
import type { ReactNode } from "react"
import { ExternalLink } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useI18n } from "../i18n"

const touch = "max-sm:h-10"

// Callers mount it to open and unmount it to close. Escape and a click outside both close it.
export function ReaderModal({ title, source, href, hrefLabel, onClose, children }: {
  title: string, source: string, href?: string, hrefLabel?: string, onClose: () => void, children: ReactNode,
}) {
  const { t } = useI18n()
  // Read during the first render, before the dialog takes focus. Radix only restores focus to a DialogTrigger.
  const [opener] = useState(() => typeof document === "undefined" ? null : document.activeElement as HTMLElement | null)
  const close = useRef<HTMLButtonElement>(null)
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent showCloseButton={false} aria-describedby={undefined}
      className="flex max-h-[80dvh] w-[min(1000px,calc(100vw-32px))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
      onOpenAutoFocus={event => { event.preventDefault(); close.current?.focus() }}
      onCloseAutoFocus={event => { event.preventDefault(); if (opener?.isConnected) opener.focus() }}>
      <DialogHeader className="flex shrink-0 flex-row flex-wrap items-center justify-between gap-3 border-b px-4 py-4 text-left sm:px-6">
        <div className="min-w-0 flex-1 basis-full sm:basis-0">
          <DialogTitle className="text-lg leading-snug [overflow-wrap:anywhere] sm:text-xl">{title}</DialogTitle>
          <p className="mt-1 text-xs [overflow-wrap:anywhere] text-muted-foreground">{source} · {t("common.read_only")}</p>
        </div>
        <div className="flex items-center gap-2">
          {href && <Button asChild variant="outline" size="sm" className={touch}>
            <a href={href} target="_blank" rel="noopener noreferrer">{hrefLabel ?? t("overview.view_github")}<ExternalLink aria-hidden="true" /></a>
          </Button>}
          <Button ref={close} type="button" variant="outline" size="sm" className={touch} onClick={onClose}>{t("overview.close_tracker")}</Button>
        </div>
      </DialogHeader>
      <div data-slot="reader-body" className="min-h-0 overflow-y-auto p-4 [scrollbar-gutter:stable] sm:p-6 [&_.markdown-body]:max-w-none [&_.markdown-body]:text-base [&_.markdown-body]:leading-[1.75] [&_.markdown-body_table]:min-w-[760px] [&_.markdown-body_table]:text-sm">
        {children}
      </div>
    </DialogContent>
  </Dialog>
}
