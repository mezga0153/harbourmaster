// The port's own trains: what opens the sidings for them, and their visits.
// A port train waits off the map till the main line is clear, runs along it
// and turns off by the switch into its siding, where it stands to be worked;
// then it backs out onto the main line, clear of the switch, and goes on
// the way it came.

import type { World } from '../world';
import * as B from '../balance';
import { LANDMARKS } from '../town';
import { Build } from '../types';
import {
  CAR_LENGTH,
  RAIL_RUN,
  arrived,
  moving,
  railColumn,
  runTrain,
  stepThrough,
  trainLength,
  wayLength,
  type CarKind,
  type Point,
  type Train,
} from '../railway';
import { sidingAt, type Siding } from '../rules/rails';
import type { GameMap } from '../map';

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

/** Where a train's front stops in a siding: just short of the buffer stop. */
function bufferEnd(map: GameMap, s: Siding): Point {
  const last = s.tiles.at(-1)!;
  return [map.xOf(last) + 0.5 + s.side * 0.35, map.yOf(last) + 0.5];
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
 * clear, comes in and stands `stand` ticks. Null when the siding has a
 * train already or is too short for one.
 */
export function sendPortTrain(
  w: World,
  s: Siding,
  wagons: CarKind = 'flat',
  stand: number = B.TRAIN_STAND_TICKS,
  dir: 1 | -1 = w.scenery.next() < 0.5 ? 1 : -1,
): Train | null {
  if (trainAt(w, s.switch)) return null;
  const n = Math.min(B.TRAIN_MAX_WAGONS, sidingCars(s) - 1);
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
        runTrain(t);
        if (arrived(t)) {
          v.state = 'standing';
          v.leaves = w.tick + v.stand;
          t.speed = 0;
        }
        break;
      case 'standing':
        if (w.tick >= v.leaves && clear() && s) {
          v.state = 'out';
          t.cars.reverse();
          t.back = true;
          t.way = wayOut(w.map, s, v.dir, trainLength(t));
          t.at = 0;
        }
        break;
      case 'out':
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
    (t) => t.port.state === 'due' || (t.port.state === 'standing' && w.tick >= t.port.leaves),
  );
  stepThrough(rail, w.scenery, w.tick, column, w.map.h, w.town?.stage ?? 0, waiting || !clear());
}
