// What the view sees of the game each frame (see protocol/views.ts): the snapshot, and the words that explain why a boat, worker, truck, crane or berth is held up.

import type { World } from '../world';
import type { Boat, CargoStats, Crane, Dockhand, Truck } from '../state';
import * as B from '../balance';
import { walkableAt } from '../rules/placement';
import {
  activity,
  aligned,
  bayCap,
  bayRoom,
  boxLookOf,
  breachPenalty,
  cancelFee,
  craneStack,
  heldIn,
  isBoxy,
} from '../helpers';
import { Build } from '../types';
import { cargoOf } from '../cargo';
import type { Cargo } from '../cargo';
import { thought } from '../staff';
import { BUSINESSES, population, townHomes, townTarget } from '../town';
import { depotViews } from './output';
import type {
  BayView,
  ContractView,
  EntityView,
  ProblemView,
  Snapshot,
  StaffView,
} from '../../protocol/views';
import {
  canUpgrade,
  capacity,
  dailyFees,
  interestDue,
  tierWaitsOn,
  truckingWith,
  visitView,
  wageBill,
} from './economy';
import { businessViews, landmarkView, wantsView } from './townBusiness';
import { tugged } from './tugs';

/** What a ship coming in to its berth is doing: on its way, or waiting for one in its way to sail. */
export function arrivingWords(w: World, b: Boat): string {
  const o = b.waitingOn !== undefined && w.boats.find((q) => q.id === b.waitingOn);
  if (!o || (b.waitedFor ?? 0) <= B.BERTH_BLOCKED_TICKS) return 'Sailing to the jetty';
  const what = o.vessel === 'feeder' ? 'feeder ship' : o.vessel === 'coaster' ? 'coaster' : 'boat';
  return `Waiting for the ${o.company} ${what} moored in its way to sail`;
}

export function boatWhy(w: World, b: Boat): string | undefined {
  const hands = w.people.some((q) => q.kind === 'dockhand');
  if (b.state === 'anchored') {
    if (b.vessel === 'feeder' && w.berthCount(b.draft, true, true) === 0) {
      return `No berth for a feeder ship: it needs a harbour or gantry crane on a quay two tiles wide, in ${B.FEEDER_DRAFT} m of water.`;
    }
    if (b.vessel === 'coaster' && w.berthCount(b.draft, true) === 0) {
      return `No berth for a coaster: it needs a quay two tiles wide, in ${B.COASTER_DRAFT} m of water.`;
    }
    if (b.vessel !== 'feeder' && !hands && [...w.cranes.values()].some((c) => c.kind === 'jib')) {
      return 'With no dockhands to unload by hand, boats wait for a berth under a jib crane. Hire dockhands, or build more jib cranes.';
    }
    return 'Every berth it fits is taken, or a boat is coming or going in the way. More berths help.';
  }
  if (b.state === 'arriving' && (b.waitedFor ?? 0) > B.BERTH_BLOCKED_TICKS) {
    return 'A ship moored across its way in must sail first. One still taking exports on board takes those already on their way, then sails.';
  }
  if (b.state !== 'moored' || b.crates === 0) return undefined;
  if (b.vessel === 'feeder') {
    const cranes = [...w.cranes.values()].filter((c) => c.kind !== 'jib');
    if (cranes.length > 0 && cranes.every((c) => w.stackFull(c))) {
      return 'The cranes have set down all they can: reach stackers must take the containers to a container yard first.';
    }
    return undefined;
  }
  const jib = [...w.cranes.values()].find((c) => c.kind === 'jib' && w.near(c.idx, b.berth));
  const spots = w.pickupSpots(b).filter((t) => walkableAt(w.map, t));
  if (!jib && (spots.length === 0 || !hands)) {
    return hands
      ? 'Dockhands cannot get to it: it lies by machines-only ground. Forklifts cannot unload boats.'
      : 'Nobody to unload it: forklifts cannot unload boats. Hire dockhands, or berth boats under a jib crane.';
  }
  if (jib && jib.stack.length >= B.CRANE_STACK && !w.jibStows(jib)) {
    return "The crane's landing stack is full: a forklift must take it away. Crate storage within reach would take crates straight in.";
  }
  if (b.vessel === 'coaster' && !w.forklifts() && !(jib && w.jibStows(jib))) {
    return 'Its crates are on pallets: dockhands set them down on the quay, but only forklifts take them on.';
  }
  return undefined;
}

export function workerWhy(w: World, p: Dockhand): string | undefined {
  if (p.state !== 'idle' || p.kind !== 'dockhand') return undefined;
  const waiting = w.boats.filter(
    (b) => b.state === 'moored' && b.vessel !== 'feeder' && b.crates - b.reserved > 0,
  );
  const outOfReach = waiting.filter((b) => !w.pickupSpots(b).some((t) => walkableAt(w.map, t)));
  if (waiting.length > 0 && outOfReach.length === waiting.length) {
    return 'Boats are waiting, but dockhands keep off machines-only ground and the ground round cranes.';
  }
  return undefined;
}

/** What a truck waiting in the parking to load is waiting for. */
export function parkedWords(w: World, t: Truck): string {
  const bay = w.dest(t.bayIdx);
  if (bay && t.boxes && !w.handlerFree(bay, t)) {
    return 'Parked, waiting for a free reach stacker to load it';
  }
  return 'Parked, waiting for a loading spot';
}

export function truckWhy(w: World, t: Truck): string | undefined {
  if (t.exports && t.state === 'parked' && w.tick >= (t.papers ?? Infinity)) {
    const store = t.boxes ? 'container yard' : 'crate storage';
    if (!w.outgoingRoom(t)) return `No outgoing ${store} has room for its load.`;
    const stores = [...(t.boxes ? w.yards : w.bays).values()].filter(
      (b) => w.takesFrom(b, t) && bayRoom(b, t.boxes) >= t.cargo,
    );
    // Those parked nearer, inside the port, take the spots first.
    const nearer =
      t.staged === undefined
        ? w.stagingSpace(t)
          ? ''
          : ' No free parking nearer the storage, inside the port, for it to wait at instead.'
        : '';
    if (t.staged === undefined && stores.some((b) => w.stagedFor(b, t))) {
      return `Waiting its turn: shippers' trucks parked nearer the outgoing ${store}, inside the port, unload first.${nearer}`;
    }
    if (stores.some((b) => w.oneWayLane(b)) && !stores.some((b) => w.queueRoom(b))) {
      return `Waiting its turn: the queue at the outgoing ${store}'s yard gantry is full. A longer yard along the gantry's lane gives room for more.${nearer}`;
    }
    // Spots free, but those on their way in to the others have to get past them first.
    const free = stores.some((b) => w.freeDockSet(b, w.lengthOf(t)).size > 0);
    return free
      ? `Waiting its turn: trucks already on their way in to unload at the outgoing ${store} go first, so it would not stand in their way.${nearer}`
      : `Outgoing ${t.boxes ? 'container yards have' : 'crate storage has'} room, but every spot beside it to unload is taken${t.boxes ? ', or spoken for by trucks on their way in' : ''}. More tiles along the side trucks use give more spots.${nearer}`;
  }
  if (t.state === 'parked' && !t.exports) {
    const bay = w.dest(t.bayIdx);
    if (!bay) return undefined;
    const what = bay.yard ? 'container yard' : bay.tiles ? 'crate storage' : 'truck bay';
    if (bay.noAccess) return bay.noAccessWhy;
    if (w.oneWayLane(bay)) {
      const n = w.inQueue(bay);
      return `The queue at the yard gantry is full: ${n} ${n === 1 ? 'truck is' : 'trucks are'} loading or lined up for it. A longer yard along the gantry's lane gives room for more.`;
    }
    if (!t.boxes || w.handlerFree(bay, t)) {
      const going = w.trucks.filter(
        (o) => o.bayIdx === bay.idx && (o.state === 'toBay' || w.docked(o)),
      ).length;
      return w.freeDockSet(bay, w.lengthOf(t)).size === 0
        ? `Every loading spot at the ${what} is taken: ${going} ${going === 1 ? 'truck is' : 'trucks are'} loading there or on the way.${bay.tiles ? ' A truck longer than a tile takes the spots either side of it too.' : ''}${bay.yard ? " A longer yard along the gantry's lane gives more spots." : ''}`
        : `Spots at the ${what} are free, but trucks on their way in go first, so it would not stand in their way.`;
    }
    const stackers = w.people.filter((p) => p.kind === 'stacker').length;
    return `This yard has no yard gantry: reach stackers load its trucks, and ${stackers === 0 ? 'there are none' : `all ${stackers} are busy`}. More reach stackers, or a yard gantry here, load trucks sooner.`;
  }
  if (t.state !== 'loading') return undefined;
  const bay = w.dest(t.bayIdx);
  if (!bay) return undefined;
  if (t.boxes && bay.yard && w.cleared(bay) === 0 && bay.boxes.length > 0) {
    return 'Waiting for customs to clear the containers in the yard.';
  }
  if (w.collectable(bay) === 0) {
    return 'Waiting for more cargo. It leaves part-loaded if none comes soon.';
  }
  if (w.byHand(t, bay) && (t.coming ?? 0) === 0) {
    const crew = w.people.filter((p) => p.kind === 'dockhand' || p.kind === 'forklift');
    return crew.length === 0
      ? 'Dockhands or forklifts load crate trucks, and there are none. Hire some.'
      : 'Waiting for a dockhand or forklift to load it: they are busy, or cannot walk or drive here. More of them, or a path to this bay, load it sooner.';
  }
  return undefined;
}

export function craneWhy(w: World, c: Crane): string {
  const full = w.stackFull(c);
  if (c.kind === 'jib') {
    const stores = w.jibStores(c);
    if (c.busy) {
      return stores.some((a) => bayRoom(a, false) > 0 && w.takesImports(a))
        ? 'Swinging crates straight into crate storage.'
        : 'Lifting crates onto its landing stack.';
    }
    if (full) {
      return 'Landing stack full: waiting for a forklift to take it away. Dockhands keep off the ground round a crane.';
    }
    if (c.stack.length > 0) return 'Waiting for a forklift to collect its landing stack.';
    return berthTrouble(w, c) ? 'No boat can come alongside it.' : 'No boat lying under it.';
  }
  if (c.busy) return 'Lifting containers off the ship.';
  // Nowhere for them to go: every yard with room has stopped taking them.
  const yards = [...w.yards.values()].filter((y) => !y.outgoing && bayRoom(y, true) > 0);
  if (c.stack.length > 0 && yards.length > 0 && yards.every((y) => y.shut)) {
    return 'Every container yard with room has stopped taking containers: open one to them again, or mark out another.';
  }
  if (full) {
    return c.kind === 'gantry'
      ? 'The bay between its legs is full: waiting for reach stackers.'
      : 'Stack full: waiting for reach stackers.';
  }
  return c.stack.length > 0
    ? 'Waiting for reach stackers to take the containers to a yard.'
    : berthTrouble(w, c)
      ? 'No container ship can come alongside it.'
      : 'No container ship alongside.';
}

/**
 * Why no ship can ever come alongside this crane, as the harbour master
 * would see it, or null if one could and there is simply none there now.
 * A jib crane takes any boat; a container crane a feeder, against a quay
 * two wide, with room for its hull and water deep enough.
 */
export function berthTrouble(w: World, c: Crane): string | null {
  const m = w.map;
  const feeder = c.kind !== 'jib';
  const draft = feeder ? B.FEEDER_DRAFT : B.BOAT_DRAFT;
  const water = w.boatCostFor(draft);
  const what = feeder ? 'a container ship' : 'a boat';
  let deepest = -1;
  let office = false;
  let wide = false;
  let room = false;
  // Berths square in front of it, where a ship lies centred on it, as the
  // harbour master looks for them (see freeBerths).
  for (const j of feeder ? w.craneFront(c) : [c.idx]) {
    for (const n of m.neighbors4(j)) {
      if (m.ocean[n] !== 1 || m.build[n] !== Build.None) continue;
      deepest = Math.max(deepest, m.depth[n]);
      if (!w.dockInUse(j)) continue;
      office = true;
      if (feeder && !w.wideQuay(j, n)) continue;
      wide = true;
      if (!w.mooredTiles(n, j, w.boatHalf(feeder))) continue;
      room = true;
      if (water(n) === 1) return null;
    }
  }
  if (deepest < 0) return `No open water beside it for ${what} to lie in.`;
  if (!office) {
    return 'No ship will come: this quay is not run by a harbour office. Build one nearby.';
  }
  if (!wide)
    return 'A container ship moors only against a quay two tiles wide: widen the quay here.';
  if (!room) {
    const reach = w.boatHalf(feeder);
    return `No room alongside for ${what}'s hull: it lies centred on the crane, and needs open water ${reach} tile${reach === 1 ? '' : 's'} either way along the quay from it.`;
  }
  return `The water alongside is only ${deepest.toFixed(1)} m deep, and ${what} needs ${draft} m: dredge in front of it.`;
}

/**
 * Everything on the map that cannot work as it is built, for a red mark
 * over it: a crane no ship can come alongside, storage or a truck bay the
 * trucks cannot reach, parking no truck can use.
 */
export function problems(w: World): ProblemView[] {
  const m = w.map;
  const out: ProblemView[] = [];
  const middle = (tiles: number[]) => ({
    x: tiles.reduce((n, i) => n + m.xOf(i) + 0.5, 0) / tiles.length,
    y: tiles.reduce((n, i) => n + m.yOf(i) + 0.5, 0) / tiles.length,
  });
  for (const c of w.cranes.values()) {
    const text = berthTrouble(w, c);
    const h = c.kind === 'jib' ? 1.7 : c.kind === 'gantry' ? 2.9 : 2.3;
    if (text) out.push({ ...middle([c.idx]), h, text, type: 'crane', idx: c.idx });
  }
  // Yard gantries working no yard: beside none, or a second by one.
  for (const [g, text] of w.gantries().idle) {
    out.push({ ...middle([g]), h: 1.6, text, type: 'yardGantry', idx: g });
  }
  for (const b of [...w.bays.values(), ...w.yards.values()]) {
    // Crate storage the trucks cannot reach is still a buffer the forklifts empty.
    if (!b.noAccess || b.warehouse || (b.tiles && !b.yard)) continue;
    out.push({
      ...middle(b.tiles ?? [b.idx]),
      h: 1.2,
      text: b.noAccessWhy ?? 'Trucks cannot reach it.',
      type: b.yard ? 'yard' : 'bay',
      idx: b.idx,
    });
  }
  for (const lot of w.lots()) {
    const why = w.lotTrouble(lot);
    if (why)
      out.push({
        ...middle(lot.tiles),
        h: 0.9,
        text: `Not in use: ${why}.`,
        type: 'parking',
        idx: lot.tiles[0],
      });
  }
  return out;
}

/** Cargo waiting at each step from boat to truck, for the cargo flow. */
export function waitingCargo(w: World): Snapshot['stock'] {
  const cranes = [...w.cranes.values()];
  const yards = [...w.yards.values()];
  const boxes = yards.reduce((n, y) => n + y.boxes.length, 0);
  const cleared = yards.reduce((n, y) => n + w.cleared(y), 0);
  return {
    landed:
      [...w.piles.values()].reduce((n, p) => n + p.crates.length, 0) +
      cranes.filter((c) => c.kind === 'jib').reduce((n, c) => n + c.stack.length, 0),
    stored: [...w.bays.values()].reduce((n, b) => n + b.crates.length, 0),
    crateExports: w.exportsWaiting(false),
    boxExports: w.exportsWaiting(true),
    boxLanded: cranes.filter((c) => c.kind !== 'jib').reduce((n, c) => n + c.stack.length, 0),
    boxCustoms: boxes - cleared,
    boxCleared: cleared,
  };
}

/** Every crate and container in the port, by where it is; see CargoStats. */
export function cargoStats(w: World): CargoStats {
  const into = () => ({
    atSea: 0,
    onShips: 0,
    landed: 0,
    carried: 0,
    customs: 0,
    ready: 0,
    onTrucks: 0,
  });
  const out = () => ({ waiting: 0, comingIn: 0, stored: 0, carried: 0, atCrane: 0, aboard: 0 });
  const c: CargoStats = {
    crates: into(),
    containers: into(),
    crateExports: out(),
    containerExports: out(),
  };
  for (const b of w.boats) {
    if (b.state === 'leaving') continue;
    const boxes = b.vessel === 'feeder';
    const f = boxes ? c.containers : c.crates;
    if (b.state === 'moored') {
      f.onShips += b.crates;
      (boxes ? c.containerExports : c.crateExports).aboard += b.out ?? 0;
    } else f.atSea += b.crates;
  }
  for (const k of w.cranes.values()) {
    const boxes = k.kind !== 'jib';
    (boxes ? c.containers : c.crates).landed += k.stack.length;
    (boxes ? c.containerExports : c.crateExports).atCrane += k.outStack?.length ?? 0;
  }
  for (const p of w.piles.values()) c.crates.landed += p.crates.length;
  for (const b of w.bays.values()) {
    // Storage no truck can reach is a buffer by the cranes.
    if (b.noAccess && b.tiles) c.crates.landed += b.crates.length;
    else c.crates.ready += b.crates.length;
    c.containers.ready += b.boxes.length;
    c.crateExports.stored += b.exports?.length ?? 0;
  }
  for (const y of w.yards.values()) {
    const clear = w.cleared(y);
    c.containers.ready += clear;
    c.containers.customs += y.boxes.length - clear;
    c.containerExports.stored += y.exports?.length ?? 0;
  }
  for (const p of w.people) {
    if (!p.carrying) continue;
    const boxes = isBoxy(p);
    if (p.outbound) (boxes ? c.containerExports : c.crateExports).carried += p.carrying;
    else (boxes ? c.containers : c.crates).carried += p.carrying;
  }
  for (const t of w.trucks) {
    if (t.cargo <= 0) continue;
    if (!t.exports) {
      (t.boxes ? c.containers : c.crates).onTrucks += t.cargo;
      continue;
    }
    const e = t.boxes ? c.containerExports : c.crateExports;
    if (t.state === 'parked' || t.state === 'toPark') e.waiting += t.cargo;
    else if (t.state === 'toBay' || t.state === 'delivering') e.comingIn += t.cargo;
  }
  return c;
}

export function buildSnapshot(w: World): Snapshot {
  const entities: EntityView[] = [];
  const staff: StaffView[] = [];
  const lifts = w.gantryLifts();
  const jibs = w.jibLifts();
  const moved = (where: object) => w.jibMoved(jibs, where);
  const parked = w.parkedPoses();
  for (const p of w.people) {
    const park = parked.get(p.id);
    entities.push({
      id: p.id,
      kind: p.kind,
      x: park?.x ?? p.x,
      y: park?.y ?? p.y,
      dir: park?.dir ?? p.dir,
      parked: park ? true : undefined,
      ...w.servedLoad(
        p,
        w.liftedLoad(p.carrying, isBoxy(p) ? [...w.carriedLooks(p)] : undefined, lifts.get(p.id)),
      ),
      moving: p.path.length > 0,
      cargo: isBoxy(p)
        ? undefined
        : p.cargoFees.map((f) => cargoOf(f, p.outbound ? 'goods' : 'fish')),
      handling: w.handlingPhase(p),
      sitting: p.state === 'resting' && p.hutIdx >= 0 && w.map.build[p.hutIdx] === Build.BreakHut,
      name: p.name,
      activity:
        p.blocked > 3
          ? 'Waiting for someone to get out of the way'
          : activity(p, w.piles.has(p.bayIdx)),
      variant: 0,
      capacity: p.capacity,
      alert: p.state === 'broken' || (p.state === 'idle' && !!p.stuck),
      why: workerWhy(w, p),
      ...w.handView(p),
    });
    staff.push({
      id: p.id,
      kind: p.kind,
      broken: p.state === 'broken',
      fuel: Math.round(p.fuel),
      home: p.home,
      name: p.name,
      skill: p.skill,
      trait: p.trait,
      wage: p.wage,
      energy: Math.round(p.energy),
      morale: Math.round(p.morale),
      activity: activity(p, w.piles.has(p.bayIdx)),
      thought: thought({
        blocked: p.blocked > 3,
        energy: p.energy,
        morale: p.morale,
        resting: p.state === 'resting',
        hasHut: p.hutIdx >= 0,
        carrying: p.carrying > 0,
        idle: p.state === 'idle' || p.state === 'wander',
      }),
      raiseAsk: p.raiseAsk,
    });
  }
  const kind = (q: Boat) =>
    q.vessel === 'feeder' ? 'feeder ship' : q.vessel === 'coaster' ? 'coaster' : 'boat';
  for (const b of w.boats) {
    const plot = w.plots.get(b);
    const clear = w.keepingClear.get(b);
    const giving = clear && clear.pace < 1 ? w.boats.find((q) => q.id === clear.of) : undefined;
    entities.push({
      id: b.id,
      kind: 'boat',
      x: b.x,
      y: b.y,
      dir: b.dir,
      ...(b.vessel === 'feeder'
        ? w.deckView(b)
        : {
            load: b.crates + (b.out ?? 0) + moved(b).set - moved(b).taken,
            catch: cargoOf(b.fee),
            // Its catch, then what it has taken on board to go out.
            cargo: [
              ...Array<Cargo>(b.crates).fill(cargoOf(b.fee)),
              ...(b.outFees ?? []).map((f) => cargoOf(f, 'goods')),
            ],
          }),
      moving: b.path.length > 0,
      name: b.company,
      activity:
        (b.state === 'approaching'
          ? 'Sailing in from sea'
          : b.state === 'anchored'
            ? 'Waiting at anchor for a berth'
            : b.state === 'arriving'
              ? arrivingWords(w, b)
              : b.state === 'moored' && b.crates === 0 && b.reserved === 0
                ? w.readyWords(b)
                : b.state === 'moored'
                  ? `Unloading, ${b.crates} ${b.vessel === 'feeder' ? 'containers' : 'crates'} left`
                  : 'Heading back out to sea') +
        (giving ? `, giving way to a ${giving.company} ${kind(giving)}` : '') +
        (tugged(w, b) ? ', with a tug alongside' : ''),
      plot: plot && [...plot].flatMap((v, k) => (k % 9 < 2 ? [Math.round(v * 100) / 100] : [])),
      givingWayTo: giving?.id,
      variant: b.variant,
      capacity:
        b.vessel === 'feeder'
          ? B.FEEDER_MAX_LOAD
          : b.vessel === 'coaster'
            ? B.COASTER_MAX_LOAD
            : B.BOAT_MAX_LOAD,
      alert:
        b.state === 'anchored' ||
        (b.state === 'arriving' && (b.waitedFor ?? 0) > B.BERTH_BLOCKED_TICKS),
      why: boatWhy(w, b),
      vessel: b.vessel,
      boxes: b.vessel === 'feeder',
      visit: visitView(w, b),
    });
  }
  for (const t of w.tugs) {
    const ship = w.boats.find((b) => b.id === t.ship);
    const whose = ship ? `the ${ship.company} ${kind(ship)}` : 'a ship';
    entities.push({
      id: t.id,
      kind: 'boat',
      x: t.x,
      y: t.y,
      dir: t.dir,
      load: 0,
      moving: t.state !== 'idle',
      name: t.name,
      activity:
        t.state === 'idle'
          ? 'Lying at its berth'
          : t.state === 'out'
            ? `Heading out to ${whose}`
            : t.state === 'assist'
              ? ship?.state === 'leaving'
                ? `Working ${whose} out of its berth`
                : `Working ${whose} in alongside`
              : 'Heading back to its berth',
      variant: 0,
      capacity: 0,
      alert: false,
      vessel: 'tug',
    });
  }
  for (const t of w.trucks) {
    const shown = t.backing
      ? w.backingPose(t)
      : { x: w.lanePos(t)[0], y: w.lanePos(t)[1], dir: t.dir };
    entities.push({
      id: t.id,
      kind: 'truck',
      ...shown,
      // A shipper's containers are all alike; the rest as they were loaded.
      ...w.liftedLoad(
        t.cargo,
        t.boxes
          ? t.exports
            ? Array.from({ length: t.cargo }, (_, k) => boxLookOf(t.id, k))
            : [...aligned(Array(t.cargo).fill(0), t.looks, t.id)]
          : undefined,
        lifts.get(t.id),
      ),
      cargo: t.boxes ? undefined : w.truckCargo(t),
      moving: t.path.length > 0,
      name: t.company,
      activity:
        t.exports && (t.state === 'toPark' || t.state === 'parked')
          ? t.staged !== undefined && t.state === 'toPark'
            ? `Paperwork done, driving to parking nearer the outgoing storage to wait for a spot`
            : w.cannedTruck(t) && t.state === 'toPark'
              ? `Bringing ${t.cargo} crates of canned fish to ship: to parking outside the port, to wait for a spot in the outgoing storage`
              : w.tick < (t.papers ?? Infinity) || t.state === 'toPark'
                ? `Bringing ${t.cargo} ${t.boxes ? 'containers' : 'crates'} to ship: paperwork first, parked outside the port`
                : w.outgoingRoom(t)
                  ? `${w.cannedTruck(t) ? 'Waiting' : 'Paperwork done, waiting'} for a free spot to unload at the outgoing storage`
                  : `${w.cannedTruck(t) ? 'Waiting' : 'Paperwork done, waiting'} for storage with room for its ${t.boxes ? 'containers' : 'crates'}`
          : t.exports && t.state === 'toBay'
            ? `Bringing ${t.cargo} ${t.boxes ? 'containers' : 'crates'} to storage, to ship`
            : t.state === 'delivering'
              ? `Unloading ${t.cargo} ${t.boxes ? 'containers' : 'crates'} to ship`
              : t.state === 'toPark'
                ? 'Driving to the parking'
                : t.state === 'parked'
                  ? parkedWords(w, t)
                  : t.state === 'toBay'
                    ? 'Driving to the truck bay'
                    : t.state === 'loading'
                      ? `Loading, ${t.cargo}/${t.capacity} ${t.boxes ? 'containers' : 'crates'}${w.customsHold(t)}`
                      : t.state === 'toTown' || t.state === 'unloading'
                        ? `${t.state === 'toTown' ? 'Delivering' : 'Unloading'} ${t.dropCount} ${t.boxes ? 'containers' : w.cratesOf(t)} at the ${BUSINESSES[w.map.build[t.drop ?? 0]]?.label ?? 'town'} in ${w.town?.name ?? 'town'}`
                        : 'Heading out to the highway',
      variant: t.variant,
      capacity: t.capacity,
      alert: false,
      boxes: t.boxes,
      why: truckWhy(w, t),
    });
  }
  const bays: BayView[] = [...w.bays.values()].map((b) => ({
    idx: b.idx,
    stock: b.crates.length + moved(b).set,
    boxes: b.boxes.length,
    capacity: bayCap(b),
    large: b.large,
    warehouse: !!b.warehouse,
    exports: (b.exports?.length ?? 0) - moved(b).taken,
    places: b.tiles && w.palletPlaces(b, heldIn(b) + moved(b).set),
    outgoing: !!b.outgoing,
    shut: !!b.shut,
    byCrane: w.byCrane(b),
    tiles: b.tiles && [...b.tiles],
    noAccess: b.noAccess,
    noAccessWhy: b.noAccess ? b.noAccessWhy : undefined,
    cargo: [
      ...b.crates.map((f) => cargoOf(f)),
      ...(b.exports ?? []).map((f) => cargoOf(f, 'goods')),
    ],
    ...w.holdsView(b),
  }));
  const contracts: ContractView[] = w.contracts.map((c) => ({
    id: c.id,
    terms: c.terms,
    satisfaction: c.satisfaction,
    cancelFee: cancelFee(c),
    breach: breachPenalty(c),
    active:
      c.terms.kind === 'fishery'
        ? w.boats.filter((b) => b.contractId === c.id).length
        : w.trucks.filter((t) => t.contractId === c.id && !t.away).length,
    away: (c.returns ?? []).filter((at) => at > w.tick).length,
    backIn: (c.returns ?? []).reduce(
      (n, at) => (at > w.tick && (n < 0 || at - w.tick < n) ? at - w.tick : n),
      -1,
    ),
    waiting: w.boats.filter((b) => b.contractId === c.id && b.state === 'anchored').length,
    nextIn: c.terms.kind !== 'haulier' ? Math.max(0, c.nextBoatTick - w.tick) : -1,
  }));
  const cap = capacity(w);
  return {
    tick: w.tick,
    cash: w.cash,
    speed: w.speed,
    seed: w.seed,
    staff: w.people.length,
    wages: wageBill(w),
    people: staff,
    candidates: w.candidates.map((c) => ({ ...c })),
    contractFees: dailyFees(w),
    loan: w.loan,
    interest: interestDue(w),
    today: { ...w.today },
    yesterday: w.yesterday ? { ...w.yesterday } : null,
    history: w.history,
    daysInRed: w.daysInRed,
    bankrupt: w.bankrupt,
    stats: { ...w.stats },
    cargo: cargoStats(w),
    cargoLog: w.cargoLog,
    entities,
    bays,
    yards: [...w.yards.values()].map((y) => ({
      idx: y.idx,
      boxes: y.boxes.length,
      exports: y.exports?.length ?? 0,
      ...w.yardLooks(y, lifts),
      outgoing: !!y.outgoing,
      shut: !!y.shut,
      byCrane: w.byCrane(y),
      gantry: w.yardGantry(y),
      cleared: w.cleared(y),
      buried: w.buriedCount(y),
      nextClear: w.nextClear(y),
      pending: w.pending(y),
      capacity: bayCap(y),
      tiles: [...(y.tiles ?? [y.idx])],
      noAccess: y.noAccess,
      noAccessWhy: y.noAccess ? y.noAccessWhy : undefined,
    })),
    problems: problems(w),
    parking: w.lots().map((lot) => {
      const keys = new Set(lot.spaces.map((sp) => sp.tiles[0]));
      return {
        tiles: lot.tiles,
        outside: lot.outside,
        wide: lot.wide,
        spaces: lot.spaces.length,
        used: w.trucks.filter((t) => t.park !== undefined && keys.has(t.park)).length,
        why: w.lotTrouble(lot),
      };
    }),
    piles: [...w.piles.values()].map((p) => ({
      idx: p.idx,
      crates: p.crates.length - moved(p).taken,
      pallets: !!p.pallets,
      out: !!p.out,
      cargo: p.crates.map((f) => cargoOf(f, p.out ? 'goods' : 'fish')),
    })),
    contracts,
    capacity: capacity(w),
    stock: waitingCargo(w),
    docks: {
      total: w.docks().length,
      coordinated: w.docks().filter((g) => g.coordinated).length,
      offices: w.map.build.filter((b) => b === Build.Office).length,
      huts: w.map.build.filter((b) => b === Build.HarbourHut).length,
      inUse: w.docks().flatMap((g) => (g.coordinated ? g.tiles : [])),
      idle: w.docks().flatMap((g) => (g.coordinated ? [] : g.tiles)),
    },
    depots: depotViews(w),
    progress: {
      tier: w.tier,
      town: w.townSize(),
      canUpgrade: canUpgrade(w),
      waitsOn: tierWaitsOn(w),
    },
    cranes: [...w.cranes.values()].map((c) => ({
      idx: c.idx,
      kind: c.kind,
      ...w.servedStack(c, moved(c).set),
      max: craneStack(c),
      angle: c.angle,
      busy: c.busy,
      stores: c.kind === 'jib' ? w.jibStores(c).length : 0,
      why: craneWhy(w, c),
      trouble: berthTrouble(w, c) ?? undefined,
      ...w.craneWork(c, jibs),
    })),
    town: w.town && {
      name: w.town.name,
      stage: w.town.stage,
      population: population(w.town, w.map),
      homes: townHomes(w.map),
      target: Math.round(townTarget(w.town)),
      jobs: w.town.jobs,
      goods: Math.round(w.town.goods),
      supplied: Math.round(w.town.supplied),
      wants: wantsView(w),
      businesses: businessViews(w),
      ...landmarkView(w, w.town),
      x: w.map.xOf(w.town.centre),
      y: w.map.yOf(w.town.centre),
    },
    train: w.rail.train && { ...w.rail.train, cars: [...w.rail.train.cars] },
    offers: w.offers.map((o) => ({
      id: o.id,
      terms: o.terms,
      signingFee: o.signingFee,
      expiresIn: o.expires - w.tick,
      breach: breachPenalty(o),
      truckingAfter: o.terms.kind === 'haulier' ? truckingWith(w, o.terms) : cap.trucking,
    })),
  };
}
