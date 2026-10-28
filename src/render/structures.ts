import { ConeGeometry, Group, Mesh, type Object3D } from 'three';
import type { BayView, CraneView, TileChange } from '../protocol';
import type { GameMap } from '../sim/map';
import { Build, isBay, isDock } from '../sim/types';
import { container, crate } from './models';
import { C } from './palette';
import { box, cyl, mat } from './parts';
import { DECK_Y, MARGIN, QUAY_Y, SEABED, landTop } from './terrain';

const roofGeo = new ConeGeometry(0.56, 0.26, 4);
roofGeo.rotateY(Math.PI / 4);
roofGeo.scale(1.05, 1, 0.8);
roofGeo.translate(0, 0.13, 0);

interface BayStack {
  crates: Object3D[];
  boxes: Object3D[];
}

interface CraneParts {
  /** Rotates about Y to point the jib at the boat being unloaded. */
  slew: Object3D;
  hook: Object3D;
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

  constructor(private map: GameMap) {
    for (let i = 0; i < map.build.length; i++) this.rebuild(i);
    this.group.add(this.highway());
  }

  apply(changes: TileChange[]): void {
    const touched = new Set<number>();
    for (const c of changes) {
      touched.add(c.i);
      for (const n of this.map.neighbors4(c.i)) touched.add(n);
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

  /** Per-frame animation: slew cranes towards their boats, bob the hooks. */
  update(dt: number, time: number): void {
    for (const c of this.cranes.values()) {
      let d = c.target - c.angle;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      c.angle += d * Math.min(1, dt * 3);
      c.slew.rotation.y = c.angle;
      c.hook.position.y = 0.55 + (c.busy ? Math.sin(time * 6) * 0.2 : 0.2);
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
    }
    const obj = this.make(i);
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
    const g = new Group();
    const top = landTop(this.map.terrain[i]);

    switch (code) {
      case Build.Road: {
        g.add(box(1, 0.05, 1, C.asphalt, 0.5, top, 0.5));
        const ew =
          this.is(i, 1, 0, Build.Road) || this.is(i, -1, 0, Build.Road) || i === this.map.entry;
        const ns = this.is(i, 0, 1, Build.Road) || this.is(i, 0, -1, Build.Road);
        if (ew !== ns) {
          for (const o of [0.25, 0.75]) {
            const [x, z, w, d] = ew ? [o, 0.5, 0.26, 0.05] : [0.5, o, 0.05, 0.26];
            g.add(box(w, 0.01, d, C.marking, x, top + 0.05, z));
          }
        }
        return g;
      }
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
        return g;
      }
      case Build.ForkliftLane: {
        // Dark asphalt with yellow edge lines and a forklift marking.
        g.add(box(1, 0.03, 1, C.asphalt, 0.5, top, 0.5));
        const along = this.is(i, 1, 0, Build.ForkliftLane) || this.is(i, -1, 0, Build.ForkliftLane);
        for (const o of [0.08, 0.92]) {
          const [x, z, w, d] = along ? [0.5, o, 1, 0.04] : [o, 0.5, 0.04, 1];
          g.add(box(w, 0.006, d, C.stripe, x, top + 0.03, z));
        }
        g.add(box(0.22, 0.006, 0.12, C.stripe, 0.46, top + 0.03, 0.5));
        g.add(box(0.06, 0.006, 0.2, C.stripe, 0.6, top + 0.03, 0.5));
        return g;
      }
      case Build.PortRoad: {
        // Concrete paving with a dashed white centre line.
        g.add(box(1, 0.03, 1, C.concrete, 0.5, top, 0.5));
        const along = this.is(i, 1, 0, Build.PortRoad) || this.is(i, -1, 0, Build.PortRoad);
        for (const o of [0.15, 0.6]) {
          const [x, z, w, d] = along ? [o + 0.125, 0.5, 0.25, 0.04] : [0.5, o + 0.125, 0.04, 0.25];
          g.add(box(w, 0.006, d, C.marking, x, top + 0.03, z));
        }
        return g;
      }
      case Build.Footpath:
        g.add(box(1, 0.03, 1, C.pathEdge, 0.5, top, 0.5));
        g.add(box(0.9, 0.025, 0.9, C.path, 0.5, top + 0.03, 0.5));
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
      case Build.Quay:
        this.quay(g, i);
        return g;
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
        const hook = new Group();
        hook.position.set(1.9, 0.55, 0);
        hook.add(box(0.012, 0.7, 0.012, C.chassis, 0, 0));
        hook.add(box(0.36, 0.04, 0.16, C.stripe, 0, -0.04));
        slew.add(hook);
        g.add(slew);
        // Landing stack for up to four containers on the landward side.
        const stack: Object3D[] = [];
        const back = this.landwardOffset(i);
        for (let layer = 0; layer < 2; layer++) {
          for (const a of [0.27, 0.73]) {
            const [cx, cz] = back.alongX
              ? [a, 0.5 + back.side * 0.34]
              : [0.5 + back.side * 0.34, a];
            const c = container(stack.length + 1, cx, y + 0.12 + layer * 0.17, cz);
            if (!back.alongX) c.rotation.y = Math.PI / 2;
            c.visible = false;
            g.add(c);
            stack.push(c);
          }
        }
        this.cranes.set(i, { slew, hook, stack, angle: 0, target: 0, busy: false });
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
        const hook = new Group();
        hook.position.set(1.08, 0.55, 0);
        hook.add(box(0.01, 0.35, 0.01, C.chassis, 0, 0));
        hook.add(box(0.07, 0.05, 0.07, C.chassis, 0, -0.04));
        slew.add(hook);
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
        this.cranes.set(i, { slew, hook, stack, angle: 0, target: 0, busy: false });
        return g;
      }
      case Build.Depot: {
        // Concrete apron, a garage with its door towards the road, a pump.
        g.add(box(1, 0.05, 1, C.concrete, 0.5, top, 0.5));
        const y = top + 0.05;
        const door = this.drivableSide(i);
        const alongX = door.dx === 0;
        const back = 0.5 - (alongX ? door.dy : door.dx) * 0.18;
        const [gx, gz] = alongX ? [0.5, back] : [back, 0.5];
        const [w, d] = alongX ? [0.84, 0.56] : [0.56, 0.84];
        g.add(box(w, 0.36, d, C.depotWall, gx, y, gz));
        g.add(box(w + 0.04, 0.04, d + 0.04, C.depotRoof, gx, y + 0.36, gz));
        const front = alongX ? gz + door.dy * (d / 2) : gx + door.dx * (w / 2);
        const [dx, dz] = alongX ? [0.5, front] : [front, 0.5];
        const [dw, dd] = alongX ? [0.46, 0.02] : [0.02, 0.46];
        g.add(box(dw, 0.28, dd, C.chassis, dx, y, dz));
        for (let k = 0; k < 4; k++)
          g.add(box(dw, 0.012, dd + 0.004, C.quayWall, dx, y + 0.04 + k * 0.065, dz));
        // Hazard stripe across the apron and a red fuel pump.
        const [sx, sz] = alongX ? [0.5, 0.5 + door.dy * 0.4] : [0.5 + door.dx * 0.4, 0.5];
        g.add(box(alongX ? 0.9 : 0.05, 0.008, alongX ? 0.05 : 0.9, C.stripe, sx, y, sz));
        const [px, pz] = alongX ? [0.88, 0.5 + door.dy * 0.3] : [0.5 + door.dx * 0.3, 0.88];
        g.add(box(0.1, 0.22, 0.08, C.funnel, px, y, pz));
        g.add(box(0.11, 0.05, 0.09, C.cabin, px, y + 0.16, pz));
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
      case Build.TruckBay:
      case Build.LargeBay: {
        const large = code === Build.LargeBay;
        g.add(box(1, 0.06, 1, large ? C.quayTop : C.concrete, 0.5, top, 0.5));
        // Which side the road is on decides where trucks enter and crates sit.
        const roadX = this.is(i, 1, 0, Build.Road) || this.is(i, -1, 0, Build.Road);
        const y = top + 0.06;
        for (const o of [0.06, 0.94]) {
          const [x, z, w, d] = roadX ? [0.5, o, 0.9, 0.05] : [o, 0.5, 0.05, 0.9];
          g.add(box(w, 0.01, d, C.stripe, x, y, z));
        }
        const crates: Object3D[] = [];
        // Large bays stack two rows deep, under a canopy.
        const rows = large ? [0.84, 0.66] : [0.84];
        for (let layer = 0; layer < (large ? 4 : 4); layer++) {
          for (const row of rows) {
            for (const a of [0.2, 0.4, 0.6, 0.8]) {
              if (crates.length >= (large ? 28 : 16)) break;
              const [cx, cz] = roadX ? [a, row] : [row, a];
              const c = crate(0.17, cx, y + layer * 0.17, cz);
              c.visible = false;
              g.add(c);
              crates.push(c);
            }
          }
        }
        if (large) {
          for (const a of [0.08, 0.92]) {
            const [cx, cz] = roadX ? [a, 0.92] : [0.92, a];
            g.add(cyl(0.03, 0.78, C.chassis, cx, y, cz));
          }
          const [rx, rz, rw, rd] = roadX ? [0.5, 0.74, 1, 0.48] : [0.74, 0.5, 0.48, 1];
          g.add(box(rw, 0.04, rd, C.depotRoof, rx, y + 0.78, rz));
        }
        const [px, pz] = roadX ? [0.92, 0.92] : [0.92, 0.08];
        g.add(cyl(0.02, 0.5, C.chassis, px, y, pz));
        g.add(box(0.04, 0.16, 0.22, C.sign, px, y + 0.45, pz));
        // Large bays also hold up to four containers, two by two.
        const boxes: Object3D[] = [];
        if (large) {
          for (let layer = 0; layer < 2; layer++) {
            for (const a of [0.3, 0.72]) {
              const [cx, cz] = roadX ? [a, 0.3] : [0.3, a];
              const c = container(boxes.length, cx, y + layer * 0.17, cz);
              if (!roadX) c.rotation.y = Math.PI / 2;
              c.visible = false;
              g.add(c);
              boxes.push(c);
            }
          }
        }
        this.stacks.set(i, { crates, boxes });
        return g;
      }
    }
    return null;
  }

  /** Concrete slab (on the shore) or block (in the water) with edge details. */
  private quay(g: Group, i: number): void {
    const onLand = this.map.isLand(i);
    const base = onLand ? landTop(this.map.terrain[i]) : SEABED;
    g.add(box(1, QUAY_Y - 0.03 - base, 1, C.quayWall, 0.5, base, 0.5));
    g.add(box(0.98, 0.03, 0.98, C.quayTop, 0.5, QUAY_Y - 0.03, 0.5));
    // Safety line, bollards and tyre fenders along open-water edges.
    const sides = [
      { dx: 1, dy: 0, x: 0.95, z: 0.5, w: 0.04, d: 0.9 },
      { dx: -1, dy: 0, x: 0.05, z: 0.5, w: 0.04, d: 0.9 },
      { dx: 0, dy: 1, x: 0.5, z: 0.95, w: 0.9, d: 0.04 },
      { dx: 0, dy: -1, x: 0.5, z: 0.05, w: 0.9, d: 0.04 },
    ];
    for (const s of sides) {
      const nx = this.map.xOf(i) + s.dx;
      const ny = this.map.yOf(i) + s.dy;
      if (!this.map.inBounds(nx, ny)) continue;
      const n = this.map.idx(nx, ny);
      if (this.map.isLand(n) || isDock(this.map.build[n])) continue;
      const inX = s.dx !== 0 ? s.x - s.dx * 0.07 : s.x;
      const inZ = s.dy !== 0 ? s.z - s.dy * 0.07 : s.z;
      g.add(box(s.w, 0.005, s.d, C.stripe, inX, QUAY_Y, inZ));
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

  /** Direction from a tile to a neighbouring drivable surface, for doors. */
  private drivableSide(i: number): { dx: number; dy: number } {
    for (const [dx, dy] of [
      [0, 1],
      [1, 0],
      [0, -1],
      [-1, 0],
    ]) {
      const x = this.map.xOf(i) + dx;
      const y = this.map.yOf(i) + dy;
      if (!this.map.inBounds(x, y)) continue;
      const b = this.map.build[this.map.idx(x, y)];
      if (
        b === Build.Road ||
        b === Build.Footpath ||
        b === Build.PortRoad ||
        b === Build.ForkliftLane ||
        b === Build.Quay ||
        isBay(b)
      ) {
        return { dx, dy };
      }
    }
    return { dx: 0, dy: 1 };
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

  private landAt(i: number, dx: number, dy: number): boolean {
    const x = this.map.xOf(i) + dx;
    const y = this.map.yOf(i) + dy;
    return this.map.inBounds(x, y) && this.map.isLand(this.map.idx(x, y));
  }

  /** Scenery road continuing off the map from the truck entry. */
  private highway(): Object3D {
    const g = new Group();
    const ey = this.map.yOf(this.map.entry);
    const top = landTop(this.map.terrain[this.map.entry]);
    g.add(box(MARGIN, 0.05, 1, C.asphalt, -MARGIN / 2, top, ey + 0.5));
    for (let x = -MARGIN; x < 0; x++) {
      for (const o of [0.25, 0.75])
        g.add(box(0.26, 0.01, 0.05, C.marking, x + o, top + 0.05, ey + 0.5));
    }
    return g;
  }
}
