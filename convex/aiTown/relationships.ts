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
): Belief[] {
  const learned: Belief[] = [];
  for (const belief of speaker.beliefs ?? []) {
    if (belief.thief === listenerId) {
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

/** One-sentence description of a belief from the holder's point of view. */
export function describeBelief(
  belief: Belief,
  selfId: string,
  nameOf: (id: string) => string,
): string {
  const thief = belief.thief === selfId ? 'you' : nameOf(belief.thief);
  const victim = belief.victim === selfId ? 'you' : nameOf(belief.victim);
  const what = `${thief} stole ${belief.quantity} ${belief.item} from ${victim}`;
  if (belief.source === 'witnessed') {
    return `You saw ${what}.`;
  }
  return `${belief.toldBy ? nameOf(belief.toldBy) : 'Someone'} told you that ${what}.`;
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
): { witnesses: string[]; victimSaw: boolean } {
  const thief = game.world.players.get(thiefId as GameId<'players'>);
  if (!thief) {
    return { witnesses: [], victimSaw: false };
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
  const seen = witnessesAt(game, thief.position, [thiefId]);
  const witnesses: string[] = [];
  let victimSaw = false;
  for (const agent of seen) {
    addBelief(agent, belief);
    if (agent.playerId === victimId) {
      victimSaw = true;
      adjustOpinion(agent, thiefId, OPINION_DELTAS.stolenFrom);
    } else {
      witnesses.push(agent.playerId);
      adjustOpinion(agent, thiefId, OPINION_DELTAS.witnessedTheft);
    }
  }
  return { witnesses, victimSaw };
}
