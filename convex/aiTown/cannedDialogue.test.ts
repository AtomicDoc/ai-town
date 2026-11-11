import { CannedLineArgs, cannedLine } from './cannedDialogue';
import { newJob } from './jobs';
import { mentionsTheft, Belief } from './relationships';
import { GAME_DAY_LENGTH } from '../constants';
import { HUNGER_FULL_TIME } from './needs';

const names: Record<string, string> = {
  'p:1': 'Traveler',
  'p:2': 'Alice',
  'p:3': 'Lucky',
  'p:4': 'Bob',
};
// 08:00 game time
const AT_8AM = 1000 * GAME_DAY_LENGTH + (8 / 24) * GAME_DAY_LENGTH;

function args(overrides: Partial<CannedLineArgs> = {}): CannedLineArgs {
  return {
    type: 'continue',
    speakerId: 'p:3',
    speakerName: 'Lucky',
    speaker: { needs: { lastAteAt: AT_8AM } },
    speakerPlayer: { coins: 50 },
    listenerId: 'p:4',
    listenerName: 'Bob',
    listener: { job: newJob('farmer') },
    nameOf: (id) => names[id] ?? 'someone',
    now: AT_8AM,
    alreadySaid: [],
    ...overrides,
  };
}

const theft: Belief = {
  kind: 'theft',
  thief: 'p:1' as Belief['thief'],
  victim: 'p:2' as Belief['victim'],
  item: 'bread',
  quantity: 1,
  at: 1,
  source: 'witnessed',
};

describe('cannedLine: start', () => {
  test('greets by time of day', () => {
    expect(cannedLine(args({ type: 'start' }))).toBe('Good morning, Bob.');
  });

  test('friendly and hostile openings follow the opinion', () => {
    expect(
      cannedLine(
        args({ type: 'start', speaker: { opinions: [{ playerId: 'p:4' as any, score: 30 }] } }),
      ),
    ).toBe('Good morning, Bob! Good to see you.');
    expect(
      cannedLine(
        args({ type: 'start', speaker: { opinions: [{ playerId: 'p:4' as any, score: -30 }] } }),
      ),
    ).toBe(`Oh. It's you, Bob.`);
  });

  test('confronts a known thief', () => {
    const line = cannedLine(
      args({
        type: 'start',
        listenerId: 'p:1',
        listenerName: 'Traveler',
        speaker: { beliefs: [theft] },
      }),
    );
    expect(line).toBe(`I saw you steal bread from Alice, Traveler. I won't forget it.`);
  });

  test('a victim accuses directly', () => {
    const line = cannedLine(
      args({
        type: 'start',
        speakerId: 'p:2',
        speakerName: 'Alice',
        listenerId: 'p:1',
        listenerName: 'Traveler',
        speaker: { beliefs: [theft] },
      }),
    );
    expect(line).toBe('You stole bread from me, Traveler! I know it was you.');
  });
});

describe('cannedLine: continue', () => {
  test('gossip comes first, and spreads via the mention check', () => {
    const line = cannedLine(args({ speaker: { beliefs: [theft] } }));
    expect(line).toBe('Did you hear? Traveler stole bread from Alice.');
    expect(mentionsTheft(line, 'Traveler', 'Alice', 'bread')).toBe(true);
  });

  test('moves through topics without repeating itself', () => {
    const speaker = {
      job: newJob('shopkeeper'),
      needs: { lastAteAt: AT_8AM - HUNGER_FULL_TIME * 0.6 },
      recentActions: [{ at: 1, description: 'reading a book', place: 'the west grove' }],
    };
    const said: string[] = [];
    for (let i = 0; i < 4; i++) {
      said.push(cannedLine(args({ speaker, speakerPlayer: { coins: 2 }, alreadySaid: [...said] })));
    }
    expect(said).toEqual([
      "Bread's 7 coins a loaf at the shop, if you need some.",
      `I'm getting really hungry.`,
      `Money's tight for me right now.`,
      'Earlier I was reading a book at the west grove.',
    ]);
    expect(cannedLine(args({ speaker: {}, alreadySaid: [] }))).toBe(
      'How are things at the wheat field?',
    );
  });

  test('off-shift workers say so', () => {
    const atNight = 1000 * GAME_DAY_LENGTH + (23 / 24) * GAME_DAY_LENGTH;
    expect(cannedLine(args({ now: atNight, speaker: { job: newJob('baker') } }))).toBe(
      `I'm done at the bakery for now.`,
    );
  });

  test('falls back to small talk, then runs out gracefully', () => {
    expect(cannedLine(args({ speaker: {}, listener: null }))).toBe('Nice weather today.');
    const everything = [
      'Nice weather today.',
      'Anything new with you?',
      'Quiet day in the village.',
      'I should get back to it soon.',
    ];
    expect(cannedLine(args({ speaker: {}, listener: null, alreadySaid: everything }))).toBe('Hm.');
  });
});

describe('cannedLine: leave', () => {
  test('polite or curt depending on the relationship', () => {
    expect(cannedLine(args({ type: 'leave' }))).toBe(`I'd better get going. See you around, Bob.`);
    expect(
      cannedLine(
        args({
          type: 'leave',
          listenerId: 'p:1',
          listenerName: 'Traveler',
          speaker: { beliefs: [theft] },
        }),
      ),
    ).toBe('Just stay away from me, Traveler.');
  });
});
