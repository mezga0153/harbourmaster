import type { Contract, FisheryTerms } from '../sim/contracts';
import { makeOffer } from '../sim/contracts';
import { spawnBoat } from '../sim/systems/boats/berthing';
import { addContract } from '../sim/systems/economy';
import { buyTug } from '../sim/systems/tugs';
import { TICKS_PER_DAY } from '../sim/types';
import { World } from '../sim/world';
import { playDay } from '../../tests/bot';
import type { Param, Params } from './controls';

// Situations for the Scenes tab: ports to start from, and what to throw at
// one while it runs, so that what boats do meeting each other, queueing
// for berths, giving way and being towed can be watched as it happens.

export interface Preset {
  id: string;
  name: string;
  note: string;
  params: readonly Param[];
  /** Build it, saying how far along it is as it goes. */
  build(p: Params, progress: (text: string) => void): Promise<World>;
}

const SEED: Param = {
  key: 'seed',
  label: 'Seed',
  kind: 'range',
  min: 1,
  max: 999_999,
  step: 1,
  value: 844241,
};
const OWN_ALL: Param = { key: 'ownAll', label: 'Own all the land', kind: 'toggle', value: true };

/** Fisheries whose boats come more often than the berths can take. */
function crowd(w: World, n: number, every: number): void {
  for (let k = 0; k < n; k++) {
    addContract(
      w,
      {
        kind: 'fishery',
        vessel: 'smack',
        name: `Lab Fishery ${k + 1}`,
        color: k % 5,
        boatEvery: every,
        cratesMin: 4,
        cratesMax: 6,
        fee: 20,
      },
      w.tick + 10 + k * 50,
      0,
    );
  }
}

/** A day of the game at a time, letting the page draw between days. */
async function botDays(w: World, days: number, progress: (text: string) => void): Promise<void> {
  for (let d = 1; d <= days; d++) {
    progress(`The bot is playing: day ${d} of ${days}…`);
    await new Promise((r) => setTimeout(r));
    for (let t = 0; t < TICKS_PER_DAY; t++) w.step();
    playDay(w);
  }
}

export const PRESETS: Preset[] = [
  {
    id: 'new',
    name: 'A new port',
    note: 'As a new game starts: one jetty, the first boat coming in.',
    params: [SEED, { ...OWN_ALL, value: false }],
    build: async (p) => World.create(p.seed as number, undefined, p.ownAll as boolean),
  },
  {
    id: 'busy',
    name: 'A busy harbour',
    note: 'A new port with three fisheries sending boats every half day: more than its jetty can take.',
    params: [
      SEED,
      OWN_ALL,
      { key: 'fisheries', label: 'Extra fisheries', kind: 'range', min: 1, max: 8, value: 3 },
      {
        key: 'every',
        label: 'Boats every (days)',
        kind: 'range',
        min: 0.1,
        max: 2,
        step: 0.1,
        value: 0.5,
      },
    ],
    build: async (p) => {
      const w = World.create(p.seed as number, undefined, p.ownAll as boolean);
      crowd(w, p.fisheries as number, p.every as number);
      return w;
    },
  },
  {
    id: 'bot',
    name: 'A port the bot built',
    note: 'The playthrough bot (tests/bot.ts) plays for some days, putting up jetties, hiring and signing fisheries as a sensible beginner would.',
    params: [
      { ...SEED, value: 1 },
      { ...OWN_ALL, value: false },
      { key: 'days', label: 'Days', kind: 'range', min: 1, max: 30, value: 8 },
      { key: 'crowd', label: 'Then crowd it with boats', kind: 'toggle', value: true },
    ],
    build: async (p, progress) => {
      const w = World.create(p.seed as number, undefined, p.ownAll as boolean);
      await botDays(w, p.days as number, progress);
      if (p.crowd) crowd(w, 3, 0.5);
      return w;
    },
  },
];

/** A contract whose boats are of this kind, from those signed or a new one of the lab's that sends none of its own. */
function lineFor(w: World, vessel: FisheryTerms['vessel'], lobster = false): Contract {
  const fits = (t: FisheryTerms) =>
    t.vessel === vessel && (vessel !== 'smack' || (t.catch === 'lobster') === lobster);
  const have = w.contracts.find((c) => c.terms.kind === 'fishery' && fits(c.terms));
  if (have) return have;
  // The game's own offers for the kind, with their names and fees.
  const taken = new Set([...w.contracts, ...w.offers].map((c) => c.terms.name));
  for (let k = 0; k < 40; k++) {
    const o = makeOffer(w.rng, w.nextId++, w.tick, 'fishery', taken, 2, 50, lobster);
    if (o && o.terms.kind === 'fishery' && fits(o.terms))
      return addContract(w, o.terms, Infinity, 0);
  }
  const terms: FisheryTerms = {
    kind: 'fishery',
    vessel,
    name: `Lab ${vessel === 'feeder' ? 'Container Line' : vessel === 'coaster' ? 'Coastal Line' : 'Fishery'}`,
    color: 2,
    boatEvery: 99,
    cratesMin: vessel === 'smack' ? 4 : 16,
    cratesMax: vessel === 'smack' ? 6 : 21,
    fee: 25,
    catch: lobster ? 'lobster' : vessel === 'coaster' ? 'timber' : undefined,
  };
  return addContract(w, terms, Infinity, 0);
}

/** A boat of this kind sets out for the port now; `close`, from just off the anchorage. Returns what was sent. */
export function sendBoat(
  w: World,
  vessel: FisheryTerms['vessel'],
  close: boolean,
  lobster = false,
): string {
  const c = lineFor(w, vessel, lobster);
  const before = w.boats.length;
  spawnBoat(w, c.id, c.terms as FisheryTerms, close);
  const b = w.boats[w.boats.length - 1];
  if (w.boats.length === before || !b) return 'No open sea to come in from';
  return `${c.terms.name}’s ${vessel} #${b.id} is on its way`;
}

/** A tug for the port, at any free tug berth. */
export function sendTug(w: World): string {
  const n = w.tugs.length;
  buyTug(w);
  return w.tugs.length > n
    ? `Tug #${w.tugs[n].id} is at its berth`
    : 'No free tug berth (build one, then try again)';
}
