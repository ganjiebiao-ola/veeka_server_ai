// ScannerRun — owns one scan from `docker run` through artifact export.
//
// Responsibilities:
//   1. Ask DockerController for a scanner handle.
//   2. Consume the bridge's stdout JSONL stream, translate each frame into
//      one or more SSE events on the bus.
//   3. Track usage, persist to Store.
//   4. On run_finished / scanner_failed → mark the DB row.
//
// One ScannerRun per active scan; held alive by SessionManager.

import { appendArtifact, removeArtifact, writeArtifact } from "./artifact_fs.ts";
import { SECRET_ENV } from "../docker/controller.ts";
import type { DockerController, RunScannerArgs, ScannerHandle } from "../docker/controller.ts";
import type { RunEventBus } from "../events/bus.ts";
import { SdkMapper } from "../events/sdk_mapper.ts";
import { decodeJsonlStream } from "../sdk_bridge/jsonl_decoder.ts";
import { UsageAggregator } from "../sdk_bridge/usage_aggregator.ts";
import { importFindings } from "./findings.ts";
import { importVendor } from "./vendor.ts"
import { importAuth } from "./auth.ts"
import { importProfile } from "./profile.ts"
import { REVIEW_STARTED } from "../events/replay.ts";
import { scrub } from "../tracker/scrub.ts";
import type { Store } from "../store/repo.ts";
import type { Finding, RunEvent, UsagePhase } from "../../shared/types.ts";

export type PushResult = { ok: boolean; sha?: string; branch?: string; error?: string; pending?: boolean };

export interface ScannerRunDeps {
  controller: DockerController;
  bus: RunEventBus;
  store: Store;
  // Fired when the run reaches a terminal state. server.ts uses it to free
  // per-run memory (bus buffers, activeRuns entry) once the TTL window — the
  // same lifetime the reaper applies to the DB row — has lapsed.
  onTerminal?: (runId: string) => void;
  onFixComplete?: (runId: string) => void | Promise<void>
}

export class ScannerRun {
  private handle: ScannerHandle | null = null;
  private mapper: SdkMapper;
  private usage = new UsageAggregator();
  private phaseUsage: Partial<Record<UsagePhase, UsageAggregator>> = {};
  private pendingPush: { resolve: (r: PushResult) => void } | null = null;
  private killTimer?: ReturnType<typeof setTimeout>;
  private timeoutMs = 0;
  private timedOut = false;
  private stopped = false;
  private artifactsDir?: string;

  constructor(
    private readonly runId: string,
    private readonly deps: ScannerRunDeps,
  ) {
    this.mapper = new SdkMapper();
  }

  async start(args: RunScannerArgs & { timeoutMs?: number }): Promise<void> {
    this.artifactsDir = args.artifactsHostDir;
    this.handle = this.deps.controller.runScanner(args);

    // Hard per-run deadline (generic headless runs). Graceful stop so the
    // entrypoint's chown-on-exit trap still runs; --rm cleans the container.
    if (args.timeoutMs && args.timeoutMs > 0) {
      this.timeoutMs = args.timeoutMs;
      this.killTimer = setTimeout(() => {
        this.timedOut = true;
        void this.deps.controller.stopGraceful(this.handle!.containerName);
      }, args.timeoutMs);
    }

    // The run stays "queued" until the container reports that it began to clone.
    this.deps.store.updateRunStatus(this.runId, "queued", { containerId: this.handle.containerName });
    this.publish({ type: "run_status", status: "queued" });
    this.publish({ type: "step_started", step: "prepare" });

    // Kick off stderr drainer (diag only — never blocks main flow).
    const secrets = Object.entries(args.env).filter(([k, v]) => SECRET_ENV.test(k) && v).map(([, v]) => String(v));
    void this.drainStderr(this.handle.stderr, secrets);

    // Consume stdout — this is the long-running loop.
    void this.consumeStdout(this.handle.stdout);

    // Wait for process exit in background; clean up when done.
    void this.handle.process.exited.then((status) => this.onExit(status));
  }

  async pause(): Promise<void> {
    if (!this.handle) throw new Error("scanner container is gone");
    await this.handle.stdin.write(new TextEncoder().encode(JSON.stringify({ type: "pause" }) + "\n"));
  }

  // Record the end before stopping the container, preserving any existing terminal state.
  async stop(): Promise<void> {
    if (!this.handle) return;
    this.stopped = true;
    if (this.killTimer !== undefined) clearTimeout(this.killTimer);
    const current = this.deps.store.getRun(this.runId)
    const aborting = !current || !["failed", "completed", "aborted", "stopped"].includes(current.status)
    if (aborting) {
      const error = "stopped by user"
      this.deps.store.updateRunStatus(this.runId, "aborted", { error })
      this.publish({ type: "run_status", status: "aborted", error })
      this.publish({ type: "run_finished", status: "aborted", error })
    }
    await this.deps.controller.stopGraceful(this.handle.containerName);
    // A pause checkpoint can finish before run_stopped arrives. Stop ends the run for good.
    if (aborting && this.artifactsDir) { try { removeArtifact(this.artifactsDir, "checkpoint.json") } catch {} }
  }

  // Trigger a git push inside the (kept-alive) container. Writes {type:"push"}
  // to the bridge stdin and resolves when the matching push_result frame
  // arrives, or times out. One push at a time per run.
  pushToBranch(branch: string, timeoutMs = 5 * 60_000): Promise<PushResult> {
    if (this.pendingPush) return Promise.resolve({ ok: false, error: "push already in progress" })
    return new Promise<PushResult>((resolve) => {
      if (!this.handle) {
        resolve({ ok: false, error: "scanner container is gone — download the patch instead" });
        return;
      }
      const pending = { resolve: (result: PushResult) => {
        if (this.pendingPush !== pending) return
        this.pendingPush = null
        clearTimeout(timer)
        resolve(result)
      } }
      const timer = setTimeout(() => pending.resolve({ ok: false,
        error: `push result not received after ${Math.round(timeoutMs / 1000)}s — remote branch ${branch} may exist, check before retrying`, pending: true }), timeoutMs)
      this.pendingPush = pending
      const line = JSON.stringify({ type: "push", branch }) + "\n";
      this.handle.stdin.write(new TextEncoder().encode(line)).catch(() => {
        pending.resolve({ ok: false, error: "stdin closed" })
      });
    });
  }

  // stderr goes to the backend log and to artifacts/stderr.log, so it outlives the container.
  // Whole lines only: a token split across two chunks would slip past the scrub.
  private async drainStderr(stream: ReadableStream<Uint8Array>, secrets: string[] = []): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let rest = "";
    const write = async (text: string) => {
      if (!text.trim()) return;
      const clean = scrub(text, secrets)[0];
      console.error(`[scanner ${this.runId}]`, clean.trimEnd());
      if (this.artifactsDir) { try { appendArtifact(this.artifactsDir, "stderr.log", clean.endsWith("\n") ? clean : clean + "\n") } catch {} }
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = rest + decoder.decode(value, { stream: true });
        // A line with no newline past 64 KB is flushed as is, so the buffer stays bounded.
        const cut = text.length > 65_536 ? text.length : text.lastIndexOf("\n") + 1;
        rest = text.slice(cut);
        await write(text.slice(0, cut));
      }
      await write(rest + decoder.decode());
    } finally {
      reader.releaseLock();
    }
  }

  private async consumeStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
    try {
      for await (const evt of decodeJsonlStream(stream)) {
        // One bad event must not stop the reader. A stopped reader fills the pipe and the container blocks.
        try { this.handleBridgeEvent(evt); }
        catch (e) { console.error(`[scanner ${this.runId}] bridge event error:`, e); }
      }
    } catch (e) {
      console.error(`[scanner ${this.runId}] stdout loop error:`, e);
    }
  }

  private handleBridgeEvent(evt: unknown): void {
    // After a user stop, late output from the dying container must not change the run's end state.
    if (this.stopped) return;
    const e = evt as Record<string, unknown>;
    switch (e.kind) {
      case "scanner_status": {
        const status = String(e.status);
        if (status === "cloning") {
          this.deps.store.updateRunStatus(this.runId, "cloning");
          this.publish({ type: "run_status", status: "cloning" });
          this.publish({ type: "step_completed", step: "prepare", status: "completed" });
          this.publish({ type: "step_started", step: "ingest" });
        } else if (status === "scanning") {
          this.deps.store.updateRunStatus(this.runId, "scanning");
          this.publish({ type: "run_status", status: "scanning" });
          this.publish({ type: "step_started", step: "scan" });
        }
        break;
      }
      case "clone_done": {
        this.publish({ type: "step_completed", step: "prepare", status: "completed" });
        this.publish({ type: "step_completed", step: "ingest", status: "completed" });
        break;
      }
      case "scanner_failed": {
        const error = String(e.error ?? "scanner reported failure");
        this.deps.store.updateRunStatus(this.runId, "failed", { error });
        this.publish({ type: "run_status", status: "failed", error });
        this.publish({ type: "run_finished", status: "failed", error });
        break;
      }
      case "sdk_message": {
        const msg = e.message;
        // An older scanner image sends no ts. Then the arrival time stands in.
        for (const out of this.mapper.map(msg, typeof e.ts === "number" ? e.ts : Date.now())) {
          if (out.type === "usage_delta") {
            this.usage.add(out.usage);
            this.deps.store.addUsage(this.runId, out.usage);
            if (e.phase === "fix" || e.phase === "review" || e.phase === "checks") {
              out.phase = e.phase;
              (this.phaseUsage[e.phase] ??= new UsageAggregator()).add(out.usage);
            }
            if (this.artifactsDir) writeArtifact(this.artifactsDir, "usage.json", JSON.stringify({
              usage: this.usage.snapshot(),
              phaseUsage: Object.fromEntries(Object.entries(this.phaseUsage).map(([phase, usage]) => [phase, usage.snapshot()])),
            }));
          }
          this.publish(out);
        }
        break;
      }
      case "phase": {
        if (e.phase === "review" || e.phase === "checks") {
          this.deps.store.setRunPhase(this.runId, e.phase);
          this.publish({ type: "run_phase", phase: e.phase });
        }
        for (const event of REVIEW_STARTED) this.publish(event);
        break;
      }
      case "run_stopped": {
        // The bridge saved checkpoint.json. The run waits for Resume.
        this.saveFindings();
        const reason = e.reason === "pause" ? "user pause" : "quota";
        this.deps.store.updateRunStatus(this.runId, "stopped", { error: `stopped at ${reason}`, stopReason: e.reason === "pause" ? "user_pause" : "quota" });
        this.publish({ type: "run_status", status: "stopped" });
        this.publish({ type: "run_finished", status: "stopped", error: `stopped at ${reason}` });
        break;
      }

      case "run_finished": {
        this.saveFindings();
        // The scanner process exit hook handles terminal status + TTL. We
        // mark the scan + report phases done here so the checklist fills
        // to 100% on both scan and fix flows. fix/commit are closed
        // out here if the L1 heuristic in SdkMapper flagged them open.
        this.publish({ type: "step_completed", step: "scan", status: "completed" });
        if (this.mapper.hasFixStarted() && !this.mapper.hasCommitStarted()) {
          this.publish({ type: "step_completed", step: "fix", status: "completed" });
        }
        if (this.mapper.hasCommitStarted()) {
          this.publish({ type: "step_completed", step: "commit", status: "completed" });
        }
        this.publish({ type: "step_started", step: "report" });
        this.publish({ type: "step_completed", step: "report", status: "completed" });

        // Container stays alive in fix mode (push-wait daemon) until the batch PR
        // step releases it, so onExit does not fire at scan end. Mark terminal
        // now. onExit's alreadyTerminal guard prevents a double-mark when the
        // container exits.
        {
          const run = this.deps.store.getRun(this.runId);
          if (!run || !["failed", "completed", "aborted", "stopped"].includes(run.status)) {
            this.deps.store.updateRunStatus(this.runId, "completed");
            const finish = () => {
              const error = this.deps.store.getRun(this.runId)?.error
              this.publish({ type: "run_status", status: "completed", ...(error ? { error } : {}) })
              this.publish({ type: "run_finished", status: "completed", ...(error ? { error } : {}) })
            }
            if (run?.mode === "fix" && this.deps.onFixComplete) {
              // Clients close on completion, so deliver the PR result first.
              void Promise.resolve().then(() => this.deps.onFixComplete!(this.runId)).catch(error => {
                const message = error instanceof Error ? error.message : String(error)
                this.deps.store.updateRunStatus(this.runId, "completed", { error: message })
                this.publish({ type: "push_result", ok: false, error: message })
              }).finally(finish)
            } else finish()
          }
        }
        break;
      }

      case "push_result": {
        const result: PushResult = {
          ok: Boolean(e.ok),
          sha: typeof e.sha === "string" && /^[a-f0-9]{40}$/.test(e.sha) ? e.sha : undefined,
          branch: e.branch ? String(e.branch) : undefined,
          error: e.error ? String(e.error) : undefined,
        };
        this.publish({ type: "push_result", ok: result.ok, branch: result.branch, error: result.error });
        this.pendingPush?.resolve(result)
        break;
      }

      case "round_started": {
        const round = Number(e.round ?? 1);
        this.deps.store.updateRunStatus(this.runId, "scanning");
        this.publish({ type: "run_status", status: "scanning" });
        this.publish({ type: "round_started", round });
        // Mark scan as in_progress whenever a query() round begins. For
        // round 1 this is the first time; for round 2+ it regresses from
        // the previous round's completed state.
        this.publish({ type: "step_started", step: "scan" });
        break;
      }
    }
  }

  private async onExit(code: number): Promise<void> {
    if (this.killTimer !== undefined) clearTimeout(this.killTimer);
    this.handle = null
    this.pendingPush?.resolve({ ok: false, error: `scanner exited with code ${code} before reporting the push result — check the remote branch before retrying` })

    const current = this.deps.store.getRun(this.runId);
    const alreadyTerminal = current && ["failed", "completed", "aborted", "stopped"].includes(current.status);
    if (!alreadyTerminal || current.status === "failed") this.saveFindings();
    if (alreadyTerminal) {
      this.deps.onTerminal?.(this.runId);
      return;
    }

    if (this.timedOut) {
      // Timeout takes precedence over the generic exit-code message — the
      // non-zero code is just the consequence of our own `docker stop`.
      const err = `timeout after ${Math.round(this.timeoutMs / 1000)}s`;
      this.deps.store.updateRunStatus(this.runId, "failed", { error: err });
      this.publish({ type: "run_status", status: "failed", error: err });
      this.publish({ type: "run_finished", status: "failed", error: err });
    } else if (code === 0) {
      this.deps.store.updateRunStatus(this.runId, "completed");
      this.publish({ type: "run_status", status: "completed" });
      this.publish({ type: "run_finished", status: "completed" });
    } else {
      const err = `scanner exited with code ${code}`;
      this.deps.store.updateRunStatus(this.runId, "failed", { error: err });
      this.publish({ type: "run_status", status: "failed", error: err });
      this.publish({ type: "run_finished", status: "failed", error: err });
    }
    this.deps.onTerminal?.(this.runId);
  }

  // Findings stay local. The dev posts them to GitHub from the Run tab.
  private saveFindings(): void {
    if (this.artifactsDir) {
      const run = this.deps.store.getRun(this.runId)
      const store = run?.mode === "scan" ? {
        insertFinding: (runId: string, finding: Finding) => {
          if (!run.includeP2 && finding.severity === "P2") return
          this.deps.store.insertFinding(runId, { ...finding, fixSummary: "",
            reason: finding.reason?.split(/\r?\n/).filter(line => !/^\s*Fix:/i.test(line)).join("\n") })
        },
        saveVendor: this.deps.store.saveVendor.bind(this.deps.store),
      } : this.deps.store
      importFindings(this.runId, this.artifactsDir, store)
      if (this.deps.store.getRun(this.runId)?.mode === "scan") {
        const run = this.deps.store.getRun(this.runId)
        importVendor(this.runId, this.artifactsDir, store, run?.repoUrl, undefined, Boolean(run?.categories?.length))
        importProfile(this.runId, this.artifactsDir, this.deps.store, this.deps.store.getRun(this.runId)?.repoUrl)
        importAuth(this.runId, this.artifactsDir, this.deps.store.getRun(this.runId)?.repoUrl)
      }
    }
  }

  private publish(ev: RunEvent): void {
    // Stamp step starts here, so the UI can show elapsed time even after a page reload.
    if (ev.type === "step_started" && ev.ts === undefined) ev = { ...ev, ts: Date.now() };
    this.deps.bus.publish(this.runId, ev);
  }
}
