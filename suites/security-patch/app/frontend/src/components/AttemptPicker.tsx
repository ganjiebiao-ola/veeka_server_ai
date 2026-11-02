import type { RunSummary } from "../types/events";
import { navigate } from "../router";
import { NativeSelect } from "@/components/ui/native-select";
import { useI18n } from "../i18n";

// A resumed run and the runs it continues or that continue it. Picking one opens that attempt.
export function AttemptPicker(props: { runId: string; attempts?: RunSummary["attempts"] }) {
  const { t, label } = useI18n();
  const attempts = props.attempts ?? [];
  if (attempts.length < 2) return null;
  // NativeSelect fills its parent. The wrapper sizes it to the longest option instead.
  return (
    <div className="max-w-full">
      <NativeSelect
        size="sm"
        className="bg-background"
        aria-label={t("run.attempts")}
        value={props.runId}
        onChange={(e) => navigate(`/runs/${encodeURIComponent(e.target.value)}`)}
      >
        {attempts.map((a, i) => (
          <option key={a.runId} value={a.runId}>
            {t("run.attempt", { n: i + 1, total: attempts.length })} · {a.runId.slice(0, 8)} · {label("run_status", a.status)}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}
