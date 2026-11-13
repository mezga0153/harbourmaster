// What the view sees of the game each frame (see protocol/views.ts): the
// snapshot, and the words that explain why a boat, worker, truck, crane or
// berth is held up.

import type { World } from '../world';
import type { Boat, CargoStats, Crane, Dockhand, Truck } from '../state';
import * as B from '../balance';
import { bayTrouble, depotDoorTrouble, walkableAt } from '../rules/placement';
import {
  activity,
  bayCap,
  bayRoom,
  boxesAt,
  boxLookOf,
  breachPenalty,
  cancelFee,
  craneStack,
  cratesAt,
  isBoxy,
  outAboard,
} from '../helpers';
import { Build } from '../types';
import { cargoName, cargoOf } from '../cargo';
import type { Cargo } from '../cargo';
import { isIce, needsCustomsOffice, type Contract } from '../contracts';
import { thought, traitDef } from '../staff';
import { BUSINESSES, population, townRoom, townTarget } from '../town';
import { depotViews } from './output';
import type {
  BayView,
  CraneFix,
  ContractView,
  EntityView,
  PlaceView,
  ProblemView,
  Snapshot,
  StaffView,
} from '../../protocol/views';
import {
  canUpgrade,
  capacity,
  dailyFees,
  fine,
  interestDue,
  tierWaitsOn,
  truckingWith,
  visitView,
  wageBill,
  hasCustomsOffice,
  offerBlocked,
} from './economy';
import { businessViews, landmarkView, wantsView } from './townBusiness';
import { tugged } from './tugs';
import { guiding, officialActivity } from './officials';
import {
  craneHeld,
  craneWork,
  deckView,
  jibLifts,
  jibMoved,
  jibReach,
  jibStores,
  servedLoad,
  servedStack,
  stackFull,
} from './cranes';
import {
  berthCount,
  boatCostFor,
  boatHalf,
  craneFront,
  dockInUse,
  docks,
  mooredTiles,
  near,
  wideQuay,
} from './boats/berthing';
import { gantries, gantryLifts, handView, liftedLoad, yardLooks } from './yardGantry';
import { pileCells, shownCells } from './cargo/places';
import { byHand, unloadWaiting } from './truckLoading';
import { handlingPhase } from './workforce/crowding';
import { parkedPoses } from './workforce/dockhands';
import { exportsWaiting, iceTrouble, readyWords, truckCargo } from './cargo/exports';
import { shipperChecks, shipperTrouble } from './cargo/shipperTrouble';
import {
  buriedCount,
  byCrane,
  papersInPort,
  carriedLooks,
  cleared,
  customsHold,
  dropRoom,
  jibRoom,
  jibStore,
  jibStows,
  nextClear,
  pending,
  pickupSpots,
  takesFrom,
  takesImports,
} from './cargo/stores';
import { bedCap, bedView, trailerLooks } from './cargo/beds';
import type { BulkKind } from '../bulk';
import { WAITS, nextStep, openCities, placeCap, placeLabel, stepsOf } from '../region';
import { sidingCars, sidingTrouble, sidingsOpen, sidingsShutWhy, trainAt } from './trains';
import { portCrossing, sidings } from '../rules/rails';
import { bySiding, yardsBeside } from './cargo/wagons';
import { dest, holdsView } from './cargo/customs';
import { placeOf } from '../designations';
import { AHEAD_CELLS, AHEAD_TILES } from '../../protocol/views';
import { forkCells } from './workforce/forkCells';
import {
  baysOpen,
  baysShutWhy,
  docked,
  inQueue,
  lotTrouble,
  lots,
  oneWayLane,
  queueRoom,
  stagedFor,
  stagingSpace,
} from './roads/bays';
import { backingPose, cratesOf, lanePos, laterStops, lengthOf } from './roads/traffic';
import { vesselName } from '../helpers';

/** What a ship coming in to its berth is doing: on its way, or waiting for one in its way to sail. */
export function arrivingWords(w: World, b: Boat): string {
  const o = b.waitingOn !== undefined && w.boats.find((q) => q.id === b.waitingOn);
  if (!o || (b.waitedFor ?? 0) <= B.BERTH_BLOCKED_TICKS) return 'Sailing to the jetty';
  return `Waiting for the ${o.company} ${vesselName(o)} moored in its way to sail`;
}

export function boatWhy(w: World, b: Boat): string | undefined {
  const hands = w.people.some((q) => q.kind === 'dockhand');
  if (b.state === 'anchored') {
    if (b.vessel === 'bulker') {
      return w.map.build.includes(Build.GrabCrane)
        ? 'Every berth at a grab crane is taken, or a ship is coming or going in the way. More grab cranes help.'
        : `No berth for a bulk carrier: it needs a grab crane on a quay two tiles wide, in ${B.BULKER_DRAFT} m of water, with room along the quay for the whole ship.`;
    }
    if (b.vessel === 'feeder' && berthCount(w, b.draft, true, true) === 0) {
      return `No berth for a feeder ship: it needs a harbour or gantry crane on a quay two tiles wide, in ${B.FEEDER_DRAFT} m of water.`;
    }
    if (b.vessel === 'coaster' && berthCount(w, b.draft, true) === 0) {
      return `No berth for a coaster: it needs a quay two tiles wide, in ${B.COASTER_DRAFT} m of water.`;
    }
    if (b.vessel !== 'feeder' && !hands && [...w.cranes.values()].some((c) => c.kind === 'jib')) {
      return 'With no dockhands to unload by hand, boats wait for a berth under a jib crane with room in crate storage in its reach. Hire dockhands, mark out more storage for cargo coming in by the cranes, or build more jib cranes.';
    }
    // A berth under a jib crane with nowhere to swing crates into is no use.
    const idle = [...w.cranes.values()].some(
      (c) => c.kind === 'jib' && !jibStore(w, c) && !berthTrouble(w, c),
    );
    if (b.vessel !== 'feeder' && idle) {
      return 'Every berth it fits is taken, or under a jib crane with no room in crate storage next to it, where it would not be unloaded. Mark out storage for cargo coming in beside the crane, or build more berths.';
    }
    // Berths nothing can unload a boat at are never handed out.
    const wide = b.vessel !== 'smack';
    if (
      b.vessel !== 'feeder' &&
      berthCount(w, b.draft, wide) > 0 &&
      berthCount(w, b.draft, wide, false, true) === 0
    ) {
      return 'No berth it fits is one it could be unloaded at: dockhands cannot walk from any to a truck bay or crate storage for cargo coming in, and no jib crane with crate storage beside it stands over one. Join the quay to them with footpaths or quay, or build a jib crane with storage next to it.';
    }
    return 'Every berth it fits is taken, or a boat is coming or going in the way. More berths help.';
  }
  if (b.state === 'arriving' && (b.waitedFor ?? 0) > B.BERTH_BLOCKED_TICKS) {
    return 'A ship moored across its way in must sail first. One still taking exports on board takes those already on their way, then sails.';
  }
  if (b.state === 'moored' && b.crates === 0) return iceTrouble(w, b);
  if (b.state !== 'moored') return undefined;
  if (b.vessel === 'bulker') {
    const full = [...w.map.build].some(
      (c, i) => c === Build.GrabCrane && (w.bulk.get(i)?.t ?? 0) >= B.HOPPER_CAP - B.GRAB_BITE,
    );
    return full
      ? 'The grab crane’s hopper is full: lay a conveyor belt away from it to a stockpile with room, or the crane stops.'
      : undefined;
  }
  if (b.vessel === 'feeder') {
    const cranes = [...w.cranes.values()].filter((c) => c.kind !== 'jib');
    if (cranes.length > 0 && cranes.every((c) => stackFull(w, c))) {
      return 'The cranes have set down all they can: reach stackers must take the containers to a container yard first.';
    }
    return undefined;
  }
  const jib = [...w.cranes.values()].find((c) => c.kind === 'jib' && near(w, c.idx, b.berth));
  const spots = pickupSpots(w, b).filter((t) => walkableAt(w.map, t));
  if (!jib && (spots.length === 0 || !hands)) {
    return hands
      ? 'Dockhands cannot get to it: it lies by machines-only ground. Forklifts cannot unload boats.'
      : 'Nobody to unload it: forklifts cannot unload boats. Hire dockhands, or berth boats under a jib crane.';
  }
  if (jib && !jibStore(w, jib)) {
    return jibStows(w, jib)
      ? 'The crate storage in reach of the jib crane over it is full on the tiles right beside the crane, the only ones it swings to: the crane waits for room. Forklifts move crates off those tiles to make some.'
      : 'The jib crane over it has no crate storage for cargo coming in next to it to swing the crates into, and it sets none down at its feet.';
  }
  return b.noRoom ? noRoomWords(w, b.noRoom) : undefined;
}

/**
 * Why the dockhands are not unloading a boat, for its panel and the red
 * mark over it: nowhere to carry its crates into, as they set none down
 * on the quay.
 */
export function noRoomWords(w: World, why: 'room' | 'customs'): string {
  if (why === 'customs') {
    return 'Its timber and goods wait in crate storage for customs, and no crate storage for cargo coming in that the dockhands can walk to has room: they set nothing down on the quay, so it waits. Mark out more crate storage for cargo coming in near the quay.';
  }
  const places = [...w.bays.values()].filter((s) => takesImports(w, s));
  if (places.length === 0) {
    return 'There is no truck bay or crate storage for cargo coming in: dockhands carry each crate straight into one and set none down on the quay or by the road, so it waits. Build a truck bay by the road, or mark out crate storage near the quay.';
  }
  const room = places.some((s) => dropRoom(w, s, false) > 0);
  return room
    ? 'Dockhands cannot walk from it to any truck bay or crate storage with room: they carry each crate straight into one and set none down on the quay, so it waits. Join the quay to them with footpaths or quay.'
    : 'Every truck bay and crate storage for cargo coming in is full: dockhands carry each crate straight into one and set none down on the quay, so it waits. Mark out more crate storage near the quay, or build more truck bays.';
}

export function workerWhy(w: World, p: Dockhand): string | undefined {
  if (p.state !== 'idle' || p.kind !== 'dockhand') return undefined;
  const waiting = w.boats.filter(
    (b) => b.state === 'moored' && b.vessel !== 'feeder' && b.crates - b.reserved > 0,
  );
  const outOfReach = waiting.filter((b) => !pickupSpots(w, b).some((t) => walkableAt(w.map, t)));
  if (waiting.length > 0 && outOfReach.length === waiting.length) {
    return 'Boats are waiting, but dockhands keep off machines-only ground and the ground round cranes.';
  }
  return undefined;
}

/** Where a truck is headed or loading, by its designation, or `none` if it has none. */
function truckPlace(w: World, t: Truck, none: string): string {
  const bay = dest(w, t.bayIdx);
  if (bay?.kerb) return placeOf(bay);
  // A pickup pulls up on the road beside a truck bay, or backs into it.
  if (t.pickup && bay?.name && !bay.tiles && t.goal !== bay.idx) {
    return `the road beside ${placeOf(bay)}`;
  }
  return bay?.name ? placeOf(bay) : none;
}

/** What a worker is up to, naming the storage or truck bay it carries cargo to. */
function workerActivity(w: World, p: Dockhand): string {
  const landing = w.piles.has(p.bayIdx);
  const to =
    p.state === 'toDrop' && !landing && !p.outbound && !p.restack && p.truckId === undefined;
  const bay = to ? dest(w, p.bayIdx) : undefined;
  if (!bay?.name) return activity(p, landing);
  if (p.kind === 'stacker' || p.kind === 'tractor') return `Taking a container to ${placeOf(bay)}`;
  if (p.kind === 'forklift') return `Carrying crates to ${placeOf(bay)}`;
  return `Carrying a crate to ${placeOf(bay)}`;
}

/** What a truck waiting in the parking to load is waiting for. */
export function parkedWords(w: World, t: Truck): string {
  const bay = dest(w, t.bayIdx);
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
      (b) => takesFrom(w, b, t) && bayRoom(b, t.boxes) >= t.cargo,
    );
    // Those parked nearer, inside the port, take the spots first.
    const nearer =
      t.staged === undefined
        ? stagingSpace(w, t)
          ? ''
          : ' No free parking nearer the storage, inside the port, for it to wait at instead.'
        : '';
    if (t.staged === undefined && stores.some((b) => stagedFor(w, b, t))) {
      return `Waiting its turn: shippers' trucks parked nearer the outgoing ${store}, inside the port, unload first.${nearer}`;
    }
    if (stores.some((b) => oneWayLane(w, b)) && !stores.some((b) => queueRoom(w, b))) {
      return `Waiting its turn: the queue at the outgoing ${store}'s yard gantry is full. A longer yard along the gantry's lane gives room for more.${nearer}`;
    }
    // Spots free, but those on their way in to the others have to get past them first.
    const free = stores.some((b) => w.freeDockSet(b, lengthOf(w, t)).size > 0);
    return free
      ? `Waiting its turn: trucks already on their way in to unload at the outgoing ${store} go first, so it would not stand in their way.${nearer}`
      : `Outgoing ${t.boxes ? 'container yards have' : 'crate storage has'} room, but every spot beside it to unload is taken${t.boxes ? ', or spoken for by trucks on their way in' : ''}. More tiles along the side trucks use give more spots.${nearer}`;
  }
  if (t.state === 'parked' && !t.exports) {
    const bay = dest(w, t.bayIdx);
    if (!bay) return undefined;
    const what = placeOf(bay);
    if (bay.noAccess) return bay.noAccessWhy;
    if (oneWayLane(w, bay)) {
      const n = inQueue(w, bay);
      return `The queue at the yard gantry is full: ${n} ${n === 1 ? 'truck is' : 'trucks are'} loading or lined up for it. A longer yard along the gantry's lane gives room for more.`;
    }
    if (!t.boxes || w.handlerFree(bay, t)) {
      const going = w.trucks.filter(
        (o) => o.bayIdx === bay.idx && (o.state === 'toBay' || docked(w, o)),
      ).length;
      return w.freeDockSet(bay, lengthOf(w, t)).size === 0
        ? `Every loading spot at ${what} is taken: ${going} ${going === 1 ? 'truck is' : 'trucks are'} loading there or on the way.${bay.tiles ? ' A truck longer than a tile takes the spots either side of it too.' : ''}${bay.yard ? " A longer yard along the gantry's lane gives more spots." : ''}`
        : `Spots at ${what} are free, but trucks on their way in go first, so it would not stand in their way.`;
    }
    const stackers = w.people.filter((p) => p.kind === 'stacker').length;
    return `This yard has no yard gantry: reach stackers load its trucks, and ${stackers === 0 ? 'there are none' : `all ${stackers} are busy`}. More reach stackers, or a yard gantry here, load trucks sooner.`;
  }
  if (unloadWaiting(w, t)) {
    const crew = w.people.filter((p) => p.kind === 'dockhand' || p.kind === 'forklift');
    return crew.length === 0
      ? "Dockhands or forklifts unload shippers' crate trucks, and there are none. Hire some."
      : 'Waiting for a dockhand or forklift to unload it: they are busy, or cannot walk or drive here. More of them, or a path to it, unload it sooner.';
  }
  if (t.state !== 'loading') return undefined;
  const bay = dest(w, t.bayIdx);
  if (!bay) return undefined;
  if (t.boxes && bay.yard && cleared(w, bay) === 0 && boxesAt(bay) > 0) {
    return 'Waiting for customs to clear the containers in the yard.';
  }
  if (w.collectable(bay) === 0) {
    return 'Waiting for more cargo. It leaves part-loaded if none comes soon.';
  }
  if (byHand(w, t, bay) && (t.coming ?? 0) === 0) {
    const crew = w.people.filter((p) => p.kind === 'dockhand' || p.kind === 'forklift');
    return crew.length === 0
      ? 'Dockhands or forklifts load crate trucks, and there are none. Hire some.'
      : 'Waiting for a dockhand or forklift to load it: they are busy, or cannot walk or drive here. More of them, or a path to this bay, load it sooner.';
  }
  return undefined;
}

/**
 * A jib crane's crate storage for cargo coming in, for its panel: the
 * tiles of it in its reach, and the room left on those, whatever room the
 * storage has beyond them.
 */
function jibReachView(w: World, c: Crane): { stores: number; storeRoom?: number } {
  if (c.kind !== 'jib') return { stores: 0 };
  const stores = jibStores(w, c).filter((a) => takesImports(w, a));
  return {
    stores: stores.reduce((n, a) => n + jibReach(w, c, a).size, 0),
    storeRoom: stores.reduce((n, a) => n + jibRoom(w, c, a), 0),
  };
}

export function craneWhy(w: World, c: Crane): string {
  const full = stackFull(w, c);
  if (c.kind === 'jib') {
    if (c.busy) {
      return w.jibJobs.get(c)?.load
        ? 'Swinging crates on board from storage.'
        : 'Swinging crates straight into crate storage.';
    }
    // Crates an older game left on the ground at its feet.
    if (craneHeld(c) > 0) return 'Waiting for a forklift to collect the crates at its feet.';
    if (berthTrouble(w, c)) return 'No boat can come alongside it.';
    if (!jibStows(w, c)) return 'No crate storage in reach to swing crates into.';
    if (!jibStore(w, c)) {
      // Beside it is machines-only ground: trucks cannot load there, only forklifts take them on.
      return w.people.some((p) => p.kind === 'forklift')
        ? 'Crate storage in reach is full on the tiles right beside it, the only ones it swings to: waiting for forklifts to move crates off them.'
        : 'Crate storage in reach is full on the tiles right beside it, the only ones it swings to, and nothing empties them: only forklifts take crates off those. Buy one at a forklift depot.';
    }
    return 'No boat lying under it.';
  }
  if (c.busy) return 'Lifting containers off the ship.';
  // Nowhere for them to go: every yard with room has stopped taking them.
  const yards = [...w.yards.values()].filter((y) => !y.outgoing && bayRoom(y, true) > 0);
  if (craneHeld(c) > 0 && yards.length > 0 && yards.every((y) => y.shut)) {
    return 'Every container yard with room has stopped taking containers: open one to them again, or mark out another.';
  }
  if (full) {
    return c.kind === 'gantry'
      ? 'The bay between its legs is full: waiting for reach stackers.'
      : 'Stack full: waiting for reach stackers.';
  }
  return craneHeld(c) > 0
    ? 'Waiting for reach stackers to take the containers to a yard.'
    : berthTrouble(w, c)
      ? 'No container ship can come alongside it.'
      : 'No container ship alongside.';
}

/**
 * Why a crane cannot work as it is built, for a red mark over it: no ship
 * can come alongside it, or a jib crane has nowhere to swing crates into.
 */
export function craneTrouble(w: World, c: Crane): string | null {
  return berthTrouble(w, c) ?? jibTrouble(w, c);
}

/** Independent geometry checks keep later requirements visible while an office is still missing. */
export function craneSite(
  w: World,
  c: Crane,
): NonNullable<import('../../protocol/views').CraneView['site']> {
  const m = w.map;
  const feeder = c.kind !== 'jib';
  const cost = boatCostFor(w, feeder ? B.FEEDER_DRAFT : B.BOAT_DRAFT);
  const site = { water: false, wide: false, room: false, depth: false };
  for (const j of feeder ? craneFront(w, c) : [c.idx]) {
    for (const n of m.neighbors4(j)) {
      if (m.ocean[n] !== 1 || m.build[n] !== Build.None) continue;
      site.water = true;
      if (feeder && !wideQuay(w, j, n)) continue;
      site.wide = true;
      if (!mooredTiles(w, n, j, boatHalf(w, feeder))) continue;
      site.room = true;
      if (cost(n) === 1) site.depth = true;
    }
  }
  return site;
}

/** What is wrong with a crane as a thing to put right, for the guide that shows how (see CraneFix). */
export function craneFix(w: World, c: Crane): CraneFix | undefined {
  return berthIssue(w, c)?.fix ?? (jibTrouble(w, c) ? 'storage' : undefined);
}

/**
 * Why a jib crane cannot unload a boat, or null if it can: it swings crates
 * only into crate storage for cargo coming in within its reach, never down
 * at its feet.
 */
export function jibTrouble(w: World, c: Crane): string | null {
  if (c.kind !== 'jib' || jibStows(w, c)) return null;
  return 'No crate storage in reach to swing crates into: mark out storage for cargo coming in next to it, in the machines-only ground round it.';
}

/**
 * Why no ship can ever come alongside this crane, as the harbour master
 * would see it, or null if one could and there is simply none there now.
 * A jib crane takes any boat; a container crane a feeder, against a quay
 * two wide, with room for its hull and water deep enough.
 */
export function berthTrouble(w: World, c: Crane): string | null {
  return berthIssue(w, c)?.text ?? null;
}

/** berthTrouble, with which of them it is. */
function berthIssue(w: World, c: Crane): { fix: CraneFix; text: string } | null {
  const m = w.map;
  const feeder = c.kind !== 'jib';
  const draft = feeder ? B.FEEDER_DRAFT : B.BOAT_DRAFT;
  const water = boatCostFor(w, draft);
  const what = feeder ? 'a container ship' : 'a boat';
  let deepest = -1;
  let office = false;
  let wide = false;
  let room = false;
  // Berths square in front of it, where a ship lies centred on it, as the
  // harbour master looks for them (see freeBerths).
  for (const j of feeder ? craneFront(w, c) : [c.idx]) {
    for (const n of m.neighbors4(j)) {
      if (m.ocean[n] !== 1 || m.build[n] !== Build.None) continue;
      deepest = Math.max(deepest, m.depth[n]);
      if (!dockInUse(w, j)) continue;
      office = true;
      if (feeder && !wideQuay(w, j, n)) continue;
      wide = true;
      if (!mooredTiles(w, n, j, boatHalf(w, feeder))) continue;
      room = true;
      if (water(n) === 1) return null;
    }
  }
  if (deepest < 0) return { fix: 'water', text: `No open water beside it for ${what} to lie in.` };
  if (!office) {
    return {
      fix: 'office',
      text: 'No ship will come: this quay is not run by a harbour office. Build another office to coordinate more docks.',
    };
  }
  if (!wide)
    return {
      fix: 'wide',
      text: 'A container ship moors only against a quay two tiles wide: widen the quay here.',
    };
  if (!room) {
    const reach = boatHalf(w, feeder);
    return {
      fix: 'room',
      text: `No room alongside for ${what}'s hull: it lies centred on the crane, and needs open water ${reach} tile${reach === 1 ? '' : 's'} either way along the quay from it.`,
    };
  }
  return {
    fix: 'depth',
    text: `The water alongside is only ${deepest.toFixed(1)} m deep, and ${what} needs ${draft} m: dredge in front of it.`,
  };
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
    const text = craneTrouble(w, c);
    const h = c.kind === 'jib' ? 1.7 : c.kind === 'gantry' ? 2.9 : 2.3;
    if (text) out.push({ ...middle([c.idx]), h, text, type: 'crane', idx: c.idx });
  }
  // Sidings a rail line's trains cannot be worked at.
  if (w.contracts.some((c) => c.terms.kind === 'rail')) {
    for (const s of sidings(m)) {
      const text = sidingTrouble(w, s);
      if (text) out.push({ ...middle(s.tiles), h: 0.9, text, type: 'siding', idx: s.switch });
    }
  }
  // Yard gantries working no yard: beside none, or a second by one.
  for (const [g, text] of gantries(w).idle) {
    out.push({ ...middle([g]), h: 1.6, text, type: 'yardGantry', idx: g });
  }
  const marked = shipperMarks(w, out);
  // Truck bays with no road in front or no way in behind for those who load them.
  for (const b of w.bays.values()) {
    if (b.tiles || b.pile || marked.has(b.idx)) continue;
    const why = bayTrouble(m, b.idx, m.orient[b.idx] & 3);
    if (!why) continue;
    out.push({ ...middle([b.idx]), h: 1.2, text: `${why}.`, type: 'bay', idx: b.idx });
    marked.add(b.idx);
  }
  for (const b of [...w.bays.values(), ...w.yards.values()]) {
    // Crate storage the trucks cannot reach is still a buffer the forklifts empty.
    if (!b.noAccess || b.warehouse || (b.tiles && !b.yard) || marked.has(b.idx)) continue;
    // Worked by the trains in the siding beside it.
    if (bySiding(w, b)) continue;
    out.push({
      ...middle(b.tiles ?? [b.idx]),
      h: 1.2,
      text: b.noAccessWhy ?? 'Trucks cannot reach it.',
      type: b.yard ? 'yard' : 'bay',
      idx: b.idx,
    });
  }
  // Depots whose machines cannot drive out of the door.
  for (let i = 0; i < m.build.length; i++) {
    if (m.build[i] !== Build.Depot) continue;
    const why = depotDoorTrouble(m, i, m.orient[i] & 3);
    if (why) out.push({ ...middle([i]), h: 1, text: why, type: 'depot', idx: i });
  }
  // Boats the dockhands have nowhere to unload into, and fishing boats
  // nothing can bring the ice to.
  for (const b of w.boats) {
    const ice = iceTrouble(w, b);
    if (ice) out.push({ x: b.x, y: b.y, h: 1.6, text: ice, type: 'boat', idx: b.id });
    if (b.state !== 'moored' || !b.noRoom || b.crates === 0) continue;
    out.push({ x: b.x, y: b.y, h: 1.6, text: noRoomWords(w, b.noRoom), type: 'boat', idx: b.id });
  }
  // Docks boats do not use, with no harbour office or hut to look after them.
  for (const d of docks(w)) {
    if (d.coordinated) continue;
    const what = d.quay ? 'quay' : 'jetty';
    const who = d.quay
      ? `a harbour office: each looks after ${B.DOCKS_PER_OFFICE} docks`
      : `a harbour office (${B.DOCKS_PER_OFFICE} docks each) or a harbourmaster's hut (${B.JETTIES_PER_HUT} jetties each)`;
    out.push({
      ...middle(d.tiles),
      h: 0.9,
      text: `Boats do not use this ${what}: no one coordinates its berths. Build another ${who}, from Buildings.`,
      type: 'dock',
      idx: d.tiles[0],
    });
  }
  for (const p of w.people) {
    const why = quitTrouble(w, p);
    if (why) out.push({ x: p.x, y: p.y, h: 1.3, text: why, type: 'worker', idx: p.id });
  }
  for (const lot of lots(w)) {
    const why = lotTrouble(w, lot);
    if (why)
      out.push({
        ...middle(lot.tiles),
        h: 0.9,
        text: `${lot.name ? `Parking ${lot.name} is n` : 'N'}ot in use: ${why}.`,
        type: 'parking',
        idx: lot.tiles[0],
      });
  }
  return out;
}

/**
 * Why a worker may soon quit, for a red mark over them: morale low, or a
 * raise asked for that a no (an unanswered ask counts as one) would bring
 * low; and what would help.
 */
function quitTrouble(w: World, p: Dockhand): string | null {
  const refused = p.morale + B.RAISE_REFUSE_MORALE * traitDef(p.trait).moraleLoss;
  const asks = p.raiseAsk > 0 && refused < B.MORALE_WARN;
  if (p.morale >= B.MORALE_WARN && !asks) return null;
  const said: string[] = [
    p.lowMoraleDays > 0
      ? `${p.name} is miserable and will quit tomorrow.`
      : p.morale < B.MORALE_WARN
        ? `${p.name} is unhappy (morale ${Math.round(p.morale)}%) and may quit.`
        : `${p.name} may quit if the raise is turned down.`,
  ];
  if (p.raiseAsk > 0)
    said.push(
      `Asks for a raise to $${p.raiseAsk}/day: answer in the Staff panel by tomorrow, or it counts as a no.`,
    );
  if (p.kind === 'dockhand' && !w.map.build.includes(Build.BreakHut))
    said.push(
      'Nowhere to rest: breaks sat on the ground wear morale down. Build a break hut (Buildings).',
    );
  else if (p.raiseAsk === 0) said.push('Breaks in a break hut and a raise lift morale.');
  return said.join(' ');
}

/**
 * A red mark for each place shippers' trucks are held up: where they come
 * off the highway when they have no parking outside the port or no
 * outgoing storage, or over outgoing storage they cannot get to. Shippers
 * held up in the same place share a mark that names them. The storage
 * marked over, so it has no second mark of its own.
 */
function shipperMarks(w: World, out: ProblemView[]): Set<number> {
  const m = w.map;
  const marks = new Map<string, { at: number; names: string[]; text: string; mark: ProblemView }>();
  for (const c of w.contracts) {
    const trouble = shipperTrouble(w, c);
    if (!trouble?.bad) continue;
    const places = trouble.kind === 'reach' ? (trouble.stores ?? []) : [m.entry];
    for (const at of places) {
      const key = `${trouble.kind}:${at}`;
      const had = marks.get(key);
      if (had) {
        had.names.push(c.terms.name);
        continue;
      }
      const store = trouble.kind === 'reach' ? (w.bays.get(at) ?? w.yards.get(at)) : undefined;
      const tiles = store?.tiles ?? [at];
      marks.set(key, {
        at,
        names: [c.terms.name],
        text: trouble.text,
        mark: {
          x: tiles.reduce((n, i) => n + m.xOf(i) + 0.5, 0) / tiles.length,
          y: tiles.reduce((n, i) => n + m.yOf(i) + 0.5, 0) / tiles.length,
          h: 1.2,
          text: '',
          type: store ? (store.yard ? 'yard' : 'bay') : 'contract',
          idx: store ? at : c.id,
        },
      });
    }
  }
  const stores = new Set<number>();
  for (const { at, names, text, mark } of marks.values()) {
    if (mark.type !== 'contract') stores.add(at);
    const who =
      names.length === 1
        ? `${names[0]}: i`
        : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}: their`;
    const rest = names.length === 1 ? text.slice(1) : text.replace(/^Its /, ' ');
    out.push({ ...mark, text: `${who}${rest}.` });
  }
  return stores;
}

/** What holds a shipper's trucks up, for its contract card. */
function troubleView(w: World, c: Contract, customs: boolean): ContractView['trouble'] {
  const t = shipperTrouble(w, c);
  if (t) return { text: `${t.text}.`, bad: t.bad };
  if (c.terms.kind === 'rail' && !sidings(w.map).some((s) => yardsBeside(w, s).length > 0)) {
    return {
      text: 'Its trains cannot come: no rail siding has a container yard beside it, a row or two off, for them to be worked from.',
      bad: true,
    };
  }
  // Signed before the port needed a customs office, or with one since
  // pulled down: it goes on, but no line like it can be signed.
  if (!customs && needsCustomsOffice(c.terms)) {
    return {
      text: 'The port has no customs office: this line goes on as signed, but no other whose cargo customs clears can be signed till you build one (Buildings).',
      bad: false,
    };
  }
  return undefined;
}

/** Cargo waiting at each step from boat to truck, for the cargo flow. */
export function waitingCargo(w: World): Snapshot['stock'] {
  const cranes = [...w.cranes.values()];
  const yards = [...w.yards.values()];
  const boxes = yards.reduce((n, y) => n + boxesAt(y), 0);
  const clearedBoxes = yards.reduce((n, y) => n + cleared(w, y), 0);
  return {
    landed:
      [...w.piles.values()].reduce((n, p) => n + cratesAt(p), 0) +
      cranes.filter((c) => c.kind === 'jib').reduce((n, c) => n + craneHeld(c), 0),
    stored: [...w.bays.values()].reduce((n, b) => n + cratesAt(b), 0),
    crateExports: exportsWaiting(w, false),
    boxExports: exportsWaiting(w, true),
    boxLanded: cranes.filter((c) => c.kind !== 'jib').reduce((n, c) => n + craneHeld(c), 0),
    boxCustoms: boxes - clearedBoxes,
    boxCleared: clearedBoxes,
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
      (boxes ? c.containerExports : c.crateExports).aboard += outAboard(b);
    } else f.atSea += b.crates;
  }
  for (const k of w.cranes.values()) {
    const boxes = k.kind !== 'jib';
    (boxes ? c.containers : c.crates).landed += craneHeld(k);
    (boxes ? c.containerExports : c.crateExports).atCrane += craneHeld(k, true);
  }
  for (const p of w.piles.values()) c.crates.landed += cratesAt(p);
  for (const b of w.bays.values()) {
    // Storage no truck can reach is a buffer by the cranes.
    if (b.noAccess && b.tiles) c.crates.landed += cratesAt(b);
    else c.crates.ready += cratesAt(b);
    c.containers.ready += boxesAt(b);
    c.crateExports.stored += cratesAt(b, true);
  }
  for (const y of w.yards.values()) {
    const clear = cleared(w, y);
    c.containers.ready += clear;
    c.containers.customs += boxesAt(y) - clear;
    c.containerExports.stored += boxesAt(y, true);
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

/** The corners ahead of a forklift driving cell by cell, as x, y pairs; see EntityView.cells. */
function cellsAhead(p: Dockhand): number[] | undefined {
  const at = forkCells(p);
  return at && at.length > 0 ? at.slice(0, AHEAD_CELLS).flatMap((c) => [c.x, c.z]) : undefined;
}

export function buildSnapshot(w: World): Snapshot {
  const entities: EntityView[] = [];
  const staff: StaffView[] = [];
  const lifts = gantryLifts(w);
  const jibs = jibLifts(w);
  const moved = (where: object) => jibMoved(w, jibs, where);
  const parked = parkedPoses(w);
  for (const p of w.people) {
    const park = parked.get(p.id);
    entities.push({
      id: p.id,
      kind: p.kind,
      x: park?.x ?? p.x,
      y: park?.y ?? p.y,
      dir: park?.dir ?? p.dir,
      parked: park ? true : undefined,
      ...servedLoad(
        w,
        p,
        liftedLoad(w, p.carrying, isBoxy(p) ? [...carriedLooks(w, p)] : undefined, lifts.get(p.id)),
      ),
      moving: p.path.length > 0 || !!forkCells(p)?.length,
      ahead:
        (p.kind === 'dockhand' || p.kind === 'forklift') && p.path.length > 0
          ? p.path.slice(0, AHEAD_TILES)
          : undefined,
      cells: p.kind === 'forklift' || p.kind === 'dockhand' ? cellsAhead(p) : undefined,
      stand: p.stand && { ...p.stand },
      cargo: isBoxy(p)
        ? undefined
        : p.load.map((c) => cargoOf(c.fee, p.outbound ? 'goods' : 'fish')),
      handling: handlingPhase(w, p),
      sitting: p.state === 'resting' && p.hutIdx >= 0 && w.map.build[p.hutIdx] === Build.BreakHut,
      name: p.name,
      activity: p.blocked > 3 ? 'Waiting for someone to get out of the way' : workerActivity(w, p),
      variant: 0,
      capacity: p.capacity,
      alert: p.state === 'broken' || (p.state === 'idle' && !!p.stuck),
      why: workerWhy(w, p),
      ...handView(w, p),
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
      activity: workerActivity(w, p),
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
        ? deckView(w, b)
        : {
            load: b.crates + outAboard(b) + moved(b).set - moved(b).taken,
            catch: cargoOf(b.fee),
            // Its catch, then what it has taken on board to go out.
            cargo: [
              ...Array<Cargo>(b.crates).fill(cargoOf(b.fee)),
              ...(b.loaded ?? []).flatMap((c) => (c ? [cargoOf(c.fee, 'goods')] : [])),
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
                ? readyWords(w, b)
                : b.state === 'moored'
                  ? `Unloading, ${b.crates} ${b.vessel === 'feeder' ? 'containers' : b.bulk ? `tonnes of ${b.bulk}` : 'crates'} left`
                  : 'Heading back out to sea') +
        (giving ? `, giving way to a ${giving.company} ${kind(giving)}` : '') +
        (tugged(w, b) ? ', with a tug alongside' : ''),
      plot: plot && [...plot].flatMap((v, k) => (k % 9 < 2 ? [Math.round(v * 100) / 100] : [])),
      givingWayTo: giving?.id,
      variant: b.variant,
      capacity:
        b.vessel === 'bulker'
          ? B.BULKER_MAX_LOAD
          : b.vessel === 'feeder'
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
  for (const h of w.officials) {
    entities.push({
      id: h.id,
      kind:
        h.role === 'customs'
          ? 'customsOfficer'
          : h.role === 'berthing'
            ? 'berthingMaster'
            : 'harbourmaster',
      x: h.x,
      y: h.y,
      dir: h.dir,
      load: 0,
      moving: h.path.length > 0,
      pointing: h.boat >= 0 && h.path.length === 0 ? true : undefined,
      guiding: h.role === 'berthing' && h.path.length === 0 && !!guiding(w, h) ? true : undefined,
      name: h.name,
      activity: officialActivity(w, h),
      variant: 0,
      capacity: 0,
      alert: false,
    });
  }
  for (const t of w.trucks) {
    const shown = t.backing
      ? backingPose(w, t)
      : { x: lanePos(w, t)[0], y: lanePos(w, t)[1], dir: t.dir };
    entities.push({
      id: t.id,
      kind: 'truck',
      ...shown,
      // A shipper's containers are all alike; the rest as they were loaded.
      ...liftedLoad(
        w,
        t.cargo,
        t.boxes
          ? t.exports
            ? Array.from({ length: t.cargo }, (_, k) => boxLookOf(t.id, k))
            : trailerLooks(t)
          : undefined,
        lifts.get(t.id),
      ),
      // Where each of a hauliers' crate truck's crates stands on its bed.
      ...(t.boxes || t.exports || !t.load
        ? { cargo: t.boxes ? undefined : truckCargo(w, t) }
        : { bed: bedView(t) }),
      moving: t.path.length > 0,
      name: t.company,
      activity:
        t.exports && (t.state === 'toPark' || t.state === 'parked')
          ? t.staged !== undefined && t.state === 'toPark'
            ? `Paperwork done, driving to parking nearer the outgoing storage to wait for a spot`
            : papersInPort(w, t) && t.state === 'toPark'
              ? `Bringing ${t.cargo} crates of ${cargoName(cargoOf(t.value, 'goods'))} to ship: to parking outside the port, to wait for a spot in the outgoing storage`
              : w.tick < (t.papers ?? Infinity) || t.state === 'toPark'
                ? `Bringing ${t.cargo} ${t.boxes ? 'containers' : 'crates'} to ship: paperwork first, parked outside the port`
                : w.outgoingRoom(t)
                  ? `${papersInPort(w, t) ? 'Waiting' : 'Paperwork done, waiting'} for a free spot to unload at the outgoing storage`
                  : `${papersInPort(w, t) ? 'Waiting' : 'Paperwork done, waiting'} for storage with room for its ${t.boxes ? 'containers' : 'crates'}`
          : t.exports && t.state === 'toBay'
            ? `Bringing ${t.cargo} ${t.boxes ? 'containers' : 'crates'} to ${truckPlace(w, t, 'storage')}, to ship`
            : unloadWaiting(w, t)
              ? 'Waiting for a dockhand or forklift to unload it'
              : t.state === 'delivering'
                ? `Unloading ${t.cargo} ${t.boxes ? 'containers' : 'crates'} to ship`
                : t.state === 'toPark'
                  ? 'Driving to the parking'
                  : t.state === 'parked'
                    ? parkedWords(w, t)
                    : t.state === 'toBay'
                      ? `Driving to ${truckPlace(w, t, 'the truck bay')}`
                      : t.state === 'loading'
                        ? `Loading at ${truckPlace(w, t, 'the bay')}, ${t.cargo}/${bedCap(w, t)} ${t.boxes ? 'containers' : 'crates'}${customsHold(w, t)}`
                        : t.state === 'toTown' || t.state === 'unloading'
                          ? `${t.state === 'toTown' ? 'Delivering' : 'Unloading'} ${t.dropCount} ${t.boxes ? 'containers' : cratesOf(w, t)} at the ${BUSINESSES[w.map.build[t.drop ?? 0]]?.label ?? 'town'} in ${w.town?.name ?? 'town'}${laterStops(w, t)}`
                          : 'Heading out to the highway',
      variant: t.variant,
      capacity: t.capacity,
      alert: false,
      boxes: t.boxes,
      pickup: t.pickup,
      why: truckWhy(w, t),
    });
  }
  // The heap at the road's end is drawn, and shown, as a heap on the quay.
  const kerbs = [...w.bays.values()].filter((b) => b.kerb);
  const bays: BayView[] = [...w.bays.values()]
    .filter((b) => !b.kerb)
    .map((b) => ({
      idx: b.idx,
      name: b.name ?? '',
      stock: cratesAt(b) + moved(b).set,
      boxes: boxesAt(b),
      capacity: bayCap(b),
      large: b.large,
      warehouse: !!b.warehouse,
      exports: cratesAt(b, true) - moved(b).taken,
      cells: shownCells(w, b, moved(b)),
      outgoing: !!b.outgoing,
      shut: !!b.shut,
      byCrane: byCrane(w, b),
      tiles: b.tiles && [...b.tiles],
      noAccess: b.noAccess,
      noAccessWhy: b.noAccess ? b.noAccessWhy : undefined,
      ...holdsView(w, b),
    }));
  const customs = hasCustomsOffice(w);
  const contracts: ContractView[] = w.contracts.map((c) => ({
    id: c.id,
    terms: c.terms,
    satisfaction: c.satisfaction,
    cancelFee: cancelFee(c),
    breach: fine(w, breachPenalty(c)),
    active:
      c.terms.kind === 'fishery'
        ? w.boats.filter((b) => b.contractId === c.id).length
        : c.terms.kind === 'rail'
          ? w.rail.trains.filter((t) => t.port?.contractId === c.id && t.port.state === 'standing')
              .length
          : w.trucks.filter((t) => t.contractId === c.id && !t.away).length,
    away: (c.returns ?? []).filter((at) => at > w.tick).length,
    backIn: (c.returns ?? []).reduce(
      (n, at) => (at > w.tick && (n < 0 || at - w.tick < n) ? at - w.tick : n),
      -1,
    ),
    waiting: w.boats.filter((b) => b.contractId === c.id && b.state === 'anchored').length,
    nextIn: c.terms.kind !== 'haulier' ? Math.max(0, c.nextBoatTick - w.tick) : -1,
    trouble: troubleView(w, c, customs),
  }));
  const cap = capacity(w);
  return {
    learning: {
      ...structuredClone(w.learning),
      seenTips: [...w.learning.tips],
      reached: [...w.bays.values(), ...w.yards.values()]
        .filter((b) => b.tiles && !b.shut && w.loadingDocks(b).length > 0)
        .map((b) => b.idx),
      usableDepots: depotViews(w)
        .filter((d) => !depotDoorTrouble(w.map, d.idx, w.map.orient[d.idx] & 3))
        .map((d) => d.idx),
      hut: w.map.build.includes(Build.BreakHut),
      gate: w.map.build.includes(Build.Gate),
      customs: hasCustomsOffice(w),
    },
    tick: w.tick,
    cash: w.cash,
    speed: w.speed,
    seed: w.seed,
    difficulty: w.difficulty,
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
      name: y.name ?? '',
      boxes: boxesAt(y),
      exports: boxesAt(y, true),
      ...yardLooks(w, y, lifts),
      outgoing: !!y.outgoing,
      shut: !!y.shut,
      byCrane: byCrane(w, y),
      gantry: w.yardGantry(y),
      cleared: cleared(w, y),
      buried: buriedCount(w, y),
      nextClear: nextClear(w, y),
      pending: pending(w, y),
      capacity: bayCap(y),
      tiles: [...(y.tiles ?? [y.idx])],
      noAccess: y.noAccess,
      noAccessWhy: y.noAccess ? y.noAccessWhy : undefined,
    })),
    problems: problems(w),
    parking: lots(w).map((lot) => {
      const keys = new Set(lot.spaces.map((sp) => sp.tiles[0]));
      return {
        tiles: lot.tiles,
        name: lot.name ?? '',
        outside: lot.outside,
        wide: lot.wide,
        spaces: lot.spaces.length,
        used: w.trucks.filter((t) => t.park !== undefined && keys.has(t.park)).length,
        why: lotTrouble(w, lot),
      };
    }),
    piles: [...w.piles.values(), ...kerbs].map((p) => ({
      idx: p.idx,
      crates: cratesAt(p) - moved(p).taken,
      pallets: !!p.pallets,
      out: !!p.out,
      cells: pileCells(p, moved(p).taken),
    })),
    contracts,
    capacity: capacity(w),
    stock: waitingCargo(w),
    docks: {
      total: docks(w).length,
      coordinated: docks(w).filter((g) => g.coordinated).length,
      offices: w.map.build.filter((b) => b === Build.Office).length,
      huts: w.map.build.filter((b) => b === Build.HarbourHut).length,
      inUse: docks(w).flatMap((g) => (g.coordinated ? g.tiles : [])),
      idle: docks(w).flatMap((g) => (g.coordinated ? [] : g.tiles)),
    },
    depots: depotViews(w),
    progress: {
      tier: w.tier,
      town: w.townSize(),
      region: w.regionSize(),
      canUpgrade: canUpgrade(w),
      waitsOn: tierWaitsOn(w),
      baysWhy: baysOpen(w) ? undefined : baysShutWhy(w),
      sidingsWhy: w.tier >= 2 && !sidingsOpen(w) ? sidingsShutWhy(w) : undefined,
    },
    cranes: [...w.cranes.values()].map((c) => ({
      idx: c.idx,
      kind: c.kind,
      site: craneSite(w, c),
      ...servedStack(w, c, moved(c).set),
      max: craneStack(c),
      angle: c.angle,
      busy: c.busy,
      ...jibReachView(w, c),
      why: craneWhy(w, c),
      trouble: craneTrouble(w, c) ?? undefined,
      fix: craneFix(w, c),
      ...craneWork(w, c, jibs),
    })),
    town: w.town && {
      name: w.town.name,
      stage: w.town.stage,
      population: population(w.town, w.map),
      homes: townRoom(w.town, w.map),
      target: Math.round(townTarget(w.town)),
      jobs: w.town.jobs,
      goods: Math.round(w.town.goods),
      supplied: Math.round(w.town.supplied),
      sentFor: Math.round(w.town.sentFor ?? 0),
      wants: wantsView(w),
      businesses: businessViews(w),
      ...landmarkView(w, w.town),
      x: w.map.xOf(w.town.centre),
      y: w.map.yOf(w.town.centre),
    },
    trains: w.rail.trains.map((t) => structuredClone(t)),
    region: regionView(w),
    bulk: {
      at: [...w.bulk].map(
        ([i, l]) => [i, l.kind, Math.round(l.t * 10) / 10] as [number, BulkKind, number],
      ),
      grabs: [...w.map.build].flatMap((b, i) =>
        b === Build.GrabCrane
          ? [
              {
                idx: i,
                busy: !!w.grabs.get(i)?.busy,
                phase: (w.grabs.get(i)?.timer ?? 0) / B.GRAB_TICKS,
                water: w.map.neighbors4(i).find((n) => w.map.ocean[n] === 1) ?? -1,
              },
            ]
          : [],
      ),
    },
    sidings: sidings(w.map).map((x) => {
      const yards = yardsBeside(w, x);
      return {
        switch: x.switch,
        tiles: x.tiles,
        cars: sidingCars(x),
        yards: yards.length,
        yardsIn: yards.filter((y) => !y.outgoing).length,
        yardsOut: yards.filter((y) => y.outgoing).length,
        crossings: x.tiles.filter((i) => w.map.build[i] !== Build.Loadout && portCrossing(w.map, i))
          .length,
        loadout: x.tiles.some((i) => w.map.build[i] === Build.Loadout),
        train: trainAt(w, x.switch)?.id,
        why: sidingTrouble(w, x),
      };
    }),
    offers: w.offers.map((o) => ({
      id: o.id,
      terms: o.terms,
      signingFee: o.signingFee,
      expiresIn: o.expires - w.tick,
      breach: fine(w, breachPenalty(o)),
      truckingAfter: o.terms.kind === 'haulier' ? truckingWith(w, o.terms) : cap.trucking,
      checks:
        o.terms.kind === 'shipper' && !isIce(o.terms)
          ? shipperChecks(w, o.terms).map(({ ok, warn, text }) => ({ ok, warn, text }))
          : undefined,
      blocked: offerBlocked(w, o.terms, customs) ?? undefined,
    })),
  };
}

/** The places along the main line, for the Region panel. */
function regionView(w: World): PlaceView[] {
  const open = new Set(sidingsOpen(w) ? openCities(w.region).map((p) => p.id) : []);
  return w.region.places.map((p) => {
    const next = nextStep(p);
    const line = w.contracts.find((c) => c.terms.kind === 'rail' && c.terms.place === p.id);
    return {
      id: p.id,
      name: p.name,
      label: placeLabel(p.kind),
      city: p.kind === 'city',
      side: p.side,
      far: p.far,
      size: p.size,
      cap: placeCap(p),
      open: open.has(p.id),
      line: line?.terms.name,
      lately: Math.round(p.lately * 10) / 10,
      taken: stepsOf(p)
        .slice(0, p.steps)
        .map((s) => s.name),
      next: next && {
        name: next.name,
        aim: next.aim,
        opens: next.opens,
        have: p.goal,
        need: next.goal.total,
        cap: next.cap,
      },
      waits: p.kind === 'city' ? undefined : WAITS[p.kind],
    };
  });
}
