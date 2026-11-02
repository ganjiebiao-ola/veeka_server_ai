import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect } from "@/components/ui/native-select"
import { Page } from "../components/Page"
import { VULN_CATEGORIES } from "../types/events";
import { useRecentRepos } from "../hooks/useRecentRepos";
import { useRelayModels } from "../hooks/useRelayModels";
import { useRepoLanguage } from "../hooks/useRepoLanguage";
import { ActiveRunBanner } from "../components/ActiveRunBanner";
import { RepoProfile } from "../components/RepoProfile";
import { KeySettings } from "../components/KeySettings"
import { RepoSettings } from "../components/RepoSettings"
import type { ActiveRun } from "../hooks/useActiveRuns";
import { PROVIDERS, CATEGORY_GROUPS, DEFAULT_CATEGORIES, shortRepo, displayProvider } from "../types/events"
import type { ProviderId } from "../types/events"
import type { ProviderAvailability } from "../components/ProviderSelect"
import { ProviderSelect, choiceProvider, providerChoice, usesApiKey, type ProviderChoice } from "../components/ProviderSelect"
import { useEffect, useRef, useState } from "react";
import { useDevMode } from "../hooks/useDevMode";
import { useI18n } from "../i18n";
import type {
  Effort,
  RunMode,
  SkillName,
  StartRunRequest,
  StartRunResponse,
  VulnCategory,
} from "../types/events";

export interface LandingPageProps {
  sessionId: string;
  startRun: (req: StartRunRequest) => Promise<StartRunResponse>;
  activeRuns: ActiveRun[];
  onStarted: (runId: string, mode: RunMode) => void;
}

export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export function LandingPage(props: LandingPageProps) {
  const { t, label, lang } = useI18n()
  const dev = useDevMode();
  const [smokeCheck, setSmokeCheck] = useState(false)
  const [providerError, setProviderError] = useState("")
  const [availability, setAvailability] = useState<ProviderAvailability>()
  useEffect(() => {
    let alive = true
    fetch("/api/providers")
      .then(async response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = await response.json() as ProviderAvailability
        if (alive) setAvailability(data)
      })
      .catch(error => { if (alive) setProviderError(error.message) })
    return () => { alive = false }
  }, [])
  const recent = useRecentRepos();
  const [repoUrl, setRepoUrl] = useState("");
  const [commitSha, setCommitSha] = useState("");
  const [branch, setBranch] = useState("");
  useEffect(() => {
    if (recent.repos.some(repo => repo.url === repoUrl)) return
    const pick = recent.repos[0]
    setRepoUrl(pick?.url ?? "")
    setBranch(pick?.branch ?? "")
    setCommitSha("")
  }, [recent.repos, repoUrl])
  const skill: SkillName = "ola-security-audit";
  const [provider, setProvider] = useState<ProviderId>("claude")
  const [model, setModel] = useState("sonnet")
  const [effort, setEffort] = useState<Effort>("high");
  const [choices, setChoices] = useState<Record<string, { model: string, effort: Effort }>>({})
  // Scan is the only start mode. Pick starts fix runs.
  const mode: RunMode = "scan";
  const [categories, setCategories] = useState<VulnCategory[]>([...DEFAULT_CATEGORIES]);
  const [includeP2, setIncludeP2] = useState(false);
  const [maxSubagents, setMaxSubagents] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false)
  const [error, setError] = useState<string | null>(null);
  const relay = useRelayModels();
  const [useRelay, setUseRelay] = useState(false);
  // The provider on the server's API key instead of its login. On by default when the server has a key.
  const [useApiKey, setUseApiKey] = useState(true);

  const apiKey = !useRelay && usesApiKey(availability, provider, useApiKey);

  const languageResult = useRepoLanguage(repoUrl.trim());
  const repoLanguage = languageResult.data?.language ? languageResult.data : null;
  const nonPhp = Boolean(repoLanguage && repoLanguage.language !== "PHP");
  const validSha = !commitSha.trim() || /^[a-fA-F0-9]{40}$/.test(commitSha.trim());
  const blocked = recent.loadStatus === "loading" ? t("landing.loading_repos")
    : recent.loadStatus === "error" ? recent.error || t("landing.repos_failed")
    : !recent.repos.some(repo => repo.url === repoUrl) ? t("landing.no_repos")
    : !availability ? providerError ? t("provider.load_failed", { msg: providerError }) : t("landing.loading_providers")
    : languageResult.status === "loading" ? t("landing.detecting_language")
    : nonPhp ? t("profile.language_warning", { language: repoLanguage!.language })
    : !validSha ? t("landing.commit_invalid")
    : useRelay && !relay.models.length ? t("landing.no_relay_models")
    : !useRelay && availability[provider]?.available === false ? t("pick.provider_down")
    : skill === "ola-security-audit" && !categories.length ? t("landing.no_bug_types")
    : submitting ? t("common.working") : null;
  const canStart = !blocked;
  const recentRepo = recent.repos.find((r) => r.url === repoUrl.trim());
  const modelLabel = useRelay ? model : PROVIDERS[provider].models.find(o => o.value === model)?.label ?? model
  const providerLabel = displayProvider({ provider, authMode: useRelay ? "relay" : apiKey ? "api-key" : "oauth" }, t)
  // Model names like "Claude Sonnet 5.5" already carry the provider name.
  const auth = useRelay ? "litellm" : apiKey ? "api-key" : availability?.[provider]?.auth
  const advancedSummary = [modelLabel.toLowerCase().includes(providerLabel.toLowerCase()) ? "" : providerLabel, modelLabel, PROVIDERS[provider].efforts.length > 0 ? t(`effort.${effort}`) : "", provider === "claude" && maxSubagents > 0 ? t("run.facts_subagents", { n: maxSubagents }) : ""].filter(Boolean).join(" · ")

  const onStart = async () => {
    if (!canStart || submittingRef.current) return
    submittingRef.current = true
    setError(null);
    setSubmitting(true);
    try {
      const resp = await props.startRun({
        sessionId: props.sessionId,
        repoUrl: repoUrl.trim(),
        branch: branch.trim() || undefined,
        commitSha: commitSha.trim() || undefined,
        skill, model, mode, provider, language: lang, includeP2,
        ...(PROVIDERS[provider].efforts.length ? { effort } : {}),
        ...(dev && smokeCheck ? { smokeSeconds: 30 } : {}),
        categories: skill === "ola-security-audit" ? categories : [],
        ...(dev && provider === "claude" ? { maxSubagents } : {}),
        ...(useRelay ? { authMode: "relay" as const } : apiKey ? { authMode: "api-key" as const } : {}),
      });
      props.onStarted(resp.runId, mode);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      submittingRef.current = false
      setSubmitting(false);
    }
  };


  return (
    <Page tabIndex={-1}>
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t("landing.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("landing.subtitle")}</p>
        </div>
      </header>

      <ActiveRunBanner runs={props.activeRuns} />
      <KeySettings />
      <RepoSettings recent={recent} />

      <Card>
        {/* The page is full width like the others; the form keeps a readable line length. */}
        <CardContent className="flex max-w-5xl flex-col gap-4">
          {recent.repos.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="recent-repo">{t("landing.recent_repos")}</Label>
              <NativeSelect
                id="recent-repo"
                className="bg-background"
                value={recentRepo ? repoUrl : ""}
                onChange={(e) => {
                  const pick = recent.repos.find((r) => r.url === e.target.value);
                  if (pick) { setRepoUrl(pick.url); setBranch(pick.branch); setCommitSha(""); }
                }}
              >
                {recent.repos.map((r) => (
                  <option key={r.url} value={r.url}>
                    {shortRepo(r.url)}{r.branch ? ` · ${r.branch}` : ""}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}

          {recent.loadStatus === "error" && <Alert variant="destructive" role="alert"><AlertDescription>{recent.error}</AlertDescription></Alert>}
          {recent.loadStatus === "done" && !recent.repos.length && <p className={desc}>{t("landing.no_repos")}</p>}
          {repoLanguage && <span className={desc}>{t("profile.language", { language: repoLanguage.language, share: repoLanguage.share })}</span>}
          {nonPhp && <Alert variant="warning"><AlertDescription>{t("profile.language_warning", { language: repoLanguage!.language })}</AlertDescription></Alert>}
          <div className="grid items-start gap-3 sm:grid-cols-2">
            <Label className={field}>
              <span>{t("term.branch")}</span>
              <Input
                type="text"
                className="font-normal"
                placeholder={t("landing.branch_placeholder")}
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
              />
            </Label>
            <Label className={field}>
              <span>{t("landing.field_commit")}</span>
              <Input
                type="text"
                className="font-normal"
                placeholder={t("landing.commit_placeholder")}
                value={commitSha}
                onChange={(e) => setCommitSha(e.target.value)}
                aria-invalid={!validSha}
              />
              {!validSha && <span className={`${descError} font-normal`}>{t("landing.commit_invalid")}</span>}
            </Label>
          </div>

          {recentRepo && !nonPhp && (
            <RepoProfile url={recentRepo.url} profile={recentRepo.profile ?? null} override={recentRepo.override ?? null} detecting={recent.detecting.includes(recentRepo.url)}
              onSaved={(override) => recent.setOverride(recentRepo.url, override)} />
          )}

          <div className="flex flex-col gap-2">
            <p className={desc}>{t("landing.priorities")}</p>
            <Label className="w-fit font-normal">
              <Checkbox checked={includeP2} onCheckedChange={v => setIncludeP2(v === true)} />
              {t("landing.include_p2")}
            </Label>
          </div>

          <Accordion type="multiple" className="border-t">
            <AccordionItem value="advanced">
              <AccordionTrigger>
                <span className="flex flex-wrap items-center gap-2">
                  <span>{t("landing.advanced")} <span className="font-normal text-muted-foreground">· {advancedSummary}</span></span>
                  {auth ? <Badge variant={AUTH_VARIANT[auth]}>{t(`auth.${auth}`)}</Badge> : null}
                </span>
              </AccordionTrigger>
              <AccordionContent forceMount className={foldContent}>
                <div className="grid items-start gap-3 sm:grid-cols-2">
                  <ProviderSelect availability={availability} value={useRelay ? "litellm" : providerChoice(availability, provider, apiKey)}
                    litellm={{ disabled: relay.models.length === 0, error: relay.error }}
                    onChange={(value: ProviderChoice) => {
                      const next = choiceProvider(value)
                      const target = value === "litellm" ? value : next
                      const saved = { ...choices, [useRelay ? "litellm" : provider]: { model, effort } }
                      setChoices(saved)
                      setUseRelay(value === "litellm")
                      setUseApiKey(value.endsWith("-api-key"))
                      setProvider(next)
                      setModel(saved[target]?.model ?? (value === "litellm" ? (relay.models[0] ?? "") : PROVIDERS[next].defaultModel))
                      setEffort(saved[target]?.effort ?? (next === "claude" ? "high" : PROVIDERS[next].defaultEffort as Effort))
                    }} />
                  {useRelay
                    ? <Select label={t("term.model")} value={model} options={relay.models.map(id => ({ value: id, label: id, desc: "" }))} onChange={setModel} />
                    : PROVIDERS[provider].models.length > 0 && <Select label={t("term.model")} value={model} options={PROVIDERS[provider].models.map(o => ({ ...o, label: o.value === "fable" ? t("model.fable_label") : o.label, desc: provider === "claude" ? t(`model.${o.value}_desc`) : "" }))} onChange={setModel} />}
                  {PROVIDERS[provider].efforts.length > 0 && <Select label={t("term.effort")} value={effort} options={EFFORTS.filter(v => PROVIDERS[provider].efforts.includes(v)).map(value => ({ value, label: t(`effort.${value}`), desc: t(`effort.${value}_desc`) }))} onChange={(v) => setEffort(v as Effort)} />}
                  {dev && provider === "claude" && <Select label={t("term.subagents")} value={String(maxSubagents)}
                    options={[0, 1, 2, 3].map(n => ({ value: String(n), label: n === 0 ? t("landing.subagents_none") : String(n), desc: t("landing.subagents_desc") }))}
                    onChange={(v) => setMaxSubagents(Number(v))} />}
                </div>
                {dev && <Label className="w-fit font-normal">
                  <Checkbox checked={smokeCheck} onCheckedChange={v => setSmokeCheck(v === true)} />
                  {t("run.smoke_check")}
                </Label>}
              </AccordionContent>
            </AccordionItem>

            {skill === "ola-security-audit" ? (
              <AccordionItem value="bug-types">
                <AccordionTrigger>
                  <span>{t("term.bug_types")} <span className="font-normal text-muted-foreground">· {categories.length === VULN_CATEGORIES.length ? t("landing.bug_types_all", { count: VULN_CATEGORIES.length }) : t("landing.bug_types_some", { count: categories.length })}</span></span>
                </AccordionTrigger>
                <AccordionContent forceMount className={foldContent}>
                  <p className={desc}>{t("landing.bug_types_hint", { count: DEFAULT_CATEGORIES.length })}</p>
                  {CATEGORY_GROUPS.map((group) => {
                    const picked = group.categories.filter((c) => categories.includes(c)).length;
                    return (
                    <div key={group.id} className="flex flex-col gap-2">
                      <Label className="text-sm font-semibold">
                        <Checkbox
                          checked={picked === group.categories.length ? true : picked ? "indeterminate" : false}
                          onCheckedChange={() =>
                            setCategories((prev) => picked === group.categories.length
                              ? prev.filter((c) => !group.categories.includes(c))
                              : [...new Set([...prev, ...group.categories])])
                          }
                        />
                        {t(`landing.group_${group.id}`)} <span className="font-normal text-muted-foreground">· {picked}/{group.categories.length}</span>
                      </Label>
                      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-x-4 gap-y-2">
                        {group.categories.map((value) => (
                          <Label key={value} className="font-normal">
                            <Checkbox
                              aria-label={label("category", value)}
                              checked={categories.includes(value)}
                              onCheckedChange={(checked) =>
                                setCategories((prev) =>
                                  checked === true
                                    ? [...prev, value]
                                    : prev.filter((v) => v !== value)
                                )
                              }
                            />
                            {label("category", value)}
                          </Label>
                        ))}
                      </div>
                    </div>
                    );
                  })}
                </AccordionContent>
              </AccordionItem>
            ) : null}
          </Accordion>

          {providerError && <Alert variant="destructive" role="alert"><AlertDescription>{t("provider.load_failed", { msg: providerError })}</AlertDescription></Alert>}
          {error ? <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert> : null}
        </CardContent>

        <CardFooter className="max-w-5xl flex-wrap justify-end gap-3">
          {blocked && <p id="start-blocked" role="status" className={`${desc} min-w-0 flex-1 [overflow-wrap:anywhere]`}>{blocked}</p>}
          <Button
            type="button"
            onClick={() => void onStart()}
            disabled={!canStart}
            aria-describedby={blocked ? "start-blocked" : undefined}
            data-testid="start-scan"
          >
            {submitting ? t("common.working") : t("landing.btn_start")}
          </Button>
        </CardFooter>
      </Card>

      <footer className="text-center text-xs text-muted-foreground">
        {t("term.session")} <code>{props.sessionId.slice(0, 8)}</code>
      </footer>
    </Page>
  );
}

const desc = "text-xs leading-normal text-muted-foreground"
const descError = "text-xs leading-normal text-red-700 dark:text-red-400"
const field = "min-w-0 flex-col items-stretch gap-1.5"
// forceMount keeps the content in the page while closed, as <details> did.
const foldContent = "flex flex-col gap-4 [[data-state=closed]>&]:hidden"
const AUTH_VARIANT = { subscription: "success", "api-key": "paused", litellm: "running" } as const

function Select<T extends string>(props: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string; desc: string; disabled?: boolean }>;
  onChange: (v: T) => void;
}) {
  const current = props.options.find((o) => o.value === props.value);
  return (
    <Label className={field}>
      <span>{props.label}</span>
      <NativeSelect
        className="bg-background font-normal"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value as T)}
      >
        {props.options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </NativeSelect>
      {current?.desc ? <span className={`${desc} font-normal`}>{current.desc}</span> : null}
    </Label>
  );
}
