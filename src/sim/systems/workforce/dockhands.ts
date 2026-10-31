// Dockhands and port machines: hiring them in, depots, fuel and repairs,
// walking and driving, each one's turn, and the jobs they take.

import type { World } from '../../world';
import { exportSources, loadSpot, takeExportJob, wantsLoad } from '../cargo/exports';
import {
  bayWithRoom,
  boxLooks,
  buried,
  buriedCount,
  carriedLooks,
  dropAt,
  dropRoom,
  freeYardSlot,
  nearerMachine,
  pickupSpots,
  reachFrom,
  readyList,
  servesYard,
  sourceValid,
  stackSides,
  takeFromSource,
  takesImports,
  truckable,
  workersAt,
  yardSlots,
  yardWithRoom,
} from '../cargo/stores';
import {
  cancelJob,
  dest,
  dropOutbound,
  dropValid,
  readyIn,
  releaseTarget,
  retargetCrate,
  startHolds,
} from '../cargo/customs';
import { mayEnter, toStopLine } from '../roads/traffic';
import { drive } from '../roads/trucks';
import { paceFactor } from '../../staff';
import type { Candidate } from '../../staff';
import type { Bay, Boat, Dockhand } from '../../state';
import * as B from '../../balance';
import {
  bayIncoming,
  bayRoom,
  craneStacks,
  isBoxy,
  isMachine,
  laneOf,
  needsCustoms,
} from '../../helpers';
import type { Source } from '../../helpers';
import { MACHINES, parkPoses } from '../../machines';
import type { ParkPose } from '../../machines';
import { Build, isBay } from '../../types';
import type { MachineKind } from '../../types';
import { MACHINE_TIER, TIERS } from '../../tiers';
import { longCarry, message, moneyAt, nag, tip } from '../output';
import { machinePlacementError, walkableAt } from '../../rules/placement';
import { book } from '../economy';
import {
  changeMorale,
  goOnBreak,
  handlingTicks,
  headingTo,
  laneFree,
  resolveHold,
  resolveJam,
  roomAhead,
  seatAtHut,
  tire,
  workingAt,
} from './crowding';
import { frontOf, gantryRails } from '../../rules/footprint';
import { cranePlaces, craneTop, customsFor, dueAt, shipFor } from '../cranes';
import type { CostFn } from '../../path';
import {
  bayTaken,
  crateTruckJob,
  crateTruckSources,
  straightOnto,
  takeCrateTruckJob,
  takeTruckJob,
  truckJob,
  truckSources,
} from '../truckLoading';
import {
  cleanSlot,
  craneSpot,
  gantryDone,
  gantryFor,
  offToGantry,
  palletPlaces,
  palletTile,
  pickPallet,
  stackedAt,
  toPallet,
} from '../yardGantry';
import { cargoOf } from '../../cargo';
import { pickTile } from '../boats/berthing';
import { WORKING } from '../../helpers';

export function spawnDockhand(w: World, at: number, c: Candidate): Dockhand {
  const p: Dockhand = {
    id: w.nextId++,
    kind: 'dockhand',
    name: c.name,
    skill: c.skill,
    trait: c.trait,
    wage: c.wage,
    energy: 100,
    morale: B.START_MORALE,
    hutIdx: -1,
    lowMoraleDays: 0,
    raiseAsk: 0,
    capacity: 1,
    needsRepair: false,
    home: -1,
    fuel: 100,
    depotTask: null,
    blocked: 0,
    squeeze: false,
    x: w.map.xOf(at) + 0.5,
    y: w.map.yOf(at) + 0.5,
    dir: 0,
    path: [],
    goal: at,
    state: 'idle',
    timer: 0,
    carrying: 0,
    cargoFees: [],
    planned: 0,
    boatId: -1,
    craneIdx: -1,
    stockIdx: -1,
    bayIdx: -1,
    toBoat: -1,
    toCrane: -1,
  };
  w.people.push(p);
  return p;
}

/** Places left in a depot; a reach stacker takes two (see MACHINES). */
export function depotRoom(w: World, depot: number): number {
  let used = 0;
  for (const q of w.people)
    if (q.home === depot && isMachine(q)) used += MACHINES[q.kind as MachineKind].room;
  return B.DEPOT_SLOTS - used;
}

/** Buy a forklift at a depot: the one at `tile`, or any with room. */
export function buyMachine(w: World, kind: MachineKind, tile?: number): void {
  if (w.tier < MACHINE_TIER[kind]) {
    return message(
      w,
      `${MACHINES[kind].label}s unlock at the ${TIERS[MACHINE_TIER[kind]].name}.`,
      'bad',
    );
  }
  let depot = tile ?? -1;
  if (tile === undefined) {
    for (let i = 0; i < w.map.build.length && depot < 0; i++) {
      if (w.map.build[i] === Build.Depot && depotRoom(w, i) >= MACHINES[kind].room) {
        depot = i;
      }
    }
    if (depot < 0) return message(w, 'Build a forklift depot first. Forklifts live there.', 'bad');
  } else {
    const err =
      tile >= 0 && tile < w.map.build.length ? machinePlacementError(w.map, tile) : 'Off the map';
    if (err) return message(w, err, 'bad');
  }
  if (depotRoom(w, depot) < MACHINES[kind].room) {
    return message(
      w,
      `That depot is full. Each houses ${B.DEPOT_SLOTS} forklifts or tractors, a reach stacker taking two places.`,
      'bad',
    );
  }
  const spec = MACHINES[kind];
  if (w.cash < spec.price) return message(w, 'Not enough money', 'bad');
  book(w, 'construction', -spec.price);
  const p = spawnDockhand(w, depot, {
    id: 0,
    name: `${spec.label} ${w.people.filter((q) => q.kind === kind).length + 1}`,
    skill: 3,
    trait: null,
    wage: spec.wage,
  });
  p.kind = kind;
  p.capacity = spec.capacity;
  tip(w, kind === 'forklift' ? 'forklifts' : kind === 'tractor' ? 'tractors' : 'stackers');
  p.home = depot;
  moneyAt(w, -spec.price, depot);
  message(w, `A new ${spec.label.toLowerCase()} is ready at the depot.`, 'good');
}

/**
 * Where each machine standing in its depot is parked, side by side in
 * the garage, out of each other's way (see parkPoses): by id, for the
 * view. The game has them in the middle of the tile.
 */
export function parkedPoses(w: World): Map<number, ParkPose> {
  const out = new Map<number, ParkPose>();
  const homes = new Map<number, Dockhand[]>();
  for (const q of w.people) {
    if (!isMachine(q) || q.home < 0 || w.map.build[q.home] !== Build.Depot) continue;
    homes.set(q.home, [...(homes.get(q.home) ?? []), q]);
  }
  for (const [depot, fleet] of homes) {
    fleet.sort((a, b) => a.id - b.id);
    const m = w.map;
    const poses = parkPoses(
      fleet.map((q) => q.kind as MachineKind),
      m.xOf(depot),
      m.yOf(depot),
      m.orient[depot] & 3,
    );
    fleet.forEach((q, k) => {
      if (q.path.length === 0 && w.tileOf(q) === depot) out.set(q.id, poses[k]);
    });
  }
  return out;
}

/** Send a forklift home for fuel, repairs or to park. False if it cannot get there. */
export function goToDepot(w: World, p: Dockhand, task: 'refuel' | 'repair' | 'park'): boolean {
  if (p.home < 0 || w.map.build[p.home] !== Build.Depot) p.home = findDepot(w, p);
  if (p.home < 0 || !headTo(w, p, p.home)) return false;
  p.depotTask = task;
  p.state = 'toDepot';
  return true;
}

/** A depot with room this forklift can reach, for one whose home is gone. */
export function findDepot(w: World, p: Dockhand): number {
  for (let i = 0; i < w.map.build.length; i++) {
    if (w.map.build[i] !== Build.Depot || depotRoom(w, i) < MACHINES[p.kind as MachineKind].room) {
      continue;
    }
    if (w.pathFor(p, w.tileOf(p), i)) return i;
  }
  return -1;
}

export function updateForkliftAtRest(w: World, p: Dockhand): boolean {
  if (p.needsRepair) {
    p.needsRepair = false;
    p.path = [];
    // Routine: the machine says so when picked, and shows a warning sign.
    if (goToDepot(w, p, 'repair')) return true;
    // No depot to reach: a mechanic comes out, at double the price.
    startRepair(w, p, B.REPAIR_COST * 2);
    nag(
      w,
      'callout',
      `${p.name} has broken down with no depot to reach. Mechanic called out at double the price.`,
      'bad',
    );
    return true;
  }
  if (p.fuel < B.LOW_FUEL && goToDepot(w, p, 'refuel')) return true;
  return false;
}

export function startRepair(w: World, p: Dockhand, cost: number): void {
  p.state = 'broken';
  p.timer = B.REPAIR_TICKS;
  book(w, 'maintenance', -cost);
  moneyAt(w, -cost, w.tileOf(p));
}

/** Into and out of a depot only through its door, from the tile it faces, not through its walls. */
export function throughDoor(w: World, i: number, from: number | undefined): boolean {
  if (from === undefined || from < 0 || from === i) return true;
  const m = w.map;
  if (m.build[i] === Build.Depot && frontOf(m, i, m.orient[i] & 3) !== from) return false;
  return m.build[from] !== Build.Depot || frontOf(m, from, m.orient[from] & 3) === i;
}

/**
 * The quay with containers on it that a gantry crane has set down: on the
 * shipside row the length of its rails, which the machines work from the
 * row behind. Where none stand yet they drive freely.
 * Once a tick.
 */
export function craneStackTiles(w: World): Set<number> {
  if (w.craneStackCache?.tick !== w.tick) {
    const m = w.map;
    const at = new Set<number>();
    for (const c of w.cranes.values()) {
      if (c.kind !== 'gantry') continue;
      const rails = gantryRails(m, c.idx, m.orient[c.idx] & 3);
      const { stack, out } = cranePlaces(w, c);
      for (const k of [...stack, ...out]) {
        const t = k < 0 ? -1 : rails[((k % craneStacks(c)) % B.GANTRY_RAILS) * 2];
        if (t >= 0) at.add(t);
      }
    }
    w.craneStackCache = { tick: w.tick, at };
  }
  return w.craneStackCache.at;
}

export function costFor(w: World, p: Dockhand): CostFn {
  return isMachine(p) ? w.driveCost : w.walkCost;
}

/** Where new staff report for work and lost staff are taken back to. */
export function muster(w: World): number {
  const bay = [...w.bays.keys()].find((b) => isBay(w.map.build[b]));
  if (bay !== undefined) return bay;
  for (let i = 0; i < w.map.build.length; i++) if (walkableAt(w.map, i)) return i;
  return w.map.entry;
}

/**
 * Someone standing where they no longer may (the path under them was
 * bulldozed, or an old save had them on the grass) is taken back to the
 * truck bay, or a forklift to its depot.
 */
export function rescue(w: World, p: Dockhand): boolean {
  // A machine a crane has just set a container down beside is not lost.
  const cost = isMachine(p) ? w.groundCost : costFor(w, p);
  if (Number.isFinite(cost(w.tileOf(p)))) return false;
  const at = isMachine(p) && p.home >= 0 ? p.home : muster(w);
  p.x = w.map.xOf(at) + 0.5;
  p.y = w.map.yOf(at) + 0.5;
  p.path = [];
  return true;
}

export function walk(w: World, p: Dockhand) {
  const before = w.tileOf(p);
  const laneBefore = laneOf(p.dir);
  const boxy = isBoxy(p);
  // A crane has set containers down on its way since it set off: it looks
  // again for a way round them, once for each such tile.
  const next = p.path[0];
  if (boxy && next !== undefined && next !== p.goal && next !== p.replanned) {
    if (craneStackTiles(w).has(next)) {
      p.replanned = next;
      const path = w.pathFor(p, before, p.goal);
      if (path) p.path = path;
    }
  }
  // Where another machine works, it waits its turn short of it; a reach
  // stacker or tractor otherwise keeps its distance in traffic (see
  // roomAhead), anyone else to their side of the tile.
  const junction = boxy ? mayEnter(w, p) : undefined;
  const enter = (i: number) =>
    !(boxy && i === p.goal && workingAt(w, i, p)) &&
    (junction ? p.squeeze || junction(i) : p.squeeze || laneFree(w, i, laneOf(headingTo(w, p, i))));
  let r: ReturnType<World['move']>;
  if (isMachine(p)) {
    // An empty tank still crawls home on the reserve.
    const top =
      p.kind === 'stacker'
        ? B.STACKER_SPEED
        : p.kind === 'tractor'
          ? B.TRACTOR_SPEED
          : B.FORKLIFT_SPEED;
    const speed = p.fuel > 0 ? top : top * 0.3;
    // A tractor finds a new way round as it drives, never turning about short.
    const repath = p.kind === 'tractor' ? () => w.pathFor(p, w.tileOf(p), p.goal) : undefined;
    const room = () =>
      boxy && !p.squeeze ? Math.min(roomAhead(w, p) - B.TRUCK_GAP, toStopLine(w, p)) : Infinity;
    const [x0, y0] = [p.x, p.y];
    r = w.move(p, w.driveCost, true, () => drive(w, p, speed, room()), enter, repath);
    // Held up behind something, it is waiting as at a tile it may not enter.
    if (r === 'moving' && p.x === x0 && p.y === y0) r = 'waiting';
  } else {
    const pace = paceFactor(p.skill, p.morale, p.energy);
    r = w.move(p, w.walkCost, true, () => w.walkSpeed() * pace, enter);
  }
  const after = w.tileOf(p);
  const laneAfter = laneOf(p.dir);
  if (isMachine(p) && (r === 'moving' || r === 'arrived')) {
    p.fuel = Math.max(0, p.fuel - B.FUEL_PER_TICK);
  }
  if (after !== before || laneAfter !== laneBefore) {
    const old = before * 4 + laneBefore;
    w.occupancy[old] = Math.max(0, w.occupancy[old] - 1);
    w.occupancy[after * 4 + laneAfter]++;
  }
  if (after !== before) {
    p.squeeze = false;
    // Only real progress clears the wait; shuffling within a tile does not.
    p.blocked = 0;
    p.came = before;
  }
  // Congestion is measured on working trips only, not strolls or breaks.
  const working = WORKING.has(p.state);
  if (r === 'waiting') {
    p.blocked++;
    if (working) w.jam.waiting++;
    if (boxy) resolveHold(w, p);
    else resolveJam(w, p);
  } else if (r === 'moving') {
    if (working) w.jam.moving++;
  } else {
    p.blocked = 0;
  }
  return r;
}

export function updateDockhand(w: World, p: Dockhand): void {
  if ((p.state === 'idle' || p.state === 'wander') && rescue(w, p)) return;
  if (tire(w, p)) return goOnBreak(w, p);
  if (p.truckId !== undefined && (isBoxy(p) ? truckJob(w, p) : crateTruckJob(w, p))) return;
  if (p.restack && restackJob(w, p)) return;
  switch (p.state) {
    case 'broken':
      if (--p.timer <= 0) {
        p.state = 'idle';
      }
      return;
    case 'toBreak': {
      if (w.map.build[p.hutIdx] !== Build.BreakHut) return goOnBreak(w, p);
      const r = walk(w, p);
      if (r === 'blocked') return goOnBreak(w, p);
      if (r === 'arrived') {
        seatAtHut(w, p);
        p.state = 'resting';
      }
      return;
    }
    case 'resting': {
      const inHut = p.hutIdx >= 0 && w.map.build[p.hutIdx] === Build.BreakHut;
      p.energy = Math.min(100, p.energy + (inHut ? B.HUT_REST : B.FLOOR_REST));
      if (p.energy >= 100) {
        if (inHut) changeMorale(w, p, B.MORALE_HUT_BREAK);
        p.hutIdx = -1;
        p.state = 'idle';
      }
      return;
    }
    case 'toDepot': {
      // Only driving home to park: work comes first.
      if (p.depotTask === 'park' && (w.tick + p.id) % 5 === 0 && assignJob(w, p)) {
        p.depotTask = null;
        return;
      }
      const r = walk(w, p);
      if (r === 'blocked' || w.map.build[p.home] !== Build.Depot) {
        p.state = 'idle';
        return;
      }
      if (r !== 'arrived') return;
      const task = p.depotTask;
      p.depotTask = null;
      if (task === 'repair') startRepair(w, p, B.REPAIR_COST);
      else if (task === 'refuel') p.state = 'refuelling';
      else p.state = 'idle';
      return;
    }
    case 'refuelling': {
      const add = Math.min(B.REFUEL_PER_TICK, 100 - p.fuel);
      p.fuel += add;
      book(w, 'maintenance', -(add / 100) * B.FUEL_COST);
      if (p.fuel >= 100) p.state = 'idle';
      return;
    }
    case 'idle':
    case 'wander': {
      if (isMachine(p) && updateForkliftAtRest(w, p)) return;
      if ((w.tick + p.id) % 5 === 0 && assignJob(w, p)) {
        p.stuck = null;
        return;
      }
      if (isMachine(p) && (w.tick + p.id) % 100 === 0) diagnose(w, p);
      // Idle forklifts go home to park instead of blocking the quay.
      if (isMachine(p) && p.state === 'idle') {
        p.timer++;
        if (p.timer > B.PARK_AFTER && w.tileOf(p) !== p.home) {
          p.timer = 0;
          goToDepot(w, p, 'park');
        }
        return;
      }
      if (p.state === 'wander') {
        const r = walk(w, p);
        if (r === 'arrived' || r === 'blocked') p.state = 'idle';
      } else if (p.kind === 'dockhand') {
        const roll = w.rng.next();
        // Standing about, not on top of the others.
        if ((w.tick + p.id) % 10 === 0 && crowded(w, p)) spreadOut(w, p);
        else if (roll < B.WANDER_CHANCE) wander(w, p);
      }
      return;
    }
    case 'toPickup': {
      if (!sourceValid(w, p)) return cancelJob(w, p);
      const r = walk(w, p);
      if (r === 'blocked') return cancelJob(w, p);
      if (r === 'arrived') {
        if (toPallet(w, p, w.bays.get(p.stockIdx), true)) return;
        p.state = 'picking';
        p.timer = handlingTicks(w, p, B.PICK_TICKS);
        // Which container off a crane's stack it takes, from the top as
        // it pulls up, whatever is set down beside it meanwhile.
        const crane = w.cranes.get(p.craneIdx);
        const top = crane && crane.kind !== 'jib' ? craneTop(w, crane, false, p) : -1;
        p.takeAt = top >= 0 ? cranePlaces(w, crane!).stack[top] : undefined;
        // A forklift's pallet in crate storage, whatever is set down meanwhile.
        const store = w.bays.get(p.stockIdx);
        if (p.kind === 'forklift' && store?.tiles) {
          p.takeAt = palletPlaces(w, store)[pickPallet(w, store, !!p.outbound, p)];
        }
      }
      return;
    }
    case 'picking': {
      // Waiting at a crane that has been taken down, it gives up.
      if (p.craneIdx >= 0 && !w.cranes.has(p.craneIdx)) return cancelJob(w, p);
      // At a yard, its gantry lifts for one at a time.
      if (!gantryFor(w, p)) return;
      if (--p.timer > 0) return;
      gantryDone(w, w.yards.get(p.stockIdx), p.id);
      const offBoat = p.craneIdx < 0 && p.stockIdx < 0 && p.boatId >= 0;
      const fees = takeFromSource(w, p);
      if (fees.length === 0) return cancelJob(w, p);
      // Fewer than planned: hand back the spare room in the bay.
      const bay = dest(w, p.bayIdx);
      if (bay && !(p.outbound && bay.tiles)) {
        bayIncoming(bay, isBoxy(p), -(p.planned - fees.length));
      }
      releaseTarget(w, p, p.planned - fees.length);
      p.planned = fees.length;
      p.carrying = fees.length;
      p.cargoFees = fees;
      if (p.toBoat !== undefined && p.toBoat >= 0) {
        const ship = w.boats.find((b) => b.id === p.toBoat);
        const spot = ship ? loadSpot(w, p, ship, w.tileOf(p)) : -1;
        if (spot < 0 || !headTo(w, p, spot)) retargetCrate(w, p);
        else p.state = 'toDrop';
        return;
      }
      if (p.toCrane !== undefined && p.toCrane >= 0) {
        const crane = w.cranes.get(p.toCrane);
        if (!crane || !headTo(w, p, craneSpot(w, p, crane, true))) retargetCrate(w, p);
        else p.state = 'toDrop';
        return;
      }
      const goal = bay ? dropAt(w, p, bay, w.tileOf(p)) : -1;
      if (goal < 0 || !headTo(w, p, goal)) return retargetCrate(w, p);
      p.state = 'toDrop';
      if (offBoat) longCarry(w, p.path.length);
      return;
    }
    case 'toDrop': {
      if (!dropValid(w, p)) return retargetCrate(w, p);
      const r = walk(w, p);
      if (r === 'blocked') return retargetCrate(w, p);
      if (r === 'arrived') {
        // The place its pallet goes in crate storage may have moved on
        // while it came: it goes on to it.
        if (toPallet(w, p, w.bays.get(p.bayIdx), false)) return;
        // One at a time at a truck bay: it waits its turn.
        const bay = w.bays.get(p.bayIdx);
        if (bay && bayTaken(w, p, bay)) return;
        p.state = 'dropping';
        p.timer = handlingTicks(w, p, B.DROP_TICKS);
      }
      return;
    }
    case 'dropping': {
      if (p.toCrane !== undefined && p.toCrane >= 0 && !w.cranes.has(p.toCrane)) {
        return retargetCrate(w, p);
      }
      if (!gantryFor(w, p)) return;
      if (--p.timer > 0) return;
      // Under a yard gantry, off the trailer onto its spreader: the tractor
      // goes on its way, and the gantry sets it down.
      const gy = w.yards.get(p.bayIdx);
      if (p.kind === 'tractor' && gy && gy.gantryOn === p.id && gy.gantryLift) {
        offToGantry(w, gy, {
          by: p.id,
          at: w.gantryLane(gy)?.get(p.goal) ?? 0,
          slot: 0,
          fees: p.cargoFees,
          looks: carriedLooks(w, p),
          from: p.cargoFrom,
          exports: !!p.outbound,
          planned: p.planned,
        });
        p.carrying = 0;
        p.cargoFees = [];
        p.cargoLooks = undefined;
        p.cargoFrom = undefined;
        p.planned = 0;
        p.bayIdx = -1;
        p.outbound = false;
        p.state = 'idle';
        return;
      }
      const gantryTo = gantryDone(w, gy, p.id);
      if (dropOutbound(w, p)) return;
      const bay = dest(w, p.bayIdx);
      if (!bay) return retargetCrate(w, p);
      const boxy = isBoxy(p);
      // Customs clear a container a while after it is stacked in the yard.
      // Their times go on first, while the list still matches the yard.
      if (boxy) {
        const from = p.cargoFrom ?? [];
        // A stacker sets it on a stack it reaches from where it stands; a
        // gantry where it kept for it.
        const clears = (k: number) => p.cargoReady?.[k] ?? customsFor(w, from[k]);
        if (p.kind === 'stacker' && bay.yard) {
          const slots = yardSlots(w, bay);
          p.cargoFees.forEach((_, k) => {
            slots.boxes.push(stackedAt(w, p, bay, clears(k)));
          });
        } else if (gantryTo !== undefined && p.cargoFees.length === 1) {
          yardSlots(w, bay).boxes.push(gantryTo);
        }
        readyList(w, bay).push(...p.cargoFees.map((_, k) => clears(k)));
        p.cargoFrom = undefined;
        p.cargoReady = undefined;
        boxLooks(w, bay).push(...carriedLooks(w, p));
        p.cargoLooks = undefined;
      }
      // A truck waiting at the bay: straight onto it.
      const onto = straightOnto(w, p, bay);
      // Brought for a truck that has gone meanwhile, they go on the stack
      // however full it is.
      if (onto) {
        onto.kind ??= cargoOf(p.cargoFees[0] ?? 0);
        onto.cargo += p.carrying;
        onto.value += p.cargoFees.reduce((n, f) => n + f, 0);
        (onto.fees ??= []).push(...p.cargoFees);
        onto.idle = 0;
      } else (boxy ? bay.boxes : bay.crates).push(...p.cargoFees);
      // Timber and goods wait in crate storage for customs.
      if (!onto && !boxy && !p.cleared) startHolds(w, bay, p.cargoFees, false);
      p.cleared = undefined;
      if (boxy) tip(w, 'customs');
      if (bay.pile) tip(w, 'landed');
      bayIncoming(bay, boxy, -p.planned);
      // Landed on the quay, a crate has not been handled yet.
      if (boxy) w.stats.containers += p.carrying;
      else if (!bay.pile) w.stats.cratesHandled += p.carrying;
      p.carrying = 0;
      p.cargoFees = [];
      p.planned = 0;
      p.bayIdx = -1;
      p.outbound = false;
      p.state = 'idle';
      return;
    }
  }
}

export function headTo(w: World, p: Dockhand, goal: number): boolean {
  const path = w.pathFor(p, w.tileOf(p), goal);
  if (!path) return false;
  p.path = path;
  p.goal = goal;
  return true;
}

/**
 * An idle machine works out whether it is cut off: from every truck bay,
 * or from cargo that is waiting. Forklifts only drive on port roads and
 * quays, which is easy to miss.
 */
export function diagnose(w: World, p: Dockhand): void {
  const here = w.tileOf(p);
  const boxy = isBoxy(p);
  const what = p.kind === 'tractor' ? 'Terminal tractors' : boxy ? 'Reach stackers' : 'Forklifts';
  const reach = (goal: number) => !!w.pathFor(p, here, goal);
  const sources: number[] = [];
  for (const c of w.cranes.values()) {
    if ((c.kind !== 'jib') === boxy && c.stack.length > 0) sources.push(pickTile(w, c));
  }
  // Crates an older game left on the quay, for the forklifts to take on.
  if (!boxy) for (const pile of w.piles.values()) if (pile.crates.length) sources.push(pile.idx);
  let stuck: string | null = null;
  const dests = [...(boxy ? w.yards : w.bays).values()].filter((d) => servesYard(w, p, d));
  const gantried = [...w.yards.values()].some((y) => w.yardGantry(y));
  if (p.kind === 'tractor' && dests.length === 0 && gantried) {
    stuck =
      "Can't work the yard gantries: tractors cannot turn about in a gantry's lane, so it needs a way on at both ends";
  } else if (p.kind === 'tractor' && dests.length === 0) {
    stuck = 'No container yard with a yard gantry to lift containers off and on';
  } else if (!dests.some((d) => dropAt(w, p, d, here) >= 0)) {
    stuck = boxy
      ? `Can't reach a container yard. ${what} only drive on port roads and quays`
      : `Can't reach a truck bay or crate storage. ${what} only drive on port roads and quays`;
  } else if (sources.length > 0 && !sources.some(reach)) {
    stuck = boxy
      ? "Can't reach the harbour crane. Connect it with quay or port roads"
      : "Can't reach the cargo. Forklifts can't drive on wooden jetties or port paths: use quays and port roads";
  }
  p.stuck = stuck;
  if (stuck && !w.warnedStuck) {
    w.warnedStuck = true;
    message(w, `${p.name}: ${stuck}.`, 'bad');
  }
}

/** Whether another dockhand stands within a step of this one, or it stands in a truck bay. */
export function crowded(w: World, p: Dockhand): boolean {
  const here = w.tileOf(p);
  const bay = w.map.build[here] === Build.TruckBay;
  if (bay) return true;
  return w.people.some(
    (q) =>
      q !== p &&
      q.kind === 'dockhand' &&
      (Math.hypot(q.x - p.x, q.y - p.y) < B.IDLE_ROOM || (bay && w.tileOf(q) === here)),
  );
}

/**
 * A dockhand with nothing to do walks a few steps off from the others,
 * and out of truck bays, to stand about on their own.
 */
export function spreadOut(w: World, p: Dockhand): void {
  const m = w.map;
  const [px, py] = [Math.floor(p.x), Math.floor(p.y)];
  const others = w.people.filter((q) => q !== p && q.kind === 'dockhand');
  // Where the others are, or are going.
  const spots = others.map((q) => {
    const g = q.path.length > 0 ? q.goal : w.tileOf(q);
    return [m.xOf(g) + 0.5, m.yOf(g) + 0.5];
  });
  const room = (x: number, y: number) =>
    Math.min(B.IDLE_ROOM * 2, ...spots.map(([ox, oy]) => Math.hypot(ox - x, oy - y)));
  let best = -1;
  // Off a truck bay anyway, out of the way of the trucks.
  let most = m.build[w.tileOf(p)] === Build.TruckBay ? -Infinity : room(p.x, p.y);
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const [x, y] = [px + dx, py + dy];
      if (!m.inBounds(x, y)) continue;
      const i = m.idx(x, y);
      // On a footpath, out of the way of the trucks and machines, and of
      // the spots on the quays and jetties where the work is.
      if (m.build[i] !== Build.Footpath) continue;
      if (!Number.isFinite(w.walkCost(i))) continue;
      // Nearer is better, as much room being equal.
      const r = room(x + 0.5, y + 0.5) - Math.hypot(dx, dy) * 0.05;
      if (r > most) [best, most] = [i, r];
    }
  }
  if (best < 0) return;
  const path = w.pathFor(p, w.tileOf(p), best);
  if (path && path.length <= 8) {
    p.path = path;
    p.goal = best;
    p.state = 'wander';
  }
}

export function wander(w: World, p: Dockhand): void {
  const x = Math.floor(p.x) + w.rng.int(-3, 3);
  const y = Math.floor(p.y) + w.rng.int(-3, 3);
  if (!w.map.inBounds(x, y)) return;
  const i = w.map.idx(x, y);
  if (!Number.isFinite(w.walkCost(i))) return;
  const path = w.pathFor(p, w.tileOf(p), i);
  if (path && path.length <= 8) {
    p.path = path;
    p.goal = i;
    p.state = 'wander';
  }
}

/**
 * Crane landing stacks first (they free the crane), then moored boats.
 * Only dockhands unload boats, carrying each crate straight into crate
 * storage or a truck bay: forklifts move crates on from storage the trucks
 * cannot reach, and take away what an older game left on the quay.
 */
export function assignJob(w: World, p: Dockhand): boolean {
  const here = w.tileOf(p);
  const cost = costFor(w, p);
  // Reach stackers handle containers, everyone else crates.
  const boxy = isBoxy(p);
  // Pallets an older game left need the forks of a forklift.
  const forks = p.kind === 'forklift';
  const hands = p.kind === 'dockhand';
  const sources: Source[] = [];
  for (const crane of w.cranes.values()) {
    if ((crane.kind !== 'jib') !== boxy) continue;
    if (crane.pallets && crane.stack.length > 0 && !forks) continue;
    // A tractor goes to a container crane working a ship too, or about to,
    // for the containers still to come off it for that crane: called
    // ahead, to be there as each is lifted (see dueAt).
    const ship = p.kind === 'tractor' ? (shipFor(w, crane)?.left ?? 0) : 0;
    const avail = crane.stack.length + ship - crane.reserved;
    if (avail > 0) sources.push({ tile: craneSpot(w, p, crane), avail, crane, rank: 0 });
  }
  if (hands) {
    for (const boat of w.boats) {
      const avail = boat.crates - boat.reserved;
      // Containers only come off a ship by crane.
      if (boat.vessel === 'feeder' || boat.state !== 'moored' || avail <= 0) continue;
      // Workers can unload from any dock tile alongside the boat.
      for (const tile of pickupSpots(w, boat)) sources.push({ tile, avail, boat, rank: 1 });
    }
  }
  // Crates an older game left on the quay: the forklifts take them on, or
  // the dockhands if there are none. Nothing sets any down there now.
  if (forks || (hands && !forklifts(w))) {
    for (const pile of w.piles.values()) {
      const avail = pile.crates.length - (pile.reserved ?? 0);
      if (avail <= 0 || (pile.pallets && !forks) || pile.out) continue;
      sources.push({ tile: pile.idx, avail, pile, rank: forks ? 0 : 2 });
    }
  }
  // Crates in storage the trucks cannot get to, by a crane say, are taken
  // on by forklift to storage or a truck bay they can.
  if (forks) {
    for (const store of w.bays.values()) {
      const avail = readyIn(w, store, false) - (store.reserved ?? 0);
      // A full load at a time: there is no boat waiting on it.
      if (!store.tiles || avail < p.capacity || truckable(w, store)) continue;
      // At the pallet it would take.
      sources.push({ tile: palletTile(w, store, true), avail, pile: store, rank: 1 });
    }
  }
  exportSources(w, p, here, sources);
  // Only stackers can lift a container onto a truck or off one.
  if (p.kind === 'stacker') truckSources(w, sources);
  if (p.kind === 'dockhand' || p.kind === 'forklift') crateTruckSources(w, sources);
  // The boat moored longest is unloaded first, however near another lies:
  // others only once its crates are all spoken for, or its spots taken.
  // A crate truck is loaded by whoever is nearest it, boats or no: one
  // standing at its bay sees it full before going back to the boats.
  // Exports count as long as the ship waiting for them has been alongside,
  // so a ship unloaded and waiting for its exports is not passed over.
  const loading = Math.max(-1, ...w.boats.filter((b) => wantsLoad(w, b)).map((b) => b.mooredTicks));
  const moored = (s: Source) => s.boat?.mooredTicks ?? (s.out ? loading : -1);
  const near = (s: Source) => !!s.truck && !s.truck.boxes && w.dist(here, s.tile) <= 2;
  const ordered = sources.sort(
    (a, b) =>
      a.rank - b.rank ||
      Number(near(b)) - Number(near(a)) ||
      moored(b) - moored(a) ||
      w.dist(here, a.tile) - w.dist(here, b.tile),
  );

  for (const src of ordered) {
    if (src.out) {
      if (takeExportJob(w, p, src, cost)) return true;
      continue;
    }
    if (src.truck) {
      if (isBoxy(p) ? takeTruckJob(w, p, src) : takeCrateTruckJob(w, p, src)) return true;
      continue;
    }
    if (!Number.isFinite(cost(src.tile))) continue;
    // Tractors are called to a container crane a ship is coming off in
    // time for each container; the foreman sends no more than two others
    // to the same spot, and the rest wait.
    if (p.kind === 'tractor' && src.crane && src.crane.kind !== 'jib') {
      if (!dueAt(w, p, src.crane, src.tile)) continue;
    } else if (workersAt(w, src.tile) >= B.WORKERS_PER_SPOT) continue;
    // A machine leaves the job to a free one nearer the pick-up.
    if (isMachine(p) && nearerMachine(w, p, src.tile)) continue;
    // Containers go to a container yard, crates to a truck bay or storage.
    // Timber and goods go through crate storage, for customs.
    const held =
      !boxy &&
      (src.boat
        ? needsCustoms(src.boat.fee)
        : src.crane
          ? src.crane.stack.some(needsCustoms)
          : !src.pile?.tiles && !!src.pile?.crates.some(needsCustoms));
    const bay = boxy
      ? yardWithRoom(w, p, src.tile)
      : src.boat
        ? landing(w, p, src.tile, held)
        : bayWithRoom(w, p, src.tile, !!src.pile?.tiles, held);
    if (!bay) {
      // The boat waits, and says why (see boatWhy).
      if (src.boat) noRoomFor(w, src.boat, held);
      else if (held) noCustomsStore(w);
      continue;
    }
    if (!headTo(w, p, src.tile)) continue;
    if (src.boat) src.boat.noRoom = undefined;
    const planned = Math.min(p.capacity, src.avail, dropRoom(w, bay, boxy));
    if (src.crane) src.crane.reserved += planned;
    if (src.boat) src.boat.reserved += planned;
    if (src.pile) src.pile.reserved = (src.pile.reserved ?? 0) + planned;
    bayIncoming(bay, boxy, planned);
    p.planned = planned;
    p.boatId = src.boat ? src.boat.id : -1;
    p.craneIdx = src.crane ? src.crane.idx : -1;
    p.stockIdx = src.pile ? src.pile.idx : -1;
    p.bayIdx = bay.idx;
    p.state = 'toPickup';
    return true;
  }
  // With nothing else to do, a stacker tidies the yards.
  return p.kind === 'stacker' && takeRestackJob(w, p, here);
}

/**
 * Send a stacker with time on its hands to restack a yard where a
 * container still in customs lies on one customs have cleared, which no
 * truck can get at until it is moved: it takes the one on top off and
 * sets it down where it buries nothing, in that yard or another with
 * room. Nearest first, and the stacks soonest cleared first.
 */
export function takeRestackJob(w: World, p: Dockhand, here: number): boolean {
  const yards = [...w.yards.values()].sort((a, b) => w.distTo(here, a) - w.distTo(here, b));
  for (const yard of yards) {
    if (!yard.tiles || buriedCount(w, yard) === 0) continue;
    const ready = readyList(w, yard);
    const slots = yardSlots(w, yard);
    for (const { at, tile } of buried(w, yard)) {
      const spot = stackSides(w, yard, yard.tiles[tile])
        .filter((s) => workersAt(w, s) === 0 && !w.spotTaken(s, p))
        .sort((x, y) => w.dist(here, x) - w.dist(here, y))
        .find((s) => w.pathFor(p, here, s));
      if (spot === undefined) continue;
      // Somewhere to set it down that buries nothing: here, or a yard with room.
      const rest = slots.boxes.filter((_, i) => i !== at);
      const clears = ready[at];
      const dest =
        freeYardSlot(w, yard, rest, slots.exports, clears, undefined, true) >= 0
          ? yard
          : yards.find(
              (b) =>
                b !== yard &&
                !!b.tiles &&
                bayRoom(b, true) > 0 &&
                takesImports(w, b) &&
                servesYard(w, p, b) &&
                freeYardSlot(w, b, ...slotLists(w, b), clears, undefined, true) >= 0 &&
                dropAt(w, p, b, spot) >= 0,
            );
      if (!dest || !headTo(w, p, spot)) continue;
      bayIncoming(dest, true, 1);
      p.restack = { yard: yard.idx, tile };
      p.bayIdx = dest.idx;
      p.planned = 1;
      p.boatId = -1;
      p.craneIdx = -1;
      p.stockIdx = -1;
      p.outbound = false;
      p.state = 'toPickup';
      return true;
    }
  }
  return false;
}

export function slotLists(w: World, b: Bay): [number[], number[]] {
  const { boxes, exports } = yardSlots(w, b);
  return [boxes, exports];
}

/**
 * A stacker restacking a yard: up to the stack, and the container off the
 * top of it, keeping when customs clear it; then it sets it down as any
 * other, where it buries nothing. True while it is at it.
 */
export function restackJob(w: World, p: Dockhand): boolean {
  const job = p.restack!;
  const yard = w.yards.get(job.yard);
  switch (p.state) {
    case 'toPickup': {
      if (!yard?.tiles) {
        cancelJob(w, p);
        return true;
      }
      const r = walk(w, p);
      if (r === 'blocked') cancelJob(w, p);
      else if (r === 'arrived') {
        p.state = 'picking';
        p.timer = handlingTicks(w, p, B.PICK_TICKS);
      }
      return true;
    }
    case 'picking': {
      if (--p.timer > 0) return true;
      const reach = yard ? reachFrom(w, yard, p.goal) : new Set<number>();
      const take = yard ? buried(w, yard).find((c) => reach.has(c.tile)) : undefined;
      if (!yard || !take) {
        cancelJob(w, p);
        return true;
      }
      const ready = readyList(w, yard);
      yardSlots(w, yard).boxes.splice(take.at, 1);
      p.cargoReady = ready.splice(take.at, 1);
      p.cargoLooks = boxLooks(w, yard).splice(take.at, 1);
      p.cargoFees = yard.boxes.splice(take.at, 1);
      p.cargoFrom = undefined;
      p.carrying = 1;
      p.restack = undefined;
      const target = dest(w, p.bayIdx);
      // Straight down where it stands if that buries nothing; else over to
      // where it does, or where it can.
      if (target === yard && cleanSlot(w, yard, p.goal, p.cargoReady[0]) >= 0) {
        p.state = 'dropping';
        p.timer = handlingTicks(w, p, B.DROP_TICKS);
        return true;
      }
      const goal = target ? dropAt(w, p, target, p.goal) : -1;
      if (target && goal >= 0 && headTo(w, p, goal)) {
        p.state = 'toDrop';
        return true;
      }
      if (target) bayIncoming(target, true, -1);
      bayIncoming(yard, true, 1);
      p.bayIdx = yard.idx;
      p.state = 'dropping';
      p.timer = handlingTicks(w, p, B.DROP_TICKS);
      return true;
    }
  }
  return false;
}

export function forklifts(w: World): boolean {
  return w.people.some((q) => q.kind === 'forklift');
}

/**
 * Where a dockhand takes what they lift off a boat from dock tile `t`:
 * into crate storage marked out right there, else carried straight on to
 * the nearest truck bay or crate storage for cargo coming in with room.
 * Never down on the quay: with nowhere to take it, the boat waits.
 */
export function landing(w: World, p: Dockhand, t: number, held = false): Bay | null {
  const store = w.bays.get(w.storeOf[t]);
  if (store && bayRoom(store, false) > 0 && takesImports(w, store)) return store;
  return bayWithRoom(w, p, t, false, held);
}

/**
 * The tiles a dockhand can walk from to some truck bay or crate storage
 * for cargo coming in, full or not: where a boat can be unloaded by hand
 * at all. Flooded out from the storage over the ground dockhands walk on,
 * once, until the port changes.
 */
export function landingReach(w: World): Uint8Array {
  if (w.landingCache) return w.landingCache;
  const m = w.map;
  const reach = new Uint8Array(m.build.length);
  const queue: number[] = [];
  for (const b of w.bays.values()) {
    if (b.tiles && b.outgoing) continue;
    for (const t of b.tiles ?? [b.idx]) {
      if (!walkableAt(m, t) || reach[t]) continue;
      reach[t] = 1;
      queue.push(t);
    }
  }
  for (let k = 0; k < queue.length; k++) {
    const t = queue[k];
    for (const n of m.neighbors4(t)) {
      // Walking the other way: from n onto t.
      if (reach[n] || !walkableAt(m, n) || !throughDoor(w, t, n)) continue;
      reach[n] = 1;
      queue.push(n);
    }
  }
  w.landingCache = reach;
  return reach;
}

/**
 * A boat the dockhands found nowhere to carry its crates into: it waits,
 * saying why (see boatWhy), and the player is told once in a while.
 */
export function noRoomFor(w: World, b: Boat, held: boolean): void {
  b.noRoom = held ? 'customs' : 'room';
  if (held) return noCustomsStore(w);
  const room = [...w.bays.values()].some((s) => takesImports(w, s) && dropRoom(w, s, false) > 0);
  nag(
    w,
    'noLanding',
    room
      ? 'Dockhands cannot walk from a boat to any truck bay or crate storage with room: they carry each crate straight there, and never set one down on the quay. Join the quay to them with footpaths or quay.'
      : 'Every truck bay and crate storage for cargo coming in is full: dockhands carry each crate straight into one, and never set one down on the quay, so the boats wait. Mark out more crate storage near the quay, or build more truck bays.',
    'bad',
  );
}

/**
 * Timber or goods with no crate storage for cargo coming in with room to
 * wait for customs in: say so, as the coasters cannot be unloaded.
 */
export function noCustomsStore(w: World): void {
  const room = [...w.bays.values()].some(
    (b) => b.tiles && takesImports(w, b) && bayRoom(b, false) > 0,
  );
  if (room) return;
  nag(
    w,
    'customsStore',
    'Timber and goods wait in crate storage for customs, and none has room: the coasters cannot be unloaded. Mark out more crate storage for cargo coming in.',
    'bad',
  );
}
