import {
  BoxGeometry,
  ConeGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  type Object3D,
} from 'three';
import type { BayView, CraneView, PileView, TileChange } from '../protocol';
import type { GameMap } from '../sim/map';
import { EXTENSION, FACING, machinesOnly, ON_QUAY } from '../sim/rules';
import { hash01 } from '../sim/noise';
import { crossingClosed, railColumn, type Train } from '../sim/railway';
import { HIGHWAY_X, TOWN } from '../sim/town';
import { Build, isDock, isPublicRoad, isTownBuilding, Store } from '../sim/types';
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
  /** A gantry: `slew` is its trolley, running out along the boom and back instead. */
  fixed?: boolean;
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
  /** Cargo landed on the quay, by tile. */
  private piles = new Map<number, { group: Group; crates: Object3D[]; pallets: boolean }>();
  private train: Train | null = null;

  constructor(private map: GameMap) {
    for (let i = 0; i < map.build.length; i++) this.rebuild(i);
    this.group.add(this.highway(), this.mainLine(), this.boundary());
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
      // Exports set down for a container crane wait on its stack too.
      c.stack.forEach((o, k) => (o.visible = k < v.stack + v.out));
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

  setYards(yards: { boxes: number; exports: number; tiles: number[] }[]): void {
    for (const y of yards) this.fill(y.tiles, y.boxes + y.exports, true);
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
  private fill(tiles: number[], count: number, boxes: boolean): void {
    let left = count;
    for (const t of tiles) {
      const stack = this.stacks.get(t);
      if (!stack) continue;
      const items = boxes ? stack.boxes : stack.crates;
      items.forEach((o, k) => (o.visible = k < left));
      left = Math.max(0, left - items.length);
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
        // Asphalt with white lines between the spaces, along the longer run of the lot.
        g.add(box(1, 0.05, 1, C.asphalt, 0.5, top, 0.5));
        const lot = [Build.Parking];
        const alongX = this.is(i, 1, 0, ...lot) || this.is(i, -1, 0, ...lot);
        for (const o of [0.04, 0.96]) {
          const [x, z, w, d] = alongX ? [o, 0.5, 0.04, 0.8] : [0.5, o, 0.8, 0.04];
          g.add(box(w, 0.01, d, C.marking, x, top + 0.05, z));
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
      case Build.Gantry: {
        // Ship-to-shore gantry over 2×2 of quay: x 0..2 along the edge, the
        // water off the front (+z), z -1..1. Four legs on rails, a portal
        // frame, and a boom running out over the ship and back over the
        // bay between the back legs, where it sets the containers down.
        const y = QUAY_Y;
        const top = y + 1.7;
        for (const z of [-0.85, 0.85]) g.add(box(2, 0.02, 0.06, C.chassis, 1, y, z));
        for (const x of [0.12, 1.88]) {
          for (const z of [-0.85, 0.85]) {
            g.add(box(0.16, 0.1, 0.22, C.chassis, x, y, z));
            g.add(box(0.1, top - y, 0.1, C.sign, x, y + 0.1, z));
          }
          g.add(box(0.12, 0.12, 1.8, C.sign, x, top - 0.12, 0));
          g.add(box(0.06, 0.06, 1.7, C.sign, x, y + 0.5, 0));
        }
        for (const z of [-0.85, 0.85]) g.add(box(1.88, 0.1, 0.1, C.sign, 1, top - 0.3, z));
        // The boom: out 2 tiles over the water, back 0.8 behind the legs.
        g.add(box(0.12, 0.1, 4.6, C.craneYellow, 0.78, top, 0.5));
        g.add(box(0.12, 0.1, 4.6, C.craneYellow, 1.22, top, 0.5));
        // Apex frame, its stays, and the machinery house on the backreach.
        for (const x of [0.78, 1.22]) g.add(box(0.06, 0.7, 0.06, C.sign, x, top + 0.1, -0.7));
        g.add(box(0.5, 0.06, 0.06, C.sign, 1, top + 0.8, -0.7));
        g.add(box(0.56, 0.28, 0.5, C.cabin, 1, top + 0.1, -1.4));
        const trolley = new Group();
        trolley.position.set(1, top, 2.2);
        trolley.add(box(0.5, 0.06, 0.3, C.chassis, 0, -0.06, 0));
        trolley.add(box(0.18, 0.14, 0.18, C.window, 0.12, -0.2, 0.06));
        const rope = box(0.012, 1, 0.012, C.chassis);
        const hook = new Group();
        hook.add(box(0.62, 0.04, 0.16, C.stripe, 0, -0.04));
        trolley.add(rope, hook);
        g.add(trolley);
        // The bay between the back legs: two rows of two, four high.
        const stack: Object3D[] = [];
        for (let layer = 0; layer < 4; layer++) {
          for (const z of [-0.68, -0.32]) {
            for (const x of [0.5, 1.5]) {
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
          rest: 0.6,
          reach: 1.0,
          stack,
          angle: 0,
          target: 0,
          busy: false,
          fixed: true,
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
    const boxes = code === Store.Boxes;
    const same = (dx: number, dy: number) => {
      const n = this.offset(i, dx, dy);
      return n >= 0 && this.map.store[n] === code;
    };
    for (const [dx, dy] of DIRS) {
      if (same(dx, dy)) continue;
      const [x, z, w, d] = dx ? [0.5 + dx * 0.45, 0.5, 0.04, 1] : [0.5, 0.5 + dy * 0.45, 1, 0.04];
      g.add(box(w, 0.006, d, boxes ? C.stripe : C.marking, x, y, z));
    }
    const stack: BayStack = { crates: [], boxes: [] };
    if (boxes) {
      const alongX = same(1, 0) || same(-1, 0) || !(same(0, 1) || same(0, -1));
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
