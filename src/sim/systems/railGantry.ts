// Rail gantries: cranes on rails along the loading track of a siding,
// spanning the track and the rows of container yards either side of it.
// While a container train stands on the track each runs along to a wagon
// and lifts containers between the wagons and the yards under it: what the
// train brought off into a yard for cargo going out, then what it takes on
// from a yard for cargo coming in, cleared by customs. Two or more on one
// track never pass: each lifts only what it can get at clear of the others,
// makes way when it has nothing to lift, and moves a container along the
// yard for another to take on when that one cannot reach it.

import type { World } from '../world';
import * as B from '../balance';
import type { Bay, Crate, Dockhand } from '../state';
import type { RailGantry, RailLift, Spot, Train } from '../railway';
import type { RailGantryView } from '../../protocol/views';
import {
  isLoading,
  isTrack,
  loadingTrack,
  longestTrack,
  sidingAt,
  sidings,
  type Siding,
} from '../rules/rails';
import { Build } from '../types';
import { RAILS } from '../orient';
import { trainWagons } from '../contracts';
import { yardPlace } from '../helpers';
import { aboard, cellPoint, stillWants, wagonCells, yardsBeside } from './cargo/wagons';
import {
  boxLooks,
  carriedLooks,
  clearTop,
  exportLooks,
  isClear,
  nextYardSlot,
  putBox,
  takeBox,
  takesExports,
  takesImports,
  readyList,
  yardCells,
  yardSlots,
  yardTop,
} from './cargo/stores';
import { trainAt } from './trains';
import { bayIncoming } from '../helpers';
import { drivable } from '../rules/placement';
import { customsFor } from './cranes';
import { tip } from './output';

type PortTrain = Train & { port: NonNullable<Train['port']> };

/** The rail gantries over the port's loading track. */
export function railGantries(w: World): RailGantry[] {
  return (w.rail.gantries ??= []);
}

/** A rail gantry put up on loading track `i`: it stands over the middle of the tile. */
export function addRailGantry(w: World, i: number): void {
  const m = w.map;
  if (railGantries(w).some((g) => g.idx === i)) return;
  railGantries(w).push({ idx: i, at: { x: m.xOf(i) + 0.5, y: m.yOf(i) + 0.5 } });
}

/** A rail gantry taken down: anything on its spreader goes where it was going. */
export function removeRailGantry(w: World, i: number): void {
  const list = railGantries(w);
  const k = list.findIndex((g) => g.idx === i);
  if (k < 0) return;
  if (list[k].lift) endLift(w, list[k]);
  list.splice(k, 1);
}

/** The rail gantries over a siding's loading track, in order along it. */
export function gantriesOn(w: World, s: Siding): RailGantry[] {
  const on = new Set(s.tiles);
  return railGantries(w)
    .filter((g) => on.has(g.idx))
    .sort((a, b) => w.map.xOf(a.idx) - w.map.xOf(b.idx));
}

/**
 * The container yards a siding's gantries span, each with the places in
 * its tiles (by their place in the yard's tiles) under them: along the
 * loading track, up to SIDING_REACH rows either side of it.
 */
export function gantryYards(w: World, s: Siding): Map<Bay, Set<number>> {
  const m = w.map;
  const xs = new Set(loadingTrack(m, s).map((t) => m.xOf(t)));
  const row = m.yOf(s.switch);
  const out = new Map<Bay, Set<number>>();
  for (const yard of yardsBeside(w, s)) {
    const reach = new Set<number>();
    (yard.tiles ?? [yard.idx]).forEach((t, n) => {
      if (Math.abs(m.yOf(t) - row) <= B.SIDING_REACH && xs.has(m.xOf(t))) reach.add(n);
    });
    if (reach.size > 0) out.set(yard, reach);
  }
  return out;
}

/** A container train standing on a siding's loading track to be worked. */
function standingAt(w: World, s: Siding): PortTrain | undefined {
  const t = trainAt(w, s.switch);
  const v = t?.port;
  if (!v || v.state !== 'standing' || v.contractId === undefined || v.hoppers) return undefined;
  return t as PortTrain;
}

/** Where the place `slot` of a yard is on the map: the middle of its tile. */
function slotSpot(w: World, yard: Bay, slot: number): Spot {
  const tile = (yard.tiles ?? [yard.idx])[yardPlace(slot).tile] ?? yard.idx;
  return { x: w.map.xOf(tile) + 0.5, y: w.map.yOf(tile) + 0.5 };
}

/** Ticks for a lift: running to `from`, taking it up, carrying it to `to`, setting it down. */
function legsOf(at: Spot, from: Spot, to: Spot): RailLift['legs'] {
  const run = (a: Spot, b: Spot) =>
    Math.round(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) / B.RAIL_GANTRY_SPEED);
  const up = Math.floor(B.RAIL_GANTRY_TICKS / 2);
  return [run(at, from), up, run(from, to), B.RAIL_GANTRY_TICKS - up];
}

/** Ticks into a lift its spreader has the container up, and the whole lift. */
export function liftMarks(l: RailLift): { taken: number; done: number } {
  const [run, up, carry, down] = l.legs;
  return { taken: run + Math.ceil(up / 2), done: run + up + carry + down };
}

/** A tick of the rail gantries: each carries on with its lift, or starts the next. */
export function stepRailGantries(w: World): void {
  for (const g of [...railGantries(w)]) {
    if (!isLoading(w.map, g.idx)) {
      removeRailGantry(w, g.idx);
      continue;
    }
    if (g.lift) runLift(w, g);
    else startLift(w, g);
  }
}

/** Tiles kept between the spreaders of two gantries on one loading track. */
const GANTRY_GAP = 1.2;

/** Whether a gantry running over `xs` along the track keeps clear of the others on it. */
function clearOfOthers(w: World, s: Siding, g: RailGantry, xs: number[]): boolean {
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  return gantriesOn(w, s).every((o) => {
    if (o === g) return true;
    const os = o.lift ? [o.at.x, o.lift.from.x, o.lift.to.x] : [o.at.x];
    return lo >= Math.max(...os) + GANTRY_GAP || hi <= Math.min(...os) - GANTRY_GAP;
  });
}

/**
 * A gantry's next lift, or none for it now: off the train first, into a
 * yard for cargo going out; then onto it, a container customs have
 * cleared, on top of its stack in a yard for cargo coming in. Of those it
 * can get at without coming near another gantry on the track (they never
 * pass), the quickest. With none, it makes way: see park.
 */
function startLift(w: World, g: RailGantry): void {
  const s = sidingAt(w.map, g.idx);
  const t = s && standingAt(w, s);
  // The tractors first: the ships wait on them.
  const lift = s ? (tractorLift(w, s, g) ?? (t ? nextLift(w, s, g, t) : null)) : null;
  if (!lift || !s) return park(w, g, s);
  if (lift.tractor !== undefined || !t) {
    // For a tractor: nothing kept on the train.
  } else if (lift.relay) {
    // Saved its place, for none else to take meanwhile.
  } else if (lift.load) t.port.coming = (t.port.coming ?? 0) + 1;
  else t.port.taking = (t.port.taking ?? 0) + 1;
  g.lift = lift;
}

function nextLift(w: World, s: Siding, g: RailGantry, t: PortTrain): RailLift | null {
  const yards = gantryYards(w, s);
  const cells = wagonCells(t);
  let best: RailLift | null = null;
  let quickest = Infinity;
  const consider = (
    load: boolean,
    from: Spot,
    to: Spot,
    cell: number,
    yard: Bay,
    slot: number,
    look: number,
  ) => {
    const legs = legsOf(g.at, from, to);
    const ticks = legs[0] + legs[2];
    if (ticks >= quickest || !clearOfOthers(w, s, g, [g.at.x, from.x, to.x])) return;
    quickest = ticks;
    best = { start: w.tick, legs, from, to, load, train: t.id, cell, yard: yard.idx, slot, look };
  };
  if (aboard(t, true) - (t.port.taking ?? 0) > 0) {
    // Each place a container may be set down, a stack at a time.
    const places: { yard: Bay; slot: number; to: Spot }[] = [];
    for (const [yard, reach] of yards) {
      if (!takesExports(w, yard)) continue;
      for (const n of reach) {
        const slot = nextYardSlot(w, yard, undefined, new Set([n]));
        if (slot >= 0) places.push({ yard, slot, to: slotSpot(w, yard, slot) });
      }
    }
    cells.forEach((c, k) => {
      if (!c?.out) return;
      const from = { ...cellPoint(t, k) };
      for (const p of places) consider(false, from, p.to, k, p.yard, p.slot, c.look ?? 0);
    });
    if (best) return best;
  }
  if (stillWants(t) <= 0) return null;
  const free = cells.map((_, k) => k).filter((k) => !cells[k]);
  for (const [yard, reach] of yards) {
    if (!takesImports(w, yard)) continue;
    const slots = yardSlots(w, yard).boxes;
    const looks = boxLooks(w, yard);
    for (const n of reach) {
      const at = clearTop(w, yard, new Set([n]));
      if (at < 0) continue;
      const from = slotSpot(w, yard, slots[at]);
      for (const k of free)
        consider(true, from, { ...cellPoint(t, k) }, k, yard, slots[at], looks[at]);
    }
  }
  return best ?? relay(w, s, g, t, free);
}

/**
 * Gantries on one track never pass, so a container near one end of the
 * yard may be out of reach of the gantry that can get at the wagons with
 * room left near the other: with nothing else to lift, a gantry moves one
 * it can get at along the yard towards them, a tile nearer at least, for
 * the other to take on.
 */
function relay(w: World, s: Siding, g: RailGantry, t: PortTrain, free: number[]): RailLift | null {
  if (free.length === 0) return null;
  const xs = free.map((k) => cellPoint(t, k).x);
  const far = (x: number) => Math.min(...xs.map((c) => Math.abs(c - x)));
  const yards = [...gantryYards(w, s)].filter(([y]) => takesImports(w, y));
  let best: RailLift | null = null;
  let gain = 1;
  for (const [yard, reach] of yards) {
    const slots = yardSlots(w, yard).boxes;
    const looks = boxLooks(w, yard);
    const ready = readyList(w, yard);
    for (const n of reach) {
      const at = clearTop(w, yard, new Set([n]));
      if (at < 0) continue;
      const from = slotSpot(w, yard, slots[at]);
      for (const [into, room] of yards) {
        for (const r of room) {
          const slot = nextYardSlot(w, into, ready[at], new Set([r]));
          if (slot < 0) continue;
          const to = slotSpot(w, into, slot);
          const better = far(from.x) - far(to.x);
          if (better < gain || !clearOfOthers(w, s, g, [g.at.x, from.x, to.x])) continue;
          gain = better;
          best = {
            start: w.tick,
            legs: legsOf(g.at, from, to),
            from,
            to,
            load: true,
            relay: { yard: into.idx, slot },
            train: t.id,
            cell: -1,
            yard: yard.idx,
            slot: slots[at],
            look: looks[at],
          };
        }
      }
    }
  }
  return best;
}

/**
 * With nothing it can lift, a gantry makes way for the others on its
 * track: the first along it runs back to that end, the last to the other,
 * any between to where it was put up.
 */
function park(w: World, g: RailGantry, s: Siding | null | undefined): void {
  const m = w.map;
  const on = s ? gantriesOn(w, s) : [g];
  const xs = s ? loadingTrack(m, s).map((t) => m.xOf(t)) : [];
  const k = on.indexOf(g);
  const x =
    on.length > 1 && k === 0
      ? Math.min(...xs) + 0.5
      : on.length > 1 && k === on.length - 1
        ? Math.max(...xs) + 0.5
        : m.xOf(g.idx) + 0.5;
  const home = { x, y: m.yOf(g.idx) + 0.5 };
  const step = (a: number, b: number) =>
    Math.abs(b - a) <= B.RAIL_GANTRY_SPEED ? b : a + Math.sign(b - a) * B.RAIL_GANTRY_SPEED;
  if (g.at.x === home.x && g.at.y === home.y) return;
  g.at = { x: step(g.at.x, home.x), y: step(g.at.y, home.y) };
}

/** The train a lift is for, while it still stands to be worked. */
function liftTrain(w: World, l: RailLift): PortTrain | undefined {
  const t = w.rail.trains.find((q) => q.id === l.train);
  return t?.port?.state === 'standing' ? (t as PortTrain) : undefined;
}

/** A gantry part way through a lift: it takes the container up half way, and sets it down at the end. */
function runLift(w: World, g: RailGantry): void {
  const l = g.lift!;
  if (l.tractor !== undefined) return runTractorLift(w, g);
  const t = liftTrain(w, l);
  if (!t) return endLift(w, g);
  const yard = w.yards.get(l.yard);
  const { taken, done } = liftMarks(l);
  const since = w.tick - l.start;
  if (!l.box && since >= taken) {
    const cells = wagonCells(t);
    if (l.load) {
      // The one it went for, else any cleared on top in reach.
      if (yard) {
        const looks = boxLooks(w, yard);
        const was = looks.indexOf(l.look);
        const s = sidingAt(w.map, g.idx);
        const reach = s ? gantryYards(w, s).get(yard) : undefined;
        const ready = readyList(w, yard);
        const same = yardTop(w, yard, false, (i) => i === was && isClear(w, ready[i]), reach);
        const at = same >= 0 ? same : clearTop(w, yard, reach);
        if (at >= 0) l.box = takeBox(w, yard, at);
      }
    } else if (cells[l.cell]?.out) {
      l.box = cells[l.cell]!;
      cells[l.cell] = null;
    }
    if (!l.box) return endLift(w, g);
  }
  if (since < done) return;
  const box = l.box;
  const into = l.relay && w.yards.get(l.relay.yard);
  if (box && l.relay) {
    // Set down further along, as cleared as it was.
    if (into) putBox(w, into, box, false, l.relay.slot);
    else if (yard) putBox(w, yard, box, false);
    l.box = undefined;
  } else if (box) {
    const cells = wagonCells(t);
    if (l.load) {
      const k = cells[l.cell] ? cells.findIndex((c) => !c) : l.cell;
      if (k >= 0) {
        box.at = w.tick;
        delete box.out;
        cells[k] = box;
      } else if (yard) putBox(w, yard, { ...box, ready: 0 }, false);
    } else if (yard && (!yardCells(yard)[l.slot] || nextYardSlot(w, yard) >= 0)) {
      putBox(w, yard, box, true, l.slot);
    } else {
      // Nowhere to set it down after all: back on its wagon.
      const k = cells[l.cell] ? cells.findIndex((c) => !c) : l.cell;
      if (k >= 0) cells[k] = box;
    }
    l.box = undefined;
  }
  endLift(w, g);
}

/**
 * A lift over, done or cut short (the train has left, or the gantry is
 * taken down): anything still on the spreader is set down in
 * the yard it came from or was going to, and it stands where it ended.
 */
function endLift(w: World, g: RailGantry): void {
  const l = g.lift;
  if (!l) return;
  const yard = w.yards.get(l.yard);
  if (l.tractor !== undefined) {
    // Off a tractor, into the yard as any other come off a ship; an
    // export it was lifting on, back.
    if (l.hand === 'off' && yard) offTractor(w, yard, l.box);
    else if (l.box && yard) putBox(w, yard, l.box, true);
  } else if (l.box && l.relay && yard) putBox(w, yard, l.box, false);
  else if (l.box && yard) putBox(w, yard, l.load ? { ...l.box, ready: 0 } : l.box, !l.load);
  // The train, if it still stands there, no longer waits on it.
  const t = l.tractor === undefined ? liftTrain(w, l) : undefined;
  if (t && !l.relay) {
    if (l.load) t.port.coming = Math.max(0, (t.port.coming ?? 0) - 1);
    else t.port.taking = Math.max(0, (t.port.taking ?? 0) - 1);
  }
  // Where it was as the lift ended: at the end, or part way for one cut short.
  const since = w.tick - l.start;
  const { taken, done } = liftMarks(l);
  g.at = since >= done ? { ...l.to } : since >= taken ? { ...l.from } : { ...g.at };
  g.lift = undefined;
}

/**
 * Where terminal tractors stand under a siding's rail gantries for them to
 * lift containers off and exports on: port road or quay in their span, off
 * the track and the yards. None without a rail gantry on it.
 */
export function railLane(w: World, s: Siding): number[] {
  const m = w.map;
  if (gantriesOn(w, s).length === 0) return [];
  const row = m.yOf(s.switch);
  const out: number[] = [];
  for (const t of loadingTrack(m, s)) {
    for (let dy = -B.SIDING_REACH; dy <= B.SIDING_REACH; dy++) {
      const y = row + dy;
      if (dy === 0 || !m.inBounds(m.xOf(t), y)) continue;
      const i = m.idx(m.xOf(t), y);
      if (w.storeOf[i] < 0 && !isTrack(m, i) && drivable(m.build[i])) out.push(i);
    }
  }
  return out;
}

/** The yards rail gantries span with somewhere for tractors under them, and the siding of each; this tick's. */
let spanned: { tick: number; w: World; by: Map<number, Siding> } | null = null;

/**
 * The siding whose rail gantries span this yard with somewhere for a
 * tractor to stand under them, for them to lift its containers off and
 * exports on; undefined if none does.
 */
export function railYard(w: World, yard: Bay): Siding | undefined {
  if (!spanned || spanned.w !== w || spanned.tick !== w.tick) {
    const by = new Map<number, Siding>();
    for (const s of sidings(w.map)) {
      if (gantriesOn(w, s).length === 0 || railLane(w, s).length === 0) continue;
      for (const y of gantryYards(w, s).keys()) if (!by.has(y.idx)) by.set(y.idx, s);
    }
    spanned = { tick: w.tick, w, by };
  }
  return spanned.by.get(yard.idx);
}

/**
 * Where a tractor stands for a rail gantry to work it at this yard: under
 * the gantries, nearest the yard along the track, one no other has if it
 * can be, that it can get to from `from`; -1 if none.
 */
export function railSpot(w: World, p: Dockhand, yard: Bay, from: number): number {
  const s = railYard(w, yard);
  if (!s) return -1;
  const m = w.map;
  const xs = (yard.tiles ?? [yard.idx]).map((t) => m.xOf(t));
  const off = (i: number) => Math.min(...xs.map((x) => Math.abs(x - m.xOf(i))));
  const order = railLane(w, s).sort(
    (a, b) =>
      Number(w.spotTaken(a, p)) - Number(w.spotTaken(b, p)) ||
      off(a) - off(b) ||
      w.dist(from, a) - w.dist(from, b),
  );
  return order.find((t) => w.pathFor(p, from, t)) ?? -1;
}

/** Which way a tractor lines up under rail gantries, for the view: along the track. */
export function railHeading(w: World, yard: Bay): number | undefined {
  return railYard(w, yard) ? 0 : undefined;
}

/**
 * Whether a tractor picking up or setting down at a yard with no yard
 * gantry may go on with it: at a yard rail gantries span, only once one
 * has handed it the export it waits for; one it brought is lifted off it
 * by the gantry, which sends it on its way. Anywhere else, yes.
 */
export function railFor(w: World, p: Dockhand, yard: Bay): boolean {
  const s = railYard(w, yard);
  if (!s) return true;
  if (p.state === 'picking' && p.handed) return true;
  if (served(w).has(p.id)) return false;
  // Nothing under the gantries to lift for it, or no room there: it does
  // without, rather than wait for good.
  const reach = gantryYards(w, s).get(yard);
  if (p.state === 'picking') return yardTop(w, yard, true, undefined, reach) < 0;
  const box = p.load[0];
  return !box || nextYardSlot(w, yard, box.ready ?? customsFor(w, box.from), reach) < 0;
}

/** Tractors already being worked by a rail gantry. */
function served(w: World): Set<number> {
  const out = new Set<number>();
  for (const g of railGantries(w)) if (g.lift?.tractor !== undefined) out.add(g.lift.tractor);
  return out;
}

/**
 * A tractor waiting under the gantry's track for it, the quickest to get
 * to clear of the others: one setting a container down in a yard it spans,
 * or waiting for an export off one.
 */
function tractorLift(w: World, s: Siding, g: RailGantry): RailLift | null {
  const lane = new Set(railLane(w, s));
  if (lane.size === 0) return null;
  const yards = gantryYards(w, s);
  const busy = served(w);
  let best: RailLift | null = null;
  let quickest = Infinity;
  for (const p of w.people) {
    if (p.kind !== 'tractor' || busy.has(p.id) || !lane.has(w.tileOf(p))) continue;
    const at = { x: p.x, y: p.y };
    let lift: RailLift | null = null;
    if (p.state === 'dropping' && p.load.length > 0) {
      const yard = w.yards.get(p.bayIdx);
      const reach = yard && yards.get(yard);
      if (!yard || !reach) continue;
      const box = p.load[0];
      const slot = nextYardSlot(w, yard, box.ready ?? customsFor(w, box.from), reach);
      if (slot < 0) continue;
      const to = slotSpot(w, yard, slot);
      lift = {
        start: w.tick,
        legs: legsOf(g.at, at, to),
        from: at,
        to,
        load: false,
        train: -1,
        cell: -1,
        yard: yard.idx,
        slot,
        look: carriedLooks(w, p)[0] ?? 0,
        tractor: p.id,
        hand: 'off',
      };
    } else if (p.state === 'picking' && p.outbound && !p.handed) {
      const yard = w.yards.get(p.stockIdx);
      const reach = yard && yards.get(yard);
      if (!yard || !reach) continue;
      const top = yardTop(w, yard, true, undefined, reach);
      if (top < 0) continue;
      const slot = yardSlots(w, yard).exports[top];
      const from = slotSpot(w, yard, slot);
      lift = {
        start: w.tick,
        legs: legsOf(g.at, from, at),
        from,
        to: at,
        load: true,
        train: -1,
        cell: -1,
        yard: yard.idx,
        slot,
        look: exportLooks(w, yard)[top] ?? 0,
        tractor: p.id,
        hand: 'on',
      };
    } else continue;
    const ticks = lift.legs[0] + lift.legs[2];
    if (ticks >= quickest || !clearOfOthers(w, s, g, [g.at.x, lift.from.x, lift.to.x])) continue;
    quickest = ticks;
    best = lift;
  }
  return best;
}

/**
 * A gantry lifting for a tractor: off it, the tractor goes on its way as
 * the spreader takes the container up, and it is set down in the yard at
 * the end, for customs; onto it, the export is taken up off its stack and
 * handed over at the end.
 */
function runTractorLift(w: World, g: RailGantry): void {
  const l = g.lift!;
  const p = w.people.find((q) => q.id === l.tractor);
  const yard = w.yards.get(l.yard);
  const { taken, done } = liftMarks(l);
  const since = w.tick - l.start;
  if (!l.box && since >= taken) {
    if (l.hand === 'off') {
      if (!p || p.state !== 'dropping' || p.bayIdx !== l.yard || !p.load[0] || !yard) {
        return endLift(w, g);
      }
      carriedLooks(w, p);
      l.box = p.load[0];
      // Its part done: on to the next.
      w.stats.containers += 1;
      p.carrying = 0;
      p.load = [];
      p.planned = 0;
      p.bayIdx = -1;
      p.outbound = false;
      p.state = 'idle';
    } else {
      if (!p || p.state !== 'picking' || p.stockIdx !== l.yard || !yard) return endLift(w, g);
      const s = sidingAt(w.map, g.idx);
      const reach = s ? gantryYards(w, s).get(yard) : undefined;
      const looks = exportLooks(w, yard);
      const was = looks.indexOf(l.look);
      const same = yardTop(w, yard, true, (i) => i === was, reach);
      const at = same >= 0 ? same : yardTop(w, yard, true, undefined, reach);
      if (at < 0) return endLift(w, g);
      l.box = takeBox(w, yard, at, true);
    }
  }
  if (since < done) return;
  if (l.hand === 'on' && l.box && p?.state === 'picking' && p.stockIdx === l.yard) {
    // Onto its trailer: it goes on with it as with any other.
    p.handed = [l.box];
    p.timer = 1;
    l.box = undefined;
  }
  endLift(w, g);
}

/**
 * A container a gantry lifted off a tractor set down in the yard, where
 * it kept a place if that is free still, customs to clear it as any other;
 * the room kept for it given back. With none in hand, only the room.
 */
function offTractor(w: World, yard: Bay, box: Crate | undefined): void {
  bayIncoming(yard, true, -1);
  if (!box) return;
  box.ready ??= customsFor(w, box.from);
  putBox(w, yard, box, false);
  tip(w, 'customs');
}

/**
 * A save from before loading track: each siding with container yards
 * beside it has loading track laid along it where they lie (the longest
 * stretch of plain track between the first and last of them), and a yard
 * gantry that stood over its track becomes a rail gantry there, or plain
 * track off it. Rail lines' trains are no longer than the track holds.
 */
export function loadingTrackFromSave(w: World): void {
  const m = w.map;
  w.rail.gantries = [];
  for (const s of sidings(m)) {
    if (s.tiles.some((t) => m.build[t] === Build.Loadout)) continue;
    const row = m.yOf(s.switch);
    const besideYard = (t: number) =>
      [...w.yards.values()].some((y) =>
        (y.tiles ?? [y.idx]).some(
          (q) => m.xOf(q) === m.xOf(t) && Math.abs(m.yOf(q) - row) <= B.SIDING_REACH,
        ),
      );
    const plain = (t: number) =>
      m.build[t] === Build.Siding || (m.build[t] === Build.YardGantry && !!(m.orient[t] & RAILS));
    const near = s.tiles.map((t, k) => (besideYard(t) ? k : -1)).filter((k) => k >= 0);
    let run: number[] = [];
    if (near.length > 0) {
      let cur: number[] = [];
      for (let k = near[0]; k <= near[near.length - 1] + 1; k++) {
        if (k < s.tiles.length && k <= near[near.length - 1] && plain(s.tiles[k])) cur.push(k);
        else {
          if (cur.length > run.length) run = cur;
          cur = [];
        }
      }
    }
    const on = new Set(run.map((k) => s.tiles[k]));
    for (const t of s.tiles) {
      const gantry = m.build[t] === Build.YardGantry && !!(m.orient[t] & RAILS);
      if (on.has(t)) {
        m.build[t] = gantry ? Build.RailGantry : Build.LoadingTrack;
        m.orient[t] = 0;
        if (gantry) addRailGantry(w, t);
      } else if (gantry) {
        m.build[t] = Build.Siding;
        m.orient[t] = 0;
      } else continue;
      w.dirty.add(t);
    }
  }
  w.gantryCache = null;
  // Yard gantries no longer lift between a yard and the wagons.
  for (const y of w.yards.values()) {
    const old = y as Bay & { gantryWagon?: unknown };
    if (old.gantryWagon === undefined) continue;
    delete old.gantryWagon;
    y.gantryOn = y.gantryTo = y.gantryLift = undefined;
  }
  const most = longestTrack(m);
  for (const c of w.contracts) {
    if (c.terms.kind !== 'rail' || c.terms.bulk || c.terms.wagons !== undefined) continue;
    c.terms.wagons = Math.max(1, Math.min(trainWagons(c.terms), most || trainWagons(c.terms)));
  }
  for (const o of w.offers) {
    if (o.terms.kind === 'rail' && !o.terms.bulk) o.terms.wagons ??= trainWagons(o.terms);
  }
}

/** A rail gantry as the view sees it: where it stands, its rails, and its lift. */
export function railGantryView(w: World, g: RailGantry): RailGantryView {
  const m = w.map;
  const s = sidingAt(m, g.idx);
  const xs = s ? loadingTrack(m, s).map((t) => m.xOf(t)) : [m.xOf(g.idx)];
  const l = g.lift;
  return {
    idx: g.idx,
    x: g.at.x,
    y: g.at.y,
    from: Math.min(...xs),
    to: Math.max(...xs) + 1,
    reach: B.SIDING_REACH,
    ...(l
      ? {
          lift: {
            start: l.start,
            legs: l.legs,
            from: l.from,
            to: l.to,
            load: l.load,
            ...(l.relay ? { relay: l.relay } : {}),
            look: l.look,
            train: l.train,
            cell: l.cell,
            yard: l.yard,
            slot: l.slot,
            ...(l.tractor !== undefined ? { tractor: l.tractor, hand: l.hand } : {}),
          },
        }
      : {}),
  };
}
