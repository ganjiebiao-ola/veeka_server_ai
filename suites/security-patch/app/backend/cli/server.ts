import { fileURLToPath } from "node:url"
import { handleClosePR, handleRowChange, handleOverview, handlePick, handleTrackers, finishBatch, recordBatchError } from "../handlers/pick.ts";
import { handleReadPR } from "../handlers/pr_reader.ts"
import { handleAddRepo, handleDetectProfile, handleListRepos, handleRemoveRepo, handleRepoLanguage, handleSetProfile } from "../handlers/repos.ts";
import { setKnownRepos } from "../tracker/repos.ts";
import { queuedBatches } from "../tracker/pick.ts";
import { Hono } from "hono";
import { join } from "node:path"
import {
  DEFAULT_CPUS,
  DEFAULT_MEMORY_MB,
  DockerController,
  parseResourceEnv,
} from "../docker/controller.ts";
import { RunEventBus } from "../events/bus.ts";
import { Store } from "../store/repo.ts";
import type { ScannerRun } from "../orchestrator/scanner.ts";
import { refreshCredentials } from "../auth/refresh_creds.ts";
import {
  handleGetRun,
  handleListAllRuns,
  handleStarRun,
  handleListFindings,
  handlePostFindings,
  handlePostPreview,
  handleListRuns,
  handleStopRun,
  handlePauseRun,
  handleActiveRuns,
  handleResumeRun,
  handleRunArtifact,
  handleRunEvents,
  handleStartRun,
} from "../handlers/runs.ts";
import { handleCreateSession, handleRefreshSession } from "../handlers/sessions.ts";
import { handleProviders } from "../handlers/providers.ts"
import { handleSetup } from "../handlers/setup.ts"
import { handleRelayModels } from "../handlers/relay.ts";
import { handleSaveKeys, maskedKeys, reloadKeys } from "../handlers/keys.ts"

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const BIND_HOST = process.env["OLA_AGENT_BIND_HOST"] || "127.0.0.1"
const RUNS_ROOT      = process.env["OLA_AGENT_RUNS_ROOT"]      || join(REPO_ROOT, "backend", "workspace", "runs");
const DB_PATH        = process.env["OLA_AGENT_DB_PATH"]        || join(REPO_ROOT, "backend", "data", "ola-agent.sqlite");
const SCANNER_IMAGE  = process.env["OLA_AGENT_SCANNER_IMAGE"]  || "ola-agent-scanner:latest";
const MAX_CONCURRENT = parseInt(process.env["MAX_CONCURRENT_SCANS"] || "5", 10);
// Per-scanner resource caps. The scanner is a SIBLING container (spawned through
// the mounted docker socket), so the backend's own mem_limit does not constrain
// it — on a small host the number that actually matters is
// MAX_CONCURRENT_SCANS x OLA_AGENT_SCANNER_MEMORY_MB. Unset (or unusable) leaves
// the built-in 2 CPU / 4096 MB, so existing deployments are unaffected.
// parseResourceEnv rejects units/suffixes and out-of-range values rather than
// letting them reach `docker run` — see the comment on it for why both a too
// small and a too large value fail silently.
const SCANNER_CPUS = parseResourceEnv(
  "OLA_AGENT_SCANNER_CPUS",
  process.env["OLA_AGENT_SCANNER_CPUS"],
  { min: 0.01, max: navigator.hardwareConcurrency, integer: false },
);
const SCANNER_MEMORY_MB = parseResourceEnv(
  "OLA_AGENT_SCANNER_MEMORY_MB",
  process.env["OLA_AGENT_SCANNER_MEMORY_MB"],
  { min: 256, max: 65536, integer: true },
);
// Set this equal to OLA_AGENT_SCANNER_MEMORY_MB to forbid the scanner from
// using swap at all. Unset leaves docker's default (swap = memory), preserving
// pre-existing behavior.
const SCANNER_MEMORY_SWAP_MB = parseResourceEnv(
  "OLA_AGENT_SCANNER_MEMORY_SWAP_MB",
  process.env["OLA_AGENT_SCANNER_MEMORY_SWAP_MB"],
  { min: 256, max: 131072, integer: true },
);
// Path on the HOST filesystem where the OAuth credentials file lives. When
// the backend runs in docker compose, scripts/dev.sh exports the slice to
// .runtime/.credentials.json and bind-mounts that to the same path inside
// the backend container (see docker-compose.yml). In dev (`./scripts/dev.sh
// start`) the path resolves to the same host file directly.
const CREDENTIALS_HOST_PATH = process.env["OLA_AGENT_CREDENTIALS_HOST_PATH"];
// Codex ChatGPT-subscription login, mounted RW into runs that use codex only.
const CODEX_AUTH_PATH = process.env["OLA_AGENT_CODEX_AUTH_PATH"] ||
  (process.env["HOME"] ? `${process.env["HOME"]}/.codex/auth.json` : undefined);
const QODER_AUTH_PATH = process.env["OLA_AGENT_QODER_AUTH_PATH"] ||
  (process.env["HOME"] ? `${process.env["HOME"]}/.qoder/.auth` : undefined);
// Antigravity login token, mounted RW into runs that use antigravity only.
const ANTIGRAVITY_AUTH_PATH = process.env["OLA_AGENT_ANTIGRAVITY_AUTH_PATH"] ||
  (process.env["HOME"] ? `${process.env["HOME"]}/.gemini/antigravity-cli/antigravity-oauth-token` : undefined);
// Claude provider auth. ANTHROPIC_API_KEY = official key; ANTHROPIC_AUTH_TOKEN
// + ANTHROPIC_BASE_URL = relay/3rd-party endpoint (e.g. what cc-switch writes
// into the host ~/.claude/settings.json env block); ANTHROPIC_MODEL optional.
const ANTHROPIC_API_KEY = process.env["ANTHROPIC_API_KEY"];
const ANTHROPIC_BASE_URL = process.env["ANTHROPIC_BASE_URL"];
const ANTHROPIC_AUTH_TOKEN = process.env["ANTHROPIC_AUTH_TOKEN"];
const ANTHROPIC_MODEL = process.env["ANTHROPIC_MODEL"];
// Codex API-key logins. A run opts in with authMode:"api-key".
const OPENAI_API_KEY = process.env["OPENAI_API_KEY"];
// Per-run relay channel, independent of the global AUTH_MODE above. When both
// are set, an individual run may opt in with authMode:"relay" to use this
// endpoint (e.g. a litellm proxy with a scoped virtual key) while the rest of
// the deployment stays on subscription OAuth. Omitted authMode keeps today's
// behavior exactly, so configuring these is safe on any deployment.
const RELAY_BASE_URL = process.env["OLA_AGENT_RELAY_BASE_URL"];
const RELAY_AUTH_TOKEN = process.env["OLA_AGENT_RELAY_AUTH_TOKEN"];
const RELAY_MODEL = process.env["OLA_AGENT_RELAY_MODEL"];
// Generic headless runs (SkillOpt et al). Both unset by default → the feature
// is off and every prompt-mode request is rejected 403.
//   WORKSPACES_ROOT: comma-separated HOST path prefixes a request's
//     workspaceHostDir must fall under. Keep it narrow (the caller's outputs
//     tree), never $HOME or /.
//   WORKSPACE_CHOWN: "uid:gid" the scanner chowns the workspace back to on
//     exit — scanners run as root, so without this the caller can't delete
//     files the agent created in the bind mount.
const WORKSPACES_ROOT = process.env["OLA_AGENT_WORKSPACES_ROOT"];
const WORKSPACE_CHOWN = process.env["OLA_AGENT_WORKSPACE_CHOWN"];
// Auth mode: explicit OLA_AGENT_AUTH_MODE wins; otherwise infer "settings"
// (API / cc-switch relay) when a token/key is present, else "oauth"
// (Claude subscription credentials). In any non-oauth mode we never mount
// OAuth credentials nor run the refresh — the provider env vars are
// authoritative. This also neutralizes the OLA_AGENT_CREDENTIALS_HOST_PATH
// that docker-compose.yml hard-codes, so API/relay mode works under compose.
const AUTH_MODE = (process.env["OLA_AGENT_AUTH_MODE"] ||
  (ANTHROPIC_AUTH_TOKEN || ANTHROPIC_API_KEY ? "settings" : "oauth")).toLowerCase();
const USE_OAUTH = AUTH_MODE === "oauth";
const EFFECTIVE_CREDS_PATH = USE_OAUTH ? CREDENTIALS_HOST_PATH : undefined;
// A base URL can carry userinfo or a token in its path or query, so the boot log shows only its origin.
export function urlOrigin(value: string): string {
  try { return new URL(value).origin } catch { return "(invalid URL)" }
}

export interface BuildAppDeps {
  store?: Store;
  controller?: DockerController;
}

export async function buildApp(deps: BuildAppDeps = {}): Promise<Hono> {
  const store = deps.store ?? await Store.open(DB_PATH);
  const controller = deps.controller ?? new DockerController({
    defaultCpus: SCANNER_CPUS,
    defaultMemoryMb: SCANNER_MEMORY_MB,
    defaultMemorySwapMb: SCANNER_MEMORY_SWAP_MB,
  });
  const bus = new RunEventBus();
  const activeRuns = new Map<string, ScannerRun>();

  // Free per-run memory (event buffers, ScannerRun entry) 30 minutes after a
  // run ends, so SSE replay keeps working for a page opened soon after.
  // Without this both maps grow forever, which bites at headless-run volume
  // (thousands of runs per optimization sweep).
  const onTerminal = (runId: string) => {
    queuedBatches.delete(runId); // a failed or cancelled batch ends its pick's chain
    setTimeout(() => {
      activeRuns.delete(runId);
      bus.drop(runId);
    }, 30 * 60_000);
  };

  // Boot hygiene: refresh OAuth credentials from Keychain (macOS host dev
  // mode only; no-op on Linux or when an API key / relay token is in use).
  // Then mark mid-flight runs from previous process as failed and sweep any
  // orphaned containers with our label.
  console.log(
    `[boot] auth mode: ${AUTH_MODE}` +
      (USE_OAUTH
        ? " (Claude subscription OAuth credentials)"
        : ` (provider env${ANTHROPIC_BASE_URL ? ` → ${urlOrigin(ANTHROPIC_BASE_URL)}` : ""}; OAuth disabled)`),
  );
  if (EFFECTIVE_CREDS_PATH) {
    const r = await refreshCredentials(EFFECTIVE_CREDS_PATH);
    if (r.refreshed) {
      const exp = r.expiresAt ? new Date(r.expiresAt).toISOString() : "(unknown)";
      console.log(`[boot] OAuth credentials refreshed from ${r.source} (expires ${exp})`);
    } else {
      console.warn(`[boot] OAuth refresh skipped: ${r.reason}`);
    }
  }
  console.log(
    `[boot] per-run relay channel: ${
      RELAY_BASE_URL && RELAY_AUTH_TOKEN ? "configured" : "not configured"
    }${RELAY_MODEL ? ` (default model ${RELAY_MODEL})` : ""}`,
  );
  if (WORKSPACES_ROOT) {
    console.log(`[boot] generic headless runs enabled — workspace roots: ${WORKSPACES_ROOT}`);
  }
  // State the commitment out loud. Scanners are sibling containers, so nothing
  // else in `docker stats` reveals this number until a scan is actually running
  // (they are `--rm` and short-lived), and "I changed the env but did it take?"
  // is otherwise unanswerable.
  {
    const cpus = SCANNER_CPUS ?? DEFAULT_CPUS;
    const mem = SCANNER_MEMORY_MB ?? DEFAULT_MEMORY_MB;
    const swap = SCANNER_MEMORY_SWAP_MB === undefined
      ? `swap up to ${mem} MB more (docker default)`
      : SCANNER_MEMORY_SWAP_MB === mem
      ? "swap disabled"
      : `swap capped at ${SCANNER_MEMORY_SWAP_MB - mem} MB`;
    console.log(
      `[boot] scanner caps: ${cpus} cpu / ${mem} MB each, ${swap}` +
        ` x MAX_CONCURRENT_SCANS=${MAX_CONCURRENT}` +
        ` -> up to ${cpus * MAX_CONCURRENT} cpu / ${mem * MAX_CONCURRENT} MB RAM committed`,
    );
  }
  const swept = await controller.sweepOrphans();
  const interrupted = store.markInterrupted(RUNS_ROOT, swept.map(container => container.runId));
  if (interrupted > 0) console.warn(`[boot] marked ${interrupted} interrupted run(s) with errors`);
  if (swept.length > 0) console.warn(`[boot] swept ${swept.length} orphan scanner container(s)`);

  const app = new Hono();
  // Host and Origin checks block DNS rebinding and cross-site writes from a browser.
  // OLA_AGENT_ALLOWED_HOSTS adds names for a server reached by domain, comma-separated.
  const allowedHosts = new Set(["localhost", "127.0.0.1", BIND_HOST.toLowerCase(),
    ...(process.env["OLA_AGENT_ALLOWED_HOSTS"] ?? "").split(",").map(host => host.trim().toLowerCase()).filter(Boolean)])
  const allowedOrigins = new Set((process.env["OLA_AGENT_UI_ORIGINS"] ??
    "http://localhost:32088,http://127.0.0.1:32088").split(",").map(origin => origin.trim()))
  app.use("*", async (c, next) => {
    const host = (c.req.header("Host") ?? new URL(c.req.url).host).toLowerCase().replace(/:\d+$/, "")
    if (!allowedHosts.has(host)) return c.json({ error: "Host is not allowed" }, 403)
    if (c.req.method !== "GET") {
      const origin = c.req.header("Origin")
      if (origin !== undefined && !allowedOrigins.has(origin)) return c.json({ error: "Origin is not allowed" }, 403)
      const contentType = c.req.header("Content-Type")?.split(";", 1)[0].trim().toLowerCase()
      // Empty POSTs from the CLI and session bootstrap have no JSON body.
      if (contentType !== "application/json" && (await c.req.text()).length) {
        return c.json({ error: "Content-Type must be application/json" }, 415)
      }
    }
    await next()
  })
  app.onError((_error, c) => {
    console.error(`[http] ${c.req.method} ${c.req.routePath}: unhandled error`)
    return c.json({ error: "Internal server error" }, 500)
  })

  app.get("/api/health", (c) => c.json({ status: "ok", dev: process.env["OLA_DEV"] === "1" }));

  // sessions
  app.post("/api/sessions", (c) => handleCreateSession(c, { store }));
  app.get("/api/sessions/:id/refresh", (c) => handleRefreshSession(c, { store }));
  app.get("/api/sessions/:id/runs", (c) => handleListRuns(c, { store, runsRootDir: RUNS_ROOT }));

  const envPath = process.env["OLA_AGENT_ENV_PATH"] || join(REPO_ROOT, ".env")
  const getGhToken = async (): Promise<string | undefined> => {
    await reloadKeys(envPath, runDeps)
    return runDeps.ghToken || process.env["GH_TOKEN"]?.trim() || process.env["OLA_AGENT_GH_TOKEN"]?.trim()
  }

  // runs
  const runDeps = {
      store,
      controller,
      bus,
      scannerImage: SCANNER_IMAGE,
      runsRootDir: RUNS_ROOT,
      credentialsHostPath: EFFECTIVE_CREDS_PATH,
      codexAuthHostPath: CODEX_AUTH_PATH,
      antigravityAuthHostPath: ANTIGRAVITY_AUTH_PATH,
      qoderAuthHostPath: QODER_AUTH_PATH,
      ghToken: undefined as string | undefined,
      getGhToken,
      anthropicApiKey: ANTHROPIC_API_KEY,
      anthropicBaseUrl: ANTHROPIC_BASE_URL,
      anthropicAuthToken: ANTHROPIC_AUTH_TOKEN,
      anthropicModel: ANTHROPIC_MODEL,
      openaiApiKey: OPENAI_API_KEY,
      relayBaseUrl: RELAY_BASE_URL,
      relayAuthToken: RELAY_AUTH_TOKEN,
      relayModel: RELAY_MODEL,
      maxConcurrent: MAX_CONCURRENT,
      activeRuns,
      workspacesRoot: WORKSPACES_ROOT,
      workspaceChown: WORKSPACE_CHOWN,
      onTerminal,
      onFixComplete: async (runId: string) => {
        await finishBatch(runDeps, runId)
          .catch((error) => {
            recordBatchError(runDeps, runId, error)
            console.warn(`[pick] ${runId}: batch PR failed: ${error}`)
          })
          // The batch PR step releases its container. A fix run that never reached it has nothing to wait for.
          .finally(() => {
            if (!activeRuns.has(runId)) return;
            const containerId = store.getContainerId(runId);
            if (containerId) controller.stopAndRemove(containerId).catch(() => {});
            activeRuns.delete(runId);
          });
      },
    };
  // Model list for the relay channel's picker. Read-only, ids only.
  app.get("/api/setup", (c) => handleSetup(c, { getGhToken }));
  app.get("/api/providers", (c) => handleProviders(c, { authMode: AUTH_MODE, credentialsHostPath: EFFECTIVE_CREDS_PATH, codexAuthHostPath: CODEX_AUTH_PATH, antigravityAuthHostPath: ANTIGRAVITY_AUTH_PATH, qoderAuthHostPath: QODER_AUTH_PATH, hasApiKey: Boolean(runDeps.anthropicApiKey), hasOpenaiKey: Boolean(runDeps.openaiApiKey) }));
  app.get("/api/relay/models", (c) => handleRelayModels(c, { baseUrl: runDeps.relayBaseUrl, authToken: runDeps.relayAuthToken }));
  app.get("/api/setup/keys", async (c) => {
    const ghToken = await getGhToken()
    return c.json(maskedKeys({ ...runDeps, ghToken }), 200, { "Cache-Control": "no-store" })
  })
  app.put("/api/setup/keys", (c) => {
    if (!c.req.header("Origin")) return c.json({ error: "Origin is required" }, 403)
    return handleSaveKeys(c, envPath, runDeps)
  })
  app.post("/api/runs", (c) => handleStartRun(c, runDeps));
  setKnownRepos(() => store.listRepos().map((r) => r.repo));
  app.get("/api/trackers", (c) => handleTrackers(c));
  app.get("/api/repos", (c) => handleListRepos(c, { store }));
  app.post("/api/repos", (c) => handleAddRepo(c, { store }));
  app.post("/api/repos/detect", (c) => handleDetectProfile(c, { store, getGhToken }));
  app.get("/api/repos/language", (c) => handleRepoLanguage(c, { getGhToken }));
  app.delete("/api/repos", (c) => handleRemoveRepo(c, { store }));
  app.put("/api/repos/profile", (c) => handleSetProfile(c, { store }));
  app.get("/api/pick", (c) => handlePick(c, runDeps));
  app.post("/api/pick", (c) => handlePick(c, runDeps, true));
  app.get("/api/overview", (c) => handleOverview(c, runDeps));
  app.get("/api/overview/prs/:number", (c) => handleReadPR(c, undefined, getGhToken));
  app.post("/api/overview/prs/:number/close", (c) => handleClosePR(c, runDeps));
  app.post("/api/pick/ignore", (c) => handleRowChange(c, runDeps, "ignore"));
  app.post("/api/pick/needs-human", (c) => handleRowChange(c, runDeps, "needs-human"))
  app.post("/api/pick/reopen", (c) => handleRowChange(c, runDeps, "reopen"));
  app.get("/api/runs", (c) => handleListAllRuns(c, { store, runsRootDir: RUNS_ROOT }));
  app.get("/api/runs/active", (c) => handleActiveRuns(c, { store, activeRuns }));
  app.patch("/api/runs/:id", (c) => handleStarRun(c, { store }));
  app.get("/api/runs/:id", (c) => handleGetRun(c, { store, runsRootDir: RUNS_ROOT }));
  app.get("/api/runs/:id/events", (c) => handleRunEvents(c, { bus, store, runsRootDir: RUNS_ROOT, activeRuns }));
  app.get("/api/runs/:id/artifacts/:kind", (c) => handleRunArtifact(c, { runsRootDir: RUNS_ROOT }));
  app.get("/api/runs/:id/findings", (c) => handleListFindings(c, { store }));
  app.get("/api/runs/:id/post", (c) => handlePostPreview(c, { store, getGhToken }));
  app.post("/api/runs/:id/post", (c) => handlePostFindings(c, { store, getGhToken }));

  // push fix commits to a new branch inside the kept-alive container
  app.post("/api/runs/:id/resume", (c) => handleResumeRun(c, runDeps));
  app.post("/api/runs/:id/pause", (c) => handlePauseRun(c, { store, activeRuns }));
  app.post("/api/runs/:id/stop", (c) => handleStopRun(c, { store, activeRuns }));

  return app;
}

if (import.meta.main) {
  const app = await buildApp();
  const port = parseInt(process.env["OLA_AGENT_PORT"] || "37018", 10);
  console.log(`[ola-agent] backend listening on http://${BIND_HOST}:${port}`)
  Bun.serve({ hostname: BIND_HOST, port, fetch: app.fetch, idleTimeout: 0 })
}
