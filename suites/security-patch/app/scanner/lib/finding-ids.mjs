import { createHash } from "node:crypto"
import { agentFs } from "./agent-fs.mjs"

export function assignFindingIds(rows, mode) {
  if (mode !== "scan") return rows
  if (!Array.isArray(rows)) throw new Error("expected a findings array")
  return rows.map(row => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return row
    const { function: functionName, sink, ...finding } = row
    // Older model output may omit these fields. Use an empty function and the trimmed snippet as the sink.
    const inputs = [row.category, row.file, typeof functionName === "string" ? functionName : "",
      typeof sink === "string" ? sink : typeof row.snippet === "string" ? row.snippet.trim() : ""]
    // Without function or sink, distinguish identical snippets at different lines.
    if (typeof functionName !== "string" && typeof sink !== "string") inputs.push(row.line)
    finding.id = createHash("sha256").update(JSON.stringify(inputs), "utf8").digest("hex")
    return finding
  })
}

export function finalizeFindingIds(path, mode) {
  if (mode !== "scan") return
  const limit = 5 * 1024 * 1024
  const rows = assignFindingIds(JSON.parse(agentFs.readFileSync(path, "utf8", limit)), mode)
  agentFs.writeFileSync(path, JSON.stringify(rows), limit)
}
