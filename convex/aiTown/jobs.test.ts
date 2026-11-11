import { gameHour, inHourWindow } from './clock';
import {
  DELIVERY_COOLDOWN,
  JOB_DEFINITIONS,
  RESTOCK_COOLDOWN,
  deliveryDue,
  deliveryQuantity,
  describeShift,
  restockDue,
  JobSnapshot,
  SerializedJob,
  WORKPLACE_ARRIVAL_DISTANCE,
  decideJobStep,
  findOpenTile,
  isJobKind,
  isOnShift,
  newJob,
  shouldAcceptInviteWhileWorking,
} from './jobs';

const farmer = JOB_DEFINITIONS.farmer;
const workplace = { x: 56, y: 40 };
const NOW = 1_000_000;
const ON_SHIFT = 10; // farmer shift is [6, 16)
const OFF_SHIFT = 20;

function snapshot(overrides: Partial<JobSnapshot> = {}): JobSnapshot {
  return { now: NOW, hour: ON_SHIFT, position: { ...workplace }, hasInputs: true, ...overrides };
}

function workingJob(taskEndsAt: number): SerializedJob {
  return { ...newJob('farmer'), workplace, taskEndsAt };
}

describe('clock', () => {
  test('gameHour maps a day onto [0, 24)', () => {
    const day = 24_000;
    expect(gameHour(0, day)).toBe(0);
    expect(gameHour(6_000, day)).toBe(6);
    expect(gameHour(day + 12_000, day)).toBe(12);
  });

  test('inHourWindow handles normal and wrapping windows', () => {
    expect(inHourWindow(10, 6, 16)).toBe(true);
    expect(inHourWindow(16, 6, 16)).toBe(false);
    expect(inHourWindow(5.99, 6, 16)).toBe(false);
    expect(inHourWindow(23, 22, 6)).toBe(true);
    expect(inHourWindow(3, 22, 6)).toBe(true);
    expect(inHourWindow(12, 22, 6)).toBe(false);
    expect(inHourWindow(12, 0, 0)).toBe(true);
  });
});

describe('decideJobStep', () => {
  test('off shift with no task in progress defers to stock behavior', () => {
    const step = decideJobStep(newJob('farmer'), farmer, workplace, snapshot({ hour: OFF_SHIFT }));
    expect(step).toEqual({ kind: 'offShift' });
  });

  test('on shift and far away: walk to the workplace', () => {
    const step = decideJobStep(
      newJob('farmer'),
      farmer,
      workplace,
      snapshot({ position: { x: 5, y: 5 } }),
    );
    expect(step).toEqual({ kind: 'walkToWork', destination: workplace });
  });

  test('already pathfinding to the workplace: keep walking', () => {
    const step = decideJobStep(
      newJob('farmer'),
      farmer,
      workplace,
      snapshot({ position: { x: 5, y: 5 }, pathfindingDestination: workplace }),
    );
    expect(step).toEqual({ kind: 'walking' });
  });

  test('pathfinding somewhere else: redirect to the workplace', () => {
    const step = decideJobStep(
      newJob('farmer'),
      farmer,
      workplace,
      snapshot({ position: { x: 5, y: 5 }, pathfindingDestination: { x: 1, y: 1 } }),
    );
    expect(step.kind).toBe('walkToWork');
  });

  test('within arrival distance counts as at work', () => {
    const near = { x: workplace.x + WORKPLACE_ARRIVAL_DISTANCE, y: workplace.y };
    const step = decideJobStep(newJob('farmer'), farmer, workplace, snapshot({ position: near }));
    expect(step).toEqual({ kind: 'startTask', until: NOW + farmer.task.duration });
  });

  test('pathfinder swapped the destination for a nearby tile: still walking', () => {
    const step = decideJobStep(
      newJob('farmer'),
      farmer,
      workplace,
      snapshot({ position: { x: 5, y: 5 }, pathfindingDestination: { x: 57, y: 40 } }),
    );
    expect(step).toEqual({ kind: 'walking' });
  });

  test('close enough but still moving: finish the walk before starting a task', () => {
    const step = decideJobStep(
      newJob('farmer'),
      farmer,
      workplace,
      snapshot({ position: { x: 55, y: 40 }, pathfindingDestination: workplace }),
    );
    expect(step).toEqual({ kind: 'walking' });
  });

  test('task in progress with intact activity: keep working', () => {
    const until = NOW + 5_000;
    const step = decideJobStep(
      workingJob(until),
      farmer,
      workplace,
      snapshot({ activity: { description: farmer.task.description, until } }),
    );
    expect(step).toEqual({ kind: 'working' });
  });

  test('task reaches its end: complete it', () => {
    const until = NOW;
    const step = decideJobStep(
      workingJob(until),
      farmer,
      workplace,
      snapshot({ activity: { description: farmer.task.description, until } }),
    );
    expect(step).toEqual({ kind: 'completeTask' });
  });

  test('a task in progress finishes even after the shift ends', () => {
    const until = NOW;
    const step = decideJobStep(
      workingJob(until),
      farmer,
      workplace,
      snapshot({ hour: OFF_SHIFT, activity: { description: farmer.task.description, until } }),
    );
    expect(step).toEqual({ kind: 'completeTask' });
  });

  test('activity cut short (conversation) abandons the task without credit', () => {
    const taskEndsAt = NOW + 20_000;
    const step = decideJobStep(
      workingJob(taskEndsAt),
      farmer,
      workplace,
      snapshot({ activity: { description: farmer.task.description, until: NOW - 1_000 } }),
    );
    expect(step).toEqual({ kind: 'abandonTask' });
  });

  test('activity replaced by something else abandons the task', () => {
    const taskEndsAt = NOW + 20_000;
    const step = decideJobStep(
      workingJob(taskEndsAt),
      farmer,
      workplace,
      snapshot({ activity: { description: 'reading a book', until: taskEndsAt } }),
    );
    expect(step).toEqual({ kind: 'abandonTask' });
  });
});

describe('findOpenTile', () => {
  // 5x5 map, everything blocked except (4, 4) and (1, 2).
  const blocked = () => Array.from({ length: 5 }, () => Array(5).fill(7));
  const layer = blocked();
  layer[4][4] = -1;
  layer[1][2] = -1;
  const map = { width: 5, height: 5, objectTiles: [layer] };

  test('returns the target when it is open', () => {
    expect(findOpenTile(map, { x: 4, y: 4 })).toEqual({ x: 4, y: 4 });
  });

  test('returns the nearest open tile when the target is blocked', () => {
    expect(findOpenTile(map, { x: 0, y: 2 })).toEqual({ x: 1, y: 2 });
  });

  test('an open tile must be clear on every layer', () => {
    const second = blocked();
    second[1][2] = -1; // (4,4) blocked on this layer
    const twoLayers = { width: 5, height: 5, objectTiles: [layer, second] };
    expect(findOpenTile(twoLayers, { x: 4, y: 4 })).toEqual({ x: 1, y: 2 });
  });

  test('returns undefined when nothing is open', () => {
    expect(
      findOpenTile(
        {
          width: 2,
          height: 2,
          objectTiles: [
            [
              [0, 0],
              [0, 0],
            ],
          ],
        },
        { x: 0, y: 0 },
      ),
    ).toBeUndefined();
  });
});

describe('baker (task with inputs)', () => {
  const baker = JOB_DEFINITIONS.baker;
  const bakery = { x: 30, y: 20 };
  const BAKER_ON_SHIFT = 8; // [4, 12)

  test('at work with wheat: start baking', () => {
    const step = decideJobStep(newJob('baker'), baker, bakery, {
      now: NOW,
      hour: BAKER_ON_SHIFT,
      position: bakery,
      hasInputs: true,
    });
    expect(step).toEqual({ kind: 'startTask', until: NOW + baker.task.duration });
  });

  test('at work without wheat: wait', () => {
    const step = decideJobStep(newJob('baker'), baker, bakery, {
      now: NOW,
      hour: BAKER_ON_SHIFT,
      position: bakery,
      hasInputs: false,
    });
    expect(step).toEqual({ kind: 'waitForInputs' });
  });

  test('missing inputs does not stop the walk to work', () => {
    const step = decideJobStep(newJob('baker'), baker, bakery, {
      now: NOW,
      hour: BAKER_ON_SHIFT,
      position: { x: 50, y: 40 },
      hasInputs: false,
    });
    expect(step).toEqual({ kind: 'walkToWork', destination: bakery });
  });
});

describe('farmer delivery (off shift)', () => {
  const bakery = { x: 30, y: 20 };

  test('no delivery due: off shift', () => {
    const step = decideJobStep(newJob('farmer'), farmer, workplace, snapshot({ hour: OFF_SHIFT }));
    expect(step).toEqual({ kind: 'offShift' });
  });

  test('delivery due and far away: walk to the bakery', () => {
    const step = decideJobStep(
      newJob('farmer'),
      farmer,
      workplace,
      snapshot({ hour: OFF_SHIFT, delivery: { destination: bakery } }),
    );
    expect(step).toEqual({ kind: 'walkToDelivery', destination: bakery });
  });

  test('delivery due and arrived: deliver', () => {
    const step = decideJobStep(
      newJob('farmer'),
      farmer,
      workplace,
      snapshot({ hour: OFF_SHIFT, position: bakery, delivery: { destination: bakery } }),
    );
    expect(step).toEqual({ kind: 'deliver' });
  });

  test('delivery is ignored during the shift', () => {
    const step = decideJobStep(
      newJob('farmer'),
      farmer,
      workplace,
      snapshot({ delivery: { destination: bakery } }),
    );
    expect(step.kind).toBe('startTask');
  });

  test('deliveryDue needs a minimum batch and respects the cooldown', () => {
    const min = farmer.delivery!.minBatch;
    expect(deliveryDue(newJob('farmer'), farmer, min - 1, NOW)).toBe(false);
    expect(deliveryDue(newJob('farmer'), farmer, min, NOW)).toBe(true);
    const recent = { ...newJob('farmer'), lastDeliveryAt: NOW - 1_000 };
    expect(deliveryDue(recent, farmer, min, NOW)).toBe(false);
    const old = { ...newJob('farmer'), lastDeliveryAt: NOW - DELIVERY_COOLDOWN };
    expect(deliveryDue(old, farmer, min, NOW)).toBe(true);
    expect(deliveryDue(newJob('baker'), JOB_DEFINITIONS.baker, 99, NOW)).toBe(false);
  });
});

describe('shopkeeper (restock, no output)', () => {
  const shopkeeper = JOB_DEFINITIONS.shopkeeper;
  const shop = { x: 42, y: 30 };
  const bakery = { x: 30, y: 20 };

  test('restock due: walk to the bakery before going to the shop', () => {
    const step = decideJobStep(newJob('shopkeeper'), shopkeeper, shop, {
      now: NOW,
      hour: 8,
      position: shop,
      hasInputs: true,
      restock: { destination: bakery },
    });
    expect(step).toEqual({ kind: 'walkToRestock', destination: bakery });
  });

  test('restock due and at the bakery: restock', () => {
    const step = decideJobStep(newJob('shopkeeper'), shopkeeper, shop, {
      now: NOW,
      hour: 8,
      position: bakery,
      hasInputs: true,
      restock: { destination: bakery },
    });
    expect(step).toEqual({ kind: 'restock' });
  });

  test('restockDue: only when low, and not more often than the cooldown', () => {
    const below = shopkeeper.restock!.below;
    expect(restockDue(newJob('shopkeeper'), shopkeeper, below, NOW)).toBe(false);
    expect(restockDue(newJob('shopkeeper'), shopkeeper, below - 1, NOW)).toBe(true);
    const recent = { ...newJob('shopkeeper'), lastRestockAt: NOW - 1 };
    expect(restockDue(recent, shopkeeper, 0, NOW)).toBe(false);
    const old = { ...newJob('shopkeeper'), lastRestockAt: NOW - RESTOCK_COOLDOWN };
    expect(restockDue(old, shopkeeper, 0, NOW)).toBe(true);
    expect(restockDue(newJob('farmer'), farmer, 0, NOW)).toBe(false);
  });

  test('a shift override moves the working hours', () => {
    const evening = newJob('shopkeeper', { start: 14, end: 22 });
    expect(isOnShift(evening, 8)).toBe(false);
    expect(isOnShift(evening, 18)).toBe(true);
    expect(describeShift(evening)).toBe('14:00–22:00');
    expect(describeShift(newJob('shopkeeper'))).toBe('06:00–14:00');
    const step = decideJobStep(evening, shopkeeper, shop, {
      now: NOW,
      hour: 8,
      position: shop,
      hasInputs: true,
    });
    expect(step).toEqual({ kind: 'offShift' });
  });
});

describe('deliveryQuantity', () => {
  test('no buyer target: sell everything held', () => {
    expect(deliveryQuantity(12, 0, undefined, 2)).toBe(12);
  });
  test('limited by what the buyer still wants', () => {
    expect(deliveryQuantity(12, 15, 18, 1)).toBe(3);
    expect(deliveryQuantity(12, 20, 18, 1)).toBe(0);
  });
  test('two suppliers each get a fair share', () => {
    expect(deliveryQuantity(15, 0, 18, 2)).toBe(9);
    expect(deliveryQuantity(5, 0, 18, 2)).toBe(5);
  });
});

describe('shift rules', () => {
  test('isOnShift follows the shift window', () => {
    expect(isOnShift(newJob('farmer'), ON_SHIFT)).toBe(true);
    expect(isOnShift(newJob('farmer'), OFF_SHIFT)).toBe(false);
  });

  test('isOnShift stays true while a task is finishing after the shift ends', () => {
    expect(isOnShift(workingJob(NOW + 1_000), OFF_SHIFT)).toBe(true);
  });

  test('on-shift workers accept humans but decline agents', () => {
    expect(shouldAcceptInviteWhileWorking(true)).toBe(true);
    expect(shouldAcceptInviteWhileWorking(false)).toBe(false);
  });
});

test('isJobKind', () => {
  expect(isJobKind('farmer')).toBe(true);
  expect(isJobKind('baker')).toBe(true);
  expect(isJobKind('wizard')).toBe(false);
  expect(isJobKind(undefined)).toBe(false);
});
