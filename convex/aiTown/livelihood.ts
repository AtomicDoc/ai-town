// Live context about an agent's working life, added to conversation prompts so
// the LLM knows what the character does and what they're up to right now:
// time of day, job and shift, whether they're working, what they carry, how
// much money they have, and how hungry they are. Kept short: every line is
// resent with every conversation turn (prompt tokens dominate LLM cost).
//
// Pure; keep it free of server-only imports.

import { dayPhase, formatGameTime, gameHour } from './clock';
import { JOB_DEFINITIONS, SerializedJob, describeShift, isOnShift } from './jobs';
import { ITEM_INFO, ITEM_KINDS, countItem, parseInventory } from './inventory';
import { parseCoins } from './economy';
import { SerializedNeeds, describeHunger, hungerLevel } from './needs';

type AgentState = { job?: SerializedJob; needs?: SerializedNeeds };
type PlayerState = {
  name: string;
  inventory?: Record<string, number>;
  coins?: number;
  activity?: { description: string; until: number };
};

/** "3 wheat and 1 bread" (no emoji: this goes to the LLM). */
export function plainInventory(raw: Record<string, number> | undefined): string | undefined {
  const inv = parseInventory(raw);
  const parts = ITEM_KINDS.filter((k) => countItem(inv, k) > 0).map(
    (k) => `${countItem(inv, k)} ${ITEM_INFO[k].name}`,
  );
  if (parts.length === 0) {
    return undefined;
  }
  return parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** One-line role description for anyone, e.g. "Bob is the village farmer at the wheat field." */
export function describeRole(name: string, agent: AgentState | null): string | undefined {
  if (!agent?.job) {
    return undefined;
  }
  const def = JOB_DEFINITIONS[agent.job.kind];
  return `${name} is the village ${def.title} at ${def.place}.`;
}

export function livelihoodPrompts(
  player: PlayerState,
  agent: AgentState | null,
  otherPlayer: { name: string },
  otherAgent: AgentState | null,
  now: number,
): string[] {
  const hour = gameHour(now);
  const lines = [`It is ${formatGameTime(hour)} (${dayPhase(hour).toLowerCase()}) in the village.`];

  if (agent?.job) {
    const def = JOB_DEFINITIONS[agent.job.kind];
    lines.push(
      `You work as the village ${def.title} at ${def.place}, ${describeShift(agent.job)}.`,
    );
    if (isOnShift(agent.job, hour)) {
      const doing =
        player.activity && player.activity.until > now ? `, ${player.activity.description}` : '';
      lines.push(`You are on your shift right now${doing}.`);
    } else {
      lines.push(`You are off work right now.`);
    }
  } else if (agent) {
    lines.push(`You don't have a job.`);
  }

  const carrying = plainInventory(player.inventory);
  lines.push(
    `You have ${parseCoins(player.coins)} coins${carrying ? ` and are carrying ${carrying}` : ''}.`,
  );

  const hunger = describeHunger(hungerLevel(agent?.needs?.lastAteAt, now));
  if (hunger) {
    lines.push(`You are ${hunger}.`);
  }

  const otherRole = describeRole(otherPlayer.name, otherAgent);
  if (otherRole) {
    lines.push(otherRole);
  }
  return lines;
}
