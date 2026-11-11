import {
  Inventory,
  MAX_STACK,
  addItem,
  countItem,
  describeInventory,
  parseInventory,
  removeItem,
  transferItem,
} from './inventory';
import { dayPhase, formatGameTime } from './clock';

describe('inventory', () => {
  test('add and count', () => {
    const inv: Inventory = {};
    expect(countItem(inv, 'wheat')).toBe(0);
    expect(addItem(inv, 'wheat', 2)).toBe(2);
    expect(addItem(inv, 'wheat', 1)).toBe(1);
    expect(countItem(inv, 'wheat')).toBe(3);
    expect(countItem(undefined, 'wheat')).toBe(0);
  });

  test('add caps at MAX_STACK and reports what fit', () => {
    const inv: Inventory = { wheat: MAX_STACK - 1 };
    expect(addItem(inv, 'wheat', 5)).toBe(1);
    expect(countItem(inv, 'wheat')).toBe(MAX_STACK);
  });

  test('remove succeeds only with enough items, and clears empty entries', () => {
    const inv: Inventory = { bread: 2 };
    expect(removeItem(inv, 'bread', 3)).toBe(false);
    expect(inv).toEqual({ bread: 2 });
    expect(removeItem(inv, 'bread', 1)).toBe(true);
    expect(inv).toEqual({ bread: 1 });
    expect(removeItem(inv, 'bread', 1)).toBe(true);
    expect(inv).toEqual({});
  });

  test('rejects non-positive or fractional quantities', () => {
    const inv: Inventory = { wheat: 5 };
    expect(() => addItem(inv, 'wheat', 0)).toThrow();
    expect(() => addItem(inv, 'wheat', -1)).toThrow();
    expect(() => removeItem(inv, 'wheat', 1.5)).toThrow();
  });

  test('transfer is all-or-nothing', () => {
    const farmer: Inventory = { wheat: 3 };
    const baker: Inventory = {};
    expect(transferItem(farmer, baker, 'wheat', 5)).toBe(false);
    expect(farmer).toEqual({ wheat: 3 });
    expect(baker).toEqual({});
    expect(transferItem(farmer, baker, 'wheat', 3)).toBe(true);
    expect(farmer).toEqual({});
    expect(baker).toEqual({ wheat: 3 });
  });

  test('transfer fails if the destination would overflow', () => {
    const from: Inventory = { wheat: 2 };
    const to: Inventory = { wheat: MAX_STACK - 1 };
    expect(transferItem(from, to, 'wheat', 2)).toBe(false);
    expect(from).toEqual({ wheat: 2 });
  });

  test('parseInventory drops unknown items and bad counts', () => {
    expect(parseInventory(undefined)).toEqual({});
    expect(parseInventory({ wheat: 2, gold: 9, bread: 0, x: -1 })).toEqual({ wheat: 2 });
    expect(parseInventory({ wheat: 1.5 })).toEqual({});
  });

  test('describeInventory', () => {
    expect(describeInventory({})).toBe('nothing');
    expect(describeInventory({ bread: 1, wheat: 3 })).toBe('🌾 3 wheat, 🍞 1 bread');
  });
});

describe('clock display', () => {
  test('formatGameTime', () => {
    expect(formatGameTime(0)).toBe('00:00');
    expect(formatGameTime(7.5)).toBe('07:30');
    expect(formatGameTime(23.999)).toBe('23:59');
  });

  test('dayPhase', () => {
    expect(dayPhase(3)).toBe('Night');
    expect(dayPhase(6)).toBe('Morning');
    expect(dayPhase(13)).toBe('Afternoon');
    expect(dayPhase(18)).toBe('Evening');
    expect(dayPhase(22)).toBe('Night');
  });
});
