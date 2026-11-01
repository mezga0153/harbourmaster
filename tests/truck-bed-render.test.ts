import { describe, expect, it } from 'vitest';
import { Group, Vector3, type Object3D } from 'three';
import * as B from '../src/sim/balance';
import { withCargo } from '../src/sim/cargo';
import { World } from '../src/sim/world';
import { Entities } from '../src/render/entities';
import { Structures } from '../src/render/structures';
import { smallTruckHauliers } from './wharf';
import { cratesAt, stockUp } from './stock';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** A Coastal Wharf game whose only hand is a forklift, crates kept coming to its truck bay. */
function forkliftOnly(): Any {
  const world: Any = World.create(7, 96);
  world.tier = 1;
  smallTruckHauliers(world);
  const lift = world.people.find((p: Any) => p.kind === 'dockhand');
  lift.kind = 'forklift';
  lift.capacity = B.FORKLIFT_CAPACITY;
  for (const p of world.people.filter((q: Any) => q !== lift)) {
    world.command({ type: 'fire', id: p.id });
  }
  return world;
}

/** The view of a game, stepped along with it. */
function view(world: Any) {
  const m = world.map;
  const entities = new Entities(m);
  const structures = new Structures(m, true);
  structures.truckSlot = (id, k, out) => entities.slotPosition(id, k, out);
  structures.slotShown = (id, k) => entities.slotShown(id, k);
  structures.slotObject = (id, k) => entities.slotObject(id, k);
  entities.containerAt = (at, out) => structures.containerAt(at, out);
  entities.crateIn = (x, z, pad) => structures.crateIn(x, z, pad);
  const scene = new Group();
  scene.add(structures.group, entities.group);
  const entries = (entities as Any).entries as Map<number, Any>;
  return { entities, structures, scene, entries };
}

describe('Loading a truck’s bed', () => {
  it('forklifts line up side on to the places they set a load in, forks at their height, two layers high', () => {
    const world = forkliftOnly();
    const bay = [...world.bays.values()][0];
    const { entities, structures, scene, entries } = view(world);
    const was = new Map<number, { load: number; at?: Any; truck?: number }>();
    let drops = 0;
    let upper = 0;
    for (let t = 0, now = 0; t < 3000; t++) {
      if (cratesAt(bay) < 8) stockUp(world, bay, [withCargo(20, 'fish')]);
      world.step();
      const s = world.snapshot();
      entities.push(s.entities, now, s.tick);
      structures.setBays(s.bays);
      structures.setPiles(s.piles);
      for (let f = 0; f < 6; f++) {
        now += 100 / 6;
        entities.update(now, now / 1000);
        structures.update(1 / 60, now / 1000);
        scene.updateMatrixWorld(true);
        for (const e of entries.values()) {
          const v = e.view;
          if (v.kind !== 'forklift') continue;
          const w: { load: number; at?: Any; truck?: number } = was.get(v.id) ?? { load: v.load };
          if (v.handStage === 'drop' && v.handAt?.truck !== undefined && v.handAt.slots) {
            w.at = v.handAt;
            w.truck = v.handAt.truck;
          }
          // Set down onto a truck: where it lined up, as it let go.
          if (w.load > 0 && v.load === 0 && w.at && w.truck !== undefined) {
            const truck = entries.get(w.truck);
            if (truck) {
              drops++;
              const r = truck.model.root;
              const tdir = -r.rotation.y;
              const root = e.model.root;
              const dir = -root.rotation.y;
              // Square on to its side, never at its tail or cab.
              expect(Math.abs(Math.cos(dir - tdir))).toBeLessThan(0.05);
              const dx = root.position.x - r.position.x;
              const dz = root.position.z - r.position.z;
              const along = dx * Math.cos(tdir) + dz * Math.sin(tdir);
              const across = -dx * Math.sin(tdir) + dz * Math.cos(tdir);
              const box = truck.size;
              if (box) {
                expect(along).toBeGreaterThan(box.min.x - 0.05);
                expect(along).toBeLessThan(box.max.x + 0.05);
              }
              // Beside it, clear of its side.
              if (box) expect(across > box.max.z || across < box.min.z).toBe(true);
              const places: Vector3[] = w.at.slots.map((k: number) =>
                (truck.model.crates[k] as Object3D).getWorldPosition(new Vector3()),
              );
              // Forks at the height of the lowest of them.
              const forks = (e.model.forks as Object3D).getWorldPosition(new Vector3());
              const low = Math.min(...places.map((p) => p.y));
              expect(Math.abs(forks.y + 0.04 - low)).toBeLessThan(0.06);
              if (w.at.slots.some((k: number) => k >= truck.view.capacity)) upper++;
              // And they show there now, each in its place.
              for (const k of w.at.slots) expect(truck.model.crates[k].visible).toBe(true);
            }
            w.at = undefined;
            w.truck = undefined;
          }
          w.load = v.load;
          was.set(v.id, w);
        }
      }
    }
    expect(drops).toBeGreaterThan(3);
    expect(upper).toBeGreaterThan(0);
  }, 120_000);

  it('shows each crate in the place the game keeps for it, which never moves as more go on', () => {
    const world: Any = World.create(7, 96);
    const { entities, structures, scene, entries } = view(world);
    const placed = new Map<string, Vector3>();
    let checked = 0;
    for (let t = 0, now = 0; t < 2000; t++) {
      world.step();
      const s = world.snapshot();
      entities.push(s.entities, now, s.tick);
      structures.setBays(s.bays);
      structures.setPiles(s.piles);
      now += 100;
      entities.update(now, now / 1000);
      scene.updateMatrixWorld(true);
      for (const v of s.entities) {
        if (v.kind !== 'truck' || !v.bed) continue;
        const e = entries.get(v.id);
        const shown = e.model.crates
          .map((c: Object3D, k: number) => (c.visible ? k : -1))
          .filter((k: number) => k >= 0)
          .sort((a: number, b: number) => a - b);
        expect(shown).toEqual(
          v.bed
            .slice(0, v.load)
            .slice()
            .sort((a: number, b: number) => a - b),
        );
        if (v.moving) continue;
        // Where each stands on the bed, against the truck, never changes.
        const r = e.model.root;
        for (const k of v.bed) {
          const p = r.worldToLocal((e.model.crates[k] as Object3D).getWorldPosition(new Vector3()));
          const key = `${v.id}:${k}`;
          const before = placed.get(key);
          if (before) expect(p.distanceTo(before)).toBeLessThan(1e-6);
          placed.set(key, p);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  }, 60_000);
});
