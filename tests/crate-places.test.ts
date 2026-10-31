import { describe, expect, it } from 'vitest';
import { Group, Vector3, type Object3D } from 'three';
import { Build, TICKS_PER_DAY } from '../src/sim/types';
import { depotDoorTrouble, frontOf, placementError } from '../src/sim/rules';
import { World } from '../src/sim/world';
import { crateSlots } from '../src/sim/systems/cargo/places';
import { Structures } from '../src/render/structures';
import { wharf } from './wharf';

// Each crate in crate storage or a truck bay's stack keeps the slot it was
// set down in until it is taken (see src/sim/systems/cargo/places.ts), and
// a forklift sets its load down only on the ground or on a whole layer.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** The slot under `s` in crate storage or a truck bay's stack: rows of eight, two to a layer. */
const below = (s: number) => (s % 8 >= 2 ? s - 2 : -1);

/**
 * The starting jetty paved into a quay with a jib crane at its tip and
 * crate storage beside it, no dockhands, and a depot of two forklifts that
 * take the crates the crane swings into storage on to the truck bay, and
 * onto the trucks there (as render.test.ts has it).
 */
function forkPort(): World {
  const world = World.create(7, 96);
  const m = world.map;
  world.boats.length = 0;
  world.tier = 1;
  world.cash = 1_000_000;
  const r = m.yOf(m.entry);
  const jetty = [...m.build.keys()].filter((i) => m.yOf(i) === r && m.build[i] === Build.Jetty);
  world.command({ type: 'build', kind: 'quay', tiles: jetty });
  const paths = [...m.build.keys()].filter((i) => m.build[i] === Build.Footpath);
  world.command({ type: 'build', kind: 'portRoad', tiles: paths });
  const office = m.build.findIndex((b, i) => b === Build.None && !placementError(m, 'office', i));
  world.command({ type: 'build', kind: 'office', tiles: [office] });
  world.command({ type: 'build', kind: 'jibCrane', tiles: [jetty[jetty.length - 1]] });
  world.command({ type: 'store', tiles: jetty.slice(-3, -1), kind: 'crates', on: true });
  for (const p of world.people.filter((q) => q.kind === 'dockhand')) {
    world.command({ type: 'fire', id: p.id });
  }
  for (let i = 0; i < m.build.length; i++) {
    if (placementError(m, 'depot', i)) continue;
    const f = [0, 1, 2, 3].find((f) => {
      const front = frontOf(m, i, f);
      return !depotDoorTrouble(m, i, f) && front >= 0 && m.build[front] === Build.PortRoad;
    });
    if (f === undefined) continue;
    world.command({ type: 'build', kind: 'depot', tiles: [i], facing: f });
    for (let k = 0; k < 2; k++) world.command({ type: 'buyMachine', kind: 'forklift', tile: i });
    break;
  }
  return world;
}

/** Every slot taken at each crate storage area and truck bay. */
function taken(world: World): Map<number, Set<number>> {
  const out = new Map<number, Set<number>>();
  for (const b of world.bays.values()) {
    if (b.yard || b.pile || (b.large && !b.tiles)) continue;
    const { crates, exports } = crateSlots(world, b);
    out.set(b.idx, new Set([...crates, ...exports].filter((s) => s >= 0)));
  }
  return out;
}

describe('Crates in storage and at truck bays', () => {
  it('are set down by a forklift only on the ground or a whole layer, never on an uneven one', () => {
    const world: Any = forkPort();
    let drops = 0;
    let onTop = 0;
    for (let t = 0; t < TICKS_PER_DAY * 5; t++) {
      const before = taken(world);
      const setting = world.people
        .filter((p: Any) => p.kind === 'forklift' && p.state === 'dropping' && p.carrying > 0)
        .map((p: Any) => [p, p.bayIdx]);
      world.step();
      const after = taken(world);
      for (const [p, at] of setting) {
        if (p.carrying > 0) continue;
        const was = before.get(at);
        const now = after.get(at);
        if (!was || !now) continue;
        const added = [...now].filter((s) => !was.has(s));
        if (added.length === 0) continue;
        drops++;
        for (const s of added) {
          const under = below(s);
          if (under < 0 || added.includes(under)) continue;
          // On a layer whole before it came: the one under it and its neighbour.
          onTop++;
          expect(was.has(under)).toBe(true);
          expect(was.has(under ^ 1)).toBe(true);
        }
      }
    }
    expect(drops).toBeGreaterThan(10);
    expect(onTop).toBeGreaterThan(0);
  }, 120_000);

  it('stay drawn just where they were set down as others are set down and taken, never shuffled', () => {
    const world: Any = wharf(4, 2);
    const structures = new Structures(world.map, true);
    const scene = new Group();
    scene.add(structures.group);
    // Every crate shown in storage and on the truck bays' stacks, where it
    // is drawn and what it shows.
    const shown = () => {
      const out = new Map<Object3D, string>();
      structures.group.traverse((o) => {
        if (!o.userData.size || !o.visible) return;
        for (let p: Object3D | null = o.parent; p; p = p.parent) if (!p.visible) return;
        const at = o.getWorldPosition(new Vector3());
        out.set(o, `${at.x.toFixed(3)},${at.y.toFixed(3)},${at.z.toFixed(3)} ${o.userData.icon}`);
      });
      return out;
    };
    const held = () => {
      let n = 0;
      for (const b of world.bays.values()) {
        if (!b.yard) n += b.crates.length + (b.exports?.length ?? 0);
      }
      return n;
    };
    let was = new Map<Object3D, string>();
    let count = held();
    let changes = 0;
    for (let t = 0; t < TICKS_PER_DAY * 3; t++) {
      world.step();
      const s = world.snapshot();
      structures.setBays(s.bays);
      scene.updateMatrixWorld(true);
      const now = shown();
      const n = held();
      // Those still shown are where they were and as they were; only as
      // many came and went as were set down and taken this tick.
      const gone = [...was.keys()].filter((o) => !now.has(o)).length;
      const come = [...now.keys()].filter((o) => !was.has(o)).length;
      for (const [o, look] of now) {
        if (!was.has(o)) continue;
        const [at] = look.split(' ');
        expect(was.get(o)!.split(' ')[0]).toBe(at);
        // Painted with what it holds as it is set down; the same after.
        if (!was.get(o)!.endsWith(' fish')) expect(look).toBe(was.get(o));
      }
      if (gone + come > 0) changes++;
      // A jib crane's crate shows as it lets go, a tick before the game has it.
      expect(Math.abs(come - gone - (n - count))).toBeLessThanOrEqual(1);
      expect(gone).toBeLessThanOrEqual(Math.max(0, count - n) + 4);
      was = now;
      count = n;
    }
    expect(changes).toBeGreaterThan(50);
  }, 180_000);

  it('keep their slots through a save and load', () => {
    const world: Any = wharf(4, 2);
    for (let t = 0; t < TICKS_PER_DAY * 2; t++) world.step();
    const slots = taken(world);
    expect([...slots.values()].some((s) => s.size > 0)).toBe(true);
    const back = World.fromSave(JSON.parse(JSON.stringify(world.toSave())));
    for (const [idx, s] of slots) {
      const b = back.bays.get(idx)!;
      expect(b.crateSlots ?? []).toEqual(world.bays.get(idx).crateSlots ?? []);
      expect(new Set([...(b.crateSlots ?? []), ...(b.outSlots ?? [])])).toEqual(s);
    }
  });
});
