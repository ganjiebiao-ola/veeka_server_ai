import { useRef, useState } from "react"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { useI18n } from "../i18n"

// Callers mount it to ask and unmount it to close. Escape cancels; clicking outside does nothing.
export function ConfirmDialog({ title: heading, message, confirmLabel, cancelLabel, onConfirm, onCancel }: {
  title?: string
  cancelLabel?: string
  message: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const { t } = useI18n()
  // Read during the first render, before the dialog takes focus.
  const [opener] = useState(() => typeof document === "undefined" ? null : document.activeElement as HTMLElement | null)
  const cancel = useRef<HTMLButtonElement>(null)

  return <AlertDialog open onOpenChange={open => { if (!open) onCancel() }}>
    <AlertDialogContent {...(!heading && { "aria-describedby": undefined })} onOpenAutoFocus={event => {
      event.preventDefault()
      cancel.current?.focus()
    }} onCloseAutoFocus={event => {
      // A disabled opener cannot take focus back, so the page does.
      event.preventDefault()
      if (opener?.isConnected && !opener.matches(":disabled")) opener.focus()
      else document.querySelector<HTMLElement>("main")?.focus()
    }}>
      <AlertDialogHeader>
        <AlertDialogTitle>{heading ?? message}</AlertDialogTitle>
        {heading && <AlertDialogDescription>{message}</AlertDialogDescription>}
      </AlertDialogHeader>
      <AlertDialogFooter>
        <Button ref={cancel} type="button" variant="outline" onClick={onCancel}>{cancelLabel ?? t("overview.close_cancel")}</Button>
        <Button type="button" onClick={onConfirm}>{confirmLabel}</Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
}
