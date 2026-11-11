// Free time (M5): named places, LLM-chosen idle activities for the
// "llm-heavy" policy (config C), and a short memory of recent actions.
//
// In llm-heavy mode, whenever an NPC is free, the LLM answers "where do you go
// and what do you do?" in its own words (e.g. "the west grove | reading a book
// under a tree | 📖"). The engine walks the NPC there and shows the activity
// for a minute. Activities have no game effect, but every NPC (in every mode)
// remembers its last few actions, and those go into its prompts.
//
// Pure helpers plus small engine helpers. Keep free of server-only imports.

import { Infer, v } from 'convex/values';
import { Point, point } from '../util/types';
import { distance } from '../util/geometry';
import { formatGameTime, gameHour } from './clock';
import { PLACES, Place } from './places';

export { PLACES };
export type { Place };

/** The named place closest to `position` (for recording where something happened). */
export function nearestPlace(position: Point): Place {
  return PLACES.reduce((best, p) =>
    distance(p.target, position) < distance(best.target, position) ? p : best,
  );
}

// ---------------------------------------------------------------------------
// Recent actions (all modes)
// ---------------------------------------------------------------------------

export const MAX_RECENT_ACTIONS = 5;
/** How many recent actions go into prompts. */
export const RECENT_ACTIONS_IN_PROMPT = 3;

export const serializedRecentAction = v.object({
  at: v.number(),
  description: v.string(),
  place: v.optional(v.string()),
});
export type RecentAction = Infer<typeof serializedRecentAction>;

type HasRecent = { recentActions?: RecentAction[] };

export function recordAction(agent: HasRecent, at: number, description: string, place?: string) {
  const entry: RecentAction = place ? { at, description, place } : { at, description };
  agent.recentActions = [...(agent.recentActions ?? []), entry].slice(-MAX_RECENT_ACTIONS);
}

/** "Recently you: read a book at the west grove (09:40); confronted Traveler (10:05)." */
export function recentActionsPrompt(agent: HasRecent): string | undefined {
  const recent = (agent.recentActions ?? []).slice(-RECENT_ACTIONS_IN_PROMPT);
  if (recent.length === 0) {
    return undefined;
  }
  const parts = recent.map(
    (a) => `${a.description}${a.place ? ` at ${a.place}` : ''} (${formatGameTime(gameHour(a.at))})`,
  );
  return `Recently you: ${parts.join('; ')}.`;
}

// ---------------------------------------------------------------------------
// LLM idle plan (config C)
// ---------------------------------------------------------------------------

/** How long a chosen idle activity lasts once the NPC gets there. */
export const IDLE_ACTIVITY_DURATION = 60_000;
export const MAX_ACTIVITY_LENGTH = 48;
export const DEFAULT_IDLE_EMOJI = '💭';

export const serializedIdlePlan = v.object({
  destination: point,
  place: v.string(),
  description: v.string(),
  emoji: v.string(),
  mode: v.union(v.literal('llm'), v.literal('llm-fallback')),
  latencyMs: v.number(),
});
export type IdlePlan = Infer<typeof serializedIdlePlan>;

export function idlePrompt(args: {
  name: string;
  identity: string;
  context: string[];
}): { role: 'system' | 'user'; content: string }[] {
  return [
    {
      role: 'system',
      content: [
        `You are ${args.name}. ${args.identity}`,
        ...args.context,
        `You have some free time right now. Staying true to your character and the time of day, decide where you go and what you do there.`,
        `Places you can go: ${PLACES.map((p) => p.name).join(', ')}.`,
        `Reply on one line in exactly this format: place | what you do (a few words, starting with a verb ending in -ing) | one emoji`,
        `Example: the west grove | reading a book under a tree | 📖`,
      ].join('\n'),
    },
    { role: 'user', content: 'Your plan:' },
  ];
}

const EMOJI = /\p{Extended_Pictographic}/u;

/**
 * Parse "place | activity | emoji". Unknown places fall back to `fallbackPlace`;
 * an unusable activity returns undefined (caller uses a scripted activity).
 */
export function parseIdlePlan(
  reply: string,
  fallbackPlace: Place,
): { place: Place; description: string; emoji: string } | undefined {
  const line = reply.split('\n').find((l) => l.includes('|')) ?? reply;
  const [rawPlace = '', rawActivity = '', rawEmoji = ''] = line.split('|').map((s) => s.trim());
  const lowered = rawPlace.toLowerCase();
  const place =
    PLACES.find((p) => lowered.includes(p.name.replace(/^the /, ''))) ??
    PLACES.find((p) => line.toLowerCase().includes(p.name.replace(/^the /, ''))) ??
    fallbackPlace;
  const description = rawActivity
    .replace(/^["'`*\s]+|["'`*.\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .slice(0, MAX_ACTIVITY_LENGTH)
    .trim();
  if (description.length < 3) {
    return undefined;
  }
  const emoji = (rawEmoji.match(EMOJI) ?? line.match(EMOJI))?.[0] ?? DEFAULT_IDLE_EMOJI;
  return { place, description, emoji };
}
