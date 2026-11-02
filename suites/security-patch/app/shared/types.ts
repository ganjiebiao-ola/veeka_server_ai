import { PROVIDERS } from "./providers";
import type { ProviderId } from "./providers";
export { PROVIDERS };
export type { ProviderId };

// Ola Security Agent — shared contracts between backend and frontend.

export type SkillName = "ola-security-audit";

// SDK accepts either an alias (auto-tracks newest of that family) or a full
// versioned model ID. We expose aliases in the UI to avoid pinning a model ID
// that gets superseded; the full IDs remain valid for advanced callers.
// Exception: 'fable' is NOT a CLI alias, and the 'haiku' alias still resolves to
// Haiku 4.5 — bridge.mjs maps both to a full id before handing it to the SDK.
//
// Backend validation and the frontend mirror derive from the provider list.
export const MODEL_IDS = PROVIDERS.claude.models.map(model => model.value);
export type ModelId = (typeof MODEL_IDS)[number];

// 5-level reasoning effort as defined by the Agent SDK Options.effort.
// Note: 'max'/'xhigh' are only effective on Fable 5, Opus 4.6/4.7/4.8 + Sonnet
// 4.6; on smaller models the SDK silently downgrades.
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export type RunMode = "scan" | "fix";

// Vuln-category tokens for scoped scanning — 1:1 with SKILL.md §1.x anchors.
// An EMPTY selection means "scan all categories" (the historical default), and
// MUST leave the scan invocation byte-identical. Only the `ola-security-audit`
// skill honors these. Generic prompt runs ignore them.
// Single source of truth: backend validation (VALID_CATEGORIES) and the UI copy
// (frontend deliberate mirror) derive from this list.
export const VULN_CATEGORIES = [
  "sqli", "cmd-injection", "deserialization", "signature-compare",
  "numeric-juggling", "path-ssrf", "weak-hash", "log-leak",
  "cors", "hardcoded-secret", "dead-code", "weak-random", "tls-verify-off",
  "mass-assignment", "loose-compare", "api-no-auth", "api-test-exposed",
] as const;
export type VulnCategory = (typeof VULN_CATEGORIES)[number];

export interface ProfileSource { field: "php" | "framework"; value: string; file: string }
// What the scanner found in the repo's files. scanner/lib/profile.mjs writes it as profile.json.
export interface RepoProfile { language: string; php: string; framework: string; sources: ProfileSource[] }
// What the operator set on the Scan page. An empty field keeps the detected value.
export interface ProfileOverride { php: string; framework: string }
// GET /api/repos/language: the language with the most bytes in GitHub's language breakdown, and its share in percent.
// language is null when GitHub lists no languages.
export interface RepoLanguage { language: string | null; share: number }

export type RunStatus =
  | "queued"
  | "cloning"
  | "scanning"
  | "completed"
  | "failed"
  | "aborted"
  | "stopped";               // paused or quota hit; Resume continues it

// Coarse phases shown in the checklist sidebar. The backend emits step_started
// / step_completed events using these names; the scanner's bridge.mjs drives
// them by inspecting the SDK message stream.
export type StepName =
  | "prepare"     // scanner container starting, before the clone
  | "ingest"      // git clone
  | "scan"        // SDK is scanning the repo
  | "classify"    // findings categorized (inferred from first Edit/Write)
  | "fix"         // patches being applied (fix mode only)
  | "commit"      // local commits created
  | "review"      // batch fix: review pass and checks
  | "report";     // diff.patch / report.md exported

export type StepStatus = "pending" | "in_progress" | "completed" | "degraded";

export interface StepProgress {
  name: StepName;
  status: StepStatus;
  startedAt?: number;   // ms epoch, from the step_started event
}

export interface Finding {
  id: string;
  category: string;   // e.g. "sqli", "cmd_injection", "weak_hash"
  kind?: string;      // misc only: a short kebab-case bug type
  severity: "P0" | "P1" | "P2";
  file?: string;
  line?: number;
  snippet?: string;
  fixSummary?: string;
  status?: "candidate" | "false positive" | "fixed" | "needs human" | "ignored";
  reason?: string;
  posted?: boolean;   // posted to the repo's GitHub tracking issue from the Run tab
}

export interface UsageDelta {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  // Qoder bills in credits and reports zero tokens.
  credits?: number;
  partialUsage?: boolean;
  partial_usage?: boolean;
}

export type UsagePhase = "fix" | "review" | "checks";
export type PhaseUsage = Partial<Record<UsagePhase, UsageDelta>>;

// SSE events emitted from backend → frontend. The frontend reducer consumes
// these and never touches raw SDK messages.
export type RunEvent =
  | { type: "run_status"; status: RunStatus; error?: string }
  | { type: "step_started"; step: StepName; ts?: number }
  | { type: "step_completed"; step: StepName; status: "completed" | "degraded" }
  | { type: "tool_invoked"; tool: string; input: Record<string, unknown>; ts?: number }
  | { type: "tool_completed"; tool: string; ok: boolean; summary?: string; ts?: number }
  | { type: "thinking_emitted"; text: string; ts?: number }
  | { type: "assistant_text"; text: string }
  | { type: "finding_emitted"; finding: Finding }
  | { type: "usage_delta"; usage: UsageDelta; phase?: UsagePhase }
  | { type: "artifact_ready"; kind: "patch" | "report" | "commits"; url: string }
  | { type: "push_result"; ok: boolean; branch?: string; prUrl?: string; error?: string }
  | { type: "run_phase"; phase: "fix" | "review" | "checks" }
  | { type: "round_started"; round: number }                                                       // each query() round
  | { type: "run_finished"; status: "completed" | "failed" | "stopped" | "aborted"; error?: string };

// Request body for POST /api/runs.
//
// Two mutually exclusive shapes share this type:
//   - skill run (the product UI): repoUrl + skill. The scanner clones the
//     repo and invokes the named skill. Original behavior, unchanged.
//   - generic run (headless API callers, e.g. SkillOpt): prompt +
//     workspaceHostDir. The backend bind-mounts the host directory as the
//     workspace and feeds the raw prompt to the agent. Server must opt in
//     via OLA_AGENT_WORKSPACES_ROOT or every generic request is rejected.
export interface StartRunRequest {
  language?: "en" | "zh"
  smokeSeconds?: number
  provider?: ProviderId
  reviewProvider?: ProviderId
  reviewModel?: string
  reviewEffort?: Effort
  pickedIds?: string[];
  ignorePRs?: number[]
  note?: string
  sessionId: string;
  // -- skill run (XOR with prompt/workspaceHostDir) --
  repoUrl?: string;
  commitSha?: string;        // full 40-character commit SHA, overrides branch checkout
  branch?: string;           // empty / undefined → backend tries main → master
  skill?: SkillName;
  // -- generic run --
  prompt?: string;           // raw task prompt (XOR with skill)
  workspaceHostDir?: string; // absolute HOST dir bind-mounted RW as the workspace (XOR with repoUrl)
  timeoutSeconds?: number;   // kill the container after N seconds (30..14400)
  // -- common --
  model: ModelId | (string & {});  // alias, or raw model id (raw ids: generic runs only)
  effort: Effort;
  mode: RunMode;
  // Scoped scanning: subset of vuln categories to focus on. Empty/omitted =
  // scan all (byte-identical to the historical invocation). Only honored for
  // the `ola-security-audit` skill.
  categories?: VulnCategory[];
  // Scan runs only: the most subagents the scan may start for exploratory
  // reads, 0-3. The agent may start fewer. Omitted = 0. Claude provider only.
  includeP2?: boolean;
  maxSubagents?: number;
  // Which provider-auth channel the run uses. "oauth" (default, and the value
  // assumed when omitted): subscription credentials via the mounted credentials
  // file, with no API key, or the deployment's global settings-mode env.
  // "api-key": the server's ANTHROPIC_API_KEY (Codex: OPENAI_API_KEY), with no subscription credentials.
  // It picks the main provider's login only. A Codex review keeps the Codex login file.
  // "relay" switches this one run to the server-configured
  // relay endpoint (OLA_AGENT_RELAY_BASE_URL / _AUTH_TOKEN) and mounts no
  // subscription credentials at all. Callers can only PICK a channel —
  // endpoint URLs and tokens are never accepted from the request body: this
  // API has no auth layer (loopback trust), so accepting credentials here
  // would hand any local process a billing channel.
  authMode?: AuthMode;
}

export type AuthMode = "oauth" | "api-key" | "relay";

export interface StartRunResponse {
  runId: string;
  status: RunStatus;
  queuePosition?: number;
}

// Server snapshot of a run for History page / refresh-on-reload.
export interface RunSummary {
  starred?: boolean;
  stopReason?: "user_pause" | "quota";
  phase?: "fix" | "review" | "checks";
  runNumber: number
  modelInfo?: { model?: string; effort?: string }
  provider?: ProviderId
  reviewProvider?: ProviderId
  reviewModel?: string
  reviewEffort?: Effort
  authMode?: AuthMode  // "api-key" = the main provider (Claude or Codex) on the server's API key, "relay" = Claude through the LiteLLM relay
  runId: string;
  sessionId: string;
  repoUrl: string;                   // `local:<dir>` for generic workspace runs
  branch: string;
  commitSha?: string;
  skill: SkillName | (string & {});  // "generic" for prompt-mode runs
  model: ModelId | (string & {});    // raw model ids allowed on generic runs
  effort: Effort;
  mode: RunMode;
  categories?: VulnCategory[];       // scoped-scan selection; [] = all
  includeP2?: boolean;
  maxSubagents?: number;             // Scan cap on subagents, 0-3. Absent on runs before the field.
  language?: "en" | "zh";             // Output language fixed at start. Absent on runs before the field.
  status: RunStatus;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  usage?: UsageDelta;
  phaseUsage?: PhaseUsage;
  attempts?: Array<{ runId: string; status: RunStatus; startedAt?: number }>;  // GET /api/runs/:id only: the resume chain, oldest first, when the run has more than one attempt
}

// UI-side cumulative usage (the frontend keeps a running total of usage_delta
// events; this shape mirrors what we store on the server-side usage_totals
// row so the UI snapshot matches a History page refresh).
export interface UsageTotals extends UsageDelta {}

export function validPickedIds(value: unknown): value is string[] {
  return Array.isArray(value) && new Set(value).size === value.length && value.every(id =>
    typeof id === "string" && id.length <= 300 && /^(pr[0-9]+:[A-Za-z0-9._/-]+|[a-f0-9]{64})$/.test(id))
}

export type HiddenPickRow = {
  id: string, category: string, file: string, lines: number[], severity: string, blockedBy: number[]
}
export type PickLimits = { maxFilesPerBatch: number }
