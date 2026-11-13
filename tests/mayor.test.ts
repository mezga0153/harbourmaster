import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../src/protocol';
import { TICKS_PER_DAY } from '../src/sim/types';
import { LANDMARKS } from '../src/sim/town';
import { HELP, mayorStep, type Watch } from '../src/ui/mayorTalk';

type TownView = NonNullable<Snapshot['town']>;
type Next = NonNullable<TownView['next']>;

const FISH: Next = {
  name: 'Fish market',
  aim: 'Truck out 12 crates of fish a day, 3 days running',
  opens: 'The market wants ice',
  have: 0,
  need: 12,
  days: { done: 0, need: 3 },
  cap: 150,
};
const ICE: Next = {
  name: 'Ice house',
  aim: 'Put 20 crates of ice on board fishing boats',
  opens: 'Lobster boats offer their catch',
  have: 0,
  need: 20,
  cap: 200,
};

const town = (next: Next | null, more: Partial<TownView> = {}): TownView =>
  ({ name: 'Gullhaven', population: 60, cap: 100, opened: [], next, ...more }) as TownView;

/** Run the mayor along `steps` of [tick, town], collecting what is said. */
function talk(steps: [number, TownView][]): { tick: number; text: string; mood: string }[] {
  let w: Watch | null = null;
  const out: { tick: number; text: string; mood: string }[] = [];
  for (const [tick, t] of steps) {
    const r = mayorStep(w, t, tick);
    w = r.watch;
    out.push(...r.say.map((s) => ({ tick, text: s.text, mood: s.mood })));
  }
  return out;
}

describe('Mayor Bramblewick', () => {
  it('greets a new game with what the town wants first', () => {
    const said = talk([[0, town(FISH)]]);
    expect(said).toHaveLength(1);
    expect(said[0].text).toMatch(/I am Mayor Bramblewick/);
    expect(said[0].text).toMatch(/12 crates of fish a day/);
  });

  it('keeps quiet between updates, then says how it is going about once a day', () => {
    const said = talk([
      [5000, town(FISH)],
      [5100, town({ ...FISH, have: 4 })],
      [5000 + TICKS_PER_DAY - 1, town({ ...FISH, have: 6 })],
      [5000 + TICKS_PER_DAY, town({ ...FISH, have: 7 })],
    ]);
    expect(said.map((s) => s.tick)).toEqual([5000, 5000 + TICKS_PER_DAY]);
    expect(said[0].text).toMatch(/Welcome back/);
    expect(said[1].text).toMatch(/7 of 12 crates today, 0 of 3 days/);
  });

  it('cheers a day kept up and frets when the run is broken', () => {
    const said = talk([
      [5000, town(FISH)],
      [5300, town({ ...FISH, have: 0, days: { done: 1, need: 3 } })],
      [5900, town({ ...FISH, have: 0, days: { done: 0, need: 3 } })],
    ]);
    expect(said[1].mood).toBe('cheer');
    expect(said[1].text).toMatch(/1 of 3 kept up/);
    expect(said[2].mood).toBe('worry');
    expect(said[2].text).toMatch(/starts over/);
  });

  it('marks half way and nearly there once each, and the trouble when stuck', () => {
    const said = talk([
      [5000, town(ICE)],
      [5010, town({ ...ICE, have: 10 })],
      [5020, town({ ...ICE, have: 11 })],
      [5030, town({ ...ICE, have: 17 })],
      [5030 + TICKS_PER_DAY, town({ ...ICE, have: 17, hint: 'No ice offer is signed' })],
    ]);
    expect(said.map((s) => s.text.slice(0, 12))).toEqual([
      'Welcome back',
      'Half way to ',
      'Nearly there',
      'About the ic',
    ]);
    expect(said[3].text).toMatch(/no ice offer is signed/);
  });

  it('celebrates a landmark opening with what it brings, then asks for the next', () => {
    const said = talk([
      [5000, town({ ...FISH, have: 12, days: { done: 2, need: 3 } })],
      [5600, town(ICE, { opened: ['Fish market'], cap: 150 })],
    ]);
    expect(said).toHaveLength(3);
    expect(said[1].mood).toBe('proud');
    expect(said[1].text).toMatch(/fish market is open!.*The market wants ice/);
    expect(said[2].text).toMatch(/ice/i);
    expect(said[2].text).toMatch(/20 crates of ice/);
  });

  it('points at the port panel while the goal waits on the next tier, and says when it counts', () => {
    const cannery: Next = { ...FISH, name: 'Cannery', need: 30, days: { done: 0, need: 2 } };
    const said = talk([
      [5000, town({ ...cannery, waiting: 'Coastal Wharf' }, { cap: 400 })],
      [5100, town(cannery, { cap: 400 })],
    ]);
    expect(said[0].text).toMatch(/Coastal Wharf/);
    expect(said[1].text).toMatch(/^At last!/);
  });

  it('ends each line about the goal with how to do it, not the celebration', () => {
    let w = mayorStep(null, town(FISH), 5000);
    expect(w.say[0].help).toEqual({ guide: 'start', step: 2 });
    w = mayorStep(w.watch, town(ICE, { opened: ['Fish market'], cap: 150 }), 5600);
    expect(w.say[0].help).toBeUndefined();
    expect(w.say[1].help).toMatchObject({ action: { cargo: 'ice' } });
    const waiting = mayorStep(
      null,
      town({ ...FISH, name: 'Cannery', waiting: 'Coastal Wharf' }),
      5000,
    );
    expect(waiting.say[0].help).toBeUndefined();
    for (const l of LANDMARKS) expect(HELP[l.name], l.name).toBeDefined();
  });

  it('says once that the town is full', () => {
    const said = talk([
      [5000, town(ICE)],
      [5010, town(ICE, { population: 100 })],
      [5020, town(ICE, { population: 100 })],
    ]);
    expect(said).toHaveLength(2);
    expect(said[1].mood).toBe('worry');
  });
});
