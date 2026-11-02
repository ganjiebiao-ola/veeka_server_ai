import { useEffect, useRef, useState } from "react"
import { Loader2 } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useI18n } from "../i18n"
import type { ProfileOverride, RepoProfile as Profile } from "../../../shared/types"

// The repo's PHP version and framework. The scan uses them to skip bug types that do not apply.
// The operator can set either one. An empty field keeps the detected value.
export function RepoProfile(props: { url: string; profile: Profile | null; override: ProfileOverride | null; detecting?: boolean; onSaved: (override: ProfileOverride) => void }) {
  const { t } = useI18n()
  const [php, setPhp] = useState(props.override?.php ?? "")
  const [framework, setFramework] = useState(props.override?.framework ?? "")
  const [state, setState] = useState<"" | "saving" | "saved" | string>("")
  const saving = useRef(false)
  // The fields follow the picked repo. A save keeps them as typed.
  useEffect(() => {
    setPhp(props.override?.php ?? "")
    setFramework(props.override?.framework ?? "")
    setState("")
  }, [props.url])

  const { profile } = props
  const phpValue = props.override?.php || profile?.php || ""
  const frameworkValue = props.override?.framework || profile?.framework || ""
  const validPhp = !php.trim() || /^\d+\.\d+$/.test(php.trim())
  const changed = php.trim() !== (props.override?.php ?? "") || framework.trim().toLowerCase() !== (props.override?.framework ?? "")

  const save = async () => {
    if (saving.current || !validPhp || !changed) return
    saving.current = true
    setState("saving")
    const body = { url: props.url, php: php.trim(), framework: framework.trim().toLowerCase() }
    try {
      const res = await fetch("/api/repos/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null)
      if (res?.ok) { props.onSaved({ php: body.php, framework: body.framework }); setState("saved") }
      else setState(((await res?.json().catch(() => null)) as { error?: string } | null)?.error ?? t("profile.save_failed"))
    } finally { saving.current = false }
  }

  return (
    <div className="flex flex-col gap-3">
      <span className="text-sm font-medium">{t("profile.title")}</span>
      {profile === null && props.detecting ? <span className={`${desc} flex items-center gap-1.5`} role="status"><Loader2 className="size-3.5 animate-spin" aria-hidden />{t("profile.detecting")}</span>
        : profile === null ? <span className={desc}>{t("profile.first_scan")}</span>
        : profile.language !== "php" ? <Alert variant="destructive"><AlertDescription>{t("profile.not_php")}</AlertDescription></Alert>
        : <span className={`${desc} [overflow-wrap:anywhere]`}>
          PHP {phpValue || "?"}{props.override?.php ? ` (${t("profile.yours")})` : ""} · {frameworkValue || t("profile.no_framework")}{props.override?.framework ? ` (${t("profile.yours")})` : ""}
        </span>}
      {profile?.language === "php" && !phpValue && <Alert variant="warning"><AlertDescription>{t("profile.missing_php")}</AlertDescription></Alert>}
      <div className="grid items-start gap-3 sm:grid-cols-2">
        <Label className={field}>
          <span>{t("profile.php")}</span>
          <Input type="text" className="font-normal" placeholder={profile?.php || "7.2"} value={php}
            onChange={(e) => setPhp(e.target.value)} aria-invalid={!validPhp} />
        </Label>
        <Label className={field}>
          <span>{t("profile.framework")}</span>
          <Input type="text" className="font-normal" placeholder={profile?.framework || "phalcon"} value={framework}
            onChange={(e) => setFramework(e.target.value)} />
        </Label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" disabled={!validPhp || !changed || state === "saving"} onClick={save}>{t("profile.save")}</Button>
        {state === "saved" ? <span className={desc}>{t("profile.saved")}</span>
          : state && state !== "saving" ? <span className="text-xs text-red-700 dark:text-red-400">{state}</span> : null}
      </div>
    </div>
  )
}

const desc = "text-xs text-muted-foreground"
const field = "min-w-0 flex-col items-stretch gap-1.5"
