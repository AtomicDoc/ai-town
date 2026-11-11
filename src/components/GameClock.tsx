import { dayPhase, formatGameTime, gameHour } from '../../convex/aiTown/clock';

const PHASE_ICON = {
  Night: '🌙',
  Morning: '🌅',
  Afternoon: '☀️',
  Evening: '🌇',
} as const;

/**
 * In-game clock overlay. Uses the engine's historical time when available so it
 * matches what the simulation is showing, falling back to wall-clock time.
 */
export default function GameClock({ time }: { time?: number }) {
  const hour = gameHour(time ?? Date.now());
  const phase = dayPhase(hour);
  return (
    <div
      className="pointer-events-none absolute top-3 left-3 z-10 rounded bg-brown-800/80 px-3 py-1 text-brown-100 shadow"
      title="Game time (one game day = 20 real minutes)"
    >
      <span className="mr-2">{PHASE_ICON[phase]}</span>
      <span className="font-mono text-lg tabular-nums">{formatGameTime(hour)}</span>
      <span className="ml-2 text-sm opacity-80">{phase}</span>
    </div>
  );
}
