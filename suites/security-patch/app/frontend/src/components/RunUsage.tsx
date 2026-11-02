import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { PhaseUsage } from "../types/events";
import { useI18n } from "../i18n";
import { fmtCredits } from "./RunFacts";

const num = "text-right tabular-nums";

export function RunUsage({ usage }: { usage?: PhaseUsage }) {
  const { t } = useI18n();
  const credits = Object.values(usage ?? {}).some(row => row?.credits);
  return (
    <Card>
      <CardHeader><h2 className="leading-none font-semibold">{t("run.phase_tokens")}</h2></CardHeader>
      <CardContent><Table>
        <TableHeader><TableRow>
          <TableHead>{t("run.usage_phase")}</TableHead>
          <TableHead className="text-right">{t("run.usage_input")}</TableHead>
          <TableHead className="text-right">{t("run.usage_cached")}</TableHead>
          <TableHead className="text-right">{t("run.usage_output")}</TableHead>
          {credits && <TableHead className="text-right">{t("run.usage_credits")}</TableHead>}
        </TableRow></TableHeader>
        <TableBody>{(["fix", "review", "checks"] as const).map(phase => {
          const row = usage?.[phase];
          const tokens = (n?: number) => n === undefined ? "—"
            : row?.partialUsage || row?.partial_usage ? <span title={t("run.usage_partial")}>≥ {n}*</span> : n;
          return <TableRow key={phase}>
            <TableHead scope="row" className="font-medium text-foreground">{t(`run.usage_${phase}`)}</TableHead>
            <TableCell className={num}>{tokens(row?.inputTokens)}</TableCell>
            <TableCell className={num}>{tokens(row && row.cacheReadTokens + row.cacheCreateTokens)}</TableCell>
            <TableCell className={num}>{tokens(row?.outputTokens)}</TableCell>
            {credits && <TableCell className={num}>{fmtCredits(row?.credits)}</TableCell>}
          </TableRow>;
        })}</TableBody>
      </Table></CardContent>
    </Card>
  );
}
