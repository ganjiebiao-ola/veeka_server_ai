import { redact } from "./redact.mjs";
import { parseScanCoverage, coverageOutput } from "./resume.mjs";

export function artifactPermission(input, { artifactsDir: ARTIFACTS_DIR, reviewNotesFile = "", scanInventory = null }) {
  if (reviewNotesFile) {
    return input?.file_path === reviewNotesFile
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: "review pass only reads code and writes its notes file" };
  }
  // SKILL §1.18: the scan also writes the repo's auth facts. The backend checks the fields before it uses them.
  if (input?.file_path === `${ARTIFACTS_DIR}/auth.json`) {
    try {
      const facts = JSON.parse(input.content);
      if (!facts || typeof facts !== "object" || Array.isArray(facts)) throw new Error("auth.json must be an object");
    } catch {
      return { behavior: "deny", message: "auth.json must be a JSON object" };
    }
    return { behavior: "allow", updatedInput: input };
  }
  if (input?.file_path === `${ARTIFACTS_DIR}/scan-coverage.json`) {
    try {
      const coverage = JSON.parse(input.content);
      if (!Array.isArray(coverage) || parseScanCoverage(coverage).length !== new Set(coverage).size) throw new Error("invalid coverage");
      return { behavior: "allow", updatedInput: { ...input, content: JSON.stringify(coverageOutput(coverage, scanInventory)) } };
    } catch { return { behavior: "deny", message: "scan-coverage.json must be a JSON array of repository-relative completed file paths" }; }
  }
  if (input?.file_path !== `${ARTIFACTS_DIR}/findings.json`) {
    return { behavior: "deny", message: "scan can only write /workspace/artifacts/findings.json, scan-coverage.json or auth.json" };
  }
  try {
    const findings = JSON.parse(input.content);
    if (!Array.isArray(findings)) throw new Error("not an array");
    const index = findings.findIndex(finding => finding?.status !== "candidate");
    if (index !== -1) {
      const finding = findings[index];
      return { behavior: "deny", message: redact(`Write findings.json: finding ${index + 1} (${String(finding?.id ?? finding?.file ?? "unnamed").slice(0, 160)}) requires candidate status. Scan tools: Read, Glob, Grep, Skill, Write.`) };
    }
  } catch {
    return { behavior: "deny", message: "Use Write for findings.json with a JSON array and candidate status for every finding. Scan tools: Read, Glob, Grep, Skill, Write." };
  }
  return { behavior: "allow", updatedInput: input };
}

const AGY_WRITE = "ServerName artifacts, ToolName write_artifact, Arguments path and content";

export function providerWording(provider, mode, skill) {
  const codex = provider === "codex";
  const qoder = provider === "qoder";
  const antigravity = provider === "antigravity";
  return {
    artifactError: message => (codex || antigravity || qoder) ? message
      .replace("Write findings.json:", "write_artifact findings.json:")
      .replace("Use Write for findings.json", "Use write_artifact for findings.json")
      .replace("Scan tools: Read, Glob, Grep, Skill, Write.", codex
        ? "Use shell commands for reads and write_artifact for artifact writes."
        : "Use the file read tools for reads and write_artifact for artifact writes.") : message,
    save: (codex || antigravity || qoder) ? "Save" : "Write",
    language: (codex || antigravity || qoder) ? "Express" : "Write",
    search: codex
      ? "Use shell commands (cat, sed -n, rg, ls, git diff/log) for your own search."
      : antigravity
      ? "Use grep_search, find_by_name, list_dir and view_file for your own search."
      : "Use Read, Glob and Grep for your own search.",
    scanWrites: antigravity ? `Use only call_mcp_tool (${AGY_WRITE}) for artifact writes.`
      : (codex || qoder) ? "Use only the write_artifact MCP tool with path and content for artifact writes." : "Use Write only; Bash is blocked.",
    saveCandidate: antigravity ? `Use call_mcp_tool (${AGY_WRITE}) to save a candidate array, or [] when there are no findings.`
      : (codex || qoder) ? "Use write_artifact to save a candidate array, or [] when there are no findings." : "Use Write to save a candidate array, or [] when there are no findings.",
    review: (codex || antigravity || qoder) ? "Inspect only." : "Read only.",
    tools: qoder ? `Load the audit skill using Read: /root/.claude/skills/${skill}/SKILL.md.\n` + (mode === "fix"
      ? "Use tools to read and edit files and run checks in the container workspace.\n"
      : "The repository is at /workspace/repo; use absolute paths. Use Read, Grep and Glob only within the added directories. Use only mcp__artifacts__write_artifact with path and content for all artifact writes. Shell, edits, web and subagents are blocked.\n")
      : codex ? `Load the audit skill using a shell command: cat /root/.claude/skills/${skill}/SKILL.md.\n` + (mode === "fix"
      ? "Use shell commands to read and edit files and run checks in the workspace-write sandbox.\n"
      : "Use shell commands (cat, sed -n, rg, ls, git diff/log) to read files in the read-only sandbox. Use only the write_artifact MCP tool with path and content for all artifact writes.\n")
      : antigravity ? `Load the audit skill using a file tool: /root/.claude/skills/${skill}/SKILL.md.\n` + (mode === "fix"
      ? "Use tools to read and edit files and run checks in the workspace.\n"
      : `The repository is at /workspace/repo; use absolute paths. Use view_file, list_dir, grep_search and find_by_name to read files, only under /workspace/repo, /workspace/related, /workspace/artifacts and the skill directory: a read anywhere else ends your turn. Use only call_mcp_tool (${AGY_WRITE}) for all artifact writes. Where the skill names other tools, use these.\n`)
      : "",
  };
}
