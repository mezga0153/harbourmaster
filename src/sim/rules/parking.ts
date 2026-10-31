// Truck parking lots: their spaces, which way trucks turn in and out, and what is wrong with a lot.

import { PARK_FLIP, PARK_MIRROR } from '../orient';
import * as B from '../balance';
import type { GameMap } from '../map';
import { Build, isPublicRoad } from '../types';
import { forkliftOnly } from './marking';
import { nearCrane } from './placement';

/**
 * A parking space: the tiles across the lot a truck stands on, diagonally,
 * from the road on one side to the road on the other, and those two road
 * tiles. Trucks drive in from one road and out onto the other, only ever
 * forwards.
 */
export interface ParkingSpace {
  tiles: number[];
  ends: [number, number];
  /**
   * Whether a truck can turn into it off the road on the lot's in side,
   * coming the way it runs, and out onto the road on its out side, going on
   * that way: see ParkingLot.flow.
   */
  ok: boolean;
}

/**
 * Which way trucks go through a lot of angled parking, for the angle the
 * spaces lean at: in off the road on `ends[in]` of each space, driving
 * along it `along`, and out onto the road on the other side, going on the
 * same way. The spaces lean the way between `along` and across the lot.
 */
export interface ParkingFlow {
  in: 0 | 1;
  along: [number, number];
  across: [number, number];
}

/** A run of truck parking, and why it is no use, if it is not. */
export interface ParkingLot {
  tiles: number[];
  spaces: ParkingSpace[];
  /** Joined to public roads, outside the port; else to port roads, inside. */
  outside: boolean;
  /** Two tiles wide, with room for the big trucks. */
  wide: boolean;
  why: string | null;
  /** Which way trucks drive through it, once laid out right. */
  flow: ParkingFlow | null;
}

/**
 * Parking lots: each run of parking tiles, which must be a strip one or two
 * tiles wide with a road all along both its long sides, both public roads
 * (outside the port) or both port roads (inside), for trucks to drive
 * across it into a space and out again on the far side.
 */
export function parkingLots(map: GameMap): ParkingLot[] {
  const lots: ParkingLot[] = [];
  const seen = new Uint8Array(map.build.length);
  const roadKind = (i: number): 'road' | 'port' | null => {
    if (i < 0) return null;
    const b = map.build[i];
    if (isPublicRoad(b) && b !== Build.Crossing) return 'road';
    const port = b === Build.PortRoad || b === Build.Quay || b === Build.YardGantry;
    return port && !forkliftOnly(map, i) && !map.store[i] && !nearCrane(map, i) ? 'port' : null;
  };
  for (let i = 0; i < map.build.length; i++) {
    if (seen[i] || map.build[i] !== Build.Parking) continue;
    const tiles: number[] = [];
    const stack = [i];
    seen[i] = 1;
    while (stack.length > 0) {
      const t = stack.pop()!;
      tiles.push(t);
      for (const n of map.neighbors4(t)) {
        if (seen[n] || map.build[n] !== Build.Parking) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    tiles.sort((a, b) => a - b);
    const xs = tiles.map((t) => map.xOf(t));
    const ys = tiles.map((t) => map.yOf(t));
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    const w = Math.max(...xs) - x0 + 1;
    const h = Math.max(...ys) - y0 + 1;
    const lot: ParkingLot = {
      tiles,
      spaces: [],
      outside: false,
      wide: false,
      why: null,
      flow: null,
    };
    lots.push(lot);
    if (tiles.length !== w * h || Math.min(w, h) > 2) {
      lot.why = 'Parking is a straight strip, one or two tiles wide';
      continue;
    }
    // Across the short way, the spaces side by side along the long way; a
    // square lot may go either way round.
    const ways: boolean[] = [];
    if (h <= 2 && (h <= w || w > 2)) ways.push(true);
    if (w <= 2) ways.push(false);
    let why: string | null = null;
    for (const acrossY of ways) {
      const along = acrossY ? w : h;
      const across = acrossY ? h : w;
      const at = (a: number, c: number) =>
        acrossY ? map.idx(x0 + a, y0 + c) : map.idx(x0 + c, y0 + a);
      const off = (a: number, c: number) => {
        const x = acrossY ? x0 + a : x0 + c;
        const y = acrossY ? y0 + c : y0 + a;
        return map.inBounds(x, y) ? map.idx(x, y) : -1;
      };
      const spaces: ParkingSpace[] = [];
      const kinds = new Set<string | null>();
      for (let a = 0; a < along; a++) {
        const span = Array.from({ length: across }, (_, c) => at(a, c));
        const ends: [number, number] = [off(a, -1), off(a, across)];
        kinds.add(roadKind(ends[0]));
        kinds.add(roadKind(ends[1]));
        spaces.push({ tiles: span, ends, ok: false });
      }
      if (kinds.has(null)) {
        why ??=
          'Parking needs a road all along both its long sides, to drive in on one and out on the other';
        continue;
      }
      if (kinds.size > 1) {
        why ??=
          'A public road on one side and a port road on the other: trucks would get into the port without a gate';
        continue;
      }
      lot.spaces = spaces;
      lot.outside = kinds.has('road');
      lot.wide = across === 2;
      lot.flow = parkingFlow(map, tiles, acrossY);
      // Each space is turned into off the road coming the way the lot runs,
      // from along the road or straight at it, and out onto the far road
      // going on that way: never round a hairpin.
      const { in: k, along: f, across: c } = lot.flow;
      const kind = roadKind(spaces[0].ends[0]);
      const step = (i: number, dx: number, dy: number) => {
        const x = map.xOf(i) + dx;
        const y = map.yOf(i) + dy;
        return map.inBounds(x, y) ? map.idx(x, y) : -1;
      };
      for (const s of spaces) {
        const e = s.ends[k];
        const o = s.ends[1 - k];
        const into = [step(e, -f[0], -f[1]), step(e, -c[0], -c[1])];
        const onto = [step(o, f[0], f[1]), step(o, c[0], c[1])];
        s.ok = into.some((t) => roadKind(t) === kind) && onto.some((t) => roadKind(t) === kind);
      }
      why = spaces.some((s) => s.ok)
        ? null
        : 'Trucks drive through it the way its arrows show, turning in off the road and on again: carry the roads on past its ends';
      break;
    }
    lot.why = why;
  }
  return lots;
}

/**
 * Which way trucks go through a lot of parking across `acrossY` (or across
 * x): in off whichever side road has the lot on its right, keeping right,
 * so trucks turn in without crossing the traffic coming the other way, and
 * out the other side. Flipped (PARK_FLIP on its tiles), in off the other.
 */
export function parkingFlow(map: GameMap, tiles: number[], acrossY: boolean): ParkingFlow {
  const flipped = tiles.some((t) => map.orient[t] & PARK_FLIP);
  const mirrored = tiles.some((t) => map.orient[t] & PARK_MIRROR);
  return flowFor(acrossY, flipped, mirrored);
}

/**
 * The next way round for a lot of parking, as the one-way tool turns it,
 * a step at a time: turned round, then leaning the other way, then turned
 * round again, then back as it was. Its PARK_FLIP and PARK_MIRROR bits.
 */
export function nextParkWay(map: GameMap, tiles: number[]): number {
  const flip = tiles.some((t) => map.orient[t] & PARK_FLIP);
  const mirror = tiles.some((t) => map.orient[t] & PARK_MIRROR);
  const [f, mi] = !mirror
    ? flip
      ? [true, true]
      : [true, false]
    : flip
      ? [false, true]
      : [false, false];
  return (f ? PARK_FLIP : 0) | (mi ? PARK_MIRROR : 0);
}

/**
 * Which way trucks go through a lot of parking across `acrossY` (or
 * across x): in off the low side road, or (`flipped`) the high one;
 * turning in with the lot on their right, or (`mirrored`) on their left.
 */
export function flowFor(acrossY: boolean, flipped: boolean, mirrored: boolean): ParkingFlow {
  const k: 0 | 1 = flipped ? 1 : 0;
  // From the side road on `ends[0]` (the low side) into the lot, or back.
  const base: [number, number] = acrossY ? [0, 1] : [1, 0];
  const across: [number, number] = k === 0 ? base : [-base[0], -base[1]];
  // Driving `along` the road, the lot is on the right: the way whose right
  // is `across`; mirrored, on the left, the other way.
  const along: [number, number] = mirrored ? [-across[1], across[0]] : [across[1], -across[0]];
  return { in: k, along, across };
}

/** Whether a truck needs a space two tiles wide: the big trucks, and those with two containers. */
export function needsWideSpace(capacity: number, boxes: boolean): boolean {
  return boxes ? capacity > 1 : capacity > B.TRUCK_CAPACITY;
}
