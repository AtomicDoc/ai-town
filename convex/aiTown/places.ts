// Named places on the default "gentle" map (64x48). Every target was checked
// to be an open tile reachable from the rest of the map.
//
// Leaf module (no imports) so jobs.ts and idle.ts can both use it without an
// import cycle.

export type Place = { name: string; target: { x: number; y: number } };

// Workplaces (see JOB_DEFINITIONS in jobs.ts).
export const WHEAT_FIELD: Place = { name: 'the wheat field', target: { x: 56, y: 40 } };
export const BAKERY: Place = { name: 'the bakery', target: { x: 30, y: 20 } };
export const SHOP: Place = { name: 'the village shop', target: { x: 42, y: 30 } };

// Places with nothing to do but be there (free time, config C).
export const LANDMARKS: readonly Place[] = [
  { name: 'the village square', target: { x: 35, y: 25 } },
  { name: 'the north meadow', target: { x: 45, y: 5 } },
  { name: 'the west grove', target: { x: 8, y: 15 } },
  { name: 'the south path', target: { x: 30, y: 44 } },
  { name: 'the east lookout', target: { x: 62, y: 2 } },
];

export const PLACES: readonly Place[] = [...LANDMARKS, WHEAT_FIELD, BAKERY, SHOP];
