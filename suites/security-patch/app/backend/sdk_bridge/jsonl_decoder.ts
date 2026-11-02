// Decodes a JSONL byte stream into typed bridge events.
//
// Scanner stdout protocol (one JSON per line):
//   { runId, kind: "scanner_status", status: "cloning" | "scanning" }
//   { runId, kind: "scanner_failed", error: string }
//   { runId, kind: "clone_done", branch: string }
//   { runId, kind: "sdk_message", message: <opaque SDKMessage> }
//   { runId, kind: "run_finished", success: boolean }

export type BridgeEvent =
  | { runId: string; kind: "scanner_status"; status: string }
  | { runId: string; kind: "scanner_failed"; error: string }
  | { runId: string; kind: "clone_done"; branch: string }
  | { runId: string; kind: "sdk_message"; message: unknown }
  | { runId: string; kind: "run_finished"; success: boolean };

export async function* decodeJsonlStream(
  source: ReadableStream<Uint8Array>,
): AsyncGenerator<BridgeEvent> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const evt = parseObject(line);
        if (evt) yield evt;
      }
    }
    // Final flush
    const tail = buf.trim();
    if (tail) {
      const evt = parseObject(tail);
      if (evt) yield evt;
    }
  } finally {
    reader.releaseLock();
  }
}

// Skip malformed lines and JSON values that are not objects, such as `null` or `5`.
function parseObject(line: string): BridgeEvent | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? value as BridgeEvent : undefined;
  } catch {
    return undefined;
  }
}
