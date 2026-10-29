import {
  BoxGeometry,
  ConeGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  type Object3D,
  Vector3,
} from 'three';
import type { BayView, CraneView, PileView, TileChange } from '../protocol';
import type { GameMap } from '../sim/map';
import { EXTENSION, FACING, footprint, machinesOnly, ON_QUAY, parkingLots } from '../sim/rules';
import { hash01 } from '../sim/noise';
import { crossingClosed, railColumn, type Train } from '../sim/railway';
import { HIGHWAY_X, TOWN } from '../sim/town';
import {
  Build,
  isDock,
  isPublicRoad,
  isTownBuilding,
  storesBoxes,
  storesOutgoing,
  TICKS_PER_SECOND,
} from '../sim/types';
import { CRANE_LIFT_SET, CRANE_LIFT_TAKEN, GANTRY_TICKS, YARD_GANTRY_TICKS } from '../sim/balance';
import { BOX_HEIGHT } from './assets';
import { container, crate, paintContainer } from './models';
import { C } from './palette';
import { box, cyl, mat } from './parts';
import { bake, pavements, townBuilding } from './town';

const LIGHT = 0xfff2b0;
const BALLAST = 0x9b9284;
const STEEL = 0x8d939b;
const LAMP_RED = 0xff3b2f;
/** A thin bar from `a` to `b`, for stays and bracing. */
function strut(
  a: [number, number, number],
  b: [number, number, number],
  thick: number,
  color: number,
): Object3D {
  const from = new Vector3(...a);
  const to = new Vector3(...b);
  const bar = box(thick, thick, from.distanceTo(to), color);
  bar.position.copy(from).add(to).multiplyScalar(0.5);
  bar.lookAt(to);
  return bar;
}

/** How many tiles a yard gantry's rails run either way along its yard, at most. */
const GANTRY_RUN = 12;
const unitBox = new BoxGeometry(1, 1, 1);
import { DECK_Y, MARGIN, QUAY_Y, SEABED, landTop } from './terrain';

/** The pointed top of a green buoy. */
const coneGeo = new ConeGeometry(0.08, 0.14, 8);
coneGeo.translate(0, 0.07, 0);
const roofGeo = new ConeGeometry(0.56, 0.26, 4);
roofGeo.rotateY(Math.PI / 4);
roofGeo.scale(1.05, 1, 0.8);
roofGeo.translate(0, 0.13, 0);

interface BayStack {
  crates: Object3D[];
  boxes: Object3D[];
}

interface GateParts {
  /** The barrier arm, pivoting up about its post. */
  boom: Object3D;
  open: boolean;
  angle: number;
}

interface CrossingParts {
  /** Barrier arms, each lifting about its post; `sign` is which way is up. */
  arms: { arm: Object3D; sign: number }[];
  /** Red lamps, flashing in turn while the barriers are down. */
  lamps: Object3D[];
  y: number;
  angle: number;
}

interface YardGantryParts {
  /** The gantry's rails, laid out along +z from its tile into the yard and along x. */
  frame: Object3D;
  /** Legs, beams and trolley, running along x on the rails. */
  carriage: Object3D;
  /** Runs along the beam, along +z of the frame: out over the yard, back over the lane. */
  trolley: Object3D;
  /** Hoist rope from the trolley, scaled to its length, and the spreader on its end. */
  rope: Object3D;
  spreader: Object3D;
  /** The container on the spreader, shown while it carries one. */
  load: Object3D;
  /** How far along the beam the far legs stand, and how far down a truck's deck is. */
  far: number;
  laneDrop: number;
  /** Where in the yard the container it is moving is, in the frame; see slotFor. */
  pick: { x: number; z: number; drop: number } | null;
  /** How far along the rails the truck it is working stands. */
  laneAt: number;
  /** The truck it is working, and the container slot on it it lifts from or sets down in. */
  truck?: number;
  slot: number;
  work: 'load' | 'unload' | null;
  look: number;
  /** How far through a lift, 0 to 1. */
  phase: number;
}

interface CraneParts {
  /** Rotates about Y to point the jib at the boat being unloaded. */
  slew: Object3D;
  /** Cable from the jib tip, scaled to its length, and the hook on its end. */
  rope: Object3D;
  hook: Object3D;
  /** Cable length when idle, and how far it plays out while lifting. */
  rest: number;
  reach: number;
  stack: Object3D[];
  angle: number;
  target: number;
  busy: boolean;
  /** A gantry: `slew` is its trolley, running out along the boom and back instead. */
  fixed?: boolean;
  /** A ship-to-shore gantry: its parts, and the lift it is at; see runShipGantry. */
  sts?: ShipGantryParts;
}

interface ShipGantryParts {
  /** Laid out as built: x along the quay edge, the water off +z. */
  frame: Object3D;
  /** Legs, portal, boom and trolley, running along x on the rails. */
  carriage: Object3D;
  /** How far along x the carriage can run either way, on the rails. */
  from: number;
  to: number;
  /** The container on the spreader, shown while it carries one. */
  load: Object3D;
  work: 'load' | 'unload' | null;
  boat: number;
  slot: number;
  look: number;
  /** How far through a lift, 0 to 1, kept in step with the game. */
  phase: number;
  /** Containers on the stack between its legs, and exports, for where the next goes. */
  stacked: number;
}

/** Roads, paths, jetties and truck bays, rebuilt per tile when they change. */
export class Structures {
  readonly group = new Group();
  private tiles = new Map<number, Object3D>();
  private stacks = new Map<number, BayStack>();
  /** Which container is in which slot, by yard (its first tile) or crane; see settle. */
  private slots = new Map<number, number[]>();
  private cranes = new Map<number, CraneParts>();
  private gates = new Map<number, GateParts>();
  /** Buoys, bobbing on the swell. */
  private buoys = new Map<number, Object3D>();
  private crossings = new Map<number, CrossingParts>();
  /** Yard gantries, by tile, for their trolley to run as they load trucks. */
  private yardGantries = new Map<number, YardGantryParts>();
  /** Where a truck's container slot is in the world; set by the renderer. */
  truckSlot?: (id: number, k: number, out: Vector3) => Vector3 | null;
  private slotAt = new Vector3();
  /** Game speed, so a gantry's lift takes as long as it does in the game. */
  private speed = 1;
  /** Cargo landed on the quay, by tile. */
  private piles = new Map<number, { group: Group; crates: Object3D[]; pallets: boolean }>();
  private train: Train | null = null;

  /** `bare`: just the tiles, without the highway, railway and boundary round the map. */
  constructor(
    private map: GameMap,
    bare = false,
  ) {
    for (let i = 0; i < map.build.length; i++) this.rebuild(i);
    if (!bare) this.group.add(this.highway(), this.mainLine(), this.boundary());
  }

  /** What is drawn on tile `i`, if anything. */
  tileObject(i: number): Object3D | undefined {
    return this.tiles.get(i);
  }

  apply(changes: TileChange[]): void {
    const touched = new Set<number>();
    for (const c of changes) {
      // Diagonals too: a quay's safety line looks one tile round the corner.
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const n = this.offset(c.i, dx, dy);
          if (n >= 0) touched.add(n);
        }
      }
    }
    // A parking lot is drawn whole: inside or out, and which way it runs,
    // depend on all of it and the roads along it.
    this.lots = null;
    for (const lot of parkingLots(this.map)) {
      if (lot.tiles.some((t) => touched.has(t))) for (const t of lot.tiles) touched.add(t);
    }
    // Containers lie along the long side of their yard, so the whole yard is
    // laid again when it changes shape.
    for (const i of [...touched]) {
      if (this.map.store[i]) for (const t of this.storeArea(i)) touched.add(t);
    }
    // A yard gantry's rails run the length of its yard, so it is laid again
    // whatever changes.
    if (changes.length > 0) for (const i of this.yardGantries.keys()) touched.add(i);
    for (const i of touched) this.rebuild(i);
  }

  /** Each parking tile's lot: inside the port or out, and whether its spaces run across x. */
  private lots: Map<number, { inside: boolean; acrossX: boolean; wide: boolean }> | null = null;

  private lotAt(i: number): { inside: boolean; acrossX: boolean; wide: boolean } {
    if (!this.lots) {
      const m = this.map;
      this.lots = new Map();
      for (const lot of parkingLots(m)) {
        const xs = lot.tiles.map((t) => m.xOf(t));
        const ys = lot.tiles.map((t) => m.yOf(t));
        const w = Math.max(...xs) - Math.min(...xs) + 1;
        const h = Math.max(...ys) - Math.min(...ys) + 1;
        const space = lot.spaces[0];
        const acrossX = space ? m.xOf(space.ends[0]) !== m.xOf(space.ends[1]) : w <= h;
        // Laid out wrong it has no side yet: port paving if only port roads join it.
        const near = lot.tiles.flatMap((t) => m.neighbors4(t).map((n) => m.build[n]));
        const inside = space
          ? !lot.outside
          : !near.some((b) => isPublicRoad(b)) &&
            near.some((b) => b === Build.PortRoad || b === Build.Quay);
        const wide = space ? space.tiles.length === 2 : Math.min(w, h) === 2;
        for (const t of lot.tiles) this.lots.set(t, { inside, acrossX, wide });
      }
    }
    return this.lots.get(i) ?? { inside: false, acrossX: false, wide: false };
  }

  setCranes(views: CraneView[]): void {
    for (const v of views) {
      const c = this.cranes.get(v.idx);
      if (!c) continue;
      // Exports set down for a container crane wait on its stack too.
      const order = v.looks ? this.settled(-1 - v.idx, v.looks) : undefined;
      c.stack.forEach((o, k) => {
        o.visible = k < v.stack + v.out;
        if (order && k < order.length) paintContainer(o, order[k]);
      });
      c.busy = v.busy;
      if (v.busy) c.target = -v.angle;
      const g = c.sts;
      if (!g) continue;
      g.stacked = v.stack + v.out;
      g.work = v.working ?? null;
      if (v.workBoat !== undefined) g.boat = v.workBoat;
      if (v.workSlot !== undefined) g.slot = v.workSlot;
      if (v.workLook !== undefined) g.look = v.workLook;
      // Kept in step with the game, without jumping for a small difference.
      if (v.workPhase !== undefined) {
        const off = ((v.workPhase - g.phase + 1.5) % 1) - 0.5;
        g.phase = Math.abs(off) > 0.15 ? v.workPhase : (g.phase + off * 0.5 + 1) % 1;
      }
    }
  }

  /** Port gates lift their barrier while a truck is passing through. */
  setGates(trucks: { x: number; y: number }[]): void {
    for (const [i, g] of this.gates) {
      const cx = this.map.xOf(i) + 0.5;
      const cy = this.map.yOf(i) + 0.5;
      g.open = trucks.some((t) => Math.hypot(t.x - cx, t.y - cy) < 1.6);
    }
  }

  /** Where the train is this frame, for the level crossings' barriers. */
  setTrain(train: Train | null): void {
    this.train = train;
  }

  /** Per-frame animation: slew cranes towards their boats, bob the hooks, lift barriers. */
  update(dt: number, time: number): void {
    for (const c of this.crossings.values()) {
      const closed = crossingClosed(this.train, c.y);
      c.angle += ((closed ? 0 : 1.45) - c.angle) * Math.min(1, dt * 3);
      for (const { arm, sign } of c.arms) arm.rotation.x = sign * c.angle;
      const blink = Math.floor(time * 3) % 2;
      c.lamps.forEach((l, k) => (l.visible = closed && k % 2 === blink));
    }
    for (const [i, buoy] of this.buoys) {
      buoy.position.y = Math.sin(time * 1.7 + i * 0.37) * 0.025;
      buoy.rotation.z = Math.sin(time * 1.3 + i) * 0.08;
      buoy.rotation.x = Math.cos(time * 1.1 + i * 0.7) * 0.08;
    }
    for (const g of this.gates.values()) {
      g.angle += ((g.open ? 1.4 : 0) - g.angle) * Math.min(1, dt * 5);
      g.boom.rotation.z = -g.angle;
    }
    for (const g of this.yardGantries.values()) this.runYardGantry(g, dt);
    for (const c of this.cranes.values()) {
      if (c.sts) {
        this.runShipGantry(c, c.sts, dt);
        continue;
      }
      if (c.fixed) {
        // Out over the ship and back in over the bay between the legs.
        const out = c.busy ? 0.5 + 0.5 * Math.sin(time * 1.1) : 1;
        c.slew.position.z += (-0.5 + out * 2.7 - c.slew.position.z) * Math.min(1, dt * 4);
      } else {
        let d = c.target - c.angle;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        c.angle += d * Math.min(1, dt * 3);
        c.slew.rotation.y = c.angle;
      }
      const drop = c.rest + (c.busy ? (0.5 + 0.5 * Math.sin(time * 3)) * c.reach : 0);
      c.rope.scale.y = drop;
      c.rope.position.y = -drop / 2;
      c.hook.position.y = -drop;
    }
  }

  /**
   * A ship-to-shore gantry at work runs along its rails to the bay of the
   * ship it is working, runs its trolley out over the row, lowers the
   * spreader onto the container and lifts it, then runs back over the bay
   * between its legs and sets it down on the stack there; loading, the other
   * way round. Idle, it waits where it is with the spreader up.
   */
  private runShipGantry(c: CraneParts, g: ShipGantryParts, dt: number): void {
    const cycle = GANTRY_TICKS / TICKS_PER_SECOND;
    g.phase = g.work ? (g.phase + (dt * this.speed) / cycle) % 1 : 0;
    const trolley = c.slew;
    let x = g.carriage.position.x;
    let z = -0.3;
    let drop = c.rest;
    let carry = false;
    const ship = g.work ? this.truckSlot?.(g.boat, g.slot, this.slotAt) : null;
    if (g.work && ship) {
      g.frame.updateWorldMatrix(true, false);
      g.frame.worldToLocal(ship);
      const deck = {
        x: ship.x,
        z: ship.z,
        drop: trolley.position.y - (ship.y + BOX_HEIGHT + 0.04),
      };
      // The next free place on the stack, or the export on top of it.
      const k = Math.max(0, Math.min(c.stack.length - 1, g.stacked - (g.work === 'load' ? 1 : 0)));
      const slot = c.stack[k];
      const pile = {
        x: slot.position.x,
        z: slot.position.z,
        drop: trolley.position.y - (slot.position.y + BOX_HEIGHT + 0.04),
      };
      const [from, to] = g.work === 'unload' ? [deck, pile] : [pile, deck];
      const p = g.phase;
      const ease = (t: number) => t * t * (3 - 2 * t);
      const dip = (t: number, depth: number) => c.rest + (depth - c.rest) * Math.sin(t * Math.PI);
      const take = CRANE_LIFT_TAKEN;
      const set = CRANE_LIFT_SET;
      // Over to the container, down and up with it at `take`, across to
      // where it goes, down and up again having let go at `set`.
      const a = take - 0.15;
      const b = take + 0.15;
      const d = set - 0.15;
      if (p < a) {
        const t = ease(p / a);
        x = g.carriage.position.x + (from.x - g.carriage.position.x) * t;
        z = trolley.position.z + (from.z - trolley.position.z) * t;
      } else if (p < b) {
        x = from.x;
        z = from.z;
        drop = dip((p - a) / (b - a), from.drop);
        carry = p >= take;
      } else if (p < d) {
        const t = ease((p - b) / (d - b));
        x = from.x + (to.x - from.x) * t;
        z = from.z + (to.z - from.z) * t;
        carry = true;
      } else {
        x = to.x;
        z = to.z;
        drop = dip((p - d) / (1 - d), to.drop);
        carry = p < set;
      }
    }
    x = Math.max(g.from, Math.min(g.to, x));
    g.carriage.position.x += (x - g.carriage.position.x) * Math.min(1, dt * 10);
    // The trolley's along the boom from the carriage.
    trolley.position.z += (z - trolley.position.z) * Math.min(1, dt * 10);
    trolley.position.x = 0;
    c.rope.scale.y = drop;
    c.rope.position.y = -drop / 2;
    c.hook.position.y = -drop;
    g.load.visible = carry;
    if (carry) paintContainer(g.load, g.look);
  }

  setSpeed(speed: number): void {
    this.speed = speed;
  }

  setYards(
    yards: {
      boxes: number;
      exports: number;
      tiles: number[];
      looks: number[];
      working?: 'load' | 'unload';
      workLook?: number;
      workAt?: number;
      workTruck?: number;
      workSlot?: number;
      workPhase?: number;
      lifted?: number;
    }[],
  ): void {
    for (const y of yards) {
      this.fill(y.tiles, y.boxes + y.exports + (y.lifted ?? 0), true, y.looks);
      // Its gantry, at work or not, and where in the yard the container
      // it is moving lies, or for one coming off a truck, where it goes.
      const tiles = new Set(y.tiles);
      for (const [i, g] of this.yardGantries) {
        if (!this.map.neighbors4(i).some((n) => tiles.has(n))) continue;
        g.work = y.working ?? null;
        g.laneAt = y.workAt ?? 0;
        g.truck = y.workTruck;
        g.slot = y.workSlot ?? 0;
        // Keep the lift in step with the game's: the container leaves the
        // truck, or lands on it, as the spreader takes it or sets it down.
        if (y.workPhase !== undefined) {
          const off = ((y.workPhase - g.phase + 1.5) % 1) - 0.5;
          g.phase = Math.abs(off) > 0.15 ? y.workPhase : (g.phase + off * 0.5 + 1) % 1;
        }
        if (y.workLook !== undefined) g.look = y.workLook;
        g.pick = y.working ? this.slotFor(g, y.tiles, y.working, y.workLook) : null;
      }
    }
  }

  /**
   * A yard gantry at work runs its trolley out over the stacks, lowers the
   * spreader, lifts a container, runs back over the truck lane below it and
   * sets it down on the truck; unloading a shipper's truck, the other way
   * round. Idle, it waits over the middle with the spreader up.
   */
  /**
   * Where on its beam a yard gantry takes the container it is loading on a
   * truck (the slot it lies in, by `look`), or puts one off a truck (the
   * next free slot): along the beam, across it, and how far down.
   */
  private slotFor(
    g: YardGantryParts,
    tiles: number[],
    work: 'load' | 'unload',
    look?: number,
  ): YardGantryParts['pick'] {
    const order = tiles.length > 0 ? (this.slots.get(tiles[0]) ?? []) : [];
    let k = work === 'load' ? (look === undefined ? -1 : order.indexOf(look)) : order.length;
    if (k < 0) return null;
    let slot: Object3D | undefined;
    for (const t of tiles) {
      const items = this.stacks.get(t)?.boxes ?? [];
      if (k < items.length) {
        slot = items[k];
        break;
      }
      k -= items.length;
    }
    if (!slot) return null;
    g.frame.updateWorldMatrix(true, false);
    slot.updateWorldMatrix(true, false);
    const at = g.frame.worldToLocal(slot.getWorldPosition(new Vector3()));
    // The spreader comes down onto its top; the container hangs below it.
    const drop = g.trolley.position.y - (at.y + BOX_HEIGHT + 0.04);
    return { x: at.x, z: at.z, drop };
  }

  private runYardGantry(g: YardGantryParts, dt: number): void {
    // One lift a cycle, as long as one takes in the game.
    const cycle = YARD_GANTRY_TICKS / TICKS_PER_SECOND;
    g.phase = g.work ? (g.phase + (dt * this.speed) / cycle) % 1 : 0;
    // Idle, it stays where it last worked.
    let x = g.carriage.position.x;
    let z = Math.max(0.6, g.far / 2);
    let drop = 0.2;
    let carry = false;
    if (g.work) {
      // Between the container in the yard and the truck in the lane under
      // the gantry, where it reaches out over the edge of the yard.
      const yard = g.pick ?? { x: 0, z: Math.max(0.8, g.far * 0.6), drop: g.laneDrop };
      // Over the very container slot on the truck, front or back of a long one.
      const at = g.truck !== undefined ? this.truckSlot?.(g.truck, g.slot, this.slotAt) : null;
      if (at) g.frame.worldToLocal(at);
      const lane = at
        ? { x: at.x, z: at.z, drop: g.trolley.position.y - (at.y + BOX_HEIGHT + 0.04) }
        : { x: g.laneAt, z: 0, drop: g.laneDrop };
      const [from, to] = g.work === 'load' ? [yard, lane] : [lane, yard];
      const p = g.phase;
      const ease = (t: number) => t * t * (3 - 2 * t);
      const dip = (t: number, depth: number) => 0.2 + (depth - 0.2) * Math.sin(t * Math.PI);
      if (p < 0.25) {
        x = from.x;
        z = from.z;
        drop = dip(p / 0.25, from.drop);
        carry = p > 0.125;
      } else if (p < 0.5) {
        const t = ease((p - 0.25) / 0.25);
        x = from.x + (to.x - from.x) * t;
        z = from.z + (to.z - from.z) * t;
        carry = true;
      } else if (p < 0.75) {
        x = to.x;
        z = to.z;
        drop = dip((p - 0.5) / 0.25, to.drop);
        carry = p < 0.625;
      } else {
        const t = ease((p - 0.75) / 0.25);
        x = to.x + (from.x - to.x) * t;
        z = to.z + (from.z - to.z) * t;
      }
    }
    g.carriage.position.x += (x - g.carriage.position.x) * Math.min(1, dt * 10);
    g.trolley.position.z += (z - g.trolley.position.z) * Math.min(1, dt * 10);
    g.rope.scale.y = drop;
    g.rope.position.y = -drop / 2;
    g.spreader.position.y = -drop;
    g.load.visible = carry;
    if (carry) paintContainer(g.load, g.look);
  }

  setBays(bays: BayView[]): void {
    for (const b of bays) {
      if (b.tiles) {
        this.fill(b.tiles, b.stock + b.exports, false);
        continue;
      }
      const stack = this.stacks.get(b.idx);
      if (!stack) continue;
      stack.crates.forEach((c, k) => (c.visible = k < b.stock));
      stack.boxes.forEach((c, k) => (c.visible = k < b.boxes));
    }
  }

  /** Crates set down on the quay beside the boats, two piles of two high, on pallets or not. */
  setPiles(views: PileView[]): void {
    const seen = new Set<number>();
    for (const v of views) {
      seen.add(v.idx);
      let pile = this.piles.get(v.idx);
      if (pile && pile.pallets !== v.pallets) {
        this.group.remove(pile.group);
        pile = undefined;
      }
      if (!pile) {
        pile = this.pile(v.idx, v.pallets);
        this.piles.set(v.idx, pile);
        this.group.add(pile.group);
      }
      pile.crates.forEach((c, k) => (c.visible = k < v.crates));
    }
    for (const [i, pile] of this.piles) {
      if (seen.has(i)) continue;
      this.group.remove(pile.group);
      this.piles.delete(i);
    }
  }

  private pile(
    i: number,
    pallets: boolean,
  ): { group: Group; crates: Object3D[]; pallets: boolean } {
    const g = new Group();
    g.position.set(this.map.xOf(i), 0, this.map.yOf(i));
    const lift = pallets ? 0.04 : 0;
    const crates: Object3D[] = [];
    for (let layer = 0; layer < 2; layer++) {
      for (const [x, z] of [
        [0.38, 0.38],
        [0.62, 0.38],
        [0.38, 0.62],
        [0.62, 0.62],
      ]) {
        const c = crate(0.2, x, QUAY_Y + lift + layer * 0.2, z);
        c.visible = false;
        g.add(c);
        crates.push(c);
      }
    }
    if (pallets) {
      for (const x of [0.38, 0.62]) {
        for (const z of [0.38, 0.62]) g.add(box(0.22, 0.04, 0.22, C.wood, x, QUAY_Y, z));
      }
    }
    return { group: g, crates, pallets };
  }

  /** Show a storage area's goods, a tile's worth at a time from its first tile. */
  private fill(tiles: number[], count: number, boxes: boolean, looks?: number[]): void {
    let left = count;
    let at = 0;
    // Each container as it looks, staying in its slot as others come and go.
    const order = looks && tiles.length > 0 ? this.settled(tiles[0], looks) : undefined;
    for (const t of tiles) {
      const stack = this.stacks.get(t);
      if (!stack) continue;
      const items = boxes ? stack.boxes : stack.crates;
      items.forEach((o, k) => {
        o.visible = k < left;
        if (order && o.visible && at + k < order.length) paintContainer(o, order[at + k]);
      });
      at += Math.min(left, items.length);
      left = Math.max(0, left - items.length);
    }
  }

  /** The slots of the containers kept under `key`, brought up to date with `looks`. */
  private settled(key: number, looks: number[]): number[] {
    const order = settle(this.slots.get(key) ?? [], looks);
    this.slots.set(key, order);
    return order;
  }

  private rebuild(i: number): void {
    const old = this.tiles.get(i);
    // A yard gantry laid again carries on where it was.
    const was = this.yardGantries.get(i);
    if (old) {
      this.group.remove(old);
      this.tiles.delete(i);
      this.stacks.delete(i);
      this.cranes.delete(i);
      this.gates.delete(i);
      this.buoys.delete(i);
      this.crossings.delete(i);
      this.yardGantries.delete(i);
    }
    let obj = this.make(i);
    const now = this.yardGantries.get(i);
    if (was && now) {
      now.carriage.position.x = was.carriage.position.x;
      now.trolley.position.z = was.trolley.position.z;
      Object.assign(now, { pick: was.pick, work: was.work, look: was.look, phase: was.phase });
    }
    if ((FACES.has(this.map.build[i]) || isTownBuilding(this.map.build[i])) && obj) {
      obj = turn(obj, this.map.orient[i]);
    }
    // A yard laid out on a quay stands on the quay's walls and piles.
    if (this.map.orient[i] & ON_QUAY) {
      const both = new Group();
      const deck = new Group();
      this.quay(deck, i, true);
      this.machinesOutline(deck, i, QUAY_Y);
      both.add(deck);
      if (obj) both.add(obj);
      obj = both;
    }
    if (!obj) return;
    obj.position.set(this.map.xOf(i), 0, this.map.yOf(i));
    this.group.add(obj);
    this.tiles.set(i, obj);
  }

  /**
   * Whether the building on tile `i` joins another of its kind beside it,
   * facing the same way, on its left (-x) and right (+x) as it is drawn,
   * facing +z before it is turned (see turn).
   */
  private joins(i: number): { left: boolean; right: boolean } {
    const m = this.map;
    const f = m.orient[i] & 3;
    const [dx, dy] = FACING[f];
    // Its +x in the world, once turned to face (dx, dy).
    const [rx, ry] = [dy, -dx];
    const same = (sx: number, sy: number) => {
      const x = m.xOf(i) + sx;
      const y = m.yOf(i) + sy;
      if (!m.inBounds(x, y)) return false;
      const n = m.idx(x, y);
      return m.build[n] === m.build[i] && (m.orient[n] & 3) === f;
    };
    return { left: same(-rx, -ry), right: same(rx, ry) };
  }

  private is(i: number, dx: number, dy: number, ...codes: number[]): boolean {
    const x = this.map.xOf(i) + dx;
    const y = this.map.yOf(i) + dy;
    if (!this.map.inBounds(x, y)) return false;
    return codes.includes(this.map.build[this.map.idx(x, y)]);
  }

  private make(i: number): Object3D | null {
    const code = this.map.build[i];
    if (code === Build.None) return null;
    // The second tile of a large bay is drawn with its first.
    if (this.map.orient[i] & EXTENSION) return null;
    const g = new Group();
    const top = landTop(this.map.terrain[i]);

    switch (code) {
      case Build.Road: {
        g.add(box(1, 0.05, 1, C.asphalt, 0.5, top, 0.5));
        if (this.map.orient[i] & TOWN && this.builtUp(i)) {
          // A town street: pavements, and a lamp now and then.
          const open = DIRS.map(([dx, dy]) => this.streetAt(i, dx, dy));
          pavements(g, top, open, hash01(i, 5, 5) < 0.3);
          return bake(g);
        }
        const road = [Build.Road, Build.Crossing];
        const ew = this.is(i, 1, 0, ...road) || this.is(i, -1, 0, ...road) || i === this.map.entry;
        const ns = this.is(i, 0, 1, ...road) || this.is(i, 0, -1, ...road);
        if (ew !== ns) {
          for (const o of [0.25, 0.75]) {
            const [x, z, w, d] = ew ? [o, 0.5, 0.26, 0.05] : [0.5, o, 0.05, 0.26];
            g.add(box(w, 0.01, d, C.marking, x, top + 0.05, z));
          }
        }
        return g;
      }
      case Build.Rail:
        this.track(
          g,
          top,
          !this.is(i, 0, 1, Build.Rail, Build.Crossing) &&
            !this.is(i, 0, -1, Build.Rail, Build.Crossing),
        );
        return g;
      case Build.Crossing:
        this.crossing(g, i, top);
        return g;
      case Build.Office: {
        // Harbour office: two storeys, a control room on top, radio mast and
        // flag. Offices side by side, facing the same way, make one long
        // block with a single entrance, control room, mast and flag.
        const { left, right } = this.joins(i);
        const [x0, x1] = [left ? 0 : 0.15, right ? 1 : 0.85];
        const lead = !left;
        g.add(box(1, 0.05, 1, C.concrete, 0.5, top, 0.5));
        const y = top + 0.05;
        g.add(box(x1 - x0, 0.4, 0.62, C.cabin, (x0 + x1) / 2, y, 0.5));
        const [w0, w1] = [left ? 0 : 0.22, right ? 1 : 0.78];
        for (const z of [0.18, 0.82]) {
          g.add(box(w1 - w0, 0.06, 0.012, C.window, (w0 + w1) / 2, y + 0.08, z));
          g.add(box(w1 - w0, 0.06, 0.012, C.window, (w0 + w1) / 2, y + 0.25, z));
        }
        const [r0, r1] = [left ? 0 : 0.13, right ? 1 : 0.87];
        g.add(box(r1 - r0, 0.03, 0.66, C.sign, (r0 + r1) / 2, y + 0.4, 0.5));
        if (lead) {
          g.add(box(0.36, 0.16, 0.36, C.window, 0.5, y + 0.43, 0.5));
          g.add(box(0.42, 0.03, 0.42, C.sign, 0.5, y + 0.59, 0.5));
          g.add(cyl(0.012, 0.42, C.chassis, 0.62, y + 0.62, 0.62));
          // Front door, towards +z like every building before it is turned.
          g.add(box(0.16, 0.22, 0.02, C.woodDark, 0.5, y, 0.82));
        }
        if (!right) {
          g.add(cyl(0.012, 0.5, C.chassis, 0.16 + (left ? 0.68 : 0), y, 0.84));
          g.add(box(0.012, 0.1, 0.14, C.funnel, 0.16 + (left ? 0.68 : 0), y + 0.4, 0.91));
        }
        return g;
      }
      case Build.PortRoad: {
        // Same paving as the quays and flush with them, with a dashed white centre line.
        g.add(box(1, QUAY_Y - top, 1, C.quayTop, 0.5, top, 0.5));
        const along = this.is(i, 1, 0, Build.PortRoad) || this.is(i, -1, 0, Build.PortRoad);
        if (this.map.store[i]) {
          this.storage(g, i, QUAY_Y);
          this.machinesOutline(g, i, QUAY_Y);
          return g;
        }
        if (machinesOnly(this.map, i)) {
          this.machinesMarking(g, i, QUAY_Y);
          return g;
        }
        for (const o of [0.15, 0.6]) {
          const [x, z, w, d] = along ? [o + 0.125, 0.5, 0.25, 0.04] : [0.5, o + 0.125, 0.04, 0.25];
          g.add(box(w, 0.006, d, C.marking, x, QUAY_Y, z));
        }
        return g;
      }
      case Build.Parking: {
        // Asphalt outside the port, port paving inside it, and white lines
        // between one space and the next, at the angle trucks park at. A
        // truck stands across the middle of its tile, so the lines run through
        // the tile's edges: each tile draws the half of each line inside it,
        // and the lines stop at the ends of the lot, off the roads.
        const { inside, acrossX, wide } = this.lotAt(i);
        const y = inside ? QUAY_Y : top + 0.05;
        g.add(box(1, y - top, 1, inside ? C.quayTop : C.asphalt, 0.5, top, 0.5));
        // Two tiles wide, a truck stands across the middle of both, where
        // the corners of the tiles meet: the lines between the spaces run
        // corner to corner across each tile, joining up across the strip.
        if (wide) {
          const line = box(1.3, 0.008, 0.035, C.marking, 0.5, y, 0.5);
          line.rotation.y = acrossX ? -Math.PI / 4 : Math.PI / 4;
          g.add(line);
          return g;
        }
        // Along the lines, which run with the parked trucks.
        const [vx, vz] = acrossX ? [Math.SQRT1_2, Math.SQRT1_2] : [Math.SQRT1_2, -Math.SQRT1_2];
        for (const o of [0, 1]) {
          const [px, pz] = acrossX ? [0.5, o] : [o, 0.5];
          // Into this tile from its edge.
          const k = (o === 0 ? 1 : -1) * 0.31;
          const half = box(0.62, 0.008, 0.035, C.marking, px + vx * k, y, pz + vz * k);
          half.rotation.y = acrossX ? -Math.PI / 4 : Math.PI / 4;
          g.add(half);
        }
        return g;
      }
      case Build.Gate: {
        // Port paving with a gatehouse to one side and a striped barrier
        // across the lane, the public road in front (+z).
        g.add(box(1, QUAY_Y - top, 1, C.quayTop, 0.5, top, 0.5));
        const y = QUAY_Y;
        g.add(box(0.6, 0.006, 0.04, C.marking, 0.42, y, 0.8));
        g.add(box(0.2, 0.26, 0.3, C.cabin, 0.88, y, 0.42));
        g.add(box(0.205, 0.08, 0.305, C.window, 0.88, y + 0.13, 0.42));
        g.add(box(0.26, 0.03, 0.36, C.sign, 0.88, y + 0.26, 0.42));
        g.add(box(0.06, 0.12, 0.06, C.chassis, 0.74, y, 0.68));
        g.add(box(0.035, 0.08, 0.035, C.chassis, 0.08, y, 0.68));
        const boom = new Group();
        boom.position.set(0.74, y + 0.11, 0.68);
        for (let k = 0; k < 6; k++) {
          boom.add(
            box(0.11, 0.03, 0.03, k % 2 ? C.marking : C.funnel, -0.06 - k * 0.11, -0.015, 0),
          );
        }
        g.add(boom);
        this.gates.set(i, { boom, open: false, angle: 0 });
        return g;
      }
      case Build.TugBerth: {
        // A pontoon afloat along the dock edge, where the tug lies: tyre
        // fenders on its water side and a pair of bollards.
        const m = this.map;
        const dock = m.neighbors4(i).find((n) => isDock(m.build[n]));
        const [dx, dy] =
          dock === undefined ? [0, -1] : [m.xOf(dock) - m.xOf(i), m.yOf(dock) - m.yOf(i)];
        const pontoon = new Group();
        pontoon.add(box(0.9, 0.08, 0.22, C.quayWall, 0, -0.04, 0));
        pontoon.add(box(0.9, 0.012, 0.22, C.quayTop, 0, 0.04, 0));
        for (const x of [-0.3, 0, 0.3]) {
          const tyre = cyl(0.045, 0.035, 0x1d1f22, x, -0.01, 0.13, 10);
          tyre.rotation.x = Math.PI / 2;
          pontoon.add(tyre);
        }
        for (const x of [-0.36, 0.36]) pontoon.add(cyl(0.025, 0.06, C.chassis, x, 0.05, 0.02, 8));
        // Along the edge nearest the dock, its fenders facing the water.
        pontoon.position.set(0.5 + dx * 0.38, 0, 0.5 + dy * 0.38);
        pontoon.rotation.y = Math.atan2(-dx, -dy);
        g.add(pontoon);
        return g;
      }
      case Build.BuoyIn:
      case Build.BuoyOut: {
        // A lateral mark: green with a cone on top for the way in, red with
        // a flat can top for the way out, a white band and a light.
        const green = code === Build.BuoyIn;
        const paint = green ? C.buoyGreen : C.buoyRed;
        const buoy = new Group();
        buoy.position.set(0.5, 0, 0.5);
        buoy.scale.setScalar(1.3);
        buoy.add(cyl(0.13, 0.12, paint, 0, -0.06, 0, 10));
        buoy.add(cyl(0.07, 0.2, paint, 0, 0.06, 0, 8));
        buoy.add(cyl(0.072, 0.04, C.cabin, 0, 0.14, 0, 8));
        if (green) {
          const cone = new Mesh(coneGeo, mat(paint));
          cone.position.y = 0.26;
          cone.castShadow = true;
          buoy.add(cone);
        } else buoy.add(cyl(0.085, 0.1, paint, 0, 0.26, 0, 8));
        buoy.add(cyl(0.025, 0.05, LIGHT, 0, green ? 0.4 : 0.36, 0, 6));
        g.add(buoy);
        this.buoys.set(i, buoy);
        return g;
      }
      case Build.Footpath:
        this.footpath(g, i, top);
        return g;
      case Build.Jetty: {
        const onBeach = this.map.isLand(i);
        const ew = this.is(i, 1, 0, Build.Jetty) || this.is(i, -1, 0, Build.Jetty);
        const ns = this.is(i, 0, 1, Build.Jetty) || this.is(i, 0, -1, Build.Jetty);
        // Run along neighbouring jetty; a lone beach jetty runs along the shore.
        const alongX = ew
          ? true
          : ns
            ? false
            : onBeach
              ? !this.landAt(i, 0, 1) || !this.landAt(i, 0, -1)
              : this.landAt(i, 1, 0) || this.landAt(i, -1, 0);
        const footing = onBeach ? top : SEABED;
        for (let k = 0; k < 4; k++) {
          const o = 0.13 + k * 0.245;
          const [x, z, w, d] = alongX ? [o, 0.5, 0.22, 1] : [0.5, o, 1, 0.22];
          g.add(box(w, 0.06, d, k % 2 ? C.wood : C.woodDark, x, DECK_Y - 0.06, z));
        }
        for (const px of [0.12, 0.88]) {
          for (const pz of [0.12, 0.88]) {
            g.add(cyl(0.05, DECK_Y - 0.06 - footing, C.woodDark, px, footing, pz));
          }
        }
        return g;
      }
      case Build.Quay: {
        this.quay(g, i);
        if (this.map.store[i]) {
          this.storage(g, i, QUAY_Y);
          this.machinesOutline(g, i, QUAY_Y);
        } else if (machinesOnly(this.map, i)) this.machinesMarking(g, i, QUAY_Y);
        return g;
      }
      case Build.HarbourCrane: {
        // Mobile harbour crane: a wheeled base with outriggers, a tall tower
        // and a long boom that slews out over the ship.
        this.quay(g, i);
        this.machinesOutline(g, i, QUAY_Y);
        const y = QUAY_Y;
        g.add(box(0.86, 0.12, 0.86, C.chassis, 0.5, y, 0.5));
        for (const [ox, oz] of [
          [0.06, 0.06],
          [0.94, 0.06],
          [0.06, 0.94],
          [0.94, 0.94],
        ]) {
          g.add(box(0.1, 0.06, 0.1, C.stripe, ox, y, oz));
        }
        g.add(cyl(0.1, 1.15, C.sign, 0.5, y + 0.12, 0.5, 8));
        const slew = new Group();
        slew.position.set(0.5, y + 1.27, 0.5);
        slew.add(box(0.36, 0.24, 0.3, C.sign, -0.04, -0.12));
        slew.add(box(0.12, 0.12, 0.26, C.window, 0.14, -0.06));
        slew.add(box(0.22, 0.2, 0.3, C.chassis, -0.28, -0.14));
        const boom = box(2.1, 0.08, 0.1, C.craneYellow, 0.95, 0.04);
        boom.rotation.z = 0.12;
        slew.add(boom);
        // Cable and container spreader hang from under the boom tip.
        const tip = new Group();
        tip.position.set(1.9, 0.15, 0);
        const rope = box(0.012, 1, 0.012, C.chassis);
        const hook = new Group();
        hook.add(box(0.36, 0.04, 0.16, C.stripe, 0, -0.04));
        tip.add(rope, hook);
        slew.add(tip);
        g.add(slew);
        // Landing stack for up to four containers on the landward side.
        const stack: Object3D[] = [];
        const back = this.landwardOffset(i);
        for (let layer = 0; layer < 2; layer++) {
          for (const off of [0.2, 0.52]) {
            const [cx, cz] = back.alongX
              ? [0.5, 0.5 + back.side * off]
              : [0.5 + back.side * off, 0.5];
            const c = container(stack.length + 1, cx, y + 0.12 + layer * BOX_HEIGHT, cz);
            if (!back.alongX) c.rotation.y = Math.PI / 2;
            c.visible = false;
            g.add(c);
            stack.push(c);
          }
        }
        this.cranes.set(i, {
          slew,
          rope,
          hook,
          rest: 0.45,
          reach: 0.6,
          stack,
          angle: 0,
          target: 0,
          busy: false,
        });
        return g;
      }
      case Build.YardGantry: {
        // A rail-mounted gantry spanning the container yard beside it: legs
        // on rails along this side of the yard and its far side, a beam
        // overhead and a trolley with its spreader over the stacks. It runs
        // along the rails to whichever row of the yard it is working.
        const m = this.map;
        const y = QUAY_Y;
        g.add(box(1, y - top, 1, C.quayTop, 0.5, top, 0.5));
        const yard = m.neighbors4(i).find((n) => storesBoxes(m.store[n]));
        const [dx, dy] =
          yard === undefined ? [0, 1] : [m.xOf(yard) - m.xOf(i), m.yOf(yard) - m.yOf(i)];
        // Across as many yard tiles as there are, up to three.
        let span = 1;
        while (span < 3) {
          const x = m.xOf(i) + dx * (span + 1);
          const z = m.yOf(i) + dy * (span + 1);
          if (!m.inBounds(x, z) || !storesBoxes(m.store[m.idx(x, z)])) break;
          span++;
        }
        // Along the yard, either way, as far as its first row runs: the
        // frame's +x is (dy, -dx) on the map.
        const along = (sign: number) => {
          let k = 0;
          while (k < GANTRY_RUN) {
            const x = m.xOf(i) + dx + dy * sign * (k + 1);
            const z = m.yOf(i) + dy - dx * sign * (k + 1);
            if (!m.inBounds(x, z) || !storesBoxes(m.store[m.idx(x, z)])) break;
            k++;
          }
          return k * sign;
        };
        const [from, to] = yard === undefined ? [0, 0] : [along(-1), along(1)];
        const frame = new Group();
        const h = 1.15;
        const far = span + 0.35;
        for (const z of [-0.35, far]) {
          frame.add(box(to - from + 1, 0.02, 0.06, C.chassis, (from + to) / 2, y, z));
        }
        const carriage = new Group();
        for (const z of [-0.35, far]) {
          for (const x of [-0.4, 0.4]) {
            carriage.add(box(0.1, h, 0.1, C.craneYellow, x, y, z));
            carriage.add(box(0.14, 0.08, 0.24, C.chassis, x, y, z));
          }
          carriage.add(box(0.9, 0.1, 0.1, C.craneYellow, 0, y + h - 0.1, z));
        }
        for (const x of [-0.4, 0.4]) {
          carriage.add(box(0.1, 0.12, far + 0.45, C.craneYellow, x, y + h, (far - 0.35) / 2));
        }
        // The trolley with its cab, the hoist ropes and the spreader on them,
        // and the container it is lifting, if any.
        const trolley = new Group();
        trolley.position.set(0, y + h, Math.max(0.6, far / 2));
        trolley.add(box(0.6, 0.08, 0.3, C.chassis, 0, 0.12, 0));
        trolley.add(box(0.2, 0.16, 0.2, C.window, 0.18, -0.16, 0));
        const rope = box(0.012, 1, 0.012, C.chassis);
        const spreader = new Group();
        spreader.add(box(0.5, 0.04, 0.16, C.stripe, 0, -0.04, 0));
        const load = container(i, 0, -0.04 - BOX_HEIGHT, 0);
        load.visible = false;
        spreader.add(load);
        trolley.add(rope, spreader);
        carriage.add(trolley);
        frame.add(carriage);
        this.yardGantries.set(i, {
          frame,
          carriage,
          trolley,
          rope,
          spreader,
          load,
          far,
          // Down to a truck's deck in the lane under it, set down there.
          laneDrop: h - 0.28 - BOX_HEIGHT,
          pick: null,
          laneAt: 0,
          slot: 0,
          work: null,
          look: 0,
          phase: 0,
        });
        // Laid out along +z, then turned to face the yard.
        frame.position.set(0.5, 0, 0.5);
        frame.rotation.y = Math.atan2(dx, dy);
        g.add(frame);
        return g;
      }
      case Build.Gantry: {
        // Ship-to-shore gantry over 2×2 of quay: x 0..2 along the edge, the
        // water off the front (+z), z -1..1. A slender portal on four legs
        // runs on rails along the quay, its boom reaching out across the
        // whole ship and back over the bay between its back legs, where it
        // sets the containers down.
        const m = this.map;
        const y = QUAY_Y;
        const top = y + 1.55;
        // The rails run on along the quay as far as it goes, three tiles
        // either way at most, for it to work the length of a ship.
        const [a, r] = footprint(m, 'gantryCrane', i, m.orient[i]);
        const [rx, ry] = [m.xOf(r) - m.xOf(a), m.yOf(r) - m.yOf(a)];
        const [bx, by] = [m.xOf(i) - m.xOf(a), m.yOf(i) - m.yOf(a)];
        const back = footprint(m, 'gantryCrane', i, m.orient[i])[2];
        const [kx, ky] = [m.xOf(back) - m.xOf(a), m.yOf(back) - m.yOf(a)];
        const paved = (x: number, z: number) => {
          if (!m.inBounds(x, z)) return false;
          const b = m.build[m.idx(x, z)];
          return (
            b === Build.Quay ||
            b === Build.Gantry ||
            b === Build.HarbourCrane ||
            b === Build.JibCrane
          );
        };
        const run = (sign: number, from: number) => {
          let k = 0;
          while (k < 3) {
            const x = m.xOf(a) + bx + rx * sign * (from + k);
            const z = m.yOf(a) + by + ry * sign * (from + k);
            if (!paved(x, z) || !paved(x + kx, z + ky)) break;
            k++;
          }
          return k;
        };
        const left = run(-1, 1);
        const right = run(1, 2);
        for (const z of [-0.85, 0.85]) {
          g.add(box(2 + left + right, 0.02, 0.05, C.chassis, 1 + (right - left) / 2, y, z));
        }
        const carriage = new Group();
        carriage.position.x = 1;
        const half = 0.38;
        const leg = 0.06;
        for (const x of [-half, half]) {
          for (const z of [-0.85, 0.85]) {
            carriage.add(box(0.1, 0.07, 0.2, C.chassis, x, y, z));
            carriage.add(box(leg, top - y, leg, C.sign, x, y + 0.07, z));
          }
          // A tie along each side, high enough for the stacks to pass under.
          carriage.add(box(0.04, 0.05, 1.7, C.sign, x, top - 0.45, 0));
        }
        // The portal beams across, front and back.
        for (const z of [-0.85, 0.85]) {
          carriage.add(box(half * 2 + leg, 0.07, 0.07, C.sign, 0, top - 0.07, z));
        }
        // The boom: twin girders out across the ship's beam and back over
        // the landside, a lighter tip, and a walkway between.
        const reach = 2.75;
        const tail = -1.55;
        for (const x of [-0.13, 0.13]) {
          carriage.add(box(0.04, 0.07, reach - tail, C.craneYellow, x, top, (reach + tail) / 2));
        }
        carriage.add(box(0.3, 0.02, reach - tail, C.chassis, 0, top - 0.01, (reach + tail) / 2));
        // An apex frame over the back legs, stays out to the tip and back to
        // the tail, and the machinery house on the backreach.
        const apex = top + 0.62;
        for (const x of [-0.13, 0.13]) {
          carriage.add(strut([x, top, -1.05], [0, apex, -0.85], 0.035, C.sign));
          carriage.add(strut([x, top, -0.65], [0, apex, -0.85], 0.035, C.sign));
          carriage.add(strut([0, apex, -0.85], [x, top + 0.07, reach - 0.15], 0.014, C.chassis));
          carriage.add(strut([0, apex, -0.85], [x, top + 0.07, tail + 0.1], 0.014, C.chassis));
        }
        carriage.add(box(0.3, 0.16, 0.36, C.cabin, 0, top + 0.07, tail + 0.3));
        // The trolley with the driver's cab under it, the hoist and spreader.
        const trolley = new Group();
        trolley.position.set(0, top, -0.3);
        trolley.add(box(0.32, 0.05, 0.22, C.chassis, 0, 0.06, 0));
        trolley.add(box(0.14, 0.12, 0.14, C.window, 0.1, -0.14, 0.04));
        const rope = box(0.012, 1, 0.012, C.chassis);
        const hook = new Group();
        hook.add(box(0.62, 0.035, 0.15, C.stripe, 0, -0.035));
        const load = container(i, 0, -0.035 - BOX_HEIGHT, 0);
        load.visible = false;
        hook.add(load);
        trolley.add(rope, hook);
        carriage.add(trolley);
        g.add(carriage);
        // The bay between the legs: a row of four across, four high.
        const stack: Object3D[] = [];
        for (let layer = 0; layer < 4; layer++) {
          for (const z of [-0.6, -0.3, 0, 0.3]) {
            const c = container(i * 5 + stack.length, 1, y + layer * BOX_HEIGHT, z);
            c.visible = false;
            g.add(c);
            stack.push(c);
          }
        }
        this.cranes.set(i, {
          slew: trolley,
          rope,
          hook,
          rest: 0.25,
          reach: 1.0,
          stack,
          angle: 0,
          target: 0,
          busy: false,
          fixed: true,
          sts: {
            frame: g,
            carriage,
            from: 1 - left - 0.6,
            to: 1 + right + 0.6,
            load,
            work: null,
            boat: -1,
            slot: 0,
            look: 0,
            phase: 0,
            stacked: 0,
          },
        });
        return g;
      }
      case Build.JibCrane: {
        this.quay(g, i);
        this.machinesOutline(g, i, QUAY_Y);
        // Pedestal, then a slewing cab and jib that swings to face the boat.
        g.add(cyl(0.13, 0.5, C.craneYellow, 0.5, QUAY_Y, 0.5, 8));
        const slew = new Group();
        slew.position.set(0.5, QUAY_Y + 0.5, 0.5);
        slew.add(box(0.3, 0.2, 0.24, C.craneYellow, -0.02, 0));
        slew.add(box(0.06, 0.1, 0.2, C.window, 0.13, 0.05));
        const jib = box(1.25, 0.06, 0.07, C.craneYellow, 0.6, 0.18);
        jib.rotation.z = 0.28;
        slew.add(jib);
        slew.add(box(0.16, 0.14, 0.2, C.chassis, -0.2, 0.02));
        // Cable and hook hang from under the jib, near its tip.
        const tip = new Group();
        tip.position.set(1.08, 0.31, 0);
        const rope = box(0.01, 1, 0.01, C.chassis);
        const hook = new Group();
        hook.add(box(0.07, 0.05, 0.07, C.chassis, 0, -0.05));
        tip.add(rope, hook);
        slew.add(tip);
        g.add(slew);
        // Landing stack on the landward half of the tile.
        const stack: Object3D[] = [];
        const back = this.landwardOffset(i);
        for (let layer = 0; layer < 2; layer++) {
          for (let k = 0; k < 5; k++) {
            const a = 0.15 + k * 0.17;
            const [cx, cz] = back.alongX
              ? [a, 0.5 + back.side * 0.32]
              : [0.5 + back.side * 0.32, a];
            const c = crate(0.15, cx, QUAY_Y + layer * 0.15, cz);
            c.visible = false;
            g.add(c);
            stack.push(c);
          }
        }
        this.cranes.set(i, {
          slew,
          rope,
          hook,
          rest: 0.2,
          reach: 0.35,
          stack,
          angle: 0,
          target: 0,
          busy: false,
        });
        return g;
      }
      case Build.Depot: {
        // Concrete apron, a garage with its door at the front (+z), a pump.
        // Depots side by side, facing the same way, make one long garage
        // with a door for each bay and a pump at the end.
        const { left, right } = this.joins(i);
        g.add(box(1, 0.05, 1, C.concrete, 0.5, top, 0.5));
        const y = top + 0.05;
        const [x0, x1] = [left ? 0 : 0.08, right ? 1 : 0.92];
        g.add(box(x1 - x0, 0.36, 0.56, C.depotWall, (x0 + x1) / 2, y, 0.32));
        const [r0, r1] = [left ? 0 : 0.06, right ? 1 : 0.94];
        g.add(box(r1 - r0, 0.04, 0.6, C.depotRoof, (r0 + r1) / 2, y + 0.36, 0.32));
        g.add(box(0.46, 0.28, 0.02, C.chassis, 0.5, y, 0.6));
        for (let k = 0; k < 4; k++) {
          g.add(box(0.46, 0.012, 0.024, C.quayWall, 0.5, y + 0.04 + k * 0.065, 0.6));
        }
        // Hazard stripe across the apron and a red fuel pump.
        const [s0, s1] = [left ? 0 : 0.05, right ? 1 : 0.95];
        g.add(box(s1 - s0, 0.008, 0.05, C.stripe, (s0 + s1) / 2, y, 0.9));
        if (!right) {
          g.add(box(0.1, 0.22, 0.08, C.funnel, 0.88, y, 0.8));
          g.add(box(0.11, 0.05, 0.09, C.cabin, 0.88, y + 0.16, 0.8));
        }
        return g;
      }
      case Build.BreakHut: {
        // A little timber hut with a red roof and a bench out front.
        g.add(box(1, 0.04, 1, C.path, 0.5, top, 0.5));
        g.add(box(0.7, 0.34, 0.5, C.cabin, 0.5, top + 0.04, 0.38));
        g.add(box(0.14, 0.22, 0.02, C.woodDark, 0.5, top + 0.04, 0.64));
        g.add(box(0.14, 0.1, 0.02, C.window, 0.3, top + 0.2, 0.64));
        g.add(box(0.14, 0.1, 0.02, C.window, 0.7, top + 0.2, 0.64));
        const roof = new Mesh(roofGeo, mat(C.funnel));
        roof.position.set(0.5, top + 0.38, 0.38);
        roof.castShadow = roof.receiveShadow = true;
        g.add(roof);
        g.add(box(0.7, 0.04, 0.12, C.wood, 0.5, top + 0.12, 0.9));
        return g;
      }
      case Build.TruckBay: {
        // Entrance at the front (+z): the truck pulls in, crates line the side.
        g.add(box(1, 0.06, 1, C.concrete, 0.5, top, 0.5));
        const y = top + 0.06;
        for (const x of [0.06, 0.94]) g.add(box(0.05, 0.01, 0.9, C.stripe, x, y, 0.5));
        const crates: Object3D[] = [];
        for (let layer = 0; layer < 4; layer++) {
          for (const z of [0.2, 0.4, 0.6, 0.8]) {
            const c = crate(0.17, 0.84, y + layer * 0.17, z);
            c.visible = false;
            g.add(c);
            crates.push(c);
          }
        }
        g.add(cyl(0.02, 0.5, C.chassis, 0.92, y, 0.08));
        g.add(box(0.04, 0.16, 0.22, C.sign, 0.92, y + 0.45, 0.08));
        this.stacks.set(i, { crates, boxes: [] });
        return g;
      }
      case Build.LargeBay: {
        // Two tiles: a truck lane (x 0..1) and a covered cargo yard beside it
        // (x 1..2), both opening onto the road at the front (+z).
        g.add(box(2, 0.06, 1, C.quayTop, 1, top, 0.5));
        const y = top + 0.06;
        for (const x of [0.06, 0.94]) g.add(box(0.05, 0.01, 0.9, C.stripe, x, y, 0.5));
        g.add(box(0.8, 0.01, 0.05, C.marking, 0.5, y, 0.08));
        // Crates: four rows of four, stacked up.
        const crates: Object3D[] = [];
        for (let layer = 0; layer < 4; layer++) {
          for (const z of [0.2, 0.4, 0.6, 0.8]) {
            for (const x of [1.2, 1.4, 1.6, 1.8]) {
              if (crates.length >= 28) break;
              const c = crate(0.17, x, y + layer * 0.17, z);
              c.visible = false;
              g.add(c);
              crates.push(c);
            }
          }
        }
        // Canopy over the yard on four posts.
        for (const x of [1.06, 1.94]) {
          for (const z of [0.06, 0.94]) g.add(cyl(0.03, 0.8, C.chassis, x, y, z));
        }
        g.add(box(1, 0.04, 1, C.depotRoof, 1.5, y + 0.8, 0.5));
        g.add(cyl(0.02, 0.5, C.chassis, 0.08, y, 0.08));
        g.add(box(0.04, 0.16, 0.22, C.sign, 0.08, y + 0.45, 0.08));
        this.stacks.set(i, { crates, boxes: [] });
        return g;
      }
    }
    return townBuilding(code, top, hash01(i, 11, 3));
  }

  /** Whether the town has built anything next to `i`; out in the country its road has no pavements. */
  private builtUp(i: number): boolean {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const n = this.offset(i, dx, dy);
        if (n >= 0 && isTownBuilding(this.map.build[n])) return true;
      }
    }
    return false;
  }

  /** Whether the street on `i` carries on to dx, dy: another road, or off the map edge. */
  private streetAt(i: number, dx: number, dy: number): boolean {
    const x = this.map.xOf(i) + dx;
    const y = this.map.yOf(i) + dy;
    if (!this.map.inBounds(x, y)) return dx < 0;
    return isPublicRoad(this.map.build[this.map.idx(x, y)]);
  }

  /** Ballast, sleepers and rails, along z (or along x). */
  private track(g: Group, top: number, alongX = false): void {
    const put = (w: number, h: number, d: number, color: number, x: number, y: number, z: number) =>
      g.add(alongX ? box(d, h, w, color, z, y, x) : box(w, h, d, color, x, y, z));
    put(0.64, 0.05, 1, BALLAST, 0.5, top, 0.5);
    for (const z of [0.17, 0.5, 0.83]) put(0.54, 0.025, 0.11, C.woodDark, 0.5, top + 0.05, z);
    for (const x of [0.35, 0.65]) put(0.03, 0.03, 1, STEEL, x, top + 0.075, 0.5);
  }

  /**
   * A road over the line on the level: the road runs along x and the rails
   * along z, with a barrier and flashing lamps on each side of the line.
   */
  private crossing(g: Group, i: number, top: number): void {
    g.add(box(1, 0.05, 1, C.asphalt, 0.5, top, 0.5));
    g.add(box(0.44, 0.012, 1, C.quayWall, 0.5, top + 0.05, 0.5));
    for (const x of [0.35, 0.65]) g.add(box(0.03, 0.02, 1, STEEL, x, top + 0.05, 0.5));
    const town = (this.map.orient[i] & TOWN) !== 0;
    if (town) pavements(g, top, [true, true, false, false], false);
    const arms: CrossingParts['arms'] = [];
    const lamps: Object3D[] = [];
    // One barrier each side of the line, across the lane coming towards it.
    for (const [px, pz, sign] of [
      [0.1, 0.9, 1],
      [0.9, 0.1, -1],
    ] as const) {
      g.add(box(0.05, 0.3, 0.05, C.cabin, px, top + 0.05, pz));
      const cross = [0.785, -0.785].map((a) => {
        const b = box(0.012, 0.012, 0.14, C.funnel, px, top + 0.3, pz);
        b.rotation.x = a;
        return b;
      });
      g.add(...cross);
      for (const dz of [-0.045, 0.045]) {
        const lamp = box(
          0.035,
          0.035,
          0.035,
          LAMP_RED,
          px + (px < 0.5 ? -0.03 : 0.03),
          top + 0.22,
          pz + dz,
        );
        lamp.visible = false;
        g.add(lamp);
        lamps.push(lamp);
      }
      const arm = new Group();
      arm.position.set(px + (px < 0.5 ? 0.04 : -0.04), top + 0.14, pz);
      // Red and white along its length, pointing across the road.
      for (let k = 0; k < 6; k++) {
        arm.add(
          box(
            0.02,
            0.025,
            0.12,
            k % 2 ? C.marking : C.funnel,
            0,
            -0.0125,
            -sign * (0.06 + k * 0.12),
          ),
        );
      }
      g.add(arm);
      arms.push({ arm, sign });
    }
    this.crossings.set(i, { arms, lamps, y: this.map.yOf(i), angle: 1.45 });
  }

  /**
   * A tile marked out as storage: a line painted round the edge of the area,
   * and the goods stacked on it, crates four high in four piles or containers
   * two abreast and three high, lying along the area.
   */
  private storage(g: Group, i: number, y: number): void {
    const code = this.map.store[i];
    const boxes = storesBoxes(code);
    // Storage for cargo going out is outlined in blue.
    const line = storesOutgoing(code) ? C.sign : boxes ? C.stripe : C.marking;
    const same = (dx: number, dy: number) => {
      const n = this.offset(i, dx, dy);
      return n >= 0 && this.map.store[n] === code;
    };
    for (const [dx, dy] of DIRS) {
      if (same(dx, dy)) continue;
      const [x, z, w, d] = dx ? [0.5 + dx * 0.45, 0.5, 0.04, 1] : [0.5, 0.5 + dy * 0.45, 1, 0.04];
      g.add(box(w, 0.006, d, line, x, y, z));
    }
    const stack: BayStack = { crates: [], boxes: [] };
    if (boxes) {
      // Along the yard's long side, as its gantry runs.
      const area = this.storeArea(i);
      const xs = area.map((t) => this.map.xOf(t));
      const ys = area.map((t) => this.map.yOf(t));
      const alongX = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys);
      for (let layer = 0; layer < 3; layer++) {
        for (const o of [0.32, 0.68]) {
          const [x, z] = alongX ? [0.5, o] : [o, 0.5];
          const c = container(i * 7 + stack.boxes.length, x, y + layer * BOX_HEIGHT, z);
          if (!alongX) c.rotation.y = Math.PI / 2;
          c.visible = false;
          g.add(c);
          stack.boxes.push(c);
        }
      }
    } else {
      for (let layer = 0; layer < 4; layer++) {
        for (const [x, z] of [
          [0.29, 0.29],
          [0.71, 0.29],
          [0.29, 0.71],
          [0.71, 0.71],
        ]) {
          const c = crate(0.2, x, y + layer * 0.2, z);
          c.visible = false;
          g.add(c);
          stack.crates.push(c);
        }
      }
    }
    this.stacks.set(i, stack);
  }

  /** Paving kept for port machines: the red outline, and a forklift sign painted on it. */
  private machinesMarking(g: Group, i: number, y: number): void {
    this.machinesOutline(g, i, y);
    g.add(box(0.22, 0.006, 0.12, C.stripe, 0.46, y, 0.5));
    g.add(box(0.06, 0.006, 0.2, C.stripe, 0.6, y, 0.5));
  }

  /** A red line round the edge of an area kept for port machines, if `i` is in one. */
  private machinesOutline(g: Group, i: number, y: number): void {
    if (!machinesOnly(this.map, i)) return;
    for (const [dx, dy] of DIRS) {
      const n = this.offset(i, dx, dy);
      if (n >= 0 && machinesOnly(this.map, n)) continue;
      const [x, z, w, d] = dx ? [0.5 + dx * 0.48, 0.5, 0.03, 1] : [0.5, 0.5 + dy * 0.48, 1, 0.03];
      g.add(box(w, 0.007, d, C.buoyRed, x, y, z));
    }
  }

  /**
   * A worn path: a dirt track with stepping stones down it and trampled grass
   * along its edges, running out to each side that leads somewhere so a run
   * of tiles reads as one winding path.
   */
  private footpath(g: Group, i: number, top: number): void {
    const arms = DIRS.filter(([dx, dy]) => this.leadsTo(i, dx, dy));
    for (const [w, h, color] of [
      [0.64, 0.012, C.verge],
      [0.42, 0.02, C.dirt],
    ] as const) {
      g.add(cyl(w / 2, h, color, 0.5, top, 0.5, 8));
      for (const [dx, dy] of arms) {
        const [x, z, bw, bd] = dx ? [0.5 + dx / 4, 0.5, 0.5, w] : [0.5, 0.5 + dy / 4, w, 0.5];
        g.add(box(bw, h, bd, color, x, top, z));
      }
    }
    // Flat stones every quarter tile, nudged and turned a little so the line wanders.
    const spots: [number, number][] = [
      [0.5, 0.5],
      ...arms.map(([dx, dy]) => [0.5 + dx / 4, 0.5 + dy / 4] as [number, number]),
    ];
    spots.forEach(([x, z], k) => {
      const jx = (hash01(i, k, 1) - 0.5) * 0.08;
      const jz = (hash01(i, k, 2) - 0.5) * 0.08;
      const s = 0.13 + hash01(i, k, 3) * 0.05;
      const stone = box(s, 0.012, s * 0.8, C.flagstone, x + jx, top + 0.02, z + jz);
      stone.rotation.y = (hash01(i, k, 4) - 0.5) * 1.2;
      g.add(stone);
    });
  }

  /** Whether a path on tile `i` should run out to the neighbour at dx, dy. */
  private leadsTo(i: number, dx: number, dy: number): boolean {
    const x = this.map.xOf(i) + dx;
    const y = this.map.yOf(i) + dy;
    if (!this.map.inBounds(x, y)) return i === this.map.entry;
    return this.map.build[this.map.idx(x, y)] !== Build.None;
  }

  /** Concrete slab (on the shore) or block (in the water) with edge details. */
  /** A quay tile; `bare` leaves off the edge furniture, for a deck built over. */
  private quay(g: Group, i: number, bare = false): void {
    const onLand = this.map.isLand(i);
    const base = onLand ? landTop(this.map.terrain[i]) : SEABED;
    // Full-tile top so neighbouring quays and port roads join without a seam.
    g.add(box(1, QUAY_Y - 0.03 - base, 1, C.quayWall, 0.5, base, 0.5));
    g.add(box(1, 0.03, 1, C.quayTop, 0.5, QUAY_Y - 0.03, 0.5));
    // Safety line, bollards and tyre fenders along open-water edges.
    const sides = [
      { dx: 1, dy: 0, x: 0.95, z: 0.5, w: 0.04, d: 1 },
      { dx: -1, dy: 0, x: 0.05, z: 0.5, w: 0.04, d: 1 },
      { dx: 0, dy: 1, x: 0.5, z: 0.95, w: 1, d: 0.04 },
      { dx: 0, dy: -1, x: 0.5, z: 0.05, w: 1, d: 0.04 },
    ];
    for (const s of bare ? [] : sides) {
      if (!this.openWater(i, s.dx, s.dy)) continue;
      const inX = s.dx !== 0 ? s.x - s.dx * 0.07 : s.x;
      const inZ = s.dy !== 0 ? s.z - s.dy * 0.07 : s.z;
      // The line runs on into the next quay along this edge, and stops at
      // the corner where the edge turns.
      const [ax, ay] = s.dx ? [0, 1] : [1, 0];
      let from = 0;
      let to = 1;
      for (const e of [-1, 1]) {
        const n = this.offset(i, ax * e, ay * e);
        const runsOn = n >= 0 && isDock(this.map.build[n]) && this.openWater(n, s.dx, s.dy);
        if (!runsOn && e < 0) from = 0.12;
        if (!runsOn && e > 0) to = 0.88;
      }
      const mid = (from + to) / 2;
      const len = to - from;
      g.add(
        box(
          s.dx ? s.w : len,
          0.005,
          s.dy ? s.d : len,
          C.stripe,
          s.dx ? inX : mid,
          QUAY_Y,
          s.dy ? inZ : mid,
        ),
      );
      g.add(
        cyl(
          0.04,
          0.08,
          C.chassis,
          s.dx ? s.x - s.dx * 0.03 : 0.3,
          QUAY_Y,
          s.dy ? s.z - s.dy * 0.03 : 0.3,
        ),
      );
      g.add(
        box(
          s.dx ? 0.05 : 0.14,
          0.12,
          s.dy ? 0.05 : 0.14,
          C.tyre,
          s.dx ? s.x + s.dx * 0.06 : 0.5,
          QUAY_Y - 0.2,
          s.dy ? s.z + s.dy * 0.06 : 0.5,
        ),
      );
    }
  }

  /** Which half of a crane tile faces land, for its landing stack. */
  private landwardOffset(i: number): { alongX: boolean; side: number } {
    const water = (dx: number, dy: number) => {
      const x = this.map.xOf(i) + dx;
      const y = this.map.yOf(i) + dy;
      return (
        this.map.inBounds(x, y) &&
        !this.map.isLand(this.map.idx(x, y)) &&
        !isDock(this.map.build[this.map.idx(x, y)])
      );
    };
    if (water(0, -1)) return { alongX: true, side: 1 };
    if (water(0, 1)) return { alongX: true, side: -1 };
    if (water(-1, 0)) return { alongX: false, side: 1 };
    return { alongX: false, side: -1 };
  }

  /** Index of the tile at dx, dy from `i`, or -1 off the map. */
  /** The tiles of the storage area `i` is in: those marked out the same, joined up. */
  private storeArea(i: number): number[] {
    const code = this.map.store[i];
    const seen = new Set([i]);
    const queue = [i];
    for (let k = 0; k < queue.length; k++) {
      for (const n of this.map.neighbors4(queue[k])) {
        if (seen.has(n) || this.map.store[n] !== code) continue;
        seen.add(n);
        queue.push(n);
      }
    }
    return queue;
  }

  private offset(i: number, dx: number, dy: number): number {
    const x = this.map.xOf(i) + dx;
    const y = this.map.yOf(i) + dy;
    return this.map.inBounds(x, y) ? this.map.idx(x, y) : -1;
  }

  /** Whether the side of `i` towards dx, dy faces water a boat could lie in. */
  private openWater(i: number, dx: number, dy: number): boolean {
    const n = this.offset(i, dx, dy);
    return n >= 0 && !this.map.isLand(n) && !isDock(this.map.build[n]);
  }

  private landAt(i: number, dx: number, dy: number): boolean {
    const x = this.map.xOf(i) + dx;
    const y = this.map.yOf(i) + dy;
    return this.map.inBounds(x, y) && this.map.isLand(this.map.idx(x, y));
  }

  /**
   * Past the west edge of the map: the highway running north to south, and
   * the roads off the map's edge joining it, the trucks' and the town's.
   */
  private highway(): Object3D {
    const g = new Group();
    const hx = HIGHWAY_X;
    const top = landTop(this.map.terrain[this.map.entry]);
    const len = this.map.h + 2 * MARGIN;
    g.add(box(1, 0.05, len, C.asphalt, hx, top, this.map.h / 2));
    for (let z = -MARGIN; z < this.map.h + MARGIN; z++) {
      g.add(box(0.05, 0.01, 0.26, C.marking, hx, top + 0.05, z + 0.25));
    }
    for (let y = 0; y < this.map.h; y++) {
      const i = this.map.idx(0, y);
      if (!isPublicRoad(this.map.build[i])) continue;
      const w = -(hx + 0.5);
      g.add(box(w, 0.05, 1, C.asphalt, -w / 2, landTop(this.map.terrain[i]), y + 0.5));
    }
    return bake(g);
  }

  /** Stakes and a painted line where the port's land ends and the country begins. */
  private boundary(): Object3D {
    const g = new Group();
    const z = this.map.limit;
    if (z >= this.map.h) return g;
    for (let x = 0; x < this.map.w; x++) {
      const i = this.map.idx(x, z - 1);
      if (!this.map.isLand(i) || !this.map.isLand(i + this.map.w)) continue;
      const top = landTop(this.map.terrain[i]);
      g.add(box(0.5, 0.012, 0.05, C.marking, x + 0.5, top, z));
      if (x % 3 === 0) {
        g.add(cyl(0.025, 0.24, C.marking, x + 0.1, top, z));
        g.add(cyl(0.027, 0.06, C.funnel, x + 0.1, top + 0.18, z));
      }
    }
    return bake(g);
  }

  /** The main line running on past both ends of the map. */
  private mainLine(): Object3D {
    const g = new Group();
    const x = railColumn(this.map);
    if (x < 0) return g;
    const sleepers = new InstancedMesh(unitBox, mat(C.woodDark), MARGIN * 3 * 2);
    const m = new Matrix4();
    let n = 0;
    for (const [from, y] of [
      [-MARGIN, 0],
      [this.map.h, this.map.h - 1],
    ] as const) {
      const top = landTop(this.map.terrain[this.map.idx(x, y)]);
      g.add(box(0.64, 0.05, MARGIN, BALLAST, x + 0.5, top, from + MARGIN / 2));
      for (const o of [0.35, 0.65])
        g.add(box(0.03, 0.03, MARGIN, STEEL, x + o, top + 0.075, from + MARGIN / 2));
      for (let k = 0; k < MARGIN * 3; k++) {
        m.makeScale(0.54, 0.025, 0.11).setPosition(x + 0.5, top + 0.0625, from + (k + 0.5) / 3);
        sleepers.setMatrixAt(n++, m);
      }
    }
    sleepers.receiveShadow = true;
    g.add(sleepers);
    return g;
  }
}

/**
 * Which container goes in which slot of a stack or yard, given the slots
 * as they were and the containers there now (`looks`, in any order): each
 * stays in its slot, one gone makes room for the last, which moves into
 * its slot, and one come goes on the end. So taking one never changes the
 * colour of more than one slot, and the stack never has a gap in it.
 */
export function settle(order: number[], looks: number[]): number[] {
  const want = new Map<number, number>();
  for (const l of looks) want.set(l, (want.get(l) ?? 0) + 1);
  const kept = new Map<number, number>();
  const slots: (number | null)[] = order.map((l) => {
    const n = kept.get(l) ?? 0;
    if (n >= (want.get(l) ?? 0)) return null;
    kept.set(l, n + 1);
    return l;
  });
  for (let i = 0; i < slots.length; i++) {
    if (slots[i] !== null) continue;
    while (slots.length > i && slots[slots.length - 1] === null) slots.pop();
    if (slots.length > i + 1) slots[i] = slots.pop()!;
  }
  for (const l of looks) {
    const n = kept.get(l) ?? 0;
    if (n >= (want.get(l) ?? 0)) continue;
    kept.set(l, n + 1);
    slots.push(l);
  }
  return slots as number[];
}

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** Buildings drawn facing +z and then turned the way they were placed. */
const FACES = new Set<number>([
  Build.Gate,
  Build.Gantry,
  Build.TruckBay,
  Build.LargeBay,
  Build.Depot,
  Build.Office,
  Build.BreakHut,
]);

/** Turn a tile's model about the tile centre so its front faces `orient`. */
function turn(obj: Object3D, orient: number): Object3D {
  const [dx, dy] = FACING[orient & 3];
  const pivot = new Group();
  pivot.position.set(0.5, 0, 0.5);
  pivot.rotation.y = Math.atan2(dx, dy);
  obj.position.set(-0.5, 0, -0.5);
  pivot.add(obj);
  const outer = new Group();
  outer.add(pivot);
  return outer;
}
