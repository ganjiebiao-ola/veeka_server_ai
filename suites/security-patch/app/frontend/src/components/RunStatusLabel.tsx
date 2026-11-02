import type { RunSummary } from "../types/events";
import { useI18n } from "../i18n";

export function RunStatusLabel({ run }: { run: Pick<RunSummary, "status" | "mode" | "phase"> }) {
  const { t, label } = useI18n();
  return <>{run.status === "scanning"
    ? t(run.mode === "fix" ? `run.phase_${run.phase ?? "fix"}` : "run_status.scanning")
    : label("run_status", run.status)}</>;
}
