/**
 * Cumulative token accounting, per model alias.
 *
 * Deliberately in-process and unpersisted. The goal is operational visibility —
 * "which alias is burning tokens?" — not billing. A restart resets the
 * counters, which is the honest trade for a routing layer that should stay
 * stateless; anything authoritative belongs in the provider's own billing data
 * or a metrics backend scraped from these numbers.
 *
 * Counts are attributed to the ALIAS the client requested, not the upstream
 * model that served it. With a fallback chain a single alias can be served by
 * several different models, and the question being answered is "what did this
 * alias cost me", so the alias is the right unit.
 */

export interface ModelUsage {
  /** Requests that reached an upstream and returned a usage-bearing response. */
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface UsageSnapshot {
  since: string;
  totals: ModelUsage;
  byModel: Record<string, ModelUsage>;
}

/** Token usage as reported by an upstream response body. */
export interface ReportedUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

const emptyUsage = (): ModelUsage => ({
  requests: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
});

export class UsageTracker {
  private readonly byModel = new Map<string, ModelUsage>();
  private readonly totals: ModelUsage = emptyUsage();
  private readonly startedAt: string;

  constructor(now: () => Date = () => new Date()) {
    this.startedAt = now().toISOString();
  }

  /** Record one request's usage against a model alias. */
  record(alias: string, usage: ReportedUsage): void {
    const entry = this.byModel.get(alias) ?? emptyUsage();

    entry.requests += 1;
    entry.promptTokens += usage.promptTokens;
    entry.completionTokens += usage.completionTokens;
    entry.totalTokens += usage.totalTokens;
    this.byModel.set(alias, entry);

    this.totals.requests += 1;
    this.totals.promptTokens += usage.promptTokens;
    this.totals.completionTokens += usage.completionTokens;
    this.totals.totalTokens += usage.totalTokens;
  }

  /** A point-in-time copy. Callers cannot mutate internal state through it. */
  snapshot(): UsageSnapshot {
    const byModel: Record<string, ModelUsage> = {};
    // Sorted by spend, so the expensive aliases are the ones you see first.
    const entries = [...this.byModel.entries()].sort(
      (a, b) => b[1].totalTokens - a[1].totalTokens,
    );
    for (const [alias, usage] of entries) byModel[alias] = { ...usage };

    return { since: this.startedAt, totals: { ...this.totals }, byModel };
  }
}

/**
 * Extract usage from an upstream response body.
 *
 * Returns undefined when the provider reported nothing usable, so callers can
 * distinguish "zero tokens" from "not reported" rather than silently recording
 * a request that consumed an unknown amount.
 */
export function extractUsage(body: unknown): ReportedUsage | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const usage = (body as Record<string, unknown>)['usage'];
  if (usage === null || typeof usage !== 'object') return undefined;

  const u = usage as Record<string, unknown>;
  const prompt = numeric(u['prompt_tokens']);
  const completion = numeric(u['completion_tokens']);
  const total = numeric(u['total_tokens']);

  if (prompt === undefined && completion === undefined && total === undefined) {
    return undefined;
  }

  const promptTokens = prompt ?? 0;
  const completionTokens = completion ?? 0;

  return {
    promptTokens,
    completionTokens,
    // Some providers omit the total; derive it rather than reporting zero.
    totalTokens: total ?? promptTokens + completionTokens,
  };
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
