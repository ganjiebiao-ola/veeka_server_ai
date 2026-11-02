import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useI18n } from "../i18n";
import { navigate } from "../router";
import { shortRepo } from "../types/events";
import type { ActiveRun } from "../hooks/useActiveRuns";

// Shown on Start and Pick while a run is going. It warns, and links to the run. It does not block.
export function ActiveRunBanner(props: { runs: ActiveRun[] }) {
  const { t, label } = useI18n();
  const [run, ...others] = props.runs;
  if (!run) return null;
  return (
    <Alert variant="info" role="status" className="flex flex-wrap items-center justify-between gap-3">
      <span>
        {t("run.active_banner", { repo: shortRepo(run.repoUrl), status: run.status === "scanning" && run.mode === "fix" ? t(`run.phase_${run.phase ?? "fix"}`) : label("run_status", run.status) })}
        {others.length > 0 && ` ${t("run.active_more", { count: others.length })}`}
      </span>
      <Button type="button" variant="outline" size="sm" onClick={() => navigate(`/runs/${encodeURIComponent(run.runId)}`)}>
        {t("run.open")}
      </Button>
    </Alert>
  );
}
