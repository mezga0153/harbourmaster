// Bulk cargo on its way through the port, a tick at a time: grab cranes
// lift it out of the bulk carriers' holds into their hoppers, conveyor
// belts carry it a tile at a time the way they face, stockpiles heap it up
// and give it back to belts running away from them, and rail loadouts pour
// it into the hopper wagons of the train standing under them. What lies
// where is in World.bulk, by tile; see bulk.ts.

import type { World } from '../world';
import * as B from '../balance';
import type { BulkKind, BulkLoad } from '../bulk';
import type { Boat } from '../state';
import { Build } from '../types';
import { FACING } from '../rules/footprint';
import { boatHalf, mooredTiles } from './boats/berthing';
import { book, payout } from './economy';
import { CAR_LENGTH, pointAt, type Train } from '../railway';
import { sidingAt } from '../rules/rails';

/** Tonnes lying on tile `i`, of what. */
export function loadAt(w: World, i: number): BulkLoad | undefined {
  return w.bulk.get(i);
}

/** How many tonnes tile `i` holds at most: a belt's, a hopper's, a bin's or a stockpile tile's. */
export function capOf(w: World, i: number): number {
  switch (w.map.build[i]) {
    case Build.Belt:
      return B.BELT_CAP;
    case Build.GrabCrane:
      return B.HOPPER_CAP;
    case Build.Loadout:
      return B.LOADOUT_CAP;
    case Build.Stockpile:
      return B.STOCKPILE_TILE;
    default:
      return 0;
  }
}

/** Put up to `t` tonnes of `kind` on tile `i`; returns how many went on. */
function put(w: World, i: number, kind: BulkKind, t: number): number {
  const at = w.bulk.get(i);
  if (at && at.kind !== kind && at.t > 1e-6) return 0;
  const room = capOf(w, i) - (at?.t ?? 0);
  const n = Math.max(0, Math.min(room, t));
  if (n <= 0) return 0;
  w.bulk.set(i, { kind, t: (at && at.kind === kind ? at.t : 0) + n });
  return n;
}

/** Take up to `t` tonnes off tile `i`; returns how many came off. */
function take(w: World, i: number, t: number): number {
  const at = w.bulk.get(i);
  if (!at) return 0;
  const n = Math.min(at.t, t);
  at.t -= n;
  if (at.t <= 1e-6) w.bulk.delete(i);
  return n;
}

/** The way a belt runs, as a step. */
function ahead(w: World, i: number): number {
  const [dx, dy] = FACING[w.map.orient[i] & 3];
  const m = w.map;
  const x = m.xOf(i) + dx;
  const y = m.yOf(i) + dy;
  return m.inBounds(x, y) ? m.idx(x, y) : -1;
}

/** The tile a belt runs away from: where it takes its load from, if that gives any. */
function behind(w: World, i: number): number {
  const [dx, dy] = FACING[w.map.orient[i] & 3];
  const m = w.map;
  const x = m.xOf(i) - dx;
  const y = m.yOf(i) - dy;
  return m.inBounds(x, y) ? m.idx(x, y) : -1;
}

/** A stockpile's tiles: those that touch, one heap. */
export function stockpileArea(w: World, i: number): number[] {
  const m = w.map;
  if (m.build[i] !== Build.Stockpile) return [];
  const seen = new Set([i]);
  const queue = [i];
  while (queue.length > 0) {
    const t = queue.pop()!;
    for (const n of m.neighbors4(t)) {
      if (seen.has(n) || m.build[n] !== Build.Stockpile) continue;
      seen.add(n);
      queue.push(n);
    }
  }
  return [...seen];
}

/** What kind a stockpile holds, if anything. */
function pileKind(w: World, area: number[]): BulkKind | undefined {
  for (const t of area) {
    const at = w.bulk.get(t);
    if (at && at.t > 1e-6) return at.kind;
  }
  return undefined;
}

/** Heap tonnes on a stockpile at tile `i`, spreading over its other tiles as that fills; returns how many. */
function heap(w: World, i: number, kind: BulkKind, t: number): number {
  const area = stockpileArea(w, i);
  const holds = pileKind(w, area);
  if (holds && holds !== kind) return 0;
  let left = t - put(w, i, kind, t);
  for (const k of area) {
    if (left <= 0) break;
    left -= put(w, k, kind, left);
  }
  return t - left;
}

/** Take tonnes off a stockpile, from tile `i` first, then the rest of it. */
function reclaim(w: World, i: number, t: number): { kind: BulkKind; t: number } | null {
  const area = stockpileArea(w, i);
  const kind = pileKind(w, area);
  if (!kind) return null;
  let got = take(w, i, t);
  for (const k of area) {
    if (got >= t) break;
    got += take(w, k, t - got);
  }
  return { kind, t: got };
}

/** Hand tonnes on to tile `to` as a belt does: onto a belt, a stockpile or a loadout's bin. */
function handOn(w: World, to: number, kind: BulkKind, t: number): number {
  switch (w.map.build[to]) {
    case Build.Belt:
    case Build.Loadout:
      return put(w, to, kind, t);
    case Build.Stockpile:
      return heap(w, to, kind, t);
    default:
      return 0;
  }
}

/** The bulk carrier lying alongside a grab crane, if one is, with cargo still in its holds. */
export function grabShip(w: World, g: number): Boat | undefined {
  const m = w.map;
  return w.boats.find((b) => {
    if (b.state !== 'moored' || !b.bulk || b.crates <= 0) return false;
    const hull = mooredTiles(w, b.berth, b.jetty, boatHalf(w, true)) ?? [b.berth];
    return hull.some((h) => m.neighbors4(h).includes(g));
  });
}

/** A grab crane: a bite at a time out of the holds into its hopper, while the hopper has room. */
function runGrab(w: World, g: number): void {
  const ship = grabShip(w, g);
  const state = w.grabs.get(g) ?? { timer: 0 };
  w.grabs.set(g, state);
  const kind = ship?.bulk;
  const hopper = w.bulk.get(g);
  const room = B.HOPPER_CAP - (hopper?.t ?? 0);
  if (!ship || !kind || room < B.GRAB_BITE || (hopper && hopper.kind !== kind)) {
    state.timer = 0;
    state.busy = false;
    return;
  }
  state.busy = true;
  if (++state.timer < B.GRAB_TICKS) return;
  state.timer = 0;
  const bite = Math.min(B.GRAB_BITE, ship.crates);
  ship.crates -= bite;
  put(w, g, kind, bite);
  // The line pays by the tonne as it is landed.
  const income = payout(w, bite * ship.fee);
  book(w, 'bulk', income);
  w.stats.earned += income;
}

/** The grab cranes', belts' and loadouts' tiles, as the map stands. */
function bulkTiles(w: World): { grabs: number[]; belts: number[]; loadouts: number[] } {
  if (w.bulkCache) return w.bulkCache;
  const out = { grabs: [] as number[], belts: [] as number[], loadouts: [] as number[] };
  w.map.build.forEach((b, i) => {
    if (b === Build.GrabCrane) out.grabs.push(i);
    else if (b === Build.Belt) out.belts.push(i);
    else if (b === Build.Loadout) out.loadouts.push(i);
  });
  return (w.bulkCache = out);
}

/** A tick of bulk cargo moving through the port. */
export function stepBulk(w: World): void {
  const m = w.map;
  const { grabs, belts } = bulkTiles(w);
  if (grabs.length === 0 && belts.length === 0 && w.bulk.size === 0) return;
  for (const g of grabs) runGrab(w, g);
  // Each belt hands on what it carried at the start of the tick, at most
  // its rate, so a tonne goes on a tile a tick, however the belts are laid.
  const moves: [number, number, BulkKind, number][] = [];
  for (const i of belts) {
    const at = w.bulk.get(i);
    if (at) moves.push([i, ahead(w, i), at.kind, Math.min(at.t, B.BELT_RATE)]);
  }
  for (const [from, to, kind, t] of moves) {
    if (to < 0) continue;
    const n = handOn(w, to, kind, t);
    if (n > 0) take(w, from, n);
  }
  // Belts take on from a grab crane's hopper or a stockpile they start
  // beside, the one behind them first: any they do not run into.
  for (const i of belts) {
    const to = ahead(w, i);
    const back = behind(w, i);
    const from = [back, ...m.neighbors4(i).filter((n) => n !== back)].filter(
      (n) =>
        n >= 0 &&
        n !== to &&
        (m.build[n] === Build.GrabCrane || m.build[n] === Build.Stockpile) &&
        // Not one that this belt's own run fills, onto a stockpile along it.
        !(m.build[n] === Build.Stockpile && m.build[to] === Build.Stockpile),
    );
    for (const n of from) {
      const at = w.bulk.get(i);
      const room = Math.min(B.BELT_RATE, B.BELT_CAP - (at?.t ?? 0));
      if (room <= 1e-6) break;
      if (m.build[n] === Build.GrabCrane) {
        const hop = w.bulk.get(n);
        if (!hop || (at && at.kind !== hop.kind)) continue;
        take(w, n, put(w, i, hop.kind, Math.min(room, hop.t)));
      } else {
        const kind = pileKind(w, stockpileArea(w, n));
        if (!kind || (at && at.kind !== kind)) continue;
        const got = reclaim(w, n, room);
        if (got) put(w, i, got.kind, got.t);
      }
    }
  }
  runLoadouts(w);
}

/** The port train of hopper wagons standing under a loadout, if one is. */
export function trainUnder(w: World, i: number): Train | undefined {
  const s = sidingAt(w.map, i);
  if (!s) return undefined;
  return w.rail.trains.find(
    (t) => t.port?.switch === s.switch && t.port.state === 'standing' && !!t.port.hoppers,
  );
}

/** Where wagon `k` (from the locomotive, 0 the first) of a standing train is. */
export function hopperPoint(t: Train, k: number): { x: number; y: number } {
  return pointAt(t.way, t.at - (k + 1.5) * CAR_LENGTH);
}

/** Loadouts pour their bins into the wagons of the train under them, the first not full first. */
function runLoadouts(w: World): void {
  for (const i of bulkTiles(w).loadouts) {
    const bin = w.bulk.get(i);
    const t = bin && trainUnder(w, i);
    if (!bin || !t?.port?.hoppers) continue;
    if (t.port.bulk && t.port.bulk !== bin.kind) continue;
    const k = t.port.hoppers.findIndex((h) => h < B.HOPPER_WAGON - 1e-6);
    if (k < 0) continue;
    const n = Math.min(B.LOADOUT_RATE, bin.t, B.HOPPER_WAGON - t.port.hoppers[k]);
    t.port.hoppers[k] += take(w, i, n);
  }
}

/** A train of hopper wagons is full. */
export function hoppersFull(t: Train): boolean {
  return !!t.port?.hoppers && t.port.hoppers.every((h) => h >= B.HOPPER_WAGON - 1e-6);
}
