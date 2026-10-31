import { describe, expect, it } from 'vitest';
import { Group } from 'three';
import { TICKS_PER_DAY } from '../src/sim/types';
import { Entities } from '../src/render/entities';
import { Structures } from '../src/render/structures';
import { CELL, CELL_CRATE, SUB, StaffGrid, type CrateBox } from '../src/render/entities/grid';
import { forkCells, keptCells } from '../src/sim/systems/workforce/forkCells';
import { wharf } from './wharf';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** The first tile of crate storage for cargo coming in, in a Coastal Wharf game. */
function storeTile(world: Any): number {
  const store = [...world.bays.values()].find((b: Any) => b.tiles && !b.outgoing);
  return store.tiles[0];
}

describe('The staff’s grid', () => {
  it('keeps the cells under a stack of crates from both, and finds a way round it', () => {
    const world = wharf(4, 2);
    const m = world.map;
    const t = storeTile(world);
    const [tx, tz] = [m.xOf(t), m.yOf(t)];
    // A stack in the middle of the tile, two crates by two, as storage stacks them.
    const stack: CrateBox[] = [];
    for (const a of [0.4, 0.6])
      for (const b of [0.42, 0.58]) stack.push({ x: tx + a, z: tz + b, half: 0.08 });
    const grid = new StaffGrid({ map: m, crates: (i) => (i === t ? stack : []), trucks: () => [] });
    for (let cz = 0; cz < SUB; cz++) {
      for (let cx = 0; cx < SUB; cx++) {
        const inner = cx >= 1 && cx <= 2 && cz >= 1 && cz <= 2;
        const bits = grid.flags(tx * SUB + cx, tz * SUB + cz);
        expect(!!(bits & CELL_CRATE), `cell ${cx},${cz}`).toBe(inner);
        // People walk in the aisle round it.
        if (!inner) expect(grid.free('dockhand', tx * SUB + cx, tz * SUB + cz)).toBe(true);
      }
    }
    // Straight across the tile, from one side of the stack to the other.
    const from = { x: tx - 0.3, z: tz + 0.5 };
    const to = { x: tx + 1.3, z: tz + 0.5 };
    for (const kind of ['forklift', 'dockhand'] as const) {
      expect(grid.clearLine(kind, from, to)).toBe(false);
      const via = grid.route(kind, from, to);
      expect(via.length, kind).toBeGreaterThan(0);
      const way = [from, ...via, to];
      for (let k = 1; k < way.length; k++) {
        expect(grid.lineBlocked(kind, way[k - 1], way[k], CELL_CRATE), `${kind} leg ${k}`).toBe(0);
      }
    }
  });

  it('keeps forklifts’ ways and dockhands out of the crates in crate storage, dockhands working them from the gaps', () => {
    const world = wharf(4, 2);
    for (const b of world.bays.values()) {
      if (b.tiles && !b.outgoing) b.crates = Array.from({ length: 40 }, () => 25);
    }
    const m = world.map;
    const structures = new Structures(m, true);
    const entities = new Entities(m);
    structures.truckSlot = (id, k, out) => entities.slotPosition(id, k, out);
    structures.slotShown = (id, k) => entities.slotShown(id, k);
    structures.slotObject = (id, k) => entities.slotObject(id, k);
    entities.containerAt = (at, out) => structures.containerAt(at, out);
    entities.crateIn = (x, z, pad) => structures.crateIn(x, z, pad);
    entities.cratesOn = (i) => structures.cratesOn(i);
    const scene = new Group();
    scene.add(structures.group, entities.group);
    const entries = (entities as Any).entries as Map<number, Any>;
    const grid = entities.staffGrid;
    let routes = 0;
    let crossing = 0;
    let stands = 0;
    let inStack = 0;
    let walkFrames = 0;
    let inCrates = 0;
    const seen = new Set<object>();
    for (let t = 0, now = 0; t < TICKS_PER_DAY * 1.5; t++) {
      world.step();
      const s = world.snapshot();
      entities.push(s.entities, now, s.tick);
      structures.setBays(s.bays);
      structures.setPiles(s.piles);
      for (let f = 0; f < 4; f++) {
        now += 100 / 4;
        entities.update(now, now / 1000);
        structures.update(1 / 40, now / 1000);
        scene.updateMatrixWorld(true);
        for (const e of entries.values()) {
          const v = e.view;
          const h = e.hand;
          if (v.kind === 'forklift' && h?.plan && !seen.has(h.plan)) {
            // Each way it plans to line up: round crates, never across them.
            seen.add(h.plan);
            const p = h.plan;
            const way = [p.out ?? h.from, ...(p.via ?? []), p.line];
            if (way.length > 2) {
              routes++;
              for (let k = 2; k < way.length - 1; k++) {
                if (grid.lineBlocked('forklift', way[k - 1], way[k], CELL_CRATE) > 0) crossing++;
              }
            }
          }
          if (v.kind !== 'dockhand') continue;
          if (h?.goal && v.handAt?.store !== undefined && !seen.has(h)) {
            seen.add(h);
            stands++;
            // Where they stand to work a crate in storage: in a gap, never in the stack.
            if (grid.blockedAt('dockhand', h.goal.x, h.goal.z, 0.05, CELL_CRATE) > 0) inStack++;
          }
          const r = e.model.root.position;
          walkFrames++;
          if (structures.crateIn(r.x, r.z, 0.02)) inCrates++;
        }
      }
    }
    expect(walkFrames).toBeGreaterThan(1000);
    expect(inCrates / walkFrames, 'dockhands among crates').toBeLessThan(0.002);
    expect(stands).toBeGreaterThan(5);
    expect(inStack).toBe(0);
    expect(routes).toBeGreaterThan(0);
    expect(crossing).toBe(0);
    // A cell is a quarter tile.
    expect(CELL).toBe(0.25);
  }, 240_000);

  it('has forklifts drive cell by cell round the crates in storage and at the truck bays, two by two cells under them', () => {
    const world = wharf(4, 2);
    for (const b of world.bays.values()) {
      if (b.tiles && !b.outgoing) b.crates = Array.from({ length: 40 }, () => 25);
    }
    const m = world.map;
    const kept = (x: number, z: number) => {
      const [tx, tz] = [Math.floor(x), Math.floor(z)];
      const bits = keptCells(world, m.idx(tx, tz));
      const [cx, cz] = [Math.floor((x - tx) * SUB), Math.floor((z - tz) * SUB)];
      return (bits & (1 << (cz * SUB + cx))) !== 0;
    };
    // A forklift two by two cells round x, z, a little inside them.
    const under = (x: number, z: number) =>
      [-0.23, 0.23].some((dx) => [-0.23, 0.23].some((dz) => kept(x + dx, z + dz)));
    let planned = 0;
    let samples = 0;
    let through = 0;
    for (let t = 0; t < TICKS_PER_DAY; t++) {
      world.step();
      for (const p of world.people) {
        if (p.kind !== 'forklift') continue;
        const way = forkCells(p);
        if (!way || way.length === 0) continue;
        planned++;
        // From the first corner on: where it is may be among them, getting out.
        for (let k = 1; k < way.length - 1; k++) {
          const [a, b] = [way[k - 1], way[k]];
          const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.06));
          for (let s = 0; s <= n; s++) {
            samples++;
            if (under(a.x + ((b.x - a.x) * s) / n, a.z + ((b.z - a.z) * s) / n)) through++;
          }
        }
      }
    }
    expect(planned).toBeGreaterThan(50);
    expect(samples).toBeGreaterThan(200);
    expect(through / samples).toBeLessThan(0.01);
  }, 240_000);
});
