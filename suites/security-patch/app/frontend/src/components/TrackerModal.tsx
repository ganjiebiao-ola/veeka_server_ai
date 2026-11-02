import { useI18n } from "../i18n"
import { ReaderModal } from "./ReaderModal"
import { Badge, severityVariant } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

export type TrackerRow = {
  id: string; category: string; file: string; lines: number[]
  severity: "P0" | "P1" | "P2" | ""
  status: "open" | "in progress" | "fixed" | "ignored" | "needs human"
  reason: string; date: string; pr: string; kind?: string
}

export function TrackerModal({ repo, tracker, onClose }: {
  repo: string
  tracker: { category: string; url: string | null; rows: TrackerRow[] }
  onClose: () => void
}) {
  const { t, label } = useI18n()
  return (
    <ReaderModal title={label("category", tracker.category)} source={repo} href={tracker.url ?? undefined} onClose={onClose}>
      {tracker.rows.length ? <Table>
        <TableHeader><TableRow><TableHead>{t("term.file_lines")}</TableHead>{tracker.category === "misc" && <TableHead>{t("overview.tracker_type")}</TableHead>}<TableHead>{t("term.status")}</TableHead><TableHead>{t("term.severity")}</TableHead><TableHead>{t("overview.tracker_date")}</TableHead><TableHead>{t("overview.tracker_reason")}</TableHead><TableHead>PR</TableHead></TableRow></TableHeader>
        <TableBody>{tracker.rows.map(row => {
          const pr = /^\[(PR #\d+)\]\((https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+)\)$/.exec(row.pr)
          return <TableRow key={row.id} className="align-top">
            <TableCell className="font-mono text-xs">{row.file}:{row.lines.join(",")}</TableCell>{tracker.category === "misc" && <TableCell>{row.kind ?? ""}</TableCell>}
            <TableCell>{label("finding_status", row.status)}</TableCell><TableCell>{row.severity && <Badge variant={severityVariant(row.severity)}>{row.severity}</Badge>}</TableCell><TableCell className="tabular-nums">{row.date}</TableCell>
            <TableCell className="min-w-[280px] whitespace-pre-wrap [overflow-wrap:anywhere]">{row.reason}</TableCell><TableCell>{pr ? <a href={pr[2]} target="_blank" rel="noopener noreferrer">{pr[1]}</a> : row.pr}</TableCell>
          </TableRow>
        })}</TableBody>
      </Table> : <p role="status" className="py-12 text-center text-muted-foreground">{t(tracker.url ? "overview.empty_tracker" : "overview.no_tracker")}</p>}
    </ReaderModal>
  )
}
