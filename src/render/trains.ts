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
 * The layouts of the cars that come in more than one: a train's locomotive
 * and coaches by the train, each wagon by itself; picked by the train's id
 * unless one is asked for (the dev lab).
 */
export const CAR_LAYOUTS = {
  loco: ['hood', 'cowl', 'shunter'],
  coach: ['single', 'double'],
  box: ['plain', 'ribbed', 'reefer'],
  tank: ['plain', 'walkway'],
} as const;

/** Which layout `kind` has, the `n`th car of train `seed`, or `asked`. */
function layoutOf(kind: CarKind, seed: number, n: number, asked?: string): string {
  const from: readonly string[] | undefined = CAR_LAYOUTS[kind as keyof typeof CAR_LAYOUTS];
  if (!from) return '';
  if (asked && from.includes(asked)) return asked;
  const per = kind === 'loco' || kind === 'coach' ? 0 : n;
  const h = Math.imul(seed * 31 + per * 7 + kind.length, 2654435761) >>> 0;
  return from[(h >>> 8) % from.length];
}

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
  seed = v,
  asked?: string,
): Object3D {
  const g = new Group();
  const layout = layoutOf(kind, seed, k, asked);
  const y = 0.07;
  for (const z of [-LEN / 2 + 0.2, LEN / 2 - 0.2]) g.add(box(0.34, 0.07, 0.3, BOGIE, 0, 0, z));
  g.add(box(0.44, 0.04, LEN, BOGIE, 0, y, 0));
  const top = y + 0.04;
  const live = LIVERIES[v % LIVERIES.length];
  switch (kind) {
    case 'loco': {
      if (layout === 'cowl') {
        // A cowl unit: the body the full width and length, a low nose
        // ahead of the cab's windscreen, fans along the roof.
        g.add(box(0.42, 0.42, LEN - 0.14, live.body, 0, top, -0.07));
        g.add(box(0.42, 0.22, 0.14, live.body, 0, top, LEN / 2 - 0.07));
        g.add(box(0.36, 0.12, 0.012, C.window, 0, top + 0.26, LEN / 2 - 0.135));
        for (const s of [-1, 1]) {
          g.add(box(0.012, 0.08, 0.12, C.window, s * 0.211, top + 0.27, LEN / 2 - 0.24));
          g.add(box(0.012, 0.05, LEN - 0.02, live.trim, s * 0.211, top + 0.1, 0));
        }
        for (const z of [-0.36, -0.12]) g.add(cyl(0.07, 0.02, BOGIE, 0, top + 0.42, z, 10));
        g.add(box(0.08, 0.05, 0.02, 0xfff2b0, 0, top + 0.14, LEN / 2 + 0.002));
        g.add(box(0.44, 0.06, 0.03, live.trim, 0, top - 0.02, LEN / 2));
        break;
      }
      if (layout === 'shunter') {
        // A shunter: a long low hood with handrails, the cab at the back,
        // its buffer beams striped against being walked into.
        g.add(box(0.3, 0.26, LEN - 0.42, live.body, 0, top, 0.19));
        g.add(cyl(0.03, 0.08, BOGIE, 0, top + 0.26, 0.3, 6));
        g.add(box(0.42, 0.46, 0.36, live.body, 0, top, -LEN / 2 + 0.2));
        for (const s of [-1, 1]) {
          g.add(box(0.36, 0.1, 0.012, C.window, 0, top + 0.3, -LEN / 2 + 0.2 + s * 0.181));
          g.add(box(0.012, 0.1, 0.2, C.window, s * 0.211, top + 0.3, -LEN / 2 + 0.2));
          g.add(box(0.012, 0.012, LEN - 0.46, live.trim, s * 0.19, top + 0.22, 0.19));
        }
        g.add(box(0.44, 0.03, 0.4, live.trim, 0, top + 0.46, -LEN / 2 + 0.2));
        for (const z of [LEN / 2, -LEN / 2])
          for (let n = 0; n < 5; n++)
            g.add(
              box(0.088, 0.06, 0.03, n % 2 ? BOGIE : live.trim, -0.176 + n * 0.088, top - 0.02, z),
            );
        g.add(box(0.08, 0.05, 0.02, 0xfff2b0, 0, top + 0.12, LEN / 2 - 0.02));
        break;
      }
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
      if (layout === 'double') {
        // A double-decker, two rows of windows under a rounded roof.
        g.add(box(0.42, 0.52, LEN, paint, 0, top, 0));
        for (const row of [0.12, 0.33]) {
          g.add(box(0.425, 0.1, LEN - 0.12, 0xe8e0c8, 0, top + row - 0.015, 0));
          for (let w = 0; w < 6; w++)
            g.add(box(0.43, 0.07, 0.12, C.window, 0, top + row, -LEN / 2 + 0.14 + w * 0.18));
        }
        g.add(box(0.36, 0.04, LEN - 0.02, 0x8d939b, 0, top + 0.52, 0));
        break;
      }
      g.add(box(0.42, 0.36, LEN, paint, 0, top, 0));
      g.add(box(0.425, 0.1, LEN - 0.12, 0xe8e0c8, 0, top + 0.17, 0));
      for (let w = 0; w < 5; w++) {
        g.add(box(0.43, 0.07, 0.13, C.window, 0, top + 0.185, -LEN / 2 + 0.16 + w * 0.22));
      }
      g.add(box(0.36, 0.05, LEN - 0.02, 0x8d939b, 0, top + 0.36, 0));
      break;
    }
    case 'box': {
      if (layout === 'reefer') {
        // A refrigerated van: white, a stripe, its cooling unit on the end.
        g.add(box(0.42, 0.38, LEN, 0xe8ecef, 0, top, 0));
        g.add(box(0.425, 0.04, LEN, 0x2f5fb3, 0, top + 0.06, 0));
        g.add(box(0.43, 0.28, 0.24, 0xc9ced3, 0, top + 0.05, 0));
        g.add(box(0.3, 0.24, 0.04, 0x8d939b, 0, top + 0.06, LEN / 2));
        g.add(box(0.44, 0.03, LEN, 0x8d939b, 0, top + 0.38, 0));
        break;
      }
      const paint = [0x8c3b30, 0x6b4f3f, 0x4f6d84][(v + k) % 3];
      g.add(box(0.42, 0.38, LEN, paint, 0, top, 0));
      if (layout === 'ribbed')
        for (let n = 0; n < 9; n++)
          g.add(box(0.43, 0.38, 0.018, 0x3a3d42, 0, top, -LEN / 2 + 0.06 + n * ((LEN - 0.12) / 8)));
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
      if (layout === 'walkway') {
        // Running boards and a handrail along both sides, bands round the
        // tank, and a ladder up to the dome.
        for (const s of [-1, 1]) {
          g.add(box(0.05, 0.015, LEN - 0.1, 0x8d939b, s * 0.215, top + 0.1, 0));
          g.add(box(0.01, 0.01, LEN - 0.2, 0xf2c230, s * 0.205, top + 0.32, 0));
          for (const z of [-0.45, 0, 0.45])
            g.add(box(0.008, 0.21, 0.008, 0xf2c230, s * 0.205, top + 0.11, z));
          g.add(box(0.012, 0.3, 0.06, 0xf2c230, s * 0.2, top + 0.06, 0.12));
        }
        for (const z of [-0.36, 0.36]) {
          const band = cyl(0.196, 0.03, BOGIE, 0, 0, 0, 10);
          band.rotation.x = Math.PI / 2;
          band.position.set(0, top + 0.2, z);
          g.add(band);
        }
      }
      break;
    }
    case 'hopper': {
      // Open topped: the sides run its length, the ends and the floor sit
      // between them, and the load just inside those, so no two faces lie
      // on top of each other and flicker; the chutes hang under the floor.
      const paint = [0x5a5f66, 0x7a5230][v % 2];
      const long = LEN - 0.06;
      const wall = 0.03;
      const inner = 0.42 - 2 * wall;
      g.add(box(inner, 0.04, long - 2 * wall, 0x3a3d42, 0, top, 0));
      for (const s of [-1, 1]) {
        g.add(box(wall, 0.3, long, paint, s * (0.21 - wall / 2), top, 0));
        g.add(box(inner, 0.3, wall, paint, 0, top, s * (long / 2 - wall / 2)));
        g.add(box(0.2, 0.05, 0.2, paint, 0, top - 0.055, s * long * 0.22));
      }
      // What it is loaded with, from the floor up to heaped over its sides; see Trains.push.
      const fill = box(
        inner - 0.02,
        HOPPER_HEAP,
        long - 2 * wall - 0.02,
        0x2b2b30,
        0,
        top + 0.04,
        0,
      );
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
        train.id,
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
