// The hauliers' and shippers' trucks: setting out, each truck's turn through
// the port and the town, and how they drive.

import type { World } from '../../world';
import { book, hauliers, smallTrucks } from '../economy';
import type { Agent, Bay, Truck } from '../../state';
import { bayCap, boxLookOf, cratesAt, isMachine, wrapAngle } from '../../helpers';
import * as B from '../../balance';
import { dest, unclaimed } from '../cargo/customs';
import {
  avoiding,
  dockFor,
  freeDock,
  frontFor,
  goDeeper,
  intoSpace,
  noWayIn,
  parkUp,
  queuedAt,
  spaceAt,
  stageNearer,
  stagedFor,
  truckCostFor,
} from './bays';
import {
  arrival,
  backIn,
  driveRound,
  entryClear,
  nextStop,
  leavePark,
  lengthOf,
  mayEnter,
  pace,
  removeTruck,
  startBacking,
  truckReroute,
} from './traffic';
import {
  boxLooks,
  cannedTruck,
  clearTop,
  clearedFor,
  exportLooks,
  iceTruck,
  readyList,
  yardSlots,
} from '../cargo/stores';
import { message, moneyAt, tip } from '../output';
import { gantryDone, gantryElsewhere, liftDone, liftTaken, offToGantry } from '../yardGantry';
import { needsWideSpace } from '../../rules/parking';
import { Build } from '../../types';
import { outgoingFull } from '../cargo/exports';
import { byHand, byStacker, cratesFor, cratesOff, truckTicks } from '../truckLoading';
import { bedCap, bottomFull, offBed, topFirst } from '../cargo/beds';
import { BUSINESSES, HIGHWAY_X } from '../../town';
import { cargoOf } from '../../cargo';

export function spawnTrucks(w: World): void {
  const m = w.map;
  // Pickups give way to small trucks once the port is a Coastal Wharf.
  smallTrucks(w);
  const firms = hauliers(w);
  const out = new Map<number, number>();
  // A truck that has left the port is away on its round, and back for
  // more only once its haulier's return is due.
  for (const t of w.trucks) {
    if (!t.away && t.drop === undefined) out.set(t.contractId, (out.get(t.contractId) ?? 0) + 1);
  }
  for (const h of firms) {
    h.returns = (h.returns ?? []).filter((at) => at > w.tick);
    out.set(h.id, (out.get(h.id) ?? 0) + h.returns.length);
  }
  // Fullest bays get trucks first. Container trucks collect from the yards,
  // and from large bays still holding containers from older saves.
  const load = (b: Bay) =>
    cratesAt(b) / bayCap(b) + b.boxes.length / (b.yard ? bayCap(b) : B.TRUCK_CAPACITY);
  const bays = [...w.bays.values(), ...w.yards.values()]
    .filter((b) => {
      // Only where there is cargo no truck is already coming for.
      if (unclaimed(w, b, false) <= 0 && unclaimed(w, b, true) <= 0) return false;
      if (w.tick < b.nextTruckTick) return false;
      if (w.loadingDocks(b).length === 0) {
        cutOff(w, b);
        return false;
      }
      // With every spot taken, more trucks queue in the parking, a few at a
      // time; a pickup pulls up beside a truck bay instead.
      if (freeDock(w, b) >= 0 || freeDock(w, b, true) >= 0) return true;
      return queuedAt(w, b) < w.loadingDocks(b).length && !!w.freeParking(b);
    })
    .sort((a, b) => load(b) - load(a) || a.idx - b.idx);

  for (const bay of w.bays.values()) {
    if (cratesAt(bay) >= bayCap(bay)) w.bayFullTicks += 10;
  }
  for (const bay of bays) {
    const from = arrival(w, bay.idx);
    if (!entryClear(w, from.tile)) continue;
    // Container trucks collect containers; big trucks only fit a large bay.
    const free = (h: (typeof firms)[number]) => (out.get(h.id) ?? 0) < h.terms.fleet;
    // A container truck goes only for a full load: as many cleared
    // containers as it carries that no other truck is coming for; or for
    // what there is, once that has been waiting a good while.
    const boxes = unclaimed(w, bay, true);
    const boxTruck = (h: (typeof firms)[number]) => free(h) && h.terms.cargo === 'container';
    const haulier =
      (boxes > 0
        ? (firms.find((h) => boxTruck(h) && boxes >= h.terms.capacity) ??
          (clearedFor(w, bay) >= B.PART_LOAD_WAIT ? firms.find(boxTruck) : undefined))
        : undefined) ??
      (unclaimed(w, bay, false) > 0
        ? firms.find(
            (h) => free(h) && !h.terms.cargo && (bay.large || h.terms.capacity <= B.TRUCK_CAPACITY),
          )
        : undefined);
    if (!haulier) {
      if (firms.some((h) => (h.returns?.length ?? 0) > 0)) tip(w, 'roundTrip');
      const stuck = firms.some(
        (h) => h.terms.capacity > B.TRUCK_CAPACITY && (out.get(h.id) ?? 0) < h.terms.fleet,
      );
      if (stuck && !w.warnedBigTrucks && ![...w.bays.values()].some((b) => b.large)) {
        w.warnedBigTrucks = true;
        message(w, 'Big trucks need a large truck bay. Build one so they can collect.', 'bad');
      }
      const boxTrucks = firms.some((h) => h.terms.cargo === 'container');
      if (bay.yard && !boxTrucks && !w.warnedBoxTrucks) {
        w.warnedBoxTrucks = true;
        message(w, 'Containers are piling up in the yard. Sign a container haulier.', 'bad');
      }
      continue;
    }
    // A container truck goes on to a yard only when its gantry or a free
    // reach stacker is there to load it; otherwise it waits in parking
    // inside the port, or is not sent yet.
    const boxy = haulier.terms.cargo === 'container';
    const pickup = !!haulier.terms.pickup;
    const served = !boxy || w.handlerFree(bay);
    const len = B.truckLength(haulier.terms.capacity, boxy);
    const to = dockFor(
      w,
      bay,
      (d, avoid) => w.drivePath(from.tile, -1, d, avoiding(w, truckCostFor(w, bay.idx), avoid)),
      len,
      pickup,
    );
    // No way to any free spot at all, rather than only past a truck there:
    // not sent, even to wait, as none could ever load there. Free for a
    // truck as long as this one: with none, dockFor tried no way at all.
    if (!to && !w.dockRouted && w.freeDockSet(bay, len, pickup).size > 0) {
      cutOff(w, bay, w.dockTurn);
      continue;
    }
    const spot = served && to ? to.dock : -1;
    // Waiting for a reach stacker, as for a spot, only a few queue in the parking.
    if (spot < 0 && queuedAt(w, bay) >= w.loadingDocks(bay, pickup).length) continue;
    const wide = needsWideSpace(haulier.terms.capacity, boxy);
    const space = spot >= 0 ? null : w.freeParking(bay, false, wide);
    // A bay beside it may have just sent a truck to the spot they share.
    if (spot < 0 && !space) continue;
    const into = space ? intoSpace(w, from.tile, space, bay.idx) : null;
    // The parking is at fault, not the bay: no way into it the way it runs.
    if (space && !into) {
      noWayIn(w, space);
      continue;
    }
    const path = space ? (into?.path ?? null) : (to?.path ?? null);
    const dock = path && path.length > 0 ? path[path.length - 1] : spot;
    if (!path) {
      cutOff(w, bay);
      continue;
    }
    bay.noAccess = false;
    out.set(haulier.id, (out.get(haulier.id) ?? 0) + 1);
    const truck: Truck = {
      id: w.nextId++,
      contractId: haulier.id,
      company: haulier.terms.name,
      capacity: haulier.terms.capacity,
      x: m.xOf(from.tile) + 0.5,
      y: m.yOf(from.tile) + 0.5,
      dir: from.dir,
      path,
      goal: dock,
      state: space ? 'toPark' : 'toBay',
      park: space?.tiles[0],
      parkFrom: into?.via,
      lot: space?.tiles,
      bayIdx: bay.idx,
      cargo: 0,
      value: 0,
      boxes: haulier.terms.cargo === 'container',
      ...(pickup ? { pickup } : {}),
      idle: 0,
      timer: 0,
      variant: haulier.terms.color,
    };
    w.trucks.push(truck);
  }
}

/** No truck can get to this bay: say so once, and try again in a while. */
export function cutOff(w: World, bay: Bay, turn = false): void {
  const what = bay.yard ? 'container yard' : bay.tiles ? 'crate storage area' : 'truck bay';
  const why = turn
    ? `Trucks could get to this ${what} but not drive away again: they never turn about on a road one tile wide. Give them a way on, a junction, or a block of road two wide to turn in.`
    : bay.tiles
      ? `Trucks cannot reach this ${what}: they load storage from inside the port, from a port road or quay beside it through a port gate, not beside machines-only ground.`
      : `Trucks cannot reach this ${what}: it needs a public road to the highway, or port roads from a port gate.`;
  // Crate storage out of the trucks' way is a buffer the forklifts empty.
  if (!bay.noAccess && !bay.warehouse) message(w, why, 'bad');
  bay.noAccess = true;
  bay.noAccessWhy = why;
  bay.nextTruckTick = w.tick + 100;
}

export function updateTruck(w: World, t: Truck): void {
  const bay = dest(w, t.bayIdx);
  switch (t.state) {
    case 'toPark': {
      const cost = truckCostFor(w, t.bayIdx, -1, t);
      const r = w.move(t, cost, false, pace(w, t, cost), mayEnter(w, t), truckReroute(w, t));
      if (r === 'blocked' || w.map.build[t.park ?? -1] !== Build.Parking) {
        return removeTruck(w, t);
      }
      if (r === 'arrived') {
        t.state = 'parked';
        t.idle = 0;
        // Only the space it is in now, not the one it came from too.
        const space = spaceAt(w, t.park);
        if (space) t.lot = space.tiles;
        parkUp(w, t);
        // A shipper's truck has its paperwork done while it waits; the
        // cannery's, from the town, have their export papers done inside
        // the port instead, crate by crate in storage.
        if (t.exports && t.papers === undefined) {
          t.papers = w.tick + (cannedTruck(w, t) ? 0 : B.PAPERWORK_TICKS);
        }
      }
      return;
    }
    case 'parked': {
      if (t.exports) {
        if (w.tick < (t.papers ?? 0) || (w.tick + t.id) % 10 !== 0) return;
        const to = w.exportStore(t);
        if (!to) {
          if (!w.outgoingRoom(t)) outgoingFull(w, t.boxes);
          else stageNearer(w, t);
          return;
        }
        // Containers wait parked until the yard's gantry or a stacker is free.
        if (t.boxes && !w.handlerFree(to.store, t)) return;
        // One waiting in parking near the storage takes the spot before one
        // far off outside the port, which moves nearer itself instead.
        if (t.staged === undefined && stagedFor(w, to.store, t)) return stageNearer(w, t);
        to.store.exportIncoming = (to.store.exportIncoming ?? 0) + t.cargo;
        t.bayIdx = to.store.idx;
        t.park = undefined;
        t.staged = undefined;
        t.path = to.path;
        t.goal = to.dock;
        t.state = 'toBay';
        return;
      }
      // Parked until a loading spot comes free, or there is nothing to wait for.
      if (!bay || w.map.build[t.park ?? -1] !== Build.Parking) return leavePark(w, t);
      if ((w.tick + t.id) % 10 !== 0) return;
      if (w.collectable(bay) === 0 && (t.idle += 10) >= B.TRUCK_GIVE_UP) {
        return leavePark(w, t);
      }
      // A yard no truck can load at and drive away from again: it goes.
      if (bay.noAccess) return leavePark(w, t);
      if (t.boxes && !w.handlerFree(bay, t)) return;
      const to = dockFor(
        w,
        bay,
        (d, avoid) => w.routeFrom(t, d, avoiding(w, truckCostFor(w, bay.idx, -1, t), avoid)),
        lengthOf(w, t),
        !!t.pickup,
      );
      if (!to) {
        // No free spot it could get to and drive away from again: it
        // gives up in a while, and the bay shows why.
        if (!w.dockRouted && w.freeDockSet(bay, lengthOf(w, t), !!t.pickup).size > 0) {
          cutOff(w, bay, w.dockTurn);
          leavePark(w, t);
        }
        return;
      }
      const { dock, path } = to;
      t.park = undefined;
      t.path = path;
      t.goal = dock;
      t.state = 'toBay';
      return;
    }
    case 'toBay': {
      if (!bay) return t.exports ? w.headOut(t) : w.truckLeave(t);
      if (t.backing) {
        if (backIn(w, t, bay)) t.state = t.exports ? 'delivering' : 'loading';
        return;
      }
      if (bay.tiles && (w.tick + t.id) % 10 === 0) goDeeper(w, t, bay);
      const cost = truckCostFor(w, t.bayIdx, -1, t);
      const r = w.move(t, cost, false, pace(w, t, cost), mayEnter(w, t), truckReroute(w, t));
      if (r === 'blocked') {
        if (t.exports) bay.exportIncoming = Math.max(0, (bay.exportIncoming ?? 0) - t.cargo);
        return removeTruck(w, t);
      }
      if (r === 'arrived') t.state = t.exports ? 'delivering' : 'loading';
      else if (r === 'moving') startBacking(w, t, bay);
      return;
    }
    case 'delivering': {
      // Unloading a shipper's goods into storage, for the ships.
      if (!bay) return w.headOut(t);
      // Crates come off by hand, dockhands' and forklifts': ice into a
      // truck bay, the rest into storage. It waits till they have it empty.
      if (byHand(w, t, bay)) {
        if (t.cargo <= 0 && (t.taking ?? 0) === 0) {
          if (!iceTruck(w, t)) tip(w, 'exports');
          w.headOut(t);
        }
        return;
      }
      // Containers at a yard with no gantry come off by reach stacker.
      if (byStacker(w, t, bay)) {
        if (t.cargo <= 0) {
          tip(w, 'exports');
          w.headOut(t);
        }
        return;
      }
      if (gantryElsewhere(w, t, bay)) return;
      if (bay.gantryOn === t.id) {
        // Off the truck onto the gantry's spreader: it may go on its way
        // now, while the gantry carries it along and sets it down.
        if (!liftTaken(w, bay)) return;
        offToGantry(w, bay, {
          by: t.id,
          at: w.gantryLane(bay)?.get(t.goal) ?? 0,
          slot: t.cargo - 1,
          fees: [t.value],
          looks: [boxLookOf(t.id, t.cargo - 1)],
          exports: true,
          planned: 1,
        });
      } else {
        if (++t.timer % truckTicks(w, t, bay) !== 0) return;
        exportLooks(w, bay).push(boxLookOf(t.id, t.cargo - 1));
        (bay.outBoxes ??= []).push(t.value);
        bay.exportIncoming = Math.max(0, (bay.exportIncoming ?? 0) - 1);
      }
      if (--t.cargo <= 0) {
        tip(w, 'exports');
        w.headOut(t);
      }
      return;
    }
    case 'loading': {
      if (!bay) return w.truckLeave(t);
      const every = truckTicks(w, t, bay);
      if (t.cargo < t.capacity && gantryElsewhere(w, t, bay)) return;
      if (bay.gantryOn === t.id ? !liftDone(w, bay) : ++t.timer % every !== 0) return;
      gantryDone(w, bay, t.id);
      // Containers at a yard with no gantry go on by reach stacker: it
      // waits while one is on its way.
      // With nothing more here for it, it goes with what it has rather
      // than wait for more.
      const none = () =>
        unclaimed(w, bay, t.boxes, t) <= 0 || (!t.boxes && cratesFor(w, t, bay) <= 0);
      const done = (t.coming ?? 0) === 0 && none();
      // Crates go on by hand: dockhands and forklifts load it, as
      // containers at a yard with no gantry go on by reach stacker.
      const hands = byHand(w, t, bay);
      if (byStacker(w, t, bay) || hands) {
        if ((t.coming ?? 0) > 0) t.idle = 0;
        else t.idle += every;
        // By hand one layer; two where forklifts load it too.
        const full = t.cargo >= (hands ? bedCap(w, t) : t.capacity);
        // With crates there for it, it waits as long as it would for any;
        // its bottom layer full, only while a forklift is coming to put
        // another on top.
        const lifting = w.people.some((q) => isMachine(q) && q.truckId === t.id);
        const waiting = hands && cratesFor(w, t, bay) > 0 && (!bottomFull(w, t) || lifting);
        const bored =
          t.cargo > 0 && !waiting ? t.idle >= B.TRUCK_PATIENCE : t.idle >= B.TRUCK_GIVE_UP;
        // Loaded by hand, it takes all there is for it before the trucks
        // behind it, and waits a while for crates being carried here: it
        // goes as full as it can.
        // Not a pickup in front of another bay, though: it is in the way there.
        const inWay = t.pickup && !!frontFor(w, t.goal, bay);
        const empty =
          (t.coming ?? 0) === 0 && cratesFor(w, t, bay) <= 0 && ((bay.incoming ?? 0) <= 0 || inWay);
        if (full || bored || (hands ? empty : done)) w.truckLeave(t);
        return;
      }
      const stock = bay.boxes;
      // Containers only once customs have cleared them, whichever those
      // are: under a gantry, the one it took up.
      const lifted = t.lifting === undefined ? -1 : boxLooks(w, bay).indexOf(t.lifting);
      t.lifting = undefined;
      // Crates off the top of the stack.
      const at =
        t.boxes && bay.yard
          ? lifted >= 0
            ? lifted
            : clearTop(w, bay)
          : t.boxes
            ? 0
            : cratesAt(bay) - 1;
      // Crates its crew loads besides those dockhands and forklifts bring
      // it: none they are on their way for, nor more than it has room for
      // with theirs.
      const spare = t.boxes ? stock.length : cratesFor(w, t, bay);
      const coming = t.boxes ? 0 : (t.coming ?? 0);
      if (coming > 0) t.idle = 0;
      if (spare > 0 && at >= 0 && t.cargo + coming < t.capacity) {
        if (t.boxes && bay.yard) yardSlots(w, bay).boxes.splice(at, 1);
        if (t.boxes && bay.yard) readyList(w, bay).splice(at, 1);
        if (t.boxes && bay.yard) (t.looks ??= []).push(boxLooks(w, bay).splice(at, 1)[0]);
        const fee = t.boxes ? stock.splice(at, 1)[0] : cratesOff(w, t, bay, at, 1)[0];
        t.value += fee;
        if (!t.boxes) (t.fees ??= []).push(fee);
        t.cargo++;
        t.idle = 0;
      } else {
        t.idle += every;
      }
      const full = t.cargo >= t.capacity;
      const bored = t.cargo > 0 ? t.idle >= B.TRUCK_PATIENCE : t.idle >= B.TRUCK_GIVE_UP;
      if (full || bored || (done && none())) w.truckLeave(t);
      return;
    }
    case 'toTown': {
      if (t.round) {
        if (driveRound(w, t)) t.round = undefined;
        return;
      }
      const cost = truckCostFor(w, t.goal, t.bayIdx);
      const r = w.move(t, cost, false, pace(w, t, cost), mayEnter(w, t), truckReroute(w, t));
      if (r === 'blocked') {
        // What it was bringing them is wanted still.
        const town = w.town;
        const stops =
          t.drop === undefined ? [] : [{ code: w.map.build[t.drop], count: t.dropCount ?? 0 }];
        for (const s of town ? [...stops, ...(t.stops ?? [])] : []) {
          town!.wants[s.code] = (town!.wants[s.code] ?? 0) + s.count;
        }
        t.stops = undefined;
        w.headOut(t);
      } else if (r === 'arrived' && t.then && w.town) {
        // Out on the highway: round past the edge of the map and in on the town's road.
        const m = w.map;
        const gate = w.town.gate;
        const ey = m.yOf(m.entry) + 0.5;
        const gy = m.yOf(gate) + 0.5;
        t.round = [HIGHWAY_X, ey, HIGHWAY_X, gy, m.xOf(gate) + 0.5, gy];
        t.path = t.then;
        t.goal = t.then.length > 0 ? t.then[t.then.length - 1] : gate;
        t.then = undefined;
      } else if (r === 'arrived') {
        t.state = 'unloading';
        t.timer = 0;
      }
      return;
    }
    case 'unloading': {
      const n = t.dropCount ?? 0;
      if (++t.timer < n * B.UNLOAD_TICKS) return;
      // Just the crates the business takes come off; the rest go on by road.
      const code = w.map.build[t.drop ?? -1];
      const def = BUSINESSES[code];
      const fees = t.fees ?? [];
      const off: number[] = [];
      if (!t.boxes && def) {
        // Off the top of the bed first.
        const picks: number[] = [];
        for (const i of topFirst(w, t)) {
          if (picks.length < n && def.takes.includes(cargoOf(fees[i]))) picks.push(i);
        }
        offBed(w, t, picks);
        for (const i of [...picks].sort((a, b) => b - a)) off.push(...fees.splice(i, 1));
      }
      const got = t.boxes ? n : off.length;
      // Fewer than were kept for it: the rest are wanted still.
      if (got < n && w.town) w.town.wants[code] = (w.town.wants[code] ?? 0) + n - got;
      const worth = t.boxes ? (t.value * n) / Math.max(1, t.cargo) : off.reduce((a, f) => a + f, 0);
      // The town pays a little extra for goods brought to its door.
      const bonus = Math.round(worth * B.TOWN_DELIVERY_BONUS);
      if (bonus > 0) {
        book(w, 'town', bonus);
        w.stats.earned += bonus;
        moneyAt(w, bonus, t.drop ?? w.tileOf(t));
      }
      if (w.town) w.town.local += t.boxes ? got * B.CONTAINER_GOODS : got;
      t.value -= Math.round(worth);
      t.cargo -= got;
      // On to the next business that takes some of the rest, else away.
      if (t.cargo > 0 && nextStop(w, t)) return;
      t.stops = undefined;
      w.headOut(t);
      return;
    }
    case 'leaving': {
      const cost = truckCostFor(w, t.goal, t.bayIdx, t);
      const r = w.move(t, cost, false, pace(w, t, cost), mayEnter(w, t), truckReroute(w, t));
      if (r === 'arrived' || r === 'blocked') removeTruck(w, t);
      return;
    }
  }
}

/**
 * Where a truck steers for the next `n` tiles of its way: the middle of
 * each, but through a jog, two corners one after the other turning one
 * way and then back as from one lane to the next, across the corners at
 * 45 degrees, from the edge it comes into the first by to the edge it
 * leaves the last by, rather than square round both; a staircase of them
 * all the way in one straight line. Each point says whether reaching it
 * passes a tile of the way: the edge it comes into a jog by passes none.
 */
export function steerPoints(
  world: World,
  a: Agent,
  n: number,
): { x: number; y: number; passes: boolean }[] {
  const m = world.map;
  const w = m.w;
  const path = a.path;
  const step = (from: number | undefined, to: number | undefined) => {
    if (from === undefined || to === undefined || from < 0 || to < 0) return 0;
    const d = to - from;
    return d === 1 || d === -1 || d === w || d === -w ? d : 0;
  };
  const mid = (i: number) => ({ x: (i % w) + 0.5, y: Math.floor(i / w) + 0.5 });
  const edge = (p: number, q: number) => {
    const a0 = mid(p);
    const b0 = mid(q);
    return { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
  };
  const before = (k: number, back: number): number | undefined => {
    const j = k - back;
    if (j >= 0) return path[j];
    return a.trail?.[2 + j];
  };
  const out: { x: number; y: number; passes: boolean }[] = [];
  for (let k = 0; k < Math.min(n, path.length); k++) {
    const t = path[k];
    const p = before(k, 1);
    const din = step(p, t);
    const dout = step(t, path[k + 1]);
    const corner = din !== 0 && dout !== 0 && dout !== din && dout !== -din;
    // Turning back the way it went before the last corner, on from a
    // jog's diagonal; or about to, at the next tile.
    const stair = corner && step(before(k, 2), p) === dout;
    const ahead = corner && step(path[k + 1], path[k + 2]) === din;
    if (stair || ahead) {
      if (!stair) {
        // Onto the diagonal at the edge it comes in by, unless past it.
        const e = edge(p!, t);
        const ux = din === 1 ? 1 : din === -1 ? -1 : 0;
        const uy = din === w ? 1 : din === -w ? -1 : 0;
        const past = k === 0 && (a.x - e.x) * ux + (a.y - e.y) * uy > -1e-6;
        if (!past) out.push({ ...e, passes: false });
      }
      out.push({ ...edge(t, path[k + 1]), passes: true });
    } else out.push({ ...mid(t), passes: true });
  }
  return out;
}

/**
 * How far a truck or port machine goes this tick, at most `top`: it gets
 * up to speed gradually, eases off in good time for a corner (the sharper
 * the slower), brakes to a stop at the end of its way rather than pulling
 * up dead, and keeps to what lets it stop within `room`, short of whatever
 * is ahead of it. With `stop` false it runs on off the end (off the map).
 */
export function drive(world: World, a: Agent, top: number, room = Infinity, stop = true): number {
  const w = world.map.w;
  const accel = top / B.VEHICLE_ACCEL_TICKS;
  const brake = top / B.VEHICLE_BRAKE_TICKS;
  // How fast it may go with `d` to go to where it must be down to `v`.
  const by = (v: number, d: number) => Math.sqrt(v * v + 2 * brake * Math.max(0, d));
  const sight = (top * top) / (2 * brake) + top;
  let want = Math.min(top, by(0, room));
  let x = a.x;
  let y = a.y;
  let heading = a.dir;
  let run = 0;
  // Where it steers, as move does: across the corner through a jog.
  const points =
    'contractId' in a
      ? steerPoints(world, a, Math.min(a.path.length, Math.ceil(sight) + 2))
      : a.path.map((i) => ({ x: (i % w) + 0.5, y: Math.floor(i / w) + 0.5, passes: true }));
  let k = 0;
  for (; k < points.length && run <= sight; k++) {
    const nx = points[k].x;
    const ny = points[k].y;
    const len = Math.hypot(nx - x, ny - y);
    const dir = len > 1e-6 ? Math.atan2(ny - y, nx - x) : heading;
    // A bend where this stretch meets the last. Into a jog's diagonal and
    // out of it, half a corner either way, it need not slow.
    if (k > 0 && len > 1e-6) {
      const bend = Math.abs(wrapAngle(dir - heading));
      const corner = top * Math.max(B.CORNER_SPEED, Math.cos(Math.min(bend, Math.PI / 2)));
      if (bend > Math.PI / 4 + 0.01) want = Math.min(want, by(corner, run));
    }
    run += len;
    x = nx;
    y = ny;
    heading = dir;
  }
  // Stopping at the end of the way, creeping the last bit.
  if (stop && k === points.length && points.length >= a.path.length) {
    want = Math.min(want, Math.max(by(0, run), top * 0.15));
  }
  const v = a.v ?? 0;
  a.v = want < v ? want : Math.min(want, v + accel);
  return a.v;
}
