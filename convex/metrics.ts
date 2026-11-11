// Experiment metrics. Milestone 4.
//
// Every LLM call (chat or embedding) can record a row in `llmCalls`: what it
// was for, which player it served, latency, retries, and token counts. This is
// the data behind "routine behavior makes zero LLM calls" (M3) and the
// latency/throughput comparisons across configurations (M5/M6).
//
// The table is separate from game state and is not touched by the vacuum cron.
// Export with:
//   npx convex data llmCalls --limit 100000 --format jsonl > experiments/llm-calls.jsonl
// Summarize with:
//   npx convex run metrics:summary '{"sinceMinutes": 30}'
//
// Tag runs by setting env vars on the deployment before starting:
//   npx convex env set EXPERIMENT_CONFIG D
//   npx convex env set EXPERIMENT_RUN_ID d-20npc-run1

import { defineTable } from 'convex/server';
import { Infer, v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';

export const llmCallFields = {
  kind: v.union(v.literal('chat'), v.literal('embedding')),
  /** Why the call was made, e.g. 'conversation.continue', 'memory.importance'. */
  purpose: v.string(),
  /** Player the call was made for, if any. */
  playerId: v.optional(v.string()),
  model: v.string(),
  startedAt: v.number(),
  /** Wall-clock time including retries. */
  durationMs: v.number(),
  retries: v.number(),
  promptTokens: v.optional(v.number()),
  completionTokens: v.optional(v.number()),
  /** Embedding batch size. */
  inputs: v.optional(v.number()),
  ok: v.boolean(),
  error: v.optional(v.string()),
  /** Experiment labels from EXPERIMENT_CONFIG / EXPERIMENT_RUN_ID. */
  experiment: v.optional(v.string()),
  runId: v.optional(v.string()),
};
const llmCallValidator = v.object(llmCallFields);
export type LlmCallRow = Infer<typeof llmCallValidator>;

export const metricsTables = {
  llmCalls: defineTable(llmCallFields)
    .index('startedAt', ['startedAt'])
    .index('runId', ['runId', 'startedAt']),
};

export const recordLlmCall = internalMutation({
  args: llmCallFields,
  handler: async (ctx, args) => {
    await ctx.db.insert('llmCalls', args);
  },
});

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export type PurposeSummary = {
  purpose: string;
  kind: 'chat' | 'embedding';
  calls: number;
  failed: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  promptTokens: number;
  completionTokens: number;
};

/** Nearest-rank percentile of an ascending-sorted array. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

export function summarizeCalls(
  rows: Pick<
    LlmCallRow,
    'kind' | 'purpose' | 'durationMs' | 'ok' | 'promptTokens' | 'completionTokens'
  >[],
): { total: number; failed: number; byPurpose: PurposeSummary[] } {
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.kind}:${row.purpose}`;
    const group = groups.get(key);
    if (group) {
      group.push(row);
    } else {
      groups.set(key, [row]);
    }
  }
  const byPurpose: PurposeSummary[] = [];
  for (const group of groups.values()) {
    const durations = group.map((r) => r.durationMs).sort((a, b) => a - b);
    const sum = durations.reduce((a, b) => a + b, 0);
    byPurpose.push({
      purpose: group[0].purpose,
      kind: group[0].kind,
      calls: group.length,
      failed: group.filter((r) => !r.ok).length,
      meanMs: Math.round(sum / group.length),
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      maxMs: durations[durations.length - 1],
      promptTokens: group.reduce((a, r) => a + (r.promptTokens ?? 0), 0),
      completionTokens: group.reduce((a, r) => a + (r.completionTokens ?? 0), 0),
    });
  }
  byPurpose.sort((a, b) => b.calls - a.calls);
  return {
    total: rows.length,
    failed: rows.filter((r) => !r.ok).length,
    byPurpose,
  };
}

// npx convex run metrics:summary '{"sinceMinutes": 30}'
// npx convex run metrics:summary '{"runId": "d-20npc-run1"}'
export const summary = internalQuery({
  args: {
    sinceMinutes: v.optional(v.number()),
    runId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const since = Date.now() - (args.sinceMinutes ?? 60) * 60_000;
    const rows = args.runId
      ? await ctx.db
          .query('llmCalls')
          .withIndex('runId', (q) => q.eq('runId', args.runId))
          .collect()
      : await ctx.db
          .query('llmCalls')
          .withIndex('startedAt', (q) => q.gte('startedAt', since))
          .collect();
    return {
      window: args.runId ? `runId ${args.runId}` : `last ${args.sinceMinutes ?? 60} min`,
      ...summarizeCalls(rows),
    };
  },
});
