// Money and trade. Milestone 2.
//
// Fixed prices, coins held by players, and all-or-nothing trades between two
// wallets (coins + inventory). Pure functions; the engine decides when trades
// happen (jobs.ts deliveries now, player buy/sell/steal later).
//
// Keep this file free of server-only imports: the frontend bundles it.

import { Inventory, ItemKind, MAX_STACK, countItem, transferItem } from './inventory';

/** Coins every player starts with (also used for players saved before coins existed). */
export const STARTING_COINS = 50;

/**
 * Fixed unit prices. Bread is priced above the 2 wheat it takes to bake, so the
 * baker earns a margin and the chain farmer -> baker -> shopkeeper pays everyone.
 */
export const PRICES: Record<ItemKind, number> = {
  wheat: 2,
  bread: 6,
};

export type Wallet = { coins: number; inventory: Inventory };

function assertQuantity(quantity: number) {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error(`Invalid trade quantity: ${quantity}`);
  }
}

/** Largest quantity of `item` the seller can sell to the buyer right now. */
export function maxTradeQuantity(
  seller: Wallet,
  buyer: Wallet,
  item: ItemKind,
  unitPrice: number = PRICES[item],
): number {
  const held = countItem(seller.inventory, item);
  const affordable = unitPrice > 0 ? Math.floor(buyer.coins / unitPrice) : held;
  const room = MAX_STACK - countItem(buyer.inventory, item);
  return Math.max(0, Math.min(held, affordable, room));
}

/**
 * Seller gives `quantity` of `item` to buyer for quantity * unitPrice coins.
 * All-or-nothing: returns false and changes nothing if the seller lacks the
 * items, the buyer lacks the coins, or the buyer can't hold them.
 */
export function trade(
  seller: Wallet,
  buyer: Wallet,
  item: ItemKind,
  quantity: number,
  unitPrice: number = PRICES[item],
): boolean {
  assertQuantity(quantity);
  if (seller === buyer) {
    return false;
  }
  if (maxTradeQuantity(seller, buyer, item, unitPrice) < quantity) {
    return false;
  }
  const total = quantity * unitPrice;
  if (!transferItem(seller.inventory, buyer.inventory, item, quantity)) {
    return false;
  }
  buyer.coins -= total;
  seller.coins += total;
  return true;
}

/** Sell as many as possible, up to `maxQuantity`. Returns the quantity sold. */
export function sellUpTo(
  seller: Wallet,
  buyer: Wallet,
  item: ItemKind,
  maxQuantity: number,
  unitPrice: number = PRICES[item],
): number {
  const quantity = Math.min(maxQuantity, maxTradeQuantity(seller, buyer, item, unitPrice));
  if (quantity <= 0) {
    return 0;
  }
  return trade(seller, buyer, item, quantity, unitPrice) ? quantity : 0;
}

/** Normalize a stored coin balance (missing for older saves, never negative). */
export function parseCoins(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) {
    return STARTING_COINS;
  }
  return Math.max(0, Math.floor(raw));
}
