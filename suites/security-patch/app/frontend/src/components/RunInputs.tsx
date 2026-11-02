import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "../i18n";
import { FoldPanel } from "./ActivityArea";

const SOURCES = ["repo", "workspace", "human", "suite"] as const;
const REASONS = ["file-too-large", "context-budget", "symlink"] as const;

interface RunInput {
  path: string;
  source: typeof SOURCES[number];
  size: number;
  reason?: typeof REASONS[number];
}

export function RunInputs({ runId }: { runId: string }) {
  const { t } = useI18n();
  const [inputs, setInputs] = useState<RunInput[] | null>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/artifacts/inputs`);
        if (response.status === 404) {
          if (!cancelled) {
            setInputs(null);
            setError(undefined);
          }
          return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!Array.isArray(data) || !data.every(input => input && typeof input.path === "string" &&
          SOURCES.includes(input.source) && Number.isSafeInteger(input.size) && input.size >= 0 &&
          (input.reason === undefined || REASONS.includes(input.reason)))) throw new Error(t("run.inputs_invalid"));
        if (!cancelled) {
          setInputs(data);
          setError(undefined);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [runId, t]);

  const note = (text: string) => <p className="text-[13px] text-muted-foreground">{text}</p>;
  return (
    <FoldPanel title={t("run.inputs")}>
      <div className="flex flex-col gap-4 p-4">
        {error ? <Alert variant="destructive" role="alert"><AlertDescription>{t("common.failed_to_load", { msg: error })}</AlertDescription></Alert>
          : inputs === undefined ? note(t("common.loading"))
          : inputs === null ? note(t("run.inputs_unavailable"))
          : inputs.length === 0 ? note(t("run.inputs_empty")) : SOURCES.map(source => {
          const group = inputs.filter(input => input.source === source);
          return group.length > 0 && <section key={source} className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">{t(`run.inputs_source_${source}`)}</h3>
            <Table>
              <TableHeader><TableRow>
                <TableHead>{t("run.inputs_path")}</TableHead>
                <TableHead className="text-right">{t("run.inputs_size")}</TableHead>
                <TableHead>{t("run.inputs_status")}</TableHead>
              </TableRow></TableHeader>
              <TableBody>{group.map(input => <TableRow key={input.path}>
                <TableCell className="whitespace-normal [overflow-wrap:anywhere]"><code className="text-xs">{input.path}</code></TableCell>
                <TableCell className="text-right tabular-nums">{t("run.inputs_bytes", { n: input.size })}</TableCell>
                <TableCell className="whitespace-normal">{input.reason ? t("run.inputs_dropped", { reason: t(`run.inputs_reason_${input.reason}`) }) : t("run.inputs_included")}</TableCell>
              </TableRow>)}</TableBody>
            </Table>
          </section>;
        })}
      </div>
    </FoldPanel>
  );
}
