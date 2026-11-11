// Traditional (non-LLM) job system. Milestone 2.
//
// A job is a scripted routine: during shift hours the agent walks to its
// workplace and repeats a work task. A task may consume input items (baker:
// 2 wheat) and produces output items (bread). After the shift, a job may
// deliver its output to another job's workplace and sell it there (farmer
// sells wheat to the baker). None of this schedules an agent operation, so a
// working agent makes zero LLM calls. When there's nothing to do, the agent
// falls back to stock AI Town behavior (wandering, conversations).
//
// Structure:
//   - decideJobStep(): pure decision function, unit-tested in jobs.test.ts.
//   - tickJob(): engine-side wrapper that applies the decision to game state.
//
// Keep this file free of server-only imports (no _generated/server): the
// frontend bundles it via world.ts -> agent.ts.

import { Infer, ObjectType, v } from 'convex/values';
import { Point, point } from '../util/types';
import { distance } from '../util/geometry';
import { GAME_DAY_LENGTH } from '../constants';
import { gameHour, inHourWindow } from './clock';
import { movePlayer } from './movement';
import { ItemKind, addItem, countItem, removeItem } from './inventory';
import { PRICES, sellUpTo } from './economy';
import type { Game } from './game';
import type { Player } from './player';

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export const jobKind = v.union(v.literal('farmer'), v.literal('baker'));
export type JobKind = Infer<typeof jobKind>;
export const JOB_KINDS: readonly JobKind[] = ['farmer', 'baker'];

export function isJobKind(value: unknown): value is JobKind {
  return typeof value === 'string' && (JOB_KINDS as readonly string[]).includes(value);
}

export type JobDefinition = {
  title: string;
  /** Preferred workplace tile; resolved to the nearest walkable tile at runtime. */
  workplaceTarget: Point;
  /** Shift window in game hours, [start, end). May wrap past midnight. */
  shiftStartHour: number;
  shiftEndHour: number;
  /** One unit of work, shown in the UI as the player's activity. */
  task: {
    description: string;
    emoji: string;
    duration: number;
    /** Items used up by one task. The task only starts if they're held. */
    consumes?: { item: ItemKind; amount: number };
  };
  /** What one completed task adds to the worker's inventory. */
  output: { item: ItemKind; amount: number };
  /** Shown while on shift at work but missing the task's inputs. */
  waitingActivity?: { description: string; emoji: string };
  /** After the shift, carry `item` to the `toJob` worker's workplace and sell it. */
  delivery?: { item: ItemKind; toJob: JobKind; minBatch: number };
};

export const JOB_DEFINITIONS: Record<JobKind, JobDefinition> = {
  farmer: {
    title: 'farmer',
    // Open field in the lower-right of the default "gentle" map (64x48).
    workplaceTarget: { x: 56, y: 40 },
    shiftStartHour: 6,
    shiftEndHour: 16,
    task: { description: 'farming', emoji: '🌾', duration: 30_000 },
    output: { item: 'wheat', amount: 1 },
    delivery: { item: 'wheat', toJob: 'baker', minBatch: 4 },
  },
  baker: {
    title: 'baker',
    // Open ground in the upper-middle of the map, reachable from the field.
    workplaceTarget: { x: 30, y: 20 },
    // Bakes in the morning with wheat delivered the previous afternoon.
    shiftStartHour: 4,
    shiftEndHour: 12,
    task: {
      description: 'baking',
      emoji: '🍞',
      duration: 45_000,
      consumes: { item: 'wheat', amount: 2 },
    },
    output: { item: 'bread', amount: 1 },
    waitingActivity: { description: 'waiting for wheat', emoji: '⏳' },
  },
};

/** How close (in tiles) counts as "arrived". Pathfinding can stop short if the tile is occupied. */
export const WORKPLACE_ARRIVAL_DISTANCE = 2;

/** Minimum time between delivery attempts, so a failed sale doesn't loop. */
export const DELIVERY_COOLDOWN = GAME_DAY_LENGTH / 2;

/** How long one "waiting for inputs" activity lasts before being re-checked/refreshed. */
export const WAITING_ACTIVITY_DURATION = 15_000;

// ---------------------------------------------------------------------------
// Serialized state (stored on the agent inside the world document)
// ---------------------------------------------------------------------------

export const serializedJob = {
  kind: jobKind,
  /** Resolved walkable workplace tile. Unset until first tick. */
  workplace: v.optional(point),
  /** Set while a work task is in progress; equals the task activity's `until`. */
  taskEndsAt: v.optional(v.number()),
  /** Lifetime units produced (a metric; the items themselves go to the player's inventory). */
  produced: v.number(),
  /** When the last delivery was attempted (successful or not). */
  lastDeliveryAt: v.optional(v.number()),
};
export type SerializedJob = ObjectType<typeof serializedJob>;

export function newJob(kind: JobKind): SerializedJob {
  return { kind, produced: 0 };
}

// ---------------------------------------------------------------------------
// Pure decision logic
// ---------------------------------------------------------------------------

export type JobSnapshot = {
  now: number;
  hour: number;
  position: Point;
  pathfindingDestination?: Point;
  activity?: { description: string; until: number };
  /** True if the task's inputs are held (or the task needs none). */
  hasInputs: boolean;
  /** Set when a delivery is due now: where to take it. */
  delivery?: { destination: Point };
};

export type JobStep =
  | { kind: 'offShift' }
  | { kind: 'walkToWork'; destination: Point }
  | { kind: 'walkToDelivery'; destination: Point }
  | { kind: 'walking' }
  | { kind: 'deliver' }
  | { kind: 'waitForInputs' }
  | { kind: 'startTask'; until: number }
  | { kind: 'working' }
  | { kind: 'completeTask' }
  | { kind: 'abandonTask' };

/** Walk to `target`, or report that we've arrived and stopped moving. */
function approach(
  s: JobSnapshot,
  target: Point,
  walkStep: (destination: Point) => JobStep,
): JobStep | 'arrived' {
  const dest = s.pathfindingDestination;
  if (distance(s.position, target) > WORKPLACE_ARRIVAL_DISTANCE) {
    // The pathfinder may swap an occupied destination for a nearby open tile,
    // so "heading there" means heading anywhere that counts as arrived.
    if (dest && distance(dest, target) <= WORKPLACE_ARRIVAL_DISTANCE) {
      return { kind: 'walking' };
    }
    return walkStep(target);
  }
  // Close enough but still moving: let the walk finish. Agent.tick cancels
  // any activity started while pathfinding, so acting now would be undone.
  if (dest) {
    return { kind: 'walking' };
  }
  return 'arrived';
}

export function decideJobStep(
  job: SerializedJob,
  def: JobDefinition,
  workplace: Point,
  s: JobSnapshot,
): JobStep {
  // 1. An in-progress task takes priority, even past the end of the shift.
  if (job.taskEndsAt !== undefined) {
    const taskActivityIntact =
      s.activity?.description === def.task.description && s.activity.until === job.taskEndsAt;
    if (!taskActivityIntact) {
      // Interrupted (e.g. a conversation cut the activity short). No credit.
      return { kind: 'abandonTask' };
    }
    return s.now >= job.taskEndsAt ? { kind: 'completeTask' } : { kind: 'working' };
  }

  // 2. Off shift: deliver output if a delivery is due, otherwise let stock
  // AI Town behavior run.
  if (!inHourWindow(s.hour, def.shiftStartHour, def.shiftEndHour)) {
    if (!s.delivery) {
      return { kind: 'offShift' };
    }
    const step = approach(s, s.delivery.destination, (destination) => ({
      kind: 'walkToDelivery',
      destination,
    }));
    return step === 'arrived' ? { kind: 'deliver' } : step;
  }

  // 3. On shift: get to work.
  const step = approach(s, workplace, (destination) => ({ kind: 'walkToWork', destination }));
  if (step !== 'arrived') {
    return step;
  }

  // 4. At work: start the next task if its inputs are on hand.
  if (!s.hasInputs) {
    return { kind: 'waitForInputs' };
  }
  return { kind: 'startTask', until: s.now + def.task.duration };
}

/** True while the job's shift window covers `hour`, or a task is still finishing. */
export function isOnShift(job: SerializedJob, hour: number): boolean {
  const def = JOB_DEFINITIONS[job.kind];
  return job.taskEndsAt !== undefined || inHourWindow(hour, def.shiftStartHour, def.shiftEndHour);
}

/** Whether the job should attempt a delivery now (ignoring where the recipient is). */
export function deliveryDue(
  job: SerializedJob,
  def: JobDefinition,
  held: number,
  now: number,
): boolean {
  if (!def.delivery || held < def.delivery.minBatch) {
    return false;
  }
  return job.lastDeliveryAt === undefined || now - job.lastDeliveryAt >= DELIVERY_COOLDOWN;
}

/**
 * Whether an on-shift worker should accept a conversation invite.
 *
 * Scripted rule (placeholder for M3's decisionPolicy.ts): while working, agents
 * decline invites from other agents, otherwise NPC small talk eats whole shifts.
 * Invites from human players are always accepted so the player can interrupt.
 */
export function shouldAcceptInviteWhileWorking(inviterIsHuman: boolean): boolean {
  return inviterIsHuman;
}

/**
 * Nearest tile to `target` with no object tiles on any layer, searched in
 * expanding square rings. Returns undefined if the map has no open tile.
 */
export function findOpenTile(
  map: { width: number; height: number; objectTiles: number[][][] },
  target: Point,
): Point | undefined {
  const isOpen = (x: number, y: number) =>
    x >= 0 &&
    y >= 0 &&
    x < map.width &&
    y < map.height &&
    map.objectTiles.every((layer) => layer[x][y] === -1);
  const tx = Math.floor(target.x);
  const ty = Math.floor(target.y);
  const maxRadius = Math.max(map.width, map.height);
  for (let r = 0; r <= maxRadius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) {
          continue; // ring only
        }
        if (isOpen(tx + dx, ty + dy)) {
          return { x: tx + dx, y: ty + dy };
        }
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Engine integration
// ---------------------------------------------------------------------------

function resolveWorkplace(game: Game, job: SerializedJob): Point {
  if (!job.workplace) {
    const target = JOB_DEFINITIONS[job.kind].workplaceTarget;
    job.workplace = findOpenTile(game.worldMap, target) ?? target;
  }
  return job.workplace;
}

/** First agent holding `kind` job, with its player. */
function findWorker(game: Game, kind: JobKind) {
  for (const agent of game.world.agents.values()) {
    if (agent.job?.kind === kind) {
      const player = game.world.players.get(agent.playerId);
      if (player) {
        return { job: agent.job, player };
      }
    }
  }
  return undefined;
}

/**
 * Advance an agent's job by one engine tick. Returns true if the job is
 * driving the agent this tick (caller should not fall through to
 * agentDoSomething), false if there's nothing for the job to do.
 *
 * Callers must only invoke this when the agent is not in a conversation.
 */
export function tickJob(game: Game, now: number, job: SerializedJob, player: Player): boolean {
  const def = JOB_DEFINITIONS[job.kind];
  const workplace = resolveWorkplace(game, job);

  const consumes = def.task.consumes;
  const hasInputs = !consumes || countItem(player.inventory, consumes.item) >= consumes.amount;

  let recipient: ReturnType<typeof findWorker>;
  let delivery: JobSnapshot['delivery'];
  if (def.delivery && deliveryDue(job, def, countItem(player.inventory, def.delivery.item), now)) {
    recipient = findWorker(game, def.delivery.toJob);
    if (recipient && recipient.player.id !== player.id) {
      delivery = { destination: resolveWorkplace(game, recipient.job) };
    }
  }

  const step = decideJobStep(job, def, workplace, {
    now,
    hour: gameHour(now),
    position: player.position,
    pathfindingDestination: player.pathfinding?.destination,
    activity: player.activity,
    hasInputs,
    delivery,
  });

  switch (step.kind) {
    case 'offShift':
      return false;
    case 'walking':
    case 'working':
      return true;
    case 'walkToWork':
    case 'walkToDelivery':
      // Drop any leftover stock activity (reading, daydreaming) before walking.
      if (player.activity && player.activity.until > now) {
        player.activity.until = now;
      }
      movePlayer(game, now, player, step.destination);
      return true;
    case 'deliver': {
      const item = def.delivery!.item;
      const held = countItem(player.inventory, item);
      const sold = recipient ? sellUpTo(player, recipient.player, item, held) : 0;
      job.lastDeliveryAt = now;
      console.log(
        `[econ] ${player.id} (${def.title}) sold ${sold}/${held} ${item}` +
          ` to ${recipient?.player.id} for ${sold * PRICES[item]} coins` +
          ` (seller ${player.coins}, buyer ${recipient?.player.coins})`,
      );
      return true;
    }
    case 'waitForInputs':
      if (def.waitingActivity && !(player.activity && player.activity.until > now)) {
        player.activity = { ...def.waitingActivity, until: now + WAITING_ACTIVITY_DURATION };
      }
      return true;
    case 'startTask':
      player.activity = {
        description: def.task.description,
        emoji: def.task.emoji,
        until: step.until,
      };
      job.taskEndsAt = step.until;
      return true;
    case 'completeTask': {
      delete job.taskEndsAt;
      if (consumes && !removeItem(player.inventory, consumes.item, consumes.amount)) {
        console.log(`[job] ${player.id} (${def.title}) missing ${consumes.item}, nothing produced`);
        return true;
      }
      job.produced += def.output.amount;
      const added = addItem(player.inventory, def.output.item, def.output.amount);
      console.log(
        `[job] ${player.id} (${def.title}) produced ${def.output.amount} ${def.output.item}` +
          `${consumes ? ` from ${consumes.amount} ${consumes.item}` : ''}` +
          ` (lifetime ${job.produced}, holding ${countItem(player.inventory, def.output.item)}` +
          `${added < def.output.amount ? ', inventory full' : ''})`,
      );
      return true;
    }
    case 'abandonTask':
      delete job.taskEndsAt;
      console.log(`[job] ${player.id} (${def.title}) task interrupted`);
      return true;
  }
}
