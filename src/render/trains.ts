import { Group, Mesh, type Object3D } from 'three';
import type { GameMap } from '../sim/map';
import { CAR_LENGTH, railColumn, type CarKind, type Train } from '../sim/railway';
import { TICKS_PER_SECOND } from '../sim/types';
import { container } from './models';
import { C } from './palette';
import { box, cyl } from './parts';
import { landTop } from './terrain';

// The train passing along the main line, carried on between sim snapshots
// at its own steady speed.

const LIVERIES = [
  { body: 0xc8372d, trim: 0xf2c230 },
  { body: 0x2f5fb3, trim: 0xf4f4f0 },
  { body: 0x2e7d4f, trim: 0xf2c230 },
  { body: 0x3b4048, trim: 0xf5872a },
];
const COACHES = [0x2e6b4f, 0x7a2a2a, 0x2f4f86, 0xb8483a];
const BOGIE = 0x2a2d31;
/** Rail top: ground, ballast, sleepers and rail. */
const RAIL_TOP = 0.105;
const LEN = CAR_LENGTH - 0.12;

/** A wagon or locomotive, along +z with its middle at the origin. */
function car(kind: CarKind, v: number, k: number): Object3D {
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
      g.add(box(0.42, 0.3, LEN - 0.06, [0x5a5f66, 0x7a5230][v % 2], 0, top, 0));
      g.add(box(0.36, 0.06, LEN - 0.14, 0x26282b, 0, top + 0.28, 0));
      break;
    }
    case 'flat': {
      const c = container(v * 31 + k * 7, 0, top, 0);
      c.rotation.y = Math.PI / 2;
      g.add(c);
      break;
    }
  }
  return g;
}

export class Trains {
  readonly group = new Group();
  private x: number;
  private ground: number;
  private view: Train | null = null;
  private model: Group | null = null;
  private key = '';
  /** When the last snapshot came in, and how many ticks a millisecond the sim was running. */
  private at = 0;
  private rate = 0;
  private now: Train | null = null;

  constructor(map: GameMap) {
    this.x = railColumn(map);
    this.ground = this.x >= 0 ? landTop(map.terrain[map.idx(this.x, 0)]) : 0;
  }

  push(train: Train | null, speed: number, now: number): void {
    this.view = train;
    this.at = now;
    this.rate = (speed * TICKS_PER_SECOND) / 1000;
    const key = train ? `${train.dir}:${train.variant}:${train.cars.join()}` : '';
    if (key !== this.key) this.rebuild(train, key);
  }

  /** Move the train on to where it is now; returns it, for the crossings. */
  update(now: number): Train | null {
    const t = this.view;
    if (!t || !this.model) return null;
    // Carry on at the train's speed, at most a few snapshots past the last.
    const ticks = Math.min(now - this.at, 400) * this.rate;
    const head = t.head + t.dir * t.speed * ticks;
    this.model.position.z = head;
    this.now = { ...t, head };
    return this.now;
  }

  private rebuild(train: Train | null, key: string): void {
    this.key = key;
    if (this.model) this.group.remove(this.model);
    this.model = null;
    if (!train || this.x < 0) return;
    const m = new Group();
    m.position.set(this.x + 0.5, this.ground + RAIL_TOP, train.head);
    train.cars.forEach((kind, k) => {
      const c = car(kind, train.variant, k);
      // Cars trail behind the head; the locomotive faces the way it is going.
      c.position.z = -train.dir * (k + 0.5) * CAR_LENGTH;
      if (train.dir < 0) c.rotation.y = Math.PI;
      m.add(c);
    });
    m.traverse((o) => {
      if (o instanceof Mesh) o.castShadow = true;
    });
    this.group.add(m);
    this.model = m;
  }
}
