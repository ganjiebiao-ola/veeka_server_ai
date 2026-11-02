import { Fragment } from "react"
import { Label } from "@/components/ui/label"
import { NativeSelect } from "@/components/ui/native-select"
import { PROVIDERS, displayProvider } from "../types/events"
import type { AuthMode, ProviderId } from "../types/events"
import { useI18n } from "../i18n"

// "litellm" is not a provider: it is Claude through the relay. Only the run picker offers it.
// "claude-api-key" and "codex-api-key" are that provider on the server's API key instead of its login.
export type ProviderChoice = ProviderId | "litellm" | "claude-api-key" | "codex-api-key"

// auth: how the provider pays. Absent when the backend cannot tell.
// apiKey: the provider can also run on the server's API key, so the picker offers both logins.
export type ProviderAvailability = Record<ProviderId, { available: boolean, reason?: string, auth?: "subscription" | "api-key", apiKey?: boolean }>

// A login and an API key are both on offer. A login that is itself an API key does not split.
const splits = (availability: ProviderAvailability | undefined, id: ProviderId) =>
  (id === "claude" || id === "codex") && availability?.[id]?.apiKey === true && availability[id].auth !== "api-key"

// Whether the main provider runs on the server's API key. useKey is the picker's choice when both logins exist.
export function usesApiKey(availability: ProviderAvailability | undefined, id: ProviderId, useKey: boolean) {
  const login = availability?.[id]
  if (id === "claude") return login?.auth === "api-key" || useKey && login?.apiKey === true
  if (id === "codex") return login?.apiKey === true && (login.auth === "api-key" || useKey)
  return false
}

export const providerChoice = (availability: ProviderAvailability | undefined, id: ProviderId, apiKey: boolean) =>
  (apiKey && splits(availability, id) ? `${id}-api-key` : id) as ProviderChoice
export const choiceProvider = (value: ProviderChoice) => (value === "litellm" ? "claude" : value.replace(/-api-key$/, "")) as ProviderId

const fieldError = "text-xs leading-normal font-normal text-red-700 dark:text-red-400"

export function ProviderSelect(props: { value: ProviderChoice, onChange: (value: ProviderChoice) => void, availability?: ProviderAvailability, fix?: boolean, review?: boolean, authMode?: AuthMode, provider?: ProviderId, litellm?: { disabled: boolean, error?: string } }) {
  const { t } = useI18n()
  // authMode picks the main provider's login only. The review provider keeps its own.
  // The review uses the run's own login, so only the main picker splits.
  const split = (id: ProviderId) => !props.review && splits(props.availability, id)
  return <Label className="min-w-0 flex-col items-stretch gap-1.5">
    <span>{t(props.review ? "provider.review" : "term.provider")}</span>
    <NativeSelect className="bg-background font-normal" value={props.value} onChange={e => props.onChange(e.target.value as ProviderChoice)}>
      {(Object.keys(PROVIDERS) as ProviderId[]).map(id => <Fragment key={id}>
        <option value={id} disabled={Boolean(PROVIDERS[id].unavailableReason) || props.availability?.[id]?.available === false || props.fix && !PROVIDERS[id].canFix}>
          {displayProvider({ provider: id, authMode: props.review ? id === props.provider ? props.authMode : "oauth" : !split(id) && props.availability?.[id]?.auth === "api-key" ? "api-key" : "oauth" }, t)}{split(id) && id === "codex" ? ` · ${t("auth.subscription")}` : ""}{PROVIDERS[id].unavailableReason ? ` · ${PROVIDERS[id].unavailableReason}` : props.availability?.[id]?.available === false ? ` · ${props.availability[id].reason || t("provider.unavailable")}` : ""}{props.fix && !PROVIDERS[id].canFix ? ` · ${t("provider.read_only")}` : ""}
        </option>
        {split(id) && <option value={`${id}-api-key`}>{displayProvider({ provider: id, authMode: "api-key" }, t)}</option>}
      </Fragment>)}
      {props.litellm && <option value="litellm" disabled={props.litellm.disabled}>{displayProvider({ provider: "claude", authMode: "relay" }, t)}{props.litellm.disabled ? ` · ${t("provider.unavailable")}` : ""}</option>}
    </NativeSelect>
    {props.value !== "litellm" && props.availability?.[choiceProvider(props.value)]?.available === false && <span className={fieldError}>{props.availability[choiceProvider(props.value)].reason || t("provider.unavailable")}</span>}
    {props.litellm?.error && <span className={fieldError}>{t("provider.relay_error", { msg: props.litellm.error })}</span>}
  </Label>
}
