import type { EntityView, Snapshot } from '../protocol';
import type { GameMap } from '../sim/map';
import { Terrain } from '../sim/types';
import { moving, pointAt, trainSpot } from '../sim/railway';

// What the port should sound like from where the camera is: pure sums over
// the snapshot, so they can be tested without Web Audio. sound.ts plays it.

/** Where the player is listening from: the middle of the view, in tiles. */
export interface Listener {
  x: number;
  y: number;
  /** Screen right, as a unit vector in tile space, for panning. */
  rightX: number;
  rightY: number;
  /** The camera's view size (see IsoCamera): small zoomed in, large zoomed out. */
  viewSize: number;
}

const smooth = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 1 zoomed right in, fading to 0 zoomed out: the near, particular sounds. */
export function nearness(l: Listener): number {
  return 1 - smooth(18, 48, l.viewSize);
}

/** 0 zoomed in, rising to 1 zoomed out: the port's hum from afar. */
export function farness(l: Listener): number {
  return smooth(14, 45, l.viewSize);
}

/** How far off, in tiles, a near sound still carries: about the width of the view. */
export function hearing(l: Listener): number {
  return l.viewSize * 0.9 + 4;
}

/** How loud a sound at (x, y) is from the listener, 0 to 1, within `range` tiles. */
export function attenuate(l: Listener, x: number, y: number, range = hearing(l)): number {
  const d = Math.hypot(x - l.x, y - l.y);
  const t = Math.max(0, 1 - d / range);
  return t ** 1.6;
}

/** Left (-1) to right (1) of the middle of the view. */
export function panOf(l: Listener, x: number, y: number, range = hearing(l)): number {
  const side = (x - l.x) * l.rightX + (y - l.y) * l.rightY;
  return Math.max(-1, Math.min(1, side / (range * 0.7))) * 0.85;
}

/** A continuous sound made by many sources: how loud, and where on the left and right. */
export interface Source {
  gain: number;
  pan: number;
}

/** A bed of engines of one kind: how loud, where, and how big those heard are, 0 to 1, for their pitch. */
export interface Engines extends Source {
  size: number;
}

/** The diesels on land, each with a sound of its own. */
export type RoadEngine = 'truck' | 'tractor' | 'stacker';
export const ROAD_ENGINES: RoadEngine[] = ['truck', 'tractor', 'stacker'];

/** The ships, by hull: each kind's engines beat differently. */
export type Hull = 'smack' | 'tug' | 'coaster' | 'feeder';
export const HULLS: Hull[] = ['smack', 'tug', 'coaster', 'feeder'];

/**
 * How big each vessel is to the ear, 0 to 1: the bigger, the deeper its
 * engines and its horn, and the further they carry.
 */
export const VESSEL_SIZE: Record<string, number> = {
  smack: 0.1,
  tug: 0.35,
  coaster: 0.55,
  feeder: 1,
};

/** How far a ship's engines carry, as a share of the hearing range. */
const HULL_CARRY: Record<Hull, number> = { smack: 0.8, tug: 1, coaster: 1.25, feeder: 1.7 };

/**
 * How big a truck is to the ear, 0 to 1: a crate truck, a bigger one, a
 * container truck with one box, with two.
 */
export function truckSize(e: Pick<EntityView, 'boxes' | 'capacity'>): number {
  if (e.boxes) return e.capacity >= 2 ? 1 : 0.75;
  return e.capacity >= 8 ? 0.5 : 0.3;
}

export interface Bed {
  /** Trucks, terminal tractors and reach stackers driving about, each kind its own. */
  diesels: Record<RoadEngine, Engines>;
  /** Ships' engines under way, by hull. */
  ships: Record<Hull, Source>;
  /** Forklifts' electric whine. */
  electric: Source;
  /** Cranes' winches lifting. */
  winch: Source;
  /** The train going by. */
  train: Source;
  /** How busy the whole port is, 0 to 1, for its hum. */
  activity: number;
}

const DIESEL: Partial<Record<EntityView['kind'], number>> = { truck: 1, tractor: 0.8, stacker: 1 };

/** Like gather, with how big the sources are on average, by how loud each is. */
function gatherEngines(parts: { w: number; pan: number; size: number }[], each: number): Engines {
  const total = parts.reduce((n, p) => n + p.w, 0);
  const size = total > 0 ? parts.reduce((n, p) => n + p.w * p.size, 0) / total : 0.5;
  return { ...gather(parts, each), size };
}

/** Tile centre of a tile index. */
const at = (idx: number, w: number) => ({ x: (idx % w) + 0.5, y: Math.floor(idx / w) + 0.5 });

/** Sums sources into one: louder the more there are, but never past 1. */
function gather(parts: { w: number; pan: number }[], each: number): Source {
  const total = parts.reduce((n, p) => n + p.w, 0);
  if (total <= 0) return { gain: 0, pan: 0 };
  const pan = parts.reduce((n, p) => n + p.w * p.pan, 0) / total;
  return { gain: 1 - Math.exp(-total * each), pan };
}

export function bed(s: Snapshot, l: Listener, w: number, trainX: number): Bed {
  const diesels: Record<RoadEngine, { w: number; pan: number; size: number }[]> = {
    truck: [],
    tractor: [],
    stacker: [],
  };
  const ships: Record<Hull, { w: number; pan: number }[]> = {
    smack: [],
    tug: [],
    coaster: [],
    feeder: [],
  };
  const electric: { w: number; pan: number }[] = [];
  const winch: { w: number; pan: number }[] = [];
  let busy = 0;
  for (const e of s.entities) {
    const working = e.moving || e.handStage !== undefined || e.handling !== undefined;
    if (!working) continue;
    if (e.kind !== 'boat' && e.kind !== 'dockhand') busy += e.kind === 'truck' ? 0.5 : 1;
    if (e.kind === 'boat') busy += 0.5;
    const hull = e.kind === 'boat' ? (e.vessel as Hull) : undefined;
    if (hull && e.moving && HULL_CARRY[hull]) {
      const range = hearing(l) * HULL_CARRY[hull];
      const a = attenuate(l, e.x, e.y, range);
      if (a > 0) ships[hull].push({ w: a, pan: panOf(l, e.x, e.y, range) });
    }
    const near = attenuate(l, e.x, e.y);
    if (near <= 0) continue;
    const pan = panOf(l, e.x, e.y);
    const d = DIESEL[e.kind];
    if (d) {
      const size = e.kind === 'truck' ? truckSize(e) : e.kind === 'stacker' ? 0.8 : 0.5;
      diesels[e.kind as RoadEngine].push({ w: near * d * (e.moving ? 1 : 0.5), pan, size });
    } else if (e.kind === 'forklift') electric.push({ w: near, pan });
  }
  for (const c of s.cranes) {
    const lifting = c.working !== undefined || c.busy;
    if (!lifting) continue;
    busy += 2;
    const p = at(c.idx, w);
    const near = attenuate(l, p.x, p.y);
    if (near > 0) winch.push({ w: near, pan: panOf(l, p.x, p.y) });
  }
  let train: Source = { gain: 0, pan: 0 };
  // The nearest train under way rumbles; one standing in a siding is quiet.
  for (const t of s.trains) {
    if (!moving(t) || trainX < 0) continue;
    const range = hearing(l) * 1.6;
    const p = trainSpot(t);
    const gain = attenuate(l, p.x, p.y, range);
    if (gain > train.gain) train = { gain, pan: panOf(l, p.x, p.y, range) };
  }
  return {
    diesels: {
      truck: gatherEngines(diesels.truck, 0.7),
      tractor: gatherEngines(diesels.tractor, 0.7),
      stacker: gatherEngines(diesels.stacker, 0.7),
    },
    ships: {
      smack: gather(ships.smack, 0.9),
      tug: gather(ships.tug, 0.9),
      coaster: gather(ships.coaster, 0.9),
      feeder: gather(ships.feeder, 0.9),
    },
    electric: gather(electric, 0.8),
    winch: gather(winch, 0.9),
    train,
    activity: Math.max(0.08, Math.min(1, busy / 40)),
  };
}

/** How much of the ground round the listener is water, 0 to 1. */
export function waterNear(map: GameMap, l: Listener): number {
  const r = hearing(l) * 0.6;
  let water = 0;
  let all = 0;
  for (let i = -3; i <= 3; i++) {
    for (let j = -3; j <= 3; j++) {
      const x = Math.floor(l.x + (i / 3) * r);
      const y = Math.floor(l.y + (j / 3) * r);
      all++;
      if (!map.inBounds(x, y))
        water++; // off the map is the open sea
      else if (map.terrain[map.idx(x, y)] === Terrain.Water) water++;
    }
  }
  return water / all;
}

export type CueKind = 'clank' | 'thunk' | 'beep' | 'hiss' | 'horn' | 'toot' | 'trainHorn';

/** Something that happened just now that makes a sound, and where. */
export interface Cue {
  kind: CueKind;
  x: number;
  y: number;
  /** Horns: the ship sounding it, for its pitch. */
  vessel?: string;
  /** A container set down on a truck or tractor's trailer, rather than on the ground or a stack. */
  onTruck?: boolean;
}

interface Seen {
  moving: boolean;
  hand?: string;
  handTruck?: boolean;
  phase: number;
  handling?: number;
  activity: string;
}

interface CraneSeen {
  working?: string;
  phase: number;
}

/**
 * Picks out, from one snapshot to the next, what has just happened that
 * makes a sound: a container set down, a crate put down, a machine backing
 * off, a truck pulling up, a ship sailing.
 */
export class CueTracker {
  private ents = new Map<number, Seen>();
  private cranes = new Map<number, CraneSeen>();
  private trains = new Set<number>();
  private primed = false;

  constructor(private rand: () => number = Math.random) {}

  update(s: Snapshot, w: number, trainX: number): Cue[] {
    const out: Cue[] = [];
    const first = !this.primed;
    this.primed = true;
    const ents = new Map<number, Seen>();
    for (const e of s.entities) {
      const now: Seen = {
        moving: e.moving,
        hand: e.handStage,
        handTruck: e.handAt?.truck !== undefined,
        phase: e.handPhase ?? 0,
        handling: e.handling,
        activity: e.activity,
      };
      ents.set(e.id, now);
      const was = this.ents.get(e.id);
      if (first || !was) continue;
      const here = { x: e.x, y: e.y };
      // A container changes hands as a machine's lift ends.
      if (was.hand && (now.hand !== was.hand || now.phase < was.phase)) {
        out.push({ kind: 'clank', ...here, onTruck: was.hand === 'drop' && was.handTruck });
      }
      // A crate or pallet put down or picked up.
      if (
        (e.kind === 'forklift' || e.kind === 'dockhand') &&
        was.handling !== undefined &&
        (now.handling === undefined || now.handling < was.handling)
      ) {
        out.push({ kind: 'thunk', ...here });
      }
      if ((e.kind === 'forklift' || e.kind === 'stacker') && now.moving && !was.moving) {
        if (this.rand() < 0.35) out.push({ kind: 'beep', ...here });
      }
      if (e.kind === 'truck' && was.moving && !now.moving && this.rand() < 0.25) {
        out.push({ kind: 'hiss', ...here });
      }
      if (e.kind === 'boat') {
        if (e.vessel === 'tug') {
          if (was.activity.startsWith('Lying') && !now.activity.startsWith('Lying')) {
            out.push({ kind: 'toot', ...here, vessel: 'tug' });
          }
        } else if (
          now.activity.startsWith('Heading back out') &&
          !was.activity.startsWith('Heading back out')
        ) {
          out.push({ kind: e.vessel === 'smack' ? 'toot' : 'horn', ...here, vessel: e.vessel });
        }
      }
    }
    this.ents = ents;

    const cranes = new Map<number, CraneSeen>();
    for (const c of s.cranes) {
      const now: CraneSeen = { working: c.working, phase: c.workPhase ?? 0 };
      cranes.set(c.idx, now);
      const was = this.cranes.get(c.idx);
      if (first || !was?.working) continue;
      if (now.working !== was.working || now.phase < was.phase - 0.3) {
        out.push({ kind: c.kind === 'jib' ? 'thunk' : 'clank', ...at(c.idx, w) });
      }
    }
    this.cranes = cranes;

    // A horn from its front as each train sets off along the line.
    const under = new Set(s.trains.filter(moving).map((t) => t.id));
    for (const t of s.trains) {
      if (!under.has(t.id) || this.trains.has(t.id) || first || trainX < 0) continue;
      const p = pointAt(t.way, t.at);
      out.push({ kind: 'trainHorn', x: p.x, y: p.y });
    }
    this.trains = under;
    return out;
  }
}

/** How far each kind of sound carries, as a share of the hearing range: horns go far over water. */
export const CARRY: Record<CueKind, number> = {
  clank: 1,
  thunk: 0.7,
  beep: 1,
  hiss: 0.8,
  horn: 4,
  toot: 2,
  trainHorn: 3,
};

/** At most this many of each kind of sound a second, so a busy port at 8× is not a din. */
export const PER_SECOND: Record<CueKind, number> = {
  clank: 5,
  thunk: 4,
  beep: 1,
  hiss: 0.7,
  horn: 0.3,
  toot: 0.5,
  trainHorn: 0.2,
};
