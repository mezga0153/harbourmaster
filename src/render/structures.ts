import {
  ConeGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  type Object3D,
  TorusGeometry,
  Vector3,
} from 'three';
import type { BayView, CraneView, HandAt, PileView, TileChange } from '../protocol';
import type { Cargo } from '../sim/cargo';
import type { GameMap } from '../sim/map';
import {
  EXTENSION,
  FACING,
  gantryYard,
  liftMarks,
  machinesOnly,
  ON_QUAY,
  parkingLots,
  type ParkingFlow,
} from '../sim/rules';
import { DEPOT_BACK } from '../sim/machines';
import { hash01 } from '../sim/noise';
import { crossingClosed, railColumn, type Train } from '../sim/railway';
import {
  GATE_IN,
  GATE_OUT,
  greenAt,
  hasHighway,
  hasLights,
  HIGHWAY_COLUMNS,
  isExit,
  oneWay,
} from '../sim/roads';
import { TOWN } from '../sim/town';
import {
  Build,
  isDock,
  isPublicRoad,
  isTownBuilding,
  storesBoxes,
  storesOutgoing,
  TICKS_PER_SECOND,
} from '../sim/types';
import {
  BOXES_PER_STORE_TILE,
  CRATES_PER_STORE_TILE,
  FORKLIFT_CAPACITY as PALLET,
  CRANE_LIFT_SET,
  CRANE_LIFT_TAKEN,
  CRANE_TICKS,
  GANTRY_RAILS,
  GANTRY_STACK,
  GANTRY_TICKS,
  HARBOUR_CRANE_TICKS,
  YARD_GANTRY_TICKS,
} from '../sim/balance';
import { BOX_HEIGHT } from './assets';
import {
  container,
  crate,
  paintCargo,
  paintContainer,
  PALLET_CRATE,
  setCrateIcon,
  setCrateSeal,
} from './models';
import { C } from './palette';
import { box, cyl, mat } from './parts';
import { bake, pavements, townBuilding } from './town';
import { clamp01, headingOf, lerpAngle, syncPhase, turnOf, wrapAngle } from './util/math';
import { unitBox } from './util/mesh';

const LIGHT = 0xfff2b0;
const BALLAST = 0x9b9284;
const STEEL = 0x8d939b;
const LAMP_RED = 0xff3b2f;
const LAMP_GREEN = 0x3dff6e;
/** The highway's crash barrier down the middle. */
const BARRIER = 0xc9ccd0;
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

/** Where a jib crane's jib is pivoted on its cab, and how long each of its three sections is. */
const JIB_FOOT_X = 0.1;
const JIB_FOOT_Y = 0.12;
const JIB_SECTION = 1.1;
/** How steeply a jib crane's jib stands when it can, running out further to reach further. */
const JIB_LUFF = 0.55;
/** As far through a lift as a jib crane goes before the game starts the next. */
const JIB_END = 0.999;

/** Where a crate lies from a jib crane; see jibAt. */
interface JibEnd {
  angle: number;
  out: number;
  y: number;
  size: number;
  yaw: number;
}

/** As lerpAngle, for something square: the least way round to lie square with `to`. */
function squareTurn(from: number, to: number, t: number): number {
  const q = Math.PI / 2;
  const d = ((((to - from) % q) + q * 1.5) % q) - q / 2;
  return from + d * t;
}

/** A pallet board under a crate of `size`, as a coaster's crates are. */
function palletUnder(c: Object3D, size: number): Object3D {
  const p = box(size * 1.1, size * 0.14, size * 1.1, C.wood, 0, -size * 0.14);
  c.add(p);
  return p;
}

/** How many tiles a yard gantry's rails run either way along its yard, at most. */
const GANTRY_RUN = 12;
/** A yard gantry's lift with no running along its rails; see liftMarks. */
const NO_RUN = [0, 0.5, 0, 0.5];
/**
 * A mobile harbour crane: how high its slewing deck stands on the tower,
 * where the boom's foot is on the deck (out along +x of it, and up), how
 * long the boom is and how far it luffs, down and up.
 */
const HARBOUR_TOWER = 1.62;
const BOOM_FOOT = { x: 0.02, y: 0.3 };
/** A depot's walls, inside up to its roof: clear of a forklift's mast. */
const DEPOT_HEIGHT = 0.56;
const BOOM_LENGTH = 2.5;
const LUFF_LOW = 0.12;
const LUFF_HIGH = 1.48;
/** How deep a harbour crane's spreader is, under the hook. */
const SPREADER = 0.035;
/**
 * How high above the quay a harbour crane carries its hook between lifts:
 * a container on it clears four tiers on a feeder's deck and passes under
 * the slewing deck.
 */
const HOOK_UP = 1.42;
import { DECK_Y, MARGIN, QUAY_Y, SEABED, landTop } from './terrain';

/** The pointed top of a green buoy. */
const coneGeo = new ConeGeometry(0.08, 0.14, 8);
coneGeo.translate(0, 0.07, 0);
const lifebuoyGeo = new TorusGeometry(0.05, 0.017, 6, 12);
const roofGeo = new ConeGeometry(0.56, 0.26, 4);
roofGeo.rotateY(Math.PI / 4);
roofGeo.scale(1.05, 1, 0.8);
roofGeo.translate(0, 0.13, 0);

interface BayStack {
  crates: Object3D[];
  boxes: Object3D[];
  /** Crate storage: the pallets' places, each holding the next four of `crates`. */
  places?: Object3D[];
}

interface GateParts {
  /** The barrier arm, pivoting up about its post. */
  boom: Object3D;
  open: boolean;
  angle: number;
}

/** A junction's traffic lights: the red and green lamps facing each way. */
interface LightParts {
  ns: { red: Object3D; green: Object3D }[];
  ew: { red: Object3D; green: Object3D }[];
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
  /** Its yard, by first tile, and how many like the one it moves were there as the lift began. */
  yard?: number;
  base: number;
  /** How many containers the truck or tractor it works showed as the lift began. */
  held: number;
  slot: number;
  work: 'load' | 'unload' | null;
  look: number;
  /** How far through a lift, 0 to 1. */
  phase: number;
  /**
   * The lift's legs, as shares of it (see liftMarks), how many ticks it
   * takes, and where the carriage and trolley were as it began: it runs
   * along its rails from there.
   */
  legs: number[];
  ticks: number;
  startX: number;
  startZ: number;
  /** How far along its rails it can run, either way, as laid out along its yard. */
  railFrom: number;
  railTo: number;
  /** The tile of the yard it works beside it (see gantryYard), or -1. */
  works: number;
  /** The tick the game began the lift it is at; see YardView.workStart. */
  liftStart?: number;
  /**
   * Where over the truck or tractor it took the container off it was, in
   * the frame: once it has it, that one may drive off, and it carries on
   * from there rather than follow it.
   */
  offAt?: { x: number; z: number; drop: number };
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
  /** A jib crane: its jib, and the lift it is at; see runJib. */
  jib?: JibParts;
  /** A mobile harbour crane: its boom, and the lift it is at; see runHarbourCrane. */
  mhc?: HarbourCraneParts;
}

interface JibParts {
  /** The jib, luffing about its foot on the cab, and the sections that run out of it. */
  luff: Object3D;
  mid: Object3D;
  end: Object3D;
  /** Where the cable hangs from, at the end of the jib. */
  tip: Object3D;
  /** The crate on the hook, of unit size scaled to the one it moves, and its pallet. */
  load: Object3D;
  pallet: Object3D;
  /** How far out from the pedestal the hook hangs. */
  out: number;
  work: 'load' | 'unload' | null;
  /** The boat and the slot on its deck the crate comes off or goes into. */
  boat: number;
  slot: number;
  /** Crate storage (by first tile) or a pile on the quay (by tile), else its landing stack. */
  store?: number;
  pile?: number;
  /** The crate's place there. */
  place: number;
  carriesPallet: boolean;
  /** How far through a lift, 0 to 1, kept in step with the game. */
  phase: number;
  /** What the lift is of, to take it up where the game has it when that changes. */
  key: string;
  /** Which way the jib was pointing, and how far out, as the lift began. */
  start: { angle: number; out: number };
}

/** A container set down on or lifted off a crane's stack that the game has not caught up with yet. */
interface StackChange {
  look: number;
  /** The place on the stack, where the game keeps them in places. */
  place?: number;
  /** How many like it were on the stack as the lift began. */
  base: number;
  /** How long ago, in game seconds, so it is let go of if the game never does. */
  age: number;
}

interface HarbourCraneParts {
  /** Its tile, which its stack's slots are kept under (as -1 - idx). */
  idx: number;
  /** The tile's model, which slots on the ship are brought into. */
  frame: Object3D;
  /** Luffed up and down about its foot, along +x of the slewing deck. */
  boom: Object3D;
  /** The boom's head, which the rope hangs from; it stays level as the boom luffs. */
  head: Object3D;
  /** The luffing ram from the deck up to the underside of the boom. */
  ram: Object3D;
  /** The spreader, turning under the hook, and the container on it while it carries one. */
  spreader: Object3D;
  load: Object3D;
  /** How far out from the tower the hook is, and how high, in the frame. */
  radius: number;
  height: number;
  /** How far the spreader is turned under the boom. */
  twist: number;
  /**
   * Which way round it slews from the ship to the stack (1 or -1), and back
   * the other way, kept from one lift to the next unless the other way is
   * clearly shorter, so it never goes the whole way round.
   */
  way: number;
  /**
   * Where the hook was as the lift began, and how far the spreader is
   * turned under the boom picking up and setting down, chosen then so it
   * does not change its mind as the ship rolls.
   */
  choice: { angle: number; radius: number; twist: number; from: number; to: number } | null;
  /** Off the ship or onto it, or a container onto a tractor beside it or off one. */
  work: 'load' | 'unload' | 'give' | 'take' | null;
  /** The tractor it lifts onto or off, or sets one straight on off the ship; -1 if none. */
  truck: number;
  /** The place on its stack the container it moves is in or goes, as the game has it. */
  place?: number;
  boat: number;
  slot: number;
  look: number;
  /** How far through a lift, 0 to 1, kept in step with the game. */
  phase: number;
  /** How far through the lift it was as last drawn. */
  drawn: number;
  /** Waiting on the ship's deck for the game to hand a container over. */
  held: boolean;
  /** Containers on its stack, and exports, for where the next goes. */
  stacked: number;
  /** How many like the one it moves were on its stack as the lift began. */
  base: number;
  /** The slot on its stack it sets the container it moves down in, or lifts it from. */
  pick: number;
  /**
   * An import set down on the stack, shown there from when it is let go
   * until the game has it there too; and an export lifted off it, gone
   * from when it is taken until the game has taken it away.
   */
  landing: StackChange | null;
  leaving: StackChange | null;
}

interface ShipGantryParts {
  /** Its main tile, which its stack's slots are kept under (as -1 - idx). */
  idx: number;
  /** Laid out as built: x along the quay edge, the water off +z. */
  frame: Object3D;
  /** Legs, portal, boom and trolley, running along x on the rails. */
  carriage: Object3D;
  /** How far along x the carriage can run either way, on the rails. */
  from: number;
  to: number;
  /** The container on the spreader, shown while it carries one. */
  load: Object3D;
  /** Off the ship or onto it, or a container onto a tractor under it or off one. */
  work: 'load' | 'unload' | 'give' | 'take' | null;
  boat: number;
  slot: number;
  /** The tractor it is lifting a container onto or off, or setting one straight on off the ship. */
  truck: number;
  /** The place on its stack the container it moves is in, or goes. */
  place?: number;
  look: number;
  /** Waiting on the game to hand a container over, not to be brought into step meanwhile. */
  holding?: boolean;
  /** How far through a lift, 0 to 1, kept in step with the game. */
  phase: number;
  /** Containers on the stack between its legs, and exports, for where the next goes. */
  stacked: number;
  /** How many like the one it moves were on its stack as the lift began. */
  base: number;
  /**
   * Where over the tractor it took a container off it was, in the frame:
   * once it has it, the tractor may drive off, and it carries on from there.
   */
  offAt?: { x: number; z: number; drop: number };
}

/** Roads, paths, jetties and truck bays, rebuilt per tile when they change. */
export class Structures {
  readonly group = new Group();
  private tiles = new Map<number, Object3D>();
  private stacks = new Map<number, BayStack>();
  /** Gantry cranes' stacks: each container's look and place, as the game has them. */
  private cranePlaces = new Map<number, { looks: number[]; places: number[] }>();
  /** Which container is in which slot, by yard (its first tile) or crane; see settle. */
  private slots = new Map<number, number[]>();
  /** Each container yard's tiles, by its first. */
  private yardTiles = new Map<number, number[]>();
  private cranes = new Map<number, CraneParts>();
  private gates = new Map<number, GateParts>();
  /** Buoys, bobbing on the swell. */
  private buoys = new Map<number, Object3D>();
  private crossings = new Map<number, CrossingParts>();
  private lights = new Map<number, LightParts>();
  /** The game's tick, for the traffic lights' phases. */
  private tick = 0;
  /** Yard gantries, by tile, for their trolley to run as they load trucks. */
  private yardGantries = new Map<number, YardGantryParts>();
  /** Where a truck's container slot is in the world; set by the renderer. */
  truckSlot?: (id: number, k: number, out: Vector3) => Vector3 | null;
  /** Whether a truck's, tractor's or ship's container slot `k` shows a container. */
  slotShown?: (id: number, k: number) => boolean;
  /** The crate or container in slot `k` of a boat or vehicle, shown or not. */
  slotObject?: (id: number, k: number) => Object3D | undefined;
  /** The tiles of each crate storage area, by its first, for where a jib crane sets crates. */
  private areas = new Map<number, number[]>();
  /** Which way a ship's container slot lies in the world, for a harbour crane's spreader. */
  slotTurn?: (id: number, k: number) => number | null;
  private slotAt = new Vector3();
  private countAt = new Vector3();
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
    if (!bare) this.group.add(this.highwayEnds(), this.mainLine(), this.boundary());
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
  private lots: Map<
    number,
    { inside: boolean; acrossX: boolean; wide: boolean; flow?: ParkingFlow | null }
  > | null = null;

  private lotAt(i: number): {
    inside: boolean;
    acrossX: boolean;
    wide: boolean;
    flow?: ParkingFlow | null;
  } {
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
        const flow = lot.flow;
        for (const t of lot.tiles) this.lots.set(t, { inside, acrossX, wide, flow });
      }
    }
    return this.lots.get(i) ?? { inside: false, acrossX: false, wide: false };
  }

  setCranes(views: CraneView[]): void {
    for (const v of views) {
      const c = this.cranes.get(v.idx);
      if (!c) continue;
      // Exports set down for a container crane wait on its stack too: on a
      // gantry crane's each in the place the game has it.
      if (v.places && v.looks) {
        const at = new Map<number, number>();
        v.places.forEach((k, j) => at.set(k, v.looks![j]));
        c.stack.forEach((o, k) => {
          const look = at.get(k);
          o.visible = look !== undefined;
          if (look !== undefined) paintContainer(o, look);
        });
        this.slots.set(-1 - v.idx, [...v.looks]);
        this.cranePlaces.set(v.idx, { looks: v.looks, places: v.places });
      } else {
        const order = v.looks ? this.settled(-1 - v.idx, v.looks) : undefined;
        c.stack.forEach((o, k) => {
          o.visible = k < v.stack + v.out;
          if (order && k < order.length) paintContainer(o, order[k]);
        });
      }
      c.busy = v.busy;
      if (v.busy) c.target = -v.angle;
      if (c.jib) {
        this.setJib(c, c.jib, v);
        continue;
      }
      const g = c.sts ?? c.mhc;
      if (!g) continue;
      g.stacked = v.stack + v.out;
      g.work = v.working ?? null;
      g.truck = v.workTruck ?? -1;
      g.place = v.workPlace;
      if (v.workBoat !== undefined) g.boat = v.workBoat;
      if (v.workSlot !== undefined) g.slot = v.workSlot;
      if (v.workLook !== undefined && v.workLook !== g.look) {
        g.look = v.workLook;
        g.base = this.kept(-1 - v.idx, g.look);
      }
      // Kept in step with the game, without jumping for a small difference,
      // nor while a harbour crane waits on the game to hand a container over.
      // A gantry waiting on a hand-over is let go once the game is on to its next lift.
      const waits = c.sts?.holding && v.workPhase !== undefined && v.workPhase >= CRANE_LIFT_TAKEN;
      if (v.workPhase !== undefined && !c.mhc?.held && !waits) {
        g.phase = syncPhase(g.phase, v.workPhase, { wrap: true });
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

  /** The game's tick, which the traffic lights change by as they do in the game. */
  setTick(tick: number): void {
    this.tick = tick;
  }

  /** Per-frame animation: slew cranes towards their boats, bob the hooks, lift barriers. */
  update(dt: number, time: number): void {
    for (const [i, l] of this.lights) {
      const green = greenAt(i, this.tick);
      for (const way of ['ns', 'ew'] as const) {
        for (const lamp of l[way]) {
          lamp.green.visible = green === way;
          lamp.red.visible = green !== way;
        }
      }
    }
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
      if (c.jib) {
        this.runJib(c, c.jib, dt);
        continue;
      }
      if (c.mhc) {
        this.runHarbourCrane(c, c.mhc, dt);
        continue;
      }
      if (c.fixed) {
        // Out over the ship and back in over the bay between the legs.
        const out = c.busy ? 0.5 + 0.5 * Math.sin(time * 1.1) : 1;
        c.slew.position.z += (-0.5 + out * 2.7 - c.slew.position.z) * Math.min(1, dt * 4);
      } else {
        c.angle = lerpAngle(c.angle, c.target, Math.min(1, dt * 3));
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
    const was = g.phase;
    g.phase = g.work ? (g.phase + (dt * this.speed) / cycle) % 1 : 0;
    if (g.phase < was || !g.work) g.base = this.kept(-1 - g.idx, g.look);
    const trolley = c.slew;
    let x = g.carriage.position.x;
    let z = -0.3;
    let drop = c.rest;
    let carry = false;
    // Its other end: a slot on the ship's deck, or on a tractor under it.
    const tractor = g.work === 'give' || g.work === 'take';
    // Off the ship straight onto a tractor under it, or off one straight
    // on board, rather than by way of its stack.
    const direct = (g.work === 'unload' || g.work === 'load') && g.truck >= 0;
    const ship = !g.work
      ? null
      : tractor
        ? this.truckSlot?.(g.truck, 0, this.slotAt)
        : this.truckSlot?.(g.boat, g.slot, this.slotAt);
    const onto = direct ? this.truckSlot?.(g.truck, 0, new Vector3()) : null;
    if (g.work && ship) {
      g.frame.updateWorldMatrix(true, false);
      g.frame.worldToLocal(ship);
      const deck = {
        x: ship.x,
        z: ship.z,
        drop: trolley.position.y - (ship.y + BOX_HEIGHT + 0.04),
      };
      // The next free place on the stack, the export on top of it, or the
      // container it gives a tractor.
      const order = this.slots.get(-1 - g.idx) ?? [];
      const k =
        g.place !== undefined && g.place >= 0
          ? g.place
          : g.work === 'give'
            ? Math.max(0, order.indexOf(g.look))
            : Math.max(0, Math.min(c.stack.length - 1, g.stacked - (g.work === 'load' ? 1 : 0)));
      const slot = c.stack[Math.min(c.stack.length - 1, k)];
      if (onto) g.frame.worldToLocal(onto);
      const pile = onto
        ? { x: onto.x, z: onto.z, drop: trolley.position.y - (onto.y + BOX_HEIGHT + 0.04) }
        : {
            x: slot.position.x,
            z: slot.position.z,
            drop: trolley.position.y - (slot.position.y + BOX_HEIGHT + 0.04),
          };
      let [from, to] = g.work === 'unload' || g.work === 'take' ? [deck, pile] : [pile, deck];
      // Taken off a tractor, it goes on from where it took it, whether the
      // tractor stays or drives off.
      const offTractor = g.work === 'take' || (g.work === 'load' && direct);
      if (offTractor && g.phase > CRANE_LIFT_TAKEN && g.offAt) from = g.offAt;
      else if (offTractor) g.offAt = { ...from };
      else g.offAt = undefined;
      const ease = (t: number) => t * t * (3 - 2 * t);
      const dip = (t: number, depth: number) => c.rest + (depth - c.rest) * Math.sin(t * Math.PI);
      const take = CRANE_LIFT_TAKEN;
      const set = CRANE_LIFT_SET;
      // Over to the container, down and up with it at `take`, across to
      // where it goes, down and up again having let go at `set`.
      const a = take - 0.15;
      const b = take + 0.15;
      const d = set - 0.15;
      // Handed over, it is on the spreader from when it leaves the ship's
      // deck or the stack until it shows where it is set down, never on
      // neither.
      const onDeck = () =>
        tractor ? !!this.slotShown?.(g.truck, 0) : !!this.slotShown?.(g.boat, g.slot);
      // Where it is set down: the tractor, for one straight off the ship.
      const onStack = () =>
        direct
          ? this.slotShown?.(g.truck, 0)
            ? g.base + 1
            : g.base
          : this.kept(-1 - g.idx, g.look);
      const onTruck = () => !!this.slotShown?.(g.truck, 0);
      const [gone, there] = direct
        ? g.work === 'unload'
          ? [() => !onDeck(), onTruck]
          : [() => !onTruck(), onDeck]
        : g.work === 'unload' || g.work === 'take'
          ? [() => !onDeck(), () => onStack() > g.base]
          : [() => onStack() < g.base, onDeck];
      // Nor does it lift one while it still shows where it was, or come up
      // again before it shows where it is set down: ahead of the game, the
      // spreader waits down on it.
      g.holding = false;
      if (was <= take && g.phase > take && !gone()) [g.phase, g.holding] = [take, true];
      if (was <= set && g.phase > set && !there()) [g.phase, g.holding] = [set, true];
      const p = g.phase;
      if (p < a) {
        const t = ease(p / a);
        x = g.carriage.position.x + (from.x - g.carriage.position.x) * t;
        z = trolley.position.z + (from.z - trolley.position.z) * t;
      } else if (p < b) {
        x = from.x;
        z = from.z;
        drop = dip((p - a) / (b - a), from.drop);
        // Only once it has left where it was: never on both at once.
        carry = gone();
      } else if (p < d) {
        const t = ease((p - b) / (d - b));
        x = from.x + (to.x - from.x) * t;
        z = from.z + (to.z - from.z) * t;
        carry = true;
      } else {
        x = to.x;
        z = to.z;
        drop = dip((p - d) / (1 - d), to.drop);
        carry = p < set || !there();
      }
    }
    x = Math.max(g.from, Math.min(g.to, x));
    const follow = this.follow(dt);
    g.carriage.position.x += (x - g.carriage.position.x) * follow;
    // The trolley's along the boom from the carriage.
    trolley.position.z += (z - trolley.position.z) * follow;
    trolley.position.x = 0;
    c.rope.scale.y = drop;
    c.rope.position.y = -drop / 2;
    c.hook.position.y = -drop;
    g.load.visible = carry;
    if (carry) paintContainer(g.load, g.look);
  }

  /** A jib crane's lift and landing stack as the game has them. */
  private setJib(c: CraneParts, j: JibParts, v: CraneView): void {
    // Pallets lift the stack by their thickness.
    const lift = v.pallets ? 0.15 * 0.14 : 0;
    c.stack.forEach((o, k) => {
      o.children[2].visible = !!v.pallets;
      o.position.y = QUAY_Y + lift + (k < 5 ? 0 : 0.15 + lift);
    });
    j.work = v.working === 'load' || v.working === 'unload' ? v.working : null;
    j.boat = v.workBoat ?? -1;
    j.slot = v.workSlot ?? 0;
    j.store = v.workStore;
    j.pile = v.workPile;
    j.place = v.workPlace ?? 0;
    j.carriesPallet = !!v.workPallet;
    // A new lift is taken up where the game has it, swinging round from
    // where the jib is; the same one is kept in step without jumping for a
    // small difference.
    const key = [v.working, v.workBoat, v.workSlot, v.workStore, v.workPile, v.workPlace].join();
    if (key !== j.key) j.start = { angle: c.angle, out: j.out };
    if (v.workPhase !== undefined) {
      j.phase = key !== j.key ? v.workPhase : syncPhase(j.phase, v.workPhase, { most: JIB_END });
    }
    j.key = key;
  }

  /**
   * Run a jib crane's jib out or in, luffing it up or down, so its hook
   * hangs `out` from the pedestal: standing at JIB_LUFF while it can, and
   * steeper close in once it has run all the way in.
   */
  private reachOut(j: JibParts, out: number): void {
    const r = Math.max(0, out - JIB_FOOT_X);
    const len = Math.max(JIB_SECTION, Math.min(3 * JIB_SECTION - 0.2, r / Math.cos(JIB_LUFF)));
    const up = Math.acos(Math.max(Math.cos(1.45), Math.min(1, r / len)));
    j.luff.rotation.z = up;
    j.end.position.x = len - JIB_SECTION / 2;
    j.mid.position.x = Math.max(JIB_SECTION, (len + JIB_SECTION) / 2 + 0.05) - JIB_SECTION / 2;
    j.tip.position.set(JIB_FOOT_X + len * Math.cos(up), JIB_FOOT_Y + len * Math.sin(up) - 0.03, 0);
    j.out = out;
  }

  /** The crate in the place a jib crane sets a crate into or takes one from, off the boat. */
  private jibPlace(c: CraneParts, j: JibParts): Object3D | undefined {
    if (j.pile !== undefined) return this.piles.get(j.pile)?.crates[j.place];
    if (j.store === undefined) return c.stack[j.place];
    let k = j.place;
    for (const t of this.areas.get(j.store) ?? []) {
      const items = this.stacks.get(t)?.crates ?? [];
      if (k < items.length) return items[k];
      k -= items.length;
    }
    return undefined;
  }

  /**
   * Where a crate lies for a jib crane to lift, from its pedestal: which
   * way and how far, how high its foot is, how big it is and which way it
   * is turned.
   */
  private jibAt(c: CraneParts, o: Object3D): JibEnd {
    const frame = c.slew.parent!;
    const at = frame.worldToLocal(o.getWorldPosition(new Vector3()));
    const ax = frame.worldToLocal(o.localToWorld(new Vector3(1, 0, 0))).sub(at);
    const dx = at.x - c.slew.position.x;
    const dz = at.z - c.slew.position.z;
    return {
      angle: Math.atan2(-dz, dx),
      out: Math.hypot(dx, dz),
      y: at.y - c.slew.position.y,
      size: ax.length() * (o.children[0]?.scale.x ?? 0.2),
      yaw: Math.atan2(-ax.z, ax.x),
    };
  }

  /**
   * A jib crane at work slews round to the crate on the boat's deck, runs
   * its jib out or in over it, lowers the hook onto it and lifts it, then
   * slews round to its landing stack or the crate storage in reach and
   * lowers it there; loading, from storage or the quay onto the boat. Idle,
   * it waits where it last worked with the hook up.
   */
  private runJib(c: CraneParts, j: JibParts, dt: number): void {
    const cycle = CRANE_TICKS / TICKS_PER_SECOND;
    // A lift ends when the game has the crate where it was set down, so the
    // next starts: it waits at the end of this one until then.
    j.phase = j.work ? Math.min(JIB_END, j.phase + (dt * this.speed) / cycle) : 0;
    const deck = j.work ? this.slotObject?.(j.boat, j.slot) : undefined;
    const yard = j.work ? this.jibPlace(c, j) : undefined;
    let angle = c.busy ? c.target : c.angle;
    let out = j.out;
    let carry = false;
    let size = j.load.scale.x;
    let yaw = c.angle + j.load.rotation.y;
    // How far down the hook goes, onto the top of a crate, and how far there it is.
    let lower: { at: JibEnd; t: number } | null = null;
    if (deck && yard) {
      const [src, dst] = j.work === 'unload' ? [deck, yard] : [yard, deck];
      const from = this.jibAt(c, src);
      const to = this.jibAt(c, dst);
      const p = j.phase;
      const ease = (t: number) => t * t * (3 - 2 * t);
      const take = CRANE_LIFT_TAKEN;
      const set = CRANE_LIFT_SET;
      // Round to the crate, down and up with it at `take`, round to where
      // it goes, down and up again having let go at `set`.
      const a = take - 0.15;
      const b = take + 0.15;
      const d = set - 0.15;
      // Handed over, it is on the hook from when it leaves where it was
      // until it shows where it is set down, never on neither. The game
      // moves it at the end of the lift, and its view a tick or so after
      // the hook takes it or lets go: here it goes as the hook does.
      if (p >= take) src.visible = false;
      if (p >= set) dst.visible = true;
      if (p < a) {
        const t = ease(p / a);
        angle = lerpAngle(j.start.angle, from.angle, t);
        out = j.start.out + (from.out - j.start.out) * t;
      } else if (p < b) {
        angle = from.angle;
        out = from.out;
        lower = { at: from, t: (p - a) / (b - a) };
        carry = p >= take || !src.visible;
        size = from.size;
        yaw = from.yaw;
      } else if (p < d) {
        const t = ease((p - b) / (d - b));
        angle = lerpAngle(from.angle, to.angle, t);
        out = from.out + (to.out - from.out) * t;
        carry = true;
        size = from.size + (to.size - from.size) * t;
        yaw = squareTurn(from.yaw, to.yaw, t);
      } else {
        angle = to.angle;
        out = to.out;
        lower = { at: to, t: (p - d) / (1 - d) };
        carry = p < set;
        size = to.size;
        yaw = squareTurn(from.yaw, to.yaw, 1);
      }
    }
    const follow = this.follow(dt);
    c.angle = lerpAngle(c.angle, angle, follow);
    c.slew.rotation.y = c.angle;
    this.reachOut(j, j.out + (out - j.out) * follow);
    // The hook comes down onto the top of the crate, which hangs below it.
    const depth = lower ? j.tip.position.y - (lower.at.y + lower.at.size + 0.05) : c.rest;
    const drop = lower ? c.rest + (depth - c.rest) * Math.sin(lower.t * Math.PI) : c.rest;
    c.rope.scale.y = drop;
    c.rope.position.y = -drop / 2;
    c.hook.position.y = -drop;
    j.load.visible = carry;
    j.load.scale.setScalar(size);
    j.load.position.y = -0.05 - size;
    j.load.rotation.y = yaw - c.angle;
    j.pallet.visible = j.carriesPallet;
  }

  /**
   * A mobile harbour crane at work slews and luffs its boom to bring the
   * hook straight over the container it is lifting, lowers the spreader
   * onto it, lifts it, slews round over its landing stack and sets it down
   * in the next place there; loading, from the export on the stack out to
   * its slot on the ship. The hook keeps its height as the boom luffs, and
   * the spreader turns to lie along the container. Idle, it waits where it
   * is with the hook up.
   */
  private runHarbourCrane(c: CraneParts, h: HarbourCraneParts, dt: number): void {
    const cycle = HARBOUR_CRANE_TICKS / TICKS_PER_SECOND;
    const was = h.drawn;
    // Stopping for a frame where it takes hold of a container or lets go
    // of one, so it is right on it then however fast the game is going,
    // even when it has just been brought into step with the game.
    let next = h.held ? h.phase : h.phase + (dt * this.speed) / cycle;
    h.held = false;
    for (const at of [CRANE_LIFT_TAKEN, CRANE_LIFT_SET]) if (was < at && next > at) next = at;
    h.phase = h.work ? next % 1 : 0;
    if (h.phase < was || !h.work) {
      h.base = this.kept(-1 - h.idx, h.look);
      h.choice = null;
    }
    const order = this.slots.get(-1 - h.idx) ?? [];
    const kept = (look: number) => this.kept(-1 - h.idx, look);
    // Shown set down or lifted until the game has it so too.
    for (const s of [h.landing, h.leaving]) if (s) s.age += dt * this.speed;
    if (h.landing && (kept(h.landing.look) > h.landing.base || h.landing.age > cycle)) {
      h.landing = null;
    }
    if (h.leaving && (kept(h.leaving.look) < h.leaving.base || h.leaving.age > cycle)) {
      h.leaving = null;
    }
    const up = QUAY_Y + HOOK_UP;
    let angle = c.angle;
    let radius = h.radius;
    let height = up;
    let twist = h.twist;
    let carry = false;
    // Its stack as the game has it, each container in its place: it then
    // shows them set down and taken itself.
    const placed = this.cranePlaces.has(h.idx);
    // Its other end: a slot on the ship's deck, or a tractor beside it.
    const tractor = h.work === 'give' || h.work === 'take';
    const direct = (h.work === 'unload' || h.work === 'load') && h.truck >= 0;
    const [far, at] = tractor ? [h.truck, 0] : [h.boat, h.slot];
    const ship = h.work ? this.truckSlot?.(far, at, this.slotAt) : null;
    if (h.work && ship) {
      const frame = turnOf(h.frame);
      const lie = (this.slotTurn?.(far, at) ?? frame) - frame;
      const deck = this.hookOver(c, h.frame.worldToLocal(ship), lie);
      // The next free place on the stack, past one just set down there, or
      // wherever the container it moves is on it.
      const there = order.lastIndexOf(h.look);
      if (h.work === 'unload') {
        h.pick =
          h.landing?.look === h.look
            ? h.stacked
            : there >= 0
              ? there
              : h.stacked + (h.landing ? 1 : 0);
      } else if (there >= 0) h.pick = there;
      if (placed && h.place !== undefined && h.place >= 0) h.pick = h.place;
      const slot = c.stack[Math.max(0, Math.min(c.stack.length - 1, h.pick))];
      const onto = direct ? this.truckSlot?.(h.truck, 0, new Vector3()) : null;
      const pile = onto
        ? this.hookOver(
            c,
            h.frame.worldToLocal(onto),
            (this.slotTurn?.(h.truck, 0) ?? turnOf(h.frame)) - turnOf(h.frame),
          )
        : this.hookOver(c, slot.position, slot.rotation.y);
      const inward = h.work === 'unload' || h.work === 'take';
      const [from, to] = inward ? [deck, pile] : [pile, deck];
      if (!h.choice) {
        const round = swing(deck.angle, pile.angle);
        if (!h.way || Math.abs(round) < Math.PI * 0.8) h.way = Math.sign(round) || 1;
        // A container lies the same either way round: the spreader turns
        // the least it can, and swings round with the boom between.
        const head = alike(from.turn - from.angle, h.twist);
        h.choice = {
          angle: c.angle,
          radius: h.radius,
          twist: h.twist,
          from: head,
          to: alike(to.turn - to.angle, head),
        };
      }
      // Out from the ship to the stack one way round, and back the other.
      const way = inward ? h.way : -h.way;
      const lift = { ...from, twist: alike(from.turn - from.angle, h.choice.from) };
      const land = { ...to, twist: alike(to.turn - to.angle, h.choice.to) };
      // High enough to clear what it passes over, carrying a container.
      const high = Math.max(up, from.height + 0.15, to.height + 0.15);
      // The ship's deck, or a tractor beside it; and a tractor it sets one
      // straight onto off the ship.
      const onDeck = () => !!this.slotShown?.(far, at);
      const onTractor = () => !!this.slotShown?.(h.truck, 0);
      // On the ship's deck or a tractor it waits for the game to hand the
      // container over, a moment at most, before it lifts it or lets go.
      if (inward && h.phase >= CRANE_LIFT_TAKEN && h.phase < CRANE_LIFT_SET) {
        if (onDeck()) [h.phase, h.held] = [CRANE_LIFT_TAKEN, true];
      }
      if (h.phase >= CRANE_LIFT_SET && (inward ? direct && !onTractor() : !onDeck())) {
        [h.phase, h.held] = [CRANE_LIFT_SET, true];
      }
      const p = h.phase;
      const ease = (t: number) => t * t * (3 - 2 * t);
      const dip = (t: number, depth: number) => high + (depth - high) * Math.sin(t * Math.PI);
      const take = CRANE_LIFT_TAKEN;
      const set = CRANE_LIFT_SET;
      // Over to the container, down and up with it at `take`, round to
      // where it goes, down and up again having let go at `set`.
      const a = take - 0.15;
      const b = take + 0.15;
      const d = set - 0.15;
      // Handed over, it is on the spreader from when it leaves the ship's
      // deck until it is set down on the stack, or from when it is lifted
      // off the stack until it shows on the deck: never on neither, nor on
      // both. The stack shows it there from when it is let go, and gone
      // from when it is taken, without waiting for the game to catch up.
      if (p < a) {
        const t = ease(p / a);
        const was = h.choice;
        angle = was.angle + swing(was.angle, lift.angle, -way) * t;
        radius = was.radius + (lift.radius - was.radius) * t;
        twist = was.twist + (lift.twist - was.twist) * t;
      } else if (p < b) {
        ({ angle, radius, twist } = lift);
        height = dip((p - a) / (b - a), lift.height);
        carry = inward ? !onDeck() : p >= take;
      } else if (p < d) {
        const t = ease((p - b) / (d - b));
        angle = lift.angle + swing(lift.angle, land.angle, way) * t;
        radius = lift.radius + (land.radius - lift.radius) * t;
        twist = lift.twist + (land.twist - lift.twist) * t;
        height = high;
        carry = true;
      } else {
        ({ angle, radius, twist } = land);
        height = dip((p - d) / (1 - d), land.height);
        carry = inward ? (direct ? !onTractor() : p < set) : !onDeck();
      }
      if (!inward && p >= take && h.leaving?.look !== h.look) {
        if (there >= 0 && kept(h.look) >= h.base)
          h.leaving = { look: h.look, base: h.base, age: 0, place: h.pick };
      }
      if (inward && !direct && p >= set && h.landing?.look !== h.look) {
        if (placed ? kept(h.look) <= h.base : there < 0) {
          h.landing = { look: h.look, base: h.base, age: 0, place: h.pick };
        }
      }
    }
    const follow = this.follow(dt);
    c.angle += swing(c.angle, angle) * follow;
    h.radius += (radius - h.radius) * follow;
    h.height += (height - h.height) * follow;
    h.twist += (twist - h.twist) * follow;
    h.load.visible = carry;
    if (carry) paintContainer(h.load, h.look);
    h.drawn = h.phase;
    // The stack as the game has it, with what was just set down on it or
    // lifted off it; in places, as setCranes has drawn it, and those.
    if (placed) {
      const landing = h.landing && c.stack[h.landing.place ?? -1];
      if (h.landing && landing) {
        landing.visible = true;
        paintContainer(landing, h.landing.look);
      }
      const leaving = h.leaving && c.stack[h.leaving.place ?? -1];
      if (leaving) leaving.visible = false;
      this.poseHarbourCrane(c, h);
      return;
    }
    c.stack.forEach((o, k) => (o.visible = k < h.stacked));
    const landing = h.landing && c.stack[h.stacked];
    if (h.landing && landing) {
      landing.visible = true;
      paintContainer(landing, h.landing.look);
    }
    const leaving = h.leaving ? order.lastIndexOf(h.leaving.look) : -1;
    if (leaving >= 0 && leaving < c.stack.length) c.stack[leaving].visible = false;
    this.poseHarbourCrane(c, h);
  }

  /**
   * Where a harbour crane's hook is to be to lift or set down a container
   * at `at`, in its tile's model, lying turned `lie` about y: which way it
   * slews, how far out and how high the hook is, and which way the
   * spreader turns.
   */
  private hookOver(
    c: CraneParts,
    at: Vector3,
    lie: number,
  ): { angle: number; radius: number; height: number; turn: number } {
    const dx = at.x - c.slew.position.x;
    const dz = at.z - c.slew.position.z;
    return {
      angle: Math.atan2(-dz, dx),
      radius: Math.hypot(dx, dz),
      height: at.y + BOX_HEIGHT + SPREADER,
      turn: lie,
    };
  }

  /** Slew, luff the boom and play out the rope to put a harbour crane's hook where it is. */
  private poseHarbourCrane(c: CraneParts, h: HarbourCraneParts): void {
    c.slew.rotation.y = c.angle;
    const out = (h.radius - BOOM_FOOT.x) / BOOM_LENGTH;
    const luff = Math.max(LUFF_LOW, Math.min(LUFF_HIGH, Math.acos(Math.max(-1, Math.min(1, out)))));
    const cos = Math.cos(luff);
    const sin = Math.sin(luff);
    h.boom.rotation.z = luff;
    h.head.position.set(BOOM_FOOT.x + BOOM_LENGTH * cos, BOOM_FOOT.y + BOOM_LENGTH * sin - 0.08, 0);
    const drop = Math.max(0.05, c.slew.position.y + h.head.position.y - h.height);
    c.rope.scale.y = drop;
    c.rope.position.y = -drop / 2;
    c.hook.position.y = -drop;
    h.spreader.rotation.y = h.twist;
    // The ram, from low on the front of the deck to under the boom.
    const [x0, y0] = [0.17, 0.06];
    const x1 = BOOM_FOOT.x + 0.8 * cos + 0.05 * sin;
    const y1 = BOOM_FOOT.y + 0.8 * sin - 0.05 * cos;
    h.ram.position.set((x0 + x1) / 2, (y0 + y1) / 2, 0);
    h.ram.scale.x = Math.hypot(x1 - x0, y1 - y0);
    h.ram.rotation.z = Math.atan2(y1 - y0, x1 - x0);
  }

  /**
   * How many containers that look like `look` are kept under `key` (a yard,
   * or a crane's stack): counted at the start of a lift, more or fewer show
   * when one has been set down there or taken away.
   */
  private kept(key: number, look: number): number {
    return (this.slots.get(key) ?? []).reduce((n, l) => n + (l === look ? 1 : 0), 0);
  }

  /**
   * How far a gantry's carriage and trolley close on where they are going
   * this frame: quickly, in game time, so they are right over a container
   * by the time the spreader comes down on it, at any game speed.
   */
  private follow(dt: number): number {
    return 1 - Math.exp(-dt * Math.max(1, this.speed) * 30);
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
      slots?: number[];
      workYard?: number;
      workLegs?: number[];
      workTicks?: number;
      workStart?: number;
    }[],
  ): void {
    for (const y of yards) {
      if (y.slots) this.stackYard(y.tiles, y.slots, y.looks);
      else this.fill(y.tiles, y.boxes + y.exports + (y.lifted ?? 0), true, y.looks);
      if (y.tiles.length > 0) this.yardTiles.set(y.tiles[0], y.tiles);
      // Its gantry, at work or not, and where in the yard the container
      // it is moving lies, or for one coming off a truck, where it goes.
      const tiles = new Set(y.tiles);
      for (const g of this.yardGantries.values()) {
        // Only the yard it works, though it may stand beside another too.
        if (!tiles.has(g.works)) continue;
        const was = g.work;
        const truck = g.truck;
        // A lift it has not been at yet: by when the game began it.
        const same =
          y.working === was &&
          y.workLook === g.look &&
          (y.workStart === undefined || y.workStart === g.liftStart);
        g.liftStart = y.workStart;
        g.legs = y.workLegs ?? NO_RUN;
        g.ticks = y.workTicks ?? YARD_GANTRY_TICKS;
        g.work = y.working ?? null;
        g.laneAt = y.workAt ?? 0;
        g.truck = y.workTruck;
        g.slot = y.workSlot ?? 0;
        // Keep the lift in step with the game's: the container leaves the
        // truck, or lands on it, as the spreader takes it or sets it down.
        // A new one starts where the game has it; the one it is at is
        // brought into step gently, never wrapped round into another.
        if (y.workPhase !== undefined && y.working) {
          g.phase = !same ? y.workPhase : syncPhase(g.phase, y.workPhase);
        }
        // A new lift runs along the rails from wherever it stands now.
        if (!same) {
          this.liftFrom(g);
          g.offAt = undefined;
        }
        if (y.workLook !== undefined) g.look = y.workLook;
        g.yard = y.tiles[0];
        // Seen first part way through a lift, as at speed, the container
        // may be lifted already: it was there as the lift began.
        const taken = (y.workPhase ?? 0) >= liftMarks(y.workLegs).taken ? 1 : 0;
        if (!same) g.base = this.kept(g.yard, g.look) + (y.working === 'load' ? taken : 0);
        if (!same || g.truck !== truck) {
          g.held = this.shownOn(g.truck) + (y.working === 'unload' ? taken : 0);
        }
        // Once it has lifted a container out of the yard its slot is empty:
        // it is still going from there.
        const pick = !y.working
          ? null
          : y.workYard !== undefined
            ? this.yardSlotAt(g, y.tiles, y.workYard)
            : this.slotFor(g, y.tiles, y.working, y.workLook);
        g.pick = pick ?? (y.working && same ? g.pick : null);
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
    const k = work === 'load' ? (look === undefined ? -1 : order.indexOf(look)) : order.length;
    const slot = this.yardSlot(tiles, k);
    if (!slot) return null;
    g.frame.updateWorldMatrix(true, false);
    slot.updateWorldMatrix(true, false);
    const at = g.frame.worldToLocal(slot.getWorldPosition(new Vector3()));
    // The spreader comes down onto its top; the container hangs below it.
    const drop = g.trolley.position.y - (at.y + BOX_HEIGHT + 0.04);
    return { x: at.x, z: at.z, drop };
  }

  /** Container slot `k` of a yard, counting a tile's worth at a time from its first. */
  private yardSlot(tiles: number[], k: number): Object3D | undefined {
    if (k < 0) return undefined;
    for (const t of tiles) {
      const items = this.stacks.get(t)?.boxes ?? [];
      if (k < items.length) return items[k];
      k -= items.length;
    }
    return undefined;
  }

  /**
   * Where a container lies on a crane's stack or in a yard, by how it
   * looks, or with no look the next free place there, for a reach stacker
   * or tractor to take it or set it down: its base in `out`, and which way
   * its length runs, as a heading. Null if there is no such place.
   */
  containerAt(at: HandAt, out: Vector3): number | null {
    const crate = this.crateAt(at);
    if (crate !== undefined) {
      if (!crate) return null;
      crate.getWorldPosition(out);
      return headingOf(crate);
    }
    let slot: Object3D | undefined;
    const placed = at.crane !== undefined ? this.cranePlaces.get(at.crane) : undefined;
    if (at.crane !== undefined && placed) {
      // A gantry crane's stack, each in its place.
      const stack = this.cranes.get(at.crane)?.stack ?? [];
      const j = at.look === undefined ? -1 : placed.looks.indexOf(at.look);
      const k = j >= 0 ? placed.places[j] : at.place;
      slot = k === undefined ? undefined : stack[k];
      if (at.look !== undefined && !slot?.visible) slot = undefined;
    } else if (at.crane !== undefined) {
      const stack = this.cranes.get(at.crane)?.stack ?? [];
      const order = this.slots.get(-1 - at.crane) ?? [];
      const k = at.look === undefined ? order.length : order.indexOf(at.look);
      slot = k < 0 ? undefined : stack[Math.min(k, stack.length - 1)];
    } else if (at.store !== undefined && at.place !== undefined) {
      // A pallet's place in crate storage, the way its forks go in.
      const tiles = this.areas.get(at.store) ?? [at.store];
      const per = CRATES_PER_STORE_TILE / PALLET;
      const place = this.stacks.get(tiles[Math.floor(at.place / per)])?.places?.[at.place % per];
      if (!place) return null;
      place.getWorldPosition(out);
      return headingOf(place);
    } else if (at.yard !== undefined && at.place !== undefined) {
      const tiles = this.yardTiles.get(at.yard) ?? [];
      const per = BOXES_PER_STORE_TILE;
      slot = this.stacks.get(tiles[Math.floor(at.place / per)])?.boxes[at.place % per];
      // A given container is there only while it shows.
      if (at.look !== undefined && !slot?.visible) slot = undefined;
    } else if (at.yard !== undefined) {
      const order = this.slots.get(at.yard) ?? [];
      const k = at.look === undefined ? order.length : order.indexOf(at.look);
      slot = this.yardSlot(this.yardTiles.get(at.yard) ?? [], k);
    }
    if (!slot) return null;
    slot.getWorldPosition(out);
    return headingOf(slot);
  }

  /**
   * A crate's place a forklift or dockhand works, by its slot: on the quay,
   * at a truck bay, in crate storage or on a jib crane's landing stack; null
   * if there is none there, undefined if `at` is not one of these.
   */
  private crateAt(at: HandAt): Object3D | null | undefined {
    if (at.slot === undefined || at.look !== undefined) return undefined;
    const k = at.slot;
    if (at.pile !== undefined) return this.piles.get(at.pile)?.crates[k] ?? null;
    if (at.bay !== undefined) return this.stacks.get(at.bay)?.crates[k] ?? null;
    if (at.store !== undefined) {
      const tiles = this.areas.get(at.store) ?? [at.store];
      const tile = tiles[Math.floor(k / CRATES_PER_STORE_TILE)];
      return this.stacks.get(tile)?.crates[k % CRATES_PER_STORE_TILE] ?? null;
    }
    if (at.crane !== undefined && this.cranes.get(at.crane)?.jib) {
      return this.cranes.get(at.crane)?.stack[k] ?? null;
    }
    return undefined;
  }

  /** How many containers a truck or tractor shows. */
  private shownOn(id: number | undefined): number {
    let n = 0;
    if (id === undefined) return n;
    for (let k = 0; this.truckSlot?.(id, k, this.countAt); k++) {
      if (this.slotShown?.(id, k)) n++;
    }
    return n;
  }

  private runYardGantry(g: YardGantryParts, dt: number): void {
    // One lift a cycle, as long as this one takes in the game: the further
    // it runs along its rails, the longer.
    const cycle = g.ticks / TICKS_PER_SECOND;
    const was = g.phase;
    // To the end of this lift and no further: the next one starts when the
    // game says it does, from where this one left it.
    g.phase = g.work ? Math.min(1, g.phase + (dt * this.speed) / cycle) : 0;
    if (!g.work) {
      g.base = this.kept(g.yard ?? -1, g.look);
      g.held = this.shownOn(g.truck);
      this.liftFrom(g);
    }
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
      const over = at
        ? { x: at.x, z: at.z, drop: g.trolley.position.y - (at.y + BOX_HEIGHT + 0.04) }
        : { x: g.laneAt, z: 0, drop: g.laneDrop };
      // Taken off one, it goes on from where it took it, whether that one
      // stays or drives off.
      const off = g.work === 'unload' && g.phase > liftMarks(g.legs).taken;
      if (!off || !g.offAt) g.offAt = over;
      const lane = off ? g.offAt : over;
      const [from, to] = g.work === 'load' ? [yard, lane] : [lane, yard];
      const ease = (t: number) => t * t * (3 - 2 * t);
      const dip = (t: number, depth: number) => 0.2 + (depth - 0.2) * Math.sin(t * Math.PI);
      // Handed over, it is on the spreader from when it leaves the yard or
      // the truck until it shows where it is set down, never on neither.
      const inYard = () => this.kept(g.yard ?? -1, g.look);
      const onTruck = () => g.truck !== undefined && !!this.slotShown?.(g.truck, g.slot);
      const [gone, there] =
        g.work === 'load'
          ? [() => inYard() < g.base, onTruck]
          : [() => this.shownOn(g.truck) < g.held, () => inYard() > g.base];
      // Run on into another lift before the game has said whether there is
      // one, it has nothing to carry until there was one there to take: a
      // tractor's single container is lifted off already.
      const had = g.work === 'load' ? g.base > 0 : g.held > 0;
      // Nor does it lift one off while it still shows where it was, or let
      // go of one before it shows where it is set down: ahead of the game,
      // as it is at speed, the spreader waits on it.
      const { taken, set } = liftMarks(g.legs);
      if (had && was <= taken && g.phase > taken && !gone()) g.phase = taken;
      if (had && was <= set && g.phase > set && !there()) g.phase = set;
      const p = g.phase;
      // Run along the rails to it, take it up, carry it along, set it down:
      // and there it stays, for the next.
      const [run, up, along] = g.legs;
      const share = (from: number, len: number) => (len > 0 ? clamp01((p - from) / len) : 1);
      if (p < run) {
        const t = ease(share(0, run));
        x = g.startX + (from.x - g.startX) * t;
        z = g.startZ + (from.z - g.startZ) * t;
      } else if (p < run + up) {
        x = from.x;
        z = from.z;
        drop = dip(share(run, up), from.drop);
        carry = p > taken || gone();
      } else if (p < run + up + along) {
        const t = ease(share(run + up, along));
        x = from.x + (to.x - from.x) * t;
        z = from.z + (to.z - from.z) * t;
        carry = true;
      } else {
        x = to.x;
        z = to.z;
        drop = dip(share(run + up + along, 1 - run - up - along), to.drop);
        carry = p < set || !there();
      }
      carry &&= had;
    }
    const follow = this.follow(dt);
    g.carriage.position.x += (x - g.carriage.position.x) * follow;
    g.trolley.position.z += (z - g.trolley.position.z) * follow;
    g.rope.scale.y = drop;
    g.rope.position.y = -drop / 2;
    g.spreader.position.y = -drop;
    g.load.visible = carry;
    if (carry) paintContainer(g.load, g.look);
  }

  /** A yard gantry setting off on a lift: from where its carriage and trolley stand now. */
  private liftFrom(g: YardGantryParts): void {
    g.startX = g.carriage.position.x;
    g.startZ = g.trolley.position.z;
  }

  setBays(bays: BayView[]): void {
    for (const b of bays) {
      if (b.tiles) {
        this.areas.set(b.idx, b.tiles);
        if (b.places) {
          this.palletise(b.tiles, b.stock + b.exports, b.places, b.cargo, b.waiting);
        } else this.fill(b.tiles, b.stock + b.exports, false, undefined, b.cargo, b.waiting);
        continue;
      }
      const stack = this.stacks.get(b.idx);
      if (!stack) continue;
      // Its crates, and on top any ice waiting for the fishing boats.
      stack.crates.forEach((c, k) => (c.visible = k < b.stock + b.exports));
      paintCargo(stack.crates, b.cargo);
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
      paintCargo(pile.crates, v.cargo);
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
  private fill(
    tiles: number[],
    count: number,
    boxes: boolean,
    looks?: number[],
    cargo?: Cargo[],
    waiting?: boolean[],
  ): void {
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
        if (!boxes && cargo && at + k < cargo.length) setCrateIcon(o, cargo[at + k]);
        if (!boxes) setCrateSeal(o, !!waiting?.[at + k]);
      });
      at += Math.min(left, items.length);
      left = Math.max(0, left - items.length);
    }
  }

  /** Crate storage's crates, `count` of them, four to each pallet, the pallets in `places`. */
  private palletise(
    tiles: number[],
    count: number,
    places: number[],
    cargo?: Cargo[],
    waiting?: boolean[],
  ): void {
    const per = CRATES_PER_STORE_TILE / PALLET;
    const on = new Map<number, number>();
    places.forEach((k, j) => on.set(k, Math.min(PALLET, Math.max(0, count - j * PALLET))));
    tiles.forEach((t, n) => {
      this.stacks.get(t)?.crates.forEach((o, k) => {
        const place = n * per + Math.floor(k / PALLET);
        o.visible = k % PALLET < (on.get(place) ?? 0);
        // The crates of the pallet in this place, in the order they went on it.
        const j = places.indexOf(place);
        const c = j >= 0 ? cargo?.[j * PALLET + (k % PALLET)] : undefined;
        if (c) setCrateIcon(o, c);
        // Still in customs, or waiting on its export papers: sealed.
        setCrateSeal(o, j >= 0 && !!waiting?.[j * PALLET + (k % PALLET)]);
      });
    });
  }

  /**
   * A yard's containers each in the slot the game stacks it in, `slots[k]`
   * looking like `looks[k]`: a tile's two stacks, three high, tile by tile.
   */
  private stackYard(tiles: number[], slots: number[], looks: number[]): void {
    const per = BOXES_PER_STORE_TILE;
    const shown = new Map<number, number>();
    slots.forEach((k, j) => shown.set(k, looks[j]));
    tiles.forEach((t, n) => {
      this.stacks.get(t)?.boxes.forEach((o, r) => {
        const look = shown.get(n * per + r);
        o.visible = look !== undefined;
        if (look !== undefined) paintContainer(o, look);
      });
    });
    // What is in it, for a gantry to tell when one has come or gone.
    if (tiles.length > 0) this.slots.set(tiles[0], [...looks]);
  }

  /** Where a yard gantry reaches for yard slot `k`; see slotFor. */
  private yardSlotAt(g: YardGantryParts, tiles: number[], k: number): YardGantryParts['pick'] {
    const per = BOXES_PER_STORE_TILE;
    const slot = this.stacks.get(tiles[Math.floor(k / per)])?.boxes[k % per];
    if (!slot) return null;
    g.frame.updateWorldMatrix(true, false);
    slot.updateWorldMatrix(true, false);
    const at = g.frame.worldToLocal(slot.getWorldPosition(new Vector3()));
    const drop = g.trolley.position.y - (at.y + BOX_HEIGHT + 0.04);
    return { x: at.x, z: at.z, drop };
  }

  /** The slots of the containers kept under `key`, brought up to date with `looks`. */
  private settled(key: number, looks: number[]): number[] {
    const order = settle(this.slots.get(key) ?? [], looks);
    this.slots.set(key, order);
    return order;
  }

  private rebuild(i: number): void {
    const old = this.tiles.get(i);
    // A yard gantry or jib crane laid again carries on where it was.
    const was = this.yardGantries.get(i);
    const jibWas = this.cranes.get(i);
    if (old) {
      this.group.remove(old);
      this.tiles.delete(i);
      this.stacks.delete(i);
      this.cranes.delete(i);
      this.gates.delete(i);
      this.buoys.delete(i);
      this.crossings.delete(i);
      this.lights.delete(i);
      this.yardGantries.delete(i);
    }
    let obj = this.make(i);
    const now = this.yardGantries.get(i);
    if (was && now) {
      // On its rails as they are now, the yard made shorter or split.
      now.carriage.position.x = Math.min(
        now.railTo,
        Math.max(now.railFrom, was.carriage.position.x),
      );
      now.trolley.position.z = was.trolley.position.z;
      const { pick, work, look, phase, base, held, legs, ticks, startX, startZ } = was;
      Object.assign(now, { pick, work, look, phase, base, held, legs, ticks, startX, startZ });
    }
    const jibNow = this.cranes.get(i);
    if (jibWas?.jib && jibNow?.jib) {
      jibNow.angle = jibWas.angle;
      jibNow.slew.rotation.y = jibWas.angle;
      this.reachOut(jibNow.jib, jibWas.jib.out);
      const { work, boat, slot, store, pile, place, carriesPallet, phase, key, start } = jibWas.jib;
      Object.assign(jibNow.jib, { work, boat, slot, store, pile, place, carriesPallet });
      Object.assign(jibNow.jib, { phase, key, start });
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
    // Paving of its own, flush with the quays; not where it stands on a
    // quay, which is drawn under it already (see build), or the two fight.
    const paving = () => {
      if (!(this.map.orient[i] & ON_QUAY)) g.add(box(1, QUAY_Y - top, 1, C.quayTop, 0.5, top, 0.5));
    };

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
        // Off a highway exit, it runs on from the slip road.
        const offExit = this.map.xOf(i) === HIGHWAY_COLUMNS && isExit(this.map, i - 1);
        const ew = this.is(i, 1, 0, ...road) || this.is(i, -1, 0, ...road) || offExit;
        const ns = this.is(i, 0, 1, ...road) || this.is(i, 0, -1, ...road);
        const way = oneWay(this.map, i);
        if (way >= 0) roadArrow(g, top + 0.05, way);
        else if (ew !== ns) {
          for (const o of [0.25, 0.75]) {
            const [x, z, w, d] = ew ? [o, 0.5, 0.26, 0.05] : [0.5, o, 0.05, 0.26];
            g.add(box(w, 0.01, d, C.marking, x, top + 0.05, z));
          }
        }
        if (hasLights(this.map, i)) this.trafficLights(g, i, top + 0.05);
        return g;
      }
      case Build.Highway:
        this.highwayTile(g, i, top);
        return bake(g);
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
        paving();
        const along = this.is(i, 1, 0, Build.PortRoad) || this.is(i, -1, 0, Build.PortRoad);
        if (this.map.store[i]) {
          this.storage(g, i, QUAY_Y);
          this.machinesOutline(g, i, QUAY_Y);
          return g;
        }
        if (machinesOnly(this.map, i)) {
          this.machinesOutline(g, i, QUAY_Y);
          return g;
        }
        const way = oneWay(this.map, i);
        if (way >= 0) roadArrow(g, QUAY_Y, way);
        else {
          for (const o of [0.15, 0.6]) {
            const [x, z, w, d] = along
              ? [o + 0.125, 0.5, 0.25, 0.04]
              : [0.5, o + 0.125, 0.04, 0.25];
            g.add(box(w, 0.006, d, C.marking, x, QUAY_Y, z));
          }
        }
        if (hasLights(this.map, i)) this.trafficLights(g, i, QUAY_Y);
        return g;
      }
      case Build.Parking: {
        // Asphalt outside the port, port paving inside it, and white lines
        // between one space and the next, at the angle trucks park at. A
        // truck stands across the middle of its tile, so the lines run through
        // the tile's edges: each tile draws the half of each line inside it,
        // and the lines stop at the ends of the lot, off the roads.
        const { inside, acrossX, wide, flow } = this.lotAt(i);
        const y = inside ? QUAY_Y : top + 0.05;
        g.add(box(1, y - top, 1, inside ? C.quayTop : C.asphalt, 0.5, top, 0.5));
        // The spaces lean the way trucks drive through the lot: between the
        // way along it and the way across it, in off one road, out onto the other.
        const lean = flow
          ? [flow.along[0] + flow.across[0], flow.along[1] + flow.across[1]]
          : acrossX
            ? [1, 1]
            : [1, -1];
        const vx = lean[0] * Math.SQRT1_2;
        const vz = lean[1] * Math.SQRT1_2;
        const turn = Math.atan2(-vz, vx);
        // Which way through it, painted on it.
        if (flow) {
          const facing = FACING.findIndex(
            ([fx, fy]) => fx === flow.across[0] && fy === flow.across[1],
          );
          if (facing >= 0) roadArrow(g, y, facing, 0.55);
        }
        // Two tiles wide, a truck stands across the middle of both, where
        // the corners of the tiles meet: the lines between the spaces run
        // corner to corner across each tile, joining up across the strip.
        if (wide) {
          const line = box(1.3, 0.008, 0.035, C.marking, 0.5, y, 0.5);
          line.rotation.y = turn;
          g.add(line);
          return g;
        }
        // Along the lines, which run with the parked trucks.
        for (const o of [0, 1]) {
          const [px, pz] = acrossX ? [0.5, o] : [o, 0.5];
          // Into this tile from its edge.
          const k = (o === 0 ? 1 : -1) * 0.31 * Math.sign(acrossX ? vz : vx);
          const half = box(0.62, 0.008, 0.035, C.marking, px + vx * k, y, pz + vz * k);
          half.rotation.y = turn;
          g.add(half);
        }
        return g;
      }
      case Build.Gate: {
        // Port paving with a gatehouse to one side and a striped barrier
        // across the lane, the public road in front (+z).
        paving();
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
        // A one-way gate: an arrow in through it from the road (-z), or out to it.
        const o = this.map.orient[i];
        if (o & (GATE_IN | GATE_OUT)) roadArrow(g, y, o & GATE_IN ? 3 : 1);
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
        } else if (machinesOnly(this.map, i)) this.machinesOutline(g, i, QUAY_Y);
        return g;
      }
      case Build.HarbourCrane: {
        // Mobile harbour crane: a wheeled undercarriage along the quay,
        // braced on four outriggers, a tall tower, and on top of it a
        // slewing deck with the machinery house, the cab and a long boom
        // luffed up and down by a ram, so the hook comes straight down over
        // a container wherever it lies, out on the ship or on the landing
        // stack beside the crane.
        this.quay(g, i);
        this.machinesOutline(g, i, QUAY_Y);
        const y = QUAY_Y;
        const back = this.landwardOffset(i);
        // Along the quay and in towards the land, from the middle of the tile.
        const at = (along: number, inward: number): [number, number] =>
          back.alongX
            ? [0.5 + along, 0.5 + back.side * inward]
            : [0.5 + back.side * inward, 0.5 + along];
        const lay = (
          along: number,
          inward: number,
          w: number,
          h: number,
          d: number,
          up: number,
          color: number = C.chassis,
        ) => {
          const [x, z] = at(along, inward);
          return back.alongX ? box(w, h, d, color, x, up, z) : box(d, h, w, color, x, up, z);
        };
        g.add(lay(0, 0, 0.84, 0.1, 0.32, y + 0.06));
        for (const along of [-0.34, -0.21, 0.21, 0.34]) {
          for (const inward of [-0.13, 0.13]) {
            g.add(lay(along, inward, 0.1, 0.08, 0.07, y, C.tyre));
          }
        }
        for (const sa of [-1, 1]) {
          for (const si of [-1, 1]) {
            const [x0, z0] = at(sa * 0.32, si * 0.12);
            const [x1, z1] = at(sa * 0.42, si * 0.42);
            g.add(strut([x0, y + 0.13, z0], [x1, y + 0.05, z1], 0.05, C.stripe));
            g.add(lay(sa * 0.42, si * 0.42, 0.11, 0.03, 0.11, y));
          }
        }
        g.add(cyl(0.1, HARBOUR_TOWER - 0.16, C.sign, 0.5, y + 0.16, 0.5, 8));
        // The slewing deck: boom out along its +x, the house and the
        // counterweight behind, the cab to one side of the boom's foot.
        const slew = new Group();
        slew.position.set(0.5, y + HARBOUR_TOWER, 0.5);
        slew.add(cyl(0.14, 0.05, C.chassis, 0, 0, 0, 8));
        slew.add(box(0.42, 0.2, 0.3, C.sign, -0.1, 0.05));
        slew.add(box(0.12, 0.16, 0.3, C.chassis, -0.37, 0.03));
        slew.add(box(0.15, 0.13, 0.12, C.cabin, 0.12, 0.05, 0.2));
        slew.add(box(0.02, 0.07, 0.1, C.window, 0.2, 0.09, 0.2));
        slew.add(box(0.1, 0.08, 0.18, C.chassis, BOOM_FOOT.x, 0.24));
        // The boom, laid out along +x from its foot and tapering to its
        // head, where the rope runs over the sheaves.
        const boom = new Group();
        boom.position.set(BOOM_FOOT.x, BOOM_FOOT.y, 0);
        const l = BOOM_LENGTH;
        boom.add(box(l * 0.6, 0.1, 0.12, C.craneYellow, l * 0.3, -0.05));
        boom.add(box(l * 0.4, 0.07, 0.08, C.craneYellow, l * 0.8, -0.035));
        boom.add(box(0.1, 0.08, 0.1, C.chassis, l, -0.04));
        slew.add(boom);
        const ram = box(1, 0.045, 0.045, C.chassis);
        slew.add(ram);
        // The rope from the head, the hook block on it, and under that the
        // spreader, turning to lie along the container it lifts.
        const head = new Group();
        const rope = box(0.012, 1, 0.012, C.chassis);
        const hook = new Group();
        hook.add(box(0.07, 0.06, 0.07, C.chassis));
        const spreader = new Group();
        spreader.add(box(0.62, SPREADER, 0.15, C.stripe, 0, -SPREADER));
        const load = container(i, 0, -SPREADER - BOX_HEIGHT, 0);
        load.visible = false;
        spreader.add(load);
        hook.add(spreader);
        head.add(rope, hook);
        slew.add(head);
        g.add(slew);
        // Landing stack for up to four containers on the quay beside it,
        // on the landward side, two by two.
        const stack: Object3D[] = [];
        for (let layer = 0; layer < 2; layer++) {
          for (const inward of [0.335, 0.645]) {
            const [cx, cz] = at(0, inward);
            const c = container(stack.length + 1, cx, y + layer * BOX_HEIGHT, cz);
            if (!back.alongX) c.rotation.y = Math.PI / 2;
            c.visible = false;
            g.add(c);
            stack.push(c);
          }
        }
        // Waiting with its boom out over the water.
        const sea = back.alongX ? (back.side * Math.PI) / 2 : back.side > 0 ? Math.PI : 0;
        this.cranes.set(i, {
          slew,
          rope,
          hook,
          rest: 0.45,
          reach: 0.6,
          stack,
          angle: sea,
          target: sea,
          busy: false,
          mhc: {
            idx: i,
            frame: g,
            boom,
            head,
            ram,
            spreader,
            load,
            radius: BOOM_FOOT.x + l * Math.cos(0.9),
            height: y + HOOK_UP,
            twist: Math.PI / 2,
            way: 0,
            choice: null,
            work: null,
            boat: -1,
            truck: -1,
            slot: 0,
            look: 0,
            phase: 0,
            drawn: 0,
            held: false,
            stacked: 0,
            base: 0,
            pick: 0,
            landing: null,
            leaving: null,
          },
        });
        this.poseHarbourCrane(this.cranes.get(i)!, this.cranes.get(i)!.mhc!);
        return g;
      }
      case Build.YardGantry: {
        // A rail-mounted gantry spanning the container yard beside it: legs
        // on rails along this side of the yard and its far side, a beam
        // overhead and a trolley with its spreader over the stacks. It runs
        // along the rails to whichever row of the yard it is working.
        const m = this.map;
        const y = QUAY_Y;
        paving();
        // The one yard it works, as the game has it: never into another
        // beside it, nor across a gap where a yard has been split in two.
        const own = gantryYard(m, i);
        const yard = own?.into;
        const inYard = (x: number, z: number) =>
          m.inBounds(x, z) && !!own && own.area.has(m.idx(x, z));
        const [dx, dy] =
          yard === undefined ? [0, 1] : [m.xOf(yard) - m.xOf(i), m.yOf(yard) - m.yOf(i)];
        // Across as many yard tiles as there are, up to three.
        let span = 1;
        while (span < 3) {
          const x = m.xOf(i) + dx * (span + 1);
          const z = m.yOf(i) + dy * (span + 1);
          if (!inYard(x, z)) break;
          span++;
        }
        // Along the yard, either way, as far as its first row runs: the
        // frame's +x is (dy, -dx) on the map.
        const along = (sign: number) => {
          let k = 0;
          while (k < GANTRY_RUN) {
            const x = m.xOf(i) + dx + dy * sign * (k + 1);
            const z = m.yOf(i) + dy - dx * sign * (k + 1);
            if (!inYard(x, z)) break;
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
          base: 0,
          held: 0,
          slot: 0,
          work: null,
          look: 0,
          phase: 0,
          legs: NO_RUN,
          ticks: YARD_GANTRY_TICKS,
          railFrom: from,
          railTo: to,
          works: yard ?? -1,
          startX: 0,
          startZ: Math.max(0.6, far / 2),
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
        const y = QUAY_Y;
        const top = y + 1.55;
        // The rails run along the quay the length of a ship, centred on it,
        // kept clear for it when it was built.
        const left = GANTRY_RAILS / 2 - 1;
        const right = GANTRY_RAILS / 2 - 1;
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
        // Its stack along the quay at the shipside, the length of its rails,
        // two deep and two high, clear of the front legs: landward of it the
        // rest of the quay under it is left for the stackers and tractors.
        // Painted out on the quay as a container yard is: the machines keep
        // off it and work it from behind.
        const [x0, x1, z0, z1] = [-left + 0.05, 2 + right - 0.05, 0.06, 0.74];
        for (const z of [z0, z1]) g.add(box(x1 - x0, 0.006, 0.04, C.stripe, (x0 + x1) / 2, y, z));
        for (const x of [x0, x1]) g.add(box(0.04, 0.006, z1 - z0, C.stripe, x, y, (z0 + z1) / 2));
        const stack: Object3D[] = [];
        const cols = GANTRY_RAILS;
        for (let layer = 0; layer < GANTRY_STACK / (cols * 2); layer++) {
          for (const z of [0.55, 0.25]) {
            for (let a = 0; a < cols; a++) {
              const x = a - (GANTRY_RAILS / 2 - 1) + 0.5;
              const c = container(i * 5 + stack.length, x, y + layer * BOX_HEIGHT, z);
              c.visible = false;
              g.add(c);
              stack.push(c);
            }
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
            idx: i,
            frame: g,
            carriage,
            from: 1 - left - 0.6,
            to: 1 + right + 0.6,
            load,
            work: null,
            boat: -1,
            truck: -1,
            slot: 0,
            look: 0,
            phase: 0,
            stacked: 0,
            base: 0,
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
        slew.add(box(0.16, 0.14, 0.2, C.chassis, -0.2, 0.02));
        // The jib luffs up and down from its foot on the cab, and runs out
        // in two more sections, each slimmer, to reach as far as it lifts.
        const luff = new Group();
        luff.position.set(JIB_FOOT_X, JIB_FOOT_Y, 0);
        const sections = [
          [0.07, 0.08],
          [0.055, 0.065],
          [0.045, 0.05],
        ].map(([h, d]) => box(JIB_SECTION, h, d, C.craneYellow, JIB_SECTION / 2, -h / 2));
        luff.add(...sections);
        slew.add(luff);
        // Cable and hook hang from the end of the jib, and a crate on the
        // hook while it carries one.
        const tip = new Group();
        const rope = box(0.01, 1, 0.01, C.chassis);
        const hook = new Group();
        hook.add(box(0.07, 0.05, 0.07, C.chassis, 0, -0.05));
        const load = crate(1);
        const pallet = palletUnder(load, 1);
        load.visible = false;
        hook.add(load);
        tip.add(rope, hook);
        slew.add(tip);
        g.add(slew);
        // Landing stack on the landward half of the tile, on pallets when
        // they come off a coaster.
        const stack: Object3D[] = [];
        const back = this.landwardOffset(i);
        for (let layer = 0; layer < 2; layer++) {
          for (let k = 0; k < 5; k++) {
            const a = 0.15 + k * 0.17;
            const [cx, cz] = back.alongX
              ? [a, 0.5 + back.side * 0.32]
              : [0.5 + back.side * 0.32, a];
            const c = crate(0.15, cx, QUAY_Y + layer * 0.15, cz);
            palletUnder(c, 0.15).visible = false;
            c.visible = false;
            g.add(c);
            stack.push(c);
          }
        }
        const parts: CraneParts = {
          slew,
          rope,
          hook,
          rest: 0.2,
          reach: 0.35,
          stack,
          angle: 0,
          target: 0,
          busy: false,
          jib: {
            luff,
            mid: sections[1],
            end: sections[2],
            tip,
            load,
            pallet,
            out: 1.2,
            work: null,
            boat: -1,
            slot: 0,
            place: 0,
            carriesPallet: false,
            phase: 0,
            key: '',
            start: { angle: 0, out: 1.2 },
          },
        };
        this.reachOut(parts.jib!, 1.2);
        this.cranes.set(i, parts);
        return g;
      }
      case Build.Depot: {
        // A garage over the whole tile, its front (+z) open under a rolled-up
        // door, tall enough for a forklift's mast, with the machines parked
        // side by side inside (see parkPoses), backs to the back wall. Its
        // side walls stand on the tile's edges, so three fit across.
        // Depots side by side, facing the same way, make one long garage
        // with a door for each bay and a fuel tank on the roof at the end.
        const { left, right } = this.joins(i);
        g.add(box(1, 0.05, 1, C.concrete, 0.5, top, 0.5));
        const y = top + 0.05;
        const [x0, x1] = [left ? 0 : -0.005, right ? 1 : 1.005];
        const mid = (x0 + x1) / 2;
        g.add(
          box(
            x1 - x0,
            DEPOT_HEIGHT,
            DEPOT_BACK - 0.005,
            C.depotWall,
            mid,
            y,
            (DEPOT_BACK - 0.005) / 2,
          ),
        );
        for (const [x, on] of [
          [0, !left],
          [1, !right],
        ] as const) {
          if (!on) continue;
          g.add(box(0.01, DEPOT_HEIGHT, 1, C.depotWall, x, y, 0.5));
          // A strip of windows high up along the side.
          g.add(box(0.014, 0.06, 0.6, C.window, x, y + DEPOT_HEIGHT - 0.14, 0.5));
        }
        g.add(box(x1 - x0, 0.04, 1, C.depotRoof, mid, y + DEPOT_HEIGHT, 0.5));
        // Over the door: the lintel, and the door rolled up under it.
        g.add(box(x1 - x0, 0.03, 0.03, C.depotWall, mid, y + DEPOT_HEIGHT - 0.03, 0.985));
        g.add(box(x1 - x0 - 0.02, 0.02, 0.025, C.chassis, mid, y + DEPOT_HEIGHT - 0.05, 0.98));
        // Hazard stripe across the doorway.
        g.add(box(1, 0.004, 0.03, C.stripe, 0.5, y, 0.975));
        if (!right) {
          // The fuel tank on the roof, red, with its pipe down the side.
          const tank = cyl(0.07, 0.3, C.funnel, 0, 0, 0, 10);
          tank.rotation.x = Math.PI / 2;
          tank.position.set(0.82, y + DEPOT_HEIGHT + 0.11, 0.2);
          g.add(tank);
          for (const z of [0.1, 0.3])
            g.add(box(0.1, 0.05, 0.03, C.chassis, 0.82, y + DEPOT_HEIGHT + 0.04, z));
          g.add(box(0.02, DEPOT_HEIGHT, 0.02, C.chassis, 1.012, y, 0.12));
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
        // The bench the dockhands sit on, on their break.
        g.add(box(0.7, 0.03, 0.12, C.wood, 0.5, top + 0.1, 0.8));
        for (const x of [0.2, 0.8]) g.add(box(0.04, 0.06, 0.1, C.woodDark, x, top + 0.04, 0.8));
        return g;
      }
      case Build.HarbourHut: {
        // The harbourmaster's hut: a little blue-painted timber shed with a
        // white door and a big window on the water, a red roof, a lifebuoy
        // and a noticeboard by the door, and a flag flying on a pole.
        g.add(box(1, 0.04, 1, C.path, 0.5, top, 0.5));
        const y = top + 0.04;
        g.add(box(0.56, 0.3, 0.46, C.shed, 0.5, y, 0.42));
        // Corner posts and a band under the eaves in white.
        for (const [x, z] of [
          [0.23, 0.2],
          [0.77, 0.2],
          [0.23, 0.64],
          [0.77, 0.64],
        ]) {
          g.add(box(0.04, 0.3, 0.04, C.shedTrim, x, y, z));
        }
        g.add(box(0.6, 0.03, 0.5, C.shedTrim, 0.5, y + 0.28, 0.42));
        const roof = new Mesh(roofGeo, mat(C.funnel));
        roof.scale.set(0.82, 0.9, 0.94);
        roof.position.set(0.5, y + 0.31 + 0.12, 0.42);
        roof.castShadow = roof.receiveShadow = true;
        g.add(roof);
        // Door and window at the front (+z).
        g.add(box(0.13, 0.21, 0.02, C.shedTrim, 0.4, y, 0.66));
        g.add(box(0.15, 0.1, 0.02, C.window, 0.62, y + 0.12, 0.66));
        g.add(box(0.17, 0.02, 0.025, C.shedTrim, 0.62, y + 0.11, 0.665));
        // Lifebuoy on the wall by the door, red and white.
        const buoy = new Mesh(lifebuoyGeo, mat(C.funnel));
        buoy.position.set(0.24, y + 0.17, 0.675);
        buoy.castShadow = true;
        g.add(buoy);
        for (const a of [0, Math.PI / 2, Math.PI, (Math.PI * 3) / 2]) {
          g.add(
            box(
              0.02,
              0.02,
              0.012,
              C.cabin,
              0.24 + Math.cos(a) * 0.05,
              y + 0.16 + Math.sin(a) * 0.05,
              0.69,
            ),
          );
        }
        // Noticeboard on two legs out front.
        for (const x of [0.73, 0.89]) g.add(box(0.015, 0.14, 0.015, C.woodDark, x, y, 0.86));
        g.add(box(0.2, 0.1, 0.02, C.wood, 0.81, y + 0.1, 0.86));
        g.add(box(0.06, 0.05, 0.022, C.cabin, 0.77, y + 0.125, 0.86));
        g.add(box(0.05, 0.04, 0.022, C.stripe, 0.85, y + 0.13, 0.86));
        // Flagpole with a flag at the corner.
        g.add(cyl(0.01, 0.62, C.cabin, 0.12, y, 0.86));
        g.add(box(0.012, 0.09, 0.15, C.sign, 0.12, y + 0.5, 0.94));
        g.add(box(0.013, 0.03, 0.15, C.cabin, 0.12, y + 0.53, 0.94));
        return g;
      }
      case Build.TruckBay: {
        // Entrance at the front (+z): the truck backs in, and the crates
        // stand two by two in the front corner, out of the way of those
        // loading it.
        g.add(box(1, 0.06, 1, C.concrete, 0.5, top, 0.5));
        const y = top + 0.06;
        for (const x of [0.06, 0.94]) g.add(box(0.05, 0.01, 0.9, C.stripe, x, y, 0.5));
        const crates: Object3D[] = [];
        // The front row stacked to the top first, away from those who stack
        // them from behind, then the row in front of them; taken off the
        // other way round.
        for (const z of [0.89, 0.71]) {
          for (let layer = 0; layer < 4; layer++) {
            for (const x of [0.71, 0.89]) {
              const c = crate(0.17, x, y + layer * 0.17, z);
              c.visible = false;
              g.add(c);
              crates.push(c);
            }
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
    const stack: BayStack = { crates: [], boxes: [], places: [] };
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
      // Pallets of crates, each a forklift's load as it carries them, set
      // down four to a tile with their forks' ends to the area's long sides.
      const area = this.storeArea(i);
      const xs = area.map((t) => this.map.xOf(t));
      const ys = area.map((t) => this.map.yOf(t));
      const alongX = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys);
      for (const a of [0.28, 0.72]) {
        for (const b of [0.29, 0.71]) {
          const place = new Group();
          // Its forks' way runs along local x; across the area's length.
          if (alongX) {
            place.position.set(b, y, a);
            place.rotation.y = -Math.PI / 2;
          } else place.position.set(a, y, b);
          for (let layer = 0; layer < 2; layer++) {
            for (const z of [-0.08, 0.08]) {
              const c = crate(PALLET_CRATE, 0, 0.025 + layer * PALLET_CRATE, z);
              c.visible = false;
              place.add(c);
              stack.crates.push(c);
            }
          }
          // The pallet shows with the first crate on it.
          const first = stack.crates[stack.crates.length - 4];
          first.add(box(0.2, 0.025, 0.34, C.wood, 0, -0.025, 0.08));
          g.add(place);
          stack.places!.push(place);
        }
      }
    }
    this.stacks.set(i, stack);
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
   * A tile of the highway: a carriageway of two lanes one way, the solid
   * line along its outer edge and the crash barrier down the middle, both
   * open at an exit, and now and then an arrow the way it goes.
   */
  private highwayTile(g: Group, i: number, top: number): void {
    const m = this.map;
    const x = m.xOf(i);
    const y = m.yOf(i);
    const exit = isExit(m, i);
    g.add(box(1, 0.05, 1, C.asphalt, 0.5, top, 0.5));
    const lineY = top + 0.05;
    // Dashes between its two lanes.
    for (const z of [0.12, 0.62]) g.add(box(0.04, 0.008, 0.26, C.marking, 0.5, lineY, z + 0.13));
    // The edge line on the outside; open where the slip road joins at an exit.
    const outer = x === 0 ? 0.07 : 0.93;
    if (!(exit && x === HIGHWAY_COLUMNS - 1)) {
      g.add(box(0.04, 0.008, 1, C.marking, outer, lineY, 0.5));
    }
    // Half the barrier down the middle each side; at an exit, the gap through it.
    const inner = x === 0 ? 0.975 : 0.025;
    if (!exit) {
      g.add(box(0.05, 0.09, 1, BARRIER, inner, lineY, 0.5));
    } else {
      // Give-way lines across the gap, and the barrier's ends.
      g.add(box(0.05, 0.008, 0.9, C.marking, inner, lineY, 0.5));
    }
    if (y % 12 === 6 && !exit) roadArrow(g, lineY, m.orient[i] & 3);
  }

  /**
   * The highway running on past the north and south ends of the map, so
   * trucks come in from somewhere and go somewhere.
   */
  private highwayEnds(): Object3D {
    const g = new Group();
    const m = this.map;
    if (!hasHighway(m)) return g;
    for (const [from, y] of [
      [-MARGIN, 0],
      [m.h, m.h - 1],
    ] as const) {
      const top = landTop(m.terrain[m.idx(0, y)]);
      const z = from + MARGIN / 2;
      g.add(box(HIGHWAY_COLUMNS, 0.05, MARGIN, C.asphalt, HIGHWAY_COLUMNS / 2, top, z));
      g.add(box(0.04, 0.008, MARGIN, C.marking, 0.07, top + 0.05, z));
      g.add(box(0.04, 0.008, MARGIN, C.marking, HIGHWAY_COLUMNS - 0.07, top + 0.05, z));
      g.add(box(0.1, 0.09, MARGIN, BARRIER, 1, top + 0.05, z));
      for (let k = 0; k < MARGIN; k += 1) {
        for (const x of [0.5, 1.5]) {
          g.add(box(0.04, 0.008, 0.26, C.marking, x, top + 0.05, from + k + 0.25));
        }
      }
    }
    return bake(g);
  }

  /**
   * Traffic lights on a junction: a post at each corner, by the lane
   * coming in on its right, its lamps red or green as the game has them.
   */
  private trafficLights(g: Group, i: number, top: number): void {
    const parts: LightParts = { ns: [], ew: [] };
    // Corner, and which traffic it faces: in on the right-hand side of the road.
    for (const [px, pz, way] of [
      [0.08, 0.92, 'ew'],
      [0.92, 0.08, 'ew'],
      [0.92, 0.92, 'ns'],
      [0.08, 0.08, 'ns'],
    ] as const) {
      g.add(cyl(0.018, 0.34, C.chassis, px, top, pz));
      g.add(box(0.06, 0.13, 0.06, C.funnel, px, top + 0.3, pz));
      const red = box(0.065, 0.04, 0.065, LAMP_RED, px, top + 0.38, pz);
      const green = box(0.065, 0.04, 0.065, LAMP_GREEN, px, top + 0.31, pz);
      green.visible = false;
      g.add(red, green);
      parts[way].push({ red, green });
    }
    this.lights.set(i, parts);
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
  Build.HarbourHut,
  Build.BreakHut,
]);

/**
 * How far to slew from `from` to `to`: the short way round, or when that is
 * over a quarter of a turn, the way `way` says (1 or -1), so that a ship
 * rolling a little cannot send a crane swinging round the other way.
 */
function swing(from: number, to: number, way = 0): number {
  let d = wrapAngle(to - from);
  if (way * d < 0 && Math.abs(d) > Math.PI / 2) d += Math.PI * 2 * way;
  return d;
}

/** The turn a container lying turned `turn` is at, the same as or half a turn from it, nearest `near`. */
function alike(turn: number, near: number): number {
  return turn + Math.PI * Math.round((near - turn) / Math.PI);
}

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

/**
 * An arrow painted on a road, the way traffic goes on it (a facing, see
 * FACING): a shaft and a head, flat on the tarmac at height `y`.
 */
function roadArrow(g: Group, y: number, facing: number, scale = 1): void {
  const [dx, dy] = FACING[facing & 3];
  const arrow = new Group();
  arrow.scale.setScalar(scale);
  arrow.add(box(0.07, 0.008, 0.36, C.marking, 0, 0, -0.06));
  // The head: two strokes back from the tip, either side of the shaft.
  for (const side of [-1, 1]) {
    const head = new Group();
    head.position.set(0, 0, 0.14);
    head.rotation.y = side * 2.4;
    head.add(box(0.07, 0.008, 0.2, C.marking, 0, 0, 0.1));
    arrow.add(head);
  }
  arrow.position.set(0.5, y, 0.5);
  arrow.rotation.y = Math.atan2(dx, dy);
  g.add(arrow);
}
