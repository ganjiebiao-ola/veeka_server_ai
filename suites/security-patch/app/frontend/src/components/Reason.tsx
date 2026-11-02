import { useLayoutEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useI18n } from "../i18n"

// Same list as LABELS in backend/tracker/rows.ts.
const LABEL = /^(Verdict|Evidence|Severity|Fix|Advisories|IDs|Trees|Ignored|Earlier reason):\s*/

// GHSA IDs link to the GitHub advisory database.
function linked(text: string) {
  return text.split(/(GHSA(?:-[a-z0-9]{4}){3})/i).map((part, i) => i % 2
    ? <a key={i} className="text-primary underline-offset-4 hover:underline" href={`https://github.com/advisories/${part}`} target="_blank" rel="noopener noreferrer">{part}</a> : part)
}

const toggle = "h-auto p-0 text-xs"

// A finding reason: one line per paragraph, bold labels, and long text folded to 3 lines until clicked.
export function Reason({ text }: { text: string }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [cut, setCut] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  // Show the toggle only when the fold hides text at the current width.
  useLayoutEffect(() => {
    const el = box.current
    if (!el || open) return
    const check = () => setCut(el.scrollHeight > el.clientHeight + 1)
    check()
    const observer = new ResizeObserver(check)
    observer.observe(el)
    return () => observer.disconnect()
  }, [text, open])
  if (!text) return <span className="text-muted-foreground">—</span>
  // " · " is the separator from before line breaks.
  const lines = text.split(/\n| · (?=Earlier reason: )/).filter(line => line.trim())
  let advisories = false
  let bullets = 0
  return <div className="text-[13px]">
    <div ref={box} className={cn("[overflow-wrap:anywhere] [&_p]:mb-1", !open && "line-clamp-3")}>
      {lines.map((line, i) => {
        if (LABEL.test(line)) { advisories = line.startsWith("Advisories:"); bullets = 0 }
        if (advisories && line.startsWith("- ") && !open && ++bullets > 5) {
          if (bullets > 6) return null
          let end = i
          while (lines[end]?.startsWith("- ")) end++
          return <Button key={i} type="button" variant="link" className={toggle} onClick={() => setOpen(true)}>{t("common.more", { count: end - i })}</Button>
        }
        // The IDs line is a plain list, so any ID counts (PKSA-..., not only CVE/GHSA). Advisories lines mix IDs into titles.
        const ids = /^IDs:/.test(line) ? [...line.slice(4).matchAll(/[^,\s]+/g)].map(m => Object.assign(m, { index: m.index! + 4 }))
          : line.startsWith("Advisories:") ? [...line.matchAll(/\b(?:CVE-\d{4}-\d{4,}|GHSA(?:-[a-z0-9]{4}){3})\b/gi)] : []
        const more = !open && ids.length > 5 ? ids.length - 5 : 0
        const shown = more ? line.slice(0, ids[4].index! + ids[4][0].length) : line
        const label = LABEL.exec(line)
        if (line.startsWith("- ")) return <p key={i} className="pl-3 -indent-2.5">• {linked(line.slice(2))}</p>
        return <p key={i}>{label ? <><b>{label[1]}:</b> {linked(shown.slice(label[0].length))}</> : linked(shown)}
          {more > 0 && <> <Button type="button" variant="link" className={toggle} onClick={() => setOpen(true)}>{t("common.more", { count: more })}</Button></>}
        </p>
      })}
    </div>
    {(cut || open) && <Button type="button" variant="link" className={toggle} onClick={() => setOpen(!open)}>{open ? t("report.collapse") : t("report.expand")}</Button>}
  </div>
}
