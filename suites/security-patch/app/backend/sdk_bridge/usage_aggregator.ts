import type { UsageDelta } from "../../shared/types.ts";

interface SdkUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cached_input_tokens?: number;
  cache_creation_input_tokens?: number;
  credits?: number;
}

// Extracts the per-message usage from any SDKMessage. Different versions of
// the Agent SDK put it in slightly different places — try the obvious ones.
export function extractUsage(sdkMessage: unknown): SdkUsage | null {
  const m = sdkMessage as Record<string, unknown>;
  // assistant message: m.message.usage
  const msg = m?.message as Record<string, unknown> | undefined;
  if (msg && typeof msg.usage === "object") return msg.usage as SdkUsage;
  // result message: m.usage
  if (typeof m?.usage === "object") return m.usage as SdkUsage;
  return null;
}

export function deltaFromUsage(usage: SdkUsage): UsageDelta {
  const inputT = Math.max(0, (usage.input_tokens ?? 0) - (usage.cached_input_tokens ?? 0));
  const outputT = usage.output_tokens ?? 0;
  const cacheReadT = usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? 0;
  const cacheCreateT = usage.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: inputT,
    outputTokens: outputT,
    cacheReadTokens: cacheReadT,
    cacheCreateTokens: cacheCreateT,
    ...(typeof usage.credits === "number" && Number.isFinite(usage.credits) && usage.credits > 0 ? { credits: usage.credits } : {}),
  };
}

export class UsageAggregator {
  private totals: UsageDelta = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
  };

  add(delta: UsageDelta): void {
    this.totals.inputTokens       += delta.inputTokens;
    this.totals.outputTokens      += delta.outputTokens;
    this.totals.cacheReadTokens   += delta.cacheReadTokens;
    this.totals.cacheCreateTokens += delta.cacheCreateTokens;
    if (delta.credits) this.totals.credits = (this.totals.credits ?? 0) + delta.credits;
  }

  snapshot(): UsageDelta {
    return { ...this.totals };
  }
}
