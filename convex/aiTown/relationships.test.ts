import {
  Belief,
  MAX_BELIEFS,
  OPINION_DELTAS,
  Social,
  addBelief,
  adjustOpinion,
  describeBelief,
  getOpinion,
  gossipFromLine,
  mentionsTheft,
  opinionPhrase,
  shareBeliefs,
  socialPrompts,
} from './relationships';
import { mostHeldItem, performPlayerAction } from './actions';
import { newJob } from './jobs';
import type { Game } from './game';

const theft = (overrides: Partial<Belief> = {}): Belief => ({
  kind: 'theft',
  thief: 'p:1' as Belief['thief'],
  victim: 'p:2' as Belief['victim'],
  item: 'bread',
  quantity: 1,
  at: 1000,
  source: 'witnessed',
  ...overrides,
});
const names: Record<string, string> = {
  'p:1': 'Traveler',
  'p:2': 'Alice',
  'p:3': 'Lucky',
  'p:4': 'Bob',
};
const nameOf = (id: string) => names[id] ?? id;

describe('opinions', () => {
  test('adjust, clamp, and read back', () => {
    const s: Social = {};
    expect(getOpinion(s, 'p:1')).toBe(0);
    expect(adjustOpinion(s, 'p:1', 30)).toBe(30);
    expect(adjustOpinion(s, 'p:1', 500)).toBe(100);
    expect(adjustOpinion(s, 'p:1', -500)).toBe(-100);
    expect(getOpinion(s, 'p:1')).toBe(-100);
  });

  test('phrases', () => {
    expect(opinionPhrase('Bob', 0)).toBeUndefined();
    expect(opinionPhrase('Bob', 20)).toBe('You like Bob.');
    expect(opinionPhrase('Bob', 50)).toBe('You like Bob a lot.');
    expect(opinionPhrase('Bob', -20)).toBe('You distrust Bob.');
    expect(opinionPhrase('Bob', -60)).toBe('You strongly distrust Bob.');
  });
});

describe('beliefs', () => {
  test('dedupes the same event and keeps the newest', () => {
    const s: Social = {};
    expect(addBelief(s, theft())).toBe(true);
    expect(addBelief(s, theft({ source: 'told' }))).toBe(false);
    for (let i = 0; i < MAX_BELIEFS + 3; i++) {
      addBelief(s, theft({ at: 2000 + i }));
    }
    expect(s.beliefs).toHaveLength(MAX_BELIEFS);
    expect(s.beliefs![MAX_BELIEFS - 1].at).toBe(2000 + MAX_BELIEFS + 2);
  });

  test('sharing creates second-hand beliefs and lowers the listener opinion of the thief', () => {
    const lucky: Social = { beliefs: [theft()] };
    const bob: Social = {};
    const learned = shareBeliefs(lucky, 'p:3', bob, 'p:4');
    expect(learned).toHaveLength(1);
    expect(bob.beliefs![0]).toMatchObject({ source: 'told', toldBy: 'p:3', thief: 'p:1' });
    expect(getOpinion(bob, 'p:1')).toBe(OPINION_DELTAS.heardAboutTheft);
    // Telling again changes nothing.
    expect(shareBeliefs(lucky, 'p:3', bob, 'p:4')).toHaveLength(0);
    expect(getOpinion(bob, 'p:1')).toBe(OPINION_DELTAS.heardAboutTheft);
  });

  test('the thief is not told about their own theft', () => {
    const lucky: Social = { beliefs: [theft()] };
    const thief: Social = {};
    expect(shareBeliefs(lucky, 'p:3', thief, 'p:1')).toHaveLength(0);
  });

  test('describeBelief', () => {
    expect(describeBelief(theft(), 'p:3', nameOf)).toBe(
      'You saw Traveler steal 1 bread from Alice.',
    );
    expect(
      describeBelief(theft({ source: 'told', toldBy: 'p:3' as Belief['thief'] }), 'p:4', nameOf),
    ).toBe('Lucky told you that Traveler stole 1 bread from Alice.');
    // Victims know who robbed them whether or not they saw it.
    expect(describeBelief(theft(), 'p:2', nameOf)).toBe('Traveler stole 1 bread from you.');
  });

  test('socialPrompts: confront the thief, gossip to others', () => {
    const lucky: Social = {
      beliefs: [theft()],
      opinions: [{ playerId: 'p:1' as Belief['thief'], score: -20 }],
    };
    expect(socialPrompts(lucky, 'p:3', 'p:1', 'Traveler', nameOf)).toEqual([
      'You distrust Traveler.',
      'You saw Traveler steal 1 bread from Alice.',
    ]);
    expect(socialPrompts(lucky, 'p:3', 'p:4', 'Bob', nameOf)).toEqual([
      'News you know: You saw Traveler steal 1 bread from Alice. You may bring it up if it fits the conversation.',
    ]);
  });
});

describe('player actions (fake world)', () => {
  type P = {
    id: string;
    human?: string;
    position: { x: number; y: number };
    inventory: Record<string, number>;
    coins: number;
    activity?: { description: string; emoji?: string; until: number };
    lastInput: number;
  };
  function world() {
    const players = new Map<string, P>([
      [
        'p:1',
        {
          id: 'p:1',
          human: 'me',
          position: { x: 10, y: 10 },
          inventory: {},
          coins: 50,
          lastInput: 0,
        },
      ],
      [
        'p:2',
        {
          id: 'p:2',
          position: { x: 11, y: 10 },
          inventory: { bread: 3, wheat: 4 },
          coins: 0,
          lastInput: 0,
        },
      ],
      ['p:3', { id: 'p:3', position: { x: 13, y: 12 }, inventory: {}, coins: 50, lastInput: 0 }],
      ['p:4', { id: 'p:4', position: { x: 50, y: 40 }, inventory: {}, coins: 50, lastInput: 0 }],
    ]);
    const agents = new Map<string, Social & { playerId: string; job?: ReturnType<typeof newJob> }>([
      ['a:2', { playerId: 'p:2', job: { ...newJob('baker'), workplace: { x: 30, y: 20 } } }],
      ['a:3', { playerId: 'p:3', job: { ...newJob('shopkeeper'), workplace: { x: 42, y: 30 } } }],
      ['a:4', { playerId: 'p:4', job: { ...newJob('farmer'), workplace: { x: 56, y: 40 } } }],
    ]);
    const playerDescriptions = new Map(Object.entries(names).map(([id, name]) => [id, { name }]));
    const game = { world: { players, agents }, playerDescriptions } as unknown as Game;
    return { game, players, agents };
  }

  test('witness -> tells another -> second-hand belief', () => {
    const { game, players, agents } = world();
    const me = players.get('p:1')!;
    const alice = players.get('p:2')!;
    const message = performPlayerAction(game, 5000, me as any, alice as any, 'steal');
    expect(message).toBe(
      'You stole 1 wheat from Alice. Alice will know it was you. Seen by: Lucky.',
    );
    expect(me.inventory).toEqual({ wheat: 1 });

    const lucky = agents.get('a:3')!;
    const bob = agents.get('a:4')!;
    expect(lucky.beliefs![0]).toMatchObject({ source: 'witnessed', thief: 'p:1', victim: 'p:2' });
    expect(getOpinion(lucky, 'p:1')).toBe(OPINION_DELTAS.witnessedTheft);
    expect(getOpinion(agents.get('a:2')!, 'p:1')).toBe(OPINION_DELTAS.stolenFrom);
    expect(bob.beliefs).toBeUndefined(); // too far away to see

    // Small talk that doesn't mention the theft passes nothing on.
    expect(gossipFromLine(game, 'p:3', 'p:4', 'Lovely weather for the harvest, Bob.')).toEqual([]);
    expect(gossipFromLine(game, 'p:3', 'p:4', 'Traveler went for a walk.')).toEqual([]);
    expect(bob.beliefs).toBeUndefined();

    // Lucky actually tells Bob (what agentFinishSendingMessage does per line).
    const learned = gossipFromLine(
      game,
      'p:3',
      'p:4',
      'Did you hear? That Traveler stole wheat right from under Alice’s nose!',
    );
    expect(learned).toHaveLength(1);
    expect(describeBelief(bob.beliefs![0], 'p:4', nameOf)).toBe(
      'Lucky told you that Traveler stole 1 wheat from Alice.',
    );
    expect(getOpinion(bob, 'p:1')).toBe(OPINION_DELTAS.heardAboutTheft);
  });

  test('the victim knows even when robbed at an unattended stall', () => {
    const { game, players, agents } = world();
    const me = players.get('p:1')!;
    const alice = players.get('p:2')!;
    alice.position = { x: 60, y: 45 }; // far away
    me.position = { x: 30, y: 21 }; // at Alice's bakery
    const message = performPlayerAction(game, 7000, me as any, alice as any, 'steal');
    expect(message).toBe(
      'You stole 1 wheat from Alice. Alice will know it was you. No one else saw you.',
    );
    const aliceAgent = agents.get('a:2')!;
    expect(describeBelief(aliceAgent.beliefs![0], 'p:2', nameOf)).toBe(
      'Traveler stole 1 wheat from you.',
    );
    expect(getOpinion(aliceAgent, 'p:1')).toBe(OPINION_DELTAS.stolenFrom);
  });

  test('buy needs stock and coins; too far away is refused', () => {
    const { game, players } = world();
    const me = players.get('p:1')!;
    const alice = players.get('p:2')!;
    expect(performPlayerAction(game, 1, me as any, alice as any, 'buy')).toContain(
      'bought 1 bread',
    );
    expect(me.coins).toBe(43);
    expect(alice.coins).toBe(7);
    const bob = players.get('p:4')!;
    expect(() => performPlayerAction(game, 1, me as any, bob as any, 'buy')).toThrow('Get closer');
  });

  test('sell only what the target buys', () => {
    const { game, players } = world();
    const me = players.get('p:1')!;
    me.inventory = { wheat: 2 };
    const alice = players.get('p:2')!;
    alice.coins = 10;
    expect(performPlayerAction(game, 1, me as any, alice as any, 'sell')).toBe(
      'You sold 1 wheat to Alice for 2 coins.',
    );
  });

  test('help finishes a task, interfere spoils it, both change opinions', () => {
    const { game, players, agents } = world();
    const me = players.get('p:1')!;
    const alice = players.get('p:2')!;
    const job = agents.get('a:2')!.job!;
    job.taskEndsAt = 9000;
    alice.activity = { description: 'baking', until: 9000 };
    performPlayerAction(game, 100, me as any, alice as any, 'help');
    expect(job.taskEndsAt).toBe(100);
    expect(alice.activity.until).toBe(100);
    expect(getOpinion(agents.get('a:2')!, 'p:1')).toBe(OPINION_DELTAS.helped);
    expect((agents.get('a:2') as any).pendingEvents).toEqual([
      expect.objectContaining({ kind: 'helped', subject: 'p:1' }),
    ]);

    job.taskEndsAt = 9000;
    alice.activity = { description: 'baking', until: 9000 };
    performPlayerAction(game, 200, me as any, alice as any, 'interfere');
    expect(alice.activity.until).toBe(200);
    expect(job.taskEndsAt).toBe(9000); // job sees the mismatch and abandons the task
    expect((agents.get('a:2') as any).pendingEvents).toContainEqual(
      expect.objectContaining({ kind: 'interfered', subject: 'p:1' }),
    );
    // Alice's spoiled task is no longer intact, so there's nothing to help with.
    expect(() => performPlayerAction(game, 300, me as any, alice as any, 'help')).toThrow(
      "isn't in the middle",
    );
    // Lucky is 3.6 tiles away: too far for help/interfere.
    expect(() =>
      performPlayerAction(game, 300, me as any, players.get('p:3') as any, 'help'),
    ).toThrow('Get closer to Lucky first.');
  });
});

describe('mentionsTheft', () => {
  const says = (text: string) => mentionsTheft(text, 'Traveler', 'Alice', 'bread');

  test('thief name plus a theft word', () => {
    expect(says('I saw the traveler steal from the bakery.')).toBe(true);
    expect(says('Traveler is a thief, mark my words.')).toBe(true);
    expect(says('Alice got robbed by Traveler this morning.')).toBe(true);
  });

  test('weak verbs need the victim or the item named too', () => {
    expect(says('Traveler took a walk by the river.')).toBe(false);
    expect(says('Traveler took bread without paying!')).toBe(true);
    expect(says('Traveler snatched something from Alice.')).toBe(true);
  });

  test('no thief name, or only small talk: no', () => {
    expect(says('Someone stole bread from Alice.')).toBe(false);
    expect(says('Traveler and Alice were at the market.')).toBe(false);
  });

  test('very short names never match', () => {
    expect(mentionsTheft('Me? I stole nothing!', 'Me', 'Alice', 'bread')).toBe(false);
  });
});

test('mostHeldItem', () => {
  expect(mostHeldItem({})).toBeUndefined();
  expect(mostHeldItem({ bread: 1, wheat: 3 })).toBe('wheat');
});
