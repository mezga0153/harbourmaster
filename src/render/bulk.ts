import { CylinderGeometry, Group, Mesh, type Object3D } from 'three';
import type { BulkView } from '../protocol';
import * as B from '../sim/balance';
import type { BulkKind } from '../sim/bulk';
import type { GameMap } from '../sim/map';
import { Build } from '../sim/types';
import { ON_QUAY } from '../sim/orient';
import { box, cyl, mat } from './parts';
import { C } from './palette';
import { QUAY_Y, landTop } from './terrain';

// Bulk cargo as the game has it: heaps on the stockpiles, a load along
// each belt, the fill in each grab crane's hopper and loadout's bin, and
// the grab cranes swinging their grabs between the hold and the hopper.

/** Bulk cargo's colour, by kind. */
export const BULK_COLOUR: Record<BulkKind, number> = {
  coal: 0x2b2b30,
  grain: 0xd9b45a,
  ore: 0x8a4b32,
};

/**
 * A heap: a square frustum a unit across at its foot and high, its top a
 * ridge-like flat a third as wide, scaled to fit the stockpile it lies on.
 */
const heapGeo = new CylinderGeometry(Math.SQRT1_2 / 3, Math.SQRT1_2, 1, 4, 1);
heapGeo.rotateY(Math.PI / 4);
heapGeo.translate(0, 0.5, 0);
heapGeo.computeVertexNormals();

/** A grab crane's moving parts: the house that slews, and the grab hanging from its jib. */
interface Grab {
  root: Group;
  house: Group;
  grab: Object3D;
  /** Its turn facing the water, and the hopper behind it. */
  sea: number;
  busy: boolean;
  phase: number;
  at: number;
}

export class BulkLayer {
  readonly group = new Group();
  private loads = new Map<number, Mesh>();
  private grabs = new Map<number, Grab>();
  private rate = 0;

  constructor(private map: GameMap) {}

  /** How high the ground or quay is on tile `i`: on a quay, its deck. */
  private top(i: number): number {
    const m = this.map;
    const quay = m.build[i] === Build.GrabCrane || (m.orient[i] & ON_QUAY) !== 0;
    return quay ? QUAY_Y : landTop(m.terrain[i]);
  }

  push(view: BulkView, speed: number): void {
    const m = this.map;
    this.rate = speed;
    const seen = new Set<number>();
    // One heap over each stockpile, as high as it is full; see heaps.
    for (const k of this.heaps(view, seen)) seen.add(k);
    for (const [i, kind, t] of view.at) {
      if (m.build[i] === Build.Stockpile) continue;
      seen.add(i);
      let mesh = this.loads.get(i);
      const b = m.build[i];
      if (!mesh) {
        mesh =
          b === Build.Stockpile
            ? new Mesh(heapGeo, mat(BULK_COLOUR[kind]))
            : box(1, 1, 1, BULK_COLOUR[kind], 0, 0, 0);
        mesh.castShadow = b === Build.Stockpile;
        this.loads.set(i, mesh);
        this.group.add(mesh);
      }
      mesh.material = mat(BULK_COLOUR[kind]);
      const x = m.xOf(i) + 0.5;
      const z = m.yOf(i) + 0.5;
      const y = this.top(i);
      if (b === Build.Belt) {
        const f = Math.min(1, t / B.BELT_CAP);
        mesh.scale.set(0.24, 0.02 + 0.07 * f, 0.24);
        mesh.position.set(x, y + 0.13, z);
      } else if (b === Build.GrabCrane) {
        const f = Math.min(1, t / B.HOPPER_CAP);
        mesh.scale.set(0.3, 0.02 + 0.1 * f, 0.3);
        mesh.position.set(x, y + 0.36 + 0.1 * f, z);
      } else if (b === Build.Loadout) {
        const f = Math.min(1, t / B.LOADOUT_CAP);
        mesh.scale.set(0.38, 0.02 + 0.16 * f, 0.38);
        mesh.position.set(x, landTop(m.terrain[i]) + 0.62 + 0.16 * f, z);
      }
      mesh.visible = t > 0.05;
    }
    for (const [i, mesh] of this.loads) {
      if (seen.has(i)) continue;
      this.group.remove(mesh);
      this.loads.delete(i);
    }
    const cranes = new Set<number>();
    for (const g of view.grabs) {
      cranes.add(g.idx);
      let crane = this.grabs.get(g.idx);
      if (!crane) {
        crane = this.makeGrab(g.idx, g.water);
        this.grabs.set(g.idx, crane);
        this.group.add(crane.root);
      }
      crane.busy = g.busy;
      crane.phase = g.phase;
      crane.at = performance.now();
    }
    for (const [i, c] of this.grabs) {
      if (cranes.has(i)) continue;
      this.group.remove(c.root);
      this.grabs.delete(i);
    }
  }

  /**
   * A heap over each stockpile with anything on it, keyed by its first
   * tile: across the stockpile's tiles, or each square run of them where
   * it is not square, and as high as the whole of it is full.
   */
  private heaps(view: BulkView, seen: Set<number>): number[] {
    const m = this.map;
    const load = new Map<number, { kind: BulkKind; t: number }>();
    for (const [i, kind, t] of view.at)
      if (m.build[i] === Build.Stockpile) load.set(i, { kind, t });
    const done = new Set<number>();
    const keys: number[] = [];
    for (const start of load.keys()) {
      if (done.has(start)) continue;
      // The stockpile's tiles, all that touch.
      const area = [start];
      done.add(start);
      for (let k = 0; k < area.length; k++) {
        for (const n of m.neighbors4(area[k])) {
          if (done.has(n) || m.build[n] !== Build.Stockpile) continue;
          done.add(n);
          area.push(n);
        }
      }
      let t = 0;
      let kind: BulkKind = 'coal';
      for (const i of area) {
        const l = load.get(i);
        if (l) {
          t += l.t;
          kind = l.kind;
        }
      }
      const xs = area.map((i) => m.xOf(i));
      const ys = area.map((i) => m.yOf(i));
      const x0 = Math.min(...xs);
      const y0 = Math.min(...ys);
      const w = Math.max(...xs) - x0 + 1;
      const d = Math.max(...ys) - y0 + 1;
      // A square stockpile heaps up as one; any other shape, a heap a tile.
      const square = w * d === area.length;
      const parts = square
        ? [{ x: x0, y: y0, w, d, tiles: area }]
        : area.map((i) => ({ x: m.xOf(i), y: m.yOf(i), w: 1, d: 1, tiles: [i] }));
      for (const p of parts) {
        const key = Math.min(...p.tiles);
        const tt = square ? t : (load.get(p.tiles[0])?.t ?? 0);
        const f = Math.min(1, tt / (p.tiles.length * B.STOCKPILE_TILE));
        if (f <= 0.002) continue;
        keys.push(key);
        let mesh = this.loads.get(key);
        if (!mesh) {
          mesh = new Mesh(heapGeo, mat(BULK_COLOUR[kind]));
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          this.loads.set(key, mesh);
          this.group.add(mesh);
        }
        mesh.material = mat(BULK_COLOUR[kind]);
        // It spreads out to the walls as it fills, and rises.
        const spread = 0.55 + 0.4 * Math.sqrt(f);
        mesh.scale.set(p.w * spread, 0.04 + 0.42 * f * Math.min(p.w, p.d, 2), p.d * spread);
        mesh.position.set(p.x + p.w / 2, this.top(key) + 0.02, p.y + p.d / 2);
        mesh.visible = true;
      }
    }
    return keys.filter((k) => !seen.has(k));
  }

  /** A grab crane on tile `i`: a pedestal, a house that slews, a jib, and the grab on its wire. */
  private makeGrab(i: number, water: number): Grab {
    const m = this.map;
    const root = new Group();
    root.position.set(m.xOf(i) + 0.5, QUAY_Y, m.yOf(i) + 0.5);
    const yellow = 0xf2c230;
    root.add(cyl(0.14, 0.5, C.chassis, 0, 0, 0, 10));
    const house = new Group();
    house.position.y = 0.5;
    house.add(box(0.34, 0.24, 0.3, yellow, -0.05, 0, 0));
    house.add(box(0.1, 0.1, 0.22, C.window, 0.13, 0.08, 0));
    // The jib, raked up and out over the water.
    const jib = box(1.3, 0.05, 0.06, yellow, 0.6, 0.2, 0);
    jib.rotation.z = 0.35;
    house.add(jib);
    const grab = new Group();
    grab.add(cyl(0.006, 0.6, C.chassis, 0, 0, 0, 4));
    const bucket = box(0.16, 0.1, 0.14, 0x41464d, 0, -0.05, 0);
    grab.add(bucket);
    house.add(grab);
    root.add(house);
    const sea = water >= 0 ? Math.atan2(-(m.yOf(water) - m.yOf(i)), m.xOf(water) - m.xOf(i)) : 0;
    house.rotation.y = sea + Math.PI;
    return { root, house, grab, sea, busy: false, phase: 0, at: 0 };
  }

  /** The grab cranes swing to and fro between the hold and the hopper, a bite a swing. */
  update(now: number): void {
    for (const c of this.grabs.values()) {
      if (!c.busy) {
        // At rest over its hopper.
        c.house.rotation.y += (c.sea + Math.PI - c.house.rotation.y) * 0.05;
        c.grab.position.set(0.35, 0.05, 0);
        continue;
      }
      const ticks = ((now - c.at) / 1000) * 10 * this.rate;
      const p = (c.phase + ticks / B.GRAB_TICKS) % 1;
      // Out over the hold and down, up and round over the hopper, and back.
      const out = p < 0.5 ? Math.sin(p * Math.PI * 2 - Math.PI / 2) * 0.5 + 0.5 : 1 - (p - 0.5) * 2;
      c.house.rotation.y = c.sea + Math.PI * (1 - out);
      const reach = 0.35 + 0.8 * out;
      const dip = out > 0.9 ? Math.sin(((p - 0.2) / 0.15) * Math.PI) * 0.4 : 0;
      c.grab.position.set(reach, 0.2 + reach * 0.36 - 0.6 - Math.max(0, dip), 0);
    }
  }
}
