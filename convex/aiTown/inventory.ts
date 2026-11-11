// Item inventory. Milestone 2.
//
// Inventories live on players (not agents) so human players can hold, buy,
// sell, and steal items too. All functions are pure and mutate only the
// inventory object passed in. Money is handled separately in economy.ts.
//
// Keep this file free of server-only imports: the frontend bundles it.

import { Infer, v } from 'convex/values';

// Tracked item types (scope: 2-3, no crafting system). Linear chain:
// farmer -> wheat -> baker -> bread -> shopkeeper.
export const itemKind = v.union(v.literal('wheat'), v.literal('bread'));
export type ItemKind = Infer<typeof itemKind>;
export const ITEM_KINDS: readonly ItemKind[] = ['wheat', 'bread'];

export const ITEM_INFO: Record<ItemKind, { name: string; emoji: string }> = {
  wheat: { name: 'wheat', emoji: '🌾' },
  bread: { name: 'bread', emoji: '🍞' },
};

export function isItemKind(value: unknown): value is ItemKind {
  return typeof value === 'string' && (ITEM_KINDS as readonly string[]).includes(value);
}

/** Item kind -> quantity. Missing or zero means none; zero entries are removed. */
export const serializedInventory = v.record(v.string(), v.number());
export type Inventory = Partial<Record<ItemKind, number>>;

/** Upper bound per item so a runaway job can't grow the world document without limit. */
export const MAX_STACK = 999;

export function countItem(inv: Inventory | undefined, item: ItemKind): number {
  return inv?.[item] ?? 0;
}

function assertQuantity(quantity: number) {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error(`Invalid item quantity: ${quantity}`);
  }
}

/** Add items, capped at MAX_STACK. Returns how many were actually added. */
export function addItem(inv: Inventory, item: ItemKind, quantity: number): number {
  assertQuantity(quantity);
  const current = countItem(inv, item);
  const next = Math.min(current + quantity, MAX_STACK);
  inv[item] = next;
  return next - current;
}

/** Remove items if enough are held. Returns false (and changes nothing) otherwise. */
export function removeItem(inv: Inventory, item: ItemKind, quantity: number): boolean {
  assertQuantity(quantity);
  const current = countItem(inv, item);
  if (current < quantity) {
    return false;
  }
  if (current === quantity) {
    delete inv[item];
  } else {
    inv[item] = current - quantity;
  }
  return true;
}

/**
 * Move items between inventories. All-or-nothing: fails without changes if the
 * source lacks the items or the destination can't hold them all.
 */
export function transferItem(
  from: Inventory,
  to: Inventory,
  item: ItemKind,
  quantity: number,
): boolean {
  assertQuantity(quantity);
  if (countItem(from, item) < quantity || countItem(to, item) + quantity > MAX_STACK) {
    return false;
  }
  removeItem(from, item, quantity);
  addItem(to, item, quantity);
  return true;
}

/** Drop unknown keys and non-positive counts (e.g. from older saves or hand edits). */
export function parseInventory(raw: Record<string, number> | undefined): Inventory {
  const inv: Inventory = {};
  if (!raw) {
    return inv;
  }
  for (const [key, count] of Object.entries(raw)) {
    if (isItemKind(key) && Number.isInteger(count) && count > 0) {
      inv[key] = Math.min(count, MAX_STACK);
    }
  }
  return inv;
}

/** Human-readable summary, e.g. "🌾 3 wheat, 🍞 1 bread" or "nothing". */
export function describeInventory(inv: Inventory | undefined): string {
  const parts = ITEM_KINDS.filter((k) => countItem(inv, k) > 0).map(
    (k) => `${ITEM_INFO[k].emoji} ${countItem(inv, k)} ${ITEM_INFO[k].name}`,
  );
  return parts.length ? parts.join(', ') : 'nothing';
}
