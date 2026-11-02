import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { NativeSelect } from "@/components/ui/native-select"
import { useI18n } from "../i18n";
import { displayProvider } from "../types/events";
import type { AuthMode, RunSummary } from "../types/events";
import type { ProviderAvailability } from "./ProviderSelect";

export function ResumeBar(props: { runId: string; onResumed: (runId: string) => void }) {
  const { t } = useI18n();
  const [run, setRun] = useState<RunSummary | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>();
  const [availability, setAvailability] = useState<ProviderAvailability>();
  const [state, setState] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const submitting = useRef(false)

  useEffect(() => {
    let cancelled = false;
    setRun(null);
    setAuthMode(undefined);
    fetch(`/api/runs/${encodeURIComponent(props.runId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((m: RunSummary | null) => {
        if (cancelled) return;
        setRun(m);
        if (m) setAuthMode(m.authMode ?? "oauth");
      })
      .catch(() => { /* keep the current auth mode */ });
    fetch("/api/providers")
      .then((r) => (r.ok ? r.json() : undefined))
      .then((data: ProviderAvailability | undefined) => { if (!cancelled) setAvailability(data); })
      .catch(() => { /* keep the run's current auth mode */ });
    return () => { cancelled = true; };
  }, [props.runId]);

  const authModes = new Set<AuthMode>(run ? [run.authMode ?? "oauth"] : []);
  if ((run?.provider ?? "claude") === "claude" && availability?.claude?.available) {
    authModes.add(availability.claude.auth === "api-key" ? "api-key" : "oauth");
    if (availability.claude.apiKey) authModes.add("api-key");
  }
  const codex = availability?.codex;
  if (run?.provider === "codex" && codex?.available) {
    if (codex.apiKey) authModes.add("api-key");
    if (!codex.apiKey || codex.auth !== "api-key") authModes.add("oauth");
  }

  const onResume = async () => {
    if (state.busy || submitting.current) return
    submitting.current = true
    setState({ busy: true });
    try {
      const r = await fetch(`/api/runs/${encodeURIComponent(props.runId)}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(authMode ? { authMode } : {}),
        }),
      });
      const body = await r.json().catch(() => ({})) as { runId?: string; error?: string };
      if (r.ok && body.runId) props.onResumed(body.runId);
      else setState({ busy: false, error: body.error ?? t("resume.failed", { status: r.status }) });
    } catch (e) {
      // A network failure must not leave the button stuck on "Resuming…".
      setState({ busy: false, error: (e as Error).message });
    } finally {
      submitting.current = false
    }
  };

  return (
    <>
      {run && authMode ? <Label className="min-w-0 font-normal">
        <span className="shrink-0">{t("resume.auth_mode")}</span>
        <NativeSelect size="sm" className="bg-background" value={authMode} disabled={state.busy} onChange={(e) => setAuthMode(e.target.value as AuthMode)}>
          {[...authModes].map((mode) => <option key={mode} value={mode}>{displayProvider({ provider: run.provider, authMode: mode }, t)}{run.provider === "codex" && mode === "oauth" && authModes.has("api-key") ? ` · ${t("auth.subscription")}` : ""}</option>)}
        </NativeSelect>
      </Label> : null}
      <Button type="button" size="sm" disabled={state.busy} onClick={onResume}>{state.busy ? t("resume.busy") : t("resume.btn")}</Button>
      {state.error ? <span role="alert" className="max-w-80 text-xs leading-snug text-red-700 dark:text-red-400">{state.error}</span> : null}
    </>
  );
}
