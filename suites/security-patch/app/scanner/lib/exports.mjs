// Pure helpers for exporting final artifacts. No SDK / process-global deps so
// they can be unit-tested with `bun test`.
import { agentFs } from "./agent-fs.mjs"
const { readFileSync } = agentFs

// Read the clone-baseline commit SHA that entrypoint.sh recorded into
// artifacts/base.json. Returns null when missing/unreadable so the caller can
// fall back to the legacy behaviour instead of crashing.
export function readBaseSha(artifactsDir, readFile = readFileSync) {
  try {
    const obj = JSON.parse(readFile(`${artifactsDir}/base.json`, "utf-8"));
    return typeof obj.sha === "string" && obj.sha.length > 0 ? obj.sha : null;
  } catch {
    return null;
  }
}

// Build the direct git commands that export patch + commits log.
//   baseSha known → diff/log against the clone baseline (captures committed +
//     uncommitted changes since clone — this is what fix/commit needs).
//   baseSha null  → legacy `diff HEAD` (uncommitted only) + `log -n 50`, so a
//     missing base.json degrades instead of crashing.
export function buildExportCommands(repoDir, artifactsDir, baseSha) {
  const safety = ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null"];
  const ref = baseSha ?? "HEAD";
  const logArgs = baseSha ? [`${baseSha}..HEAD`] : ["-n", "50"];
  return {
    patchCmd: { cmd: "git", args: [...safety, "diff", "--no-ext-diff", "--no-textconv", ref], outFile: `${artifactsDir}/working.patch` },
    commitsCmd: {
      cmd: "git",
      args: [...safety, "log", "--no-ext-diff", "--no-textconv", ...logArgs, "--format=%H%n%s%n%b%n--END--"],
      outFile: `${artifactsDir}/commits.log`,
    },
  };
}

export function scanOutput(rows, includeP2 = false) {
  return rows.filter(row => includeP2 || row?.severity !== "P2").map(row => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return row;
    return {
      ...row,
      fix_summary: "",
      reason: typeof row.reason === "string" ? row.reason.split(/\r?\n/).filter(line => !/^\s*Fix:/i.test(line)).join("\n") : row.reason,
    };
  });
}
