import { describeRole, livelihoodPrompts, plainInventory } from './livelihood';
import { newJob } from './jobs';
import { GAME_DAY_LENGTH } from '../constants';
import { HUNGER_FULL_TIME } from './needs';

// A timestamp at 08:00 game time.
const DAY_START = 1000 * GAME_DAY_LENGTH;
const AT_8AM = DAY_START + (8 / 24) * GAME_DAY_LENGTH;

describe('plainInventory', () => {
  test('lists items without emoji', () => {
    expect(plainInventory(undefined)).toBeUndefined();
    expect(plainInventory({ wheat: 3 })).toBe('3 wheat');
    expect(plainInventory({ bread: 1, wheat: 3 })).toBe('3 wheat and 1 bread');
  });
});

describe('livelihoodPrompts', () => {
  test('working farmer with goods, money, and an appetite', () => {
    const lines = livelihoodPrompts(
      {
        name: 'Bob',
        coins: 40,
        inventory: { wheat: 5 },
        activity: { description: 'farming', until: AT_8AM + 10_000 },
      },
      { job: newJob('farmer'), needs: { lastAteAt: AT_8AM - HUNGER_FULL_TIME * 0.6 } },
      { name: 'Alice' },
      { job: newJob('baker') },
      AT_8AM,
    );
    expect(lines).toEqual([
      'It is 08:00 (morning) in the village.',
      'You work as the village farmer at the wheat field, 06:00–16:00.',
      'You are on your shift right now, farming.',
      'You have 40 coins and are carrying 5 wheat.',
      'You are hungry.',
      'Alice is the village baker at the bakery.',
    ]);
  });

  test('off-work shopkeeper on an evening shift, talking to a human', () => {
    const lines = livelihoodPrompts(
      { name: 'Lucky' },
      { job: newJob('shopkeeper', { start: 14, end: 22 }) },
      { name: 'Me' },
      null,
      AT_8AM,
    );
    expect(lines).toContain('You work as the village shopkeeper at the village shop, 14:00–22:00.');
    expect(lines).toContain('You are off work right now.');
    expect(lines).toContain('You have 50 coins.');
    expect(lines.some((l) => l.startsWith('Me is'))).toBe(false);
  });

  test('agent without a job', () => {
    const lines = livelihoodPrompts({ name: 'X' }, {}, { name: 'Y' }, null, AT_8AM);
    expect(lines).toContain(`You don't have a job.`);
  });

  test('describeRole', () => {
    expect(describeRole('Stella', { job: newJob('shopkeeper') })).toBe(
      'Stella is the village shopkeeper at the village shop.',
    );
    expect(describeRole('Me', null)).toBeUndefined();
  });
});
