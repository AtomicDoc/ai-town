// Decision policy. Milestone 3: the core of the hybrid architecture.
//
// Routine behavior (work shifts, deliveries, restocking, eating, shopping,
// wandering) is always scripted and never calls the LLM. Unusual events are
// queued on the agent and handed to this policy, which decides who chooses the
// response:
//
//   policy       routine     unusual events
//   ----------   ---------   ---------------------------------------------
//   traditional  scripted    scripted fallback choice           (config A)
//   hybrid       scripted    LLM picks from a small menu         (config D)
//   llm-heavy    (M5)        LLM picks from a small menu         (config C)
//
// Set with: npx convex env set DECISION_POLICY hybrid|traditional|llm-heavy
//
// An LLM decision is one short multiple-choice completion (~10 output tokens);
// the engine then carries out the choice with scripted mechanics (start a
// conversation, walk away, steal a loaf, ...). Every decision, scripted or
// LLM, is logged to the `decisions` table.
//
// Pure; keep free of server-only imports (the frontend bundles agent.ts).

import { Infer, v } from 'convex/values';
import { GAME_DAY_LENGTH } from '../constants';
import { playerId } from './ids';
import { itemKind } from './inventory';

// ---------------------------------------------------------------------------
// Events and choices
// ---------------------------------------------------------------------------

export const eventKind = v.union(
  v.literal('robbed'),
  v.literal('witnessedTheft'),
  v.literal('brokeAndHungry'),
  v.literal('playerApproach'),
);
export type EventKind = Infer<typeof eventKind>;

export const serializedEvent = v.object({
  kind: eventKind,
  at: v.number(),
  /** The other person involved: the thief, or the approaching player. */
  subject: v.optional(playerId),
  victim: v.optional(playerId),
  item: v.optional(itemKind),
});
export type AgentEvent = Infer<typeof serializedEvent>;

export const decisionChoice = v.union(
  v.literal('confront'),
  v.literal('warnOthers'),
  v.literal('avoid'),
  v.literal('ignore'),
  v.literal('askForHelp'),
  v.literal('steal'),
  v.literal('wait'),
  v.literal('greet'),
  v.literal('wave'),
);
export type DecisionChoice = Infer<typeof decisionChoice>;

/** Menu offered for each event, and the scripted choice (config A / LLM failure). */
export const EVENT_OPTIONS: Record<
  EventKind,
  { options: DecisionChoice[]; fallback: DecisionChoice }
> = {
  robbed: { options: ['confront', 'warnOthers', 'avoid', 'ignore'], fallback: 'confront' },
  witnessedTheft: { options: ['confront', 'warnOthers', 'ignore'], fallback: 'warnOthers' },
  brokeAndHungry: { options: ['askForHelp', 'steal', 'wait'], fallback: 'askForHelp' },
  playerApproach: { options: ['greet', 'wave', 'ignore'], fallback: 'wave' },
};

/** What each option means, as shown to the LLM. */
export const CHOICE_DESCRIPTIONS: Record<DecisionChoice, string> = {
  confront: 'go up to {subject} and have it out with them',
  warnOthers: 'go and tell someone else what happened',
  avoid: 'keep your distance from {subject}',
  ignore: 'let it go and carry on with your day',
  askForHelp: 'find someone and ask them to help you get food',
  steal: 'take a loaf of bread from the shop without paying',
  wait: 'go hungry for now and hope things improve',
  greet: 'start a conversation with {subject}',
  wave: 'give {subject} a friendly wave and carry on',
};

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export type PolicyMode = 'hybrid' | 'traditional' | 'llm-heavy';
export const POLICY_MODES: readonly PolicyMode[] = ['hybrid', 'traditional', 'llm-heavy'];

/** Policy mode from the DECISION_POLICY env var (default: hybrid). */
export function policyMode(): PolicyMode {
  const raw = typeof process !== 'undefined' ? process.env?.DECISION_POLICY : undefined;
  return (POLICY_MODES as readonly string[]).includes(raw ?? '') ? (raw as PolicyMode) : 'hybrid';
}

export type PolicyDecision =
  | { mode: 'scripted'; choice: DecisionChoice }
  | { mode: 'llm'; options: DecisionChoice[] };

/** Decide who chooses the response to an unusual event. */
export function decide(event: AgentEvent, mode: PolicyMode): PolicyDecision {
  const spec = EVENT_OPTIONS[event.kind];
  if (mode === 'traditional') {
    return { mode: 'scripted', choice: spec.fallback };
  }
  return { mode: 'llm', options: spec.options };
}

// ---------------------------------------------------------------------------
// Event queue (stored on the agent)
// ---------------------------------------------------------------------------

/** Events older than this are dropped unhandled (the moment has passed). */
export const EVENT_TTL = GAME_DAY_LENGTH / 4;
export const MAX_PENDING_EVENTS = 5;

type EventQueue = { pendingEvents?: AgentEvent[] };

/** Queue an event unless the same kind about the same subject is already queued. */
export function enqueueEvent(agent: EventQueue, event: AgentEvent): boolean {
  const queue = agent.pendingEvents ?? [];
  if (queue.some((e) => e.kind === event.kind && e.subject === event.subject)) {
    return false;
  }
  agent.pendingEvents = [...queue, event].slice(-MAX_PENDING_EVENTS);
  return true;
}

/** Remove and return the oldest unexpired event, dropping expired ones. */
export function takeNextEvent(agent: EventQueue, now: number): AgentEvent | undefined {
  const fresh = (agent.pendingEvents ?? []).filter((e) => now - e.at < EVENT_TTL);
  const next = fresh.shift();
  agent.pendingEvents = fresh.length ? fresh : undefined;
  return next;
}

// ---------------------------------------------------------------------------
// LLM prompt and reply parsing
// ---------------------------------------------------------------------------

export function describeEvent(event: AgentEvent, nameOf: (id: string) => string): string {
  const subject = event.subject ? nameOf(event.subject) : 'someone';
  const item = event.item ?? 'something';
  switch (event.kind) {
    case 'robbed':
      return `${subject} just stole ${item} from you.`;
    case 'witnessedTheft':
      return `You just saw ${subject} steal ${item} from ${
        event.victim ? nameOf(event.victim) : 'someone'
      }.`;
    case 'brokeAndHungry':
      return `You are hungry, you have no bread left, and you can't afford to buy any.`;
    case 'playerApproach':
      return `${subject} just walked up to you.`;
  }
}

export function decisionPrompt(args: {
  name: string;
  identity: string;
  context: string[];
  event: string;
  options: DecisionChoice[];
  subjectName?: string;
}): { role: 'system' | 'user'; content: string }[] {
  const subject = args.subjectName ?? 'them';
  const menu = args.options.map(
    (o) => `- ${o}: ${CHOICE_DESCRIPTIONS[o].replace('{subject}', subject)}`,
  );
  return [
    {
      role: 'system',
      content: [
        `You are ${args.name}. ${args.identity}`,
        ...args.context,
        `Something just happened: ${args.event}`,
        `Decide what you do next, staying true to your personality. Choose exactly one option:`,
        ...menu,
        `Reply with only the option name.`,
      ].join('\n'),
    },
    { role: 'user', content: 'Your choice:' },
  ];
}

function optionPatterns(option: string): string[] {
  const spaced = option.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return [option.toLowerCase(), spaced];
}

/**
 * Pick the option the reply names first (case-insensitive; "warnOthers" also
 * matches "warn others"). Undefined if the reply names none of them.
 */
export function parseChoice(reply: string, options: DecisionChoice[]): DecisionChoice | undefined {
  const text = reply.toLowerCase();
  let best: { option: DecisionChoice; index: number } | undefined;
  for (const option of options) {
    for (const pattern of optionPatterns(option)) {
      const match = new RegExp(`\\b${pattern}\\b`).exec(text);
      if (match && (!best || match.index < best.index)) {
        best = { option, index: match.index };
      }
    }
  }
  return best?.option;
}
