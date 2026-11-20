// The port's own trains: what opens the sidings for them, and their visits.
// A port train waits off the map till the main line is clear, runs along it
// and turns off by the switch into its siding, where it stands to be worked;
// then it backs out onto the main line, clear of the switch, and goes on
// the way it came.

import type { World } from '../world';
import * as B from '../balance';
import { LANDMARKS } from '../town';
import { Build, TICKS_PER_DAY } from '../types';
import {
  CAR_LENGTH,
  RAIL_RUN,
  along,
  arrived,
  moving,
  pointAt,
  railColumn,
  runTrain,
  stepThrough,
  trainLength,
  wayLength,
  type CarKind,
  type Point,
  type Train,
} from '../railway';
import {
  loadingTrack,
  portCrossing,
  sidingAt,
  sidings,
  standOffset,
  trackWagons,
  type Siding,
} from '../rules/rails';
import type { Crate } from '../state';
import { trainWagons } from '../contracts';
import { aboard, wagonCells, yardsBeside } from './cargo/wagons';
import { gantriesOn, stepRailGantries } from './railGantry';
import { book, payout } from './economy';
import { message, moneyAt } from './output';
import { boxLookOf } from '../helpers';
import type { GameMap } from '../map';
import { placeById, placeName, served } from './region';
import type { PlaceKind } from '../region';
import { hoppersFull } from './bulk';

/** Where the town's railway station comes in LANDMARKS. */
const STATION = LANDMARKS.findIndex((l) => l.code === Build.Station);

/** Whether the railway lets the port lay sidings: once the town has its station. */
export function sidingsOpen(w: World): boolean {
  return (w.town?.landmarks ?? 0) > STATION;
}

/** Why the port cannot lay sidings yet. */
export function sidingsShutWhy(w: World): string {
  const at = w.town?.landmarks ?? 0;
  return at > STATION
    ? ''
    : `The railway company lays no sidings for the port till ${w.town?.name ?? 'the town'} has its railway station: see the Town panel`;
}

/** How many cars, the locomotive with them, stand in a siding clear of the main line. */
export function sidingCars(s: Siding): number {
  // From the middle of its first tile to the buffer stop, and the last of the curve.
  return Math.floor((s.tiles.length - 0.15) / CAR_LENGTH);
}

/** A siding's switch's row middle and the main line's x there. */
function switchPoint(map: GameMap, s: Siding): Point {
  return [map.xOf(s.switch) + 0.5, map.yOf(s.switch) + 0.5];
}

/**
 * The curve off the main line into a siding, for a train running `dir`
 * along the line: a quarter circle of a tile's radius from the line, a
 * tile before the switch's row, to the middle of the siding's first tile.
 */
function curve(map: GameMap, s: Siding, dir: 1 | -1): Point[] {
  const [rx, ry] = switchPoint(map, s);
  const cx = rx + s.side;
  const cy = ry - dir;
  const out: Point[] = [];
  for (let k = 0; k <= 8; k++) {
    const a = (k / 8) * (Math.PI / 2);
    out.push([cx - s.side * Math.cos(a), cy + dir * Math.sin(a)]);
  }
  return out;
}

/**
 * Where a train's front stops in a siding: its locomotive just past the
 * loading track, its wagons along it; with none, just short of the buffer
 * stop. See standOffset.
 */
function bufferEnd(map: GameMap, s: Siding): Point {
  const [rx, ry] = switchPoint(map, s);
  return [rx + s.side * standOffset(map, s), ry];
}

/** In along the main line from past the map's end, `dir`, and off into the siding. */
export function wayIn(map: GameMap, s: Siding, dir: 1 | -1): Point[] {
  const [rx] = switchPoint(map, s);
  const from: Point = [rx, dir > 0 ? -RAIL_RUN : map.h + RAIL_RUN];
  return [from, ...curve(map, s, dir), bufferEnd(map, s)];
}

/** Where the front of a train `len` long stops, backed out of a siding onto the main line clear of the switch. */
function backedTo(map: GameMap, s: Siding, dir: 1 | -1, len: number): Point {
  const [rx, ry] = switchPoint(map, s);
  return [rx, ry - dir * (len + 2)];
}

/** Back out of the siding the way it came in, onto the main line past the switch. */
export function wayOut(map: GameMap, s: Siding, dir: 1 | -1, len: number): Point[] {
  return [bufferEnd(map, s), ...curve(map, s, dir).reverse(), backedTo(map, s, dir, len)];
}

/** On along the main line the way it first came, from backed out, off the map. */
export function wayAway(map: GameMap, s: Siding, dir: 1 | -1, len: number): Point[] {
  const [rx, by] = backedTo(map, s, dir, len);
  return [
    [rx, by + dir * len],
    [rx, dir > 0 ? map.h + RAIL_RUN : -RAIL_RUN],
  ];
}

/** The port trains, each with its visit. */
export function portTrains(w: World): (Train & { port: NonNullable<Train['port']> })[] {
  return w.rail.trains.filter((t) => t.port) as (Train & { port: NonNullable<Train['port']> })[];
}

/** The port train calling at the siding with switch `sw`, if one is. */
export function trainAt(w: World, sw: number): Train | undefined {
  return w.rail.trains.find((t) => t.port?.switch === sw);
}

/**
 * Send a train to a siding: it waits off the map for the main line to
 * clear, comes in and stands `stand` ticks at most. Null when the siding
 * has a train already or is too short for one. `wagons` at most, as many
 * as the siding holds if not said.
 */
export function sendPortTrain(
  w: World,
  s: Siding,
  wagons: CarKind = 'flat',
  stand: number = B.TRAIN_STAND_TICKS,
  dir: 1 | -1 = w.scenery.next() < 0.5 ? 1 : -1,
  most = Infinity,
): Train | null {
  if (trainAt(w, s.switch)) return null;
  // Its back clear of the main line, the front where it stands (see standOffset).
  const room = Math.floor((standOffset(w.map, s) - 0.5) / CAR_LENGTH);
  const n = Math.min(B.TRAIN_MAX_WAGONS, room - 1, most);
  if (n < 1) return null;
  const train: Train = {
    id: w.rail.nextId++,
    cars: ['loco', ...Array<CarKind>(n).fill(wagons)],
    variant: w.scenery.int(0, 3),
    speed: B.PORT_TRAIN_SPEED,
    top: B.PORT_TRAIN_SPEED,
    way: wayIn(w.map, s, dir),
    at: 0,
    stops: true,
    port: { switch: s.switch, state: 'due', dir, stand, leaves: 0 },
  };
  w.rail.trains.push(train);
  return train;
}

/** The siding a port train calls at, while its track is there. */
export function sidingOf(w: World, t: Train): Siding | null {
  if (!t.port) return null;
  // East or west of the line: never both at one switch.
  return sidingAt(w.map, t.port.switch + 1) ?? sidingAt(w.map, t.port.switch - 1);
}

/** A tick of the railway: the port's trains first, then those passing along the main line. */
export function stepTrains(w: World): void {
  const rail = w.rail;
  const column = railColumn(w.map);
  // One train under way at a time: the port's go first when the line is clear.
  const clear = () => !rail.trains.some(moving);
  for (const t of portTrains(w)) {
    const s = sidingOf(w, t);
    const v = t.port;
    switch (v.state) {
      case 'due':
        // Its siding taken up before it came: it never does.
        if (!s) rail.trains.splice(rail.trains.indexOf(t), 1);
        else if (clear()) {
          v.state = 'in';
          // Laid longer or shorter since it was sent: in as far as it stands now.
          t.way = wayIn(w.map, s, v.dir);
          t.at = 0;
        }
        break;
      case 'in':
        if (crossingAhead(w, t)) {
          t.speed = 0;
          break;
        }
        runTrain(t);
        if (arrived(t)) {
          v.state = 'standing';
          v.leaves = w.tick + v.stand;
          t.speed = 0;
        }
        break;
      case 'standing':
        if ((w.tick >= v.leaves || worked(t)) && clear() && s) {
          leave(w, t);
          v.state = 'out';
          t.cars.reverse();
          t.back = true;
          t.way = wayOut(w.map, s, v.dir, trainLength(t));
          t.at = 0;
        }
        break;
      case 'out':
        if (crossingAhead(w, t)) {
          t.speed = 0;
          break;
        }
        runTrain(t);
        if (arrived(t) && s) {
          v.state = 'away';
          t.cars.reverse();
          t.back = false;
          t.way = wayAway(w.map, s, v.dir, trainLength(t));
          t.at = 0;
          t.stops = false;
          t.speed = 0;
        }
        break;
      case 'away':
        runTrain(t);
        if (t.at - trainLength(t) > wayLength(t.way)) rail.trains.splice(rail.trains.indexOf(t), 1);
        break;
    }
  }
  const waiting = portTrains(w).some(
    (t) =>
      t.port.state === 'due' ||
      (t.port.state === 'standing' && (w.tick >= t.port.leaves || worked(t))),
  );
  if (w.tick % 10 === 3) callTrains(w);
  stepRailGantries(w);
  stepThrough(
    rail,
    w.scenery,
    w.tick,
    column,
    w.map.h,
    w.town?.stage ?? 0,
    waiting || !clear(),
    stationRow(w, column),
  );
  for (const t of rail.trains) if (!t.port && t.from === undefined) t.from = whence(w, t);
}

/**
 * Whether a rail line's train has been worked and may go: what it brought
 * all off, and as much on as it takes, with no stacker still at it.
 */
function worked(t: Train): boolean {
  const v = t.port;
  if (!v || v.contractId === undefined) return false;
  if (v.hoppers) return hoppersFull(t);
  const pt = t as Train & { port: NonNullable<Train['port']> };
  if ((v.coming ?? 0) > 0 || (v.taking ?? 0) > 0) return false;
  return (
    aboard(pt, true) === 0 && aboard(pt, false) >= Math.min(v.take ?? 0, wagonCells(pt).length)
  );
}

/** A rail line's train pulls out: the containers it takes inland are paid for, and what it brought and could not leave goes back. */
function leave(w: World, t: Train): void {
  const v = t.port;
  if (!v || v.contractId === undefined) return;
  const pt = t as Train & { port: NonNullable<Train['port']> };
  const line = w.contracts.find((c) => c.id === v.contractId);
  const name = line?.terms.name ?? 'The rail line';
  // Hopper wagons: paid for by the tonne they take, towards the place they go to.
  if (v.hoppers) {
    const tonnes = v.hoppers.reduce((n, h) => n + h, 0);
    const s = sidingOf(w, t);
    if (tonnes > 0 && line?.terms.kind === 'rail') {
      const income = payout(w, tonnes * line.terms.fee);
      book(w, 'bulk', income);
      w.stats.earned += income;
      if (s) moneyAt(w, income, s.tiles[Math.floor(s.tiles.length / 2)]);
      served(w, line.terms.place, 'inland', Math.round(tonnes));
    }
    return;
  }
  const cells = wagonCells(pt);
  const going = cells.filter((c): c is Crate => !!c && !c.out);
  const back = aboard(pt, true);
  const s = sidingOf(w, t);
  if (going.length > 0) {
    const income = payout(
      w,
      going.reduce((n, c) => n + c.fee, 0),
    );
    book(w, 'containers', income);
    w.stats.earned += income;
    if (s) moneyAt(w, income, s.tiles[Math.floor(s.tiles.length / 2)]);
    if (!w.learning.marks.includes('trainDelivery')) w.learning.marks.push('trainDelivery');
    // Towards the next step of the city it goes to.
    if (line?.terms.kind === 'rail') served(w, line.terms.place, 'inland', going.length);
  }
  if (back > 0) {
    message(
      w,
      `${name}'s train left with ${back} of the containers it brought still on board: there was no stacker to unload it, or no room in a container yard for cargo going out beside its siding.`,
      'bad',
    );
  }
  // Empty as it goes on its way.
  v.cells = cells.map(() => null);
}

/**
 * Rail lines send their trains when due, each to a siding with no train in
 * it and a container yard beside it, bringing containers to go out on the
 * feeders and with room for those it takes away.
 */
export function callTrains(w: World): void {
  for (const c of w.contracts) {
    const terms = c.terms;
    if (terms.kind !== 'rail' || w.tick < c.nextBoatTick) continue;
    if (portTrains(w).some((t) => t.port.contractId === c.id && t.port.state !== 'away')) continue;
    // Container trains on loading track that holds them, with yards beside
    // it, the shortest that does; hopper wagons under a loadout.
    const long = terms.bulk ? 0 : trainWagons(terms);
    const s = sidings(w.map)
      .filter(
        (x) =>
          !trainAt(w, x.switch) &&
          sidingCars(x) >= 2 &&
          (terms.bulk
            ? x.tiles.some((t) => w.map.build[t] === Build.Loadout)
            : trackWagons(w.map, x) >= long && yardsBeside(w, x).length > 0),
      )
      .sort((a, b) => trackWagons(w.map, a) - trackWagons(w.map, b))[0];
    // None free: it waits, and tries again soon.
    if (!s) {
      c.nextBoatTick = w.tick + 60;
      continue;
    }
    // From its city's end of the line; longer once it has its freight terminal.
    const place = placeById(w, terms.place);
    const dir = place ? (-place.side as 1 | -1) : undefined;
    if (terms.bulk) {
      const train = sendPortTrain(
        w,
        s,
        'hopper',
        B.TRAIN_STAND_TICKS,
        dir,
        Math.ceil(terms.take / B.HOPPER_WAGON),
      );
      if (!train?.port) continue;
      train.port.contractId = c.id;
      train.port.bulk = terms.bulk;
      train.port.hoppers = train.cars.filter((k) => k === 'hopper').map(() => 0);
      c.nextBoatTick =
        w.tick + Math.round(terms.trainEvery * TICKS_PER_DAY * (0.85 + w.rng.next() * 0.3));
      continue;
    }
    // A city with its freight terminal sends more, on more wagons, where the track holds them.
    const extra = place && place.steps >= 1 ? B.TERMINAL_EXTRA : 0;
    const wagons = Math.min(trackWagons(w.map, s), long + Math.ceil(extra / B.WAGON_BOXES));
    const take = Math.min(terms.take + extra, wagons * B.WAGON_BOXES);
    const train = sendPortTrain(w, s, 'flat', B.TRAIN_STAND_TICKS, dir, wagons);
    if (!train?.port) continue;
    train.port.contractId = c.id;
    const pt = train as Train & { port: NonNullable<Train['port']> };
    const cells = wagonCells(pt);
    const bring = Math.min(terms.bring, cells.length);
    for (let k = 0; k < bring; k++) {
      cells[k] = {
        fee: terms.fee,
        at: w.tick,
        out: true,
        look: boxLookOf(train.id, k),
        ...(terms.place !== undefined ? { place: terms.place } : {}),
      };
    }
    train.port.take = Math.min(take, cells.length);
    c.nextBoatTick =
      w.tick + Math.round(terms.trainEvery * TICKS_PER_DAY * (0.85 + w.rng.next() * 0.3));
  }
}

/** The tiles under each car of a train, by the middle of the car. */
function carTiles(w: World, t: Train): Set<number> {
  const out = new Set<number>();
  const m = w.map;
  for (let k = 0; k < t.cars.length; k++) {
    for (const f of [0.2, 0.5, 0.8]) {
      const p = pointAt(t.way, t.at - (k + f) * CAR_LENGTH);
      const x = Math.floor(p.x);
      const y = Math.floor(p.y);
      if (m.inBounds(x, y)) out.add(m.idx(x, y));
    }
  }
  return out;
}

/** Whether a port train standing in its siding stands across this crossing in the port. */
export function trainOver(w: World, i: number): boolean {
  if (!portCrossing(w.map, i)) return false;
  return portTrains(w).some((t) => t.port.state === 'standing' && carTiles(w, t).has(i));
}

/** How near, in tiles, a port train coming to a crossing in the port holds the road. */
const CROSSING_HOLD = 2.5;

/**
 * Whether no one may go onto this crossing in the port now: a train is on
 * it, or one under way is about to be.
 */
export function trackHeld(w: World, i: number): boolean {
  if (!portCrossing(w.map, i)) return false;
  const cx = w.map.xOf(i) + 0.5;
  const cy = w.map.yOf(i) + 0.5;
  for (const t of portTrains(w)) {
    if (t.port.state === 'due' || t.port.state === 'away') continue;
    if (carTiles(w, t).has(i)) return true;
    if (t.port.state === 'standing') continue;
    const s = along(t.way, cx, cy);
    if (s !== null && s >= t.at && s - t.at <= CROSSING_HOLD) return true;
  }
  return false;
}

/** Whether someone is still on a crossing in the port just ahead of a train, which waits for them. */
function crossingAhead(w: World, t: Train): boolean {
  const s = sidingOf(w, t);
  if (!s) return false;
  const m = w.map;
  for (const i of s.tiles) {
    if (!portCrossing(m, i)) continue;
    const at = along(t.way, m.xOf(i) + 0.5, m.yOf(i) + 0.5);
    if (at === null || at < t.at - 0.5 || at - t.at > 1.5) continue;
    if (w.people.some((p) => w.tileOf(p) === i) || w.trucks.some((q) => w.tileOf(q) === i)) {
      return true;
    }
  }
  return false;
}

/** The row of the town's railway station, standing beside the main line, if it has one. */
export function stationRow(w: World, column: number): number | undefined {
  const m = w.map;
  if (column < 0) return undefined;
  for (let y = 0; y < m.h; y++) {
    for (const dx of [1, -1]) {
      if (m.inBounds(column + dx, y) && m.build[m.idx(column + dx, y)] === Build.Station) return y;
    }
  }
  return undefined;
}

/**
 * Why a siding's trains cannot be worked, or nothing: too short, no
 * loading track or too little, no yard beside it, no one to work it.
 */
export function sidingTrouble(w: World, s: Siding): string | undefined {
  if (sidingCars(s) < 2) return 'Too short for a train: lay the siding at least three tiles long';
  // A siding with a loadout is for hopper wagons, and needs no yard.
  if (s.tiles.some((t) => w.map.build[t] === Build.Loadout)) return undefined;
  if (loadingTrack(w.map, s).length === 0) {
    return 'No loading track on it: container trains stand on loading track to be worked. Lay some along it (Roads, Railway)';
  }
  const holds = trackWagons(w.map, s);
  if (holds < 1) {
    return 'Its loading track holds no wagon yet: lay it longer, with plain track past it for the locomotive';
  }
  // The rail lines whose trains are longer than any loading track holds.
  const most = Math.max(...sidings(w.map).map((x) => trackWagons(w.map, x)));
  const short = w.contracts.find(
    (c) => c.terms.kind === 'rail' && !c.terms.bulk && trainWagons(c.terms) > most,
  );
  if (short && short.terms.kind === 'rail' && holds === most) {
    const n = trainWagons(short.terms);
    return `${short.terms.name}'s trains are ${n} wagons long, and its loading track holds ${holds}: lay it longer, or the trains wait`;
  }
  const yards = yardsBeside(w, s);
  if (yards.length === 0) {
    return `No container yard beside its loading track for its trains to be worked from: mark one out up to ${B.SIDING_REACH} rows off it`;
  }
  if (!yards.some((y) => !y.outgoing) || !yards.some((y) => y.outgoing)) {
    return yards.some((y) => y.outgoing)
      ? 'No yard for containers coming in beside its loading track: trains take nothing away inland'
      : 'No yard for containers going out beside its loading track: what the trains bring stays on board';
  }
  // A rail gantry over the track works it; else reach stackers do.
  if (gantriesOn(w, s).length === 0 && !w.people.some((p) => p.kind === 'stacker')) {
    return 'Nothing to unload and load the wagons: put a rail gantry over the loading track, or buy a reach stacker at a depot';
  }
  return undefined;
}

/**
 * Where along the line a train passing through comes from: a place past
 * the end it comes in at, one that would send what it carries.
 */
function whence(w: World, t: Train): string {
  const side = t.way[0][1] < 0 ? -1 : 1;
  const wagons = new Set(t.cars);
  const kinds: PlaceKind[] = wagons.has('coach')
    ? ['city']
    : wagons.has('hopper')
      ? ['colliery', 'mine', 'farms']
      : wagons.has('tank')
        ? ['power', 'steelworks']
        : ['city', 'steelworks'];
  const near = w.region.places.filter((p) => p.side === side);
  const p = near.find((q) => kinds.includes(q.kind)) ?? near[0];
  return p ? placeName(p) : '';
}
