import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { test } from "bun:test"
import { deepStrictEqual as assertEquals } from "node:assert/strict"
import { Database } from "bun:sqlite";
import { Store } from "./repo.ts";

function makeRun(store: Store, runId: string, mode: "fix" | "scan" = "fix") {
  store.ensureSession("s1");
  store.createRun({
    runId, sessionId: "s1", repoUrl: "https://x/y", branch: "main",
    skill: "ola-security-audit", model: "haiku", effort: "low", mode,
  });
}

test("run numbers span repos and sessions and survive paging, restart and VACUUM", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const path = `${dir}/numbers.sqlite`
  let store = await Store.open(path)
  const other = await Store.open(path)
  const originalNow = Date.now
  Date.now = () => 1000
  try {
    makeRun(store, "z-first")
    other.ensureSession("s2")
    other.createRun({ runId: "a-second", sessionId: "s2", repoUrl: "https://github.com/other/repo", branch: "main",
      skill: "ola-security-audit", model: "haiku", effort: "low", mode: "scan" })
    assertEquals(store.getRun("z-first")?.runNumber, 1)
    assertEquals(store.getRun("a-second")?.runNumber, 2)
    assertEquals(store.listAllRuns(1, 1).map(r => r.runNumber), [1])
    assertEquals(store.listRunsForSession("s2").map(r => r.runNumber), [2])
    store.updateRunStatus("z-first", "completed")
    assertEquals(store.listAllRuns().filter(r => r.status === "completed").map(r => r.runNumber), [1])
    store.close()
    other.close()
    const raw = new Database(path)
    raw.exec("VACUUM")
    raw.close()
    store = await Store.open(path)
    Date.now = () => 0
    makeRun(store, "third")
    assertEquals(store.listAllRuns().map(r => [r.runId, r.runNumber]), [["third", 3], ["a-second", 2], ["z-first", 1]])
  } finally {
    Date.now = originalNow
    store.close()
    other.close()
    await rm(dir, { recursive: true })
  }
})

test("legacy runs get stable numbers by creation time with UUID ties", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const path = `${dir}/legacy.sqlite`
  const schema = (await readFile(new URL("./schema.sql", import.meta.url), "utf8"))
    .replace(/^\s*run_number\s+INTEGER.*$/m, "")
  const raw = new Database(path, { create: true })
  raw.exec(schema)
  raw.exec("INSERT INTO sessions VALUES ('s1', 1, 1)")
  for (const [id, at] of [["newest", 30], ["tie-b", 20], ["oldest", 10], ["tie-a", 20]]) {
    raw.run(`INSERT INTO runs (id, session_id, repo_url, branch, skill, model, effort, mode, status, started_at)
      VALUES (?, 's1', 'https://x/y', 'main', 'ola-security-audit', 'haiku', 'low', 'scan', 'completed', ?)`, [id, at])
  }
  raw.close()
  let store = await Store.open(path)
  const expected = [["newest", 4], ["tie-b", 3], ["tie-a", 2], ["oldest", 1]]
  try {
    assertEquals(store.listAllRuns().map(r => [r.runId, r.runNumber]), expected)
    store.close()
    const vacuum = new Database(path)
    vacuum.exec("UPDATE runs SET started_at = 0 WHERE id = 'newest'; VACUUM")
    vacuum.close()
    store = await Store.open(path)
    assertEquals(store.listAllRuns().map(r => [r.runId, r.runNumber]), expected)
    assertEquals(store.getRun("tie-a")?.runNumber, 2)
    makeRun(store, "next")
    assertEquals(store.getRun("next")?.runNumber, 5)
  } finally { store.close(); await rm(dir, { recursive: true }) }
})

test("start reservations count before a run exists and release only once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const store = await Store.open(`${dir}/t.sqlite`)
  try {
    const release = store.reserveStart(1)!
    assertEquals(typeof release, "function")
    assertEquals(store.reserveStart(1), undefined)
    release()
    release()
    makeRun(store, "queued")
    assertEquals(store.reserveStart(1), undefined)
    store.updateRunStatus("queued", "failed")
    const next = store.reserveStart(1)!
    assertEquals(typeof next, "function")
    assertEquals(store.reserveStart(1), undefined)
    next()
  } finally { store.close(); await rm(dir, { recursive: true }) }
})

test("markInterrupted counts changed rows and preserves completed runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const store = await Store.open(`${dir}/t.sqlite`)
  try {
    for (const id of ["queued", "scanning", "completed"]) makeRun(store, id)
    store.updateRunStatus("scanning", "scanning")
    store.updateRunStatus("completed", "completed")
    assertEquals(store.markInterrupted(), 2)
    assertEquals(store.getRun("queued")?.status, "failed")
    assertEquals(store.getRun("scanning")?.status, "failed")
    assertEquals(store.getRun("completed")?.status, "completed")
    assertEquals(store.markInterrupted(), 0)
  } finally {
    store.close()
    await rm(dir, { recursive: true })
  }
})

test("categories round-trip: stored CSV → parsed array; empty → []", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"));
  const store = await Store.open(`${dir}/t.sqlite`);
  store.ensureSession("s1");
  store.createRun({
    runId: "scoped", sessionId: "s1", repoUrl: "https://x/y", branch: "main",
    skill: "ola-security-audit", model: "haiku", effort: "low", mode: "scan", categories: "sqli,hardcoded-secret",
  });
  store.createRun({
    runId: "full", sessionId: "s1", repoUrl: "https://x/y", branch: "main",
    skill: "ola-security-audit", model: "haiku", effort: "low", mode: "scan", // categories omitted → "" → []
  });
  assertEquals(store.getRun("scoped")?.categories, ["sqli", "hardcoded-secret"]);
  assertEquals(store.getRun("full")?.categories, []);
  store.close();
});

test("Store.open migrates a legacy runs table lacking the categories column", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"));
  const path = `${dir}/t.sqlite`;
  // Build a genuine pre-feature DB: the real schema with the `categories` line
  // stripped out. Store.open()'s CREATE TABLE IF NOT EXISTS won't re-add the
  // column (the table already exists) — ONLY the guarded ALTER can. If the ALTER
  // were removed, createRun's INSERT (which names `categories`) would throw
  // "no such column", so this test actually exercises the migration.
  const schema = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
  const legacy = schema.replace(/^\s*categories\s+TEXT,.*$/m, "");
  if (legacy.includes("categories")) throw new Error("test setup: categories column not stripped");
  const raw = new Database(path, { create: true });
  raw.exec(legacy);
  raw.close();

  const store = await Store.open(path); // guarded ALTER must add `categories`
  store.ensureSession("s1");
  store.createRun({
    runId: "r", sessionId: "s1", repoUrl: "https://x/y", branch: "main",
    skill: "ola-security-audit", model: "haiku", effort: "low", mode: "fix", categories: "sqli",
  });
  assertEquals(store.getRun("r")?.categories, ["sqli"]);
  store.close();
});

test("Store.open migrates a legacy runs table lacking the language column", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"));
  const path = `${dir}/t.sqlite`;
  const schema = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
  const legacy = schema.replace(/^\s*language\s+TEXT,.*$/m, "");
  if (/^\s*language\s/m.test(legacy)) throw new Error("test setup: language column not stripped");
  const raw = new Database(path, { create: true });
  raw.exec(legacy);
  raw.run(
    "INSERT INTO sessions (id, created_at, last_seen_at) VALUES ('s1', 1, 1)");
  raw.run(
    "INSERT INTO runs (id, run_number, session_id, repo_url, branch, skill, model, effort, mode, status, started_at) VALUES ('old', 1, 's1', 'https://x/y', 'main', 'ola-security-audit', 'haiku', 'low', 'fix', 'completed', 1)");
  raw.close();

  const store = await Store.open(path);
  assertEquals(store.getRun("old")?.language, undefined);
  store.createRun({
    runId: "new", sessionId: "s1", repoUrl: "https://x/y", branch: "main",
    skill: "ola-security-audit", model: "haiku", effort: "low", mode: "fix", language: "en",
  });
  assertEquals(store.getRun("new")?.language, "en");
  assertEquals(store.getRun("old")?.language, undefined);
  store.close();
});

test("Store.open migrates legacy runs with P2 off and persists explicit P2 settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"));
  const path = `${dir}/legacy.sqlite`;
  const schema = (await readFile(new URL("./schema.sql", import.meta.url), "utf8"))
    .replace(/^\s*include_p2\s+INTEGER,.*$/m, "");
  const raw = new Database(path, { create: true });
  raw.exec(schema);
  assertEquals((raw.query("PRAGMA table_info(runs)").all() as { name: string }[])
    .some(c => c.name === "include_p2"), false);
  raw.exec("INSERT INTO sessions VALUES ('s1', 1, 1)");
  raw.exec(`INSERT INTO runs (id, run_number, session_id, repo_url, branch, skill, model, effort, mode, status)
    VALUES ('old', 1, 's1', 'https://x/y', 'main', 'ola-security-audit', 'haiku', 'low', 'scan', 'completed')`);
  raw.close();

  let store = await Store.open(path);
  try {
    const old = store.getRun("old")!;
    assertEquals([old.runId, old.runNumber, old.repoUrl, old.status], ["old", 1, "https://x/y", "completed"]);
    assertEquals(old.includeP2 ?? false, false);
    for (const [runId, includeP2] of [["on", true], ["off", false], ["default", undefined]] as const) {
      store.createRun({
        runId, sessionId: "s1", repoUrl: "https://x/y", branch: "main",
        skill: "ola-security-audit", model: "haiku", effort: "low", mode: "scan", includeP2,
      });
    }
    store.close();
    store = await Store.open(path);
    assertEquals(store.getRun("old"), old);
    assertEquals(store.listAllRuns().map(r => [r.runId, r.includeP2 ?? false]),
      [["default", false], ["off", false], ["on", true], ["old", false]]);
    const check = new Database(path);
    try {
      assertEquals(check.query("SELECT id, include_p2 FROM runs ORDER BY run_number").all(), [
        { id: "old", include_p2: null }, { id: "on", include_p2: 1 },
        { id: "off", include_p2: 0 }, { id: "default", include_p2: null },
      ]);
    } finally { check.close(); }
  } finally { store.close(); await rm(dir, { recursive: true }); }
});

test("Store.open drops the decision tables and fails runs that waited on an answer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const path = `${dir}/t.sqlite`
  let store = await Store.open(path)
  makeRun(store, "asked")
  makeRun(store, "done")
  store.updateRunStatus("asked", "awaiting_user" as never)
  store.updateRunStatus("done", "completed")
  store.close()
  const raw = new Database(path)
  raw.exec("CREATE TABLE decisions (id TEXT PRIMARY KEY); CREATE TABLE clarifications (id TEXT PRIMARY KEY)")
  raw.close()
  store = await Store.open(path)
  try {
    assertEquals(store.getRun("asked")?.status, "failed")
    assertEquals(store.getRun("done")?.status, "completed")
  } finally {
    store.close()
  }
  const check = new Database(path)
  assertEquals(check.prepare("SELECT name FROM sqlite_master WHERE name IN ('decisions', 'clarifications')").all(), [])
  check.close()
  await rm(dir, { recursive: true })
})

test("Store.open is idempotent (guarded categories ALTER re-runs safely)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"));
  const path = `${dir}/t.sqlite`;
  // Second open re-runs the guarded ALTER against a DB that already has the
  // column — it must be swallowed (duplicate column) rather than throwing.
  const s1 = await Store.open(path);
  s1.close();
  const s2 = await Store.open(path);
  s2.close();
});

test("Store.open turns old expired runs into completed runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"));
  let store = await Store.open(`${dir}/t.sqlite`);
  makeRun(store, "old", "fix");
  store.close();
  const raw = new Database(`${dir}/t.sqlite`);
  raw.run("UPDATE runs SET status = 'expired' WHERE id = 'old'");
  raw.close();
  store = await Store.open(`${dir}/t.sqlite`);
  assertEquals(store.getRun("old")?.status, "completed");
  store.close();
  // The timer columns are gone too.
  const columns = (new Database(`${dir}/t.sqlite`).query("PRAGMA table_info(runs)").all() as { name: string }[]).map((c) => c.name);
  assertEquals(columns.filter((c) => c === "ttl_minutes" || c === "expires_at"), []);
  await rm(dir, { recursive: true });
});

test("findings migration preserves rows and supports stable IDs across runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"));
  const path = `${dir}/legacy.sqlite`;
  const schema = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
  const legacy = schema.replace(/^\s*review_(model|effort)\s+TEXT,.*$/gm, "").replace(/^\s*commit_sha\s+TEXT,.*$/m, "")
    .replace(/^\s*run_number\s+INTEGER.*$/m, "")
    .replace(/^\s*status\s+TEXT,.*$/m, "")
    .replace(/^\s*reason\s+TEXT,.*$/m, "")
    .replace("id           TEXT NOT NULL,", "id           TEXT PRIMARY KEY,")
    .replace("emitted_at   INTEGER NOT NULL,\n  PRIMARY KEY (run_id, id)", "emitted_at   INTEGER NOT NULL");
  const raw = new Database(path, { create: true });
  raw.exec(legacy);
  raw.exec("INSERT INTO sessions VALUES ('s1', 1, 1)");
  raw.exec(`INSERT INTO runs (id, session_id, repo_url, branch, skill, model, effort, mode, status)
    VALUES ('old', 's1', 'https://x/y', 'main', 'ola-security-audit', 'haiku', 'low', 'audit-only', 'completed')`);
  raw.exec("INSERT INTO findings (id, run_id, category, severity, emitted_at) VALUES ('stable', 'old', 'sqli', 'P0', 1)");
  raw.close();
  let store = await Store.open(path);
  try {
    assertEquals(store.listFindings("old")[0].id, "stable");
    assertEquals(store.getRun("old")?.provider, "claude");
    assertEquals(store.getRun("old")?.reviewProvider, "claude");
    assertEquals(store.getRun("old")?.reviewModel, undefined);
    assertEquals(store.getRun("old")?.reviewEffort, undefined);
    assertEquals(store.getRun("old")?.authMode, "oauth");
    store.createRun({
      runId: "relay", sessionId: "s1", repoUrl: "https://x/y", branch: "main",
      skill: "ola-security-audit", model: "gateway/gpt-test", effort: "low", mode: "scan", authMode: "relay",
    });
    assertEquals(store.getRun("relay")?.authMode, "relay");
    const commitSha = "a".repeat(40);
    store.createRun({
      runId: "new", sessionId: "s1", repoUrl: "https://x/y", branch: "main",
      skill: "ola-security-audit", model: "haiku", effort: "low", mode: "fix", commitSha, reviewProvider: "codex", reviewModel: "gpt-6.1-sol", reviewEffort: "xhigh",
    });
    assertEquals(store.getRun("new")?.commitSha, commitSha);
    assertEquals(store.getRun("new")?.reviewModel, "gpt-6.1-sol");
    assertEquals(store.listAllRuns().find(r => r.runId === "new")?.reviewEffort, "xhigh");
    assertEquals(store.listAllRuns().find((r) => r.runId === "new")?.commitSha, commitSha);
    const finding = { id: "stable", category: "sqli", severity: "P0", status: "candidate" as const, reason: "Reachable" };
    store.insertFinding("new", finding);
    store.insertFinding("new", { ...finding, status: "fixed", reason: "Parameterized", fixSummary: "Bind input" });
    assertEquals(store.listFindings("new").length, 1);
    assertEquals(store.listFindings("new")[0].status, "fixed");
    assertEquals(store.listFindings("new")[0].reason, "Parameterized");
    assertEquals(store.listFindings("new")[0].fixSummary, "Bind input");
    assertEquals(store.listFindings("old")[0].status, undefined);
    store.close();
    store = await Store.open(path);
    assertEquals(store.listFindings("old")[0].id, "stable");
    assertEquals(store.getRun("old")?.provider, "claude");
    assertEquals(store.getRun("old")?.reviewProvider, "claude");
    assertEquals(store.getRun("old")?.reviewModel, undefined);
    assertEquals(store.getRun("old")?.reviewEffort, undefined);
    assertEquals(store.listFindings("new")[0].id, "stable");
    assertEquals(store.getRun("new")?.reviewModel, "gpt-6.1-sol");
    assertEquals(store.getRun("new")?.reviewEffort, "xhigh");
  } finally {
    store.close();
    await rm(dir, { recursive: true });
  }
});

test("repos table is seeded once from past runs, newest on top, and removals stick", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"));
  const path = `${dir}/seed.sqlite`;
  const schema = (await readFile(new URL("./schema.sql", import.meta.url), "utf8")).split("-- Repos the dev started")[0]
    .replace(/^\s*run_number\s+INTEGER.*$/m, "")
  const raw = new Database(path, { create: true });
  raw.exec(schema);
  raw.exec("INSERT INTO sessions VALUES ('s1', 1, 1)");
  for (const [id, url, branch, at] of [["r1", "https://github.com/A/One", "main", 1], ["r2", "https://github.com/b/two", "(default)", 2], ["r3", "local:/tmp/x", "(local)", 3], ["r4", "https://github.com/a/one", "dev", 4]]) {
    raw.exec(`INSERT INTO runs (id, session_id, repo_url, branch, skill, model, effort, mode, status, started_at)
      VALUES ('${id}', 's1', '${url}', '${branch}', 'ola-security-audit', 'haiku', 'low', 'scan', 'completed', ${at})`);
  }
  raw.close();
  let store = await Store.open(path);
  try {
    assertEquals(store.listRepos().map((r) => [r.repo, r.branch]), [["a/one", "dev"], ["b/two", ""]]);
    store.removeRepo("a/one");
    store.close();
    store = await Store.open(path);
    assertEquals(store.listRepos().map((r) => r.repo), ["b/two"]);
  } finally { store.close(); await rm(dir, { recursive: true }); }
});

test("boot records interrupted PR steps without changing completed status or existing errors", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises")
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const store = await Store.open(`${dir}/test.sqlite`)
  try {
    for (const id of ["pending", "pushed", "errored", "scan", "no-pick", "old", "nothing-fixed"]) {
      makeRun(store, id, id === "scan" ? "scan" : "fix")
      store.updateRunStatus(id, "completed", id === "errored" ? { error: "original error" } : {})
      await mkdir(`${dir}/${id}/artifacts`, { recursive: true })
      if (id !== "no-pick") await writeFile(`${dir}/${id}/artifacts/picked.json`, "[]")
    }
    await writeFile(`${dir}/pushed/artifacts/push.json`, "{}")
    assertEquals(store.markInterrupted(dir, ["pending", "pushed", "errored", "scan", "no-pick"]), 1)
    assertEquals(store.getRun("pending")?.status, "completed")
    assertEquals(store.getRun("pending")?.error, "PR step interrupted by backend restart; no PR opened")
    assertEquals(store.getRun("errored")?.error, "original error")
    for (const id of ["pushed", "scan", "no-pick", "old", "nothing-fixed"]) assertEquals(Boolean(store.getRun(id)?.error), false)
    assertEquals(store.markInterrupted(dir), 0)
  } finally { store.close(); await rm(dir, { recursive: true }) }
})

test("touchSession updates only sessions that exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const store = await Store.open(`${dir}/t.sqlite`)
  try {
    assertEquals(store.touchSession("s1"), false)
    store.ensureSession("s1")
    assertEquals(store.touchSession("s1"), true)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test("a late active status cannot reopen a finished run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const store = await Store.open(`${dir}/t.sqlite`)
  try {
    makeRun(store, "r1")
    store.updateRunStatus("r1", "scanning")
    assertEquals(store.getRun("r1")?.status, "scanning")
    store.updateRunStatus("r1", "completed")
    store.updateRunStatus("r1", "scanning")
    assertEquals(store.getRun("r1")?.status, "completed")
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test("legacy usage columns remain untouched while token totals update", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-legacy-usage-"));
  const path = join(dir, "test.sqlite");
  let store = await Store.open(path);
  store.close();
  const db = new Database(path);
  db.exec("ALTER TABLE usage_totals ADD COLUMN est_cost_usd REAL NOT NULL DEFAULT 0");
  store = await Store.open(path);
  try {
    makeRun(store, "legacy");
    db.run("UPDATE usage_totals SET est_cost_usd = 9 WHERE run_id = ?", ["legacy"]);
    const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheCreateTokens: 0 };
    store.addUsage("legacy", usage);
    assertEquals(store.getRun("legacy")?.usage, usage);
    assertEquals(store.listAllRuns()[0].usage, usage);
    assertEquals(store.listRunsForSession("s1")[0].usage, usage);
    assertEquals(db.query("SELECT est_cost_usd FROM usage_totals WHERE run_id = ?").get("legacy"), { est_cost_usd: 9 });
  } finally { store.close(); db.close(); await rm(dir, { recursive: true }); }
});

test("credits column migrates onto an old usage table and sums Qoder credits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-credits-"));
  const path = join(dir, "test.sqlite");
  let store = await Store.open(path);
  store.close();
  const db = new Database(path);
  db.exec("ALTER TABLE usage_totals DROP COLUMN credits");
  store = await Store.open(path);
  try {
    makeRun(store, "qoder");
    const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
    assertEquals(store.getRun("qoder")?.usage, zero);
    store.addUsage("qoder", { ...zero, credits: 1.5 });
    store.addUsage("qoder", { ...zero, credits: 0.34 });
    store.addUsage("qoder", zero);
    assertEquals(store.getRun("qoder")?.usage, { ...zero, credits: 1.84 });
    assertEquals(store.listAllRuns()[0].usage, { ...zero, credits: 1.84 });
  } finally { store.close(); db.close(); await rm(dir, { recursive: true }); }
});
