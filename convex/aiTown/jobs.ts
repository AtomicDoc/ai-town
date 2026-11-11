// Traditional (non-LLM) job system. Milestone 2.
//
// A job is a scripted routine: during shift hours the agent walks to its
// workplace and repeats a work task. A task may consume input items (baker:
// 2 wheat) and may produce output items (bread). Around the work itself:
//   - restock: at/during the shift, buy supplies from another job's workplace
//     (shopkeeper buys bread from the bakery), up to a stock target;
//   - delivery: after the shift, carry output to another job's workplace and
//     sell it there (farmers sell wheat to the bakery), limited by the buyer's
//     stock target and split fairly between suppliers.
// Workplaces are self-serve: trades happen with the owner's stock and purse
// whether or not the owner is standing there.
//
// None of this schedules an agent operation, so a working agent makes zero
// LLM calls. When there's nothing to do, the agent falls back to stock
// AI Town behavior (wandering, conversations).
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
import { formatGameTime, gameHour, inHourWindow } from './clock';
import { movePlayer } from './movement';
import { ItemKind, addItem, countItem, removeItem } from './inventory';
import { WHOLESALE_PRICES, sellUpTo } from './economy';
import { noteTrade } from './relationships';
import { logRoutine } from './decisions';
import { BAKERY, SHOP, WHEAT_FIELD } from './places';
import type { Game } from './game';
import type { Player } from './player';

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export const jobKind = v.union(
  v.literal('farmer'),
  v.literal('farmhand'),
  v.literal('baker'),
  v.literal('shopkeeper'),
);
export type JobKind = Infer<typeof jobKind>;
export const JOB_KINDS: readonly JobKind[] = ['farmer', 'farmhand', 'baker', 'shopkeeper'];

export function isJobKind(value: unknown): value is JobKind {
  return typeof value === 'string' && (JOB_KINDS as readonly string[]).includes(value);
}

export type JobDefinition = {
  title: string;
  /** Short place name for prompts/UI. */
  place: string;
  /** Preferred workplace tile; resolved to the nearest walkable tile at runtime. */
  workplaceTarget: Point;
  /** Default shift window in game hours, [start, end). May wrap past midnight. */
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
  /** What one completed task adds to the worker's inventory, if anything. */
  output?: { item: ItemKind; amount: number };
  /** Shown while on shift at work but missing the task's inputs. */
  waitingActivity?: { description: string; emoji: string };
  /** How much of an item this job wants on hand; caps what it buys. */
  stockTarget?: { item: ItemKind; amount: number };
  /** On shift, buy `stockTarget` item from the `fromJob` workplace when low. */
  restock?: { fromJob: JobKind; below: number };
  /** After the shift, carry `item` to the `toJob` worker's workplace and sell it. */
  delivery?: { item: ItemKind; toJob: JobKind; minBatch: number };
};

// Workplace names and tiles live in places.ts (shared with free-time places).

export const JOB_DEFINITIONS: Record<JobKind, JobDefinition> = {
  farmer: {
    title: 'farmer',
    place: WHEAT_FIELD.name,
    workplaceTarget: WHEAT_FIELD.target,
    shiftStartHour: 6,
    shiftEndHour: 16,
    task: { description: 'farming', emoji: '🌾', duration: 30_000 },
    output: { item: 'wheat', amount: 1 },
    delivery: { item: 'wheat', toJob: 'baker', minBatch: 4 },
  },
  farmhand: {
    title: 'farmhand',
    place: WHEAT_FIELD.name,
    workplaceTarget: WHEAT_FIELD.target,
    shiftStartHour: 10,
    shiftEndHour: 18,
    task: { description: 'farming', emoji: '🌾', duration: 40_000 },
    output: { item: 'wheat', amount: 1 },
    delivery: { item: 'wheat', toJob: 'baker', minBatch: 4 },
  },
  baker: {
    title: 'baker',
    place: BAKERY.name,
    workplaceTarget: BAKERY.target,
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
    // About a day of baking; farmers can't sell more wheat than this.
    stockTarget: { item: 'wheat', amount: 18 },
  },
  shopkeeper: {
    title: 'shopkeeper',
    place: SHOP.name,
    workplaceTarget: SHOP.target,
    // Default morning shift; a second shopkeeper overrides it (see characters.ts).
    shiftStartHour: 6,
    shiftEndHour: 14,
    task: { description: 'tending the shop', emoji: '🧺', duration: 60_000 },
    stockTarget: { item: 'bread', amount: 6 },
    restock: { fromJob: 'baker', below: 3 },
  },
};

/** How close (in tiles) counts as "arrived". Pathfinding can stop short if the tile is occupied. */
export const WORKPLACE_ARRIVAL_DISTANCE = 2;

/** Minimum time between delivery attempts, so a failed sale doesn't loop. */
export const DELIVERY_COOLDOWN = GAME_DAY_LENGTH / 2;

/** Minimum time between restock attempts. */
export const RESTOCK_COOLDOWN = GAME_DAY_LENGTH / 6;

/** How long one "waiting for inputs" activity lasts before being re-checked/refreshed. */
export const WAITING_ACTIVITY_DURATION = 15_000;

// ---------------------------------------------------------------------------
// Serialized state (stored on the agent inside the world document)
// ---------------------------------------------------------------------------

export const jobShift = v.object({ start: v.number(), end: v.number() });

export const serializedJob = {
  kind: jobKind,
  /** Per-worker shift override (game hours), e.g. a second shopkeeper's evening shift. */
  shift: v.optional(jobShift),
  /** Resolved walkable workplace tile. Unset until first tick. */
  workplace: v.optional(point),
  /** Set while a work task is in progress; equals the task activity's `until`. */
  taskEndsAt: v.optional(v.number()),
  /** Lifetime units produced (a metric; the items themselves go to the player's inventory). */
  produced: v.number(),
  /** When the last delivery was attempted (successful or not). */
  lastDeliveryAt: v.optional(v.number()),
  /** When the last restock was attempted (successful or not). */
  lastRestockAt: v.optional(v.number()),
};
export type SerializedJob = ObjectType<typeof serializedJob>;

export function newJob(kind: JobKind, shift?: { start: number; end: number }): SerializedJob {
  return shift ? { kind, shift, produced: 0 } : { kind, produced: 0 };
}

/** The job's effective shift window. */
export function shiftWindow(job: SerializedJob): { start: number; end: number } {
  const def = JOB_DEFINITIONS[job.kind];
  return job.shift ?? { start: def.shiftStartHour, end: def.shiftEndHour };
}

/** "06:00–14:00" */
export function describeShift(job: SerializedJob): string {
  const { start, end } = shiftWindow(job);
  return `${formatGameTime(start)}–${formatGameTime(end)}`;
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
  /** Set when a restock is due now: where to buy. */
  restock?: { destination: Point };
};

export type JobStep =
  | { kind: 'offShift' }
  | { kind: 'walkToWork'; destination: Point }
  | { kind: 'walkToDelivery'; destination: Point }
  | { kind: 'walkToRestock'; destination: Point }
  | { kind: 'walking' }
  | { kind: 'deliver' }
  | { kind: 'restock' }
  | { kind: 'waitForInputs' }
  | { kind: 'startTask'; until: number }
  | { kind: 'working' }
  | { kind: 'completeTask' }
  | { kind: 'abandonTask' };

/** Walk to `target`, or report that we've arrived and stopped moving. */
export function approach(
  s: { position: Point; pathfindingDestination?: Point },
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
  const { start, end } = shiftWindow(job);
  if (!inHourWindow(s.hour, start, end)) {
    if (!s.delivery) {
      return { kind: 'offShift' };
    }
    const step = approach(s, s.delivery.destination, (destination) => ({
      kind: 'walkToDelivery',
      destination,
    }));
    return step === 'arrived' ? { kind: 'deliver' } : step;
  }

  // 3. On shift: fetch supplies first if running low.
  if (s.restock) {
    const step = approach(s, s.restock.destination, (destination) => ({
      kind: 'walkToRestock',
      destination,
    }));
    return step === 'arrived' ? { kind: 'restock' } : step;
  }

  // 4. Get to work.
  const step = approach(s, workplace, (destination) => ({ kind: 'walkToWork', destination }));
  if (step !== 'arrived') {
    return step;
  }

  // 5. At work: start the next task if its inputs are on hand.
  if (!s.hasInputs) {
    return { kind: 'waitForInputs' };
  }
  return { kind: 'startTask', until: s.now + def.task.duration };
}

/** True while the job's shift window covers `hour`, or a task is still finishing. */
export function isOnShift(job: SerializedJob, hour: number): boolean {
  const { start, end } = shiftWindow(job);
  return job.taskEndsAt !== undefined || inHourWindow(hour, start, end);
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

/** Whether the job should go restock now (ignoring the supplier's stock). */
export function restockDue(
  job: SerializedJob,
  def: JobDefinition,
  held: number,
  now: number,
): boolean {
  if (!def.restock || !def.stockTarget || held >= def.stockTarget.amount) {
    return false;
  }
  // Top up to the target once at the start of every shift, whatever is left.
  if (job.lastRestockAt === undefined || job.lastRestockAt < currentShiftStart(job, now)) {
    return true;
  }
  // During the shift, top up again only when running low.
  return held < def.restock.below && now - job.lastRestockAt >= RESTOCK_COOLDOWN;
}

/** Wall-clock time at which the most recent occurrence of the job's shift began. */
export function currentShiftStart(
  job: SerializedJob,
  now: number,
  dayLength: number = GAME_DAY_LENGTH,
): number {
  const { start } = shiftWindow(job);
  const hoursSinceStart = (gameHour(now, dayLength) - start + 24) % 24;
  return now - (hoursSinceStart / 24) * dayLength;
}

/**
 * How many units one supplier may sell to a buyer in one delivery: no more
 * than the supplier holds, than the buyer still wants, or than the supplier's
 * fair share of the buyer's target when several suppliers serve one buyer.
 */
export function deliveryQuantity(
  held: number,
  buyerHeld: number,
  buyerTarget: number | undefined,
  suppliers: number,
): number {
  if (buyerTarget === undefined) {
    return held;
  }
  const wanted = Math.max(0, buyerTarget - buyerHeld);
  const share = Math.ceil(buyerTarget / Math.max(1, suppliers));
  return Math.max(0, Math.min(held, wanted, share));
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

export function resolveWorkplace(game: Game, job: SerializedJob): Point {
  if (!job.workplace) {
    const target = JOB_DEFINITIONS[job.kind].workplaceTarget;
    job.workplace = findOpenTile(game.worldMap, target) ?? target;
  }
  return job.workplace;
}

/** All agents holding a `kind` job, with their players. */
export function findWorkers(game: Game, kind: JobKind) {
  const workers: { job: SerializedJob; player: Player }[] = [];
  for (const agent of game.world.agents.values()) {
    if (agent.job?.kind === kind) {
      const player = game.world.players.get(agent.playerId);
      if (player) {
        workers.push({ job: agent.job, player });
      }
    }
  }
  return workers;
}

/** Number of workers whose job delivers `item` to `toJob`. */
function countSuppliers(game: Game, item: ItemKind, toJob: JobKind): number {
  let n = 0;
  for (const agent of game.world.agents.values()) {
    const d = agent.job && JOB_DEFINITIONS[agent.job.kind].delivery;
    if (d && d.item === item && d.toJob === toJob) {
      n++;
    }
  }
  return n;
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

  // Delivery: sell output to the first recipient that still wants it.
  let recipient: ReturnType<typeof findWorkers>[number] | undefined;
  let delivery: JobSnapshot['delivery'];
  if (def.delivery && deliveryDue(job, def, countItem(player.inventory, def.delivery.item), now)) {
    recipient = findWorkers(game, def.delivery.toJob).find((w) => w.player.id !== player.id);
    if (recipient) {
      delivery = { destination: resolveWorkplace(game, recipient.job) };
    }
  }

  // Restock: buy from the supplier with the most stock.
  let supplier: ReturnType<typeof findWorkers>[number] | undefined;
  let restock: JobSnapshot['restock'];
  if (
    def.restock &&
    def.stockTarget &&
    restockDue(job, def, countItem(player.inventory, def.stockTarget.item), now)
  ) {
    const item = def.stockTarget.item;
    supplier = findWorkers(game, def.restock.fromJob)
      .filter((w) => w.player.id !== player.id && countItem(w.player.inventory, item) > 0)
      .sort((a, b) => countItem(b.player.inventory, item) - countItem(a.player.inventory, item))[0];
    if (supplier && player.coins >= WHOLESALE_PRICES[item]) {
      restock = { destination: resolveWorkplace(game, supplier.job) };
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
    restock,
  });

  switch (step.kind) {
    case 'offShift':
      return false;
    case 'walking':
    case 'working':
      return true;
    case 'walkToWork':
    case 'walkToDelivery':
    case 'walkToRestock':
      // Drop any leftover activity (reading, daydreaming, waiting) before walking.
      if (player.activity && player.activity.until > now) {
        player.activity.until = now;
      }
      movePlayer(game, now, player, step.destination);
      logRoutine(game, now, player, step.kind);
      return true;
    case 'deliver': {
      const item = def.delivery!.item;
      const held = countItem(player.inventory, item);
      let sold = 0;
      if (recipient) {
        const target = JOB_DEFINITIONS[recipient.job.kind].stockTarget;
        const quantity = deliveryQuantity(
          held,
          countItem(recipient.player.inventory, item),
          target?.item === item ? target.amount : undefined,
          countSuppliers(game, item, recipient.job.kind),
        );
        sold = sellUpTo(player, recipient.player, item, quantity, WHOLESALE_PRICES[item]);
        if (sold > 0) {
          noteTrade(game, player.id, recipient.player.id);
        }
      }
      job.lastDeliveryAt = now;
      logRoutine(game, now, player, 'deliver');
      console.log(
        `[econ] ${player.id} (${def.title}) sold ${sold}/${held} ${item}` +
          ` to ${recipient?.player.id} for ${sold * WHOLESALE_PRICES[item]} coins` +
          ` (seller ${player.coins}, buyer ${recipient?.player.coins})`,
      );
      return true;
    }
    case 'restock': {
      const item = def.stockTarget!.item;
      const wanted = Math.max(0, def.stockTarget!.amount - countItem(player.inventory, item));
      const bought = supplier
        ? sellUpTo(supplier.player, player, item, wanted, WHOLESALE_PRICES[item])
        : 0;
      if (supplier && bought > 0) {
        noteTrade(game, supplier.player.id, player.id);
      }
      job.lastRestockAt = now;
      logRoutine(game, now, player, 'restock');
      console.log(
        `[econ] ${player.id} (${def.title}) restocked ${bought}/${wanted} ${item}` +
          ` from ${supplier?.player.id} for ${bought * WHOLESALE_PRICES[item]} coins` +
          ` (buyer ${player.coins}, seller ${supplier?.player.coins})`,
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
      logRoutine(game, now, player, 'startTask');
      return true;
    case 'completeTask': {
      delete job.taskEndsAt;
      if (consumes && !removeItem(player.inventory, consumes.item, consumes.amount)) {
        console.log(`[job] ${player.id} (${def.title}) missing ${consumes.item}, nothing produced`);
        return true;
      }
      if (!def.output) {
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
