import {
  DEFAULT_IDLE_EMOJI,
  MAX_RECENT_ACTIONS,
  PLACES,
  RecentAction,
  idlePrompt,
  nearestPlace,
  parseIdlePlan,
  recentActionsPrompt,
  recordAction,
} from './idle';
import { GAME_DAY_LENGTH } from '../constants';

const square = PLACES.find((p) => p.name === 'the village square')!;
const grove = PLACES.find((p) => p.name === 'the west grove')!;

describe('places', () => {
  test('include the workplaces once each', () => {
    const names = PLACES.map((p) => p.name);
    expect(names).toContain('the wheat field');
    expect(names).toContain('the bakery');
    expect(names).toContain('the village shop');
    expect(new Set(names).size).toBe(names.length);
  });

  test('nearestPlace', () => {
    expect(nearestPlace({ x: 9, y: 14 }).name).toBe('the west grove');
  });
});

describe('parseIdlePlan', () => {
  test('well-formed reply', () => {
    expect(parseIdlePlan('the west grove | reading a book under a tree | 📖', square)).toEqual({
      place: grove,
      description: 'reading a book under a tree',
      emoji: '📖',
    });
  });

  test('tolerates chatter, casing, quotes, and a missing "the"', () => {
    const plan = parseIdlePlan(
      'Here is my plan:\nWest Grove | "Kicking rocks along the path." | 🪨',
      square,
    );
    expect(plan).toEqual({
      place: grove,
      description: 'kicking rocks along the path',
      emoji: '🪨',
    });
  });

  test('unknown place falls back; missing emoji gets the default', () => {
    expect(parseIdlePlan('the moon | stargazing |', square)).toEqual({
      place: square,
      description: 'stargazing',
      emoji: DEFAULT_IDLE_EMOJI,
    });
  });

  test('no usable activity: undefined (caller uses a stock activity)', () => {
    expect(parseIdlePlan('I am not sure.', square)).toBeUndefined();
    expect(parseIdlePlan('the bakery | | 🍞', square)).toBeUndefined();
  });

  test('long activities are trimmed', () => {
    const plan = parseIdlePlan(`the bakery | ${'smelling bread '.repeat(10)} | 🍞`, square)!;
    expect(plan.description.length).toBeLessThanOrEqual(48);
  });
});

describe('recent actions', () => {
  test('keeps the last few and phrases them for prompts with game times', () => {
    const agent: { recentActions?: RecentAction[] } = {};
    const at = (hour: number) => 1000 * GAME_DAY_LENGTH + (hour / 24) * GAME_DAY_LENGTH;
    recordAction(agent, at(8), 'reading a book', 'the west grove');
    recordAction(agent, at(9.5), 'confronted Traveler');
    recordAction(agent, at(11), 'kicking rocks', 'the village square');
    expect(recentActionsPrompt(agent)).toBe(
      'Recently you: reading a book at the west grove (08:00); confronted Traveler (09:30); kicking rocks at the village square (11:00).',
    );
    for (let i = 0; i < 10; i++) recordAction(agent, at(12), `thing ${i}`);
    expect(agent.recentActions).toHaveLength(MAX_RECENT_ACTIONS);
    expect(recentActionsPrompt({})).toBeUndefined();
  });
});

test('idlePrompt lists the places and the reply format', () => {
  const [system] = idlePrompt({ name: 'Lucky', identity: 'Lucky runs the shop.', context: [] });
  expect(system.content).toContain('the west grove');
  expect(system.content).toContain('place | what you do');
});
