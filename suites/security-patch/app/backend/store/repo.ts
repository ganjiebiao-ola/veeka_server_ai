import type { VendorData } from "../../shared/vendor.ts"
import type { ProfileOverride, RepoProfile } from "../../shared/types.ts"
import { githubRepo } from "../tracker/repos.ts";
import { existsSync } from "node:fs"
import { Database } from "bun:sqlite";
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { mkdir, readFile } from "node:fs/promises"
import type {
  AuthMode,
  Effort,
  ProviderId,
  Finding,
  RunMode,
  RunStatus,
  RunSummary,
  UsageDelta,
} from "../../shared/types.ts";

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");

export interface CreateRunArgs {
  provider?: ProviderId
  reviewProvider?: ProviderId
  reviewModel?: string
  reviewEffort?: Effort
  authMode?: AuthMode
  runId: string;
  sessionId: string;
  repoUrl: string;
  branch: string;
  skill: string;   // SkillName, or "generic" for prompt-mode runs
  model: string;   // ModelId alias or raw model id — validated by the handler
  effort: Effort;
  mode: RunMode;
  commitSha?: string;
  categories?: string;  // comma-joined scoped-scan tokens; "" = full scan
  includeP2?: boolean;
  maxSubagents?: number;  // Scan runs only
  language?: "en" | "zh"
  resumedFrom?: string;   // the stopped run this run resumes
}

export class Store {
  private db: Database;
  private starting = 0

  constructor(dbPath: string) {
    // Bun returns epoch-millisecond integers as numbers without 32-bit truncation.
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
  }

  static async open(dbPath: string): Promise<Store> {
    await mkdir(dirname(dbPath), { recursive: true });
    const store = new Store(dbPath);
    const schema = await readFile(SCHEMA_PATH, "utf8");
    store.db.exec(schema);
    store.db.transaction(() => {
      const columns = store.db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>
      if (!columns.some(c => c.name === "run_number")) {
        store.db.exec(`ALTER TABLE runs ADD COLUMN run_number INTEGER CHECK (run_number > 0);
          WITH numbered AS (
            SELECT id, ROW_NUMBER() OVER (ORDER BY started_at ASC, id ASC) AS number FROM runs
          )
          UPDATE runs SET run_number = (SELECT number FROM numbered WHERE numbered.id = runs.id);`)
      }
      for (const [name, definition] of [["starred", "INTEGER NOT NULL DEFAULT 0"], ["stop_reason", "TEXT"], ["phase", "TEXT"]]) {
        if (!columns.some(c => c.name === name)) store.db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${definition}`)
      }
      store.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_number ON runs(run_number)")
    }).immediate()
    // Seed the repos table from past runs, oldest first so the newest ends up on top.
    // PRAGMA user_version marks it done, so a repo the dev removes later does not come back.
    const seeded = (store.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version >= 1;
    if (!seeded) {
      const past = store.db.prepare("SELECT repo_url, branch FROM runs WHERE repo_url NOT LIKE 'local:%' ORDER BY started_at ASC").all() as Array<{ repo_url: string; branch: string }>;
      for (const run of past) {
        const slug = githubRepo(run.repo_url);
        if (slug) store.touchRepo(slug, run.repo_url, run.branch.startsWith("(") ? "" : run.branch);
      }
      store.db.exec("PRAGMA user_version = 1");
    }
    // Additive migration for pre-existing DBs (schema.sql only runs CREATE TABLE
    // IF NOT EXISTS, so a new column never reaches an already-created table).
    // ADD COLUMN is a cheap metadata-only op in SQLite; the catch swallows the
    // "duplicate column name" error on DBs that already have it.
    try { store.db.exec("ALTER TABLE runs ADD COLUMN categories TEXT"); } catch { /* already present */ }
    try { store.db.exec("ALTER TABLE runs ADD COLUMN commit_sha TEXT"); } catch { /* already present */ }
    try { store.db.exec("ALTER TABLE runs ADD COLUMN include_p2 INTEGER"); } catch { /* already present */ }
    try { store.db.exec("ALTER TABLE runs ADD COLUMN max_subagents INTEGER"); } catch { /* already present */ }
    try { store.db.exec("ALTER TABLE runs ADD COLUMN language TEXT"); } catch { /* already present */ }
    try { store.db.exec("ALTER TABLE runs ADD COLUMN resumed_from TEXT"); } catch { /* already present */ }
    try { store.db.exec("ALTER TABLE findings ADD COLUMN status TEXT"); } catch { /* already present */ }
    try { store.db.exec("ALTER TABLE findings ADD COLUMN reason TEXT"); } catch { /* already present */ }
    try { store.db.exec("ALTER TABLE findings ADD COLUMN kind TEXT"); } catch { /* already present */ }
    try { store.db.exec("ALTER TABLE findings ADD COLUMN posted INTEGER NOT NULL DEFAULT 0"); } catch { /* already present */ }
    try { store.db.exec("ALTER TABLE repos ADD COLUMN profile TEXT NOT NULL DEFAULT ''"); } catch { /* already present */ }
    try { store.db.exec("ALTER TABLE repos ADD COLUMN profile_override TEXT NOT NULL DEFAULT ''"); } catch { /* already present */ }
    try { store.db.exec("ALTER TABLE usage_totals ADD COLUMN credits REAL NOT NULL DEFAULT 0"); } catch { /* already present */ }
    // Runs no longer ask the operator anything. Drop the old tables and end runs that waited on an answer.
    store.db.exec(`DROP TABLE IF EXISTS decisions;
      DROP TABLE IF EXISTS clarifications;
      UPDATE runs SET status = 'failed', error = COALESCE(error, 'interrupted by backend restart')
        WHERE status IN ('awaiting_user','awaiting_clarifications');`)
    // "expired" only meant that the container was gone. Runs keep no container now, so it reads as completed.
    store.db.exec("UPDATE runs SET status = 'completed' WHERE status = 'expired'")
    // The container timer is gone, and so are its columns.
    store.db.exec("DROP INDEX IF EXISTS idx_runs_expires")
    for (const column of ["ttl_minutes", "expires_at"]) {
      try { store.db.exec(`ALTER TABLE runs DROP COLUMN ${column}`) } catch { /* already gone */ }
    }
    const runColumns = store.db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>
    for (const column of ["provider", "review_provider"]) {
      if (!runColumns.some(c => c.name === column)) {
        store.db.exec(`ALTER TABLE runs ADD COLUMN ${column} TEXT NOT NULL DEFAULT 'claude'`)
      }
    }
    for (const column of ["review_model", "review_effort"]) {
      if (!runColumns.some(c => c.name === column)) store.db.exec(`ALTER TABLE runs ADD COLUMN ${column} TEXT`)
    }
    // Older rows keep "oauth": relay runs were not recorded before this column.
    if (!runColumns.some(c => c.name === "auth_mode")) {
      store.db.exec("ALTER TABLE runs ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'oauth'")
    }
    const columns = store.db.prepare("PRAGMA table_info(findings)").all() as Array<{ name: string; pk: number }>;
    if (!columns.some((c) => c.name === "run_id" && c.pk > 0)) {
      // Stable finding hashes repeat across runs. Preserve legacy rows while
      // replacing the global key with a per-run key.
      store.db.exec(`BEGIN;
        ALTER TABLE findings RENAME TO findings_legacy;
        DROP INDEX idx_findings_run;
        ${schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS findings"), schema.indexOf("CREATE TABLE IF NOT EXISTS usage_totals"))}
        INSERT INTO findings (id, run_id, category, severity, file, line, snippet, fix_summary, status, reason, emitted_at)
          SELECT id, run_id, category, severity, file, line,
          snippet, fix_summary, status, reason, emitted_at FROM findings_legacy;
        DROP TABLE findings_legacy;
        COMMIT;`);
    }
    return store;
  }

  close(): void {
    this.db.close();
  }

  // --- sessions -----------------------------------------------------------
  // Returns false when no session has this id.
  touchSession(sessionId: string): boolean {
    return this.db.run(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`, [Date.now(), sessionId]).changes > 0;
  }

  ensureSession(sessionId: string): void {
    const now = Date.now();
    this.db.run(
      `INSERT INTO sessions (id, created_at, last_seen_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      [
        sessionId, now, now,
      ]
    );
  }

  // --- runs ---------------------------------------------------------------
  createRun(args: CreateRunArgs): void {
    this.db.run(
      `INSERT INTO runs
         (id, session_id, repo_url, branch, skill, model, effort, mode, categories, include_p2, max_subagents, language, commit_sha, provider, review_provider, review_model, review_effort, auth_mode, resumed_from, status, started_at, run_number)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, (SELECT COALESCE(MAX(run_number), 0) + 1 FROM runs))`,
      [
        args.runId,
        args.sessionId,
        args.repoUrl,
        args.branch,
        args.skill,
        args.model,
        args.effort,
        args.mode,
        args.categories ?? "",
        args.includeP2 == null ? null : Number(args.includeP2),
        args.maxSubagents ?? null,
        args.language ?? null,
        args.commitSha ?? null,
        args.provider ?? "claude",
        args.reviewProvider ?? "claude",
        args.reviewModel ?? null,
        args.reviewEffort ?? null,
        args.authMode ?? "oauth",
        args.resumedFrom ?? null,
        Date.now(),
      ]
    );
    this.db.run(
      `INSERT INTO usage_totals (run_id) VALUES (?)`,
      [
        args.runId,
      ]
    );
  }

  // Records an error without changing the run's status, e.g. a PR step that fails after the run completed.
  setRunError(runId: string, error: string): void {
    this.db.run(`UPDATE runs SET error = ? WHERE id = ?`, [error, runId]);
  }

  updateRunStatus(runId: string, status: RunStatus, opts: { error?: string; containerId?: string; stopReason?: "user_pause" | "quota" } = {}): void {
    const now = Date.now();
    if (status === "completed" || status === "failed" || status === "aborted" || status === "stopped") {
      this.db.run(
        `UPDATE runs SET status = ?, finished_at = ?, error = COALESCE(?, error), stop_reason = COALESCE(?, stop_reason) WHERE id = ?`,
        [
          status, now, opts.error ?? null, opts.stopReason ?? null, runId,
        ]
      );
    } else {
      // A late event from a dying container must not move a finished run back to an active status.
      this.db.run(
        `UPDATE runs SET status = ?, container_id = COALESCE(?, container_id)
         WHERE id = ? AND status NOT IN ('completed', 'failed', 'aborted', 'stopped')`,
        [
          status, opts.containerId ?? null, runId,
        ]
      );
    }
  }

  // Runs that have not reached an end state, newest first.
  stoppedRunIds(): string[] {
    return (this.db.prepare("SELECT id FROM runs WHERE status = 'stopped'").all() as Array<{ id: string }>).map(r => r.id);
  }

  listUnfinishedRuns(): Array<{ runId: string; status: string; repoUrl: string; mode: string }> {
    return this.db.prepare(
      `SELECT id AS runId, status, repo_url AS repoUrl, mode FROM runs
       WHERE status NOT IN ('completed', 'failed', 'expired', 'aborted', 'stopped') ORDER BY started_at DESC`,
    ).all() as Array<{ runId: string; status: string; repoUrl: string; mode: string }>;
  }

  // --- repos --------------------------------------------------------------
  touchRepo(repo: string, url: string, branch: string): void {
    this.db.run(
      `INSERT INTO repos (repo, url, branch, last_used) VALUES (?, ?, ?, ?)
       ON CONFLICT(repo) DO UPDATE SET url = excluded.url, branch = excluded.branch, last_used = excluded.last_used`,
      [
        repo, url, branch, Date.now(),
      ]
    );
  }

  listRepos(): Array<{ repo: string; url: string; branch: string; profile: RepoProfile | null; override: ProfileOverride | null }> {
    const rows = this.db.prepare("SELECT repo, url, branch, profile, profile_override FROM repos ORDER BY last_used DESC").all() as Array<{ repo: string; url: string; branch: string; profile: string; profile_override: string }>;
    return rows.map(({ profile, profile_override, ...row }) => ({ ...row, profile: profile ? JSON.parse(profile) : null, override: profile_override ? JSON.parse(profile_override) : null }));
  }

  saveProfile(repo: string, profile: RepoProfile): void {
    this.db.run("UPDATE repos SET profile = ? WHERE repo = ?", [JSON.stringify(profile), repo]);
  }

  // An empty override clears it. Returns false when the repo is unknown.
  setProfileOverride(repo: string, override: ProfileOverride): boolean {
    const value = override.php || override.framework ? JSON.stringify(override) : "";
    return this.db.run("UPDATE repos SET profile_override = ? WHERE repo = ?", [value, repo]).changes > 0;
  }

  profileOverride(repo: string): ProfileOverride | null {
    const row = this.db.prepare("SELECT profile_override FROM repos WHERE repo = ?").get(repo) as { profile_override: string } | undefined;
    return row?.profile_override ? JSON.parse(row.profile_override) : null;
  }

  removeRepo(repo: string): void {
    this.db.run("DELETE FROM repos WHERE repo = ?", [repo]);
  }

  // The scanner container id/name for a run (not exposed on RunSummary). Used
  // by the push handler to reap the kept-alive container after a successful push.
  getContainerId(runId: string): string | null {
    const row = this.db.prepare(`SELECT container_id FROM runs WHERE id = ?`)
      .get(runId) as { container_id: string | null } | undefined;
    return row?.container_id ?? null;
  }


  markInterrupted(runsRootDir?: string, orphanRunIds: string[] = []): number {
    // Called at backend boot: any run that the previous process left in a
    // mid-flight state is bumped to 'failed' with a synthetic error.
    const res = this.db.run(
      `UPDATE runs
          SET status = 'failed',
              error = COALESCE(error, 'interrupted by backend restart'),
              finished_at = COALESCE(finished_at, ?)
        WHERE status IN ('queued','cloning','scanning')`,
      [
        Date.now(),
      ]
    );
    let interrupted = res.changes
    if (runsRootDir) {
      const rows = this.db.query("SELECT id FROM runs WHERE status = 'completed' AND mode = 'fix' AND error IS NULL").all() as { id: string }[]
      for (const { id } of rows) {
        if (!orphanRunIds.includes(id) || !/^[A-Za-z0-9_-]+$/.test(id)) continue
        const dir = join(runsRootDir, id, "artifacts")
        if (existsSync(join(dir, "picked.json")) && !existsSync(join(dir, "push.json"))) {
          this.db.run("UPDATE runs SET error = ? WHERE id = ?", ["PR step interrupted by backend restart; no PR opened", id])
          interrupted++
        }
      }
    }
    return interrupted;
  }

  getRun(runId: string): RunSummary | null {
    const row = this.db.prepare(
      `SELECT r.*, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_create_tokens, u.credits
         FROM runs r LEFT JOIN usage_totals u ON r.id = u.run_id
        WHERE r.id = ?`,
    ).get(runId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToSummary(row);
  }

  listRunsForSession(sessionId: string, limit = 50): RunSummary[] {
    const rows = this.db.prepare(
      `SELECT r.*, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_create_tokens, u.credits
         FROM runs r LEFT JOIN usage_totals u ON r.id = u.run_id
        WHERE r.session_id = ?
        ORDER BY run_number DESC
        LIMIT ?`,
    ).all(sessionId, limit) as Record<string, unknown>[];
    return rows.map(rowToSummary);
  }

  setStarred(runId: string, starred: boolean): void {
    this.db.run("UPDATE runs SET starred = ? WHERE id = ?", [Number(starred), runId]);
  }

  setRunPhase(runId: string, phase: "fix" | "review" | "checks"): void {
    this.db.run("UPDATE runs SET phase = ? WHERE id = ?", [phase, runId]);
  }

  countRuns(filters: { status?: string; mode?: string; starred?: boolean } = {}): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM runs r
      WHERE (? = '' OR r.status = ?) AND (? = '' OR r.mode = ?) AND (? = 0 OR r.starred = 1)`)
      .get(filters.status ?? "", filters.status ?? "", filters.mode ?? "", filters.mode ?? "", Number(!!filters.starred)) as { n: number }).n;
  }

  listAllRuns(limit = 200, offset = 0, filters: { status?: string; mode?: string; starred?: boolean } = {}): RunSummary[] {
    const rows = this.db.prepare(
      `SELECT r.*, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_create_tokens, u.credits
         FROM runs r LEFT JOIN usage_totals u ON r.id = u.run_id
        WHERE (? = '' OR r.status = ?) AND (? = '' OR r.mode = ?) AND (? = 0 OR r.starred = 1)
        ORDER BY run_number DESC
        LIMIT ? OFFSET ?`,
    ).all(filters.status ?? "", filters.status ?? "", filters.mode ?? "", filters.mode ?? "", Number(!!filters.starred), limit, offset) as Record<string, unknown>[];
    return rows.map(rowToSummary);
  }

  countActive(): number {
    // Every non-terminal status counts, else the concurrency gate admits
    // more containers than MAX_CONCURRENT_SCANS.
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM runs
        WHERE status IN ('queued','cloning','scanning')`,
    ).get() as { n: number } | undefined;
    return row?.n ?? 0;
  }

  reserveStart(maxConcurrent: number): (() => void) | undefined {
    if (this.countActive() + this.starting >= maxConcurrent) return undefined
    this.starting++
    let released = false
    return () => {
      if (released) return
      released = true
      this.starting--
    }
  }

  // --- usage --------------------------------------------------------------
  addUsage(runId: string, d: UsageDelta): void {
    this.db.run(
      `UPDATE usage_totals
          SET input_tokens        = input_tokens        + ?,
              output_tokens       = output_tokens       + ?,
              cache_read_tokens   = cache_read_tokens   + ?,
              cache_create_tokens = cache_create_tokens + ?,
              credits             = credits             + ?
        WHERE run_id = ?`,
      [
        d.inputTokens, d.outputTokens, d.cacheReadTokens, d.cacheCreateTokens, d.credits ?? 0, runId,
      ]
    );
  }

  saveVendor(runId: string, data: VendorData): void {
    this.db.run("INSERT INTO run_vendor (run_id, data) VALUES (?, ?) ON CONFLICT(run_id) DO UPDATE SET data = excluded.data",
      [runId, JSON.stringify(data)])
  }

  getVendor(runId: string): VendorData | null {
    const row = this.db.prepare("SELECT data FROM run_vendor WHERE run_id = ?").get(runId) as { data: string } | undefined
    return row ? JSON.parse(row.data) : null
  }

  // --- findings -----------------------------------------------------------
  insertFinding(runId: string, f: {
    id: string;
    category: string;
    severity: string;
    file?: string;
    line?: number;
    snippet?: string;
    fixSummary?: string;
    status?: Finding["status"];
    reason?: string;
    kind?: string;
  }): void {
    this.db.run(
      `INSERT INTO findings (id, run_id, category, severity, file, line, snippet, fix_summary, status, reason, emitted_at, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, id) DO UPDATE SET
         category = excluded.category, severity = excluded.severity,
         file = excluded.file, line = excluded.line, snippet = excluded.snippet,
         fix_summary = excluded.fix_summary, status = excluded.status, reason = excluded.reason, kind = excluded.kind`,
      [
        f.id, runId, f.category, f.severity,
        f.file ?? null, f.line ?? null, f.snippet ?? null, f.fixSummary ?? null,
        f.status ?? null, f.reason ?? null, Date.now(), f.kind ?? null,
      ]
    );
  }

  listFindings(runId: string): Finding[] {
    const rows = this.db.prepare(
      `SELECT id, category, severity, file, line, snippet, fix_summary, status, reason, kind, posted
         FROM findings WHERE run_id = ? ORDER BY emitted_at ASC`,
    ).all(runId) as Array<{
      id: string; category: string; severity: string;
      file: string | null; line: number | null;
      snippet: string | null; fix_summary: string | null;
      status: Finding["status"] | null; reason: string | null;
      kind: string | null; posted: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      category: r.category,
      severity: r.severity as Finding["severity"],
      file: r.file ?? undefined,
      line: r.line ?? undefined,
      snippet: r.snippet ?? undefined,
      fixSummary: r.fix_summary ?? undefined,
      status: r.status ?? undefined,
      reason: r.reason ?? undefined,
      ...(r.kind ? { kind: r.kind } : {}),
      ...(r.posted ? { posted: true } : {}),
    }));
  }

  // The resume chain this run belongs to, oldest first. Each run has at most one resume.
  attempts(runId: string): Array<{ runId: string; status: RunStatus; startedAt?: number }> {
    const get = this.db.prepare("SELECT id, status, started_at, resumed_from FROM runs WHERE id = ?")
    const next = this.db.prepare("SELECT id FROM runs WHERE resumed_from = ?")
    type Row = { id: string; status: RunStatus; started_at: number | null; resumed_from: string | null }
    let first = get.get(runId) as Row | null
    if (!first) return []
    for (let seen = new Set([first.id]); first.resumed_from && !seen.has(first.resumed_from);) {
      const prev = get.get(first.resumed_from) as Row | null
      if (!prev) break
      seen.add(prev.id)
      first = prev
    }
    const chain: Row[] = [first]
    for (let row = first; ;) {
      const child = next.get(row.id) as { id: string } | null
      if (!child || chain.some(r => r.id === child.id)) break
      row = get.get(child.id) as Row
      chain.push(row)
    }
    return chain.map(r => ({ runId: r.id, status: r.status, ...(r.started_at ? { startedAt: r.started_at } : {}) }))
  }

  markPosted(runId: string, ids: string[]): void {
    for (const id of ids) this.db.run("UPDATE findings SET posted = 1 WHERE run_id = ? AND id = ?", [runId, id]);
  }
}

function rowToSummary(row: Record<string, unknown>): RunSummary {
  return {
    runId: String(row.id),
    runNumber: Number(row.run_number),
    sessionId: String(row.session_id),
    repoUrl: String(row.repo_url),
    branch: String(row.branch),
    commitSha: row.commit_sha != null ? String(row.commit_sha) : undefined,
    skill: String(row.skill) as RunSummary["skill"],
    provider: row.provider as ProviderId,
    reviewProvider: row.review_provider as ProviderId,
    reviewModel: row.review_model == null ? undefined : String(row.review_model),
    reviewEffort: row.review_effort == null ? undefined : row.review_effort as Effort,
    authMode: row.auth_mode === "relay" || row.auth_mode === "api-key" ? row.auth_mode : "oauth",
    model: String(row.model) as RunSummary["model"],
    effort: row.effort as Effort,
    mode: row.mode as RunMode,
    categories: row.categories != null && String(row.categories) !== ""
      ? String(row.categories).split(",") as RunSummary["categories"]
      : [],
    ...(row.include_p2 != null ? { includeP2: Boolean(row.include_p2) } : {}),
    ...(row.max_subagents != null ? { maxSubagents: Number(row.max_subagents) } : {}),
    ...(row.language === "en" || row.language === "zh" ? { language: row.language } : {}),
    starred: Boolean(row.starred),
    ...(row.stop_reason ? { stopReason: String(row.stop_reason) as RunSummary["stopReason"] } : {}),
    ...(row.phase ? { phase: String(row.phase) as RunSummary["phase"] } : {}),
    status: row.status as RunStatus,
    startedAt: row.started_at != null ? Number(row.started_at) : undefined,
    finishedAt: row.finished_at != null ? Number(row.finished_at) : undefined,
    error: row.error != null ? String(row.error) : undefined,
    usage: {
      inputTokens:       Number(row.input_tokens       ?? 0),
      outputTokens:      Number(row.output_tokens      ?? 0),
      cacheReadTokens:   Number(row.cache_read_tokens  ?? 0),
      cacheCreateTokens: Number(row.cache_create_tokens ?? 0),
      ...(Number(row.credits) > 0 ? { credits: Number(row.credits) } : {}),
    },
  };
}
