import type { RunEvent, UsageDelta } from "../../shared/types.ts";
import { deltaFromUsage, extractUsage } from "../sdk_bridge/usage_aggregator.ts";

interface UseRecord {
  name: string;
  input: Record<string, unknown>;
}

// SdkMapper turns raw SDKMessages from the scanner bridge into normalized
// RunEvents the frontend reducer understands. It is stateful per-run because
// tool_use ↔ tool_result correlation requires remembering the use id across
// multiple frames.
//
// It also runs the L1 step heuristic: infer `classify / fix / commit` step
// transitions from observable tool_use events, so the Checklist sidebar
// actually advances through these phases in fix mode (scan mode never
// emits Edit/Write so these are no-ops there).
export class SdkMapper {
  private pending = new Map<string, UseRecord>();
  // L1 step heuristic flags — fire exactly once per run.
  private classifyFired = false;
  private fixStarted = false;
  private commitStarted = false;
  // While true, L1 step heuristic events are suppressed. Replay toggles this
  // around the removed indexing pass in older event logs. The model used Write
  // there to create CLAUDE.md files, which would otherwise read as "fix phase started".
  private suppressHeuristics = false;
  // API message ids already billed. One mapper serves every query() call in a
  // run (fix rounds, review passes), and API ids are globally unique,
  // so one set per run counts each API message exactly once.
  private seenMessageIds = new Set<string>();
  // What this query() call has added so far. Its result message replaces it with the SDK's own count.
  private round: UsageDelta = ZERO;

  setSuppressHeuristics(v: boolean): void { this.suppressHeuristics = v; }

  /** True once a `git commit` Bash has been observed. ScannerRun uses this
   *  in onExit/round_finished to decide whether to emit step_completed:commit. */
  hasCommitStarted(): boolean { return this.commitStarted; }
  hasFixStarted(): boolean { return this.fixStarted; }

  // ts is when the bridge saw the message. The timeline shows it on reasoning and tool calls.
  map(sdkMessage: unknown, ts?: number): RunEvent[] {
    const out: RunEvent[] = [];

    const m = sdkMessage as { type?: string; message?: { id?: string; content?: unknown[] } };

    // 1) Usage. Assistant messages give a live estimate, once per message.id:
    // - The SDK emits one assistant message per content block, all sharing one
    //   message.id and the same usage, so repeats must be skipped.
    // - That usage is from the start of the reply, so it misses most output tokens.
    // The `result` message ends a query() call with the SDK's own token totals.
    // Its delta replaces the round's estimate.
    if (m?.type === "assistant") {
      const id = m.message?.id;
      const seen = typeof id === "string" && this.seenMessageIds.has(id);
      const usage = seen ? null : extractUsage(sdkMessage);
      if (usage) {
        if (typeof id === "string") this.seenMessageIds.add(id);
        const delta = deltaFromUsage(usage);
        this.round = combine(this.round, delta, 1);
        out.push({ type: "usage_delta", usage: delta });
      }
    }
    if (m?.type === "result" || m?.type === "turn.completed") {
      const usage = extractUsage(sdkMessage);
      if (usage) {
        const sdk = deltaFromUsage(usage);
        const delta = combine(sdk, this.round, -1);
        out.push({ type: "usage_delta", usage: delta });
      }
      this.round = ZERO;
    }

    if (m?.type === "assistant") {
      const content = m.message?.content ?? [];
      for (const block of content) {
        const b = block as { type?: string };
        if (b.type === "text") {
          // The model's primary output — what it says to the user. Skill
          // reports (markdown) live here. NOT to be conflated with
          // 'thinking' blocks, which are internal reasoning.
          const text = (block as { text: string }).text;
          if (typeof text === "string" && text.length > 0) {
            out.push({ type: "assistant_text", text });
          }
        } else if (b.type === "thinking") {
          // Extended thinking — model's internal reasoning. Truncate so the
          // UI stays scannable; users who want the full trace open the
          // collapsed panel.
          const t = (block as { thinking?: string }).thinking;
          if (typeof t === "string" && t.length > 0) {
            out.push({ type: "thinking_emitted", text: truncate(t, 800), ts });
          }
        } else if (b.type === "tool_use") {
          const tu = block as { id: string; name: string; input: Record<string, unknown> };
          this.pending.set(tu.id, { name: tu.name, input: tu.input ?? {} });
          out.push({ type: "tool_invoked", tool: tu.name, input: tu.input ?? {}, ts });

          // L1 heuristic: first Edit/Write tool = classification finished,
          // fix phase begins. Emit a fast classify start+complete pair so
          // the checklist marks it done, then start fix.
          if (!this.suppressHeuristics && !this.classifyFired && (tu.name === "Edit" || tu.name === "Write")) {
            this.classifyFired = true;
            this.fixStarted = true;
            out.push({ type: "step_started",   step: "classify" });
            out.push({ type: "step_completed", step: "classify", status: "completed" });
            out.push({ type: "step_started",   step: "fix" });
          }

          // L1 heuristic: first `git commit` Bash = fix done, commit begins.
          // Regex permits up to 8 tokens between `git` and `commit` so we
          // catch flagged forms the model sometimes uses, like
          //   git -c user.email=ai@bot -c user.name=AI commit -m "..."
          //   git -C /workspace/repo commit -m "..."
          // entrypoint.sh now pre-sets user.email/name so plain `git commit`
          // is the common case; this regex is the defense-in-depth fallback.
          if (!this.suppressHeuristics && !this.commitStarted && tu.name === "Bash") {
            const cmd = String((tu.input as { command?: string }).command ?? "");
            if (/\bgit\b(?:\s+\S+){0,8}\s+commit\b/.test(cmd)) {
              this.commitStarted = true;
              if (this.fixStarted) {
                out.push({ type: "step_completed", step: "fix", status: "completed" });
              }
              out.push({ type: "step_started", step: "commit" });
            }
          }
        }
      }
    } else if (m?.type === "user") {
      const content = m.message?.content ?? [];
      for (const block of content) {
        const b = block as { type?: string };
        if (b.type === "tool_result") {
          const tr = block as { tool_use_id: string; content: unknown; is_error?: boolean };
          const rec = this.pending.get(tr.tool_use_id);
          if (!rec) continue;
          out.push({
            type: "tool_completed",
            tool: rec.name,
            ok: !tr.is_error,
            summary: stringifyToolResult(tr.content),
            ts,
          });
          this.pending.delete(tr.tool_use_id);
        }
      }
    }
    return out;
  }
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === "string") return truncate(content, 200);
  if (Array.isArray(content)) {
    return truncate(
      content
        .map((c) => {
          const b = c as { text?: string };
          return typeof b.text === "string" ? b.text : "";
        })
        .join("\n"),
      200,
    );
  }
  return "";
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

const ZERO: UsageDelta = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };

// a + sign * b, field by field.
function combine(a: UsageDelta, b: UsageDelta, sign: 1 | -1): UsageDelta {
  return {
    inputTokens: a.inputTokens + sign * b.inputTokens,
    outputTokens: a.outputTokens + sign * b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + sign * b.cacheReadTokens,
    cacheCreateTokens: a.cacheCreateTokens + sign * b.cacheCreateTokens,
    ...(a.credits || b.credits ? { credits: (a.credits ?? 0) + sign * (b.credits ?? 0) } : {}),
  };
}
