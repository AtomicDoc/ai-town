import { v } from 'convex/values';
import { internalAction, internalQuery } from '../_generated/server';
import {
  DecisionChoice,
  EVENT_OPTIONS,
  decisionChoice,
  decisionPrompt,
  describeEvent,
  parseChoice,
  serializedEvent,
} from './decisionPolicy';
import { chatCompletion } from '../util/llm';
import { llmTrace } from '../util/llmTrace';
import { livelihoodPrompts } from './livelihood';
import { socialPrompts } from './relationships';
import { WorldMap, serializedWorldMap } from './worldMap';
import { rememberConversation } from '../agent/memory';
import { GameId, agentId, conversationId, playerId } from './ids';
import {
  continueConversationMessage,
  leaveConversationMessage,
  startConversationMessage,
} from '../agent/conversation';
import { assertNever } from '../util/assertNever';
import { serializedAgent } from './agent';
import { ACTIVITIES, ACTIVITY_COOLDOWN, CONVERSATION_COOLDOWN } from '../constants';
import { api, internal } from '../_generated/api';
import { sleep } from '../util/sleep';
import { serializedPlayer } from './player';

export const agentRememberConversation = internalAction({
  args: {
    worldId: v.id('worlds'),
    playerId,
    agentId,
    conversationId,
    operationId: v.string(),
  },
  handler: async (ctx, args) => {
    await rememberConversation(
      ctx,
      args.worldId,
      args.agentId as GameId<'agents'>,
      args.playerId as GameId<'players'>,
      args.conversationId as GameId<'conversations'>,
    );
    await sleep(Math.random() * 1000);
    await ctx.runMutation(api.aiTown.main.sendInput, {
      worldId: args.worldId,
      name: 'finishRememberConversation',
      args: {
        agentId: args.agentId,
        operationId: args.operationId,
      },
    });
  },
});

export const agentGenerateMessage = internalAction({
  args: {
    worldId: v.id('worlds'),
    playerId,
    agentId,
    conversationId,
    otherPlayerId: playerId,
    operationId: v.string(),
    type: v.union(v.literal('start'), v.literal('continue'), v.literal('leave')),
    messageUuid: v.string(),
  },
  handler: async (ctx, args) => {
    let completionFn;
    switch (args.type) {
      case 'start':
        completionFn = startConversationMessage;
        break;
      case 'continue':
        completionFn = continueConversationMessage;
        break;
      case 'leave':
        completionFn = leaveConversationMessage;
        break;
      default:
        assertNever(args.type);
    }
    const text = await completionFn(
      ctx,
      args.worldId,
      args.conversationId as GameId<'conversations'>,
      args.playerId as GameId<'players'>,
      args.otherPlayerId as GameId<'players'>,
    );

    await ctx.runMutation(internal.aiTown.agent.agentSendMessage, {
      worldId: args.worldId,
      conversationId: args.conversationId,
      agentId: args.agentId,
      playerId: args.playerId,
      text,
      messageUuid: args.messageUuid,
      leaveConversation: args.type === 'leave',
      operationId: args.operationId,
    });
  },
});

export const agentDoSomething = internalAction({
  args: {
    worldId: v.id('worlds'),
    player: v.object(serializedPlayer),
    agent: v.object(serializedAgent),
    map: v.object(serializedWorldMap),
    otherFreePlayers: v.array(v.object(serializedPlayer)),
    operationId: v.string(),
  },
  handler: async (ctx, args) => {
    const { player, agent } = args;
    const map = new WorldMap(args.map);
    const now = Date.now();
    // Don't try to start a new conversation if we were just in one.
    const justLeftConversation =
      agent.lastConversation && now < agent.lastConversation + CONVERSATION_COOLDOWN;
    // Don't try again if we recently tried to find someone to invite.
    const recentlyAttemptedInvite =
      agent.lastInviteAttempt && now < agent.lastInviteAttempt + CONVERSATION_COOLDOWN;
    const recentActivity = player.activity && now < player.activity.until + ACTIVITY_COOLDOWN;
    // Decide whether to do an activity or wander somewhere.
    if (!player.pathfinding) {
      if (recentActivity || justLeftConversation) {
        await sleep(Math.random() * 1000);
        await ctx.runMutation(api.aiTown.main.sendInput, {
          worldId: args.worldId,
          name: 'finishDoSomething',
          args: {
            operationId: args.operationId,
            agentId: agent.id,
            destination: wanderDestination(map),
          },
        });
        return;
      } else {
        // TODO: have LLM choose the activity & emoji
        const activity = ACTIVITIES[Math.floor(Math.random() * ACTIVITIES.length)];
        await sleep(Math.random() * 1000);
        await ctx.runMutation(api.aiTown.main.sendInput, {
          worldId: args.worldId,
          name: 'finishDoSomething',
          args: {
            operationId: args.operationId,
            agentId: agent.id,
            activity: {
              description: activity.description,
              emoji: activity.emoji,
              until: Date.now() + activity.duration,
            },
          },
        });
        return;
      }
    }
    const invitee =
      justLeftConversation || recentlyAttemptedInvite
        ? undefined
        : await ctx.runQuery(internal.aiTown.agent.findConversationCandidate, {
            now,
            worldId: args.worldId,
            player: args.player,
            otherFreePlayers: args.otherFreePlayers,
          });

    // TODO: We hit a lot of OCC errors on sending inputs in this file. It's
    // easy for them to get scheduled at the same time and line up in time.
    await sleep(Math.random() * 1000);
    await ctx.runMutation(api.aiTown.main.sendInput, {
      worldId: args.worldId,
      name: 'finishDoSomething',
      args: {
        operationId: args.operationId,
        agentId: args.agent.id,
        invitee,
      },
    });
  },
});

// ---------------------------------------------------------------------------
// M3: LLM decisions for unusual events (see decisionPolicy.ts)
// ---------------------------------------------------------------------------

export const decisionPromptData = internalQuery({
  args: {
    worldId: v.id('worlds'),
    playerId,
  },
  handler: async (ctx, args) => {
    const world = await ctx.db.get(args.worldId);
    if (!world) {
      throw new Error(`World ${args.worldId} not found`);
    }
    const player = world.players.find((p) => p.id === args.playerId);
    const agent = world.agents.find((a) => a.playerId === args.playerId);
    if (!player || !agent) {
      throw new Error(`Agent for ${args.playerId} not found`);
    }
    const agentDescription = await ctx.db
      .query('agentDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('agentId', agent.id))
      .first();
    const descriptions = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .collect();
    return {
      player,
      agent,
      identity: agentDescription?.identity ?? '',
      names: descriptions.map((d) => ({ playerId: d.playerId, name: d.name })),
    };
  },
});

export const agentDecide = internalAction({
  args: {
    worldId: v.id('worlds'),
    playerId,
    agentId,
    operationId: v.string(),
    event: serializedEvent,
    options: v.array(decisionChoice),
  },
  handler: async (ctx, args) => {
    const started = Date.now();
    let choice: DecisionChoice | undefined;
    try {
      const data = await ctx.runQuery(internal.aiTown.agentOperations.decisionPromptData, {
        worldId: args.worldId,
        playerId: args.playerId,
      });
      const nameOf = (id: string) => data.names.find((n) => n.playerId === id)?.name ?? 'someone';
      const name = nameOf(args.playerId);
      const subjectName = args.event.subject ? nameOf(args.event.subject) : undefined;
      const context = [
        ...livelihoodPrompts(
          { name, ...data.player },
          data.agent,
          { name: subjectName ?? '' },
          null,
          Date.now(),
        ),
        ...(args.event.subject && subjectName
          ? socialPrompts(data.agent, args.playerId, args.event.subject, subjectName, nameOf)
          : []),
      ];
      const messages = decisionPrompt({
        name,
        identity: data.identity,
        context,
        event: describeEvent(args.event, nameOf),
        options: args.options,
        subjectName,
      });
      const { content } = await chatCompletion(
        { messages, max_tokens: 12, temperature: 0.7 },
        llmTrace(ctx, `decision.${args.event.kind}`, args.playerId),
      );
      choice = parseChoice(content, args.options);
      console.log(`[decision] ${args.playerId} LLM replied "${content.trim()}" -> ${choice}`);
    } catch (e) {
      console.error(`[decision] LLM decision failed for ${args.playerId}: ${String(e)}`);
    }
    const mode = choice ? 'llm' : 'llm-fallback';
    await ctx.runMutation(api.aiTown.main.sendInput, {
      worldId: args.worldId,
      name: 'finishDecision',
      args: {
        agentId: args.agentId,
        operationId: args.operationId,
        event: args.event,
        choice: choice ?? EVENT_OPTIONS[args.event.kind].fallback,
        mode,
        options: args.options,
        latencyMs: Date.now() - started,
      },
    });
  },
});

function wanderDestination(worldMap: WorldMap) {
  // Wander someonewhere at least one tile away from the edge.
  return {
    x: 1 + Math.floor(Math.random() * (worldMap.width - 2)),
    y: 1 + Math.floor(Math.random() * (worldMap.height - 2)),
  };
}
