import { Group, type Object3D } from 'three';
import type { BayView, TileChange } from '../protocol';
import type { GameMap } from '../sim/map';
import { Build } from '../sim/types';
import { crate } from './models';
import { C } from './palette';
import { box, cyl } from './parts';
import { DECK_Y, MARGIN, SEABED, landTop } from './terrain';

interface BayStack {
  crates: Object3D[];
}

/** Roads, paths, jetties and truck bays, rebuilt per tile when they change. */
export class Structures {
  readonly group = new Group();
  private tiles = new Map<number, Object3D>();
  private stacks = new Map<number, BayStack>();

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

  setBays(bays: BayView[]): void {
    for (const b of bays) {
      const stack = this.stacks.get(b.idx);
      if (stack) stack.crates.forEach((c, k) => (c.visible = k < b.stock));
    }
  }

  private rebuild(i: number): void {
    const old = this.tiles.get(i);
    if (old) {
      this.group.remove(old);
      this.tiles.delete(i);
      this.stacks.delete(i);
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
      case Build.Footpath:
        g.add(box(1, 0.03, 1, C.pathEdge, 0.5, top, 0.5));
        g.add(box(0.9, 0.025, 0.9, C.path, 0.5, top + 0.03, 0.5));
        return g;
      case Build.Jetty: {
        const alongX =
          this.is(i, 1, 0, Build.Jetty) ||
          this.is(i, -1, 0, Build.Jetty) ||
          this.landAt(i, 1, 0) ||
          this.landAt(i, -1, 0);
        for (let k = 0; k < 4; k++) {
          const o = 0.13 + k * 0.245;
          const [x, z, w, d] = alongX ? [o, 0.5, 0.22, 1] : [0.5, o, 1, 0.22];
          g.add(box(w, 0.06, d, k % 2 ? C.wood : C.woodDark, x, DECK_Y - 0.06, z));
        }
        for (const px of [0.12, 0.88]) {
          for (const pz of [0.12, 0.88]) {
            g.add(cyl(0.05, DECK_Y - 0.06 - SEABED, C.woodDark, px, SEABED, pz));
          }
        }
        return g;
      }
      case Build.TruckBay: {
        g.add(box(1, 0.06, 1, C.concrete, 0.5, top, 0.5));
        // Which side the road is on decides where trucks enter and crates sit.
        const roadX = this.is(i, 1, 0, Build.Road) || this.is(i, -1, 0, Build.Road);
        const y = top + 0.06;
        for (const o of [0.06, 0.94]) {
          const [x, z, w, d] = roadX ? [0.5, o, 0.9, 0.05] : [o, 0.5, 0.05, 0.9];
          g.add(box(w, 0.01, d, C.stripe, x, y, z));
        }
        const crates: Object3D[] = [];
        for (let layer = 0; layer < 4; layer++) {
          for (const a of [0.2, 0.4, 0.6, 0.8]) {
            const [cx, cz] = roadX ? [a, 0.84] : [0.84, a];
            const c = crate(0.19, cx, y + layer * 0.19, cz);
            c.visible = false;
            g.add(c);
            crates.push(c);
          }
        }
        const [px, pz] = roadX ? [0.92, 0.92] : [0.92, 0.08];
        g.add(cyl(0.02, 0.5, C.chassis, px, y, pz));
        g.add(box(0.04, 0.16, 0.22, C.sign, px, y + 0.45, pz));
        this.stacks.set(i, { crates });
        return g;
      }
    }
    return null;
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
