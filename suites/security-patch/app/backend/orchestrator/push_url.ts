import { readArtifactJson } from "./artifact_fs.ts"
import { join, resolve } from "node:path"

// Read base.json.branch (written by entrypoint.sh at clone) for the PR
// base. Returns null if missing/unreadable; caller falls back to run.branch.
export function readBaseBranch(runsRootDir: string, runId: string): string | null {
  try {
    const obj = readArtifactJson(join(resolve(runsRootDir, runId), "artifacts"), "base.json") as { branch?: unknown };
    return typeof obj.branch === "string" && obj.branch.length > 0 ? obj.branch : null;
  } catch {
    return null;
  }
}
