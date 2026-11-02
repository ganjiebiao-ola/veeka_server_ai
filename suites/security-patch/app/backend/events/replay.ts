import type { RunEvent, UsageDelta } from "../../shared/types.ts"
import { decodeJsonlStream } from "../sdk_bridge/jsonl_decoder.ts"
import { SdkMapper } from "./sdk_mapper.ts"

// events.jsonl comes from the bridge, so it never holds the entrypoint's "cloning" or
// "clone_done" frames. Any scan frame proves prepare and clone already finished.
const CLONE_DONE: RunEvent[] = [
  { type: "step_completed", step: "prepare", status: "completed" },
  { type: "step_completed", step: "ingest", status: "completed" },
]

// A batch fix enters review or checks only after its fix round committed, maybe in an
// earlier run that this one resumes. So every step up to the commit is done.
export const REVIEW_STARTED: RunEvent[] = [
  ...(["scan", "classify", "fix", "commit"] as const).map((step): RunEvent => ({ type: "step_completed", step, status: "completed" })),
  { type: "step_started", step: "review" },
]

export async function* replayEvents(source: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const mapper = new SdkMapper()
  let failed = false
  try {
    for await (const raw of decodeJsonlStream(source)) {
      if (!raw || typeof raw !== "object") continue
      const frame = raw as unknown as Record<string, unknown>
      const events: RunEvent[] = []
      switch (frame.kind) {
        case "sdk_message":
          try {
            events.push(...mapper.map(frame.message, typeof frame.ts === "number" ? frame.ts : undefined).filter(event =>
              ["tool_invoked", "tool_completed", "thinking_emitted", "step_started", "step_completed"].includes(event.type)))
          } catch {
            // A damaged SDK frame must not hide the rest of the saved log.
          }
          break
        case "clone_done":
          events.push(...CLONE_DONE)
          break
        case "scanner_status":
          if (frame.status === "cloning") events.push({ type: "step_started", step: "ingest" })
          if (frame.status === "scanning") events.push(...CLONE_DONE, { type: "step_started", step: "scan" })
          break
        case "round_started":
          events.push(...CLONE_DONE, { type: "step_started", step: "scan" })
          break
        case "phase":
          if (frame.phase === "review" || frame.phase === "checks") events.push({ type: "run_phase", phase: frame.phase })
          events.push(...CLONE_DONE, ...REVIEW_STARTED)
          break
        // Older event logs carry the removed indexing pass. Its CLAUDE.md writes are not fix steps.
        case "indexing_started":
          mapper.setSuppressHeuristics(true)
          break
        case "indexing_done":
          mapper.setSuppressHeuristics(false)
          break
        case "scanner_failed":
        case "run_stopped":
          failed = true
          break
        case "run_finished":
          if (failed) break
          events.push({ type: "step_completed", step: "scan", status: "completed" },
            { type: "step_completed", step: "report", status: "completed" })
          if (mapper.hasFixStarted()) events.push({ type: "step_completed", step: "fix", status: "completed" })
          if (mapper.hasCommitStarted()) events.push({ type: "step_completed", step: "commit", status: "completed" })
          break
        default:
          // Older event artifacts may already contain normalized frontend events.
          if (frame.type === "usage_delta" && frame.usage && typeof frame.usage === "object") {
            const { inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, credits, partialUsage, partial_usage } = frame.usage as UsageDelta
            events.push({ type: "usage_delta", usage: { inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens,
              ...(typeof credits === "number" && credits > 0 ? { credits } : {}),
              ...(partialUsage ? { partialUsage: true } : {}), ...(partial_usage ? { partial_usage: true } : {}) },
              ...(frame.phase === "fix" || frame.phase === "review" || frame.phase === "checks" ? { phase: frame.phase } : {}) })
          } else if (typeof frame.type === "string") events.push(frame as unknown as RunEvent)
      }
      for (const event of events) yield JSON.stringify(event) + "\n"
    }
  } finally {
    await source.cancel()
  }
}
