// Needs (hunger) and food shopping. Milestone 2.
//
// Hunger is derived from the time since an agent last ate: 0 just after a meal,
// 100 after HUNGER_FULL_TIME. Agents:
//   - eat a bread from their own inventory whenever they're hungry, standing
//     still, and not mid-task (works on or off shift, any hour);
//   - go shopping when off shift, getting peckish, low on bread, and able to
//     afford it. The shop is self-serve: they buy from a shopkeeper's stock
//     whether or not the shopkeeper is there, so it's never "closed".
// Like jobs, none of this calls the LLM.
//
// Structure mirrors jobs.ts: decideNeedsStep() is pure and unit-tested;
// tickNeeds() applies it in the engine.
//
// Keep this file free of server-only imports: the frontend bundles it.

import { ObjectType, v } from 'convex/values';
import { Point } from '../util/types';
import { GAME_DAY_LENGTH } from '../constants';
import { countItem, removeItem } from './inventory';
import { PRICES, sellUpTo } from './economy';
import { JobStep, approach, findWorkers, resolveWorkplace } from './jobs';
import { movePlayer } from './movement';
import { noteTrade } from './relationships';
import { AgentEvent, enqueueEvent } from './decisionPolicy';
import { logRoutine } from './decisions';
import type { Game } from './game';
import type { Player } from './player';

/** Time for hunger to go from 0 to 100. */
export const HUNGER_FULL_TIME = 2 * GAME_DAY_LENGTH;
/** Eat (if holding bread) at this hunger: about once per game day. */
export const EAT_AT = 50;
/** Start shopping for bread at this hunger, so there's a loaf ready before EAT_AT. */
export const SHOP_AT = 25;
/** Loaves an agent tries to keep on hand. */
export const SPARE_BREAD = 2;
export const EAT_DURATION = 10_000;
/** Minimum time between shopping trips (successful or not). */
export const SHOP_COOLDOWN = GAME_DAY_LENGTH / 6;

export const EATING_ACTIVITY = { description: 'eating', emoji: '🍞' };

export const serializedNeeds = {
  lastAteAt: v.number(),
  lastShopAt: v.optional(v.number()),
  /** When the last brokeAndHungry event was raised (M3). */
  lastBrokeEventAt: v.optional(v.number()),
};

/** Minimum time between brokeAndHungry events for one agent. */
export const BROKE_EVENT_COOLDOWN = GAME_DAY_LENGTH / 4;

/** Hungry, no bread, and can't afford any: an unusual situation for the policy. */
export function brokeAndHungryDue(
  needs: SerializedNeeds,
  hunger: number,
  bread: number,
  coins: number,
  now: number,
): boolean {
  return (
    hunger >= EAT_AT &&
    bread === 0 &&
    coins < PRICES.bread &&
    (needs.lastBrokeEventAt === undefined || now - needs.lastBrokeEventAt >= BROKE_EVENT_COOLDOWN)
  );
}
export type SerializedNeeds = ObjectType<typeof serializedNeeds>;

/** Hunger 0-100 from the time since the last meal. */
export function hungerLevel(lastAteAt: number | undefined, now: number): number {
  if (lastAteAt === undefined) {
    return 0;
  }
  const level = ((now - lastAteAt) / HUNGER_FULL_TIME) * 100;
  return Math.round(Math.min(100, Math.max(0, level)));
}

export function describeHunger(hunger: number): string | undefined {
  if (hunger >= 80) return 'starving';
  if (hunger >= EAT_AT) return 'hungry';
  if (hunger >= SHOP_AT) return 'a little peckish';
  return undefined;
}

export type NeedsSnapshot = {
  hunger: number;
  bread: number;
  /** On shift (shopping waits until after work; eating doesn't). */
  working: boolean;
  /** A job task is in progress (don't interrupt it to eat). */
  taskInProgress: boolean;
  /** Currently in the eating activity. */
  eating: boolean;
  position: Point;
  pathfindingDestination?: Point;
  /** Set when a shopping trip is due now: where the shop is. */
  shop?: { destination: Point };
};

export type NeedsStep =
  | { kind: 'none' }
  | { kind: 'eating' }
  | { kind: 'eat' }
  | { kind: 'buy' }
  | Extract<JobStep, { kind: 'walking' } | { kind: 'walkToWork' }>;

export function decideNeedsStep(s: NeedsSnapshot): NeedsStep {
  if (s.eating) {
    return { kind: 'eating' };
  }
  // Eat when hungry, holding bread, standing still, and not mid-task.
  if (
    s.hunger >= EAT_AT &&
    s.bread > 0 &&
    !s.taskInProgress &&
    s.pathfindingDestination === undefined
  ) {
    return { kind: 'eat' };
  }
  if (s.working || !s.shop) {
    return { kind: 'none' };
  }
  // Reuse the job system's walking logic; 'walkToWork' here means "walk to the shop".
  const step = approach(s, s.shop.destination, (destination) => ({
    kind: 'walkToWork',
    destination,
  }));
  if (step === 'arrived') {
    return { kind: 'buy' };
  }
  return step as NeedsStep;
}

/** Whether a shopping trip is due (ignoring whether the shop has stock). */
export function shoppingDue(
  needs: SerializedNeeds,
  hunger: number,
  bread: number,
  coins: number,
  now: number,
): boolean {
  return (
    hunger >= SHOP_AT &&
    bread < SPARE_BREAD &&
    coins >= PRICES.bread &&
    (needs.lastShopAt === undefined || now - needs.lastShopAt >= SHOP_COOLDOWN)
  );
}

/**
 * Advance an agent's needs by one engine tick. Returns true if needs are
 * driving the agent this tick (eating or shopping).
 */
export function tickNeeds(
  game: Game,
  now: number,
  agent: {
    needs?: SerializedNeeds;
    job?: { taskEndsAt?: number };
    pendingEvents?: AgentEvent[];
  },
  player: Player,
  working: boolean,
): boolean {
  if (!agent.needs) {
    // Start everyone fed.
    agent.needs = { lastAteAt: now };
  }
  const needs = agent.needs;
  const hunger = hungerLevel(needs.lastAteAt, now);
  const bread = countItem(player.inventory, 'bread');

  // Unusual situation for the decision policy (M3); handled next tick.
  if (brokeAndHungryDue(needs, hunger, bread, player.coins, now)) {
    needs.lastBrokeEventAt = now;
    enqueueEvent(agent, { kind: 'brokeAndHungry', at: now });
  }

  let seller: ReturnType<typeof findWorkers>[number] | undefined;
  let shop: NeedsSnapshot['shop'];
  if (!working && shoppingDue(needs, hunger, bread, player.coins, now)) {
    seller = findWorkers(game, 'shopkeeper')
      .filter((w) => w.player.id !== player.id && countItem(w.player.inventory, 'bread') > 0)
      .sort(
        (a, b) => countItem(b.player.inventory, 'bread') - countItem(a.player.inventory, 'bread'),
      )[0];
    if (seller) {
      shop = { destination: resolveWorkplace(game, seller.job) };
    }
  }

  const eating =
    player.activity?.description === EATING_ACTIVITY.description && player.activity.until > now;
  const step = decideNeedsStep({
    hunger,
    bread,
    working,
    taskInProgress: agent.job?.taskEndsAt !== undefined,
    eating,
    position: player.position,
    pathfindingDestination: player.pathfinding?.destination,
    shop,
  });

  switch (step.kind) {
    case 'none':
      return false;
    case 'eating':
    case 'walking':
      return true;
    case 'eat':
      removeItem(player.inventory, 'bread', 1);
      needs.lastAteAt = now;
      player.activity = { ...EATING_ACTIVITY, until: now + EAT_DURATION };
      console.log(`[needs] ${player.id} ate bread (hunger was ${hunger})`);
      logRoutine(game, now, player, 'eat');
      return true;
    case 'walkToWork':
      if (player.activity && player.activity.until > now) {
        player.activity.until = now;
      }
      movePlayer(game, now, player, step.destination);
      logRoutine(game, now, player, 'goShopping');
      return true;
    case 'buy': {
      const wanted = Math.max(0, SPARE_BREAD - bread);
      const bought = seller ? sellUpTo(seller.player, player, 'bread', wanted, PRICES.bread) : 0;
      needs.lastShopAt = now;
      if (seller && bought > 0) {
        noteTrade(game, seller.player.id, player.id);
      }
      console.log(
        `[econ] ${player.id} bought ${bought}/${wanted} bread from ${seller?.player.id}` +
          ` for ${bought * PRICES.bread} coins (buyer ${player.coins}, shop ${seller?.player.coins})`,
      );
      logRoutine(game, now, player, 'buy');
      return true;
    }
  }
}
