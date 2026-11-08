import { Group, Mesh, Vector3, type Object3D } from 'three';
import type { GameMap } from '../sim/map';
import * as B from '../sim/balance';
import { CAR_LENGTH, pointAt, wayLength, type CarKind, type Train } from '../sim/railway';
import { TICKS_PER_SECOND } from '../sim/types';
import { KeyedObjects } from './keyed';
import { container, paintContainer } from './models';
import { C } from './palette';
import { box, cyl } from './parts';
import { landTop } from './terrain';

// The trains on the main line and in the port's sidings, carried on between
// sim snapshots at their own speed, each car following the curves.

const LIVERIES = [
  { body: 0xc8372d, trim: 0xf2c230 },
  { body: 0x2f5fb3, trim: 0xf4f4f0 },
  { body: 0x2e7d4f, trim: 0xf2c230 },
  { body: 0x3b4048, trim: 0xf5872a },
];
const COACHES = [0x2e6b4f, 0x7a2a2a, 0x2f4f86, 0xb8483a];
const BOGIE = 0x2a2d31;
/** How high a full hopper wagon's load is, from its floor: heaped a little over its sides. */
const HOPPER_HEAP = 0.32;
/** Where a hopper wagon's floor is, above the rails. */
const HOPPER_FLOOR = 0.15;
/** Rail top: ground, ballast, sleepers and rail. */
const RAIL_TOP = 0.105;
const LEN = CAR_LENGTH - 0.12;

/**
 * A wagon or locomotive, along +z with its middle at the origin. A port
 * train's flat wagon carries the containers `boxes` gives the looks of,
 * front (+z) first, or none; one passing through, a container of its own.
 */
export function trainCar(
  kind: CarKind,
  v: number,
  k: number,
  boxes?: readonly (number | null)[],
  slots?: Object3D[],
): Object3D {
  const g = new Group();
  const y = 0.07;
  for (const z of [-LEN / 2 + 0.2, LEN / 2 - 0.2]) g.add(box(0.34, 0.07, 0.3, BOGIE, 0, 0, z));
  g.add(box(0.44, 0.04, LEN, BOGIE, 0, y, 0));
  const top = y + 0.04;
  const live = LIVERIES[v % LIVERIES.length];
  switch (kind) {
    case 'loco': {
      // Hood unit: a cab at the front and the engine housing behind.
      g.add(box(0.42, 0.42, 0.34, live.body, 0, top, LEN / 2 - 0.2));
      g.add(box(0.43, 0.1, 0.2, C.window, 0, top + 0.26, LEN / 2 - 0.16));
      g.add(box(0.44, 0.03, 0.38, live.trim, 0, top + 0.42, LEN / 2 - 0.2));
      g.add(box(0.34, 0.32, LEN - 0.42, live.body, 0, top, -0.2));
      g.add(box(0.345, 0.05, LEN - 0.42, live.trim, 0, top + 0.06, -0.2));
      g.add(cyl(0.04, 0.08, BOGIE, 0, top + 0.32, -0.3, 6));
      // Headlamp and a striped buffer beam.
      g.add(box(0.08, 0.05, 0.02, 0xfff2b0, 0, top + 0.12, LEN / 2 - 0.02));
      g.add(box(0.44, 0.06, 0.03, live.trim, 0, top - 0.02, LEN / 2));
      break;
    }
    case 'coach': {
      const paint = COACHES[v % COACHES.length];
      g.add(box(0.42, 0.36, LEN, paint, 0, top, 0));
      g.add(box(0.425, 0.1, LEN - 0.12, 0xe8e0c8, 0, top + 0.17, 0));
      for (let w = 0; w < 5; w++) {
        g.add(box(0.43, 0.07, 0.13, C.window, 0, top + 0.185, -LEN / 2 + 0.16 + w * 0.22));
      }
      g.add(box(0.36, 0.05, LEN - 0.02, 0x8d939b, 0, top + 0.36, 0));
      break;
    }
    case 'box': {
      g.add(box(0.42, 0.38, LEN, [0x8c3b30, 0x6b4f3f, 0x4f6d84][(v + k) % 3], 0, top, 0));
      g.add(box(0.43, 0.3, 0.3, 0x5a3d2b, 0, top + 0.03, 0));
      g.add(box(0.44, 0.03, LEN, 0x8d939b, 0, top + 0.38, 0));
      break;
    }
    case 'tank': {
      const tank = cyl(0.19, LEN - 0.12, [0x2a2d31, 0xe8ecef, 0x3f7d4a][v % 3], 0, 0, 0, 10);
      tank.rotation.x = Math.PI / 2;
      tank.position.set(0, top + 0.2, 0);
      g.add(tank);
      g.add(box(0.14, 0.06, 0.14, BOGIE, 0, top + 0.37, 0));
      break;
    }
    case 'hopper': {
      // Open topped: a floor, two sides and two ends, and the chutes under it.
      const paint = [0x5a5f66, 0x7a5230][v % 2];
      const long = LEN - 0.06;
      g.add(box(0.42, 0.04, long, 0x3a3d42, 0, top, 0));
      for (const s of [-1, 1]) {
        g.add(box(0.03, 0.3, long, paint, s * 0.195, top, 0));
        g.add(box(0.42, 0.3, 0.03, paint, 0, top, s * (long / 2 - 0.015)));
        g.add(box(0.2, 0.06, 0.2, paint, 0, top - 0.06, s * long * 0.22));
      }
      // What it is loaded with, from the floor up to heaped over its sides; see Trains.push.
      const fill = box(0.36, HOPPER_HEAP, long - 0.06, 0x2b2b30, 0, top + 0.04, 0);
      fill.visible = !boxes;
      slots?.push(fill);
      g.add(fill);
      break;
    }
    case 'flat': {
      g.add(box(0.44, 0.03, LEN, 0x6b4f3f, 0, top, 0));
      const looks = boxes ?? [v * 31 + k * 7];
      looks.forEach((look, n) => {
        // A port train's places are there empty too, for the cranes to set one in.
        const z = boxes ? (n === 0 ? 0.3 : -0.3) : 0;
        const c = container(look ?? 0, 0, top + 0.03, z);
        c.rotation.y = Math.PI / 2;
        c.visible = look !== null;
        g.add(c);
        slots?.push(c);
      });
      break;
    }
  }
  return g;
}

/** A train's model and the view of it it was built from. */
interface Shown {
  view: Train;
  model: Group;
  cars: Object3D[];
  /** A port train's container places, by its cells (see PortVisit.cells). */
  slots: Object3D[];
}

export class Trains {
  readonly group = new Group();
  private map: GameMap;
  /** Each train under its key: a new make-up of cars, way or direction is a new model. */
  private models = new KeyedObjects<string, Shown>((m) => this.group.remove(m.model));
  private shown: Shown[] = [];
  /** When the last snapshot came in, and how many ticks a millisecond the sim was running. */
  private at = 0;
  private rate = 0;

  constructor(map: GameMap) {
    this.map = map;
  }

  push(trains: readonly Train[], speed: number, now: number): void {
    this.at = now;
    this.rate = (speed * TICKS_PER_SECOND) / 1000;
    const keyOf = (t: Train) =>
      `${t.id}:${t.back ? 'b' : 'f'}:${t.cars.join()}:${t.way.map((p) => p.join(',')).join(';')}:${t.port?.cells ? 'cells' : ''}${t.port?.hoppers ? 'hoppers' : ''}`;
    const byKey = new Map(trains.map((t) => [keyOf(t), t]));
    this.models.sync([...byKey.keys()], (k) => this.build(byKey.get(k)!));
    this.shown = [...byKey].map(([k, t]) => {
      const m = this.models.get(k)!;
      m.view = t;
      // A port train's hopper wagons fill as the loadout pours into them.
      t.port?.hoppers?.forEach((h, n) => {
        const fill = m.slots[n];
        if (!fill) return;
        const f = Math.min(1, h / B.HOPPER_WAGON);
        fill.visible = f > 0.02;
        // The box's height is its scale: from the floor, up to heaped over the sides.
        fill.scale.y = 0.02 + (HOPPER_HEAP - 0.02) * f;
        fill.position.y = HOPPER_FLOOR + fill.scale.y / 2;
      });
      // Containers on and off as the game has them.
      t.port?.cells?.forEach((c, n) => {
        const slot = m.slots[n];
        if (!slot) return;
        slot.visible = !!c;
        if (c) paintContainer(slot, c.look ?? 0);
      });
      return m;
    });
  }

  /** Move the trains on to where they are now; returns them, for the crossings. */
  update(now: number): Train[] {
    // Carry on at each train's speed, at most a few snapshots past the last.
    const ticks = Math.min(now - this.at, 400) * this.rate;
    return this.shown.map((m) => {
      const t = m.view;
      let at = t.at + t.speed * ticks;
      if (t.stops) at = Math.min(at, wayLength(t.way));
      if (t.stopAt !== undefined) at = Math.min(at, t.stopAt);
      const now = { ...t, at };
      this.place(m, now);
      return now;
    });
  }

  /** Where a port train's container place for cell `k` is in the world, or null. */
  slotPosition(id: number, k: number, out: Vector3): Vector3 | null {
    const slot = this.shown.find((m) => m.view.id === id)?.slots[k];
    return slot ? slot.getWorldPosition(out) : null;
  }

  /** Whether a port train shows a container in cell `k`. */
  slotShown(id: number, k: number): boolean {
    return !!this.shown.find((m) => m.view.id === id)?.slots[k]?.visible;
  }

  /** Each car between its bogies' points along the way, so they follow the curves. */
  private place(m: Shown, t: Train): void {
    const map = this.map;
    m.cars.forEach((c, k) => {
      const front = pointAt(t.way, t.at - k * CAR_LENGTH - 0.25);
      const rear = pointAt(t.way, t.at - (k + 1) * CAR_LENGTH + 0.25);
      const x = (front.x + rear.x) / 2;
      const y = (front.y + rear.y) / 2;
      const tx = Math.min(map.w - 1, Math.max(0, Math.floor(x)));
      const ty = Math.min(map.h - 1, Math.max(0, Math.floor(y)));
      c.position.set(x, landTop(map.terrain[map.idx(tx, ty)]) + RAIL_TOP, y);
      // Facing the way it runs; a locomotive backing faces back.
      const flip = t.back && t.cars[k] === 'loco' ? Math.PI : 0;
      c.rotation.y = Math.atan2(front.x - rear.x, front.y - rear.y) + flip;
    });
  }

  private build(train: Train): Shown {
    const model = new Group();
    const n = train.cars.length - 1;
    const cells = train.port?.cells;
    const slots: Object3D[] = [];
    const cars = train.cars.map((kind, k) => {
      // Its wagon counted from the locomotive, which is last when it backs.
      const wagon = train.back ? n - k : k;
      const at = (wagon - 1) * B.WAGON_BOXES;
      const looks = cells
        ? Array.from({ length: B.WAGON_BOXES }, (_, s) => {
            // The cell nearer the locomotive faces it: to the back when backing.
            const cell = cells[at + (train.back ? B.WAGON_BOXES - 1 - s : s)];
            return cell ? (cell.look ?? 0) : null;
          })
        : undefined;
      const mine: Object3D[] = [];
      const hoppers = train.port?.hoppers;
      const c = trainCar(
        kind,
        train.variant,
        k,
        kind === 'flat' ? looks : kind === 'hopper' && hoppers ? [] : undefined,
        mine,
      );
      // A port train's hopper wagons, by wagon from the locomotive.
      if (hoppers && kind === 'hopper') slots[wagon - 1] = mine[0];
      // By cell: the one nearer the locomotive first, at the back when it backs.
      if (cells && kind === 'flat') {
        mine.forEach((o, s) => (slots[at + (train.back ? B.WAGON_BOXES - 1 - s : s)] = o));
      }
      model.add(c);
      return c;
    });
    model.traverse((o) => {
      if (o instanceof Mesh) o.castShadow = true;
    });
    this.group.add(model);
    const m = { view: train, model, cars, slots };
    this.place(m, train);
    return m;
  }
}
