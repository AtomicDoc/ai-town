import { v } from 'convex/values';
import { agentId, conversationId, parseGameId, playerId } from './ids';
import { addItem, itemKind, removeItem } from './inventory';
import { Player, activity } from './player';
import { Conversation, conversationInputs } from './conversation';
import { movePlayer } from './movement';
import { inputHandler } from './inputHandler';
import { point } from '../util/types';
import { Descriptions } from '../../data/characters';
import { AgentDescription } from './agentDescription';
import { Agent } from './agent';
import { isJobKind, isOnShift, jobKind, newJob } from './jobs';
import { gameHour } from './clock';

/** The job (and shift override) a character in data/characters.ts should have. */
function jobFromDescription(description: (typeof Descriptions)[number]) {
  if (!('job' in description) || !isJobKind(description.job)) {
    return undefined;
  }
  const shift = 'shift' in description ? description.shift : undefined;
  return newJob(description.job, shift);
}

export const agentInputs = {
  finishRememberConversation: inputHandler({
    args: {
      operationId: v.string(),
      agentId,
    },
    handler: (game, now, args) => {
      const agentId = parseGameId('agents', args.agentId);
      const agent = game.world.agents.get(agentId);
      if (!agent) {
        throw new Error(`Couldn't find agent: ${agentId}`);
      }
      if (
        !agent.inProgressOperation ||
        agent.inProgressOperation.operationId !== args.operationId
      ) {
        console.debug(`Agent ${agentId} isn't remembering ${args.operationId}`);
      } else {
        delete agent.inProgressOperation;
        delete agent.toRemember;
      }
      return null;
    },
  }),
  finishDoSomething: inputHandler({
    args: {
      operationId: v.string(),
      agentId: v.id('agents'),
      destination: v.optional(point),
      invitee: v.optional(v.id('players')),
      activity: v.optional(activity),
    },
    handler: (game, now, args) => {
      const agentId = parseGameId('agents', args.agentId);
      const agent = game.world.agents.get(agentId);
      if (!agent) {
        throw new Error(`Couldn't find agent: ${agentId}`);
      }
      if (
        !agent.inProgressOperation ||
        agent.inProgressOperation.operationId !== args.operationId
      ) {
        console.debug(`Agent ${agentId} didn't have ${args.operationId} in progress`);
        return null;
      }
      delete agent.inProgressOperation;
      const player = game.world.players.get(agent.playerId)!;
      // A wander/invite/activity decided before the shift started can arrive
      // after it. Drop it so the job keeps control of an on-shift worker.
      if (agent.job && isOnShift(agent.job, gameHour(now))) {
        console.log(`[job] ${player.id} on shift, ignoring stale agentDoSomething result`);
        return null;
      }
      if (args.invitee) {
        const inviteeId = parseGameId('players', args.invitee);
        const invitee = game.world.players.get(inviteeId);
        if (!invitee) {
          throw new Error(`Couldn't find player: ${inviteeId}`);
        }
        Conversation.start(game, now, player, invitee);
        agent.lastInviteAttempt = now;
      }
      if (args.destination) {
        movePlayer(game, now, player, args.destination);
      }
      if (args.activity) {
        player.activity = args.activity;
      }
      return null;
    },
  }),
  agentFinishSendingMessage: inputHandler({
    args: {
      agentId,
      conversationId,
      timestamp: v.number(),
      operationId: v.string(),
      leaveConversation: v.boolean(),
    },
    handler: (game, now, args) => {
      const agentId = parseGameId('agents', args.agentId);
      const agent = game.world.agents.get(agentId);
      if (!agent) {
        throw new Error(`Couldn't find agent: ${agentId}`);
      }
      const player = game.world.players.get(agent.playerId);
      if (!player) {
        throw new Error(`Couldn't find player: ${agent.playerId}`);
      }
      const conversationId = parseGameId('conversations', args.conversationId);
      const conversation = game.world.conversations.get(conversationId);
      if (!conversation) {
        throw new Error(`Couldn't find conversation: ${conversationId}`);
      }
      if (
        !agent.inProgressOperation ||
        agent.inProgressOperation.operationId !== args.operationId
      ) {
        console.debug(`Agent ${agentId} wasn't sending a message ${args.operationId}`);
        return null;
      }
      delete agent.inProgressOperation;
      conversationInputs.finishSendingMessage.handler(game, now, {
        playerId: agent.playerId,
        conversationId: args.conversationId,
        timestamp: args.timestamp,
      });
      if (args.leaveConversation) {
        conversation.leave(game, now, player);
      }
      return null;
    },
  }),
  // Testing helper: adjust a player's items and/or coins (negative = take).
  debugGive: inputHandler({
    args: {
      playerId,
      item: v.optional(itemKind),
      quantity: v.optional(v.number()),
      coins: v.optional(v.number()),
    },
    handler: (game, now, args) => {
      const player = game.world.players.get(parseGameId('players', args.playerId));
      if (!player) {
        throw new Error(`Couldn't find player: ${args.playerId}`);
      }
      if (args.item && args.quantity) {
        if (args.quantity > 0) {
          addItem(player.inventory, args.item, args.quantity);
        } else if (!removeItem(player.inventory, args.item, -args.quantity)) {
          throw new Error(`${player.id} doesn't have ${-args.quantity} ${args.item}`);
        }
      }
      if (args.coins) {
        player.coins = Math.max(0, player.coins + Math.trunc(args.coins));
      }
      return { inventory: { ...player.inventory }, coins: player.coins };
    },
  }),
  // Give an agent a scripted job, or remove it with `job: null`. Assigning
  // resets progress; any in-progress task activity is left to expire.
  assignJob: inputHandler({
    args: {
      agentId,
      job: v.union(jobKind, v.null()),
    },
    handler: (game, now, args) => {
      const agentId = parseGameId('agents', args.agentId);
      const agent = game.world.agents.get(agentId);
      if (!agent) {
        throw new Error(`Couldn't find agent: ${agentId}`);
      }
      agent.job = args.job === null ? undefined : newJob(args.job);
      return null;
    },
  }),
  // Apply data/characters.ts (descriptions, goals, jobs, shifts) to an existing
  // world, matching characters by name. Keeps job progress when the job and
  // shift are unchanged.
  syncCharacters: inputHandler({
    args: {},
    handler: (game, now) => {
      const updated: string[] = [];
      for (const description of Descriptions) {
        const playerDescription = [...game.playerDescriptions.values()].find(
          (d) => d.name === description.name,
        );
        if (!playerDescription) {
          continue;
        }
        playerDescription.description = description.identity;
        const agent = [...game.world.agents.values()].find(
          (a) => a.playerId === playerDescription.playerId,
        );
        if (!agent) {
          continue;
        }
        const agentDescription = game.agentDescriptions.get(agent.id);
        if (agentDescription) {
          agentDescription.identity = description.identity;
          agentDescription.plan = description.plan;
        }
        const desired = jobFromDescription(description);
        const unchanged =
          desired &&
          agent.job?.kind === desired.kind &&
          JSON.stringify(agent.job.shift) === JSON.stringify(desired.shift);
        if (!unchanged) {
          agent.job = desired;
        }
        updated.push(`${description.name}: ${desired ? desired.kind : 'no job'}`);
      }
      game.descriptionsModified = true;
      return updated;
    },
  }),
  createAgent: inputHandler({
    args: {
      descriptionIndex: v.number(),
    },
    handler: (game, now, args) => {
      const description = Descriptions[args.descriptionIndex];
      const playerId = Player.join(
        game,
        now,
        description.name,
        description.character,
        description.identity,
      );
      const agentId = game.allocId('agents');
      game.world.agents.set(
        agentId,
        new Agent({
          id: agentId,
          playerId: playerId,
          inProgressOperation: undefined,
          lastConversation: undefined,
          lastInviteAttempt: undefined,
          toRemember: undefined,
          job: jobFromDescription(description),
        }),
      );
      game.agentDescriptions.set(
        agentId,
        new AgentDescription({
          agentId: agentId,
          identity: description.identity,
          plan: description.plan,
        }),
      );
      return { agentId };
    },
  }),
};
