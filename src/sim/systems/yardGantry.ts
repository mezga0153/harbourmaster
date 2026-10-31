// Yard gantries: the crane spanning a container yard that loads its trucks and
// tractors and takes containers off them, its lifts, and the places in the yard
// it sets them down.

import type { World } from '../world';
import { straightOnto } from './truckLoading';
import { handlingTicks } from './workforce/crowding';
import { craneStackTiles, headTo } from './workforce/dockhands';
import {
  boxLooks,
  carriedLooks,
  clearTop,
  exportLooks,
  freeYardSlot,
  isClear,
  machineGround,
  nextYardSlot,
  reachFrom,
  readyList,
  stackLooks,
  yardSlots,
  yardTop,
} from './cargo/stores';
import { heldMask } from './cargo/customs';
import type { Bay, Boat, Crane, Dockhand, GantryHeld, GantryWork, Truck } from '../state';
import { Build, isCrane } from '../types';
import { footprint, gantryRails, gantryYard, liftMarks } from '../rules/footprint';
import { bayIncoming, boxLookOf, clamp, craneStacks, heldIn, isTruck, liftTicks } from '../helpers';
import type { Vehicle } from '../helpers';
import { cranePlaces, craneTop, customsFor, nextCranePlace, takingAt } from './cranes';
import * as B from '../balance';
import { tip } from './output';
import type { EntityView, HandAt } from '../../protocol/views';
import { pickTile } from './boats/berthing';

/** A yard gantry stands beside this container yard, to load its trucks. */
export function yardGantry(w: World, yard: Bay): boolean {
  return gantryOf(w, yard) >= 0;
}

/**
 * The yard gantry that works this container yard, by its tile, or -1:
 * one that spans it (see gantryYard), the first where two stand by it;
 * never one beside it that spans another yard.
 */
export function gantryOf(w: World, yard: Bay): number {
  return gantries(w).byYard.get(yard.idx) ?? -1;
}

/**
 * Every yard gantry and the yard it works, by the yard's first tile;
 * and those that work none: beside no yard, or a second by one. Cleared
 * when the map changes.
 */
export function gantries(w: World): { byYard: Map<number, number>; idle: Map<number, string> } {
  if (w.gantryCache) return w.gantryCache;
  const m = w.map;
  const byYard = new Map<number, number>();
  const idle = new Map<number, string>();
  for (let g = 0; g < m.build.length; g++) {
    if (m.build[g] !== Build.YardGantry) continue;
    const own = gantryYard(m, g);
    const yard = own ? w.yards.get(w.storeOf[own.into]) : undefined;
    if (!yard) {
      idle.set(
        g,
        'A yard gantry spans the container yard beside it, and there is none beside this one: mark one out beside it, or take it down',
      );
    } else if (byYard.has(yard.idx)) {
      idle.set(
        g,
        'Another yard gantry works the yard beside this one already: a yard is worked by one gantry',
      );
    } else byYard.set(yard.idx, g);
  }
  return (w.gantryCache = { byYard, idle });
}

/**
 * Someone is there to load or unload a container truck at this storage:
 * a yard gantry, or a reach stacker free and not already wanted by another
 * truck there waiting for one. Always so for crate storage and bays.
 */
export function handlerFree(w: World, bay: Bay, except?: Truck): boolean {
  if (!bay.yard || w.yardGantry(bay)) return true;
  const free = w.people.filter(
    (p) =>
      p.kind === 'stacker' &&
      (p.state === 'idle' ||
        p.state === 'wander' ||
        (p.state === 'toDepot' && p.depotTask === 'park')),
  ).length;
  const wanting = w.trucks.filter((q) => {
    if (q === except || !q.boxes || (q.coming ?? 0) > 0 || (q.taking ?? 0) > 0) return false;
    if (q.state !== 'toBay' && q.state !== 'loading' && q.state !== 'delivering') return false;
    const yard = w.yards.get(q.bayIdx);
    return !!yard && !w.yardGantry(yard);
  }).length;
  return free > wanting;
}

/**
 * The truck a yard's gantry is loading or unloading: one at a time, the
 * first with a container to move.
 */
export function gantryTruck(w: World, y: Bay): Truck | undefined {
  let ready: boolean | undefined;
  let best: Truck | undefined;
  let bestD = Infinity;
  for (const t of w.trucks) {
    if (t.bayIdx !== y.idx || !t.boxes) continue;
    const wants =
      (t.state === 'delivering' && t.cargo > 0) ||
      (t.state === 'loading' &&
        t.cargo < t.capacity &&
        (ready ??= readyList(w, y).some((r) => isClear(w, r))));
    if (!wants) continue;
    // The nearest along its rails to where it stands, so it runs to and
    // fro no more than it must.
    const d = fromGantry(w, y, t.goal);
    if (d < bestD) {
      best = t;
      bestD = d;
    }
  }
  return best;
}

/** How far along its rails a yard's gantry is from lane tile `i`. */
export function fromGantry(w: World, y: Bay, i: number): number {
  return Math.abs((w.gantryLane(y)?.get(i) ?? 0) - (y.gantryAt ?? 0));
}

/**
 * What a yard's gantry is doing, for the view: a truck it is loading or
 * unloading, and where that truck stands along its rails.
 */
export function gantryWork(w: World, y: Bay): GantryWork {
  if (!w.yardGantry(y)) return {};
  // The one it is part way through a lift for. Between lifts it is at
  // none: it stands where it set the last one down, rather than show a
  // lift for the next one waiting that has not begun.
  const on = gantryHolder(w, y);
  // Setting down one lifted off a truck or tractor that has gone on.
  const h = y.gantryHeld;
  if (!on && h && y.gantryLift) {
    return {
      working: 'unload',
      workLook: h.looks[0],
      workAt: h.at,
      workTruck: h.by,
      workSlot: h.slot,
      workYard: y.gantryTo,
      released: true,
      ...liftView(w, y, h.by),
    };
  }
  if (!on || !y.gantryLift) return {};
  const p = isTruck(on) ? undefined : on;
  if (p) {
    const workAt = w.gantryLane(y)?.get(p.goal) ?? 0;
    const lift = { workAt, workTruck: p.id, workSlot: 0, ...liftView(w, y, p.id) };
    if (p.state === 'dropping') {
      // Where the sim stacks it, by when customs clear it.
      const workYard = y.gantryTo ?? stackedAt(w, p, y, customsFor(w, p.cargoFrom?.[0]));
      return {
        working: 'unload',
        workLook: carriedLooks(w, p)[0],
        workYard,
        ...lift,
      };
    }
    const top = Math.max(0, yardTop(w, y, true));
    return { working: 'load', workLook: exportLooks(w, y)[top], ...lift };
  }
  const t = on as Truck;
  const workAt = w.gantryLane(y)?.get(t.goal) ?? 0;
  const view = liftView(w, y, t.id);
  if (t.state === 'delivering') {
    const look = boxLookOf(t.id, t.cargo - 1);
    return {
      working: 'unload',
      workLook: look,
      workAt,
      workTruck: t.id,
      workSlot: t.cargo - 1,
      workYard: y.gantryTo,
      ...view,
    };
  }
  const look = t.lifting ?? boxLooks(w, y)[clearTop(w, y)];
  return {
    working: 'load',
    workLook: look,
    workAt,
    workTruck: t.id,
    workSlot: t.cargo,
    ...view,
  };
}

/** How far through its lift for `id` a yard's gantry is, and the lift's legs, for the view. */
export function liftView(
  w: World,
  y: Bay,
  id: number,
): { workPhase: number; workLegs?: number[]; workTicks?: number; workStart?: number } {
  const l = y.gantryOn === id || y.gantryHeld?.by === id ? y.gantryLift : undefined;
  if (!l) return { workPhase: 0 };
  const total = liftTicks(l);
  return {
    workPhase: clamp((w.tick - l.start) / total, 0, 1),
    workLegs: l.legs.map((k) => k / total),
    workTicks: total,
    workStart: l.start,
  };
}

/** Where yard slot `slot` lies along its yard's gantry rails, as gantryLane counts. */
export function slotAlong(w: World, y: Bay, slot: number | undefined): number {
  const lane = w.gantryLane(y);
  if (!lane || slot === undefined || slot < 0) return 0;
  const tile = (y.tiles ?? [y.idx])[Math.floor(slot / B.BOXES_PER_STORE_TILE)];
  if (tile === undefined) return 0;
  const m = w.map;
  let g = -1;
  let ax = 0;
  let ay = 0;
  for (const [i, k] of lane) {
    if (k === 0) g = i;
  }
  for (const [i, k] of lane) {
    if (k !== 1 && k !== -1) continue;
    ax = (m.xOf(i) - m.xOf(g)) * k;
    ay = (m.yOf(i) - m.yOf(g)) * k;
    break;
  }
  return (m.xOf(tile) - m.xOf(g)) * ax + (m.yOf(tile) - m.yOf(g)) * ay;
}

/**
 * A yard's gantry starts a lift: along its rails from where it stands to
 * `from`, where it takes the container up, then along to `to`, where it
 * sets it down. Returns how many ticks it takes: the longer the way along
 * the rails, the longer.
 */
export function startLift(w: World, y: Bay, from: number, to: number): number {
  const at = y.gantryAt ?? from;
  // Taking it up and setting it down take as long as a lift always did.
  const up = Math.floor(B.YARD_GANTRY_TICKS / 2);
  const down = B.YARD_GANTRY_TICKS - up;
  const run = (d: number) => Math.round(Math.abs(d) / B.YARD_GANTRY_SPEED);
  y.gantryLift = { start: w.tick, legs: [run(from - at), up, run(to - from), down], to };
  return liftTicks(y.gantryLift);
}

/** Whether the lift a yard's gantry is part way through is done. */
export function liftDone(w: World, y: Bay): boolean {
  const l = y.gantryLift;
  return !l || w.tick - l.start >= liftTicks(l);
}

/** Ticks from the start of a yard gantry's lift until its spreader has the container up. */
export function takenIn(_w: World, y: Bay): number {
  const l = y.gantryLift;
  // Not before the view has it taken: half way through taking it up.
  return l ? l.legs[0] + Math.ceil(l.legs[1] / 2) : 0;
}

/** Whether a yard gantry's spreader has taken up the container it is lifting. */
export function liftTaken(w: World, y: Bay): boolean {
  const l = y.gantryLift;
  return !l || w.tick - l.start >= takenIn(w, y);
}

/**
 * A yard gantry has lifted a container off the truck or tractor it was
 * working: that one is free to go, and the gantry carries the container
 * on and sets it down at the end of the lift, taking on no other till then.
 */
export function offToGantry(_w: World, y: Bay, held: GantryHeld): void {
  y.gantryHeld = held;
  y.gantryOn = undefined;
}

/** A yard gantry sets down the container it lifted off a truck or tractor gone on its way. */
export function settleGantry(w: World, y: Bay): void {
  const h = y.gantryHeld;
  if (!h) return;
  const to = y.gantryTo;
  if (h.exports) {
    if (to !== undefined && h.fees.length === 1) yardSlots(w, y).exports.push(to);
    exportLooks(w, y).push(...h.looks);
    (y.exports ??= []).push(...h.fees);
    y.exportIncoming = Math.max(0, (y.exportIncoming ?? 0) - h.planned);
  } else {
    // Customs clear it a while after it is stacked, as any other.
    const ready = h.fees.map((_, k) => customsFor(w, h.from?.[k]));
    if (to !== undefined && h.fees.length === 1) yardSlots(w, y).boxes.push(to);
    readyList(w, y).push(...ready);
    boxLooks(w, y).push(...h.looks);
    y.boxes.push(...h.fees);
    bayIncoming(y, true, -h.planned);
    w.stats.containers += h.fees.length;
    tip(w, 'customs');
  }
  y.gantryHeld = y.gantryTo = undefined;
  // It stands where it set the container down, for the next.
  if (y.gantryLift) y.gantryAt = y.gantryLift.to;
  y.gantryLift = undefined;
}

/**
 * Containers a yard gantry is part way through lifting, by the truck or
 * tractor it is working: off it once the spreader has it, on it once set
 * down. The sim moves each at the end of the lift; the view shows it
 * where the gantry has it.
 */
export function gantryLifts(world: World): Map<number, GantryWork & { yard: number }> {
  const lifts = new Map<number, GantryWork & { yard: number }>();
  for (const y of world.yards.values()) {
    const w = gantryWork(world, y);
    // Only those still on, or still being lifted onto, the truck or tractor.
    if (w.workTruck !== undefined && !w.released) lifts.set(w.workTruck, { ...w, yard: y.idx });
  }
  return lifts;
}

/**
 * A reach stacker or terminal tractor taking a container off where it is
 * or setting one down, for the view to work it there in step.
 */
export function handView(
  w: World,
  p: Dockhand,
): Pick<EntityView, 'handStage' | 'handPhase' | 'handTicks' | 'handAt' | 'handCount'> {
  if (p.state !== 'picking' && p.state !== 'dropping') return {};
  const pick = p.state === 'picking';
  const crates = p.kind === 'forklift' || p.kind === 'dockhand';
  const at = crates ? crateAt(w, p, pick) : handAt(w, p, pick);
  if (crates && !at) return {};
  const ticks = handlingTicks(w, p, pick ? B.PICK_TICKS : B.DROP_TICKS);
  return {
    handStage: pick ? 'pick' : 'drop',
    handPhase: clamp(1 - p.timer / ticks, 0, 1),
    handTicks: ticks,
    handAt: at,
    ...(crates && pick ? { handCount: p.planned } : {}),
  };
}

/**
 * The places crate storage's pallets are in, four to a tile, kept beside
 * its crates: each stays where it was set down as forklifts take full
 * ones from under the one being filled, and a new one goes in the lowest
 * free place. With `n` more than it holds, as many more as `n` would fill,
 * where they would go.
 */
export function palletPlaces(_w: World, b: Bay, n = 0): number[] {
  const per = B.FORKLIFT_CAPACITY;
  const room = (b.tiles?.length ?? 1) * (B.CRATES_PER_STORE_TILE / per);
  const places = (b.places ??= []);
  const pallets = Math.ceil(heldIn(b) / per);
  if (places.length > pallets) places.length = pallets;
  const used = new Set<number>();
  places.forEach((k, j) => {
    if (k < 0 || k >= room || used.has(k)) places[j] = -1;
    else used.add(k);
  });
  const free = () => {
    let k = 0;
    while (used.has(k)) k++;
    used.add(k);
    return k;
  };
  places.forEach((k, j) => k < 0 && (places[j] = free()));
  while (places.length < pallets) places.push(free());
  if (n <= pallets * per) return places;
  const more = [...places];
  while (more.length < Math.ceil(n / per)) more.push(free());
  return more;
}

/** Where crate `k` of crate storage is, counting `n` there: its pallet's place, four to each. */
export function crateSlot(w: World, b: Bay, k: number, n = k + 1): number {
  const per = B.FORKLIFT_CAPACITY;
  return (palletPlaces(w, b, n)[Math.floor(k / per)] ?? 0) * per + (k % per);
}

/**
 * Which of crate storage's pallets a forklift takes, of its exports when
 * `out`: the one it pulled up to, else the last full one no other is
 * lifting, so it leaves alone the one being filled, by a jib crane say;
 * with none full, or when it is taking less than a pallet's worth, the
 * last. -1 if there are none.
 */
export function pickPallet(w: World, b: Bay, out: boolean, p?: Dockhand): number {
  const per = B.FORKLIFT_CAPACITY;
  const places = palletPlaces(w, b);
  const last = places.length - 1;
  const at = p?.state === 'picking' && p.takeAt !== undefined ? places.indexOf(p.takeAt) : -1;
  if (at >= 0) return at;
  if (p && (p.state === 'toPickup' || p.state === 'picking') && p.planned < per) return last;
  const [from, to] = out ? [b.crates.length, heldIn(b)] : [0, b.crates.length];
  const taken = new Set(
    w.people
      .filter((q) => q !== p && q.kind === 'forklift' && q.state === 'picking')
      .filter((q) => q.stockIdx === b.idx)
      .map((q) => q.takeAt),
  );
  // Never a pallet with crates on it still waiting on customs or papers.
  const wait = heldMask(w, b);
  const cleared = (j: number) => !wait.slice(j * per, (j + 1) * per).includes(true);
  for (let j = last; j >= 0; j--) {
    if (j * per >= from && (j + 1) * per <= to && !taken.has(places[j]) && cleared(j)) return j;
  }
  return last;
}

/**
 * The tile of crate storage the pallet a forklift takes is on (`pick`),
 * or the place the next goes: four pallets to a tile.
 */
export function palletTile(
  w: World,
  b: Bay,
  pick: boolean,
  coming = !pick,
  out = false,
  p?: Dockhand,
): number {
  const tiles = b.tiles ?? [b.idx];
  const per = B.CRATES_PER_STORE_TILE / B.FORKLIFT_CAPACITY;
  const next = heldIn(b) + (coming ? b.incoming : 0);
  const place = pick
    ? (palletPlaces(w, b)[pickPallet(w, b, out, p)] ?? 0)
    : Math.floor(crateSlot(w, b, next) / B.FORKLIFT_CAPACITY);
  return tiles[Math.min(tiles.length - 1, Math.floor(place / per))];
}

/**
 * How many crates a forklift may take off crate storage: those on the
 * pallet it drives up to, so it lifts just what is seen on it; no limit
 * anywhere else.
 */
export function onPallet(w: World, p: Dockhand, b: Bay): number {
  if (p.kind !== 'forklift' || !b.tiles || b.yard) return Infinity;
  const j = pickPallet(w, b, !!p.outbound, p);
  return Math.min(B.FORKLIFT_CAPACITY, heldIn(b) - j * B.FORKLIFT_CAPACITY);
}

/**
 * Where in crate storage's crates, or its exports, `n` taken off it come
 * from: a forklift's whole pallet from wherever it is, its place left
 * free; else the last.
 */
export function takenFrom(w: World, p: Dockhand, b: Bay, n: number): number {
  const per = B.FORKLIFT_CAPACITY;
  const list = p.outbound ? (b.exports ?? []) : b.crates;
  const skip = p.outbound ? b.crates.length : 0;
  const j = p.kind === 'forklift' && b.tiles && !b.yard ? pickPallet(w, b, !!p.outbound, p) : -1;
  p.takeAt = undefined;
  const places = palletPlaces(w, b);
  const at = j * per - skip;
  if (j < 0 || j === places.length - 1 || n !== per || at < 0 || at + n > list.length) return 0;
  places.splice(j, 1);
  return at;
}

/**
 * A forklift at crate storage not at the tile of the pallet it takes, or
 * the place its own goes as it sets it down, heads on there; true if so.
 */
export function toPallet(w: World, p: Dockhand, b: Bay | undefined, pick: boolean): boolean {
  if (p.kind !== 'forklift' || !b?.tiles || b.yard) return false;
  const tile = palletTile(w, b, pick, false, !!p.outbound, p);
  return tile !== w.tileOf(p) && headTo(w, p, tile);
}

/**
 * The crate a forklift or dockhand takes, or the place it sets one down:
 * the last there, or the next place after it, as each shows its crates
 * in order; in crate storage a forklift's whole pallet (see storage).
 */
export function crateAt(w: World, p: Dockhand, pick: boolean): HandAt | undefined {
  const last = (n: number) => (pick ? n - 1 : n);
  const store = (b: Bay): HandAt | undefined => {
    const held = heldIn(b);
    if (last(held) < 0) return undefined;
    if (p.kind !== 'forklift') return { store: b.idx, slot: crateSlot(w, b, last(held)) };
    const place = pick
      ? palletPlaces(w, b)[pickPallet(w, b, !!p.outbound, p)]
      : Math.floor(crateSlot(w, b, held) / B.FORKLIFT_CAPACITY);
    return { store: b.idx, place };
  };
  const onBoat = (b: Boat): HandAt => ({ truck: b.id, slot: last(b.crates + (b.out ?? 0)) });
  // Ice off the back of an ice works' truck, onto the bay's stack.
  const iceTruck =
    p.truckId !== undefined && !p.truckLoad && w.trucks.find((q) => q.id === p.truckId);
  if (iceTruck) {
    const bay = w.bays.get(p.bayIdx);
    if (pick) return { truck: iceTruck.id, slot: iceTruck.cargo - 1 };
    return bay ? { bay: bay.idx, slot: heldIn(bay) } : undefined;
  }
  if (pick) {
    const crane = w.cranes.get(p.craneIdx);
    if (crane?.kind === 'jib') return { crane: crane.idx, slot: crane.stack.length - 1 };
    const boat = w.boats.find((b) => b.id === p.boatId);
    if (boat) return onBoat(boat);
    const pile = w.piles.get(p.stockIdx);
    if (pile) return { pile: pile.idx, slot: pile.crates.length - 1 };
    const bay = w.bays.get(p.stockIdx);
    if (!bay) return undefined;
    // Off a truck bay's stack, as onto a truck there; its ice, on top, for a boat.
    if (bay.tiles) return store(bay);
    return { bay: bay.idx, slot: last(p.outbound ? heldIn(bay) : bay.crates.length) };
  }
  // Onto a truck it is loading.
  const truck = p.truckId !== undefined && w.trucks.find((q) => q.id === p.truckId);
  if (truck) return { truck: truck.id, slot: truck.cargo };
  const boat = p.toBoat !== undefined && p.toBoat >= 0 && w.boats.find((b) => b.id === p.toBoat);
  if (boat) return onBoat(boat);
  const pile = w.piles.get(p.bayIdx);
  if (pile) return { pile: pile.idx, slot: pile.crates.length };
  const bay = w.bays.get(p.bayIdx);
  if (!bay) return undefined;
  const onto = straightOnto(w, p, bay);
  if (onto) return { truck: onto.id, slot: onto.cargo };
  return bay.tiles ? store(bay) : { bay: bay.idx, slot: bay.crates.length };
}

/** Where a stacker or tractor is taking a container from, or setting one down. */
export function handAt(w: World, p: Dockhand, pick: boolean): HandAt | undefined {
  const first = (y: Bay) => (y.tiles ?? [y.idx])[0];
  // Under a yard gantry, a tractor stands along the lane for it to lift.
  const lane = (y: Bay): HandAt => {
    const along = p.kind === 'tractor' ? laneHeading(w, y) : undefined;
    return along === undefined ? { yard: first(y) } : { yard: first(y), along };
  };
  if (p.truckId !== undefined) {
    const t = w.trucks.find((q) => q.id === p.truckId);
    const yard = w.yards.get(p.bayIdx);
    if (!t || !yard) return undefined;
    // Off the stack onto the truck, or off the truck onto the stack.
    if (pick !== !!p.truckLoad) return { truck: t.id, slot: pick ? t.cargo - 1 : t.cargo };
    if (!pick) return { yard: first(yard), place: stackedAt(w, p, yard) };
    const at = clearTop(w, yard, reachFrom(w, yard, p.goal));
    if (at < 0) return undefined;
    const place = yardSlots(w, yard).boxes[at];
    return { yard: first(yard), look: boxLooks(w, yard)[at], place };
  }
  if (pick) {
    const crane = w.cranes.get(p.craneIdx);
    if (crane)
      return (
        craneHand(w, p, crane) ?? {
          crane: crane.idx,
          look: stackLooks(w, crane)[Math.max(0, takingAt(w, p, crane))],
        }
      );
    const yard = w.yards.get(p.stockIdx);
    if (!yard || !p.outbound) return undefined;
    const reach = p.kind === 'stacker' ? reachFrom(w, yard, p.goal) : undefined;
    const at = Math.max(0, yardTop(w, yard, true, undefined, reach));
    const place = yardSlots(w, yard).exports[at];
    return { ...lane(yard), look: exportLooks(w, yard)[at], place };
  }
  if (p.toCrane !== undefined && p.toCrane >= 0) {
    const crane = w.cranes.get(p.toCrane);
    const place = crane && crane.kind !== 'jib' ? nextCranePlace(w, crane, true) : undefined;
    return (crane && craneHand(w, p, crane)) ?? { crane: p.toCrane, place };
  }
  if (p.toBoat !== undefined && p.toBoat >= 0) return undefined;
  const yard = w.yards.get(p.bayIdx);
  if (!yard) return undefined;
  // Where it will be stacked, by when customs clear it.
  const ready = p.outbound ? undefined : (p.cargoReady?.[0] ?? customsFor(w, p.cargoFrom?.[0]));
  return { ...lane(yard), place: stackedAt(w, p, yard, ready) };
}

/**
 * The place in a yard a container a machine sets down goes: a stacker's
 * on a stack it reaches from where it stands, if there is room on one.
 */
export function stackedAt(w: World, p: Dockhand, yard: Bay, ready?: number): number {
  const { boxes, exports } = yardSlots(w, yard);
  const reach = p.kind === 'stacker' ? reachFrom(w, yard, p.goal) : undefined;
  const at = reach ? freeYardSlot(w, yard, boxes, exports, ready, reach) : -1;
  return at >= 0 ? at : freeYardSlot(w, yard, boxes, exports, ready);
}

/**
 * Where a stacker standing at `at` sets a container clearing at `ready`
 * down in a yard without burying one cleared sooner: on a stack it
 * reaches from there, or -1.
 */
export function cleanSlot(w: World, yard: Bay, at: number, ready: number): number {
  const { boxes, exports } = yardSlots(w, yard);
  return freeYardSlot(w, yard, boxes, exports, ready, reachFrom(w, yard, at), true);
}

/**
 * A tractor under a gantry crane stands where it is, in the bay between
 * the legs, lined up along the quay for the crane to lift onto or off it.
 */
export function craneHand(w: World, p: Dockhand, c: Crane): HandAt | undefined {
  if (p.kind !== 'tractor' || c.kind === 'jib') return undefined;
  return { crane: c.idx, along: quayHeading(w, c) };
}

/**
 * Where a machine stands to work a place on a gantry crane's stack: on
 * the landward row of its rails, behind the stack the place is in.
 */
export function besideStack(w: World, c: Crane, place: number): number {
  const m = w.map;
  const along = (place % craneStacks(c)) % B.GANTRY_RAILS;
  const back = gantryRails(m, c.idx, m.orient[c.idx] & 3)[along * 2 + 1];
  return back >= 0 && Number.isFinite(w.driveCost(back)) ? back : pickTile(w, c);
}

/** Which way the quay edge a container crane stands on runs, as a heading. */
export function quayHeading(w: World, c: Crane): number {
  const m = w.map;
  if (c.kind === 'gantry') {
    const [a, r] = footprint(m, 'gantryCrane', c.idx, m.orient[c.idx] & 3);
    return Math.atan2(m.yOf(r) - m.yOf(a), m.xOf(r) - m.xOf(a));
  }
  const sea = m.neighbors4(c.idx).find((n) => m.ocean[n] === 1 && m.build[n] === Build.None);
  if (sea === undefined) return 0;
  return Math.atan2(m.xOf(sea) - m.xOf(c.idx), -(m.yOf(sea) - m.yOf(c.idx)));
}

/**
 * Where a terminal tractor waits for a crane to lift a container onto it
 * or off it: in the bay between a gantry crane's legs; beside a harbour
 * crane on the quay, along it, clear of the crane and its stack, on a
 * side no other tractor has if it can.
 */
export function craneSpot(w: World, p: Dockhand, c: Crane, drop = false): number {
  // A stacker at a gantry crane goes along it to the stack it works: the
  // export on top it takes, or the next place for one it brings.
  if (p.kind === 'stacker' && c.kind === 'gantry') {
    const place = drop
      ? nextCranePlace(w, c, true)
      : cranePlaces(w, c).stack[craneTop(w, c, false)];
    return place === undefined || place < 0 ? pickTile(w, c) : besideStack(w, c, place);
  }
  // A tractor at a gantry crane lines up along its rails behind the
  // stack, beside the containers. Never turning about on the way, it
  // drives on along the row and out the far end: it goes as far along
  // as it can before another standing there, or going there, so those
  // after it stop short of it rather than wait to get past.
  if (p.kind === 'tractor' && c.kind === 'gantry') {
    const lane = craneLane(w, c);
    const stack = craneStackTiles(w);
    const here = w.tileOf(p);
    const free = (t: number) => !w.spotTaken(t, p) && !stack.has(t);
    let deepest = -1;
    for (const t of [...lane].sort((a, b) => w.dist(here, a) - w.dist(here, b))) {
      if (!free(t)) break;
      deepest = t;
    }
    return deepest >= 0 ? deepest : (lane.find(free) ?? lane[0] ?? pickTile(w, c));
  }
  if (p.kind !== 'tractor' || c.kind !== 'harbour') return pickTile(w, c);
  const m = w.map;
  const a = quayHeading(w, c);
  const [dx, dy] = [Math.round(Math.cos(a)), Math.round(Math.sin(a))];
  const sides: number[] = [];
  for (const sign of [1, -1]) {
    const x = m.xOf(c.idx) + dx * sign;
    const y = m.yOf(c.idx) + dy * sign;
    if (!m.inBounds(x, y)) continue;
    const t = m.idx(x, y);
    if (Number.isFinite(w.driveCost(t)) && !isCrane(m.build[t])) sides.push(t);
  }
  // The side no other tractor has, if one is free.
  return sides.find((t) => !w.spotTaken(t, p)) ?? sides[0] ?? pickTile(w, c);
}

/**
 * The row a gantry crane's rails run along behind its stack, on the
 * landward side of the containers it sets down: where tractors line up
 * along the quay for it to lift onto or off, the length of its rails. The
 * machines' ground only, nearest the bay between its legs first.
 */
export function craneLane(w: World, c: Crane): number[] {
  const m = w.map;
  const pick = pickTile(w, c);
  const ground = machineGround(w);
  return gantryRails(m, c.idx, m.orient[c.idx] & 3)
    .filter((t, k) => k % 2 === 1 && t >= 0 && ground.has(t))
    .sort((a, b) => w.dist(pick, a) - w.dist(pick, b));
}

/** Which way the lane under a yard's gantry runs, as a heading; see gantryLane. */
export function laneHeading(w: World, y: Bay): number | undefined {
  const m = w.map;
  const area = new Set(y.tiles ?? [y.idx]);
  const g = m.build.findIndex(
    (b, i) => b === Build.YardGantry && m.neighbors4(i).some((n) => area.has(n)),
  );
  if (g < 0) return undefined;
  const into = m.neighbors4(g).find((n) => area.has(n))!;
  return Math.atan2(m.xOf(g) - m.xOf(into), m.yOf(into) - m.yOf(g));
}

/**
 * A terminal tractor a yard's gantry is lifting a container off, or
 * exports onto. They come before the trucks: the ships are waiting.
 */
export function gantryTractor(w: World, y: Bay): Dockhand | undefined {
  let best: Dockhand | undefined;
  for (const p of w.people) {
    const at =
      p.kind === 'tractor' &&
      ((p.state === 'dropping' && p.bayIdx === y.idx) ||
        (p.state === 'picking' && p.stockIdx === y.idx));
    if (at && (!best || fromGantry(w, y, p.goal) < fromGantry(w, y, best.goal))) best = p;
  }
  return best;
}

/**
 * A truck's or tractor's load as it looks while a yard gantry lifts: one
 * fewer once taken off, one more once set down.
 */
export function liftedLoad(
  _w: World,
  load: number,
  looks: number[] | undefined,
  lift: GantryWork | undefined,
): { load: number; looks?: number[] } {
  const p = lift?.workPhase ?? 0;
  const { taken, set } = liftMarks(lift?.workLegs);
  if (lift?.working === 'unload' && p >= taken) {
    return { load: load - 1, looks: looks?.slice(0, load - 1) };
  }
  if (lift?.working === 'load' && p >= set && lift.workLook !== undefined) {
    return { load: load + 1, looks: looks && [...looks, lift.workLook] };
  }
  return { load, looks };
}

/**
 * A yard's containers as they look, and its gantry at work: less the one
 * it has taken up to load, plus one it has set down off a truck.
 */
export function yardLooks(
  world: World,
  y: Bay,
  lifts: Map<number, GantryWork & { yard: number }>,
): GantryWork & { looks: number[]; slots: number[]; lifted: number; workYard?: number } {
  const looks = [...boxLooks(world, y), ...exportLooks(world, y)];
  const { boxes, exports } = yardSlots(world, y);
  const slots = [...boxes, ...exports];
  const w = [...lifts.values()].find((l) => l.yard === y.idx) ?? gantryWork(world, y);
  const p = w.workPhase ?? 0;
  const { taken, set } = liftMarks(w.workLegs);
  let lifted = 0;
  // Where in the yard the container it moves is, or goes.
  const workYard =
    w.working === 'load'
      ? slots[looks.indexOf(w.workLook ?? -1)]
      : w.working === 'unload'
        ? (w.workYard ?? nextYardSlot(world, y))
        : undefined;
  if (w.working === 'load' && p >= taken) {
    const k = looks.indexOf(w.workLook ?? -1);
    if (k >= 0) {
      looks.splice(k, 1);
      slots.splice(k, 1);
    }
    lifted = -1;
  } else if (w.working === 'unload' && p >= set && w.workLook !== undefined) {
    looks.push(w.workLook);
    slots.push(workYard ?? nextYardSlot(world, y));
    lifted = 1;
  }
  const { working, workLook, workAt, workTruck, workSlot, workPhase, workLegs, workTicks } = w;
  return {
    looks,
    slots,
    lifted,
    working,
    workLook,
    workAt,
    workTruck,
    workSlot,
    workPhase,
    workYard,
    workLegs,
    workTicks,
    workStart: w.workStart,
  };
}

/**
 * At a yard with a gantry, waiting while it works another truck or a
 * tractor; else it has the gantry lift for it. Between lifts, a tractor
 * goes first, then the trucks in turn.
 */
export function gantryElsewhere(w: World, t: Truck, bay: Bay): boolean {
  if (!t.boxes || !bay.yard || !w.yardGantry(bay)) return false;
  const on = gantryHolder(w, bay);
  if (on) return on !== t;
  // Still setting down one it lifted off another.
  if (bay.gantryHeld) return true;
  if (gantryTractor(w, bay) !== undefined || w.gantryTruck(bay) !== t) return true;
  bay.gantryOn = t.id;
  // Loading, the container it takes up, whatever customs clear meanwhile;
  // unloading, where it goes.
  t.lifting = t.state === 'loading' ? boxLooks(w, bay)[clearTop(w, bay)] : undefined;
  if (t.state === 'delivering') keepGantryTo(w, bay, nextYardSlot(w, bay));
  // Along its rails to the container, and with it to where it goes.
  const lane = w.gantryLane(bay)?.get(t.goal) ?? 0;
  if (t.state === 'loading') {
    const k = clearTop(w, bay);
    startLift(w, bay, slotAlong(w, bay, yardSlots(w, bay).boxes[k]), lane);
  } else startLift(w, bay, lane, slotAlong(w, bay, bay.gantryTo));
  return false;
}

/**
 * The truck or tractor a yard's gantry is part way through a lift for,
 * still there; it lifts for one at a time and sees each lift through,
 * so a container it has taken up is set down where it was going.
 */
export function gantryHolder(w: World, y: Bay): Vehicle | undefined {
  const id = y.gantryOn;
  if (id === undefined) return undefined;
  const t = w.trucks.find((q) => q.id === id);
  const p = t ? undefined : w.people.find((q) => q.id === id);
  const there = t
    ? t.bayIdx === y.idx && (t.state === 'loading' || t.state === 'delivering')
    : !!p &&
      p.kind === 'tractor' &&
      ((p.state === 'picking' && p.stockIdx === y.idx) ||
        (p.state === 'dropping' && p.bayIdx === y.idx));
  if (!there) {
    y.gantryOn = y.gantryTo = undefined;
    if (y.gantryLift) y.gantryAt = y.gantryLift.to;
    y.gantryLift = undefined;
  }
  return there ? (t ?? p) : undefined;
}

/**
 * Whether a tractor picking up or setting down at a yard has its gantry
 * lifting for it, taking it on if it is free; true anywhere else.
 */
export function gantryFor(w: World, p: Dockhand): boolean {
  if (p.kind !== 'tractor') return true;
  const y = w.yards.get(p.state === 'picking' ? p.stockIdx : p.bayIdx);
  if (!y || !w.yardGantry(y)) return true;
  const on = gantryHolder(w, y);
  if (on) return on === p;
  // Still setting down one it lifted off another.
  if (y.gantryHeld) return false;
  y.gantryOn = p.id;
  const lane = w.gantryLane(y)?.get(p.goal) ?? 0;
  // Setting one down, where it goes, by when customs clear it; taking
  // exports up, the one on top. It takes as long as its way along the rails.
  // Lifted off, the tractor need wait only until the spreader has it.
  if (p.state === 'dropping') {
    keepGantryTo(w, y, stackedAt(w, p, y, customsFor(w, p.cargoFrom?.[0])));
    startLift(w, y, lane, slotAlong(w, y, y.gantryTo));
    p.timer = Math.max(1, takenIn(w, y));
  } else {
    const top = yardTop(w, y, true);
    p.timer = startLift(w, y, slotAlong(w, y, yardSlots(w, y).exports[top]), lane);
  }
  return true;
}

/** Keep a place in a yard for the container its gantry sets down. */
export function keepGantryTo(_w: World, y: Bay, at: number): void {
  y.gantryTo = at >= 0 ? at : undefined;
}

/**
 * A lift done: the gantry is free for the next. Returns the place it kept
 * in the yard for the container it set down, if it did.
 */
export function gantryDone(_w: World, bay: Bay | undefined, id: number): number | undefined {
  if (bay?.gantryOn !== id) return undefined;
  const to = bay.gantryTo;
  bay.gantryOn = bay.gantryTo = undefined;
  // It stands where it set the container down, for the next.
  if (bay.gantryLift) bay.gantryAt = bay.gantryLift.to;
  bay.gantryLift = undefined;
  return to;
}
