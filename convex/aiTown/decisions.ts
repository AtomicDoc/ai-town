// Engine side of the decision policy (M3): detects unusual events, routes
// them through decisionPolicy.decide(), starts LLM decisions as agent
// operations, carries out choices, and logs every decision.
//
// Keep free of server-only imports: agent.ts (bundled by the frontend)
// imports this file.

import { Infer, v } from 'convex/values';
import { GAME_DAY_LENGTH } from '../constants';
import { distance } from '../util/geometry';
import { point } from '../util/types';
import type { Point } from '../util/types';
import { GameId, playerId } from './ids';
import { Conversation } from './conversation';
import { movePlayer } from './movement';
import { countItem } from './inventory';
import { approach, findOpenTile, findWorkers, resolveWorkplace } from './jobs';
import { IDLE_ACTIVITY_DURATION, nearestPlace, recordAction } from './idle';
import { INTERACT_DISTANCE, performPlayerAction } from './actions';
import {
  AgentEvent,
  DecisionChoice,
  EVENT_OPTIONS,
  decide,
  policyMode,
  takeNextEvent,
} from './decisionPolicy';
import type { Game } from './game';
import type { Player } from './player';
import type { Agent } from './agent';

/** A multi-step plan (e.g. steal) is abandoned after this long. */
export const INTENT_TIMEOUT = GAME_DAY_LENGTH / 12;
/** Shown while an LLM decision is pending. */
export const THINKING_ACTIVITY = { description: 'thinking', emoji: '💭' };

export const serializedIntent = v.union(
  // Walk to a stall (or its owner) and take a loaf.
  v.object({
    kind: v.literal('steal'),
    targetId: playerId,
    until: v.number(),
  }),
  // Walk to a place and do a (purely cosmetic) activity there (config C idle plan).
  v.object({
    kind: v.literal('activity'),
    destination: point,
    place: v.string(),
    description: v.string(),
    emoji: v.string(),
    until: v.number(),
  }),
);
export type Intent = Infer<typeof serializedIntent>;

// Legacy (PR #12 walk-by detection, removed): kept so saved agents still validate.
export const serializedApproachSeen = v.object({ playerId, at: v.number() });
export type ApproachSeen = Infer<typeof serializedApproachSeen>;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/** Log a routine (always scripted) decision, e.g. 'startTask', 'deliver', 'eat'. */
export function logRoutine(game: Game, now: number, player: Player, step: string) {
  game.logDecision({
    at: now,
    playerId: player.id,
    trigger: `routine.${step}`,
    mode: 'scripted',
    choice: step,
    policy: policyMode(),
  });
}

// NPCs react only to direct interactions: being robbed, helped, or interfered
// with (raised in relationships.recordTheft and actions.ts), plus seeing a
// theft and being broke and hungry. Walking nearby triggers nothing.

// ---------------------------------------------------------------------------
// Event processing
// ---------------------------------------------------------------------------

/**
 * Handle the next queued event, if any. Returns true if the agent is busy
 * with it this tick (an LLM decision started, or a scripted choice applied).
 */
export function processEvents(game: Game, now: number, agent: Agent, player: Player): boolean {
  const event = takeNextEvent(agent, now);
  if (!event) {
    return false;
  }
  const mode = policyMode();
  const decision = decide(event, mode);
  if (decision.mode === 'scripted') {
    applyDecision(game, now, agent, player, event, decision.choice);
    game.logDecision({
      at: now,
      playerId: player.id,
      trigger: `event.${event.kind}`,
      mode: 'scripted',
      choice: decision.choice,
      options: EVENT_OPTIONS[event.kind].options,
      policy: mode,
    });
    return true;
  }
  player.activity = { ...THINKING_ACTIVITY, until: now + 60_000 };
  agent.startOperation(game, now, 'agentDecide', {
    worldId: game.worldId,
    playerId: player.id,
    agentId: agent.id,
    event,
    options: decision.options,
  });
  return true;
}

/** Apply the outcome of an LLM decision (called from the finishDecision input). */
export function finishLlmDecision(
  game: Game,
  now: number,
  agent: Agent,
  player: Player,
  event: AgentEvent,
  choice: DecisionChoice,
  mode: 'llm' | 'llm-fallback',
  options: DecisionChoice[],
  latencyMs: number,
) {
  if (player.activity?.description === THINKING_ACTIVITY.description) {
    player.activity.until = now;
  }
  applyDecision(game, now, agent, player, event, choice);
  game.logDecision({
    at: now,
    playerId: player.id,
    trigger: `event.${event.kind}`,
    mode,
    choice,
    options,
    latencyMs,
    policy: policyMode(),
  });
}

// ---------------------------------------------------------------------------
// Carrying out choices
// ---------------------------------------------------------------------------

function nameOf(game: Game, id: string): string {
  return game.playerDescriptions.get(id as GameId<'players'>)?.name ?? 'someone';
}

function inConversation(game: Game, p: Player): boolean {
  return !!game.world.playerConversation(p);
}

/** Nearest other agent's player that's free to talk, excluding `exclude`. */
function nearestFreeAgentPlayer(game: Game, player: Player, exclude: string[]): Player | undefined {
  let best: { p: Player; d: number } | undefined;
  for (const a of game.world.agents.values()) {
    if (a.playerId === player.id || exclude.includes(a.playerId)) continue;
    const p = game.world.players.get(a.playerId);
    if (!p || inConversation(game, p)) continue;
    const d = distance(p.position, player.position);
    if (!best || d < best.d) best = { p, d };
  }
  return best?.p;
}

function startTalking(game: Game, now: number, player: Player, other: Player | undefined): string {
  if (!other || inConversation(game, player) || inConversation(game, other)) {
    return 'no one available';
  }
  if (player.pathfinding) {
    delete player.pathfinding;
  }
  const result: { error?: string } = Conversation.start(game, now, player, other);
  return result.error ?? `talking to ${other.id}`;
}

/** A walkable tile about 8 tiles directly away from `from`. */
function pointAwayFrom(game: Game, position: Point, from: Point): Point {
  const dx = position.x - from.x;
  const dy = position.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const target = {
    x: Math.min(game.worldMap.width - 2, Math.max(1, Math.round(position.x + (dx / len) * 8))),
    y: Math.min(game.worldMap.height - 2, Math.max(1, Math.round(position.y + (dy / len) * 8))),
  };
  return findOpenTile(game.worldMap, target) ?? target;
}

/** Carry out a decision with scripted mechanics. Returns a short note for logs. */
export function applyDecision(
  game: Game,
  now: number,
  agent: Agent,
  player: Player,
  event: AgentEvent,
  choice: DecisionChoice,
): string {
  const subject = event.subject && game.world.players.get(event.subject as GameId<'players'>);
  let note = '';
  switch (choice) {
    case 'confront':
    case 'greet':
    case 'thank':
      note = startTalking(game, now, player, subject || undefined);
      break;
    case 'warnOthers':
    case 'askForHelp':
      note = startTalking(
        game,
        now,
        player,
        nearestFreeAgentPlayer(game, player, event.subject ? [event.subject] : []),
      );
      break;
    case 'avoid':
      if (subject && !inConversation(game, player)) {
        movePlayer(game, now, player, pointAwayFrom(game, player.position, subject.position));
        note = 'walking away';
      } else {
        note = 'nothing to avoid';
      }
      break;
    case 'wave':
      player.activity = { description: 'waving', emoji: '👋', until: now + 5_000 };
      note = 'waved';
      break;
    case 'steal': {
      const target = breadSeller(game, player);
      if (target) {
        agent.intent = { kind: 'steal', targetId: target.id, until: now + INTENT_TIMEOUT };
        note = `plans to steal from ${target.id}`;
      } else {
        note = 'no bread anywhere to steal';
      }
      break;
    }
    case 'ignore':
    case 'wait':
      note = choice;
      break;
  }
  console.log(`[decision] ${player.id} ${event.kind} -> ${choice}: ${note}`);
  // Remember notable choices so the NPC can talk about them later.
  const who = event.subject ? nameOf(game, event.subject) : 'them';
  const remembered: Partial<Record<DecisionChoice, string>> = {
    confront: `confronted ${who}`,
    warnOthers: `went to warn others about ${who}`,
    avoid: `kept away from ${who}`,
    askForHelp: 'asked around for help getting food',
    thank: `went to thank ${who}`,
    greet: `went to talk with ${who}`,
  };
  if (remembered[choice]) {
    recordAction(agent, now, remembered[choice]!, nearestPlace(player.position).name);
  }
  return note;
}

/** A shopkeeper (or failing that, the baker) holding bread. */
function breadSeller(game: Game, player: Player): Player | undefined {
  for (const kind of ['shopkeeper', 'baker'] as const) {
    const w = findWorkers(game, kind).find(
      (w) => w.player.id !== player.id && countItem(w.player.inventory, 'bread') > 0,
    );
    if (w) return w.player;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Multi-step intents (currently: steal a loaf)
// ---------------------------------------------------------------------------

/** Advance the agent's intent. Returns true while it's driving the agent. */
export function tickIntent(game: Game, now: number, agent: Agent, player: Player): boolean {
  const intent = agent.intent;
  if (!intent) {
    return false;
  }
  if (intent.kind === 'activity') {
    if (now > intent.until) {
      delete agent.intent;
      return false;
    }
    const step = approach(
      { position: player.position, pathfindingDestination: player.pathfinding?.destination },
      intent.destination,
      (destination) => ({ kind: 'walkToWork', destination }),
    );
    if (step === 'arrived') {
      player.activity = {
        description: intent.description,
        emoji: intent.emoji,
        until: now + IDLE_ACTIVITY_DURATION,
      };
      recordAction(agent, now, intent.description, intent.place);
      delete agent.intent;
    } else if (step.kind === 'walkToWork') {
      movePlayer(game, now, player, step.destination);
    }
    return true;
  }
  const target = game.world.players.get(intent.targetId as GameId<'players'>);
  const targetAgent = [...game.world.agents.values()].find((a) => a.playerId === intent.targetId);
  if (!target || now > intent.until) {
    delete agent.intent;
    return false;
  }
  // Go to the target's stall (self-serve) or the target, whichever is closer.
  const stall = targetAgent?.job ? resolveWorkplace(game, targetAgent.job) : undefined;
  const destination =
    stall && distance(player.position, stall) < distance(player.position, target.position)
      ? stall
      : { x: Math.floor(target.position.x), y: Math.floor(target.position.y) };
  const close =
    distance(player.position, target.position) <= INTERACT_DISTANCE ||
    (!!stall && distance(player.position, stall) <= INTERACT_DISTANCE);
  if (!close) {
    if (!player.pathfinding) {
      movePlayer(game, now, player, destination);
    }
    return true;
  }
  delete agent.intent;
  try {
    const message = performPlayerAction(game, now, player, target, 'steal', 'bread');
    console.log(`[decision] ${player.id} carried out steal: ${message}`);
    recordAction(
      agent,
      now,
      `stole a loaf of bread from ${nameOf(game, target.id)}`,
      nearestPlace(player.position).name,
    );
  } catch (e: any) {
    console.log(`[decision] ${player.id} couldn't steal: ${e.message}`);
  }
  return true;
}
