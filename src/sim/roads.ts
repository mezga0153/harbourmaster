import { EXIT, GATE_IN, GATE_OUT, LIGHTS, NORTH, ONE_WAY, SOUTH } from './orient';
export { EXIT, GATE_IN, GATE_OUT, LIGHTS, NORTH, ONE_WAY, SOUTH } from './orient';
import { landError } from './land';
import type { GameMap } from './map';
import { Build, Deco, Terrain } from './types';

// The rules of the road beyond plain two-way streets: the highway along
// the west edge of the map with its exits, one-way roads, traffic lights
// and one-way port gates. They bind the hauliers' trucks; the port's own
// machines go where they need to inside the port.

/** The highway's two carriageways: southbound down x = 0, northbound up x = 1. */
export const HIGHWAY_COLUMNS = 2;
/** How far apart exits are, at the least, in rows: room to slow down and pull in. */
export const EXIT_SPACING = 6;

export function isHighway(code: number): boolean {
  return code === Build.Highway;
}

/** Roads that can be made one way. */
export function canBeOneWay(code: number): boolean {
  return code === Build.Road || code === Build.PortRoad;
}

export function isExit(map: GameMap, i: number): boolean {
  return map.build[i] === Build.Highway && (map.orient[i] & EXIT) !== 0;
}

export function hasLights(map: GameMap, i: number): boolean {
  return (map.orient[i] & LIGHTS) !== 0 && canBeOneWay(map.build[i]);
}

/** The only way traffic may drive on tile `i` (a facing), or -1 for either way. */
export function oneWay(map: GameMap, i: number): number {
  const b = map.build[i];
  if (b === Build.Highway) return map.orient[i] & 3;
  if (canBeOneWay(b) && map.orient[i] & ONE_WAY) return map.orient[i] & 3;
  return -1;
}

/** The facing of a step from tile `a` to its neighbour `b`. */
export function stepFacing(map: GameMap, a: number, b: number): number {
  const d = b - a;
  return d === 1 ? 0 : d === map.w ? 1 : d === -1 ? 2 : 3;
}

/**
 * Whether trucks may drive from tile `a` onto its neighbour `b`: along the
 * highway only its own way, off or onto it only at an exit, and never
 * against the way of a one-way road (they may turn into or out of one).
 */
export function flowOk(map: GameMap, a: number, b: number): boolean {
  const d = stepFacing(map, a, b);
  const ha = isHighway(map.build[a]);
  const hb = isHighway(map.build[b]);
  if (ha || hb) {
    if (ha && hb) {
      // Along a carriageway its own way, or across the middle at an exit.
      if (d === SOUTH || d === NORTH) return (map.orient[a] & 3) === d && (map.orient[b] & 3) === d;
      return isExit(map, a) && isExit(map, b);
    }
    return isExit(map, ha ? a : b) && (d === 0 || d === 2);
  }
  const fa = oneWay(map, a);
  const fb = oneWay(map, b);
  if (fa >= 0 && d === (fa ^ 2)) return false;
  if (fb >= 0 && d === (fb ^ 2)) return false;
  return true;
}

/** Whether traffic can pass between two neighbouring tiles either way. */
export function linked(map: GameMap, a: number, b: number): boolean {
  return flowOk(map, a, b) || flowOk(map, b, a);
}

/** A port gate trucks may not drive the way from `there` (outside) to `here` (inside) through: */
export function gateBars(map: GameMap, gate: number, inward: boolean): boolean {
  if (map.build[gate] !== Build.Gate) return false;
  return (map.orient[gate] & (inward ? GATE_OUT : GATE_IN)) !== 0;
}

/** Ticks of green each way at a set of traffic lights, then all red to clear the junction. */
export const GREEN_TICKS = 45;
export const CLEAR_TICKS = 10;
export const LIGHT_CYCLE = 2 * (GREEN_TICKS + CLEAR_TICKS);

/**
 * Which way the lights at junction `i` are green at `tick`: 'ns' for traffic
 * going north or south, 'ew' for east or west, null while all are red.
 * Neighbouring sets are out of step, so a queue does not stop at each.
 */
export function greenAt(i: number, tick: number): 'ns' | 'ew' | null {
  const t = (tick + ((i * 37) % LIGHT_CYCLE)) % LIGHT_CYCLE;
  if (t < GREEN_TICKS) return 'ns';
  if (t < GREEN_TICKS + CLEAR_TICKS) return null;
  if (t < 2 * GREEN_TICKS + CLEAR_TICKS) return 'ew';
  return null;
}

/** Lay the highway down the west edge, and an exit at each row in `exits`. */
export function layHighway(map: GameMap, exits: Iterable<number>): void {
  for (let y = 0; y < map.h; y++) {
    for (let x = 0; x < HIGHWAY_COLUMNS; x++) {
      const i = map.idx(x, y);
      map.build[i] = Build.Highway;
      map.orient[i] = x === 0 ? SOUTH : NORTH;
      map.store[i] = 0;
      map.deco[i] = Deco.None;
      if (!map.isLand(i)) {
        // On an embankment.
        map.terrain[i] = Terrain.Grass;
        map.depth[i] = 0;
        map.ocean[i] = 0;
      } else if (map.terrain[i] === Terrain.Rock) map.terrain[i] = Terrain.Grass;
    }
  }
  for (const y of exits) setExit(map, y, true);
}

/** Open or close the highway's barrier at row `y`, for an exit to the road beside it. */
export function setExit(map: GameMap, y: number, on: boolean): void {
  for (let x = 0; x < HIGHWAY_COLUMNS; x++) {
    const i = map.idx(x, y);
    if (map.build[i] !== Build.Highway) continue;
    map.orient[i] = on ? map.orient[i] | EXIT : map.orient[i] & ~(EXIT | LIGHTS);
  }
}

/** The rows of the highway's exits. */
export function exitRows(map: GameMap): number[] {
  const out: number[] = [];
  for (let y = 0; y < map.h; y++) if (isExit(map, map.idx(1, y))) out.push(y);
  return out;
}

export function hasHighway(map: GameMap): boolean {
  return map.h > 0 && map.build[map.idx(0, 0)] === Build.Highway;
}

/**
 * Where trucks come onto the map, at the ends of the highway: down the
 * southbound side from the north, or up the northbound from the south.
 */
export function highwayIns(map: GameMap): { tile: number; dir: number }[] {
  return [
    { tile: map.idx(0, 0), dir: Math.PI / 2 },
    { tile: map.idx(1, map.h - 1), dir: -Math.PI / 2 },
  ];
}

/** Where trucks leave the map, at the far ends of the highway. */
export function highwayOuts(map: GameMap): number[] {
  return [map.idx(0, map.h - 1), map.idx(1, 0)];
}

/** Of the highway's ends `ends`, the one nearest row `y`, so trucks take the shorter way. */
export function nearestEnd(map: GameMap, ends: number[], y: number): number {
  let best = ends[0];
  for (const e of ends) if (Math.abs(map.yOf(e) - y) < Math.abs(map.yOf(best) - y)) best = e;
  return best;
}

/** Why an exit cannot be opened from the highway at row `y`, or null if it can. */
export function exitError(map: GameMap, y: number): string | null {
  if (!hasHighway(map)) return 'There is no highway here';
  if (y < 2 || y > map.h - 3) return 'Too near the end of the map for an exit';
  if (isExit(map, map.idx(1, y))) return 'There is an exit here already';
  for (const r of exitRows(map)) {
    if (Math.abs(r - y) < EXIT_SPACING)
      return `Exits must be at least ${EXIT_SPACING} tiles apart along the highway`;
  }
  const beside = map.idx(HIGHWAY_COLUMNS, y);
  // The town opens its own exits past the port's land.
  const land = map.buildable(beside) ? landError(map, beside) : null;
  if (land) return land;
  const b = map.build[beside];
  if (b === Build.Road) return null;
  if (b !== Build.None) return 'Clear the tile beside the highway for the road off it';
  if (!map.isLand(beside) || map.terrain[beside] === Terrain.Rock)
    return 'The road off it needs clear land beside the highway';
  return null;
}

type Point = readonly [number, number];

/** Screen right of heading `h` on the map, keeping right as trucks do. */
const rightOf = (h: Point): Point => [-h[1], h[0]];

/**
 * The way a vehicle drives across a junction tile, keeping right `lane`
 * off the middle of the road: in heading `h`, out heading `e`, as a line
 * of points about the tile's centre. Straight on along its lane; a turn
 * by the corner where its lane in meets its lane out; turning about, across
 * to the other side.
 */
export function laneLine(h: Point, e: Point, lane: number): Point[] {
  const rh = rightOf(h);
  const re = rightOf(e);
  const a: Point = [-h[0] * 0.5 + rh[0] * lane, -h[1] * 0.5 + rh[1] * lane];
  const b: Point = [e[0] * 0.5 + re[0] * lane, e[1] * 0.5 + re[1] * lane];
  const dot = h[0] * e[0] + h[1] * e[1];
  if (dot > 0.5) return [a, b];
  if (dot < -0.5) return [a, [rh[0] * lane, rh[1] * lane], [re[0] * lane, re[1] * lane], b];
  return [a, [(rh[0] + re[0]) * lane, (rh[1] + re[1]) * lane], b];
}

/** Whether segments p1–p2 and q1–q2 meet, touching or running along each other included. */
function segmentsMeet(p1: Point, p2: Point, q1: Point, q2: Point): boolean {
  const eps = 1e-6;
  const cross = (o: Point, a: Point, b: Point) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const on = (o: Point, a: Point, b: Point) =>
    Math.min(o[0], a[0]) - eps <= b[0] &&
    b[0] <= Math.max(o[0], a[0]) + eps &&
    Math.min(o[1], a[1]) - eps <= b[1] &&
    b[1] <= Math.max(o[1], a[1]) + eps;
  const d1 = cross(q1, q2, p1);
  const d2 = cross(q1, q2, p2);
  const d3 = cross(p1, p2, q1);
  const d4 = cross(p1, p2, q2);
  if (
    ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) &&
    ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))
  )
    return true;
  return (
    (Math.abs(d1) <= eps && on(q1, q2, p1)) ||
    (Math.abs(d2) <= eps && on(q1, q2, p2)) ||
    (Math.abs(d3) <= eps && on(p1, p2, q1)) ||
    (Math.abs(d4) <= eps && on(p1, p2, q2))
  );
}

/**
 * Whether two ways across a junction (see laneLine) meet: crossing, or
 * coming together onto the same lane out. Two turning off in opposite
 * lanes, as one leaves a roundabout and another comes onto it there, or
 * one turns into a side road and another out of it, never do.
 */
export function waysMeet(a: readonly Point[], b: readonly Point[]): boolean {
  for (let i = 0; i + 1 < a.length; i++) {
    for (let j = 0; j + 1 < b.length; j++) {
      if (segmentsMeet(a[i], a[i + 1], b[j], b[j + 1])) return true;
    }
  }
  return false;
}

/** What is left of way `w` (see laneLine) from the point on it nearest `p`, less `back` behind that. */
export function wayFrom(w: readonly Point[], p: Point, back: number): Point[] {
  let best = 0;
  let bestD = Infinity;
  let s = 0;
  for (let k = 0; k + 1 < w.length; k++) {
    const [ax, ay] = w[k];
    const [bx, by] = w[k + 1];
    const len = Math.hypot(bx - ax, by - ay);
    const t =
      len > 0
        ? Math.max(
            0,
            Math.min(1, ((p[0] - ax) * (bx - ax) + (p[1] - ay) * (by - ay)) / (len * len)),
          )
        : 0;
    const d = Math.hypot(ax + (bx - ax) * t - p[0], ay + (by - ay) * t - p[1]);
    if (d < bestD) {
      bestD = d;
      best = s + t * len;
    }
    s += len;
  }
  // Walk to the point `back` short of the nearest one, then keep the rest.
  const start = Math.max(0, best - back);
  const out: Point[] = [];
  s = 0;
  for (let k = 0; k + 1 < w.length; k++) {
    const [ax, ay] = w[k];
    const [bx, by] = w[k + 1];
    const len = Math.hypot(bx - ax, by - ay);
    if (out.length === 0 && s + len >= start) {
      const t = len > 0 ? (start - s) / len : 0;
      out.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
    }
    if (out.length > 0) out.push(w[k + 1]);
    s += len;
  }
  return out.length >= 2 ? out : w.slice(-2);
}
