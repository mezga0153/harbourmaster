// Building the port: putting up and pulling down, marking out storage,
// machines-only ground and one-way roads, lights, gates, roundabouts and exits
// off the highway, dredging and reclaiming, and buying plots.

import type { World } from '../world';
import {
  Build,
  Deco,
  STORE_CODE,
  Store,
  Terrain,
  isBay,
  isDock,
  isPublicRoad,
  storesBoxes,
  storesOutgoing,
} from '../types';
import type { BuildKind, StoreKind } from '../types';
import { BUILDABLES, ROTATABLE } from '../rules/buildables';
import { BUILD_TIER, TIERS } from '../tiers';
import { message, moneyAt, tip } from './output';
import {
  anchorOf,
  bestFacing,
  footprint,
  gantryGround,
  gantryOver,
  partOrient,
} from '../rules/footprint';
import {
  bulldozeError,
  bulldozeTiles,
  bulldozeValue,
  depotDoorTrouble,
  placementCost,
  placementError,
  reflood,
  terraform,
  terraformCost,
  terraformError,
} from '../rules/placement';
import { book } from './economy';
import {
  FORKLIFT_ONLY,
  GATE_IN,
  GATE_OUT,
  LIGHTS,
  ONE_WAY,
  ON_PORT_ROAD,
  ON_QUAY,
  PARK_FLIP,
  PARK_MIRROR,
} from '../orient';
import { isLandError, nextPrice, ownedPlots, plotBounds, plotError, plotPrice } from '../land';
import * as B from '../balance';
import {
  ROUNDABOUT_RING,
  STORE_COST,
  STORE_LABEL,
  STORE_TIER,
  forkliftOnly,
  forkliftOnlyError,
  gateWay,
  lightsError,
  oneWayError,
  roadUnderParking,
  roundaboutCost,
  roundaboutError,
  storeError,
  unmarkRefund,
  unmarkable,
} from '../rules/marking';
import {
  HIGHWAY_COLUMNS,
  exitError,
  hasHighway,
  hasLights,
  isExit,
  isHighway,
  layHighway,
  oneWay,
  setExit,
  stepFacing,
} from '../roads';
import { nextParkWay } from '../rules/parking';
import type { Bay, Crate } from '../state';
import { bayCap, bayIncoming, bayRoom, boxesAt, cratesAt, isBoxy, yardPlace } from '../helpers';
import { cratesIn, place, slotsOf, stackOf } from './cargo/places';
import { addCrane } from './cranes';
import { docks } from './boats/berthing';
import { settleGantry } from './yardGantry';
import { boxesIn, jibStows, putBox, removePile, yardCells, yardSlots } from './cargo/stores';
import { dest } from './cargo/customs';
import { addBay, baysOpen, baysShutWhy, lotOf, lotTrouble, lots, removeBay } from './roads/bays';
import { handOn, prefixOf } from '../designations';

export function build(w: World, kind: BuildKind, tiles: number[], facing?: number): void {
  const def = BUILDABLES[kind];
  if (BUILD_TIER[kind] > w.tier) {
    return message(w, `${def.label} unlocks at the ${TIERS[BUILD_TIER[kind]].name}.`, 'bad');
  }
  if (kind === 'truckBay' && !baysOpen(w)) return message(w, baysShutWhy(w), 'bad');
  let spent = 0;
  let firstError: string | null = null;
  // Why a depot just built is no use yet, said once it is up.
  let shutIn: string | undefined;
  // A jib crane just built with no crate storage in reach to swing crates into.
  let noStore = false;
  // Docks grow out from the shore, so a line dragged from the sea inwards
  // only fits once the tiles nearer the shore are built: keep going round
  // until nothing more can be placed.
  let left = tiles.filter((i) => i >= 0 && i < w.map.build.length);
  let broke = false;
  while (left.length > 0 && !broke) {
    firstError = null;
    const skipped: number[] = [];
    for (const i of left) {
      const f = facing ?? bestFacing(w.map, kind, i);
      const err =
        placementError(w.map, kind, i, undefined, f) ??
        boatInTheWay(w, kind, i) ??
        kerbInTheWay(w, footprint(w.map, kind, i, f));
      if (err) {
        firstError ??= err;
        skipped.push(i);
        continue;
      }
      const cost = placementCost(w.map, kind, i);
      if (cost > w.cash) {
        firstError = 'Not enough money';
        broke = true;
        break;
      }
      book(w, 'construction', -cost);
      spent += cost;
      footprint(w.map, kind, i, f).forEach((t, k) => {
        // Built over, the heap at the road's end is gone: it had no crates.
        if (w.bays.get(t)?.kerb) w.bays.delete(t);
        // A building on a quay remembers it, to leave it when cleared.
        const quay = w.map.build[t] === Build.Quay ? ON_QUAY : 0;
        // A road over the railway is a level crossing.
        const crossing = def.code === Build.Road && w.map.build[t] === Build.Rail;
        // Parking is marked out on a road: which kind it was, for when it is unmarked.
        const under = kind === 'parking' && w.map.build[t] === Build.PortRoad ? ON_PORT_ROAD : 0;
        w.map.build[t] = crossing ? Build.Crossing : def.code;
        w.map.orient[t] =
          (ROTATABLE.has(kind) ? partOrient(f, k) : 0) |
          (kind === 'parking' ? w.map.orient[t] & ON_QUAY : quay) |
          under;
        w.map.deco[t] = Deco.None;
        w.dirty.add(t);
      });
      if (kind === 'truckBay' || kind === 'largeBay') addBay(w, i);
      if (kind === 'depot') shutIn ??= depotDoorTrouble(w.map, i, f) ?? undefined;
      if (kind === 'jibCrane') {
        addCrane(w, i, 'jib');
        noStore ||= !jibStows(w, w.cranes.get(i)!);
      }
      if (kind === 'jibCrane' || kind === 'harbourCrane' || kind === 'gantryCrane') {
        tip(w, 'cranes');
      }
      if (kind === 'yardGantry') tip(w, 'yardGantry');
      if (kind === 'harbourCrane') addCrane(w, i, 'harbour');
      if (kind === 'gantryCrane') {
        addCrane(w, i, 'gantry');
        keepForMachines(w, gantryGround(w.map, i, f));
      }
    }
    if (skipped.length === left.length) break;
    left = skipped;
  }
  // Built only partly, the rest off the port's land: the advisor explains, once.
  if (firstError && isLandError(firstError)) tip(w, 'land');
  if (spent > 0) moneyAt(w, -spent, tiles[tiles.length - 1]);
  if (spent > 0 && kind === 'road') exitsFor(w, tiles);
  if (spent > 0 && (kind === 'jetty' || kind === 'quay')) {
    w.dockCache = null;
    const idle = docks(w).some((g) => !g.coordinated);
    if (idle && !w.warnedOffice) {
      w.warnedOffice = true;
      message(
        w,
        kind === 'quay'
          ? 'Quays need a harbour office to coordinate them. Boats will not use this one until you build one.'
          : `Only ${B.FREE_DOCKS} jetties can run without a harbour office or harbourmaster's hut. Build one so boats use this jetty.`,
        'bad',
      );
    }
  } else if (spent > 0 && kind === 'office') {
    w.warnedOffice = false;
    message(w, 'The harbour office is open and coordinating berths.', 'good');
  } else if (spent > 0 && kind === 'customs') {
    message(
      w,
      'The customs office is open: lines landing timber, goods or containers, and the cannery, can be signed now.',
      'good',
    );
  } else if (spent > 0 && kind === 'harbourHut') {
    w.warnedOffice = false;
    message(
      w,
      `The harbourmaster's hut is open, looking after ${B.JETTIES_PER_HUT} more jetties.`,
      'good',
    );
  } else if (spent > 0 && kind === 'parking') {
    // Laid out where trucks cannot use it: say why.
    w.lotsCache = null;
    w.reachCache = null;
    const lot = lots(w).find((l) => l.tiles.some((i) => tiles.includes(i)));
    const trouble = lot && lotTrouble(w, lot);
    if (trouble) message(w, `This parking is no use yet: ${trouble.toLowerCase()}.`, 'bad');
  } else if (shutIn) {
    message(w, `This depot is no use yet: ${shutIn[0].toLowerCase()}${shutIn.slice(1)}`, 'bad');
  } else if (noStore) {
    message(
      w,
      'This jib crane unloads nothing yet: it swings crates only into crate storage, and there is none for cargo coming in next to it. Mark some out in the machines-only ground round it.',
      'bad',
    );
  } else if (firstError) message(w, firstError, 'bad');
}

/** Buy plot `p` of the port's land, beside the land it owns, if there is cash for it. */
export function buyPlot(w: World, p: number): void {
  const m = w.map;
  const err = plotError(m, p);
  if (err) return message(w, err, 'bad');
  const price = plotPrice(m, p);
  if (price > w.cash) {
    return message(
      w,
      `Not enough money: this plot costs $${price.toLocaleString('en-US')}.`,
      'bad',
    );
  }
  book(w, 'construction', -price);
  m.plots[p] = 1;
  m.plotsBought++;
  w.plotsChanged = true;
  const b = plotBounds(m, p);
  moneyAt(w, -price, m.idx((b.x0 + b.x1) >> 1, (b.y0 + b.y1) >> 1));
  message(
    w,
    `The plot is the port’s to build on: ${ownedPlots(m)} plots owned. The next plot of land costs $${nextPrice(m).toLocaleString('en-US')}.`,
    'good',
  );
}

/** Crates heaped at the road's end for the pickups on any of `tiles`, or on their way there. */
function kerbInTheWay(w: World, tiles: number[]): string | null {
  const heap = tiles.map((t) => w.bays.get(t)).find((b) => b?.kerb);
  return heap && cratesAt(heap) + heap.incoming > 0
    ? 'Crates are heaped here for the pickups'
    : null;
}

export function boatInTheWay(w: World, kind: BuildKind, i: number): string | null {
  // A jetty is made a quay under a boat moored at it: the boat lies on at
  // the quay, as at any other.
  if (kind !== 'jetty') return null;
  const blocked = w.boats.some((b) => b.berth === i || w.tileOf(b) === i);
  return blocked ? 'A boat is in the way' : null;
}

/** Mark port roads and quays for port machines only, free: round a gantry crane's rails. */
export function keepForMachines(w: World, tiles: number[]): void {
  for (const t of tiles) {
    const b = w.map.build[t];
    if ((b !== Build.Quay && b !== Build.PortRoad) || forkliftOnly(w.map, t)) continue;
    w.map.orient[t] |= FORKLIFT_ONLY;
    w.dirty.add(t);
  }
}

export function markForkliftOnly(w: World, tiles: number[], on: boolean): void {
  if (w.tier < B.FORKLIFT_ONLY_TIER) {
    return message(
      w,
      `Machines-only areas unlock at the ${TIERS[B.FORKLIFT_ONLY_TIER].name}.`,
      'bad',
    );
  }
  let spent = 0;
  let firstError: string | null = null;
  for (const i of tiles) {
    if (i < 0 || i >= w.map.build.length) continue;
    const err = forkliftOnlyError(w.map, i);
    if (err) {
      firstError ??= err;
      continue;
    }
    if (forkliftOnly(w.map, i) === on) continue;
    if (w.cash < B.FORKLIFT_ONLY_COST) {
      firstError = 'Not enough money';
      break;
    }
    book(w, 'construction', -B.FORKLIFT_ONLY_COST);
    spent += B.FORKLIFT_ONLY_COST;
    w.map.orient[i] ^= FORKLIFT_ONLY;
    w.dirty.add(i);
    if (on) tip(w, 'machinesOnly');
  }
  if (spent > 0) moneyAt(w, -spent, tiles[tiles.length - 1]);
  else if (firstError) message(w, firstError, 'bad');
}

/**
 * A public road just built up to the highway, meeting it head on rather
 * than running alongside, opens an exit there; or says why it cannot.
 */
export function exitsFor(w: World, tiles: number[]): void {
  const m = w.map;
  if (!hasHighway(m)) return;
  const road = (x: number, y: number) => m.inBounds(x, y) && isPublicRoad(m.build[m.idx(x, y)]);
  const rows = new Set<number>();
  for (const i of tiles) {
    const y = m.yOf(i);
    if (m.xOf(i) !== HIGHWAY_COLUMNS || !road(HIGHWAY_COLUMNS, y)) continue;
    if (isExit(m, m.idx(1, y)) || road(HIGHWAY_COLUMNS, y - 1) || road(HIGHWAY_COLUMNS, y + 1))
      continue;
    rows.add(y);
  }
  for (const y of rows) openExit(w, y, true);
}

/** Open an exit off the highway at row `row`, and the road off it; `auto`, for a road built up to it. */
export function openExit(w: World, row: number, auto = false): void {
  const m = w.map;
  const why = (text: string) =>
    message(w, auto ? `The road meets the highway, but no exit opens: ${text}` : text, 'bad');
  if (w.tier < B.EXIT_TIER) {
    return why(
      auto
        ? `exits open from the ${TIERS[B.EXIT_TIER].name}.`
        : `Highway exits open at the ${TIERS[B.EXIT_TIER].name}.`,
    );
  }
  const err = exitError(m, row);
  if (err) return why(auto ? `${err[0].toLowerCase()}${err.slice(1)}.` : err);
  if (w.cash < B.EXIT_COST) {
    return why(
      auto ? `an exit costs $${B.EXIT_COST.toLocaleString('en-US')}.` : 'Not enough money',
    );
  }
  book(w, 'construction', -B.EXIT_COST);
  setExit(m, row, true);
  const beside = m.idx(HIGHWAY_COLUMNS, row);
  if (m.build[beside] === Build.None) {
    m.build[beside] = Build.Road;
    m.orient[beside] = 0;
    m.deco[beside] = Deco.None;
  }
  for (let x = 0; x <= HIGHWAY_COLUMNS; x++) w.dirty.add(m.idx(x, row));
  moneyAt(w, -B.EXIT_COST, beside);
  tip(w, 'exits');
}

/**
 * Make road tiles one way, the way the drag ran over them (the last the
 * way it came onto it); one tile on its own is turned the other way.
 * With `on` false, they go back to two way.
 */
export function markOneWay(w: World, tiles: number[], on: boolean): void {
  const m = w.map;
  // Truck parking picked: its lot turned round, to run the other way.
  const lots = new Set(tiles.filter((i) => m.build[i] === Build.Parking).map((i) => lotOf(w, i)));
  for (const lot of lots) {
    if (!lot) continue;
    const next = nextParkWay(m, lot.tiles);
    for (const t of lot.tiles) {
      m.orient[t] = (m.orient[t] & ~(PARK_FLIP | PARK_MIRROR)) | next;
      w.dirty.add(t);
    }
  }
  if (lots.size > 0) w.lotsCache = null;
  tiles = tiles.filter((i) => m.build[i] !== Build.Parking);
  if (tiles.length === 0) return;
  if (w.tier < B.ONE_WAY_TIER) {
    return message(w, `One-way roads unlock at the ${TIERS[B.ONE_WAY_TIER].name}.`, 'bad');
  }
  let spent = 0;
  let firstError: string | null = null;
  tiles.forEach((i, k) => {
    if (i < 0 || i >= m.build.length || firstError === 'Not enough money') return;
    const err = oneWayError(m, i);
    if (err) {
      firstError ??= err;
      return;
    }
    const was = oneWay(m, i);
    if (!on) {
      if (was < 0) return;
      m.orient[i] &= ~ONE_WAY;
      w.dirty.add(i);
      return;
    }
    const next = tiles[k + 1];
    const prev = tiles[k - 1];
    const along = (a: number, b: number) => m.neighbors4(a).includes(b);
    const f =
      next !== undefined && along(i, next)
        ? stepFacing(m, i, next)
        : prev !== undefined && along(prev, i)
          ? stepFacing(m, prev, i)
          : was >= 0
            ? was ^ 2
            : -1;
    if (f < 0) {
      firstError ??= 'Drag along the road the way the traffic should go';
      return;
    }
    if (f === was) return;
    if (w.cash < B.ONE_WAY_COST) {
      firstError = 'Not enough money';
      return;
    }
    book(w, 'construction', -B.ONE_WAY_COST);
    spent += B.ONE_WAY_COST;
    m.orient[i] = (m.orient[i] & ~3) | ONE_WAY | f;
    w.dirty.add(i);
  });
  if (spent > 0) {
    moneyAt(w, -spent, tiles[tiles.length - 1]);
    tip(w, 'oneWay');
  } else if (firstError) message(w, firstError, 'bad');
}

/** Put up traffic lights at a junction, or take them down again for nothing back. */
export function toggleLights(w: World, i: number): void {
  const m = w.map;
  if (i < 0 || i >= m.build.length) return;
  if (w.tier < B.LIGHTS_TIER) {
    return message(w, `Traffic lights unlock at the ${TIERS[B.LIGHTS_TIER].name}.`, 'bad');
  }
  const err = lightsError(m, i);
  if (err) return message(w, err, 'bad');
  const tiles = [i];
  const on = !hasLights(m, i);
  if (on && w.cash < B.LIGHTS_COST) return message(w, 'Not enough money', 'bad');
  if (on) {
    book(w, 'construction', -B.LIGHTS_COST);
    moneyAt(w, -B.LIGHTS_COST, i);
    tip(w, 'lights');
  }
  for (const t of tiles) {
    m.orient[t] = on ? m.orient[t] | LIGHTS : m.orient[t] & ~LIGHTS;
    w.dirty.add(t);
  }
}

/** Let trucks through a port gate both ways, only in, or only out. */
export function setGateWay(w: World, i: number, way: 'both' | 'in' | 'out'): void {
  const m = w.map;
  if (i < 0 || i >= m.build.length) return;
  const g = anchorOf(m, i);
  if (m.build[g] !== Build.Gate) return message(w, 'Pick a port gate', 'bad');
  if (w.tier < B.ONE_WAY_TIER) {
    return message(w, `One-way gates unlock at the ${TIERS[B.ONE_WAY_TIER].name}.`, 'bad');
  }
  if (gateWay(m, g) === way) return;
  if (w.cash < B.GATE_WAY_COST) return message(w, 'Not enough money', 'bad');
  book(w, 'construction', -B.GATE_WAY_COST);
  moneyAt(w, -B.GATE_WAY_COST, g);
  const bits = way === 'in' ? GATE_IN : way === 'out' ? GATE_OUT : 0;
  m.orient[g] = (m.orient[g] & ~(GATE_IN | GATE_OUT)) | bits;
  w.dirty.add(g);
}

/** A roundabout round an island at `c`: a ring of one-way road, keeping right. */
export function buildRoundabout(w: World, c: number): void {
  const m = w.map;
  if (c < 0 || c >= m.build.length) return;
  if (w.tier < B.LIGHTS_TIER) {
    return message(w, `Roundabouts unlock at the ${TIERS[B.LIGHTS_TIER].name}.`, 'bad');
  }
  const err = roundaboutError(m, c);
  if (err) return message(w, err, 'bad');
  const cost = roundaboutCost(m, c);
  if (w.cash < cost) return message(w, 'Not enough money', 'bad');
  book(w, 'construction', -cost);
  moneyAt(w, -cost, c);
  const cx = m.xOf(c);
  const cy = m.yOf(c);
  // The island in the middle.
  m.build[c] = Build.None;
  m.orient[c] = 0;
  m.deco[c] = Deco.None;
  w.dirty.add(c);
  for (const [dx, dy, f] of ROUNDABOUT_RING) {
    const i = m.idx(cx + dx, cy + dy);
    m.build[i] = Build.Road;
    m.orient[i] = ONE_WAY | f;
    m.deco[i] = Deco.None;
    w.dirty.add(i);
  }
  tip(w, 'roundabout');
}

/**
 * Lay the highway down the west edge of a map from before it ran on the
 * map: the roads that went off the edge there join it at exits, and
 * anything else in its way is cleared. Trucks out on the old highway
 * round to the town head off.
 */
export function layHighwayIn(w: World): void {
  const m = w.map;
  if (hasHighway(m)) return;
  const exits = new Set<number>([m.yOf(m.entry)]);
  let cleared = false;
  for (let y = 0; y < m.h; y++) {
    if (isPublicRoad(m.build[m.idx(0, y)]) && isPublicRoad(m.build[m.idx(HIGHWAY_COLUMNS, y)])) {
      exits.add(y);
    }
    for (let x = 0; x < HIGHWAY_COLUMNS; x++) {
      const i = m.idx(x, y);
      if (m.build[i] === Build.None || isPublicRoad(m.build[i])) continue;
      w.bays.delete(i);
      w.yards.delete(i);
      cleared = true;
    }
  }
  const row = m.yOf(m.entry);
  const beside = m.idx(HIGHWAY_COLUMNS, row);
  if (m.build[beside] === Build.None) m.build[beside] = Build.Road;
  layHighway(m, exits);
  m.entry = m.idx(HIGHWAY_COLUMNS - 1, row);
  if (cleared) rebuildStores(w);
  for (const t of w.trucks) {
    if (!t.round && !t.then) continue;
    t.round = undefined;
    t.then = undefined;
    w.headOut(t);
  }
}

/** Mark port road and quay tiles out as storage, or clear them, for a refund. */
/**
 * Clear whatever marks lie on the tiles: storage, which gives back what
 * bulldozing it would, and machines-only marks, for nothing. The ground
 * kept round cranes and gantry rails stays as it is.
 */
export function unmark(w: World, tiles: number[]): void {
  let refund = 0;
  let stores = false;
  let any = false;
  for (const i of tiles) {
    if (i < 0 || i >= w.map.build.length) continue;
    const what = unmarkable(w.map, i);
    if (what.store) {
      refund += unmarkRefund(w.map, i);
      w.map.store[i] = Store.None;
      stores = true;
    }
    if (what.machines) w.map.orient[i] &= ~FORKLIFT_ONLY;
    if (what.road) w.map.orient[i] &= ~(ONE_WAY | LIGHTS);
    if (what.parking) {
      // The road it was marked out on, back as it was.
      refund += unmarkRefund(w.map, i);
      w.map.build[i] = roadUnderParking(w.map, i);
      w.map.orient[i] &= ON_QUAY;
    }
    if (what.store || what.machines || what.road || what.parking) {
      w.dirty.add(i);
      any = true;
    }
  }
  if (stores) rebuildStores(w);
  if (refund > 0) {
    book(w, 'construction', refund);
    moneyAt(w, refund, tiles[tiles.length - 1]);
  }
  if (!any) message(w, 'Nothing marked out here that can be cleared', 'bad');
}

export function markStore(w: World, tiles: number[], kind: StoreKind, on: boolean): void {
  const tier = STORE_TIER[kind];
  if (w.tier < tier) {
    return message(w, `${STORE_LABEL[kind]} unlocks at the ${TIERS[tier].name}.`, 'bad');
  }
  let net = 0;
  let firstError: string | null = null;
  let changed = false;
  for (const i of tiles) {
    if (i < 0 || i >= w.map.build.length) continue;
    const err =
      storeError(w.map, i, kind, on) ??
      (on && w.piles.has(i) ? 'Cargo is waiting on the quay here' : null);
    if (err) {
      firstError ??= err;
      continue;
    }
    const value = on ? -STORE_COST[kind] : Math.floor(STORE_COST[kind] * B.BULLDOZE_REFUND);
    if (value < 0 && w.cash < -value) {
      firstError = 'Not enough money';
      break;
    }
    book(w, 'construction', value);
    net += value;
    w.map.store[i] = on ? STORE_CODE[kind] : Store.None;
    w.dirty.add(i);
    changed = true;
  }
  if (changed) rebuildStores(w);
  if (changed && on) tip(w, kind === 'boxes' ? 'yards' : 'storage');
  if (net !== 0) moneyAt(w, net, tiles[tiles.length - 1]);
  else if (firstError) message(w, firstError, 'bad');
}

/**
 * Gather the storage marked out on the map into areas, one for each run of
 * touching tiles of a kind, keeping what they held: each area's goods are
 * set down a tile's worth at a time and picked up again by the new areas.
 * Whatever was on a tile no longer marked out is lost.
 */
export function rebuildStores(w: World): void {
  const m = w.map;
  // Any container on a gantry's spreader goes down first, with the rest.
  for (const y of w.yards.values()) settleGantry(w, y);
  const old = [...w.bays.values(), ...w.yards.values()].filter((b) => b.tiles);
  // Each tile's area's designation, for the areas laid out afresh to keep.
  const had = new Map<number, string>();
  for (const a of old) for (const t of a.tiles!) if (a.name) had.set(t, a.name);
  const areas: Bay[] = [];
  // Containers coming in, by the tile they stand on.
  const held = new Map<number, Crate[]>();
  // Crates coming in, by the tile they stand on.
  const crates = new Map<number, Crate[]>();
  const lost = { crates: 0, boxes: 0 };
  // Crate storage marked out just as it was keeps each crate in its slot;
  // any other is stacked afresh.
  const same = new Map<string, Bay>();
  for (const a of old) if (!a.yard) same.set(a.tiles!.join(), a);
  for (const a of old) {
    const tiles = a.tiles!;
    if (a.yard) {
      const cells = yardCells(a);
      for (const s of yardSlots(w, a).boxes) {
        const t = tiles[Math.min(tiles.length - 1, yardPlace(s).tile)];
        held.set(t, [...(held.get(t) ?? []), cells[s]!]);
      }
      lost.boxes += boxesAt(a);
    } else {
      for (const s of slotsOf(a, false)) {
        const t = tiles[Math.min(tiles.length - 1, stackOf(a, s))];
        crates.set(t, [...(crates.get(t) ?? []), a.cells[s]!]);
      }
      lost.crates += cratesAt(a);
    }
    (a.yard ? w.yards : w.bays).delete(a.idx);
  }
  w.spotCache.clear();
  w.laneCache = null;
  w.railCache = null;
  w.laneOfCache.clear();
  w.yardLaneCache = null;
  w.gantryCache = null;
  w.storeOf.fill(-1);
  for (let i = 0; i < m.store.length; i++) {
    const kind = m.store[i];
    if (!kind || w.storeOf[i] >= 0) continue;
    const tiles: number[] = [];
    const stack = [i];
    w.storeOf[i] = i;
    while (stack.length > 0) {
      const t = stack.pop()!;
      tiles.push(t);
      for (const n of m.neighbors4(t)) {
        if (m.store[n] !== kind || w.storeOf[n] >= 0) continue;
        w.storeOf[n] = i;
        stack.push(n);
      }
    }
    tiles.sort((a, b) => a - b);
    const yard = storesBoxes(kind);
    const area: Bay = {
      idx: i,
      large: !yard,
      warehouse: !yard,
      yard,
      outgoing: storesOutgoing(kind),
      tiles,
      boxIncoming: 0,
      cells: [],
      incoming: 0,
      nextTruckTick: 0,
      noAccess: false,
    };
    const was = yard ? undefined : same.get(tiles.join());
    if (was) {
      // Each crate, and each export, just where it stood.
      area.cells = was.cells.slice();
      lost.crates -= cratesAt(area);
    } else if (!yard) {
      const goods = tiles.flatMap((t) => crates.get(t) ?? []).slice(0, bayCap(area));
      place(w, area, goods);
      lost.crates -= goods.length;
    }
    if (yard) {
      // Joined up from areas stacked at different times: those clearing first, first.
      const goods = tiles
        .flatMap((t) => held.get(t) ?? [])
        .slice(0, bayCap(area))
        .sort((x, y) => (x.ready ?? 0) - (y.ready ?? 0));
      for (const c of goods) putBox(w, area, c, false);
      lost.boxes -= goods.length;
    }
    (yard ? w.yards : w.bays).set(i, area);
    areas.push(area);
  }
  handOn(areas as (Bay & { tiles: number[] })[], prefixOf, had, (a, name) => (a.name = name));
  // Loads on their way, and trucks loading, go to the area their old one became.
  const remap = new Map<number, number>();
  for (const a of old) {
    const code =
      STORE_CODE[
        a.yard ? (a.outgoing ? 'boxesOut' : 'boxes') : a.outgoing ? 'cratesOut' : 'crates'
      ];
    const t = a.tiles!.find((t) => m.store[t] === code);
    const now = t === undefined ? -1 : w.storeOf[t];
    remap.set(a.idx, now);
    const area = dest(w, now);
    if (area) {
      area.nextTruckTick = Math.max(area.nextTruckTick, a.nextTruckTick);
      area.noAccess ||= a.noAccess;
      // Joined with one shut, it stays shut.
      if (a.shut) area.shut = true;
    }
  }
  for (const p of w.people) {
    const now = remap.get(p.bayIdx);
    if (now !== undefined) p.bayIdx = now;
    const area = dest(w, p.bayIdx);
    if (area?.tiles && p.planned > 0) {
      // Exports on their way into storage by a crane, or cargo coming in.
      if (p.outbound) area.exportIncoming = (area.exportIncoming ?? 0) + p.planned;
      else bayIncoming(area, isBoxy(p), p.planned);
    }
    // And forklifts on their way to collect from storage.
    const from = remap.get(p.stockIdx);
    if (from !== undefined) p.stockIdx = from;
    const store = w.bays.get(p.stockIdx);
    if (store?.tiles && !p.carrying) store.reserved = (store.reserved ?? 0) + p.planned;
  }
  for (const t of w.trucks) t.bayIdx = remap.get(t.bayIdx) ?? t.bayIdx;
  // Exports go with the area their old one became, as far as there is room.
  for (const a of old) {
    const area = dest(w, remap.get(a.idx) ?? -1);
    // Crate storage marked out just as it was has them where they stood.
    if (!a.yard && area && area.tiles?.join() === a.tiles?.join()) continue;
    const room = area ? Math.max(0, bayRoom(area, !!a.yard)) : 0;
    if (a.yard) {
      const goods = boxesIn(a, true);
      if (area) for (const c of goods.slice(0, room)) putBox(w, area, c, true);
      lost.boxes += Math.max(0, goods.length - room);
      continue;
    }
    // Waiting on their papers still, where they went.
    const goods = cratesIn(a, true);
    if (area) place(w, area, goods.slice(0, room));
    lost.crates += Math.max(0, goods.length - room);
  }
  for (const t of w.trucks) {
    const area = dest(w, t.bayIdx);
    if (t.exports && t.state === 'toBay' && area?.tiles) {
      area.exportIncoming = (area.exportIncoming ?? 0) + t.cargo;
    }
  }
  for (const p of w.people) {
    const area = dest(w, p.stockIdx);
    if (p.outbound && !p.carrying && area?.tiles) {
      area.outReserved = (area.outReserved ?? 0) + p.planned;
    }
  }
  // Setting containers down in the yards above looks at which yard each
  // gantry works, while the yards were still being marked out: not kept.
  w.gantryCache = null;
  w.yardLaneCache = null;
  const what = [
    lost.crates > 0 && `${lost.crates} crate${lost.crates === 1 ? '' : 's'}`,
    lost.boxes > 0 && `${lost.boxes} container${lost.boxes === 1 ? '' : 's'}`,
  ].filter(Boolean);
  if (what.length > 0) {
    message(
      w,
      `${what.join(' and ')} stored there ${lost.crates + lost.boxes === 1 ? 'was' : 'were'} lost.`,
      'bad',
    );
  }
}

/**
 * Dredge or reclaim each tile a step. Like docks, a channel dug inland
 * from the shore fits in one drag, in as many rounds as it takes.
 */
export function terraformTiles(w: World, tiles: number[], raise: boolean): void {
  if (w.tier < B.TERRAFORM_TIER) {
    const what = raise ? 'Land reclamation' : 'Dredging';
    return message(w, `${what} unlocks at the ${TIERS[B.TERRAFORM_TIER].name}.`, 'bad');
  }
  const m = w.map;
  let spent = 0;
  let firstError: string | null = null;
  const done = new Set<number>();
  let left = tiles.filter((i) => i >= 0 && i < m.build.length);
  let broke = false;
  for (let progress = true; progress && !broke && left.length > 0;) {
    progress = false;
    firstError = null;
    const skipped: number[] = [];
    for (const i of left) {
      const cx = m.xOf(i) + 0.5;
      const cy = m.yOf(i) + 0.5;
      const err =
        terraformError(m, i, raise, done) ??
        (w.boats.some((b) => Math.hypot(b.x - cx, b.y - cy) < 1.5) ? 'A boat is in the way' : null);
      if (err) {
        firstError ??= err;
        skipped.push(i);
        continue;
      }
      const cost = terraformCost(m, i, raise);
      if (cost > w.cash) {
        firstError = 'Not enough money';
        broke = true;
        break;
      }
      book(w, 'construction', -cost);
      spent += cost;
      terraform(m, i, raise);
      done.add(i);
      w.dirty.add(i);
      progress = true;
    }
    left = skipped;
  }
  if (done.size > 0) {
    for (const i of reflood(m)) w.dirty.add(i);
    w.dockCache = null;
    w.capacityCache = null;
  }
  if (firstError && isLandError(firstError)) tip(w, 'land');
  if (spent > 0) moneyAt(w, -spent, tiles[tiles.length - 1]);
  else if (firstError) message(w, firstError, 'bad');
}

export function bulldoze(w: World, tiles: number[]): void {
  // Ground a gantry crane taken down kept for machines, to give back.
  const freed: number[] = [];
  let net = 0;
  let lastError: string | null = null;
  let stores = false;
  for (const t of tiles) {
    if (t < 0 || t >= w.map.build.length) continue;
    // A click anywhere on a building takes all of it down.
    const i = anchorOf(w.map, t);
    let err = bulldozeError(w.map, i);
    if (!err && isDock(w.map.build[i]) && w.boats.some((b) => b.jetty === i)) {
      err = 'A boat is moored here';
    }
    if (err) {
      lastError = err;
      continue;
    }
    const value = bulldozeValue(w.map, i);
    if (value < 0 && w.cash < -value) {
      lastError = 'Not enough money';
      break;
    }
    book(w, 'construction', value);
    net += value;
    if (isHighway(w.map.build[i])) {
      // Closing an exit: the barrier down the middle goes back across.
      setExit(w.map, w.map.yOf(i), false);
      for (let x = 0; x < HIGHWAY_COLUMNS; x++) w.dirty.add(w.map.idx(x, w.map.yOf(i)));
      continue;
    }
    if (w.map.build[i] === Build.Gantry) {
      w.cranes.delete(i);
      freed.push(...gantryGround(w.map, i, w.map.orient[i] & 3));
    }
    if (w.map.build[i] === Build.JibCrane || w.map.build[i] === Build.HarbourCrane) {
      // Taking down a crane leaves the quay it stood on.
      w.cranes.delete(i);
      w.map.build[i] = Build.Quay;
    } else if (w.map.build[i] === Build.Crossing) {
      // Taking up a level crossing leaves the line.
      w.map.build[i] = Build.Rail;
    } else if (w.map.build[i] !== Build.None) {
      if (isBay(w.map.build[i]) || w.bays.get(i)?.kerb) removeBay(w, i);
      removePile(w, i);
      for (const b of bulldozeTiles(w.map, i)) {
        w.map.build[b] = w.map.orient[b] & ON_QUAY ? Build.Quay : Build.None;
        w.map.orient[b] = 0;
        if (w.map.store[b]) {
          w.map.store[b] = Store.None;
          stores = true;
        }
        w.dirty.add(b);
      }
    } else if (w.map.deco[i] !== Deco.None) {
      w.map.deco[i] = Deco.None;
    } else {
      w.map.terrain[i] = Terrain.Grass;
    }
    w.dirty.add(i);
  }
  if (stores) rebuildStores(w);
  // What no other gantry crane's rails still need goes back to everyone.
  for (const t of freed) {
    if (!forkliftOnly(w.map, t) || gantryOver(w.map, t, true) >= 0) continue;
    w.map.orient[t] &= ~FORKLIFT_ONLY;
    w.dirty.add(t);
  }
  if (net !== 0) moneyAt(w, net, tiles[tiles.length - 1]);
  else if (lastError && tiles.length === 1) message(w, lastError, 'bad');
}
