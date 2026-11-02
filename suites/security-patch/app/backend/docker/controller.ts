// DockerController — owns scanner container lifecycle.
//
// Each scan starts a sibling container via host docker.sock. The container
// streams JSONL on stdout; we attach to stdin/stdout via `docker run -i`
// piped through `Bun.spawn`.
//
// We hold the underlying Process for as long as the run is live so callers
// can write push and shutdown commands to stdin and read events from stdout.

import { writeArtifact } from "../orchestrator/artifact_fs.ts";
import { fileURLToPath } from "node:url";
import { scrub } from "../tracker/scrub.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { tmpdir } from "node:os"

export interface ScannerEnv {
  OUTPUT_LANGUAGE?: "en" | "zh"
  RUN_ID: string;
  PROVIDER?: string
  REVIEW_PROVIDER?: string
  REVIEW_MODEL?: string
  REVIEW_EFFORT?: string
  PROVIDER_COMMAND?: string
  REVIEW_PROVIDER_COMMAND?: string
  SMOKE_SECONDS?: string
  CODEX_HOME?: string       // set with the Codex auth mount
  // Skill-run fields — absent on generic workspace runs (LOCAL_WORKSPACE=1).
  REPO_URL?: string;
  BRANCH?: string;
  COMMIT_SHA?: string;
  SKILL?: string;
  PICKED_IDS?: string;
  PICKED_FILE?: string;
  MAX_CHANGED_LINES?: string; // batch line limit for the fix agent
  RESUME_DONE?: string;       // comma-joined picked ids the checkpoint marks done
  RESUME_BUNDLE?: string;     // git bundle of the stopped run's commits
  CATEGORIES?: string;        // comma-joined vuln-category tokens for scoped scan (ola-security-audit only)
  PROFILE_OVERRIDE?: string;  // scan only: JSON {php, framework} the operator set on the Scan page
  REPO_PHP?: string;          // fix only: the Scan page PHP version, override first. vendor-upgrade.mjs reads it
  INCLUDE_P2?: string;
  MAX_SUBAGENTS?: string;     // Scan cap, 0-3. The bridge blocks Agent and Task past it
  MODEL: string;
  EFFORT: string;
  MODE: string;
  // Generic headless-run flags (set by handlers/runs.ts only for prompt-mode
  // runs). The entrypoint/bridge treat absence as "product behavior unchanged".
  LOCAL_WORKSPACE?: string;   // "1" → /workspace/repo is a bind mount, skip clone
  PROMPT_FILE?: string;       // container path holding the raw task prompt
  EVENTS_LOG?: string;        // "1" → bridge appends every frame to artifacts/events.jsonl
  WORKSPACE_CHOWN?: string;   // "uid:gid" → entrypoint chowns the workspace on exit
  GH_TOKEN?: string;
  // Claude provider auth. In "settings" mode (cc-switch follow) these are
  // sourced from the host ~/.claude/settings.json env block and injected as
  // env vars; the Agent SDK / claude CLI read them directly. ANTHROPIC_API_KEY
  // is the official key; ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL target a
  // relay/3rd-party endpoint; ANTHROPIC_MODEL optionally overrides the model.
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
  ANTHROPIC_MODEL?: string;
  // Codex API-key runs only. The scanner hands it to Codex as CODEX_API_KEY and never to the agent's commands.
  OPENAI_API_KEY?: string;
}

export interface RunScannerArgs {
  runId: string;
  image: string;
  env: ScannerEnv;
  artifactsHostDir: string;        // host path mounted to /workspace/artifacts
  workspaceHostDir?: string;       // host dir mounted RW to /workspace/repo (generic runs; clone skipped)
  credentialsHostPath?: string;    // host file mounted RO to /root/.claude/.credentials.json
  codexAuthHostPath?: string;      // host file mounted RW (Codex refreshes tokens) to /root/.codex/auth.json
  qoderAuthHostPath?: string;      // host dir mounted RW (the user token refreshes) to /root/.qoder/.auth
  antigravityAuthHostPath?: string; // host file mounted RW to /root/.gemini/antigravity-cli/antigravity-oauth-token
  relatedHostDirs?: { id: string, dir: string }[]; // host repos mounted RO to /workspace/related/<id> for caller search
  // Per-run overrides. No caller sets these today (the HTTP API exposes no
  // such field), so in practice the deployment-wide defaults below apply.
  cpus?: number;
  memoryMb?: number;
  memorySwapMb?: number;
}

export interface ScannerHandle {
  containerName: string;
  process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  stdin: WritableStreamDefaultWriter<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
}

// Env names that hold a credential. run-info.json keeps the name and drops the value.
export const SECRET_ENV = /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL/i;
let appCommit: string | undefined;

// run-info.json: what this container ran with, kept so a past run can be diagnosed after
// `--rm` removes the container. Best effort: a failed write never blocks the run.
function writeRunInfo(args: RunScannerArgs, resources: { cpus: number; memoryMb: number; memorySwapMb?: number }): void {
  const out = (cmd: string[]) => {
    try {
      const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore" });
      return r.exitCode === 0 ? r.stdout.toString().trim() : undefined;
    } catch { return undefined; }
  };
  appCommit ??= out(["git", "-C", fileURLToPath(new URL(".", import.meta.url)), "rev-parse", "HEAD"]) ?? "";
  const secrets: string[] = [];
  const env = Object.fromEntries(Object.entries(args.env).filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => SECRET_ENV.test(k) ? (secrets.push(String(v)), [k, "<set>"]) : [k, v]));
  const info = {
    image: args.image,
    imageId: out(["docker", "image", "inspect", "--format", "{{.Id}}", args.image]),
    appCommit: appCommit || undefined,
    startedAt: new Date().toISOString(),
    resources,
    mounts: {
      credentials: Boolean(args.credentialsHostPath), codexAuth: Boolean(args.codexAuthHostPath),
      antigravityAuth: Boolean(args.antigravityAuthHostPath), qoderAuth: Boolean(args.qoderAuthHostPath),
      workspace: Boolean(args.workspaceHostDir),
    },
    env,
  };
  try {
    writeArtifact(args.artifactsHostDir, "run-info.json", scrub(JSON.stringify(info, null, 2), secrets)[0] + "\n");
  } catch (e) {
    console.warn(`[scanner ${args.runId}] could not write run-info.json: ${(e as Error).message}`);
  }
}

const CONTAINER_NAME_PREFIX = "ola-agent-scanner-";

// The single source of truth for scanner resource caps. These are the values
// that used to be hard-coded inline below, so a deployment that configures
// nothing behaves exactly as before. cli/server.ts passes `undefined` when the
// corresponding env var is unset, which lands back here via `??`.
export const DEFAULT_CPUS = 2;
export const DEFAULT_MEMORY_MB = 4096;

export interface DockerControllerOpts {
  // Deployment-wide caps for each scanner container. Wired from
  // OLA_AGENT_SCANNER_CPUS / _MEMORY_MB / _MEMORY_SWAP_MB in cli/server.ts.
  defaultCpus?: number;
  defaultMemoryMb?: number;
  // Undefined means "do not pass --memory-swap at all", which is docker's
  // historical behavior here. See the note where the flag is emitted.
  defaultMemorySwapMb?: number;
}

// Parse one of the resource env vars.
//
// Returns undefined for "unset / not usable", so the caller falls back to the
// constant above. Rejecting is deliberately strict because docker fails in two
// opposite and equally quiet ways:
//
//   · too small — `parseInt("2g")` is 2, i.e. a 2 MB cap. docker refuses
//     ("Minimum memory limit allowed is 6MB") and EVERY scan dies, but the
//     failure only reaches the backend log via drainStderr; the run record just
//     shows `scanner exited with code 125`. Writing `2g` is the natural typo
//     here, since the neighbouring compose/env values use `g` suffixes.
//   · too large — `--memory 99999999m` is accepted and yields a ~95 TB cap,
//     i.e. no cap at all. One misplaced digit silently removes the very limit
//     this knob exists to impose, and nothing logs it.
//
// So: only a plain number is accepted, it must sit inside a sane range, and
// anything else warns loudly and falls back instead of reaching `docker run`.
export function parseResourceEnv(
  name: string,
  raw: string | undefined,
  opts: { min: number; max: number; integer: boolean },
): number | undefined {
  const s = (raw ?? "").trim();
  if (s === "") return undefined;
  const shape = opts.integer ? /^\d+$/ : /^\d+(\.\d+)?$/;
  if (!shape.test(s)) {
    console.warn(
      `[config] ${name}="${s}" is not a plain ${opts.integer ? "integer" : "number"} ` +
        `(no units or suffixes — memory is already in MB); ignoring it and using the default`,
    );
    return undefined;
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n < opts.min || n > opts.max) {
    console.warn(
      `[config] ${name}=${s} is outside the accepted range [${opts.min}, ${opts.max}]; ` +
        `ignoring it and using the default`,
    );
    return undefined;
  }
  return n;
}

export class DockerController {
  // Not `private`: private members make the class nominally typed, which would
  // silently break structural mocks passed as BuildAppDeps.controller.
  readonly defaultCpus: number;
  readonly defaultMemoryMb: number;
  readonly defaultMemorySwapMb?: number;

  constructor(opts: DockerControllerOpts = {}) {
    this.defaultCpus = opts.defaultCpus ?? DEFAULT_CPUS;
    this.defaultMemoryMb = opts.defaultMemoryMb ?? DEFAULT_MEMORY_MB;
    this.defaultMemorySwapMb = opts.defaultMemorySwapMb;
  }

  // Start a scanner container in the foreground (we keep the Bun.spawn
  // process bound so we can write to stdin and read stdout interactively).
  runScanner(args: RunScannerArgs): ScannerHandle {
    for (const related of args.relatedHostDirs ?? []) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(related.id)) {
        throw new Error("invalid related repo id")
      }
    }
    // Docker's -v grammar treats colons as separators and relative paths as named volumes.
    for (const path of [args.artifactsHostDir, args.workspaceHostDir, args.credentialsHostPath,
      args.codexAuthHostPath, args.antigravityAuthHostPath, args.qoderAuthHostPath, ...(args.relatedHostDirs ?? []).map(repo => repo.dir)]) {
      if (path !== undefined && (!isAbsolute(path) || /[:\0]/.test(path))) throw new Error("invalid bind mount path")
    }
    const name = `${CONTAINER_NAME_PREFIX}${args.runId}`;

    const dockerArgs: string[] = [
      "run",
      "-i",                  // keep stdin open
      "--rm",
      "--name", name,
      "--label", "ola-agent=true",
      "--label", `ola-agent-run=${args.runId}`,
      "--cpus", String(args.cpus ?? this.defaultCpus),
      "--memory", `${args.memoryMb ?? this.defaultMemoryMb}m`,
      "--pids-limit", "512",
      "--network", "bridge",
    ];

    if (args.env.PROVIDER === "codex" || (args.env.MODE === "fix" && args.env.REVIEW_PROVIDER === "codex")) {
      // Bubblewrap needs user namespaces and mounts, without adding container capabilities.
      // ponytail: pinned Moby seccomp snapshot, refresh when Docker's security policy changes.
      dockerArgs.push("--security-opt", `seccomp=${fileURLToPath(new URL("./codex-seccomp.json", import.meta.url))}`);
    }

    // --memory on its own is only half a cap: when --memory-swap is omitted,
    // docker sets it to 2 x --memory, so the container can still consume an
    // equal amount of swap on top of its RAM allowance. On a small host that
    // is the path to a swap-thrash freeze rather than a clean OOM kill --
    // the kernel keeps reclaiming instead of declaring OOM, and nothing gets
    // killed. Setting the two equal disables swap for the container, which is
    // the same trick this project's compose services use (memswap_limit ==
    // mem_limit). Left unset here so the default stays byte-identical.
    const swapMb = args.memorySwapMb ?? this.defaultMemorySwapMb;
    if (swapMb !== undefined) {
      dockerArgs.push("--memory-swap", `${swapMb}m`);
    }

    // Bind host artifacts dir so backend can read patch/report after exit
    // even if container is gone (--rm).
    dockerArgs.push("-v", `${args.artifactsHostDir}:/workspace/artifacts`);

    // Generic workspace runs: mount the caller's host dir as the repo. RW —
    // the agent's job is to edit these files in place.
    if (args.workspaceHostDir) {
      dockerArgs.push("-v", `${args.workspaceHostDir}:/workspace/repo`);
    }

    // Related repos for caller search (SKILL §0.6). Read-only: the agent only searches them.
    for (const related of args.relatedHostDirs ?? []) {
      dockerArgs.push("-v", `${related.dir}:/workspace/related/${related.id}:ro`);
    }

    // OAuth credentials (PaceClaw-style export). Read-only.
    if (args.credentialsHostPath) {
      dockerArgs.push("-v", `${args.credentialsHostPath}:/root/.claude/.credentials.json:ro`);
    }

    // Codex ChatGPT-subscription login. Only runs that use Codex get it.
    if (args.codexAuthHostPath) {
      dockerArgs.push("-v", `${args.codexAuthHostPath}:/root/.codex/auth.json`);
    }

    // Qoder login directory. Only runs that use Qoder get it.
    if (args.qoderAuthHostPath) {
      dockerArgs.push("-v", `${args.qoderAuthHostPath}:/root/.qoder/.auth`);
    }
    // Antigravity login. Only runs that use Antigravity get it.
    if (args.antigravityAuthHostPath) {
      dockerArgs.push("-v", `${args.antigravityAuthHostPath}:/root/.gemini/antigravity-cli/antigravity-oauth-token`);
    }

    // Docker reads values from its environment so secrets stay out of argv.
    const env = { ...process.env }
    for (const [k, v] of Object.entries(args.env)) {
      if (v === undefined || v === null || v === "") continue;
      dockerArgs.push("-e", k);
      env[k] = v
    }

    dockerArgs.push(args.image);
    writeRunInfo(args, { cpus: args.cpus ?? this.defaultCpus, memoryMb: args.memoryMb ?? this.defaultMemoryMb, memorySwapMb: swapMb });

    // Keep the CID outside scanner-writable mounts and never remove a container by a reused name.
    const cidDir = mkdtempSync(join(tmpdir(), "ola-scanner-cid-"))
    const cidPath = join(cidDir, "cid")
    dockerArgs.splice(1, 0, "--cidfile", cidPath)
    let proc: ScannerHandle["process"]
    try {
      proc = Bun.spawn(["docker", ...dockerArgs], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    } catch (error) {
      rmSync(cidDir, { recursive: true, force: true })
      throw error
    }
    const cleanup = async (code: number) => {
      let id = ""
      try { if (code !== 0) id = readFileSync(cidPath, "utf8").trim() } catch { /* No container was created. */ }
      finally { rmSync(cidDir, { recursive: true, force: true }) }
      if (/^[a-f0-9]{64}$/.test(id)) await this.stopAndRemove(id)
    }
    void proc.exited.then(cleanup, () => cleanup(1)).catch(() => {})
    return {
      containerName: name,
      process: proc,
      stdin: new WritableStream<Uint8Array>({
        async write(chunk) {
          proc.stdin.write(chunk)
          await proc.stdin.flush()
        },
        close() { proc.stdin.end() },
      }).getWriter(),
      stdout: proc.stdout,
      stderr: proc.stderr,
    };
  }

  // SIGTERM → grace window → SIGKILL. Used by the run timeout so the
  // entrypoint's chown-on-exit trap gets a chance to run; `--rm` removes the
  // container once stopped. Removal also grants this window so live
  // scanners can export artifacts during cancellation or orphan sweeps.
  async stopGraceful(containerNameOrId: string, graceSeconds = 5): Promise<void> {
    try {
      await Bun.spawn(["docker", "stop", "-t", String(graceSeconds), containerNameOrId], { env: process.env,
        stdout: "ignore", stderr: "ignore",
      }).exited
    } catch { /* The container may already have stopped. */ }
  }

  async stopAndRemove(containerNameOrId: string): Promise<void> {
    await this.stopGraceful(containerNameOrId);
    try {
      await Bun.spawn(["docker", "rm", "-f", containerNameOrId], { env: process.env,
        stdout: "ignore", stderr: "ignore",
      }).exited
    } catch { /* The container may already have been removed. */ }
  }

  // Sweep ALL ola-agent labeled containers — used on backend boot to clean
  // orphans from a crashed prior process.
  async sweepOrphans(): Promise<{ id: string, runId: string }[]> {
    const p = Bun.spawn(["docker", "ps", "-aq", "--filter", "label=ola-agent=true", "--format", '{{.ID}} {{.State}} {{.Label "ola-agent-run"}}'], { env: process.env,
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(p.stdout).text()
    if (await p.exited !== 0) return [];
    const containers = output.split("\n").map(s => s.trim()).filter(Boolean).map(line => {
      const [id, state, runId] = line.split(/\s+/)
      return { id: id!, runId: state === "running" ? runId ?? "" : "" }
    })
    for (const { id } of containers) {
      await this.stopAndRemove(id);
    }
    return containers;
  }
}
