import { chmod, readFile, realpath, writeFile } from "node:fs/promises"
// Refresh OAuth credentials into the file the scanner containers mount RO.
// Solves the "24h OAuth token expired" loop by re-reading the host's
// authoritative source on every scan startup.
//
// Source by platform:
//   - macOS: `security find-generic-password -s 'Claude Code-credentials'`
//   - Linux: file at $OLA_AGENT_CREDENTIALS_SOURCE (default ~/.claude/.credentials.json)
//
// On Linux this requires the Claude Code CLI to be refreshed on the host —
// the CLI auto-refreshes whenever it runs and the access_token is near
// expiry. If no one runs `claude` periodically, the file goes stale. Use
// scripts/keep-claude-token-fresh.sh in cron to force a refresh every 6h.

const isDarwin = process.platform === "darwin";

let inflight: Promise<RefreshResult> | null = null;

export interface RefreshResult {
  refreshed: boolean;
  reason?: string;
  expiresAt?: number;
  source?: "keychain" | "file";
}

export function refreshCredentials(targetPath: string): Promise<RefreshResult> {
  if (inflight) return inflight;
  inflight = doRefresh(targetPath).finally(() => { inflight = null; });
  return inflight;
}

// Back-compat alias for existing call sites that imported the old name.
export const refreshCredentialsFromKeychain = refreshCredentials;

async function doRefresh(targetPath: string): Promise<RefreshResult> {
  if (!targetPath) {
    return { refreshed: false, reason: "OLA_AGENT_CREDENTIALS_HOST_PATH not set" };
  }
  return isDarwin ? await refreshFromKeychain(targetPath) : await refreshFromFile(targetPath);
}

async function refreshFromKeychain(targetPath: string): Promise<RefreshResult> {
  let raw: string;
  try {
    const p = Bun.spawn(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"], { env: process.env,
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(p.stdout).text()
    if (await p.exited !== 0) {
      return { refreshed: false, source: "keychain",
        reason: "Keychain entry 'Claude Code-credentials' missing; run `claude login`" };
    }
    raw = output.trim();
  } catch (e) {
    return { refreshed: false, source: "keychain", reason: `Keychain read failed: ${(e as Error).message}` };
  }
  return await persistSlice(raw, targetPath, "keychain");
}

async function refreshFromFile(targetPath: string): Promise<RefreshResult> {
  // Default Linux location written by Claude Code CLI; overridable via env.
  const sourcePath =
    process.env["OLA_AGENT_CREDENTIALS_SOURCE"] ||
    `${process.env["HOME"] ?? ""}/.claude/.credentials.json`;

  // No-op if source IS target (e.g. someone pointed CREDENTIALS_SOURCE at
  // .runtime/.credentials.json — we'd overwrite ourselves and lose data).
  if (await samePath(sourcePath, targetPath)) {
    return { refreshed: false, source: "file",
      reason: `source and target resolve to the same path (${sourcePath})` };
  }

  let raw: string;
  try {
    raw = await readFile(sourcePath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { refreshed: false, source: "file",
        reason: `source file ${sourcePath} missing; run \`claude login\` on the host` };
    }
    return { refreshed: false, source: "file",
      reason: `read ${sourcePath} failed: ${(e as Error).message}` };
  }
  return await persistSlice(raw, targetPath, "file");
}

async function persistSlice(raw: string, targetPath: string, source: "keychain" | "file"): Promise<RefreshResult> {
  let parsed: { claudeAiOauth?: { accessToken?: string; expiresAt?: number } };
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { refreshed: false, source, reason: `payload not JSON: ${(e as Error).message}` };
  }
  if (!parsed.claudeAiOauth?.accessToken) {
    return { refreshed: false, source, reason: "payload missing claudeAiOauth.accessToken" };
  }
  const slice = JSON.stringify({ claudeAiOauth: parsed.claudeAiOauth });
  try {
    await writeFile(targetPath, slice);
    await chmod(targetPath, 0o600);
  } catch (e) {
    return { refreshed: false, source, reason: `write ${targetPath} failed: ${(e as Error).message}` };
  }
  return {
    refreshed: true,
    source,
    expiresAt: parsed.claudeAiOauth.expiresAt,
  };
}

async function samePath(a: string, b: string): Promise<boolean> {
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return false;
  }
}
