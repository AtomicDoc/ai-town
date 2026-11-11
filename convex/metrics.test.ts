import { jest } from '@jest/globals';
import { percentile, summarizeCalls } from './metrics';
import { LlmCallRecord, chatCompletion } from './util/llm';

describe('percentile', () => {
  test('nearest rank', () => {
    const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(100);
    expect(percentile(xs, 0)).toBe(10);
    expect(percentile([], 50)).toBe(0);
  });
});

describe('summarizeCalls', () => {
  test('groups by kind and purpose with latency and token totals', () => {
    const rows = [
      {
        kind: 'chat' as const,
        purpose: 'conversation.continue',
        durationMs: 1000,
        ok: true,
        promptTokens: 100,
        completionTokens: 20,
      },
      {
        kind: 'chat' as const,
        purpose: 'conversation.continue',
        durationMs: 3000,
        ok: true,
        promptTokens: 120,
        completionTokens: 30,
      },
      { kind: 'chat' as const, purpose: 'conversation.continue', durationMs: 2000, ok: false },
      { kind: 'embedding' as const, purpose: 'embedding.query', durationMs: 50, ok: true },
    ];
    const s = summarizeCalls(rows);
    expect(s.total).toBe(4);
    expect(s.failed).toBe(1);
    expect(s.byPurpose[0]).toEqual({
      purpose: 'conversation.continue',
      kind: 'chat',
      calls: 3,
      failed: 1,
      meanMs: 2000,
      p50Ms: 2000,
      p95Ms: 3000,
      maxMs: 3000,
      promptTokens: 220,
      completionTokens: 50,
    });
    expect(s.byPurpose[1].purpose).toBe('embedding.query');
  });

  test('empty input', () => {
    expect(summarizeCalls([])).toEqual({ total: 0, failed: 0, byPurpose: [] });
  });
});

describe('chatCompletion tracing', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  function trace(records: LlmCallRecord[]) {
    return {
      purpose: 'conversation.start',
      playerId: 'p:2',
      record: async (row: LlmCallRecord) => {
        records.push(row);
      },
    };
  }

  test('records purpose, player, model and token usage on success', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'Hello Lucky' } }],
        usage: { prompt_tokens: 321, completion_tokens: 12, total_tokens: 333 },
      }),
    })) as unknown as typeof fetch;
    const records: LlmCallRecord[] = [];
    const { content } = await chatCompletion(
      { messages: [{ role: 'user', content: 'hi' }], model: 'llama3.1:8b' },
      trace(records),
    );
    expect(content).toBe('Hello Lucky');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'chat',
      purpose: 'conversation.start',
      playerId: 'p:2',
      model: 'llama3.1:8b',
      promptTokens: 321,
      completionTokens: 12,
      retries: 0,
      ok: true,
    });
    expect(records[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  test('records a failed call and still throws', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => 'bad request',
    })) as unknown as typeof fetch;
    const records: LlmCallRecord[] = [];
    await expect(
      chatCompletion({ messages: [{ role: 'user', content: 'hi' }], model: 'm' }, trace(records)),
    ).rejects.toThrow('bad request');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ ok: false, purpose: 'conversation.start' });
    expect(records[0].error).toContain('400');
  });

  test('works without a trace', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    })) as unknown as typeof fetch;
    const { content } = await chatCompletion({ messages: [], model: 'm' });
    expect(content).toBe('ok');
  });
});
