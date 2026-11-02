import { useEffect, useState } from "react";
import type {
  Finding,
  RunEvent,
  RunMode,
  RunStatus,
  StepName,
  StepProgress,
  StepStatus,
  UsageDelta,
  PhaseUsage,
} from "../types/events";

// Step lists per mode. Scan skips classify/fix/commit (no code change), so
// the checklist doesn't dangle pending rows that never light up.
export const STEPS_BY_MODE: Record<RunMode, StepName[]> = {
  scan:         ["prepare", "ingest", "scan", "report"],
  fix:          ["prepare", "ingest", "scan", "classify", "fix", "commit", "review", "report"],
};

// Old runs may carry a removed mode such as "audit-only". Show them with the scan steps.
function stepsFor(mode: RunMode): StepName[] {
  return STEPS_BY_MODE[mode] ?? STEPS_BY_MODE.scan;
}

export interface ToolLogEntry {
  ts?: number;          // absent in logs saved before the bridge stamped frames
  tool: string;
  input: Record<string, unknown>;
  ok?: boolean;
  summary?: string;
  durationMs?: number;
}

// Reasoning and tool calls in the order they happened. A tool entry points into toolLog,
// which keeps its result up to date.
export type TimelineEntry = { thinking: string; ts?: number } | { tool: number };

export interface RunState {
  reconnecting: boolean
  reconnects: number
  status: RunStatus;
  steps: StepProgress[];
  /** Markdown report — concatenated assistant text blocks. The primary scan
   *  output, rendered as the main column header. */
  assistantText: string;
  toolLog: ToolLogEntry[];
  timeline: TimelineEntry[];
  findings: Finding[];
  hasUsage: boolean;
  usage: UsageDelta;
  phaseUsage: PhaseUsage;
  artifacts: Array<{ kind: "patch" | "report" | "commits"; url: string }>;
  error?: string;
  /** Set when a fix run's batch PR is open: its branch and PR link. */
  pushBranch?: string;
  prUrl?: string;
  /** Why the batch PR push failed. */
  pushError?: string;
  /** query() round counter — 1 for the first round, ≥2 for review and check rounds. */
  round: number;
  phase?: "fix" | "review" | "checks";
}

function addUsage(previous: UsageDelta | undefined, delta: UsageDelta): UsageDelta {
  previous ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
  return {
    inputTokens: previous.inputTokens + delta.inputTokens,
    outputTokens: previous.outputTokens + delta.outputTokens,
    cacheReadTokens: previous.cacheReadTokens + delta.cacheReadTokens,
    cacheCreateTokens: previous.cacheCreateTokens + delta.cacheCreateTokens,
    ...(previous.credits || delta.credits ? { credits: (previous.credits ?? 0) + (delta.credits ?? 0) } : {}),
    ...(previous.partialUsage || delta.partialUsage ? { partialUsage: true } : {}),
    ...(previous.partial_usage || delta.partial_usage ? { partial_usage: true } : {}),
  };
}

export function buildInitialRunState(mode: RunMode = "scan"): RunState {
  return {
    reconnecting: false,
    reconnects: 0,
    status: "connecting",
    steps: stepsFor(mode).map((name) => ({ name, status: "pending" as StepStatus })),
    assistantText: "",
    toolLog: [],
    timeline: [],
    findings: [],
    hasUsage: false,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    },
    phaseUsage: {},
    artifacts: [],
    round: 1,
  };
}

// Kept exported for components that want a placeholder before run starts.
export const initialRunState: RunState = buildInitialRunState("scan");

// Run is finished (completed / failed / expired / aborted). After this point
// any further events the backend replays (e.g. EventSource auto-reconnect
// resurfacing the buffered tail) must NOT be re-appended to timeline/toolLog
// arrays — that's what produced the "Reasoning turns keeps climbing
// after 100%" double-count.
function isTerminalStatus(s: RunStatus): boolean {
  return s === "completed" || s === "failed" || s === "aborted" || s === "stopped";
}

export function reduceRunEvent(state: RunState, ev: RunEvent): RunState {
  // Idempotency guard for post-terminal events. We still let `run_status` and
  // `run_finished` flow through (the user may want to see a status update
  // from a late event), but accumulators stay frozen.
  if (
    isTerminalStatus(state.status) &&
    ev.type !== "run_status" && ev.type !== "run_finished" && ev.type !== "push_result"
  ) {
    return state;
  }
  switch (ev.type) {
    case "run_status":
      return { ...state, status: ev.status, error: ev.error ?? state.error };

    case "step_started":
      return {
        ...state,
        steps: state.steps.map((s) => s.name === ev.step ? { ...s, status: "in_progress", startedAt: ev.ts ?? Date.now() } : s),
      };

    case "step_completed":
      return {
        ...state,
        steps: state.steps.map((s) => s.name === ev.step ? { ...s, status: ev.status } : s),
      };

    case "tool_invoked":
      return {
        ...state,
        toolLog: state.toolLog.concat({ ts: ev.ts ?? Date.now(), tool: ev.tool, input: ev.input }),
        timeline: state.timeline.concat({ tool: state.toolLog.length }),
      };

    case "tool_completed": {
      // Annotate the most recent matching tool entry without a completion.
      const log = [...state.toolLog];
      for (let i = log.length - 1; i >= 0; i--) {
        if (log[i].tool === ev.tool && log[i].ok === undefined) {
          log[i] = { ...log[i], ok: ev.ok, summary: ev.summary, durationMs: duration(log[i].ts, ev.ts ?? Date.now()) };
          break;
        }
      }
      return { ...state, toolLog: log };
    }

    case "assistant_text": {
      // Concatenate with a separator between blocks so consecutive text
      // chunks from the same assistant turn still render as continuous
      // paragraphs in markdown, while distinct turns get a blank line.
      const sep = state.assistantText.length > 0 ? "\n\n" : "";
      return { ...state, assistantText: state.assistantText + sep + ev.text };
    }

    case "thinking_emitted":
      return { ...state, timeline: state.timeline.concat({ thinking: ev.text, ts: ev.ts ?? Date.now() }) };

    case "finding_emitted":
      return { ...state, findings: state.findings.concat(ev.finding) };

    case "usage_delta": {
      return {
        ...state,
        hasUsage: true,
        usage: addUsage(state.hasUsage ? state.usage : undefined, ev.usage),
        phaseUsage: ev.phase ? { ...state.phaseUsage, [ev.phase]: addUsage(state.phaseUsage[ev.phase], ev.usage) } : state.phaseUsage,
      };
    }

    case "artifact_ready":
      return { ...state, artifacts: state.artifacts.concat({ kind: ev.kind, url: ev.url }) };

    case "run_finished":
      return {
        ...state,
        status: ev.status,
        reconnecting: false,
        error: ev.error ?? state.error,
      };

    case "run_phase":
      return { ...state, phase: ev.phase };

    case "round_started":
      // A new query() round began — advance the round counter, and let
      // scanning status / step updates flow normally.
      return { ...state, round: ev.round };

    case "push_result":
      return ev.ok
        ? { ...state, pushBranch: ev.branch, prUrl: ev.prUrl, pushError: undefined }
        : { ...state, pushError: ev.error ?? "push failed" };
  }
}

function duration(start: number | undefined, end: number | undefined): number | undefined {
  return start !== undefined && end !== undefined ? end - start : undefined;
}

export interface UseRunEventsOptions {
  EventSourceCtor?: typeof EventSource;
  mode?: RunMode;          // selects the checklist step list
}

export function useRunEvents(runId: string, options: UseRunEventsOptions = {}): RunState {
  const [state, setState] = useState<RunState>(() => buildInitialRunState(options.mode));

  useEffect(() => {
    setState(buildInitialRunState(options.mode));
    const Ctor = options.EventSourceCtor ?? (typeof EventSource !== "undefined" ? EventSource : undefined);
    if (!Ctor) return;
    const es = new Ctor(`/api/runs/${encodeURIComponent(runId)}/events`);
    let opened = false
    es.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data) as RunEvent;
        setState((prev) => {
          const next = reduceRunEvent(prev, ev);
          // The final frame can carry an error absent from the preceding status.
          if (ev.type === "run_finished") {
            es.close();
          }
          return next;
        });
      } catch {
        // malformed line — ignore
      }
    };
    es.onerror = () => {
      setState((prev) =>
        isTerminalStatus(prev.status)
          ? prev
          : { ...prev, reconnecting: es.readyState !== 2, error: es.readyState === 2 ? "event stream closed" : undefined },
      );
    };
    es.onopen = () => {
      const reconnect = opened
      opened = true
      // Connections replay the available history. Rebuild accumulators without keeping raw events.
      setState(prev => ({ ...buildInitialRunState(options.mode), reconnects: prev.reconnects + Number(reconnect) }))
    };
    return () => es.close();
  }, [runId, options.EventSourceCtor, options.mode]);

  return state;
}

export function parseEventsLog(text: string, mode: RunMode = "scan"): {
  toolLog: ToolLogEntry[];
  timeline: TimelineEntry[];
  steps: StepProgress[];
} {
  const toolLog: ToolLogEntry[] = [];
  const timeline: TimelineEntry[] = [];
  const stepNames = stepsFor(mode);
  const steps: StepProgress[] = stepNames.map((name) => ({ name, status: "pending" as StepStatus }));

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const ev = JSON.parse(trimmed) as RunEvent;
      if (ev.type === "tool_invoked") {
        timeline.push({ tool: toolLog.length });
        toolLog.push({ ts: ev.ts, tool: ev.tool, input: ev.input });
      } else if (ev.type === "tool_completed") {
        for (let i = toolLog.length - 1; i >= 0; i--) {
          if (toolLog[i].tool === ev.tool && toolLog[i].ok === undefined) {
            toolLog[i] = { ...toolLog[i], ok: ev.ok, summary: ev.summary, durationMs: duration(toolLog[i].ts, ev.ts) };
            break;
          }
        }
      } else if (ev.type === "thinking_emitted") {
        if (ev.text) timeline.push({ thinking: ev.text, ts: ev.ts });
      } else if (ev.type === "step_started") {
        const s = steps.find((x) => x.name === ev.step);
        if (s) { s.status = "in_progress"; s.startedAt = ev.ts ?? Date.now(); }
      } else if (ev.type === "step_completed") {
        const s = steps.find((x) => x.name === ev.step);
        if (s) s.status = ev.status;
      }
    } catch {
      // ignore malformed line
    }
  }
  return { toolLog, timeline, steps };
}
