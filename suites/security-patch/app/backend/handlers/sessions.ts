import type { Context } from "hono";
import type { Store } from "../store/repo.ts";

// POST /api/sessions  → { sessionId }
export function handleCreateSession(c: Context, deps: { store: Store }): Response {
  const sid = crypto.randomUUID();
  deps.store.ensureSession(sid);
  return c.json({ sessionId: sid }, 201);
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/sessions/:id/refresh — touches last_seen_at; returns sessionId echo.
// Used on app load when a localStorage sessionId is found. A 404 makes the UI create a new session.
export function handleRefreshSession(c: Context, deps: { store: Store }): Response {
  const sid = c.req.param("id");
  if (!sid || !SESSION_ID.test(sid)) return c.json({ error: "invalid session id" }, 400);
  if (!deps.store.touchSession(sid)) return c.json({ error: "session not found" }, 404);
  return c.json({ sessionId: sid });
}
