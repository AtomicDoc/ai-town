// Builds an LlmTrace that records each LLM call into the `llmCalls` table
// (convex/metrics.ts). Metrics must never break gameplay, so write failures
// are logged and swallowed.

import { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { LlmCallRecord, LlmTrace } from './llm';

export type LlmPurpose =
  | 'conversation.start'
  | 'conversation.continue'
  | 'conversation.leave'
  | 'memory.summary'
  | 'memory.importance'
  | 'memory.reflection'
  | 'embedding.memory'
  | 'embedding.query'
  | 'test';

export function llmTrace(ctx: ActionCtx, purpose: LlmPurpose, playerId?: string): LlmTrace {
  return {
    purpose,
    playerId,
    record: async (row: LlmCallRecord) => {
      const experiment = process.env.EXPERIMENT_CONFIG;
      const runId = process.env.EXPERIMENT_RUN_ID;
      console.log(
        `[llm] ${row.kind} ${row.purpose} ${row.durationMs}ms` +
          `${row.promptTokens !== undefined ? ` in=${row.promptTokens}` : ''}` +
          `${row.completionTokens !== undefined ? ` out=${row.completionTokens}` : ''}` +
          `${row.ok ? '' : ' FAILED'}`,
      );
      try {
        await ctx.runMutation(internal.metrics.recordLlmCall, {
          ...row,
          ...(experiment ? { experiment } : {}),
          ...(runId ? { runId } : {}),
        });
      } catch (e) {
        console.error(`[llm] failed to record metrics: ${String(e)}`);
      }
    },
  };
}
