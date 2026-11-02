import { Info } from "lucide-react"
import { useI18n } from "../i18n"
import { Badge, severityVariant } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"

// Mirrors the levels in the headings of skill/ola-security-audit/SKILL.md; tests/severity_guide_test.tsx checks they agree.
export const FIXED_LEVELS = {
  P0: ["sqli", "cmd-injection", "signature-compare", "cors", "hardcoded-secret", "dead-code"],
  P1: ["numeric-juggling", "path-ssrf", "weak-random", "tls-verify-off", "mass-assignment", "loose-compare"],
  P2: ["weak-hash", "log-leak"],
} as const
export const CODE_DEPENDENT = {
  "deserialization": ["P0", "P1"],
  "vendor-cve": ["P1", "P2"],
  "api-no-auth": ["P0", "P1", "P2"],
  "api-test-exposed": ["P0", "P1", "P2"],
} as const

export function SeverityGuide() {
  const { t } = useI18n()
  return <Dialog>
    <DialogTrigger asChild>
      <Button type="button" variant="ghost" size="icon-sm" className="-my-1 size-6 text-muted-foreground" aria-label={t("severity.guide_open")}>
        <Info aria-hidden="true" />
      </Button>
    </DialogTrigger>
    <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{t("severity.guide_title")}</DialogTitle>
        <DialogDescription>{t("severity.guide_intro")}</DialogDescription>
      </DialogHeader>
      <dl className="grid gap-4 text-sm">
        {(Object.keys(FIXED_LEVELS) as Array<keyof typeof FIXED_LEVELS>).map(level => <div key={level} className="grid gap-1.5">
          <dt className="flex items-center gap-2 font-semibold"><Badge variant={severityVariant(level)}>{level}</Badge>{t(`severity.${level}`)}</dt>
          <dd className="text-muted-foreground">{FIXED_LEVELS[level].map(id => t(`category.${id}`)).join(" · ")}</dd>
        </div>)}
        <div className="grid gap-1.5">
          <dt className="font-semibold">{t("severity.depends")}</dt>
          <dd><ul className="grid gap-1.5">{(Object.keys(CODE_DEPENDENT) as Array<keyof typeof CODE_DEPENDENT>).map(id => <li key={id}>
            <span className="font-medium">{t(`category.${id}`)}</span> <span className="text-muted-foreground">· {t(`severity.note.${id}`)}</span>
          </li>)}</ul></dd>
        </div>
      </dl>
      <p className="border-t pt-3 text-[13px] text-muted-foreground">{t("severity.guide_filter")}</p>
    </DialogContent>
  </Dialog>
}
