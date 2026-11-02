import { test } from "bun:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../store/repo.ts";
import { handleListAllRuns, handleStarRun } from "./runs.ts";

function addRun(store: Store, id: string, mode: "scan" | "fix") {
  store.ensureSession("history");
  store.createRun({ runId: id, sessionId: "history", repoUrl: "https://github.com/a/b", branch: "main",
    skill: "ola-security-audit", model: "sonnet", effort: "high", mode });
}

function routes(store: Store) {
  const app = new Hono();
  app.get("/api/runs", c => handleListAllRuns(c, { store }));
  app.patch("/api/runs/:id", c => handleStarRun(c, { store }));
  return app;
}

test("history pages beyond 200 and combines status, mode and starred filters before pagination", async () => {
  const store = await Store.open(":memory:");
  const app = routes(store);
  try {
    for (let i = 1; i <= 215; i++) {
      addRun(store, `run-${i}`, i % 2 ? "scan" : "fix");
      store.updateRunStatus(`run-${i}`, i % 3 ? "completed" : "failed");
      if (i % 2) store.setStarred(`run-${i}`, true);
    }
    for (const limit of [10, 50, 100]) {
      const result = await (await app.request(`/api/runs?limit=${limit}&offset=200`)).json();
      assert.equal(result.total, 215);
      assert.equal(result.runs.length, Math.min(limit, 15));
      assert.equal(result.runs[0].runNumber, 15);
    }
    const result = await (await app.request("/api/runs?limit=10&offset=10&mode=scan&status=failed&starred=1")).json();
    assert.equal(result.total, 36);
    assert.equal(result.runs.length, 10);
    assert.equal(result.runs[0].runNumber, 153);
    assert(result.runs.every((run: any) => run.mode === "scan" && run.status === "failed" && run.starred));
    const empty = await (await app.request("/api/runs?offset=999&mode=scan&starred=1")).json();
    assert.equal(empty.runs.length, 0);
    assert.equal(empty.total, 108);
    for (const query of ["mode=invalid", "status=invalid", "starred=true", "mode=scan%27%20OR%201=1"]) {
      assert.equal((await app.request(`/api/runs?${query}`)).status, 400);
    }
  } finally { store.close(); }
});

test("star endpoint toggles an existing run and rejects invalid bodies and unknown runs", async () => {
  const store = await Store.open(":memory:");
  const app = routes(store);
  const patch = (id: string, body: string) => app.request(`/api/runs/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body,
  });
  try {
    addRun(store, "run-1", "fix");
    assert.equal(store.getRun("run-1")?.starred, false);
    for (const starred of [true, false]) {
      const response = await patch("run-1", JSON.stringify({ starred }));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { starred });
      assert.equal(store.getRun("run-1")?.starred, starred);
    }
    for (const body of ["{", "null", "{}", '{"starred":1}', '{"starred":"true"}']) {
      assert.equal((await patch("run-1", body)).status, 400);
    }
    assert.equal((await patch("unknown", '{"starred":true}')).status, 404);
  } finally { store.close(); }
});

test("opening a legacy database adds star, stop reason and phase safely and preserves runs on reopening", async () => {
  const dir = await mkdtemp(join(tmpdir(), "history-migration-"));
  const path = join(dir, "runs.sqlite");
  let store: Store | undefined;
  try {
    const schema = await readFile(new URL("../store/schema.sql", import.meta.url), "utf8");
    const raw = new Database(path, { create: true });
    raw.exec(schema.replace(/,\n  starred[\s\S]*?phase         TEXT/, ""));
    raw.exec(`INSERT INTO sessions VALUES ('history', 1, 1);
      INSERT INTO runs (id, run_number, session_id, repo_url, branch, skill, model, effort, mode, status)
      VALUES ('legacy', 1, 'history', 'https://github.com/a/b', 'main', 'ola-security-audit', 'sonnet', 'high', 'scan', 'completed');`);
    raw.close();
    store = await Store.open(path);
    assert.equal(store.getRun("legacy")?.starred, false);
    assert.equal(store.getRun("legacy")?.status, "completed");
    addRun(store, "run-1", "scan");
    store.setStarred("run-1", true);
    store.setRunPhase("run-1", "checks");
    store.updateRunStatus("run-1", "stopped", { stopReason: "user_pause" });
    store.close();
    store = await Store.open(path);
    const run = store.getRun("run-1")!;
    assert.equal(run.starred, true);
    assert.equal(run.stopReason, "user_pause");
    assert.equal(run.phase, "checks");
    assert.equal(store.countRuns(), 2);
    store.setStarred("run-1", false);
    assert.equal(store.countRuns({ starred: true }), 0);
  } finally { store?.close(); await rm(dir, { recursive: true, force: true }); }
});
