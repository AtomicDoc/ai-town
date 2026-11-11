import {
  AgentEvent,
  EVENT_OPTIONS,
  EVENT_TTL,
  MAX_PENDING_EVENTS,
  decide,
  decisionPrompt,
  describeEvent,
  enqueueEvent,
  parseChoice,
  policyMode,
  takeNextEvent,
} from './decisionPolicy';
import { summarizeDecisions } from '../metrics';
import { brokeAndHungryDue, EAT_AT } from './needs';
import { PRICES } from './economy';

const names: Record<string, string> = { 'p:1': 'Traveler', 'p:2': 'Alice', 'p:3': 'Lucky' };
const nameOf = (id: string) => names[id] ?? id;
const robbed: AgentEvent = {
  kind: 'robbed',
  at: 1000,
  subject: 'p:1' as AgentEvent['subject'],
  item: 'bread',
};

describe('policy', () => {
  test('hybrid and llm-heavy hand unusual events to the LLM with the menu', () => {
    expect(decide(robbed, 'hybrid')).toEqual({
      mode: 'llm',
      options: EVENT_OPTIONS.robbed.options,
    });
    expect(decide(robbed, 'llm-heavy').mode).toBe('llm');
  });

  test('traditional uses the scripted fallback', () => {
    expect(decide(robbed, 'traditional')).toEqual({ mode: 'scripted', choice: 'confront' });
    expect(decide({ kind: 'playerApproach', at: 0 }, 'traditional')).toEqual({
      mode: 'scripted',
      choice: 'wave',
    });
  });

  test('every fallback is one of its own options', () => {
    for (const spec of Object.values(EVENT_OPTIONS)) {
      expect(spec.options).toContain(spec.fallback);
    }
  });

  test('policyMode reads DECISION_POLICY, defaulting to hybrid', () => {
    const old = process.env.DECISION_POLICY;
    process.env.DECISION_POLICY = 'traditional';
    expect(policyMode()).toBe('traditional');
    process.env.DECISION_POLICY = 'nonsense';
    expect(policyMode()).toBe('hybrid');
    delete process.env.DECISION_POLICY;
    expect(policyMode()).toBe('hybrid');
    if (old !== undefined) process.env.DECISION_POLICY = old;
  });
});

describe('event queue', () => {
  test('dedupes by kind and subject, caps the queue', () => {
    const agent: { pendingEvents?: AgentEvent[] } = {};
    expect(enqueueEvent(agent, robbed)).toBe(true);
    expect(enqueueEvent(agent, { ...robbed, at: 2000 })).toBe(false);
    for (let i = 0; i < 10; i++) {
      enqueueEvent(agent, { kind: 'playerApproach', at: i, subject: `p:${10 + i}` as any });
    }
    expect(agent.pendingEvents).toHaveLength(MAX_PENDING_EVENTS);
  });

  test('drops legacy playerApproach events from saved queues', () => {
    const agent: { pendingEvents?: AgentEvent[] } = {
      pendingEvents: [
        { kind: 'playerApproach', at: 100, subject: 'p:1' as any },
        { ...robbed, at: 200 },
      ],
    };
    expect(takeNextEvent(agent, 300)).toEqual({ ...robbed, at: 200 });
    expect(takeNextEvent(agent, 300)).toBeUndefined();
  });

  test('helped and interfered have direct-interaction menus', () => {
    expect(decide({ kind: 'helped', at: 0 }, 'traditional')).toEqual({
      mode: 'scripted',
      choice: 'thank',
    });
    expect(decide({ kind: 'interfered', at: 0 }, 'hybrid')).toEqual({
      mode: 'llm',
      options: ['confront', 'avoid', 'ignore'],
    });
    expect(describeEvent({ kind: 'helped', at: 0, subject: 'p:1' as any }, nameOf)).toBe(
      'Traveler just pitched in and helped you finish your work.',
    );
  });

  test('takes oldest first and drops expired events', () => {
    const agent: { pendingEvents?: AgentEvent[] } = {
      pendingEvents: [
        { kind: 'brokeAndHungry', at: 0 },
        { ...robbed, at: EVENT_TTL },
      ],
    };
    const now = EVENT_TTL + 10;
    expect(takeNextEvent(agent, now)).toEqual({ ...robbed, at: EVENT_TTL });
    expect(takeNextEvent(agent, now)).toBeUndefined();
    expect(agent.pendingEvents).toBeUndefined();
  });
});

describe('LLM prompt and parsing', () => {
  test('describeEvent', () => {
    expect(describeEvent(robbed, nameOf)).toBe('Traveler just stole bread from you.');
    expect(describeEvent({ ...robbed, kind: 'witnessedTheft', victim: 'p:2' as any }, nameOf)).toBe(
      'You just saw Traveler steal bread from Alice.',
    );
    expect(describeEvent({ kind: 'playerApproach', at: 0, subject: 'p:1' as any }, nameOf)).toBe(
      'Traveler just walked up to you.',
    );
  });

  test('prompt lists the menu with the subject filled in', () => {
    const [system] = decisionPrompt({
      name: 'Alice',
      identity: 'Alice is the village baker.',
      context: ['It is 08:00 (morning) in the village.'],
      event: 'Traveler just stole bread from you.',
      options: EVENT_OPTIONS.robbed.options,
      subjectName: 'Traveler',
    });
    expect(system.content).toContain('- confront: go up to Traveler and have it out with them');
    expect(system.content).toContain('- avoid: keep your distance from Traveler');
    expect(system.content).toContain('Reply with only the option name.');
  });

  test('parseChoice handles plain, spaced, and chatty replies', () => {
    const opts = EVENT_OPTIONS.robbed.options;
    expect(parseChoice('confront', opts)).toBe('confront');
    expect(parseChoice('WarnOthers', opts)).toBe('warnOthers');
    expect(parseChoice('I will warn others about this.', opts)).toBe('warnOthers');
    expect(parseChoice('Ignore. Actually, confront.', opts)).toBe('ignore');
    expect(parseChoice('I would steal it back', opts)).toBeUndefined();
  });
});

describe('triggers and summaries', () => {
  test('brokeAndHungry: hungry, no bread, cannot afford, not too often', () => {
    const needs = { lastAteAt: 0 };
    expect(brokeAndHungryDue(needs, EAT_AT, 0, PRICES.bread - 1, 1000)).toBe(true);
    expect(brokeAndHungryDue(needs, EAT_AT, 1, 0, 1000)).toBe(false);
    expect(brokeAndHungryDue(needs, EAT_AT, 0, PRICES.bread, 1000)).toBe(false);
    expect(brokeAndHungryDue(needs, EAT_AT - 1, 0, 0, 1000)).toBe(false);
    expect(brokeAndHungryDue({ ...needs, lastBrokeEventAt: 999 }, EAT_AT, 0, 0, 1000)).toBe(false);
  });

  test('summarizeDecisions splits routine and event decisions by mode', () => {
    const s = summarizeDecisions([
      { trigger: 'routine.startTask', mode: 'scripted', choice: 'startTask' },
      { trigger: 'routine.startTask', mode: 'scripted', choice: 'startTask' },
      { trigger: 'routine.eat', mode: 'scripted', choice: 'eat' },
      { trigger: 'event.robbed', mode: 'llm', choice: 'confront' },
      { trigger: 'event.robbed', mode: 'llm-fallback', choice: 'confront' },
    ]);
    expect(s.total).toBe(5);
    expect(s.llm).toBe(2);
    expect(s.llmShare).toBe(0.4);
    expect(s.byTrigger[0]).toMatchObject({ trigger: 'routine.startTask', scripted: 2, llm: 0 });
    expect(s.byTrigger.find((t) => t.trigger === 'event.robbed')).toMatchObject({
      llm: 1,
      llmFallback: 1,
      choices: { confront: 2 },
    });
  });
});
