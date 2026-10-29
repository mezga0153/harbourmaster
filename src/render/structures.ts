import {
  BoxGeometry,
  ConeGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  type Object3D,
} from 'three';
import type { BayView, CraneView, TileChange } from '../protocol';
import type { GameMap } from '../sim/map';
import { EXTENSION, FACING, FORKLIFT_ONLY, ON_QUAY, footprint } from '../sim/rules';
import { hash01 } from '../sim/noise';
import { crossingClosed, railColumn, type Train } from '../sim/railway';
import { TOWN } from '../sim/town';
import { Build, isDock, isPublicRoad, isTownBuilding } from '../sim/types';
import { BOX_HEIGHT } from './assets';
import { container, crate } from './models';
import { C } from './palette';
import { box, cyl, mat } from './parts';
import { bake, pavements, townBuilding } from './town';

const LIGHT = 0xfff2b0;
const BALLAST = 0x9b9284;
const STEEL = 0x8d939b;
const LAMP_RED = 0xff3b2f;
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
}

/** Roads, paths, jetties and truck bays, rebuilt per tile when they change. */
export class Structures {
  readonly group = new Group();
  private tiles = new Map<number, Object3D>();
  private stacks = new Map<number, BayStack>();
  private cranes = new Map<number, CraneParts>();
  private gates = new Map<number, GateParts>();
  /** Buoys, bobbing on the swell. */
  private buoys = new Map<number, Object3D>();
  private crossings = new Map<number, CrossingParts>();
  private train: Train | null = null;

  constructor(private map: GameMap) {
    for (let i = 0; i < map.build.length; i++) this.rebuild(i);
    this.group.add(this.highway(), this.mainLine());
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
    for (const i of touched) this.rebuild(i);
  }

  setCranes(views: CraneView[]): void {
    for (const v of views) {
      const c = this.cranes.get(v.idx);
      if (!c) continue;
      c.stack.forEach((o, k) => (o.visible = k < v.stack));
      c.busy = v.busy;
      if (v.busy) c.target = -v.angle;
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
    for (const c of this.cranes.values()) {
      let d = c.target - c.angle;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      c.angle += d * Math.min(1, dt * 3);
      c.slew.rotation.y = c.angle;
      const drop = c.rest + (c.busy ? (0.5 + 0.5 * Math.sin(time * 3)) * c.reach : 0);
      c.rope.scale.y = drop;
      c.rope.position.y = -drop / 2;
      c.hook.position.y = -drop;
    }
  }

  setYards(yards: { idx: number; boxes: number }[]): void {
    for (const y of yards) {
      this.stacks.get(y.idx)?.boxes.forEach((c, k) => (c.visible = k < y.boxes));
    }
  }

  setBays(bays: BayView[]): void {
    for (const b of bays) {
      const stack = this.stacks.get(b.idx);
      if (!stack) continue;
      stack.crates.forEach((c, k) => (c.visible = k < b.stock));
      stack.boxes.forEach((c, k) => (c.visible = k < b.boxes));
    }
  }

  private rebuild(i: number): void {
    const old = this.tiles.get(i);
    if (old) {
      this.group.remove(old);
      this.tiles.delete(i);
      this.stacks.delete(i);
      this.cranes.delete(i);
      this.gates.delete(i);
      this.buoys.delete(i);
      this.crossings.delete(i);
    }
    let obj = this.make(i);
    if ((FACES.has(this.map.build[i]) || isTownBuilding(this.map.build[i])) && obj) {
      obj = turn(obj, this.map.orient[i]);
    }
    // A yard laid out on a quay stands on the quay's walls and piles.
    if (this.map.orient[i] & ON_QUAY) {
      const both = new Group();
      const deck = new Group();
      this.quay(deck, i, true);
      both.add(deck);
      if (obj) both.add(obj);
      obj = both;
    }
    if (!obj) return;
    obj.position.set(this.map.xOf(i), 0, this.map.yOf(i));
    this.group.add(obj);
    this.tiles.set(i, obj);
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
        // Harbour office: two storeys, a control room on top, radio mast and flag.
        g.add(box(1, 0.05, 1, C.concrete, 0.5, top, 0.5));
        const y = top + 0.05;
        g.add(box(0.7, 0.4, 0.62, C.cabin, 0.5, y, 0.5));
        for (const z of [0.18, 0.82]) {
          g.add(box(0.56, 0.06, 0.012, C.window, 0.5, y + 0.08, z));
          g.add(box(0.56, 0.06, 0.012, C.window, 0.5, y + 0.25, z));
        }
        g.add(box(0.74, 0.03, 0.66, C.sign, 0.5, y + 0.4, 0.5));
        g.add(box(0.36, 0.16, 0.36, C.window, 0.5, y + 0.43, 0.5));
        g.add(box(0.42, 0.03, 0.42, C.sign, 0.5, y + 0.59, 0.5));
        g.add(cyl(0.012, 0.42, C.chassis, 0.62, y + 0.62, 0.62));
        g.add(cyl(0.012, 0.5, C.chassis, 0.16, y, 0.84));
        g.add(box(0.012, 0.1, 0.14, C.funnel, 0.16, y + 0.4, 0.91));
        // Front door, towards +z like every building before it is turned.
        g.add(box(0.16, 0.22, 0.02, C.woodDark, 0.5, y, 0.82));
        return g;
      }
      case Build.PortRoad: {
        // Same paving as the quays and flush with them, with a dashed white centre line.
        g.add(box(1, QUAY_Y - top, 1, C.quayTop, 0.5, top, 0.5));
        const along = this.is(i, 1, 0, Build.PortRoad) || this.is(i, -1, 0, Build.PortRoad);
        if (this.map.orient[i] & FORKLIFT_ONLY) {
          this.forkliftMarking(g, along, QUAY_Y);
          return g;
        }
        for (const o of [0.15, 0.6]) {
          const [x, z, w, d] = along ? [o + 0.125, 0.5, 0.25, 0.04] : [0.5, o + 0.125, 0.04, 0.25];
          g.add(box(w, 0.006, d, C.marking, x, QUAY_Y, z));
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
        if (this.map.orient[i] & FORKLIFT_ONLY) {
          const along = this.is(i, 1, 0, Build.Quay) || this.is(i, -1, 0, Build.Quay);
          this.forkliftMarking(g, along, QUAY_Y);
        }
        return g;
      }
      case Build.HarbourCrane: {
        // Mobile harbour crane: a wheeled base with outriggers, a tall tower
        // and a long boom that slews out over the ship.
        this.quay(g, i);
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
      case Build.JibCrane: {
        this.quay(g, i);
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
        g.add(box(1, 0.05, 1, C.concrete, 0.5, top, 0.5));
        const y = top + 0.05;
        g.add(box(0.84, 0.36, 0.56, C.depotWall, 0.5, y, 0.32));
        g.add(box(0.88, 0.04, 0.6, C.depotRoof, 0.5, y + 0.36, 0.32));
        g.add(box(0.46, 0.28, 0.02, C.chassis, 0.5, y, 0.6));
        for (let k = 0; k < 4; k++) {
          g.add(box(0.46, 0.012, 0.024, C.quayWall, 0.5, y + 0.04 + k * 0.065, 0.6));
        }
        // Hazard stripe across the apron and a red fuel pump.
        g.add(box(0.9, 0.008, 0.05, C.stripe, 0.5, y, 0.9));
        g.add(box(0.1, 0.22, 0.08, C.funnel, 0.88, y, 0.8));
        g.add(box(0.11, 0.05, 0.09, C.cabin, 0.88, y + 0.16, 0.8));
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
      case Build.Yard: {
        // 2×2 behind a gate onto the road at the front (+z): x 0..2, z -1..1.
        // A lane along the gate where trucks load, then containers three
        // along, four rows deep, two high.
        // Laid out on a quay, the yard's paving sits on the quay deck.
        const tiles = footprint(this.map, 'containerYard', i, this.map.orient[i] & 3);
        const raised = tiles.some((t) => t >= 0 && this.map.orient[t] & ON_QUAY);
        const floor = raised ? QUAY_Y : top;
        const base = Math.min(
          ...tiles.map((t) =>
            t >= 0 && !(this.map.orient[t] & ON_QUAY) ? landTop(this.map.terrain[t]) : floor,
          ),
        );
        g.add(box(2, floor + 0.05 - base, 2, C.quayTop, 1, base, 0));
        const y = floor + 0.05;
        g.add(box(1.9, 0.008, 0.04, C.stripe, 1, y, 0.3));
        const boxes: Object3D[] = [];
        for (let layer = 0; layer < 2; layer++) {
          for (const z of [0.12, -0.2, -0.52, -0.84]) {
            for (const x of [0.35, 1, 1.65]) {
              const c = container(boxes.length * 7 + layer, x, y + layer * BOX_HEIGHT, z);
              c.visible = false;
              g.add(c);
              boxes.push(c);
            }
          }
        }
        // Floodlight masts at the back corners and a gate sign.
        for (const x of [0.06, 1.94]) {
          g.add(cyl(0.02, 0.9, C.chassis, x, y, -0.94));
          g.add(box(0.14, 0.05, 0.08, C.window, x, y + 0.9, -0.94));
        }
        g.add(cyl(0.02, 0.5, C.chassis, 0.06, y, 0.94));
        g.add(box(0.04, 0.16, 0.22, C.sign, 0.06, y + 0.45, 0.94));
        this.stacks.set(i, { crates: [], boxes });
        return g;
      }
      case Build.Warehouse: {
        // 2×2: a loading apron with two truck docks at the front (+z, z 0..1)
        // and a clad shed behind (z -1..0), its roller doors onto the docks.
        g.add(box(2, 0.06, 2, C.quayTop, 1, top, 0));
        const y = top + 0.06;
        for (const x of [0.04, 1, 1.96]) g.add(box(0.04, 0.008, 0.9, C.stripe, x, y, 0.5));
        g.add(box(1.9, 0.62, 0.9, C.shed, 1, y, -0.5));
        // Ribs on the cladding, a pale roof and a canopy over the docks.
        for (let k = 0; k < 7; k++) {
          const x = 0.1 + k * 0.3;
          g.add(box(0.02, 0.62, 0.92, C.shedTrim, x, y, -0.5));
        }
        g.add(box(1.96, 0.04, 0.96, C.shedTrim, 1, y + 0.62, -0.5));
        g.add(box(1.96, 0.025, 0.34, C.depotRoof, 1, y + 0.5, 0.12));
        for (const x of [0.5, 1.5]) {
          g.add(box(0.52, 0.42, 0.02, C.chassis, x, y, -0.04));
          for (let k = 0; k < 5; k++) {
            g.add(box(0.52, 0.012, 0.024, C.quayWall, x, y + 0.05 + k * 0.08, -0.03));
          }
          // Rubber bumpers either side of each door.
          for (const s of [-1, 1]) g.add(box(0.05, 0.1, 0.04, C.tyre, x + s * 0.3, y, 0));
        }
        // Name board over the docks.
        g.add(box(0.9, 0.14, 0.02, C.sign, 1, y + 0.66, -0.04));
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

  /** Yellow edge lines and a forklift sign painted on forklift-only paving. */
  private forkliftMarking(g: Group, along: boolean, y: number): void {
    for (const o of [0.1, 0.9]) {
      const [x, z, w, d] = along ? [0.5, o, 1, 0.04] : [o, 0.5, 0.04, 1];
      g.add(box(w, 0.006, d, C.stripe, x, y, z));
    }
    g.add(box(0.22, 0.006, 0.12, C.stripe, 0.46, y, 0.5));
    g.add(box(0.06, 0.006, 0.2, C.stripe, 0.6, y, 0.5));
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

  /** Scenery roads continuing off the map: the highway from the truck entry, and the town's. */
  private highway(): Object3D {
    const g = new Group();
    for (let y = 0; y < this.map.h; y++) {
      const i = this.map.idx(0, y);
      if (!isPublicRoad(this.map.build[i])) continue;
      const top = landTop(this.map.terrain[i]);
      g.add(box(MARGIN, 0.05, 1, C.asphalt, -MARGIN / 2, top, y + 0.5));
      if (i !== this.map.entry) continue;
      for (let x = -MARGIN; x < 0; x++) {
        for (const o of [0.25, 0.75])
          g.add(box(0.26, 0.01, 0.05, C.marking, x + o, top + 0.05, y + 0.5));
      }
    }
    return g;
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

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** Buildings drawn facing +z and then turned the way they were placed. */
const FACES = new Set<number>([
  Build.Gate,
  Build.Warehouse,
  Build.Yard,
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
