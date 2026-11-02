// Mirrors shared/types.ts. Frontend tsconfig only includes src/ so we copy
// the contract here instead of reaching across the repo.

import { PROVIDERS } from "../../../shared/providers";
import type { ProviderId } from "../../../shared/providers";
export { PROVIDERS };
export type { ProviderId };

export type SkillName = "ola-security-audit";

export type ModelId = "fable" | "opus" | "sonnet" | "haiku";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type RunMode = "scan" | "fix";

// Mirror of shared/types.ts VULN_CATEGORIES. Empty selection = scan all.
export const VULN_CATEGORIES = [
  "sqli", "cmd-injection", "deserialization", "signature-compare",
  "numeric-juggling", "path-ssrf", "weak-hash", "log-leak",
  "cors", "hardcoded-secret", "dead-code", "weak-random", "tls-verify-off",
  "mass-assignment", "loose-compare", "api-no-auth", "api-test-exposed",
] as const;
export type VulnCategory = (typeof VULN_CATEGORIES)[number];
// The Scan page groups bug types so the operator can scan one kind first.
// ponytail: PHP is the only language. Move this into applies-to.json with a language field when Go lands.
export const PHP_SPECIFIC_CATEGORIES: readonly VulnCategory[] = ["numeric-juggling", "loose-compare", "mass-assignment"];
// A small starter set for first-time operators: high-impact bugs that most PHP apps can have.
export const DEFAULT_CATEGORIES: readonly VulnCategory[] = ["sqli", "cmd-injection", "deserialization", "hardcoded-secret", "api-test-exposed"];
export const CATEGORY_GROUPS = [
  { id: "general", categories: VULN_CATEGORIES.filter((c) => !PHP_SPECIFIC_CATEGORIES.includes(c)) },
  { id: "php", categories: PHP_SPECIFIC_CATEGORIES },
] as const;

export type RunStatus =
  | "connecting"
  | "queued"
  | "cloning"
  | "scanning"
  | "completed"
  | "failed"
  | "aborted"
  | "stopped";               // paused or quota hit; Resume continues it

export type StepName =
  | "prepare"     // scanner container starting, before the clone
  | "ingest"
  | "scan"
  | "classify"
  | "fix"
  | "commit"
  | "review"      // batch fix: review pass and checks
  | "report";

export type StepStatus = "pending" | "in_progress" | "completed" | "degraded";

export interface StepProgress {
  name: StepName;
  status: StepStatus;
  startedAt?: number;   // ms epoch, from the step_started event
}

export interface Finding {
  id: string;
  category: string;
  severity: "P0" | "P1" | "P2";
  file?: string;
  line?: number;
  snippet?: string;
  fixSummary?: string;
  status?: "candidate" | "false positive" | "fixed" | "needs human";
  reason?: string;
  posted?: boolean;   // posted to the repo's GitHub tracker file from the Run tab
  subsystem?: string;
}

export interface UsageDelta {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  // Qoder bills in credits and reports zero tokens.
  credits?: number;
  // Display-only compatibility for saved ACP runs.
  partialUsage?: boolean;
  partial_usage?: boolean;
}

export type UsagePhase = "fix" | "review" | "checks";
export type PhaseUsage = Partial<Record<UsagePhase, UsageDelta>>;

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
  | { type: "round_started"; round: number }
  | { type: "run_finished"; status: "completed" | "failed" | "stopped" | "aborted"; error?: string };

export interface StartRunRequest {
  language?: "en" | "zh"
  smokeSeconds?: number
  provider?: ProviderId
  reviewProvider?: ProviderId
  reviewModel?: string
  reviewEffort?: Effort
  pickedIds?: string[];
  sessionId: string;
  repoUrl: string;
  branch?: string;
  commitSha?: string;
  skill: SkillName;
  model: string;
  effort?: Effort;  // omitted for providers without effort controls
  mode: RunMode;
  categories?: VulnCategory[];   // scoped-scan selection; [] / omitted = all
  includeP2?: boolean;
  maxSubagents?: number;         // Scan only: the most subagents it may start, 0-3
  authMode?: AuthMode;  // "api-key" uses the server's ANTHROPIC_API_KEY (Codex: OPENAI_API_KEY), "relay" the server's relay endpoint
}

export type AuthMode = "oauth" | "api-key" | "relay";

// GET /api/relay/models. The browser never calls the gateway: the relay key
// stays on the server, so we ask the backend for the id list.
export interface RelayModels {
  configured: boolean;
  models: string[];
  error?: string;
}

export interface StartRunResponse {
  runId: string;
  status: RunStatus;
  queuePosition?: number;
}

// Mirrors backend RunSummary (already used by GET /api/runs/:id).
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
  repoUrl: string;
  branch: string;
  commitSha?: string;
  skill: SkillName;
  model: string;
  effort: Effort;
  mode: RunMode;
  categories?: VulnCategory[];       // scoped-scan selection; [] = all
  includeP2?: boolean;
  maxSubagents?: number;             // Scan cap on subagents, 0-3. Absent on older runs
  language?: "en" | "zh";             // Output language fixed at start. Absent on older runs
  context?: string[];                // workspace files the run got in its prompt. Absent on generic runs
  status: RunStatus;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  usage?: UsageDelta;
  phaseUsage?: PhaseUsage;
  attempts?: Array<{ runId: string; status: RunStatus; startedAt?: number }>;  // GET /api/runs/:id only: the resume chain, oldest first, when the run has more than one attempt
}

// "claude-sonnet-5-5" and "claude-haiku-4-5-20251001" read as "Claude Sonnet 5.5" and "Claude Haiku 4.5".
// Other IDs stay raw, so a gateway or codex model keeps its exact name.
function friendlyModel(id: string) {
  const m = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(?:-\d{8})?$/.exec(id)
  return m ? `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id
}

// "LiteLLM" is not a provider id. It is Claude through the relay, so History names it apart.
// "https://github.com/owner/repo.git" → "owner/repo". A local run ("local:/a/b/name") → "name".
export function shortRepo(url: string): string {
  if (url.startsWith("local:")) return url.replace(/\/+$/, "").split("/").pop() || url
  return url.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "")
}

// The backend stores "(default)" or "(local)" when the run named no branch.
export const isNamedBranch = (branch: string | undefined) => !!branch && !branch.startsWith("(")

export function displayBranch(branch: string | undefined, t: (key: string) => string): string {
  if (!branch || branch === "(default)") return t("common.default_branch")
  if (branch === "(local)") return t("common.local")
  return branch
}

export function displayProvider(run: Pick<RunSummary, "provider" | "authMode">, t?: (key: string) => string) {
  const provider = PROVIDERS[run.provider ?? "claude"].label
  const auth = run.authMode === "relay" ? "litellm" : run.authMode === "api-key" ? run.authMode : "subscription"
  return provider + ((run.provider ?? "claude") === "claude" || run.provider === "codex" && run.authMode === "api-key" ? ` · ${t ? t(`auth.${auth}`) : { litellm: "LiteLLM key", "api-key": "API key", subscription: "Subscription" }[auth]}` : "")
}

export function displayModelInfo(run: Pick<RunSummary, "provider" | "authMode" | "model" | "effort" | "modelInfo">, unspecified: string, requested = "Requested") {
  const provider = PROVIDERS[run.provider ?? "claude"]
  const reported = run.modelInfo?.model
  // A relay model id is a gateway name, so the picker aliases do not apply to it.
  const alias = run.authMode === "relay" ? run.model : provider.models.find(option => option.value === run.model)?.label ?? run.model
  const model = reported ? friendlyModel(reported) : (alias ? `${alias} · ${requested}` : "") || `${provider.label} · ${unspecified}`
  return {
    model,
    effort: run.modelInfo?.effort || (run.provider && run.provider !== "claude" ? unspecified : run.effort || unspecified),
    // The exact reported ID, for a tooltip, only when the label hides it.
    ...(reported && model !== reported ? { reportedId: reported } : {}),
  }
}

export function reviewSettings(run: RunSummary) {
  const provider = run.reviewProvider ?? "claude"
  const defaults = PROVIDERS[provider]
  const copiesFixer = provider === "claude" && (run.provider ?? "claude") === "claude"
  return {
    provider,
    model: run.reviewModel ?? (copiesFixer ? run.model : defaults.defaultModel),
    effort: run.reviewEffort ?? (copiesFixer ? run.effort : defaults.defaultEffort),
  }
}
