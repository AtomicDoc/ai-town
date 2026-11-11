// World clock shared by traditional (non-LLM) subsystems: jobs, needs, schedules.
//
// Game time is derived from wall-clock time so it survives engine restarts and
// is identical for every agent in a step. Keep this file free of server-only
// imports: the frontend bundles anything reachable from convex/aiTown/world.ts.

import { GAME_DAY_LENGTH } from '../constants';

/** Hour of the in-game day in [0, 24), fractional. */
export function gameHour(now: number, dayLength: number = GAME_DAY_LENGTH): number {
  const fraction = (now % dayLength) / dayLength;
  return fraction * 24;
}

/** "HH:MM" for a fractional game hour, e.g. 7.5 -> "07:30". */
export function formatGameTime(hour: number): string {
  const totalMinutes = Math.floor(hour * 60) % (24 * 60);
  const hh = Math.floor(totalMinutes / 60);
  const mm = totalMinutes % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export type DayPhase = 'Night' | 'Morning' | 'Afternoon' | 'Evening';

/** Coarse label for the UI and for prompts (e.g. "It is morning"). */
export function dayPhase(hour: number): DayPhase {
  if (hour >= 5 && hour < 12) return 'Morning';
  if (hour >= 12 && hour < 17) return 'Afternoon';
  if (hour >= 17 && hour < 21) return 'Evening';
  return 'Night';
}

/**
 * True if `hour` falls inside [start, end). Handles windows that wrap past
 * midnight (e.g. start 22, end 6). start === end means "all day".
 */
export function inHourWindow(hour: number, start: number, end: number): boolean {
  if (start === end) {
    return true;
  }
  if (start < end) {
    return hour >= start && hour < end;
  }
  return hour >= start || hour < end;
}
