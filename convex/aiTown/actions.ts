// Player actions on other characters. Milestone 2.
//
// The human player (or any player, via testing:act) can, when close enough:
//   buy       - 1 item from the target at retail price (shop/bakery stock),
//   sell      - 1 item the target's job wants, at wholesale price,
//   steal     - 1 item from the target (witnesses form beliefs),
//   help      - finish the target's current work task right away,
//   interfere - spoil the target's current work task.
// Talking is the existing conversation system.
//
// Stalls are self-serve, so buy/sell/steal also work at the target's
// workplace when the target isn't there (e.g. stealing from the empty shop).
// Help/interfere need the target in person.
//
// Each action updates opinions (relationships.ts) and runs entirely in the
// engine: no LLM calls. Keep free of server-only imports.

import { Infer, v } from 'convex/values';
import { distance } from '../util/geometry';
import { GameId, parseGameId, playerId } from './ids';
import { inputHandler } from './inputHandler';
import { ITEM_KINDS, ItemKind, countItem, itemKind, transferItem } from './inventory';
import { PRICES, WHOLESALE_PRICES, trade } from './economy';
import { JOB_DEFINITIONS, resolveWorkplace } from './jobs';
import { enqueueEvent } from './decisionPolicy';
import {
  OPINION_DELTAS,
  adjustOpinion,
  agentOfPlayer,
  noteTrade,
  recordTheft,
} from './relationships';
import type { Game } from './game';
import type { Player } from './player';

export const playerActionKind = v.union(
  v.literal('buy'),
  v.literal('sell'),
  v.literal('steal'),
  v.literal('help'),
  v.literal('interfere'),
);
export type PlayerActionKind = Infer<typeof playerActionKind>;

/** Tiles within which the actor can act on a target (or its stall). */
export const INTERACT_DISTANCE = 3;

function nameOf(game: Game, id: string): string {
  return game.playerDescriptions.get(id as GameId<'players'>)?.name ?? id;
}

/** The item the target's job buys from others, if any (baker: wheat, shopkeeper: bread). */
export function itemWantedBy(target: { job?: { kind: keyof typeof JOB_DEFINITIONS } }) {
  const def = target.job && JOB_DEFINITIONS[target.job.kind];
  return def?.stockTarget;
}

/** The item a target holds the most of, for stealing. */
export function mostHeldItem(inventory: Partial<Record<ItemKind, number>>): ItemKind | undefined {
  let best: ItemKind | undefined;
  for (const item of ITEM_KINDS) {
    if (
      countItem(inventory, item) > 0 &&
      (!best || countItem(inventory, item) > countItem(inventory, best))
    ) {
      best = item;
    }
  }
  return best;
}

/**
 * Apply a player action. Returns a short message for the actor; throws an
 * Error with a readable message if the action isn't possible.
 */
export function performPlayerAction(
  game: Game,
  now: number,
  actor: Player,
  target: Player,
  action: PlayerActionKind,
  requestedItem?: ItemKind,
): string {
  if (actor.id === target.id) {
    throw new Error(`You can't do that to yourself.`);
  }
  const targetName = nameOf(game, target.id);
  const targetAgent = agentOfPlayer(game, target.id);
  const stall = targetAgent?.job ? resolveWorkplace(game, targetAgent.job) : undefined;
  const nearTarget = distance(actor.position, target.position) <= INTERACT_DISTANCE;
  const nearStall = !!stall && distance(actor.position, stall) <= INTERACT_DISTANCE;
  if (actor.human) {
    actor.lastInput = now;
  }

  const requireNear = (stallOk: boolean) => {
    if (!(nearTarget || (stallOk && nearStall))) {
      throw new Error(
        stallOk && stall
          ? `Get closer to ${targetName} or their stall first.`
          : `Get closer to ${targetName} first.`,
      );
    }
  };

  switch (action) {
    case 'buy': {
      requireNear(true);
      const item = requestedItem ?? 'bread';
      if (countItem(target.inventory, item) < 1) {
        throw new Error(`${targetName} has no ${item} to sell.`);
      }
      const price = PRICES[item];
      if (!trade(target, actor, item, 1, price)) {
        throw new Error(`You can't afford ${item} (${price} coins).`);
      }
      noteTrade(game, target.id, actor.id);
      return `You bought 1 ${item} from ${targetName} for ${price} coins.`;
    }
    case 'sell': {
      requireNear(true);
      const wanted = targetAgent && itemWantedBy(targetAgent);
      if (!wanted) {
        throw new Error(`${targetName} doesn't buy anything.`);
      }
      const item = wanted.item;
      if (countItem(actor.inventory, item) < 1) {
        throw new Error(`${targetName} buys ${item}, and you don't have any.`);
      }
      if (countItem(target.inventory, item) >= wanted.amount) {
        throw new Error(`${targetName} has enough ${item} already.`);
      }
      const price = WHOLESALE_PRICES[item];
      if (!trade(actor, target, item, 1, price)) {
        throw new Error(`${targetName} can't afford to buy ${item} right now.`);
      }
      noteTrade(game, actor.id, target.id);
      return `You sold 1 ${item} to ${targetName} for ${price} coins.`;
    }
    case 'steal': {
      requireNear(true);
      const item = requestedItem ?? mostHeldItem(target.inventory);
      if (!item || countItem(target.inventory, item) < 1) {
        throw new Error(`${targetName} has nothing to steal.`);
      }
      if (!transferItem(target.inventory, actor.inventory, item, 1)) {
        throw new Error(`You can't carry any more ${item}.`);
      }
      const { witnesses, victimKnows } = recordTheft(game, now, actor.id, target.id, item, 1);
      console.log(
        `[action] ${actor.id} stole 1 ${item} from ${target.id}; victim knows: ${victimKnows}; witnesses: ${
          witnesses.join(', ') || 'none'
        }`,
      );
      const seen = witnesses.map((id) => nameOf(game, id));
      return `You stole 1 ${item} from ${targetName}.${
        victimKnows ? ` ${targetName} will know it was you.` : ''
      } ${seen.length ? `Seen by: ${seen.join(', ')}.` : 'No one else saw you.'}`;
    }
    case 'help':
    case 'interfere': {
      requireNear(false);
      const job = targetAgent?.job;
      const activity = target.activity;
      const working =
        job?.taskEndsAt !== undefined &&
        activity !== undefined &&
        activity.until === job.taskEndsAt &&
        activity.description === JOB_DEFINITIONS[job.kind].task.description;
      if (!job || !working || !activity || !targetAgent) {
        throw new Error(`${targetName} isn't in the middle of any work.`);
      }
      if (action === 'help') {
        // Finish the task now; the job completes it (with output) next tick.
        job.taskEndsAt = now;
        activity.until = now;
        adjustOpinion(targetAgent, actor.id, OPINION_DELTAS.helped);
        enqueueEvent(targetAgent, { kind: 'helped', at: now, subject: actor.id });
        return `You helped ${targetName} finish ${activity.description}.`;
      }
      // Cut the activity short; the job abandons the task (no output) next tick.
      activity.until = now;
      adjustOpinion(targetAgent, actor.id, OPINION_DELTAS.interfered);
      enqueueEvent(targetAgent, { kind: 'interfered', at: now, subject: actor.id });
      return `You interfered with ${targetName}'s ${activity.description}.`;
    }
  }
}

export const actionInputs = {
  playerAction: inputHandler({
    args: {
      playerId,
      targetId: playerId,
      action: playerActionKind,
      item: v.optional(itemKind),
    },
    handler: (game, now, args) => {
      const actor = game.world.players.get(parseGameId('players', args.playerId));
      const target = game.world.players.get(parseGameId('players', args.targetId));
      if (!actor || !target) {
        throw new Error(`Unknown player`);
      }
      const message = performPlayerAction(game, now, actor, target, args.action, args.item);
      console.log(`[action] ${actor.id} ${args.action} -> ${target.id}: ${message}`);
      return message;
    },
  }),
};
