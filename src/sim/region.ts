import { Rng } from './rng';

// The region the port serves from the Container Port on: places along the
// main line past the map's north and south ends, each growing as the port
// serves it, the town up the coast among them. Inland cities send container
// trains (see systems/trains.ts) and grow, step by step, on the containers
// the port moves for them; the collieries, farms, mines and works wait for
// the Bulk Terminal. The region's size, the town's people with theirs, is
// what the harbour authority looks to from the Bulk Terminal on.

export type PlaceKind = 'city' | 'colliery' | 'farms' | 'mine' | 'power' | 'steelworks';

/**
 * A step a place takes as the port serves it, like the town's landmarks:
 * `inland`, containers its trains take away inland; `out`, containers they
 * brought put on board ships; `any`, both together.
 */
export interface PlaceStep {
  name: string;
  goal: { what: 'inland' | 'out' | 'any'; total: number };
  /** The goal in words, for the Region panel. */
  aim: string;
  /** What taking it brings, in words. */
  opens: string;
  /** People the place may grow to once it has taken it. */
  cap: number;
}

export interface Place {
  id: number;
  name: string;
  kind: PlaceKind;
  /** The end of the main line it lies past: -1 north (towards -y), +1 south. */
  side: 1 | -1;
  /** How far past the map's end, in km. */
  far: number;
  /** People living or working there. */
  size: number;
  /** How many of its steps it has taken. */
  steps: number;
  /** Towards its next step: containers so far. */
  goal: number;
  /** Containers the port moved for it today, and a day lately: it grows while served. */
  today: number;
  lately: number;
}

export interface Region {
  places: Place[];
}

/** People a city has to start with, and may grow to before its first step. */
const CITY_START = 1800;
const CITY_CAP = 2000;

/** What an inland city's container trains bring it, step by step. */
export const CITY_STEPS: PlaceStep[] = [
  {
    name: 'Freight terminal',
    goal: { what: 'inland', total: 40 },
    aim: 'Its trains take 40 containers inland',
    opens: 'Its trains come longer: room for 4 more containers a train',
    cap: 2600,
  },
  {
    name: 'Distribution park',
    goal: { what: 'out', total: 40 },
    aim: 'Put 40 containers its trains brought on board ships',
    opens: 'The other end of the line takes notice: another city offers its trains',
    cap: 3600,
  },
  {
    name: 'Business district',
    goal: { what: 'any', total: 200 },
    aim: 'Move 200 containers for it, in and out',
    opens: 'Offices and homes: it grows on',
    cap: 5000,
  },
];

/** What the places waiting for the Bulk Terminal would send or want, for the Region panel. */
export const WAITS: Record<Exclude<PlaceKind, 'city'>, string> = {
  colliery: 'Would send coal down the line to go out on bulk carriers',
  farms: 'Would send their grain at harvest, for the silos and the bulk carriers',
  mine: 'Would send ore to go out on bulk carriers',
  power: 'Wants coal by the trainload once ships can land it',
  steelworks: 'Wants ore and coal landed, and would send steel out in containers',
};

const KIND_LABEL: Record<PlaceKind, string> = {
  city: 'City',
  colliery: 'Colliery',
  farms: 'Farms and grain co-op',
  mine: 'Ore mine',
  power: 'Power station',
  steelworks: 'Steelworks',
};

export function placeLabel(k: PlaceKind): string {
  return KIND_LABEL[k];
}

const CITIES = ['Ashford', 'Kingsbridge', 'Thornbury', 'Millbrook', 'Castleton', 'Redwater'];
const VILLAGES = ['Coalbrook', 'Harrowdale', 'Oakhurst', 'Fenmoor', 'Stonebridge', 'Ironvale'];
const BULK: { kind: Exclude<PlaceKind, 'city'>; size: number }[] = [
  { kind: 'colliery', size: 350 },
  { kind: 'farms', size: 450 },
  { kind: 'mine', size: 250 },
  { kind: 'power', size: 150 },
  { kind: 'steelworks', size: 600 },
];

/** The region of a map from its seed: a city at each end of the line, and the works between. */
export function newRegion(seed: number): Region {
  const rng = new Rng((seed ^ 0x2e61) >>> 0);
  const cities = [...CITIES].sort(() => rng.next() - 0.5);
  const villages = [...VILLAGES].sort(() => rng.next() - 0.5);
  const first: 1 | -1 = rng.next() < 0.5 ? 1 : -1;
  const places: Place[] = [];
  const add = (p: Omit<Place, 'id' | 'steps' | 'goal' | 'today' | 'lately'>) =>
    places.push({ ...p, id: places.length + 1, steps: 0, goal: 0, today: 0, lately: 0 });
  // The nearer city first: its trains are the first the railway offers.
  add({ name: cities[0], kind: 'city', side: first, far: rng.int(25, 40), size: CITY_START });
  add({
    name: cities[1],
    kind: 'city',
    side: -first as 1 | -1,
    far: rng.int(45, 70),
    size: CITY_START,
  });
  BULK.forEach((b, k) => {
    const name = b.kind === 'power' || b.kind === 'steelworks' ? cities[k % 2] : villages[k];
    add({
      name,
      kind: b.kind,
      side: (k % 2 === 0 ? first : -first) as 1 | -1,
      far: rng.int(8, 90),
      size: b.size,
    });
  });
  return { places };
}

/** The steps a place takes, by its kind: none yet but for the cities. */
export function stepsOf(p: Place): PlaceStep[] {
  return p.kind === 'city' ? CITY_STEPS : [];
}

/** People a place may grow to, as far as its steps let it. */
export function placeCap(p: Place): number {
  if (p.kind !== 'city') return p.size;
  return p.steps > 0 ? CITY_STEPS[p.steps - 1].cap : CITY_CAP;
}

/** The step a place is working towards, if it has one. */
export function nextStep(p: Place): PlaceStep | undefined {
  return stepsOf(p)[p.steps];
}

/** Count containers the port moved for a place towards its next step; the step it took, if it did. */
export function countFor(p: Place, what: 'inland' | 'out', n: number): PlaceStep | null {
  p.today += n;
  const step = nextStep(p);
  if (!step || (step.goal.what !== what && step.goal.what !== 'any')) return null;
  p.goal += n;
  if (p.goal < step.goal.total) return null;
  p.steps++;
  p.goal = 0;
  return step;
}

/** Share of the way to its cap a place served lately grows each day. */
const GROWTH = 0.12;

/** A day's end: places the port served grow towards what their steps let them. */
export function regionDay(r: Region): void {
  for (const p of r.places) {
    p.lately = p.lately * 0.7 + p.today * 0.3;
    p.today = 0;
    if (p.kind === 'city' && p.lately >= 0.5) {
      p.size = Math.round(p.size + (placeCap(p) - p.size) * GROWTH);
    }
  }
}

/** People in the region's places, besides the town's. */
export function placesSize(r: Region): number {
  return r.places.reduce((n, p) => n + p.size, 0);
}

/** The cities whose container trains the railway offers the port, once it may lay sidings. */
export function openCities(r: Region): Place[] {
  const cities = r.places.filter((p) => p.kind === 'city');
  // The second once the first has its distribution park.
  return cities.filter((_, k) => k === 0 || cities[0].steps >= 2);
}
