import { Readable } from "node:stream"
import { createReadStream, fstatSync } from "node:fs"
import { lstat, mkdir, realpath } from "node:fs/promises"
import type { Context } from "hono";
import { loginFileExists, qoderLoginExists } from "./providers.ts"
import { loadRepoContext, relatedRepoDirs } from "./repo_context.ts"
import type { RunInput } from "./repo_context.ts"
import { join, resolve } from "node:path"
import type { Store } from "../store/repo.ts";
import type { DockerController } from "../docker/controller.ts";
import type { RunEventBus } from "../events/bus.ts";
import { replayEvents } from "../events/replay.ts"
import { GitHubClient, operatorToken } from "../tracker/client.ts"
import { GitHubTrackerStore, type TrackerStore } from "../tracker/store.ts"
import { matchTracked, postFindings } from "../orchestrator/findings.ts"
import { githubRepo, trackerForUrl } from "../tracker/repos.ts"
import { BATCH, preparePick, queuedBatches, refreshRows, subsystem } from "../tracker/pick.ts"
import type { PickClient } from "../tracker/pick.ts"
import { ScannerRun } from "../orchestrator/scanner.ts";
import { TARGETS_DIR } from "../orchestrator/vendor.ts"
import { copyArtifact, openArtifact, readArtifact, readArtifactJson, writeArtifact } from "../orchestrator/artifact_fs.ts";
import { readBaseBranch } from "../orchestrator/push_url.ts";
import { refreshCredentials } from "../auth/refresh_creds.ts";
import { EFFORTS, validPickedIds, MODEL_IDS, VULN_CATEGORIES, PROVIDERS } from "../../shared/types.ts";
import type {
  AuthMode,
  Effort,
  ModelId,
  RunEvent,
  RunMode,
  SkillName,
  StartRunRequest,
  StartRunResponse,
  RunSummary,
  UsageDelta,
  PhaseUsage,
} from "../../shared/types.ts";

// providerSelection picks the provider env + credentials mount for one run.
// Exported for tests. "relay" carries no subscription credentials at all —
// the run's only provider identity is the relay token, so a compromised or
// runaway relay run can never touch the OAuth credentials file.
export function providerSelection(
  authMode: AuthMode,
  deps: Pick<
    RunHandlersDeps,
    | "anthropicApiKey"
    | "anthropicBaseUrl"
    | "anthropicAuthToken"
    | "anthropicModel"
    | "relayBaseUrl"
    | "relayAuthToken"
    | "relayModel"
    | "credentialsHostPath"
  >,
): {
  env: {
    ANTHROPIC_API_KEY?: string;
    ANTHROPIC_BASE_URL?: string;
    ANTHROPIC_AUTH_TOKEN?: string;
    ANTHROPIC_MODEL?: string;
  };
  credentialsHostPath?: string;
} {
  if (authMode === "relay") {
    return {
      env: {
        ANTHROPIC_BASE_URL: deps.relayBaseUrl,
        ANTHROPIC_AUTH_TOKEN: deps.relayAuthToken,
        ANTHROPIC_MODEL: deps.relayModel,
      },
      credentialsHostPath: undefined,
    };
  }
  if (authMode === "api-key") {
    return {
      env: { ANTHROPIC_API_KEY: deps.anthropicApiKey, ANTHROPIC_BASE_URL: deps.anthropicBaseUrl, ANTHROPIC_MODEL: deps.anthropicModel },
      credentialsHostPath: undefined,
    };
  }
  // Claude Code prefers an API key over the subscription login, so a subscription run gets no key or token.
  if (deps.credentialsHostPath) {
    return { env: { ANTHROPIC_MODEL: deps.anthropicModel }, credentialsHostPath: deps.credentialsHostPath };
  }
  // Settings mode (`run start --auth=settings`): no subscription login, the host provider env is the login.
  return {
    env: {
      ANTHROPIC_API_KEY: deps.anthropicApiKey,
      ANTHROPIC_BASE_URL: deps.anthropicBaseUrl,
      ANTHROPIC_AUTH_TOKEN: deps.anthropicAuthToken,
      ANTHROPIC_MODEL: deps.anthropicModel,
    },
    credentialsHostPath: undefined,
  };
}

export interface RunHandlersDeps {
  store: Store;
  createTrackerStore?: (repo: string) => Promise<TrackerStore>;
  controller: DockerController;
  bus: RunEventBus;
  scannerImage: string;
  runsRootDir: string;            // host dir for per-run artifacts
  credentialsHostPath?: string;
  codexAuthHostPath?: string;     // OLA_AGENT_CODEX_AUTH_PATH; mounted only for runs that use codex
  qoderAuthHostPath?: string;
  antigravityAuthHostPath?: string; // OLA_AGENT_ANTIGRAVITY_AUTH_PATH; mounted only for runs that use antigravity
  getGhToken?: () => Promise<string | undefined>;
  anthropicApiKey?: string;
  openaiApiKey?: string;          // OPENAI_API_KEY; Codex runs with authMode:"api-key" only
  anthropicBaseUrl?: string;      // relay/3rd-party endpoint (cc-switch "settings" mode)
  anthropicAuthToken?: string;    // token for the relay endpoint
  anthropicModel?: string;        // optional model override from host settings.json
  relayBaseUrl?: string;          // per-run relay channel (authMode:"relay"); see shared/types.ts
  relayAuthToken?: string;
  relayModel?: string;
  maxConcurrent: number;
  activeRuns: Map<string, ScannerRun>;
  // Generic headless-run support. Unset workspacesRoot → every generic
  // request is rejected 403, keeping the public surface identical on
  // deployments that don't opt in.
  workspacesRoot?: string;        // comma-separated host-path prefixes allowed for workspaceHostDir
  workspaceChown?: string;        // "uid:gid" scanners chown generic workspaces to on exit
  // Called once per run on reaching a terminal state; server.ts frees the
  // per-run memory (bus buffers, activeRuns entry) after the TTL window.
  onTerminal?: (runId: string) => void;
  // Called when a fix run with picked rows completes; server.ts opens the batch PR.
  onFixComplete?: (runId: string) => void | Promise<void>
}

const SAFE_RUN_ID = /^[A-Za-z0-9_-]+$/;
const VALID_SKILLS: SkillName[] = ["ola-security-audit"];
const VALID_MODELS: readonly ModelId[] = MODEL_IDS;
const VALID_EFFORTS: readonly Effort[] = EFFORTS;
const VALID_MODES: RunMode[] = ["scan", "fix"];
const MAX_SUBAGENTS_LIMIT = 3;  // Scan cap ceiling. The bridge clamps to the same value.
const VALID_CATEGORIES = new Set<string>(VULN_CATEGORIES);
// Generic-run model ids are free-form (relay-side names); keep them to a
// conservative charset since they travel via `docker run -e`.
const RAW_MODEL_RX = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/;
const MAX_PROMPT_BYTES = 256 * 1024;
// Match bridge.mjs: two 5 MiB scan artifacts plus checkpoint metadata.
const MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024;
const startingRepos = new Set<string>()
// POST /api/runs
// resume is set only by handleResumeRun, never by the request body.
function smokeError(body: { smokeSeconds?: unknown }): string | undefined {
  if (body.smokeSeconds !== undefined && (typeof body.smokeSeconds !== "number" || !Number.isInteger(body.smokeSeconds) || body.smokeSeconds < 1 || body.smokeSeconds > 30)) {
    return "smokeSeconds must be a whole number from 1 to 30"
  }
}

type Checkpoint = { language?: unknown, done?: unknown, bundled?: unknown, head?: unknown }
async function readCheckpoint(runsRootDir: string, runId: string): Promise<Checkpoint | undefined> {
  try { return JSON.parse(readArtifact(resolve(runsRootDir, runId, "artifacts"), "checkpoint.json", MAX_CHECKPOINT_BYTES)) as Checkpoint }
  catch { return undefined }
}

export const trackerStoreFor = async (repo: string, deps: Pick<RunHandlersDeps, "createTrackerStore" | "getGhToken">): Promise<TrackerStore> =>
  deps.createTrackerStore ? deps.createTrackerStore(repo) : new GitHubTrackerStore(repo, await operatorToken(deps.getGhToken))

export async function handleStartRun(c: Context, deps: RunHandlersDeps, requestBody?: Partial<StartRunRequest>, suppliedPickClient?: PickClient, resume?: { from: string, done: string[], bundled: boolean }): Promise<Response> {
  let body: Partial<StartRunRequest>;
  try {
    body = requestBody ?? await c.req.json() as Partial<StartRunRequest>;
  } catch (e) {
    return c.json({ error: `invalid JSON: ${(e as Error).message}` }, 400);
  }

  if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 1000)) {
    return c.json({ error: "note must be text of at most 1000 characters" }, 400)
  }
  if (body.note !== undefined && !body.pickedIds?.length) {
    return c.json({ error: "note requires a picked fix batch" }, 400)
  }

  if (body.language !== undefined && body.language !== "en" && body.language !== "zh") {
    return c.json({ error: 'language must be "en" or "zh"' }, 400)
  }

  const sessionId = body.sessionId?.trim();
  const repoUrl = body.repoUrl?.trim();
  const branch = (body.branch ?? "").trim();
  if (body.commitSha !== undefined && typeof body.commitSha !== "string") {
    return c.json({ error: "commitSha must be a full 40-character commit SHA" }, 400);
  }
  const commitSha = body.commitSha?.trim().toLowerCase() || undefined;
  if (commitSha && !/^[a-f0-9]{40}$/.test(commitSha)) {
    return c.json({ error: "commitSha must be a full 40-character commit SHA" }, 400);
  }
  const skill = body.skill;
  const runProvider = body.provider ?? "claude"
  const reviewProvider = body.reviewProvider ?? "claude"
  if (typeof runProvider !== "string" || typeof reviewProvider !== "string" ||
      !Object.hasOwn(PROVIDERS, runProvider) || !Object.hasOwn(PROVIDERS, reviewProvider)) {
    return c.json({ error: "unknown provider or reviewProvider" }, 400)
  }
  const reviewModel = body.reviewModel
  // Providers without effort controls take no effort; "" from older clients means none.
  const reviewEffort = (body.reviewEffort as string | undefined) === "" && !PROVIDERS[reviewProvider].efforts.length ? undefined : body.reviewEffort
  if (reviewModel !== undefined && (body.authMode === "relay" && reviewProvider === "claude"
    ? typeof reviewModel !== "string" || !RAW_MODEL_RX.test(reviewModel)
    : !PROVIDERS[reviewProvider].models.some(model => model.value === reviewModel && !model.disabled))) {
    return c.json({ error: "invalid reviewModel for review provider" }, 400)
  }
  if (reviewEffort !== undefined && !PROVIDERS[reviewProvider].efforts.includes(reviewEffort)) {
    return c.json({ error: "invalid reviewEffort for review provider" }, 400)
  }
  if (body.mode === "fix" && !PROVIDERS[runProvider].canFix) {
    return c.json({ error: "provider does not support fix runs" }, 400)
  }
  for (const id of new Set([runProvider, reviewProvider])) {
    if (PROVIDERS[id].unavailableReason) return c.json({ error: PROVIDERS[id].unavailableReason }, 400)
  }
  // Codex needs the operator's login file in the container. Check it exists
  // (stat only, never read) so a missing login fails here, not inside the run.
  // authMode only picks the main provider's login, so a Codex review keeps the login file.
  // A Codex review under another main provider falls back to the key when the host has no login file.
  const usesCodex = [runProvider, reviewProvider].some(id => PROVIDERS[id].auth === "codex")
  const codexKey = runProvider === "codex" && body.authMode === "api-key"
  const loginExists = usesCodex && !codexKey && await loginFileExists(deps.codexAuthHostPath)
  const reviewKey = usesCodex && !codexKey && !loginExists && runProvider !== "codex" && Boolean(deps.openaiApiKey)
  if (usesCodex && !codexKey && !loginExists && !reviewKey) {
    return c.json({ error: "Codex login file not found. Run `codex login` on the host or set OLA_AGENT_CODEX_AUTH_PATH." }, 400)
  }
  const codexUsesKey = codexKey || reviewKey
  const usesAntigravity = [runProvider, reviewProvider].some(id => PROVIDERS[id].auth === "antigravity")
  if (usesAntigravity) {
    const exists = await loginFileExists(deps.antigravityAuthHostPath)
    if (!exists) {
      return c.json({ error: "Antigravity login file not found. Run `agy` on the host or set OLA_AGENT_ANTIGRAVITY_AUTH_PATH." }, 400)
    }
  }
  const usesQoder = [runProvider, reviewProvider].some(id => PROVIDERS[id].auth === "qoder")
  if (usesQoder && !await qoderLoginExists(deps.qoderAuthHostPath)) {
    return c.json({ error: "Qoder login directory not found or incomplete. Run `qodercli` on the host or set OLA_AGENT_QODER_AUTH_PATH." }, 400)
  }
  const providerModels = PROVIDERS[runProvider].models.map(model => model.value)
  const model = body.model;
  // Run records require an effort value; providers without effort controls never receive it.
  const effort = PROVIDERS[runProvider].efforts.length ? body.effort : "medium";
  const mode = body.mode;
  if (body.includeP2 !== undefined && typeof body.includeP2 !== "boolean") {
    return c.json({ error: "includeP2 must be a boolean" }, 400);
  }
  const includeP2 = body.includeP2 === true;
  // Scan only: the most subagents the agent may start. Omitted = 0, which keeps Agent and Task blocked.
  const maxSubagents = body.maxSubagents === undefined ? 0 : body.maxSubagents;
  // Scoped-scan category selection (deduped). Only the ola-security-audit skill
  // honors it; empty = full scan (byte-identical invocation). A present-but-
  // non-array value is a client bug — reject it rather than silently coercing
  // to [] (which means "full scan" and could burn a large token budget).
  if (body.categories !== undefined && !Array.isArray(body.categories)) {
    return c.json({ error: "categories must be an array of category tokens" }, 400);
  }
  const categories = Array.isArray(body.categories)
    ? [...new Set(body.categories.map(String))]
    : [];
  // Generic (headless) run: raw prompt + bind-mounted host workspace instead
  // of skill + cloned repo. Everything below branches on this exactly once;
  // the skill-run path keeps its original validation byte-for-byte.
  const isGeneric = typeof body.prompt === "string";

  if (isGeneric && commitSha) {
    return c.json({ error: "commitSha only applies to cloned repository runs" }, 400);
  }

  if (!sessionId) return c.json({ error: "sessionId required" }, 400);

  // Resolved early: the model check below depends on it.
  const authMode = (body.authMode ?? "oauth") as AuthMode;
  if (authMode !== "oauth" && authMode !== "api-key" && authMode !== "relay") {
    return c.json({ error: `authMode must be "oauth", "api-key" or "relay"` }, 400);
  }
  if (runProvider === "codex" && authMode === "relay") {
    return c.json({ error: "Codex runs require oauth or api-key authMode" }, 400);
  }
  if ((runProvider === "antigravity" || runProvider === "qoder") && authMode !== "oauth") {
    return c.json({ error: `${PROVIDERS[runProvider].label} runs require oauth authMode` }, 400);
  }
  if (authMode === "api-key" && !(codexKey ? deps.openaiApiKey : deps.anthropicApiKey)) {
    return c.json({ error: `${codexKey ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"} is not set on this server` }, 400);
  }
  if (authMode === "relay" && !(deps.relayBaseUrl && deps.relayAuthToken)) {
    return c.json({ error: "relay channel not configured on this server" }, 400);
  }

  let workspaceHostDir = "";
  const configuredTimeout = process.env.OLA_AGENT_RUN_TIMEOUT_SECONDS
  let timeoutSeconds = !isGeneric && mode === "scan" ? 4 * 60 * 60 : 0
  if (!isGeneric && mode === "scan" && configuredTimeout !== undefined) {
    const value = Number(configuredTimeout)
    if (!configuredTimeout.trim() || !Number.isSafeInteger(value) || value < 0) {
      return c.json({ error: "OLA_AGENT_RUN_TIMEOUT_SECONDS must be a non-negative whole number" }, 500)
    }
    timeoutSeconds = value
  }
  if (isGeneric) {
    if (!deps.workspacesRoot) {
      return c.json({ error: "generic runs disabled (OLA_AGENT_WORKSPACES_ROOT not set)" }, 403);
    }
    if (!body.prompt!.trim()) return c.json({ error: "prompt must be non-empty" }, 400);
    if (new TextEncoder().encode(body.prompt!).length > MAX_PROMPT_BYTES) {
      return c.json({ error: `prompt exceeds ${MAX_PROMPT_BYTES} bytes` }, 400);
    }
    if (skill !== undefined || repoUrl) {
      return c.json({ error: "prompt runs must not set skill/repoUrl" }, 400);
    }
    const rawDir = (body.workspaceHostDir ?? "").trim();
    if (!rawDir.startsWith("/")) {
      return c.json({ error: "workspaceHostDir must be an absolute host path" }, 400);
    }
    workspaceHostDir = resolve(rawDir); // collapses any ../ segments
    // Resolve symlinks, so a link inside an allowed root cannot mount a directory outside it.
    // Under compose the backend cannot see the host roots, so a root it cannot resolve keeps the path check only.
    const realDir = await realpath(workspaceHostDir).catch(() => undefined);
    const roots = deps.workspacesRoot.split(",").map((r) => r.trim()).filter(Boolean);
    const realRoots = await Promise.all(roots.map((root) => realpath(root).catch(() => undefined)));
    const inside = (dir: string, root: string) => dir === root || (dir + "/").startsWith(root.endsWith("/") ? root : root + "/");
    const allowed = roots.some((root, i) => {
      const realRoot = realRoots[i];
      return realRoot ? realDir !== undefined && inside(realDir, realRoot) : inside(workspaceHostDir, root);
    });
    if (realDir) workspaceHostDir = realDir;
    if (!allowed) {
      return c.json({ error: "workspaceHostDir outside OLA_AGENT_WORKSPACES_ROOT allowlist" }, 403);
    }
    if (body.timeoutSeconds !== undefined) {
      const t = Number(body.timeoutSeconds);
      if (!Number.isFinite(t)) return c.json({ error: "timeoutSeconds must be a number" }, 400);
      timeoutSeconds = Math.min(14400, Math.max(30, Math.floor(t)));
    }
    // Raw model ids (relay-side names) allowed here; "" defers to the
    // container's ANTHROPIC_MODEL, so it needs one.
    if (model === undefined ||
        (model !== "" && !VALID_MODELS.includes(model as ModelId) && !RAW_MODEL_RX.test(model))) {
      return c.json({ error: `model must be one of ${VALID_MODELS.join("|")}, a plausible model id, or ""` }, 400);
    }
    if (model === "" && !(authMode === "relay" ? deps.relayModel : deps.anthropicModel)) {
      return c.json({ error: "model is required: no ANTHROPIC_MODEL is set to pick one" }, 400);
    }
  } else {
    // The scanner binds GH_TOKEN to the clone host, so only GitHub repos run.
    if (!repoUrl || !githubRepo(repoUrl)) {
      return c.json({ error: "repoUrl must be a GitHub repository, such as https://github.com/owner/repo" }, 400);
    }
    if (!skill || !VALID_SKILLS.includes(skill)) {
      return c.json({ error: `skill must be one of ${VALID_SKILLS.join("|")}` }, 400);
    }
    // A relay run names a gateway model, so the provider's alias list does not
    // apply. The charset check keeps the id safe for `docker run -e`.
    if (authMode === "relay") {
      if (typeof model !== "string" || !RAW_MODEL_RX.test(model)) {
        return c.json({ error: "model must be a valid relay model id" }, 400);
      }
    } else if (typeof model !== "string" || (providerModels.length ? !providerModels.includes(model) : model !== "")) {
      return c.json({ error: "model must be supported by the selected provider" }, 400);
    }
  }
  if (!effort || !VALID_EFFORTS.includes(effort)) {
    return c.json({ error: `effort must be one of ${VALID_EFFORTS.join("|")}` }, 400);
  }
  if (!mode || !VALID_MODES.includes(mode)) {
    return c.json({ error: `mode must be one of ${VALID_MODES.join("|")}` }, 400);
  }
  // Category scoping only applies to the ola-security-audit skill run. Reject a
  // non-empty selection anywhere else (generic run / other skill) instead of
  // silently dropping it, and reject unknown tokens.
  if (categories.length > 0) {
    if (isGeneric || skill !== "ola-security-audit") {
      return c.json({ error: "categories only apply to the ola-security-audit skill" }, 400);
    }
    const bad = categories.filter((cat) => !VALID_CATEGORIES.has(cat));
    if (bad.length > 0) {
      return c.json({ error: `unknown vuln category token(s): ${bad.join(",")}; allowed: ${[...VALID_CATEGORIES].join(",")}` }, 400);
    }
  }
  if (!Number.isInteger(maxSubagents) || maxSubagents < 0 || maxSubagents > MAX_SUBAGENTS_LIMIT) {
    return c.json({ error: `maxSubagents must be an integer from 0 to ${MAX_SUBAGENTS_LIMIT}` }, 400);
  }
  if (maxSubagents > 0 && (mode !== "scan" || isGeneric || runProvider !== "claude")) {
    return c.json({ error: "maxSubagents only applies to Claude scan runs" }, 400);
  }
  const smokeValidationError = smokeError(body)
  if (smokeValidationError) return c.json({ error: smokeValidationError }, 400)
  if (process.env["OLA_DEV"] !== "1" && (body.smokeSeconds !== undefined || maxSubagents > 0)) {
    return c.json({ error: "smokeSeconds and maxSubagents > 0 require dev mode (OLA_DEV=1)" }, 400)
  }

  if (body.pickedIds !== undefined && (!validPickedIds(body.pickedIds) || isGeneric || mode !== "fix" || skill !== "ola-security-audit")) {
    return c.json({ error: "pickedIds requires a fix skill run and valid unique row ids" }, 400);
  }

  if (!isGeneric && mode === "fix" && !body.pickedIds?.length && !resume) {
    return c.json({ error: "fix runs require pickedIds or a resume" }, 400)
  }
  const ghToken = await deps.getGhToken?.()
  if (!isGeneric && !ghToken) {
    return c.json({ error: "GH_TOKEN is not set. Add a GitHub token with repo scope in Keys settings." }, 400)
  }

  const startKey = isGeneric ? `local:${workspaceHostDir}` : githubRepo(repoUrl!) ?? repoUrl!.toLowerCase()
  if (startingRepos.has(startKey)) return c.json({ error: "Run start in progress for this repository" }, 409)
  const releaseSlot = deps.store.reserveStart(deps.maxConcurrent)
  if (!releaseSlot) {
    return c.json({
      error: `max concurrent runs reached (${deps.maxConcurrent}); try again later`,
    }, 429, { "Retry-After": "5" });
  }
  startingRepos.add(startKey)
  let runId: string | undefined
  try {
    if (resume && await lstat(resolve(deps.runsRootDir, resume.from, "artifacts", "resumed.json")).then(() => true, () => false)) {
      return c.json({ error: "run already resumed" }, 409)
    }

    let pick: Awaited<ReturnType<typeof preparePick>> | undefined
    const trackerRepo = isGeneric ? undefined : trackerForUrl(repoUrl!)
    if (body.pickedIds?.length && !trackerRepo) return c.json({ error: "pickedIds requires the tracker repository" }, 400)
    let trackerClient: PickClient | undefined
    let trackerStore: TrackerStore | undefined
    if (trackerRepo && skill === "ola-security-audit") {
      // Refresh rows from PR states, so Pick sees merged and closed PRs. GitHub errors never block the run.
      const refresh = async () => {
        try {
          trackerClient = suppliedPickClient ?? new GitHubClient(trackerRepo, await operatorToken(deps.getGhToken))
          trackerStore = await trackerStoreFor(trackerRepo, deps)
          await refreshRows(trackerClient, trackerStore, trackerRepo, await heldRows(deps))
        } catch (error) {
          console.warn(`[runs] row refresh skipped: ${(error as Error).message}`)
        }
      }
      // A Pick run reads the rows next, so it waits. Other runs only keep Pick fresh, so the start does not wait.
      if (body.pickedIds?.length) await refresh(); else void refresh()
    }
    if (body.pickedIds?.length) {
      try {
        pick = await preparePick(trackerClient ?? suppliedPickClient ?? new GitHubClient(trackerRepo!, await operatorToken(deps.getGhToken)), trackerStore ?? await trackerStoreFor(trackerRepo!, deps), trackerRepo!, body.pickedIds)
      } catch (error) {
        return c.json({ error: (error as Error).message }, 400)
      }
    }

    // Refresh OAuth credentials from host Keychain (macOS dev mode) before
    // spawning the scanner. No-op when not on darwin or when
    // OLA_AGENT_CREDENTIALS_HOST_PATH unset. Per-call cost is one fork+exec
    // of `security`; concurrent calls coalesce into a single refresh.
    if (deps.credentialsHostPath) {
      const r = await refreshCredentials(deps.credentialsHostPath);
      if (!r.refreshed && r.reason) {
        console.warn(`[runs] credential refresh skipped: ${r.reason}`);
      }
    }

    deps.store.ensureSession(sessionId);

    // Categories only take effect for the ola-security-audit skill run; anywhere
    // else this collapses to "" so the scan invocation stays byte-identical.
    // Selecting all categories is the same as "full scan" — normalize it to
    // empty so it's stored/shown/scoped as Full (not a misleading "非全量").
    const isFullSelection = categories.length >= VULN_CATEGORIES.length;
    const scopedCategories: string[] =
      !isGeneric && skill === "ola-security-audit" && !isFullSelection ? categories : [];
    const categoriesCsv = scopedCategories.join(",");

    const newRunId = crypto.randomUUID()
    deps.store.createRun({
      runId: newRunId,
      sessionId,
      repoUrl: isGeneric ? `local:${workspaceHostDir}` : repoUrl!,
      branch: isGeneric ? "(local)" : (branch || "(default)"),
      skill: isGeneric ? "generic" : skill!,
      provider: runProvider,
      reviewProvider,
      reviewModel,
      reviewEffort,
      authMode,
      model: model as string,
      effort,
      mode,
      categories: categoriesCsv,
      ...(mode === "scan" ? { maxSubagents, includeP2 } : {}),
      language: body.language ?? "zh",
      commitSha,
      ...(resume ? { resumedFrom: resume.from } : {}),
    });
    runId = newRunId
    // The queued row now holds the slot.
    releaseSlot()
    // A repo the dev types is remembered for Start, Pick and Overview. A Pick run only reuses one.
    const repoSlug = isGeneric ? undefined : githubRepo(repoUrl!);
    if (repoSlug && !body.pickedIds?.length) deps.store.touchRepo(repoSlug, repoUrl!.trim(), branch || "");
    const profileOverride = mode === "scan" && repoSlug ? deps.store.profileOverride(repoSlug) : null;
    const savedRepo = mode === "fix" && repoSlug ? deps.store.listRepos().find(row => row.repo === repoSlug) : undefined;
    const repoPhp = savedRepo?.override?.php || savedRepo?.profile?.php || "";

    // Prepare per-run artifacts dir on host.
    const artifactsDir = resolve(deps.runsRootDir, runId, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const inputs: RunInput[] = []

    // Prompt travels as a file, not env: avoids `docker run -e` size limits and
    // /proc/<pid>/cmdline exposure. The artifacts dir is identity-mounted in
    // compose, so the path the scanner sees is /workspace/artifacts/prompt.txt.
    if (isGeneric) {
      writeArtifact(artifactsDir, "prompt.txt", body.prompt!);
    }

    if (pick) {
      const rows = pick.picked.map(({ id, category, file, lines, severity, reason }) => ({ id, category, file, lines, severity, reason }))
      writeArtifact(artifactsDir, "picked.json", JSON.stringify(rows))
    }
    let note = body.note?.trim()
    if (resume) {
      const from = resolve(deps.runsRootDir, resume.from, "artifacts")
      // Review and check files carry over, so the resumed run continues where the stopped one was.
      // The bridge reads resume-checkpoint.json for the phase and the finished review rounds,
      // and starts the new report with resume-report.md.
      const carried: [string, string][] = [
        ...(mode === "scan" ? ["auth.json"] : ["picked.json", "findings.json", "review-1.json", "review-2.json", "checks.json", ...(resume.bundled ? ["resume.bundle"] : [])]).map((name): [string, string] => [name, name]),
        ["checkpoint.json", "resume-checkpoint.json"],
        ["report.md", "resume-report.md"],
      ]
      for (const [name, as] of carried) {
        try { copyArtifact(from, name, artifactsDir, as, name === "resume.bundle" ? 64 * 1024 * 1024 : name === "checkpoint.json" ? MAX_CHECKPOINT_BYTES : undefined) } catch {}
      }
      // The batch note lives only in repo context, so the stopped run's context carries it over.
      const saved = (await readRepoContext(from)).find(document => document?.path === "operator-note.md")?.content
      note = typeof saved === "string" ? saved : undefined
    }

    // Repo context goes into the scan and fix prompt (bridge.mjs), for every provider. Generic runs get no context.
    if (!isGeneric) {
      const context = await loadRepoContext(repoUrl!, undefined, note, inputs)
      if (context.length) writeArtifact(artifactsDir, "repo-context.json", JSON.stringify(context))
      // The image's copy of the repo notes is as old as the image. The entrypoint installs this one instead.
      const repo = githubRepo(repoUrl!)
      if (repo) try { copyArtifact(TARGETS_DIR, repo.replace("/", "__") + ".md", artifactsDir, "target-notes.md") } catch { /* no notes */ }
      for (const name of ["SKILL.md", "applies-to.json"]) {
        const info = await lstat(resolve(TARGETS_DIR, "..", name)).catch(() => undefined)
        if (info?.isFile()) inputs.push({ path: `skill/${skill}/${name}`, source: "suite", size: info.size })
      }
    }
    for (const [path, source] of [
      ["prompt.txt", "human"], ["picked.json", "human"], ["target-notes.md", "repo"],
      ...["resume-checkpoint.json", "resume-report.md", "resume.bundle", "auth.json", "findings.json", "review-1.json", "review-2.json", "checks.json"].map(path => [path, "repo"] as const),
    ] as const) {
      const info = await lstat(join(artifactsDir, path)).catch(() => undefined)
      if (info?.isFile()) inputs.push({ path, source, size: info.size })
    }
    writeArtifact(artifactsDir, "inputs.json", JSON.stringify(inputs))

    // Launch scanner in background. Failures bubble to the bus / store.
    const scanner = new ScannerRun(runId, {
      controller: deps.controller,
      bus: deps.bus,
      store: deps.store,
      onTerminal: deps.onTerminal,
      onFixComplete: mode === "fix" && (pick || resume) ? deps.onFixComplete : undefined,
    });
    deps.activeRuns.set(runId, scanner);

    const provider = providerSelection(runProvider === "codex" ? "oauth" : authMode, deps);
    await scanner.start({
      runId,
      image: deps.scannerImage,
      env: {
        RUN_ID: runId,
        EVENTS_LOG: "1",
        ...(isGeneric
          ? {
            LOCAL_WORKSPACE: "1",
            PROMPT_FILE: "/workspace/artifacts/prompt.txt",
            ...(deps.workspaceChown ? { WORKSPACE_CHOWN: deps.workspaceChown } : {}),
          }
          : {
            REPO_URL: `https://github.com/${githubRepo(repoUrl!)}`,
            BRANCH: branch,
            ...(commitSha ? { COMMIT_SHA: commitSha } : {}),
            SKILL: skill!,
            ...(body.pickedIds !== undefined ? { PICKED_IDS: (pick ? pick.picked.map(row => row.id) : body.pickedIds).join(",") } : {}),
            ...(mode === "fix" && (pick || resume) ? { PICKED_FILE: "/workspace/artifacts/picked.json", MAX_CHANGED_LINES: String(BATCH.maxLines) } : {}),
            ...(mode === "fix" && resume ? { RESUME_DONE: resume.done.join(","), ...(resume.bundled ? { RESUME_BUNDLE: "/workspace/artifacts/resume.bundle" } : {}) } : {}),
            // Empty selection ⇒ key omitted ⇒ bridge round1Prompt unchanged.
            ...(categoriesCsv ? { CATEGORIES: categoriesCsv } : {}),
            // The operator's PHP version and framework from the Scan page. The bridge filters bug types with it.
            ...(profileOverride ? { PROFILE_OVERRIDE: JSON.stringify(profileOverride) } : {}),
            ...(repoPhp ? { REPO_PHP: repoPhp } : {}),
          }),
        ...(usesCodex ? { CODEX_HOME: "/root/.codex" } : {}),
        ...(codexUsesKey ? { OPENAI_API_KEY: deps.openaiApiKey } : {}),
        PROVIDER: runProvider,
        REVIEW_PROVIDER: reviewProvider,
        ...(reviewModel !== undefined ? { REVIEW_MODEL: reviewModel } : {}),
        ...(reviewEffort !== undefined ? { REVIEW_EFFORT: reviewEffort } : {}),
        PROVIDER_COMMAND: JSON.stringify(PROVIDERS[runProvider].command),
        REVIEW_PROVIDER_COMMAND: JSON.stringify(PROVIDERS[reviewProvider].command),
        SMOKE_SECONDS: String(body.smokeSeconds ?? 0),
        MODEL: model as string,
        EFFORT: effort,
        ...(mode === "scan" ? { INCLUDE_P2: String(includeP2) } : {}),
        ...(maxSubagents ? { MAX_SUBAGENTS: String(maxSubagents) } : {}),
        MODE: mode,
        OUTPUT_LANGUAGE: body.language ?? "zh",
        GH_TOKEN: ghToken,
        ...provider.env,
      },
      artifactsHostDir: artifactsDir,
      workspaceHostDir: isGeneric ? workspaceHostDir : undefined,
      credentialsHostPath: provider.credentialsHostPath,
      codexAuthHostPath: usesCodex && !codexUsesKey ? deps.codexAuthHostPath : undefined,
      qoderAuthHostPath: usesQoder ? deps.qoderAuthHostPath : undefined,
      antigravityAuthHostPath: usesAntigravity ? deps.antigravityAuthHostPath : undefined,
      // ponytail: host paths, so this works when the backend runs on the host (dev.sh), not inside compose.
      relatedHostDirs: isGeneric ? undefined : await relatedRepoDirs(repoUrl!),
      timeoutMs: timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined,
    })
    if (pick) {
      try {
        await pick.mark(runId)
      } catch (error) {
        throw new Error(`could not mark picked rows. Run stopped so the rows cannot be picked twice: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (pick?.rest.length) queuedBatches.set(runId, { body: { ...body, sessionId, model, effort }, rest: pick.rest })

    if (resume) {
      writeArtifact(resolve(deps.runsRootDir, resume.from, "artifacts"), "resumed.json", JSON.stringify({ runId }))
    }

    const resp: StartRunResponse = { runId, status: "queued" };
    return c.json(resp, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (runId) {
      deps.store.updateRunStatus(runId, "failed", { error: msg })
      deps.bus.publish(runId, { type: "run_status", status: "failed", error: msg })
      deps.bus.publish(runId, { type: "run_finished", status: "failed", error: msg })
      await deps.activeRuns.get(runId)?.stop().catch(() => {})
      deps.activeRuns.delete(runId)
      deps.onTerminal?.(runId)
    }
    return c.json({ error: msg, runId }, 500)
  } finally {
    releaseSlot()
    startingRepos.delete(startKey)
  }
}

// Keep rows through PR creation, or while a stopped run waits for a resume.
// A resume copies picked.json, so the newest attempt of a chain holds the rows.
export async function heldRows(deps: { store: Store, runsRootDir: string, activeRuns?: ReadonlyMap<string, unknown> }): Promise<Set<string>> {
  const held = new Set<string>()
  const completing = [...deps.activeRuns?.keys() ?? []].filter(id => deps.store.getRun(id)?.status === "completed")
  const ids = new Set([...deps.store.listUnfinishedRuns().map(run => run.runId), ...deps.store.stoppedRunIds(), ...completing])
  await Promise.all([...ids].filter(id => SAFE_RUN_ID.test(id)).map(async id => {
    const dir = resolve(deps.runsRootDir, id, "artifacts")
    if (await lstat(join(dir, "resumed.json")).then(() => true, () => false)) return
    let rows: unknown = []
    try { rows = readArtifactJson(dir, "picked.json") } catch {}
    for (const row of Array.isArray(rows) ? rows : []) if (typeof row?.id === "string") held.add(row.id)
  }))
  return held
}

// POST /api/runs/:id/resume — continue a stopped run from its checkpoint.
export async function handleResumeRun(c: Context, deps: RunHandlersDeps): Promise<Response> {
  const runId = c.req.param("id");
  if (!runId || !SAFE_RUN_ID.test(runId)) return c.json({ error: "bad run id" }, 400);
  let options: Pick<StartRunRequest, "authMode"> = {}
  const text = await c.req.text()
  if (text.trim()) {
    try { options = JSON.parse(text) } catch { return c.json({ error: "invalid JSON" }, 400) }
    if (!options || typeof options !== "object" || Array.isArray(options)) return c.json({ error: "body must be an object" }, 400)
  }
  const run = deps.store.getRun(runId);
  if (!run) return c.json({ error: "not found" }, 404);
  if (run.status !== "stopped") return c.json({ error: `run is ${run.status}, only a stopped run can resume` }, 409);
  const dir = resolve(deps.runsRootDir, runId, "artifacts");
  try { await lstat(join(dir, "resumed.json")); return c.json({ error: "run already resumed" }, 409) } catch { /* not resumed yet */ }
  const checkpoint = await readCheckpoint(deps.runsRootDir, runId)
  if (!checkpoint) return c.json({ error: "run has no checkpoint" }, 409)
  const done = Array.isArray(checkpoint.done) && validPickedIds(checkpoint.done) ? checkpoint.done : []
  return await handleStartRun(c, deps, {
    sessionId: run.sessionId, repoUrl: run.repoUrl, branch: run.branch === "(default)" ? "" : run.branch,
    provider: run.provider, reviewProvider: run.reviewProvider, reviewModel: run.reviewModel, reviewEffort: run.reviewEffort, authMode: options.authMode === undefined ? run.authMode : options.authMode,
    commitSha: run.mode === "scan" && typeof checkpoint.head === "string" && /^[a-f0-9]{40}$/.test(checkpoint.head) ? checkpoint.head : run.commitSha,
    skill: run.skill as SkillName, model: run.model, effort: run.effort, mode: run.mode,
    categories: run.categories ?? [],
    language: run.language ?? (checkpoint.language === "en" ? "en" : "zh"),
    ...(run.mode === "scan" ? { maxSubagents: run.maxSubagents ?? 0, includeP2: run.includeP2 ?? false } : {}),
  }, undefined, { from: runId, done, bundled: run.mode === "fix" && checkpoint.bundled === true });
}

function tokenUsage(usage: UsageDelta): UsageDelta {
  const { inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, credits, partialUsage, partial_usage } = usage
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, ...(credits ? { credits } : {}),
    ...(partialUsage ? { partialUsage } : {}), ...(partial_usage ? { partial_usage } : {}) }
}

function validUsage(value: unknown): value is UsageDelta {
  if (!value || typeof value !== "object") return false
  const usage = value as UsageDelta
  return [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheCreateTokens]
    .every(n => Number.isSafeInteger(n) && n >= 0) &&
    (usage.credits === undefined || Number.isFinite(usage.credits) && usage.credits >= 0)
}

async function withModelInfo(run: RunSummary, runsRootDir?: string): Promise<RunSummary> {
  if (!runsRootDir || !SAFE_RUN_ID.test(run.runId)) return run
  try {
    const record = readArtifactJson(resolve(runsRootDir, run.runId, "artifacts"), "usage.json") as { usage?: unknown, phaseUsage?: PhaseUsage } | null
    if (validUsage(record?.usage) && record?.phaseUsage && typeof record.phaseUsage === "object" &&
      !Array.isArray(record.phaseUsage) && Object.entries(record.phaseUsage).every(([phase, usage]) =>
        ["fix", "review", "checks"].includes(phase) && validUsage(usage))) {
      run = { ...run, usage: tokenUsage(record.usage), phaseUsage: Object.fromEntries(Object.entries(record.phaseUsage).map(([phase, usage]) => [phase, tokenUsage(usage)])) }
    }
  } catch { /* older runs have no usage record */ }
  try {
    const info = readArtifactJson(resolve(runsRootDir, run.runId, "artifacts"), "model-info.json") as { model?: unknown, effort?: unknown } | null
    const model = typeof info?.model === "string" && RAW_MODEL_RX.test(info.model) ? info.model : undefined
    const effort = typeof info?.effort === "string" && RAW_MODEL_RX.test(info.effort) ? info.effort : undefined
    return model || effort ? { ...run, modelInfo: { model, effort } } : run
  } catch { return run }
}

// GET /api/runs/:id
export async function handleGetRun(c: Context, deps: { store: Store, runsRootDir?: string }): Promise<Response> {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "missing run id" }, 400);
  const run = deps.store.getRun(id);
  if (!run) return c.json({ error: "not found" }, 404);
  const summary = await withModelInfo(run, deps.runsRootDir)
  const attempts = deps.store.attempts(id)
  const context = deps.runsRootDir && SAFE_RUN_ID.test(id) && githubRepo(run.repoUrl) ? await contextPaths(deps.runsRootDir, id) : undefined
  return c.json({ ...summary, ...(attempts.length > 1 ? { attempts } : {}), ...(context ? { context } : {}) });
}

// The workspace files a repo run got in its prompt. Empty when it got none.
async function contextPaths(runsRootDir: string, runId: string): Promise<string[]> {
  const documents = await readRepoContext(join(resolve(runsRootDir, runId), "artifacts"))
  return documents.map(document => document?.path).filter((path): path is string => typeof path === "string")
}

// Runs before the rename saved the repo context as indexing-context.json.
async function readRepoContext(artifactsDir: string): Promise<{ path?: unknown, content?: unknown }[]> {
  for (const name of ["repo-context.json", "indexing-context.json"]) {
    try {
      const documents = readArtifactJson(artifactsDir, name)
      return Array.isArray(documents) ? documents : []
    } catch {}
  }
  return []
}

// GET /api/sessions/:id/runs — per-session history (kept for multi-tenant)
export async function handleListRuns(c: Context, deps: { store: Store, runsRootDir?: string }): Promise<Response> {
  const sid = c.req.param("id");
  if (!sid) return c.json({ error: "missing session id" }, 400);
  const rows = deps.store.listRunsForSession(sid);
  return c.json({ runs: await Promise.all(rows.map(run => withModelInfo(run, deps.runsRootDir))) });
}

// GET /api/runs?limit=&offset=  — cross-session history list
export async function handleListAllRuns(c: Context, deps: { store: Store, runsRootDir?: string }): Promise<Response> {
  const limit  = clampInt(c.req.query("limit"),  200, 1, 500);
  const offset = clampInt(c.req.query("offset"),   0, 0, Number.MAX_SAFE_INTEGER);
  const status = c.req.query("status") ?? "";
  const mode = c.req.query("mode") ?? "";
  const starred = c.req.query("starred");
  if (mode && !["scan", "fix"].includes(mode) || status && !["connecting", "queued", "cloning", "scanning", "completed", "failed", "aborted", "stopped"].includes(status) || starred !== undefined && !["0", "1"].includes(starred)) {
    return c.json({ error: "invalid history filter" }, 400);
  }
  const filters = { status, mode, starred: starred === "1" };
  const rows = deps.store.listAllRuns(limit, offset, filters);
  return c.json({ runs: await Promise.all(rows.map(run => withModelInfo(run, deps.runsRootDir))), total: deps.store.countRuns(filters), limit, offset });
}

export async function handleStarRun(c: Context, deps: { store: Store }): Promise<Response> {
  const id = c.req.param("id");
  if (!id || !SAFE_RUN_ID.test(id)) return c.json({ error: "bad run id" }, 400);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.starred !== "boolean") return c.json({ error: "starred must be a boolean" }, 400);
  if (!deps.store.getRun(id)) return c.json({ error: "not found" }, 404);
  deps.store.setStarred(id, body.starred);
  return c.json({ starred: body.starred });
}

// GET /api/runs/:id/findings
export function handleListFindings(c: Context, deps: { store: Store }): Response {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "missing run id" }, 400);
  return c.json({ findings: deps.store.listFindings(id).map(f => ({ ...f, subsystem: findingSubsystem(f) })) });
}

// The Pick page's subsystem, so the run page filters findings the same way. A path outside the repo has none.
function findingSubsystem(f: { category: string, kind?: string, file?: string }): string {
  try { return f.file ? subsystem({ ...f, file: f.file }) : "" } catch { return "" }
}

type PostDeps = Pick<RunHandlersDeps, "store" | "createTrackerStore" | "getGhToken">

// Only a completed scan of a GitHub repo can post. Returns the repo, or the error response.
function postableRun(c: Context, store: Store): { id: string, repo: string } | Response {
  const id = c.req.param("id")
  const run = id ? store.getRun(id) : null
  if (!run) return c.json({ error: "run not found" }, 404)
  if (run.mode !== "scan" || run.status !== "completed") return c.json({ error: "only a completed scan can post findings" }, 409)
  const repo = githubRepo(run.repoUrl)
  if (!repo) return c.json({ error: "only a GitHub repository can get issues" }, 400)
  return { id: id!, repo }
}

// GET /api/runs/:id/post — which unposted findings the repo's tracking issues already hold, so the Run tab can untick them.
export async function handlePostPreview(c: Context, deps: PostDeps): Promise<Response> {
  const run = postableRun(c, deps.store)
  if (run instanceof Response) return run
  try {
    const findings = deps.store.listFindings(run.id).filter(f => !f.posted)
    const trackerStore = await trackerStoreFor(run.repo, deps)
    return c.json({ repo: run.repo, matches: await matchTracked(findings, trackerStore) })
  } catch {
    console.warn(`[runs ${run.id}] reading tracker failed`)
    return c.json({ error: "could not read the tracker. Check gh auth login or GH_TOKEN." }, 502)
  }
}

// POST /api/runs/:id/post {ids} — post the findings the dev ticked to the scanned repo's GitHub tracking issues.
// Findings already posted are left out.
export async function handlePostFindings(c: Context, deps: PostDeps): Promise<Response> {
  const run = postableRun(c, deps.store)
  if (run instanceof Response) return run
  const body = await c.req.json().catch(() => ({})) as { ids?: unknown }
  if (!Array.isArray(body.ids) || !body.ids.length || !body.ids.every(value => typeof value === "string")) {
    return c.json({ error: "ids must be a non-empty list of finding ids" }, 400)
  }
  const ids = new Set(body.ids as string[])
  const findings = deps.store.listFindings(run.id).filter(f => ids.has(f.id) && !f.posted)
  try {
    const counts = await postFindings(run.id, run.repo, findings, await trackerStoreFor(run.repo, deps))
    deps.store.markPosted(run.id, findings.map(f => f.id))
    return c.json(counts)
  } catch {
    // Do not echo the error. It can hold a token or a GitHub response body.
    console.warn(`[runs ${run.id}] posting findings failed`)
    return c.json({ error: "posting to GitHub failed. Check gh auth login or GH_TOKEN." }, 502)
  }
}

function clampInt(v: string | undefined, def: number, lo: number, hi: number): number {
  if (v == null) return def;
  const n = parseInt(v, 10);
  if (isNaN(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}

// GET /api/runs/:id/events  — SSE stream
export function handleRunEvents(c: Context, deps: { bus: RunEventBus, store: Store, runsRootDir: string, activeRuns?: ReadonlyMap<string, ScannerRun> }): Response {
  const runId = c.req.param("id");
  if (!runId || !SAFE_RUN_ID.test(runId)) return c.json({ error: "bad run id" }, 400)
  const run = deps.store.getRun(runId)
  if (!run) return c.json({ error: "not found" }, 404)
  const completing = run.status === "completed" && run.mode === "fix" && deps.activeRuns?.has(runId) &&
    !deps.bus.history(runId).some(event => event.type === "run_finished")
  const terminal = !completing && (run.status === "completed" || run.status === "failed" || run.status === "aborted" || run.status === "stopped") ? run.status : undefined
  async function* storedEvents(): AsyncGenerator<RunEvent> {
    const history = deps.bus.history(runId!)
    if (history.length) {
      for (const event of history) if (event.type !== "run_finished") yield event
    } else {
      let fd: number | undefined
      try { fd = openArtifact(resolve(deps.runsRootDir, runId!, "artifacts"), "events.jsonl") } catch { /* missing or not a regular file */ }
      if (fd !== undefined) {
        for await (const line of replayEvents(Readable.toWeb(createReadStream("", { fd })) as unknown as ReadableStream<Uint8Array>)) {
          const event = JSON.parse(line) as RunEvent
          if (event.type !== "run_finished") yield event
        }
      }
    }
    yield { type: "run_finished", status: terminal!, ...(run!.error ? { error: run!.error } : {}) }
  }
  const iter = terminal ? storedEvents() : deps.bus.subscribe(runId)
  const encoder = new TextEncoder()
  let cancelled = false

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("retry: 1000\n\n"));
    },
    async pull(controller) {
      try {
        const { value: event, done } = await iter.next()
        if (cancelled) return
        if (!done) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        if (done || event.type === "run_finished") {
          await iter.return?.()
          controller.close()
        }
      } catch (error) {
        await iter.return?.()
        if (!cancelled) controller.error(error)
      }
    },
    cancel() {
      cancelled = true
      return iter.return?.().then(() => {})
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// GET /api/runs/active — runs still going. A database row left by a backend restart has no live
// scanner, so it does not count. The UI uses this for its Run tab and its "another run" warning.
export function handleActiveRuns(
  c: Context,
  deps: { store: Store; activeRuns: Map<string, ScannerRun> },
): Response {
  return c.json({ runs: deps.store.listUnfinishedRuns().filter((run) => deps.activeRuns.has(run.runId)).map(run => ({ ...run, phase: deps.store.getRun(run.runId)?.phase })) });
}

// POST /api/runs/:id/pause — checkpoint a scan at the next safe point.
export async function handlePauseRun(
  c: Context,
  deps: { store: Store; activeRuns: Map<string, ScannerRun> },
): Promise<Response> {
  const runId = c.req.param("id");
  if (!runId || !SAFE_RUN_ID.test(runId)) return c.json({ error: "bad run id" }, 400);
  const run = deps.store.getRun(runId);
  if (!run) return c.json({ error: "not found" }, 404);
  if (run.mode !== "scan" || !["queued", "cloning", "scanning"].includes(run.status)) {
    return c.json({ error: "only a running scan can pause" }, 409);
  }
  const scanner = deps.activeRuns.get(runId);
  if (!scanner) return c.json({ error: "run is not active" }, 409);
  try { await scanner.pause(); }
  catch { return c.json({ error: "could not request pause" }, 503); }
  return c.json({ ok: true });
}

// POST /api/runs/:id/stop — end a run that has not finished. A finished run keeps its status.
export async function handleStopRun(
  c: Context,
  deps: { store: Store; activeRuns: Map<string, ScannerRun> },
): Promise<Response> {
  const runId = c.req.param("id");
  if (!runId || !SAFE_RUN_ID.test(runId)) return c.json({ error: "bad run id" }, 400);

  const run = deps.store.getRun(runId);
  if (!run) return c.json({ error: "not found" }, 404);
  if (["completed", "failed", "aborted", "stopped"].includes(run.status)) {
    return c.json({ error: `run is already ${run.status}` }, 409);
  }
  const scanner = deps.activeRuns.get(runId);
  if (!scanner) return c.json({ error: "run is not active" }, 409);

  await scanner.stop();
  return c.json({ ok: true });
}

// GET /api/runs/:id/artifacts/<kind>. Only the files named below are served.
export async function handleRunArtifact(c: Context, deps: { runsRootDir: string }): Promise<Response> {
  const runId = c.req.param("id");
  const kind = c.req.param("kind");
  if (!runId || !SAFE_RUN_ID.test(runId)) return c.json({ error: "bad run id" }, 400);

  const filename = ({
    patch:    "working.patch",
    report:   "report.md",       // full report (process + final summary) — compat
    activity: "activity.md",     // process narration before the summary marker
    commits:  "commits.log",
    push:     "push.json",
    // Generic headless runs:
    response: "response.md",     // final assistant message (SkillOpt's answer)
    summary:  "response.md",     // alias for response.md / summary.md
    events:   "events.jsonl",    // full bridge frame log (SkillOpt's raw trace)
    prompt:   "prompt.txt",      // the submitted task prompt
    // Diagnostics, written for every run:
    "run-info": "run-info.json",           // image, app commit, caps, env (secret values dropped)
    stderr:     "stderr.log",              // scrubbed container stderr
    context:    "repo-context.json",       // repo context given to scan and fix runs
    inputs:     "inputs.json",
  } as Record<string, string>)[kind ?? ""];
  if (!filename) return c.json({ error: "unknown artifact kind" }, 400);

  const dir = join(resolve(deps.runsRootDir, runId), "artifacts");
  try {
    // The scanner can leave a symlink, FIFO or directory in artifacts/. Serve regular files only.
    if (!(await lstat(join(dir, filename))).isFile()) return c.json({ error: "not a regular file" }, 400);
    const fd = openArtifact(dir, filename);
    const size = fstatSync(fd).size;
    const source = Readable.toWeb(createReadStream("", { fd })) as unknown as ReadableStream<Uint8Array>
    if (kind === "events" && c.req.query?.("replay") === "1") {
      return new Response(Readable.toWeb(Readable.from(replayEvents(source))) as unknown as ReadableStream<Uint8Array>, {
        headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
      })
    }
    const ct = filename.endsWith(".json")
      ? "application/json"
      : filename.endsWith(".md")
        ? "text/markdown; charset=utf-8"
        : "text/plain; charset=utf-8";
    return new Response(source, {
      headers: {
        "Content-Type": ct,
        "Content-Length": String(size),
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return c.json({ error: "not found" }, 404);
    // The message can hold absolute host paths. Log it, return a generic error.
    console.warn(`[runs ${runId}] artifact ${kind} unreadable: ${(e as Error).message}`);
    return c.json({ error: "artifact unreadable" }, 500);
  }
}
