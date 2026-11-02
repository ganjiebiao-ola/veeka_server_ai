import { useEffect, useState } from "react"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useI18n } from "../i18n"

export function KeySettings() {
  const { t, lang } = useI18n()
  const [keys, setKeys] = useState<{ anthropicApiKey: string | null, openaiApiKey: string | null, relayAuthToken: string | null, ghToken: string | null }>()
  const [claude, setClaude] = useState("")
  const [openai, setOpenai] = useState("")
  const [relay, setRelay] = useState("")
  const [github, setGithub] = useState("")
  const [message, setMessage] = useState("")
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  async function load() {
    setLoading(true)
    setMessage("")
    try {
      const response = await fetch("/api/setup/keys")
      if (!response.ok) throw new Error()
      setKeys(await response.json())
    } catch { setMessage(t("keys.load_failed")) } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [lang])

  async function save() {
    setSaving(true)
    setMessage("")
    try {
      const response = await fetch("/api/setup/keys", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(claude ? { anthropicApiKey: claude } : {}), ...(openai ? { openaiApiKey: openai } : {}), ...(relay ? { relayAuthToken: relay } : {}), ...(github ? { ghToken: github } : {}) }),
      })
      if (!response.ok) throw new Error()
      setClaude("")
      setOpenai("")
      setRelay("")
      setGithub("")
      window.location.reload()
    } catch { setMessage(t("keys.save_failed")) } finally { setSaving(false) }
  }

  const field = (id: string, name: string, value: string, placeholder: string | null | undefined, set: (value: string) => void, hint?: string) =>
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{name}</Label>
      <Input id={id} type="password" autoComplete="off" value={value} placeholder={placeholder ?? t("keys.unset")} onChange={e => set(e.target.value)} />
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>

  return <Card className="py-0">
    <Accordion type="single" collapsible className="px-5 max-sm:px-4">
      <AccordionItem value="keys">
        <AccordionTrigger>{t("keys.title")}</AccordionTrigger>
        {/* forceMount keeps the content in the page while closed, as <details> did. */}
        <AccordionContent forceMount className="flex max-w-5xl flex-col gap-4 [[data-state=closed]>&]:hidden">
          <p className="text-xs text-muted-foreground">{t("keys.description")}</p>
          <div className="grid items-start gap-3 sm:grid-cols-2">
            {field("key-claude", t("keys.claude"), claude, keys?.anthropicApiKey, setClaude)}
            {field("key-openai", t("keys.openai"), openai, keys?.openaiApiKey, setOpenai)}
            {field("key-relay", t("keys.relay"), relay, keys?.relayAuthToken, setRelay)}
            {field("key-github", t("keys.github"), github, keys?.ghToken, setGithub, t("keys.github_hint"))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" disabled={saving || (!claude && !openai && !relay && !github)} onClick={() => void save()}>{t("keys.save")}</Button>
            <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={() => void load()}>{loading ? t("common.refreshing") : t("common.refresh")}</Button>
          </div>
          {message && <Alert variant="destructive" role="alert"><AlertDescription>{message}</AlertDescription></Alert>}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  </Card>
}
