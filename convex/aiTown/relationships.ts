// Relationships and beliefs. Milestone 2.
//
// Each agent holds:
//   - opinions: a score in [-100, 100] about other players (NPCs or humans),
//     nudged by trades, help, interference, and theft;
//   - beliefs: things it believes happened, currently thefts. A belief is either
//     first-hand ('witnessed') or second-hand ('told', with who told them).
//
// Belief propagation (the thesis's demonstrated scenario):
//   witness sees a theft -> witness talks with another agent -> when that
//   conversation ends with real messages, the listener gains a second-hand
//   belief and a (smaller) opinion drop toward the thief.
// Conversation prompts include opinions and beliefs (socialPrompts), so the
// LLM can confront, gossip, or warn accordingly.
//
// Pure helpers plus small engine helpers. Keep free of server-only imports.

import { Infer, v } from 'convex/values';
import { GameId, playerId } from './ids';
import { ItemKind, itemKind } from './inventory';
import { distance } from '../util/geometry';
import type { Game } from './game';
import type { Agent } from './agent';
import type { Point } from '../util/types';

export const OPINION_MIN = -100;
export const OPINION_MAX = 100;
export const MAX_BELIEFS = 10;
/** Tiles within which an agent sees an action happen. */
export const WITNESS_RADIUS = 6;

export const OPINION_DELTAS = {
  trade: 1,
  helped: 10,
  interfered: -15,
  stolenFrom: -40,
  witnessedTheft: -20,
  heardAboutTheft: -10,
} as const;

export const serializedOpinion = v.object({ playerId, score: v.number() });
export type Opinion = Infer<typeof serializedOpinion>;

export const serializedBelief = v.object({
  kind: v.literal('theft'),
  thief: playerId,
  victim: playerId,
  item: itemKind,
  quantity: v.number(),
  /** When the theft happened (wall-clock ms). */
  at: v.number(),
  source: v.union(v.literal('witnessed'), v.literal('told')),
  /** Who passed the belief on, for second-hand beliefs. */
  toldBy: v.optional(playerId),
});
export type Belief = Infer<typeof serializedBelief>;

/** The social state an agent carries (a subset of Agent / SerializedAgent). */
export type Social = { opinions?: Opinion[]; beliefs?: Belief[] };

// ---------------------------------------------------------------------------
// Opinions
// ---------------------------------------------------------------------------

export function getOpinion(social: Social, about: string): number {
  return social.opinions?.find((o) => o.playerId === about)?.score ?? 0;
}

/** Change an opinion by `delta`, clamped to [-100, 100]. Returns the new score. */
export function adjustOpinion(social: Social, about: string, delta: number): number {
  if (!social.opinions) {
    social.opinions = [];
  }
  let opinion = social.opinions.find((o) => o.playerId === about);
  if (!opinion) {
    opinion = { playerId: about, score: 0 };
    social.opinions.push(opinion);
  }
  opinion.score = Math.max(OPINION_MIN, Math.min(OPINION_MAX, opinion.score + delta));
  return opinion.score;
}

/** Plain-language opinion for prompts, or undefined if neutral. */
export function opinionPhrase(name: string, score: number): string | undefined {
  if (score >= 40) return `You like ${name} a lot.`;
  if (score >= 15) return `You like ${name}.`;
  if (score <= -40) return `You strongly distrust ${name}.`;
  if (score <= -15) return `You distrust ${name}.`;
  return undefined;
}

// ---------------------------------------------------------------------------
// Beliefs
// ---------------------------------------------------------------------------

function sameEvent(a: Belief, b: Belief): boolean {
  return a.kind === b.kind && a.thief === b.thief && a.victim === b.victim && a.at === b.at;
}

export function hasBelief(social: Social, belief: Belief): boolean {
  return !!social.beliefs?.some((b) => sameEvent(b, belief));
}

/**
 * Add a belief unless the same event is already believed. Keeps the newest
 * MAX_BELIEFS. Returns true if it was new.
 */
export function addBelief(social: Social, belief: Belief): boolean {
  if (hasBelief(social, belief)) {
    return false;
  }
  social.beliefs = [...(social.beliefs ?? []), belief]
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_BELIEFS);
  return true;
}

/**
 * Pass the speaker's beliefs to the listener as second-hand beliefs. Skips
 * events the listener already knows and thefts the listener committed.
 * Applies the "heard about theft" opinion drop toward the thief. Returns the
 * beliefs the listener newly learned.
 */
export function shareBeliefs(
  speaker: Social,
  speakerId: string,
  listener: Social,
  listenerId: string,
  include: (belief: Belief) => boolean = () => true,
): Belief[] {
  const learned: Belief[] = [];
  for (const belief of speaker.beliefs ?? []) {
    if (belief.thief === listenerId || !include(belief)) {
      continue;
    }
    const secondHand: Belief = {
      ...belief,
      source: 'told',
      toldBy: speakerId as GameId<'players'>,
    };
    if (addBelief(listener, secondHand)) {
      adjustOpinion(listener, belief.thief, OPINION_DELTAS.heardAboutTheft);
      learned.push(secondHand);
    }
  }
  return learned;
}

/** Words that, next to the thief's name, count as talking about the theft. */
const THEFT_WORDS = [
  'steal',
  'stole',
  'stolen',
  'stealing',
  'theft',
  'thief',
  'thieves',
  'rob',
  'robbed',
  'robbing',
  'swiped',
  'pinched',
  'nicked',
  'pocketed',
];
/** Ambiguous verbs that only count when the victim or the item is named too. */
const WEAK_THEFT_WORDS = ['took', 'taken', 'grabbed', 'snatched'];

function containsWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

/**
 * Whether a line of dialogue tells someone about a theft. It must name the
 * thief and use a theft word ("stole", "thief", "robbed", ...); weaker verbs
 * like "took" count only if the victim or the item is named too. Names shorter
 * than 3 letters (e.g. the old default human name "Me") never match, to avoid
 * false positives on common words.
 */
export function mentionsTheft(
  text: string,
  thiefName: string,
  victimName: string,
  item: string,
): boolean {
  if (thiefName.length < 3 || !containsWord(text, thiefName)) {
    return false;
  }
  if (THEFT_WORDS.some((w) => containsWord(text, w))) {
    return true;
  }
  const namesVictimOrItem =
    (victimName.length >= 3 && containsWord(text, victimName)) || containsWord(text, item);
  return namesVictimOrItem && WEAK_THEFT_WORDS.some((w) => containsWord(text, w));
}

/**
 * Gossip from one line of dialogue: the listener learns each of the speaker's
 * beliefs that the line actually talks about. Returns what was learned.
 */
export function gossipFromLine(
  game: Game,
  speakerId: string,
  listenerId: string,
  text: string,
): Belief[] {
  const speaker = agentOfPlayer(game, speakerId);
  const listener = agentOfPlayer(game, listenerId);
  if (!speaker || !listener) {
    return [];
  }
  const nameOf = (id: string) => game.playerDescriptions.get(id as GameId<'players'>)?.name ?? '';
  return shareBeliefs(speaker, speakerId, listener, listenerId, (b) =>
    mentionsTheft(text, nameOf(b.thief), nameOf(b.victim), b.item),
  );
}

/** One-sentence description of a belief from the holder's point of view. */
export function describeBelief(
  belief: Belief,
  selfId: string,
  nameOf: (id: string) => string,
): string {
  const thief = belief.thief === selfId ? 'you' : nameOf(belief.thief);
  const victim = belief.victim === selfId ? 'you' : nameOf(belief.victim);
  const object = `${belief.quantity} ${belief.item} from ${victim}`;
  if (belief.source === 'witnessed') {
    // Victims always know they were robbed and by whom, seen or not.
    if (belief.victim === selfId) {
      return `${thief === 'you' ? 'You' : thief} stole ${object}.`;
    }
    return `You saw ${thief} steal ${object}.`;
  }
  const teller = belief.toldBy ? nameOf(belief.toldBy) : 'Someone';
  return `${teller} told you that ${thief} stole ${object}.`;
}

/**
 * Prompt lines about the conversation partner and what the agent believes.
 * Beliefs involving the partner come first; other beliefs are offered as news.
 */
export function socialPrompts(
  agent: Social,
  selfId: string,
  otherId: string,
  otherName: string,
  nameOf: (id: string) => string,
): string[] {
  const lines: string[] = [];
  const opinion = opinionPhrase(otherName, getOpinion(agent, otherId));
  if (opinion) {
    lines.push(opinion);
  }
  const beliefs = agent.beliefs ?? [];
  const aboutOther = beliefs.filter((b) => b.thief === otherId || b.victim === otherId);
  const news = beliefs.filter((b) => b.thief !== otherId && b.victim !== otherId);
  for (const b of aboutOther) {
    lines.push(describeBelief(b, selfId, nameOf));
  }
  if (news.length > 0) {
    const latest = news[news.length - 1];
    lines.push(
      `News you know: ${describeBelief(latest, selfId, nameOf)} You may bring it up if it fits the conversation.`,
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Engine helpers
// ---------------------------------------------------------------------------

export function agentOfPlayer(game: Game, id: string): Agent | undefined {
  for (const agent of game.world.agents.values()) {
    if (agent.playerId === id) {
      return agent;
    }
  }
  return undefined;
}

/** Both sides of a completed trade think slightly better of each other. */
export function noteTrade(game: Game, sellerId: string, buyerId: string) {
  const seller = agentOfPlayer(game, sellerId);
  const buyer = agentOfPlayer(game, buyerId);
  if (seller) adjustOpinion(seller, buyerId, OPINION_DELTAS.trade);
  if (buyer) adjustOpinion(buyer, sellerId, OPINION_DELTAS.trade);
}

/** Agents (other than `exclude`) close enough to `position` to see what happens there. */
export function witnessesAt(game: Game, position: Point, exclude: string[]): Agent[] {
  const witnesses: Agent[] = [];
  for (const agent of game.world.agents.values()) {
    if (exclude.includes(agent.playerId)) {
      continue;
    }
    const player = game.world.players.get(agent.playerId);
    if (player && distance(player.position, position) <= WITNESS_RADIUS) {
      witnesses.push(agent);
    }
  }
  return witnesses;
}

/** Record a theft: the victim (if nearby) and onlookers form first-hand beliefs. */
export function recordTheft(
  game: Game,
  now: number,
  thiefId: string,
  victimId: string,
  item: ItemKind,
  quantity: number,
): { witnesses: string[]; victimKnows: boolean } {
  const thief = game.world.players.get(thiefId as GameId<'players'>);
  if (!thief) {
    return { witnesses: [], victimKnows: false };
  }
  const belief: Belief = {
    kind: 'theft',
    thief: thiefId as GameId<'players'>,
    victim: victimId as GameId<'players'>,
    item,
    quantity,
    at: now,
    source: 'witnessed',
  };
  // The victim always knows they were robbed, and by whom, even if they were
  // away from their stall (a deliberate simplification for the study).
  const victim = agentOfPlayer(game, victimId);
  if (victim) {
    addBelief(victim, belief);
    adjustOpinion(victim, thiefId, OPINION_DELTAS.stolenFrom);
  }
  // Bystanders within sight form first-hand beliefs too.
  const witnesses: string[] = [];
  for (const agent of witnessesAt(game, thief.position, [thiefId, victimId])) {
    addBelief(agent, belief);
    adjustOpinion(agent, thiefId, OPINION_DELTAS.witnessedTheft);
    witnesses.push(agent.playerId);
  }
  return { witnesses, victimKnows: !!victim };
}
