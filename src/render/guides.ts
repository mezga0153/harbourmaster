import {
  Box3,
  Group,
  Mesh,
  MeshLambertMaterial,
  type OrthographicCamera,
  PlaneGeometry,
  Vector3,
} from 'three';
import type { BayView, CellsView, YardView } from '../protocol';
import { CRATES_PER_STORE_TILE } from '../sim/balance';
import type { GameMap } from '../sim/map';
import { bestFacing, footprint } from '../sim/rules';
import { Build, Store, type BuildKind } from '../sim/types';
import { FORKS_EMPTY, FORKS_LOADED, forklift, stacker } from './machines';
import { trainCar } from './trains';
import { CAR_LENGTH } from '../sim/railway';
import { RAILS } from '../sim/orient';
import { boat, person, truck, type Model } from './model';
import { Overlay, type Hints } from './overlay';
import { Structures } from './structures';
import { C } from './palette';
import { buildLand, surfaceY } from './terrain';
import { at, block, lay, patch, place, row, shoot, viewOf } from './thumbs';

/**
 * The guides' pictures (src/ui/Guide.tsx): a bit of port built up a beat at
 * a time on a patch of shore, as the game draws it, each beat rendered once
 * and shown in turn like a flip book, with a hand over it where the player
 * would click or drag.
 */

/** A boat, truck, machine or person stood somewhere in a beat; `turn` from facing +x, `load` crates aboard. */
interface Prop {
  /** A train: its locomotive's front at (x, y), wagons trailing back along -x, `load` containers on them. */
  kind: 'smack' | 'coaster' | 'feeder' | 'forklift' | 'stacker' | 'truck' | 'person' | 'train';
  x: number;
  y: number;
  turn?: number;
  load?: number;
}

/** Crates in storage (its tiles) or a truck bay (its tile). */
interface Stock {
  tiles: number[];
  n: number;
  boxes?: boolean;
  outgoing?: boolean;
}

interface Beat {
  /** What is built in this beat, kept in those after it. */
  build?: (m: GameMap) => void;
  /** Tiles shown green as the game previews a build under the hand, in this beat only. */
  ghost?: (m: GameMap) => number[];
  /** Tiles tinted as the game explains them (where trucks load, a crane's ground), in this beat only. */
  hints?: (m: GameMap) => Hints;
  /** Crates in storage from this beat on, until another beat says otherwise. */
  stock?: (m: GameMap) => Stock[];
  /** Who and what stands about, in this beat only. */
  props?: Prop[];
  /** The player's hand, over a tile (x, y): pressed, or just pointing. */
  hand?: { x: number; y: number; down?: boolean };
  /** How long it shows, in ms. */
  hold?: number;
}

interface Picture {
  w: number;
  h: number;
  coast: number;
  /** The tiles framed, x0, y0, x1, y1. */
  view: [number, number, number, number];
  beats: Beat[];
}

/** One beat as drawn: the image, and where the hand is over it, in % of its width and height. */
export interface Frame {
  url: string;
  hand?: { left: number; top: number; down: boolean };
  hold: number;
}

const SIZE = [400, 240] as const;
const BEAT = 900;
const LAST = 2600;

const E = 0; // facing +x, towards the sea
const S = Math.PI / 2; // turned along the shore, towards -y
const N = -Math.PI / 2;

/** The concrete quay along the shore, columns x0 to x1, rows y0 to y1. */
function quay(m: GameMap, x0: number, x1: number, y0: number, y1: number): number[] {
  return lay(m, Build.Quay, block(m, x0, y0, x1, y1));
}

function store(m: GameMap, tiles: number[], kind: number = Store.Crates): number[] {
  for (const t of tiles) m.store[t] = kind;
  return tiles;
}

// Most pictures are on a patch 11 by 7, sand to column 6 and sea from 7,
// with the quay's edge, where it has one, at column 6; those with a
// container ship, 12 long.

const W = 11;
const H = 7;
const LONG = 12;
const COAST = 7;

/** A quay two wide along the shore with a port road behind it. */
function wharf(m: GameMap): void {
  quay(m, 5, 6, 1, 5);
  lay(m, Build.PortRoad, block(m, 3, 0, 4, 6));
}

/** A drag over a column of tiles, from row y0 to y1, as hand-down beats every `step` rows, then let go. */
function drag(
  x: number,
  y0: number,
  y1: number,
  make: (m: GameMap, tiles: number[]) => void,
  x1 = x,
): Beat[] {
  const out: Beat[] = [];
  for (let y = y0; ; y = Math.min(y1, y + 2)) {
    const to = y;
    out.push({
      hand: { x: x1, y: to, down: true },
      ghost: (m) => block(m, x, y0, x1, to),
    });
    if (y === y1) break;
  }
  out.push({ hand: { x: x1, y: y1 }, build: (m) => make(m, block(m, x, y0, x1, y1)) });
  return out;
}

/** A drag along a row of tiles, from column x0 to x1, as hand-down beats every two, then let go. */
function dragRow(
  y: number,
  x0: number,
  x1: number,
  make: (m: GameMap, tiles: number[]) => void,
): Beat[] {
  const out: Beat[] = [];
  for (let x = x0; ; x = Math.min(x1, x + 2)) {
    const to = x;
    out.push({ hand: { x: to, y, down: true }, ghost: (m) => row(m, y, x0, to) });
    if (x === x1) break;
  }
  out.push({ hand: { x: x1, y }, build: (m) => make(m, row(m, y, x0, x1)) });
  return out;
}

/** The main line down column 0. */
function mainLine(m: GameMap): void {
  lay(
    m,
    Build.Rail,
    Array.from({ length: H }, (_, y) => at(m, 0, y)),
  );
}

/** A siding along row 3 off the main line, port roads either side, and a yard for containers in below it and out above. */
function railYards(m: GameMap): void {
  mainLine(m);
  lay(m, Build.Siding, row(m, 3, 1, 6));
  lay(m, Build.PortRoad, [
    ...row(m, 4, 2, 6),
    ...row(m, 5, 1, 6),
    ...row(m, 2, 2, 6),
    ...row(m, 1, 1, 6),
  ]);
  store(m, row(m, 4, 2, 6), Store.Boxes);
  store(m, row(m, 2, 2, 6), Store.BoxesOut);
}

/** A building put down on tile (x, y): the hand points, presses with the game's preview under it, and lets go. */
function put(kind: BuildKind, x: number, y: number): Beat[] {
  const where = (m: GameMap) => {
    const i = at(m, x, y);
    return footprint(m, kind, i, bestFacing(m, kind, i)).filter((t) => t >= 0);
  };
  return [
    { hand: { x, y }, ghost: (m) => where(m) },
    { hand: { x, y, down: true }, ghost: (m) => where(m) },
    { hand: { x, y }, build: (m) => void place(m, kind, at(m, x, y)) },
  ];
}

const coaster = (load: number): Prop => ({ kind: 'coaster', x: 7.75, y: 3.5, turn: S, load });
const feeder = (load: number): Prop => ({ kind: 'feeder', x: 8, y: 6, turn: S, load });

const PICTURES = {
  siding: {
    w: W,
    h: H,
    coast: COAST,
    view: [0, 1, 6, 5],
    beats: [
      { build: mainLine },
      ...dragRow(3, 1, 6, (m, t) => void lay(m, Build.Siding, t)),
      { props: [{ kind: 'train', x: 6.85, y: 3.5, load: 4 }] },
    ],
  },
  sidingYards: {
    w: W,
    h: H,
    coast: COAST,
    view: [0, 0, 6, 6],
    beats: [
      {
        build: (m) => {
          mainLine(m);
          lay(m, Build.Siding, row(m, 3, 1, 6));
          lay(m, Build.PortRoad, [...row(m, 4, 2, 6), ...row(m, 5, 1, 6), ...row(m, 2, 2, 6)]);
        },
      },
      ...dragRow(4, 2, 6, (m, t) => void store(m, t, Store.Boxes)),
      ...dragRow(2, 2, 6, (m, t) => void store(m, t, Store.BoxesOut)),
      {
        props: [{ kind: 'stacker', x: 4.5, y: 5.5, turn: N }],
        stock: (m) => [{ tiles: row(m, 4, 2, 6), n: 8, boxes: true }],
      },
    ],
  },
  sidingTrain: {
    w: W,
    h: H,
    coast: COAST,
    view: [0, 0, 6, 6],
    beats: [
      {
        build: railYards,
        stock: (m) => [{ tiles: row(m, 4, 2, 6), n: 8, boxes: true }],
        props: [{ kind: 'train', x: 6.85, y: 3.5, load: 4 }],
      },
      {
        props: [
          { kind: 'train', x: 6.85, y: 3.5, load: 3 },
          { kind: 'stacker', x: 5.5, y: 1.5, turn: S, load: 1 },
        ],
        stock: (m) => [
          { tiles: row(m, 4, 2, 6), n: 8, boxes: true },
          { tiles: row(m, 2, 2, 6), n: 1, boxes: true },
        ],
      },
      {
        props: [
          { kind: 'train', x: 6.85, y: 3.5, load: 2 },
          { kind: 'stacker', x: 3.5, y: 5.5, turn: N, load: 1 },
        ],
        stock: (m) => [
          { tiles: row(m, 4, 2, 6), n: 6, boxes: true },
          { tiles: row(m, 2, 2, 6), n: 4, boxes: true },
        ],
      },
      {
        props: [{ kind: 'train', x: 6.85, y: 3.5, load: 6 }],
        stock: (m) => [
          { tiles: row(m, 4, 2, 6), n: 2, boxes: true },
          { tiles: row(m, 2, 2, 6), n: 4, boxes: true },
        ],
      },
    ],
  },
  sidingGantry: {
    w: W,
    h: H,
    coast: COAST,
    view: [0, 0, 6, 6],
    beats: [
      {
        build: (m) => {
          mainLine(m);
          lay(m, Build.Siding, row(m, 3, 1, 6));
          lay(m, Build.PortRoad, row(m, 4, 2, 6));
          store(m, row(m, 4, 2, 6), Store.Boxes);
        },
        stock: (m) => [{ tiles: row(m, 4, 2, 6), n: 8, boxes: true }],
      },
      // Over the track, which runs on under it.
      ...put('yardGantry', 2, 3).map((b) =>
        b.build
          ? {
              ...b,
              build: (m: GameMap) => {
                b.build!(m);
                m.orient[at(m, 2, 3)] |= RAILS;
              },
            }
          : b,
      ),
      { props: [{ kind: 'train', x: 6.85, y: 3.5, load: 2 }] },
      {
        props: [{ kind: 'train', x: 6.85, y: 3.5, load: 6 }],
        stock: (m) => [{ tiles: row(m, 4, 2, 6), n: 4, boxes: true }],
      },
    ],
  },
  firstBoat: {
    w: W,
    h: H,
    coast: COAST,
    view: [3, 1, 10, 5],
    beats: [
      {
        build: (m) => {
          lay(m, Build.Jetty, row(m, 3, 5, 8));
          lay(m, Build.Footpath, row(m, 3, 3, 4));
        },
        props: [{ kind: 'smack', x: 9, y: 4.4, load: 8 }],
      },
      { hand: { x: 8, y: 4 }, props: [{ kind: 'smack', x: 8, y: 4, load: 8 }] },
      { hand: { x: 8, y: 4, down: true }, props: [{ kind: 'smack', x: 8, y: 4, load: 8 }] },
    ],
  },
  firstDelivery: {
    w: W,
    h: H,
    coast: COAST,
    view: [0, 2, 9, 6],
    beats: [
      {
        build: (m) => {
          lay(m, Build.Jetty, row(m, 3, 5, 8));
          lay(m, Build.Footpath, block(m, 4, 3, 4, 5));
          lay(m, Build.Road, row(m, 5, 0, 3));
        },
        props: [
          { kind: 'smack', x: 8, y: 4, load: 8 },
          { kind: 'person', x: 7, y: 3.5, load: 1 },
        ],
      },
      {
        props: [
          { kind: 'person', x: 4.5, y: 4.5, load: 1 },
          { kind: 'truck', x: 2.5, y: 5.5 },
        ],
      },
      {
        props: [
          { kind: 'person', x: 3.8, y: 5.3 },
          { kind: 'truck', x: 2.5, y: 5.5, load: 4 },
        ],
      },
      { props: [{ kind: 'truck', x: 0.5, y: 5.5, load: 4, turn: Math.PI }] },
    ],
  },
  breakHut: {
    w: W,
    h: H,
    coast: COAST,
    view: [1, 1, 7, 5],
    beats: [
      {
        build: (m) => {
          lay(m, Build.Footpath, row(m, 3, 1, 5));
          lay(m, Build.Jetty, row(m, 3, 6, 8));
        },
      },
      ...put('breakHut', 3, 2),
      { props: [{ kind: 'person', x: 3.5, y: 3.5 }] },
    ],
  },
  customs: {
    w: W,
    h: H,
    coast: COAST,
    view: [1, 1, 7, 5],
    beats: [{ build: wharf }, ...put('customs', 2, 3)],
  },
  parking: {
    w: W,
    h: H,
    coast: COAST,
    view: [0, 1, 5, 6],
    beats: [
      { build: (m) => void lay(m, Build.Road, block(m, 1, 1, 4, 6)) },
      ...drag(2, 2, 4, (m, t) => void lay(m, Build.Parking, t), 3),
      { props: [{ kind: 'truck', x: 2.8, y: 3.5, turn: E }] },
      { props: [{ kind: 'truck', x: 4.5, y: 4.5, turn: N }] },
    ],
  },
  outStorage: {
    w: W,
    h: H,
    coast: COAST,
    view: [3, 1, 8, 5],
    beats: [
      { build: wharf },
      ...drag(5, 2, 4, (m, t) => void store(m, t, Store.CratesOut)),
      {
        props: [{ kind: 'truck', x: 4.5, y: 3.5 }],
        stock: (m) => [{ tiles: block(m, 5, 2, 5, 4), n: 20, outgoing: true }],
      },
      {
        props: [coaster(8), { kind: 'person', x: 6.5, y: 3.5, load: 1 }],
        stock: (m) => [{ tiles: block(m, 5, 2, 5, 4), n: 8, outgoing: true }],
      },
    ],
  },
  containerDepot: {
    w: W,
    h: H,
    coast: COAST,
    view: [1, 1, 7, 6],
    beats: [
      { build: wharf },
      ...put('depot', 2, 2),
      { props: [{ kind: 'stacker', x: 3.5, y: 2.5, turn: E }] },
      { props: [{ kind: 'stacker', x: 4.5, y: 4.5, turn: N }] },
    ],
  },
  containerYard: {
    w: W,
    h: LONG,
    coast: COAST,
    view: [2, 1, 10, 10],
    beats: [
      {
        build: (m) => {
          quay(m, 5, 6, 0, 11);
          lay(m, Build.PortRoad, block(m, 2, 0, 4, 11));
          place(m, 'harbourCrane', at(m, 6, 5));
        },
      },
      ...drag(3, 2, 4, (m, t) => void store(m, t, Store.Boxes)),
      {
        props: [feeder(30), { kind: 'stacker', x: 4.5, y: 5.5, turn: N, load: 1 }],
        stock: (m) => [{ tiles: block(m, 3, 2, 3, 4), n: 5, boxes: true }],
      },
      {
        props: [
          { kind: 'stacker', x: 4.5, y: 3.5, turn: Math.PI },
          { kind: 'truck', x: 2.5, y: 3.5, turn: S },
        ],
        hints: (m) => [{ kind: 'spot', tiles: block(m, 2, 2, 2, 4) }],
        stock: (m) => [{ tiles: block(m, 3, 2, 3, 4), n: 10, boxes: true }],
      },
    ],
  },
  quay: {
    w: W,
    h: H,
    coast: COAST,
    view: [4, 1, 7, 5],
    beats: [
      { hand: { x: 5, y: 1 } },
      ...drag(5, 1, 5, (m, t) => void lay(m, Build.Quay, t), 6),
      { props: [coaster(20)] },
    ],
  },
  office: {
    w: W,
    h: H,
    coast: COAST,
    view: [1, 1, 7, 5],
    beats: [
      { build: wharf, hand: { x: 2, y: 3 } },
      ...put('office', 2, 3),
      { props: [coaster(20)] },
    ],
  },
  storage: {
    w: W,
    h: H,
    coast: COAST,
    view: [3, 1, 8, 5],
    beats: [
      { build: wharf, hand: { x: 5, y: 2 } },
      ...drag(5, 2, 4, (m, t) => void store(m, t)),
      { hints: (m) => [{ kind: 'spot', tiles: block(m, 4, 2, 4, 4) }] },
      {
        props: [coaster(20), { kind: 'person', x: 6.5, y: 3.4, turn: Math.PI, load: 1 }],
        stock: (m) => [{ tiles: block(m, 5, 2, 5, 4), n: 14 }],
      },
      {
        props: [
          coaster(8),
          { kind: 'person', x: 6.5, y: 2.5, turn: Math.PI, load: 1 },
          { kind: 'truck', x: 4.5, y: 3.4, turn: S },
        ],
        stock: (m) => [{ tiles: block(m, 5, 2, 5, 4), n: 30 }],
      },
    ],
  },
  gate: {
    w: W,
    h: H,
    coast: COAST,
    view: [0, 0, 6, 6],
    beats: [
      { build: (m) => void lay(m, Build.Road, row(m, 5, 0, 1)), hand: { x: 2, y: 5 } },
      { hand: { x: 2, y: 5, down: true }, ghost: (m) => [at(m, 2, 5)] },
      {
        hand: { x: 2, y: 5 },
        build: (m) => {
          lay(m, Build.PortRoad, [at(m, 3, 5)]);
          place(m, 'portGate', at(m, 2, 5));
        },
      },
      ...drag(3, 1, 5, (m, t) => void lay(m, Build.PortRoad, t), 5),
      { hand: { x: 5, y: 1 } },
      ...drag(5, 1, 3, (m, t) => void store(m, t)),
      {
        stock: (m) => [{ tiles: block(m, 5, 1, 5, 3), n: 24 }],
        props: [{ kind: 'truck', x: 0.6, y: 5.5, turn: E }],
      },
      {
        props: [{ kind: 'truck', x: 4.5, y: 2.4, turn: S }],
        hints: (m) => [{ kind: 'spot', tiles: block(m, 4, 1, 4, 3) }],
      },
    ],
  },
  jib: {
    w: W,
    h: H,
    coast: COAST,
    view: [3, 1, 8, 5],
    beats: [
      { build: wharf, hand: { x: 6, y: 3 } },
      ...put('jibCrane', 6, 3),
      {
        hand: { x: 5, y: 3 },
        hints: (m) => [{ kind: 'reach', tiles: [at(m, 5, 3), at(m, 4, 3)] }],
      },
      { hand: { x: 5, y: 3, down: true }, ghost: (m) => [at(m, 5, 3)] },
      { hand: { x: 4, y: 3, down: true }, ghost: (m) => [at(m, 5, 3), at(m, 4, 3)] },
      { hand: { x: 4, y: 3 }, build: (m) => void store(m, [at(m, 5, 3), at(m, 4, 3)]) },
      { props: [{ kind: 'smack', x: 7.7, y: 3.5, turn: S, load: 10 }] },
      {
        props: [{ kind: 'smack', x: 7.7, y: 3.5, turn: S, load: 3 }],
        stock: (m) => [{ tiles: [at(m, 5, 3), at(m, 4, 3)], n: 7 }],
      },
    ],
  },
  /** A jib crane needs open water beside it: at the quay's edge, not behind. */
  jibEdge: {
    w: W,
    h: H,
    coast: COAST,
    view: [3, 1, 8, 5],
    beats: [
      { build: wharf, hand: { x: 5, y: 3 } },
      { hand: { x: 6, y: 3 } },
      ...put('jibCrane', 6, 3),
      { props: [{ kind: 'smack', x: 7.7, y: 3.5, turn: S, load: 10 }] },
    ],
  },
  depot: {
    w: W,
    h: H,
    coast: COAST,
    view: [1, 1, 6, 6],
    beats: [
      {
        build: (m) => {
          wharf(m);
          store(m, block(m, 5, 2, 5, 4));
        },
        stock: (m) => [{ tiles: block(m, 5, 2, 5, 4), n: 30 }],
        hand: { x: 2, y: 2 },
      },
      ...put('depot', 2, 2),
      { props: [{ kind: 'forklift', x: 3.5, y: 2.5, turn: E }] },
      { props: [{ kind: 'forklift', x: 4.4, y: 3.5, turn: E, load: 4 }] },
      {
        props: [
          { kind: 'forklift', x: 3.6, y: 5.0, turn: N, load: 4 },
          { kind: 'truck', x: 3.5, y: 6.3, turn: E },
        ],
      },
    ],
  },
  /** A container ship moors against a quay two tiles wide. */
  wide: {
    w: W,
    h: LONG,
    coast: COAST,
    view: [4, 1, 10, 10],
    beats: [
      {
        build: (m) => {
          quay(m, 6, 6, 0, 11);
          place(m, 'harbourCrane', at(m, 6, 5));
        },
        hand: { x: 5, y: 1 },
      },
      ...drag(5, 1, 10, (m, t) => void lay(m, Build.Quay, t)),
      { props: [feeder(40)] },
    ],
  },
  /** The ship lies centred on its crane, with open water its length along the quay. */
  room: {
    w: W,
    h: LONG,
    coast: COAST,
    view: [4, 1, 10, 10],
    beats: [
      {
        build: (m) => {
          quay(m, 5, 6, 0, 11);
          place(m, 'harbourCrane', at(m, 6, 5));
          lay(m, Build.Jetty, row(m, 8, 7, 9));
        },
        hand: { x: 8, y: 8 },
      },
      { hand: { x: 8, y: 8, down: true }, ghost: (m) => row(m, 8, 7, 9) },
      { hand: { x: 8, y: 8 }, build: (m) => void lay(m, Build.None, row(m, 8, 7, 9)) },
      { props: [feeder(40)] },
    ],
  },
  /** Dredged deep enough in front of the crane. */
  depth: {
    w: W,
    h: LONG,
    coast: COAST,
    view: [4, 1, 10, 10],
    beats: [
      {
        build: (m) => {
          for (let i = 0; i < m.depth.length; i++) if (m.ocean[i]) m.depth[i] = 2;
          quay(m, 5, 6, 0, 11);
          place(m, 'harbourCrane', at(m, 6, 5));
        },
        hand: { x: 7, y: 1 },
      },
      ...drag(7, 1, 10, (m, t) => t.forEach((i) => (m.depth[i] = 6)), 8),
      { props: [feeder(40)] },
    ],
  },
  gantry: {
    w: W,
    h: LONG,
    coast: COAST,
    view: [3, 1, 10, 10],
    beats: [
      { build: (m) => void quay(m, 4, 6, 0, 11), hand: { x: 6, y: 4 } },
      ...put('gantryCrane', 6, 4),
      { props: [feeder(40)] },
      { props: [feeder(28), { kind: 'stacker', x: 4.5, y: 6, turn: N }] },
    ],
  },
} satisfies Record<string, Picture>;

export type PictureId = keyof typeof PICTURES;

/** A port train standing in a siding along +x: its locomotive first, then flat wagons with `load` containers. */
function train(p: Prop, map: GameMap): Group {
  const g = new Group();
  const wagons = 3;
  let left = p.load ?? 0;
  for (let k = 0; k <= wagons; k++) {
    const looks = k === 0 ? undefined : [0, 1].map((s) => (left-- > 0 ? k * 2 + s : null));
    const car = trainCar(k === 0 ? 'loco' : 'flat', 1, k, looks);
    car.rotation.y = Math.PI / 2;
    car.position.set(p.x - (k + 0.5) * CAR_LENGTH, surfaceY(map, p.x, p.y) + 0.105, p.y);
    g.add(car);
  }
  return g;
}

function prop(p: Prop, map: GameMap): Model {
  if (p.kind === 'train') return { root: train(p, map), crates: [] } as unknown as Model;
  const model =
    p.kind === 'forklift'
      ? forklift()
      : p.kind === 'stacker'
        ? stacker()
        : p.kind === 'truck'
          ? truck(1, 8, false, 3)
          : p.kind === 'person'
            ? person(7)
            : boat(1, p.kind, 2);
  const afloat = p.kind === 'smack' || p.kind === 'coaster' || p.kind === 'feeder';
  model.root.position.set(p.x, afloat ? 0 : surfaceY(map, p.x, p.y), p.y);
  model.root.rotation.y = p.turn ?? 0;
  model.crates.forEach((c, k) => (c.visible = k < (p.load ?? 0)));
  if (model.forks) model.forks.position.y = p.load ? FORKS_LOADED : FORKS_EMPTY;
  return model;
}

function drawn(pic: Picture, k: number): { content: Group; map: GameMap } {
  const map = patch(pic.w, pic.h, pic.coast);
  let stock: Stock[] = [];
  for (const b of pic.beats.slice(0, k + 1)) {
    b.build?.(map);
    if (b.stock) stock = b.stock(map);
  }
  const structures = new Structures(map, true);
  structures.setBays(
    stock
      .filter((s) => !s.boxes)
      .map(
        (s) =>
          ({
            idx: s.tiles[0],
            tiles: s.tiles,
            stock: s.outgoing ? 0 : s.n,
            exports: s.outgoing ? s.n : 0,
            cells: cells(s),
          }) as BayView,
      ),
  );
  structures.setYards(
    stock
      .filter((s) => s.boxes)
      .map(
        (s) =>
          ({
            idx: s.tiles[0],
            tiles: s.tiles,
            boxes: s.n,
            exports: 0,
            cells: Array.from({ length: s.tiles.length * 6 }, (_, i) =>
              i < s.n ? { look: i + 1 } : null,
            ),
          }) as YardView,
      ),
  );
  const water = new Mesh(
    new PlaneGeometry(pic.w - pic.coast + 40, pic.h + 40),
    new MeshLambertMaterial({ color: 0x3f8fc9, transparent: true, opacity: 0.82 }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(pic.coast + (pic.w - pic.coast + 40) / 2, -0.02, pic.h / 2);
  // Sand on past the patch, under its edge, so the picture has no hole.
  const beyond = new Mesh(
    new PlaneGeometry(pic.coast + 40, pic.h + 40),
    new MeshLambertMaterial({ color: C.sand }),
  );
  beyond.rotation.x = -Math.PI / 2;
  beyond.position.set(pic.coast - (pic.coast + 40) / 2, surfaceY(map, 0.5, 0.5) - 0.01, pic.h / 2);
  const content = new Group();
  content.add(buildLand(map), beyond, water, structures.group);
  const beat = pic.beats[k];
  if (beat.ghost || beat.hints) {
    const overlay = new Overlay();
    const ghost = beat.ghost?.(map) ?? [];
    overlay.setGhosts(
      map,
      ghost,
      ghost.map(() => true),
    );
    overlay.setHints(map, 'tool', beat.hints?.(map) ?? []);
    content.add(overlay.group);
  }
  for (const p of beat.props ?? []) content.add(prop(p, map).root);
  return { content, map };
}

/** Crates of fish on pallets, a pallet of four at a time on each tile in turn, so all of them have some. */
function cells(s: Stock): CellsView {
  const out: CellsView = Array(s.tiles.length * CRATES_PER_STORE_TILE).fill(null);
  for (let i = 0; i < s.n; i++) {
    const tile = Math.floor(i / 4) % s.tiles.length;
    const place = Math.floor(i / (4 * s.tiles.length)) * 4 + (i % 4);
    if (place < CRATES_PER_STORE_TILE)
      out[tile * CRATES_PER_STORE_TILE + place] = { cargo: s.outgoing ? 'canned' : 'fish' };
  }
  return out;
}

/** Where the hand over tile (x, y) is in the picture, in % from its top left. */
function handAt(cam: OrthographicCamera, map: GameMap, x: number, y: number) {
  const v = new Vector3(x + 0.5, surfaceY(map, x + 0.5, y + 0.5), y + 0.5).project(cam);
  return { left: ((v.x + 1) / 2) * 100, top: ((1 - v.y) / 2) * 100 };
}

const cache = new Map<string, Promise<Frame[]>>();
const nextTick = () => new Promise((r) => setTimeout(r, 0));

/** The picture's beats as drawn, a beat at a time so the page stays live meanwhile. */
export function guideFrames(id: PictureId): Promise<Frame[]> {
  let got = cache.get(id);
  if (!got) {
    got = (async () => {
      const pic: Picture = PICTURES[id];
      const [x0, y0, x1, y1] = pic.view;
      const cam = viewOf(new Box3(new Vector3(x0, 0, y0), new Vector3(x1 + 1, 1.4, y1 + 1)), SIZE);
      const frames: Frame[] = [];
      for (let k = 0; k < pic.beats.length; k++) {
        await nextTick();
        const { content, map } = drawn(pic, k);
        const b = pic.beats[k];
        frames.push({
          url: shoot(content, cam, SIZE),
          hand: b.hand && { ...handAt(cam, map, b.hand.x, b.hand.y), down: !!b.hand.down },
          hold: b.hold ?? (k === pic.beats.length - 1 ? LAST : BEAT),
        });
      }
      return frames;
    })();
    got.catch(() => cache.delete(id));
    cache.set(id, got);
  }
  return got;
}
