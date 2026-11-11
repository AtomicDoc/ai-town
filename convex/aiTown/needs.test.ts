import {
  EAT_AT,
  HUNGER_FULL_TIME,
  NeedsSnapshot,
  SHOP_AT,
  SHOP_COOLDOWN,
  SPARE_BREAD,
  decideNeedsStep,
  describeHunger,
  hungerLevel,
  shoppingDue,
} from './needs';
import { PRICES } from './economy';
import { GAME_DAY_LENGTH } from '../constants';

const NOW = 10_000_000;
const shop = { x: 42, y: 30 };

function snap(overrides: Partial<NeedsSnapshot> = {}): NeedsSnapshot {
  return {
    hunger: 0,
    bread: 0,
    working: false,
    taskInProgress: false,
    eating: false,
    position: { x: 5, y: 5 },
    ...overrides,
  };
}

describe('hunger', () => {
  test('rises linearly from the last meal and caps at 100', () => {
    expect(hungerLevel(NOW, NOW)).toBe(0);
    expect(hungerLevel(NOW - HUNGER_FULL_TIME / 2, NOW)).toBe(50);
    expect(hungerLevel(NOW - HUNGER_FULL_TIME * 3, NOW)).toBe(100);
    expect(hungerLevel(undefined, NOW)).toBe(0);
  });

  test('agents get hungry about once per game day', () => {
    expect(hungerLevel(NOW - GAME_DAY_LENGTH, NOW)).toBe(EAT_AT);
  });

  test('describeHunger', () => {
    expect(describeHunger(0)).toBeUndefined();
    expect(describeHunger(SHOP_AT)).toBe('a little peckish');
    expect(describeHunger(EAT_AT)).toBe('hungry');
    expect(describeHunger(90)).toBe('starving');
  });
});

describe('decideNeedsStep', () => {
  test('hungry with bread and standing still: eat, even on shift', () => {
    expect(decideNeedsStep(snap({ hunger: EAT_AT, bread: 1 }))).toEqual({ kind: 'eat' });
    expect(decideNeedsStep(snap({ hunger: EAT_AT, bread: 1, working: true }))).toEqual({
      kind: 'eat',
    });
  });

  test('does not eat mid-task, while walking, or without bread', () => {
    expect(decideNeedsStep(snap({ hunger: 90, bread: 1, taskInProgress: true })).kind).toBe('none');
    expect(
      decideNeedsStep(snap({ hunger: 90, bread: 1, pathfindingDestination: { x: 1, y: 1 } })).kind,
    ).toBe('none');
    expect(decideNeedsStep(snap({ hunger: 90, bread: 0 })).kind).toBe('none');
  });

  test('keeps eating until the activity ends', () => {
    expect(decideNeedsStep(snap({ eating: true }))).toEqual({ kind: 'eating' });
  });

  test('off shift with a shopping trip due: walk to the shop, then buy', () => {
    expect(decideNeedsStep(snap({ shop: { destination: shop } }))).toEqual({
      kind: 'walkToWork',
      destination: shop,
    });
    expect(decideNeedsStep(snap({ position: shop, shop: { destination: shop } }))).toEqual({
      kind: 'buy',
    });
  });

  test('never shops while working', () => {
    expect(decideNeedsStep(snap({ working: true, shop: { destination: shop } })).kind).toBe('none');
  });
});

describe('shoppingDue', () => {
  const needs = { lastAteAt: NOW };

  test('peckish, low on bread, can afford it', () => {
    expect(shoppingDue(needs, SHOP_AT, 0, PRICES.bread, NOW)).toBe(true);
  });

  test('not yet peckish, already stocked, or broke', () => {
    expect(shoppingDue(needs, SHOP_AT - 1, 0, 100, NOW)).toBe(false);
    expect(shoppingDue(needs, 90, SPARE_BREAD, 100, NOW)).toBe(false);
    expect(shoppingDue(needs, 90, 0, PRICES.bread - 1, NOW)).toBe(false);
  });

  test('respects the cooldown between trips', () => {
    expect(shoppingDue({ ...needs, lastShopAt: NOW - 1 }, 90, 0, 100, NOW)).toBe(false);
    expect(shoppingDue({ ...needs, lastShopAt: NOW - SHOP_COOLDOWN }, 90, 0, 100, NOW)).toBe(true);
  });
});
