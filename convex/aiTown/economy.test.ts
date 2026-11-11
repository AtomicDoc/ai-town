import {
  PRICES,
  STARTING_COINS,
  Wallet,
  maxTradeQuantity,
  parseCoins,
  sellUpTo,
  trade,
} from './economy';
import { MAX_STACK } from './inventory';

function wallet(coins: number, inventory: Wallet['inventory'] = {}): Wallet {
  return { coins, inventory: { ...inventory } };
}

describe('economy', () => {
  test('bread is worth more than the wheat it takes to bake', () => {
    expect(PRICES.bread).toBeGreaterThan(2 * PRICES.wheat);
  });

  test('trade moves items one way and coins the other', () => {
    const farmer = wallet(0, { wheat: 5 });
    const baker = wallet(50);
    expect(trade(farmer, baker, 'wheat', 3)).toBe(true);
    expect(farmer).toEqual({ coins: 3 * PRICES.wheat, inventory: { wheat: 2 } });
    expect(baker).toEqual({ coins: 50 - 3 * PRICES.wheat, inventory: { wheat: 3 } });
  });

  test('trade is all-or-nothing', () => {
    const farmer = wallet(0, { wheat: 5 });
    const poorBaker = wallet(PRICES.wheat * 2);
    expect(trade(farmer, poorBaker, 'wheat', 3)).toBe(false);
    expect(farmer).toEqual(wallet(0, { wheat: 5 }));
    expect(poorBaker).toEqual(wallet(PRICES.wheat * 2));
    expect(trade(farmer, wallet(100), 'wheat', 6)).toBe(false);
  });

  test('cannot trade with yourself', () => {
    const w = wallet(50, { wheat: 5 });
    expect(trade(w, w, 'wheat', 1)).toBe(false);
  });

  test('maxTradeQuantity is limited by stock, money, and room', () => {
    expect(maxTradeQuantity(wallet(0, { wheat: 5 }), wallet(100), 'wheat')).toBe(5);
    expect(maxTradeQuantity(wallet(0, { wheat: 5 }), wallet(PRICES.wheat * 2 + 1), 'wheat')).toBe(
      2,
    );
    expect(
      maxTradeQuantity(wallet(0, { wheat: 5 }), wallet(100, { wheat: MAX_STACK - 1 }), 'wheat'),
    ).toBe(1);
    expect(maxTradeQuantity(wallet(0), wallet(100), 'wheat')).toBe(0);
  });

  test('sellUpTo sells what the buyer can afford', () => {
    const farmer = wallet(0, { wheat: 10 });
    const baker = wallet(PRICES.wheat * 4);
    expect(sellUpTo(farmer, baker, 'wheat', 10)).toBe(4);
    expect(farmer.inventory).toEqual({ wheat: 6 });
    expect(baker.coins).toBe(0);
    expect(sellUpTo(farmer, baker, 'wheat', 10)).toBe(0);
  });

  test('rejects invalid quantities', () => {
    expect(() => trade(wallet(0, { wheat: 1 }), wallet(10), 'wheat', 0)).toThrow();
    expect(() => trade(wallet(0, { wheat: 1 }), wallet(10), 'wheat', 1.5)).toThrow();
  });

  test('parseCoins defaults old saves and clamps bad values', () => {
    expect(parseCoins(undefined)).toBe(STARTING_COINS);
    expect(parseCoins(12)).toBe(12);
    expect(parseCoins(-5)).toBe(0);
    expect(parseCoins(3.7)).toBe(3);
    expect(parseCoins(NaN)).toBe(STARTING_COINS);
  });
});
