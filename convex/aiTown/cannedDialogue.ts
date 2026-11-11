// Scripted dialogue for the "traditional" policy (config A): no LLM at all.
//
// Lines are picked from templates filled with the speaker's live state: time
// of day, job and current activity, hunger, money, recent actions, opinion of
// the listener, and theft beliefs. Gossip lines name the thief and use "stole",
// so relationships.gossipFromLine still spreads beliefs in config A.
//
// Pure. Keep free of server-only imports.

import { dayPhase, gameHour } from './clock';
import { JOB_DEFINITIONS, SerializedJob, isOnShift } from './jobs';
import { PRICES, parseCoins } from './economy';
import { SerializedNeeds, EAT_AT, hungerLevel } from './needs';
import { Belief, Opinion, getOpinion } from './relationships';
import { RecentAction } from './idle';

export type CannedSpeakerState = {
  job?: SerializedJob;
  needs?: SerializedNeeds;
  recentActions?: RecentAction[];
  opinions?: Opinion[];
  beliefs?: Belief[];
};

export type CannedLineArgs = {
  type: 'start' | 'continue' | 'leave';
  speakerId: string;
  speakerName: string;
  speaker: CannedSpeakerState;
  speakerPlayer: { coins?: number; activity?: { description: string; until: number } };
  listenerId: string;
  listenerName: string;
  listener: CannedSpeakerState | null;
  nameOf: (id: string) => string;
  now: number;
  /** Lines the speaker already said in this conversation (not repeated). */
  alreadySaid: string[];
};

const HOSTILE = -15;
const FRIENDLY = 15;

function greeting(now: number): string {
  switch (dayPhase(gameHour(now))) {
    case 'Morning':
      return 'Good morning';
    case 'Afternoon':
      return 'Good afternoon';
    case 'Evening':
      return 'Good evening';
    case 'Night':
      return 'Evening';
  }
}

/** What the speaker believes about the listener as a thief, phrased to their face. */
function accusation(a: CannedLineArgs): string | undefined {
  const b = (a.speaker.beliefs ?? []).find((b) => b.thief === a.listenerId);
  if (!b) return undefined;
  if (b.victim === a.speakerId) {
    return `You stole ${b.item} from me, ${a.listenerName}! I know it was you.`;
  }
  if (b.source === 'witnessed') {
    return `I saw you steal ${b.item} from ${a.nameOf(b.victim)}, ${a.listenerName}. I won't forget it.`;
  }
  return `${b.toldBy ? a.nameOf(b.toldBy) : 'Someone'} told me you stole ${b.item} from ${a.nameOf(
    b.victim,
  )}, ${a.listenerName}.`;
}

/** Newest theft news that doesn't involve the listener as the thief. */
function gossip(a: CannedLineArgs): string | undefined {
  const news = (a.speaker.beliefs ?? []).filter((b) => b.thief !== a.listenerId);
  const b = news[news.length - 1];
  if (!b) return undefined;
  if (b.victim === a.speakerId) {
    return `Did you hear? ${a.nameOf(b.thief)} stole ${b.item} from me, can you believe it?`;
  }
  return `Did you hear? ${a.nameOf(b.thief)} stole ${b.item} from ${a.nameOf(b.victim)}.`;
}

function jobLine(a: CannedLineArgs): string | undefined {
  const job = a.speaker.job;
  if (!job) return undefined;
  const def = JOB_DEFINITIONS[job.kind];
  if (!isOnShift(job, gameHour(a.now))) {
    return `I'm done at ${def.place} for now.`;
  }
  const doing = a.speakerPlayer.activity?.description;
  switch (job.kind) {
    case 'farmer':
    case 'farmhand':
      return `The wheat's coming in well today.`;
    case 'baker':
      return doing === 'waiting for wheat'
        ? `I'm still waiting on wheat for the oven.`
        : `I've got loaves to bake before noon.`;
    case 'shopkeeper':
      return `Bread's ${PRICES.bread} coins a loaf at the shop, if you need some.`;
  }
}

function hungerLine(a: CannedLineArgs): string | undefined {
  const hunger = hungerLevel(a.speaker.needs?.lastAteAt, a.now);
  if (hunger >= 80) return `I'm starving.`;
  if (hunger >= EAT_AT) return `I'm getting really hungry.`;
  return undefined;
}

function moneyLine(a: CannedLineArgs): string | undefined {
  return parseCoins(a.speakerPlayer.coins) < PRICES.bread
    ? `Money's tight for me right now.`
    : undefined;
}

function recentLine(a: CannedLineArgs): string | undefined {
  const r = (a.speaker.recentActions ?? []).at(-1);
  if (!r) return undefined;
  return `Earlier I was ${r.description}${r.place ? ` at ${r.place}` : ''}.`;
}

function askAboutWork(a: CannedLineArgs): string | undefined {
  const job = a.listener?.job;
  return job ? `How are things at ${JOB_DEFINITIONS[job.kind].place}?` : undefined;
}

const FILLERS = [
  'Nice weather today.',
  'Anything new with you?',
  'Quiet day in the village.',
  'I should get back to it soon.',
];

function firstUnsaid(
  candidates: (string | undefined)[],
  alreadySaid: string[],
): string | undefined {
  return candidates.find((c): c is string => !!c && !alreadySaid.includes(c));
}

/** One line of scripted dialogue. Never repeats a line the speaker already said. */
export function cannedLine(a: CannedLineArgs): string {
  const opinion = getOpinion(a.speaker, a.listenerId);
  if (a.type === 'start') {
    const greet = greeting(a.now);
    return (
      firstUnsaid(
        [
          accusation(a),
          opinion <= HOSTILE ? `Oh. It's you, ${a.listenerName}.` : undefined,
          opinion >= FRIENDLY ? `${greet}, ${a.listenerName}! Good to see you.` : undefined,
          `${greet}, ${a.listenerName}.`,
        ],
        a.alreadySaid,
      ) ?? `Hello, ${a.listenerName}.`
    );
  }
  if (a.type === 'leave') {
    return opinion <= HOSTILE || accusation(a)
      ? `Just stay away from me, ${a.listenerName}.`
      : `I'd better get going. See you around, ${a.listenerName}.`;
  }
  const topics = [
    accusation(a),
    gossip(a),
    jobLine(a),
    hungerLine(a),
    moneyLine(a),
    recentLine(a),
    askAboutWork(a),
    ...FILLERS,
  ];
  return firstUnsaid(topics, a.alreadySaid) ?? `Hm.`;
}
