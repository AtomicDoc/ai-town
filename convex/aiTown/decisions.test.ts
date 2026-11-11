import { applyDecision, processEvents, tickIntent } from './decisions';
import { AgentEvent } from './decisionPolicy';
import { newJob } from './jobs';
import type { Game } from './game';

type P = {
  id: string;
  human?: string;
  position: { x: number; y: number };
  inventory: Record<string, number>;
  coins: number;
  activity?: { description: string; emoji?: string; until: number };
  pathfinding?: { destination: { x: number; y: number } };
  lastInput: number;
};

function fakeWorld() {
  const players = new Map<string, P>([
    [
      'p:1',
      {
        id: 'p:1',
        human: 'Me',
        position: { x: 10, y: 10 },
        inventory: {},
        coins: 50,
        lastInput: 0,
      },
    ],
    ['p:2', { id: 'p:2', position: { x: 12, y: 10 }, inventory: {}, coins: 0, lastInput: 0 }],
    [
      'p:3',
      { id: 'p:3', position: { x: 20, y: 10 }, inventory: { bread: 4 }, coins: 50, lastInput: 0 },
    ],
  ]);
  const agents = new Map<string, any>([
    ['a:2', { id: 'a:2', playerId: 'p:2' }],
    [
      'a:3',
      { id: 'a:3', playerId: 'p:3', job: { ...newJob('shopkeeper'), workplace: { x: 42, y: 30 } } },
    ],
  ]);
  const conversations = new Map<string, any>();
  const logs: any[] = [];
  const open = Array.from({ length: 64 }, () => Array(48).fill(-1));
  const game = {
    world: {
      players,
      agents,
      conversations,
      playerConversation: (p: P) =>
        [...conversations.values()].find((c) => c.participants.has(p.id)),
    },
    allocId: () => 'c:50',
    logDecision: (row: any) => logs.push(row),
    worldMap: { width: 64, height: 48, objectTiles: [open] },
    playerDescriptions: new Map([
      ['p:1', { name: 'Traveler' }],
      ['p:2', { name: 'Alice' }],
      ['p:3', { name: 'Lucky' }],
    ]),
  } as unknown as Game;
  return { game, players, agents, conversations, logs };
}

const robbed: AgentEvent = { kind: 'robbed', at: 0, subject: 'p:1' as any, item: 'bread' };

describe('processEvents (traditional policy)', () => {
  const old = process.env.DECISION_POLICY;
  beforeAll(() => {
    process.env.DECISION_POLICY = 'traditional';
  });
  afterAll(() => {
    if (old === undefined) delete process.env.DECISION_POLICY;
    else process.env.DECISION_POLICY = old;
  });

  test('robbed -> scripted confront: starts a conversation with the thief and logs it', () => {
    const { game, players, agents, conversations, logs } = fakeWorld();
    const alice = agents.get('a:2');
    alice.pendingEvents = [robbed];
    expect(processEvents(game, 100, alice, players.get('p:2') as any)).toBe(true);
    const convo = conversations.get('c:50');
    expect(convo).toBeDefined();
    expect([...convo.participants.keys()].sort()).toEqual(['p:1', 'p:2']);
    expect(logs).toEqual([
      expect.objectContaining({
        trigger: 'event.robbed',
        mode: 'scripted',
        choice: 'confront',
        policy: 'traditional',
      }),
    ]);
    expect(alice.pendingEvents).toBeUndefined();
  });

  test('no events: nothing happens', () => {
    const { game, players, agents, logs } = fakeWorld();
    expect(processEvents(game, 100, agents.get('a:2'), players.get('p:2') as any)).toBe(false);
    expect(logs).toEqual([]);
  });
});

describe('idle activity intent (config C)', () => {
  test('walks to the place, then does the activity and remembers it', () => {
    const { game, players, agents } = fakeWorld();
    const alice = players.get('p:2')!;
    const aliceAgent = agents.get('a:2');
    aliceAgent.intent = {
      kind: 'activity',
      destination: { x: 8, y: 15 },
      place: 'the west grove',
      description: 'reading a book under a tree',
      emoji: '📖',
      until: 100_000,
    };
    expect(tickIntent(game, 1000, aliceAgent, alice as any)).toBe(true);
    expect(alice.pathfinding?.destination).toEqual({ x: 8, y: 15 });

    delete alice.pathfinding;
    alice.position = { x: 8, y: 15 };
    expect(tickIntent(game, 2000, aliceAgent, alice as any)).toBe(true);
    expect(alice.activity).toMatchObject({
      description: 'reading a book under a tree',
      emoji: '📖',
    });
    expect(aliceAgent.intent).toBeUndefined();
    expect(aliceAgent.recentActions).toEqual([
      { at: 2000, description: 'reading a book under a tree', place: 'the west grove' },
    ]);
  });

  test('an expired plan is dropped', () => {
    const { game, players, agents } = fakeWorld();
    const aliceAgent = agents.get('a:2');
    aliceAgent.intent = {
      kind: 'activity',
      destination: { x: 8, y: 15 },
      place: 'the west grove',
      description: 'x',
      emoji: '📖',
      until: 10,
    };
    expect(tickIntent(game, 1000, aliceAgent, players.get('p:2') as any)).toBe(false);
    expect(aliceAgent.intent).toBeUndefined();
  });
});

describe('applyDecision', () => {
  test('notable choices are remembered as recent actions', () => {
    const { game, players, agents } = fakeWorld();
    const aliceAgent = agents.get('a:2');
    applyDecision(game, 100, aliceAgent, players.get('p:2') as any, robbed, 'confront');
    expect(aliceAgent.recentActions?.[0].description).toBe('confronted Traveler');
  });

  test('avoid walks away from the subject', () => {
    const { game, players, agents } = fakeWorld();
    const alice = players.get('p:2')!;
    applyDecision(game, 100, agents.get('a:2'), alice as any, robbed, 'avoid');
    const dest = (alice as any).pathfinding.destination;
    expect(dest.x).toBeGreaterThan(alice.position.x); // the thief is to the left
  });

  test('wave sets a short activity', () => {
    const { game, players, agents } = fakeWorld();
    const alice = players.get('p:2')!;
    applyDecision(game, 100, agents.get('a:2'), alice as any, robbed, 'wave');
    expect(alice.activity).toMatchObject({ description: 'waving', until: 5100 });
  });

  test('steal: plans a theft from the shopkeeper, then carries it out when close', () => {
    const { game, players, agents } = fakeWorld();
    const alice = players.get('p:2')!;
    const aliceAgent = agents.get('a:2');
    const broke: AgentEvent = { kind: 'brokeAndHungry', at: 0 };
    applyDecision(game, 100, aliceAgent, alice as any, broke, 'steal');
    expect(aliceAgent.intent).toMatchObject({ kind: 'steal', targetId: 'p:3' });

    // Far away: walks toward Lucky.
    expect(tickIntent(game, 200, aliceAgent, alice as any)).toBe(true);
    expect(alice.pathfinding).toBeDefined();

    // Next to Lucky: steals a loaf; Lucky (the victim) gets a robbed event.
    delete alice.pathfinding;
    alice.position = { x: 19, y: 10 };
    expect(tickIntent(game, 300, aliceAgent, alice as any)).toBe(true);
    expect(alice.inventory).toEqual({ bread: 1 });
    expect(aliceAgent.intent).toBeUndefined();
    expect(agents.get('a:3').pendingEvents).toEqual([
      expect.objectContaining({ kind: 'robbed', subject: 'p:2' }),
    ]);
  });
});
