import { useRef, useState } from "react"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { repoKey, useRecentRepos, type RecentRepo } from "../hooks/useRecentRepos"
import { useRepoLanguage } from "../hooks/useRepoLanguage"
import { useI18n } from "../i18n"
import { shortRepo } from "../types/events"
import { ConfirmDialog } from "./ConfirmDialog"

function RepoRow({ repo, removing, onRemove }: { repo: RecentRepo; removing: boolean; onRemove: () => void }) {
  const { t } = useI18n()
  const language = useRepoLanguage(repo.url).data
  return <div className="flex items-center justify-between gap-2">
    <span className="min-w-0 text-sm [overflow-wrap:anywhere]">{[shortRepo(repo.url), repo.branch, language?.language].filter(Boolean).join(" · ")}</span>
    <Button type="button" variant="outline" size="sm" className="shrink-0" title={t("repo.remove_title")} aria-label={t("repo.remove_label", { repo: repoKey(repo.url) })} disabled={removing} onClick={onRemove}>{t("common.remove")}</Button>
  </div>
}

export function RepoSettings({ recent }: { recent: ReturnType<typeof useRecentRepos> }) {
  const { t } = useI18n()
  const [url, setUrl] = useState("")
  const [branch, setBranch] = useState("")
  const [removeRepo, setRemoveRepo] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const addingRef = useRef(false)
  const [status, setStatus] = useState("")
  const language = useRepoLanguage(url.trim()).data
  const validUrl = /^https?:\/\/.+\..+/.test(url.trim())
  const alreadyListed = recent.repos.some(repo => repoKey(repo.url) === repoKey(url))

  async function addRepo() {
    if (!validUrl || language?.language !== "PHP" || alreadyListed || addingRef.current || recent.removing) return
    addingRef.current = true
    setAdding(true)
    setStatus("")
    try {
      const res = await fetch("/api/repos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: url.trim(), branch }) }).catch(() => null)
      const body = await res?.json().catch(() => null) as { ok?: boolean; error?: string } | null
      if (res?.ok && body?.ok) { await recent.reload(); void recent.detect(url.trim()); setUrl(""); setBranch(""); setStatus(t("landing.added")) }
      else setStatus(body?.error || t("landing.add_failed"))
    } catch { setStatus(t("landing.add_failed")) }
    finally { addingRef.current = false; setAdding(false) }
  }

  return <Card className="py-0">
    <Accordion type="single" collapsible className="px-5 max-sm:px-4">
      <AccordionItem value="repos">
        <AccordionTrigger><span>{t("repos.title")} <span className="font-normal text-muted-foreground">· {recent.repos.length}</span></span></AccordionTrigger>
        {/* forceMount keeps the content in the page while closed, as <details> did. */}
        <AccordionContent forceMount className="flex max-w-5xl flex-col gap-4 [[data-state=closed]>&]:hidden">
          <p className={desc}>{t("repos.single_only")}</p>
          {recent.repos.length ? recent.repos.map(repo => <RepoRow key={repo.url} repo={repo} removing={recent.removing || adding} onRemove={() => setRemoveRepo(repo.url)} />) : <p className={desc}>{t("repos.empty")}</p>}
          {recent.error && <Alert variant="destructive" role="alert"><AlertDescription>{recent.error}</AlertDescription></Alert>}
          <div className="grid items-start gap-3 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="repo-url">{t("landing.field_repo")}</Label>
              <Input id="repo-url" type="url" disabled={adding} placeholder="https://github.com/owner/repo.git" value={url} onChange={e => { setUrl(e.target.value); setStatus("") }} />
              {language && <span className={desc}>{t("profile.language", { language: language.language, share: language.share })}</span>}
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="repo-branch">{t("repos.branch")}</Label>
              <Input id="repo-branch" type="text" disabled={adding} value={branch} onChange={e => setBranch(e.target.value)} />
            </div>
          </div>
          {language && language.language !== "PHP" && <Alert variant="warning"><AlertDescription>{t("profile.language_warning", { language: language.language })}</AlertDescription></Alert>}
          <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" disabled={!validUrl || language?.language !== "PHP" || alreadyListed || adding || recent.removing} onClick={() => void addRepo()}>{t("landing.add_repo")}</Button></div>
          {status && <span className={desc} role="status">{status}</span>}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
    {removeRepo && <ConfirmDialog message={t("repo.remove_confirm", { repo: removeRepo })} confirmLabel={t("common.remove")}
      onCancel={() => setRemoveRepo(null)} onConfirm={() => { setRemoveRepo(null); void recent.forget(removeRepo) }} />}
  </Card>
}

const desc = "text-xs text-muted-foreground"
