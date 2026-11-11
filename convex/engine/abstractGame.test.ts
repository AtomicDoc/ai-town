import { nextInputNumber } from './abstractGame';

describe('nextInputNumber', () => {
  test('first input on a fresh engine is 0', () => {
    expect(nextInputNumber(undefined, undefined)).toBe(0);
  });

  test('normally follows the latest stored input', () => {
    expect(nextInputNumber(41, 40)).toBe(42);
    expect(nextInputNumber(41, 41)).toBe(42);
  });

  test('after the vacuum cron deletes all inputs, numbering continues past the engine', () => {
    // Observed on Molly: inputs vacuumed, engine at processedInputNumber 993,
    // new inputs restarted at 0 and were never loaded.
    expect(nextInputNumber(undefined, 993)).toBe(994);
  });

  test('skips past inputs stranded below processedInputNumber', () => {
    expect(nextInputNumber(32, 993)).toBe(994);
  });
});
