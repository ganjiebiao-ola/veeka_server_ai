import type { RunSummary, UsageDelta } from "../types/events";
import { displayModelInfo, displayProvider, PROVIDERS, reviewSettings } from "../types/events";
import { scopeLabel } from "./ReportView";
import { DURATION_UNITS, useI18n } from "../i18n";
import type { Lang } from "../i18n"

const groups = "m-0 grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-x-8 gap-y-3"
const group = "flex min-w-0 flex-col gap-0.5"
const dt = "mb-0.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
const dd = "m-0 text-[13px] [overflow-wrap:anywhere] text-muted-foreground"
const main = "m-0 text-[15px] font-semibold [overflow-wrap:anywhere] text-foreground"

// What a run is, in three groups: Run, Model and Usage. Both run pages show it.
// A live run passes its streamed usage, and its duration counts up to now.
export function RunFacts({ meta, usage, live, note }: { meta: RunSummary; usage?: UsageDelta; live?: boolean; note?: string }) {
  const { t, label, lang } = useI18n();
  const u = usage ?? meta.usage;
  const review = reviewSettings(meta);
  const qoder = meta.provider === "qoder";
  const tokens = !qoder || fmtTokens(u) !== "—" ? t("run.facts_tokens", { n: (u?.partialUsage || u?.partial_usage ? "≥ " : "") + fmtTokens(u) }) : "";
  const credits = qoder || u?.credits ? t("run.facts_credits", { n: fmtCredits(u?.credits) }) : "";
  const modelInfo = displayModelInfo(meta, t("common.unspecified"), t("common.requested"));
  const end = meta.finishedAt ?? (live ? Date.now() : undefined);
  // Repo-specific files: the mounted-repo context and knowledge. The rest are workspace security defaults.
  const repoFiles = meta.context?.filter(path => /^(team-context\/mounted-repos|knowledge)\//.test(path)) ?? [];
  return (
    <div className="flex flex-col gap-2">
      <dl className={groups}>
        <div className={group}>
          <dt className={dt}>{t("run.facts_run")}</dt>
          <dd className={main}>{label("mode", meta.mode)}</dd>
          {meta.mode !== "fix" && <dd className={dd}>
            {scopeLabel(t, meta.skill, meta.categories, meta.mode)}
            {meta.maxSubagents != null && ` · ${meta.maxSubagents ? t("run.facts_subagents", { n: meta.maxSubagents }) : t("run.facts_no_subagents")}`}
          </dd>}
        </div>
        <div className={group}>
          <dt className={dt}>{t("term.model")}</dt>
          <dd className={main} title={modelInfo.reportedId}>{meta.mode === "fix" && `${t("role.fix")}: `}{modelInfo.model}</dd>
          <dd className={dd}>{displayProvider(meta, t)}{PROVIDERS[meta.provider ?? "claude"].efforts.length > 0 && ` · ${t("run.facts_effort", { effort: label("effort", modelInfo.effort) })}`}</dd>
          {meta.mode === "fix" && <dd className={dd}>{t("run.review_provider", { provider: PROVIDERS[review.provider].label })} · {review.model}{PROVIDERS[review.provider].efforts.length > 0 && ` · ${label("effort", review.effort)}`}</dd>}
        </div>
        <div className={group}>
          <dt className={dt}>{t("run.facts_usage")}</dt>
          <dd className={main} title={u && tokens ? t("history.tokens_title", {
            in: u.inputTokens, out: u.outputTokens, read: u.cacheReadTokens, write: u.cacheCreateTokens,
          }) + (u.partialUsage || u.partial_usage ? `\n${t("run.usage_partial")}` : "") : undefined}>{(qoder ? [credits, tokens] : [tokens, credits]).filter(Boolean).join(" · ")}</dd>
          <dd className={dd}>{fmtDuration(meta.startedAt, end, lang)}</dd>
        </div>
        {meta.context && <div className={group}>
          <dt className={dt}>{t("run.facts_context")}</dt>
          <dd className={main} title={meta.context.join("\n") || undefined}>
            {repoFiles.length ? repoFiles.map(path => path.split("/").pop()).join(", ") : `⚠ ${t("run.facts_context_none")}`}
          </dd>
          <dd className={dd}>{t("run.facts_context_files", { n: meta.context.length })}</dd>
        </div>}
      </dl>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}


// Qoder's own billing unit. Never converted to money.
export function fmtCredits(credits?: number): string {
  return credits ? credits.toFixed(2) : "—";
}

export function fmtTokens(u?: UsageDelta): string {
  if (!u) return "—";
  const total = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreateTokens;
  if (total === 0) return "—";
  if (total < 1000) return String(total);
  if (total < 1_000_000) return (total / 1000).toFixed(1) + "k";
  return (total / 1_000_000).toFixed(2) + "M";
}

export function fmtDuration(start?: number, end?: number, lang: Lang = "en"): string {
  if (start == null || end == null) return "—"
  const sec = Math.max(0, Math.round((end - start) / 1000))
  const [d, h, m, s] = DURATION_UNITS[lang]
  if (sec >= 86400) return `${Math.floor(sec / 86400)}${d} ${Math.floor(sec / 3600) % 24}${h}`
  if (sec >= 3600) return `${Math.floor(sec / 3600)}${h} ${Math.floor(sec / 60) % 60}${m}`
  if (sec >= 60) return `${Math.floor(sec / 60)}${m} ${String(sec % 60).padStart(2, "0")}${s}`
  return `${sec}${s}`
}
