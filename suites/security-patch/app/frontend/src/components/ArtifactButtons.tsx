import { Suspense, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { RunMode } from "../types/events";
import { useI18n } from "../i18n";
import { DiagnosticReader } from "./lazy";

export const DIAGNOSTICS = ["run-info", "stderr", "events", "context"] as const;
export type DiagnosticKind = typeof DIAGNOSTICS[number];

// A disabled button still takes the pointer, so its title can say why.
const explainDisabled = "disabled:pointer-events-auto disabled:cursor-not-allowed";

// Report / Patch / Commits reader buttons, shared by the live RunPage result
// bar (CompletionCard) and the History detail page (RunDetailPage) so the
// rendering + empty-patch handling lives in one place.
//
// Why probe the patch: `working.patch` is `git diff <clone-baseline>` (committed
// + uncommitted changes since clone). It's EMPTY only when the scan changed
// nothing. The reader would then show a blank file that reads as "nothing was
// fixed". We probe the size and, when empty, disable the button with a tooltip.
export function ArtifactButtons({ runId, mode }: { runId: string; mode: RunMode }) {
  const { t } = useI18n();
  const patchEmpty = usePatchEmpty(runId, mode);
  // activity.md only exists for marker-split runs. Then the report is the summary and
  // activity joined, so the button says "Full report".
  const hasActivity = useArtifactExists(runId, "activity");
  const [reading, setReading] = useState<"report" | "patch" | "commits" | null>(null);
  const reportTitle = t(hasActivity ? "artifact.full_report" : "artifact.report");
  const open = (kind: "patch" | "commits") => (
    <Button type="button" variant="outline" aria-haspopup="dialog" title={t(`artifact.${kind}_title`)} onClick={() => setReading(kind)}>
      {t(`artifact.${kind}`)}
    </Button>
  );
  return (
    <>
      {/* The Summary and Activity panels carry their own download. Here only the whole report. */}
      <Button type="button" variant="outline" aria-haspopup="dialog"
        title={t(hasActivity ? "artifact.full_report_title" : "artifact.report_title")} onClick={() => setReading("report")}>
        {reportTitle}
      </Button>
      {reading && <Suspense fallback={<Skeleton aria-hidden="true" className="h-9 w-24" />}>
        <DiagnosticReader key={reading} runId={runId} kind={reading} title={reading === "report" ? reportTitle : undefined} onClose={() => setReading(null)} />
      </Suspense>}
      {/* Patch + Commits only exist in fix mode (scan modifies nothing). */}
      {mode === "fix" ? (
        <>
          {patchEmpty ? (
            <Button type="button" variant="outline" className={explainDisabled} disabled title={t("artifact.patch_empty")}>
              {t("artifact.patch")}
            </Button>
          ) : open("patch")}
          {open("commits")}
        </>
      ) : null}
    </>
  );
}

// Diagnostics for a past run: what the container ran with, its stderr, the event log and the
// repo context. Each opens in a reader. A file the run never wrote gets a disabled button.
export function DiagnosticButtons({ runId }: { runId: string }) {
  const { t } = useI18n();
  const [reading, setReading] = useState<DiagnosticKind | null>(null);
  return (
    <>
      <span className="text-sm text-muted-foreground">{t("artifact.diagnostics")}</span>
      {DIAGNOSTICS.map(kind => <DiagnosticButton key={kind} runId={runId} kind={kind} onOpen={() => setReading(kind)} />)}
      {reading && <Suspense fallback={<Skeleton aria-hidden="true" className="h-9 w-24" />}>
        <DiagnosticReader key={reading} runId={runId} kind={reading} onClose={() => setReading(null)} />
      </Suspense>}
    </>
  );
}

function DiagnosticButton({ runId, kind, onOpen }: { runId: string; kind: DiagnosticKind; onOpen: () => void }) {
  const { t } = useI18n();
  const exists = useArtifactExists(runId, kind);
  return (
    <Button type="button" variant="outline" className={explainDisabled} disabled={!exists} aria-haspopup="dialog"
      title={t(exists ? `artifact.${kind}_title` : "artifact.missing")} onClick={onOpen}>
      {t(`artifact.${kind}`)}
    </Button>
  );
}

// Probe whether an artifact exists (200 vs 404) once per run. Used to decide
// whether the split (activity.md) download layout applies. Defaults to false so
// a slow/failed probe just falls back to the single-report layout.
function useArtifactExists(runId: string, kind: string): boolean {
  const [exists, setExists] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/artifacts/${kind}`);
        res.body?.cancel();               // don't download the body just to probe
        if (!cancelled) setExists(res.ok);
      } catch { /* leave false on probe failure */ }
    })();
    return () => { cancelled = true; };
  }, [runId, kind]);
  return exists;
}

// Probe the patch artifact's size once per run. Defaults to "not empty" so a
// failed/slow probe never hides a real patch; flips to empty only on a
// confirmed Content-Length of 0.
function usePatchEmpty(runId: string, mode: RunMode): boolean {
  const [empty, setEmpty] = useState(false);
  useEffect(() => {
    if (mode !== "fix") return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/artifacts/patch`);
        if (!res.ok) return;
        const len = res.headers.get("content-length");
        let isEmpty: boolean;
        if (len != null) {
          isEmpty = Number(len) === 0;
          res.body?.cancel();                 // don't download the body just to size it
        } else {
          isEmpty = (await res.text()).trim().length === 0;
        }
        if (!cancelled) setEmpty(isEmpty);
      } catch {
        /* leave as not-empty on probe failure */
      }
    })();
    return () => { cancelled = true; };
  }, [runId, mode]);
  return empty;
}
