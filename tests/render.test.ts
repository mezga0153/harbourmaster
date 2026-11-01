import { describe, expect, it } from 'vitest';
import { Box3, Group, Vector3, type Object3D } from 'three';
import { CRANE_LIFT_SET, CRANE_LIFT_TAKEN } from '../src/sim/balance';
import { depotDoorTrouble, FACING, frontOf, placementError } from '../src/sim/rules';
import { Build, TICKS_PER_DAY } from '../src/sim/types';
import { World } from '../src/sim/world';
import { cargoOf, withCargo } from '../src/sim/cargo';
import { Entities, turnAbout } from '../src/render/entities';
import { settle, Structures } from '../src/render/structures';
import { surfaceY } from '../src/render/terrain';
import { boat, person, truck } from '../src/render/model';
import { forklift } from '../src/render/machines';
import { CRATE } from '../src/render/models';
import { shutIn, smallTruckHauliers, wharf } from './wharf';
import { cratesAt, stockUp } from './stock';
import { cratesIn } from '../src/sim/systems/cargo/places';

describe('Container slots', () => {
  it('keeps each container in its slot as others come and go', () => {
    let order = settle([], [1, 2, 3, 4, 5]);
    expect(order).toEqual([1, 2, 3, 4, 5]);
    // The first is taken: the last moves into its slot, the rest stay put.
    order = settle(order, [2, 3, 4, 5]);
    expect(order).toEqual([5, 2, 3, 4]);
    // One comes, in any order the yard lists them: it goes on the end.
    order = settle(order, [9, 2, 3, 4, 5]);
    expect(order).toEqual([5, 2, 3, 4, 9]);
    // Two go at once, one of them the last.
    order = settle(order, [2, 4, 5]);
    expect(order).toEqual([5, 2, 4]);
    // Alike ones count as many as there are.
    expect(settle([7, 7, 8], [7, 8])).toEqual([7, 8]);
    expect(settle([], [])).toEqual([]);
  });
});

describe('Forklifts turning about', () => {
  it('back out and pull forward round onto their way, never sliding sideways', () => {
    const keep = 0.16;
    for (const face of [Math.PI, -Math.PI, 2.2, -2.2, 2.6, -2.9, 3.1]) {
      const path = turnAbout(face);
      expect(path.reach).toBeGreaterThan(0.2);
      expect(path.reach).toBeLessThan(1.5);
      // From where it stood, on its own side of the way it faced...
      const start = path.at(0);
      expect(start.ahead).toBeCloseTo(-keep * Math.sin(face), 6);
      expect(start.right).toBeCloseTo(keep * Math.cos(face), 6);
      expect(Math.cos(start.face - face)).toBeCloseTo(1, 6);
      // ...to facing ahead on its own side of the way it is going.
      const end = path.at(path.reach);
      expect(end.ahead).toBeCloseTo(0, 6);
      expect(end.right).toBeCloseTo(keep, 6);
      expect(end.face).toBeCloseTo(0, 6);
      // Always going straight forward or straight back as it faces: it
      // backs out first, then goes forward, and does not go back again.
      const n = 1000;
      let backing = true;
      for (let k = 0; k < n; k++) {
        const s0 = (path.reach * k) / n;
        const s1 = (path.reach * (k + 1)) / n;
        const a = path.at(s0);
        const b = path.at(s1);
        const dx = b.ahead + s1 - (a.ahead + s0);
        const dy = b.right - a.right;
        const d = Math.hypot(dx, dy);
        const f = (a.face + b.face) / 2;
        expect(Math.abs(Math.cos(f) * dy - Math.sin(f) * dx) / d).toBeLessThan(0.02);
        const forward = Math.cos(f) * dx + Math.sin(f) * dy > 0;
        if (forward) backing = false;
        else expect(backing).toBe(true);
      }
    }
  });
});

describe('Dockhands handling crates', () => {
  it('stay on the quay, leaning out to crates on the boats rather than stepping aboard', () => {
    const world = World.create(7, 96);
    const entities = new Entities(world.map);
    let atBoat = 0;
    for (let t = 0, now = 0; t < 800; t++) {
      world.step();
      const s = world.snapshot();
      entities.push(s.entities, now, s.tick);
      const boats = new Set(s.entities.filter((e) => e.kind === 'boat').map((e) => e.id));
      for (let f = 0; f < 6; f++) {
        now += 100 / 6;
        entities.update(now, now / 1000);
        for (const { view, pos } of entities.worldPositions()) {
          if (view.kind !== 'dockhand') continue;
          if (view.handAt?.truck !== undefined && boats.has(view.handAt.truck)) atBoat++;
          expect(surfaceY(world.map, pos.x, pos.z)).toBeGreaterThan(0);
        }
      }
    }
    expect(atBoat).toBeGreaterThan(10);
  });

  it('walk up to a crate and back onto their way, never jumping there', () => {
    const world = World.create(7, 96);
    const entities = new Entities(world.map);
    const structures = new Structures(world.map, true);
    structures.truckSlot = (id, k, out) => entities.slotPosition(id, k, out);
    structures.slotShown = (id, k) => entities.slotShown(id, k);
    structures.slotObject = (id, k) => entities.slotObject(id, k);
    entities.containerAt = (at, out) => structures.containerAt(at, out);
    const last = new Map<number, [number, number]>();
    let handled = 0;
    for (let t = 0, now = 0; t < 2000; t++) {
      world.step();
      const s = world.snapshot();
      entities.push(s.entities, now, s.tick);
      structures.setBays(s.bays);
      structures.setPiles(s.piles);
      for (let f = 0; f < 6; f++) {
        now += 100 / 6;
        entities.update(now, now / 1000);
        structures.update(1 / 60, now / 1000);
        for (const { view, pos } of entities.worldPositions()) {
          if (view.kind !== 'dockhand') continue;
          if (view.handStage) handled++;
          const was = last.get(view.id);
          // A brisk walk at most: hardly more than half as fast again as they walk.
          if (was) expect(Math.hypot(pos.x - was[0], pos.z - was[1])).toBeLessThan(0.066);
          last.set(view.id, [pos.x, pos.z]);
        }
      }
    }
    expect(handled).toBeGreaterThan(50);
  });

  it('set each crate down in its place, up on a stack or a truck, and take it from there', () => {
    const world = World.create(7, 96);
    smallTruckHauliers(world);
    const m = world.map;
    const structures = new Structures(m, true);
    const entities = new Entities(m);
    structures.truckSlot = (id, k, out) => entities.slotPosition(id, k, out);
    structures.slotShown = (id, k) => entities.slotShown(id, k);
    structures.slotObject = (id, k) => entities.slotObject(id, k);
    entities.containerAt = (at, out) => structures.containerAt(at, out);
    const scene = new Group();
    scene.add(structures.group, entities.group);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries = (entities as any).entries as Map<number, any>;
    const held = new Map<
      number,
      { shown: boolean; at: Vector3; place?: Vector3; ship?: boolean }
    >();
    let drops = 0;
    let picks = 0;
    let early = 0;
    let up = 0;
    let now = 0;
    for (let t = 0; t < 1500; t++) {
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
        for (const { view, pos } of entities.worldPositions()) {
          if (view.kind !== 'dockhand') continue;
          const e = entries.get(view.id);
          const shown = entities.slotShown(view.id, 0);
          const was = held.get(view.id);
          const at = entities.slotPosition(view.id, 0, new Vector3())!;
          // Let go of: it was where it goes.
          if (was?.shown && !shown && was.place) {
            drops++;
            if (was.place.y - pos.y > 0.05) up++;
            expect(was.at.distanceTo(was.place)).toBeLessThan(0.03);
          }
          // Taken up off a stack: it is where it lay. Off a boat it is in
          // their hands as it changes hands.
          if (was && !was.shown && shown && was.place && !was.ship) {
            picks++;
            expect(at.distanceTo(was.place)).toBeLessThan(0.05);
          }
          // Off a boat, while they bend to it: on the deck, not in their
          // hands as well.
          const off = view.handStage === 'pick' ? view.handAt?.truck : undefined;
          if (off !== undefined) {
            early++;
            expect(shown && entities.slotShown(off, view.handAt!.slot ?? 0)).toBe(false);
          }
          const ship = off !== undefined || (!!was?.ship && !view.handStage);
          held.set(view.id, { shown, at, place: e.hand?.place?.clone(), ship });
        }
      }
    }
    expect(drops).toBeGreaterThan(10);
    expect(early).toBeGreaterThan(50);
    // Some onto others, up off the ground.
    expect(up).toBeGreaterThan(0);
  });

  it('unload the near side of a boat first, and load the far side of a truck first', () => {
    const world = World.create(7, 96);
    smallTruckHauliers(world);
    const m = world.map;
    const structures = new Structures(m, true);
    const entities = new Entities(m);
    structures.truckSlot = (id, k, out) => entities.slotPosition(id, k, out);
    structures.slotShown = (id, k) => entities.slotShown(id, k);
    structures.slotObject = (id, k) => entities.slotObject(id, k);
    entities.containerAt = (at, out) => structures.containerAt(at, out);
    const seen = new Set<string>();
    const near = { boat: [0, 0], truck: [0, 0] };
    const p = new Vector3();
    let now = 0;
    for (let t = 0; t < 2500; t++) {
      world.step();
      const s = world.snapshot();
      entities.push(s.entities, now, s.tick);
      structures.setBays(s.bays);
      structures.setPiles(s.piles);
      for (let f = 0; f < 6; f++) {
        now += 100 / 6;
        entities.update(now, now / 1000);
        structures.update(1 / 60, now / 1000);
      }
      for (const { view, pos } of entities.worldPositions()) {
        const at = view.handAt;
        // Once they stand at it.
        if (view.kind !== 'dockhand' || at?.truck === undefined || (view.handPhase ?? 0) < 0.75) {
          continue;
        }
        const other = s.entities.find((e) => e.id === at.truck);
        if (!other) continue;
        const key = `${view.id}:${at.truck}:${at.slot}:${view.handStage}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // How far each of its places is from the dockhand at it.
        const d = (k: number) => entities.slotPosition(at.truck!, k, p)!.distanceTo(pos);
        const slots = [...Array(other.capacity).keys()];
        const mine = d(at.slot ?? 0);
        if (other.kind === 'boat' && view.handStage === 'pick') {
          // Of those still on board, among the nearer half.
          const on = slots.filter((k) => entities.slotShown(at.truck!, k));
          near.boat[1]++;
          if (on.filter((k) => d(k) < mine - 1e-6).length <= on.length / 2) near.boat[0]++;
        } else if (other.kind === 'truck' && view.handStage === 'drop') {
          // Of the places still free, among the farther half.
          const free = slots.filter((k) => !entities.slotShown(at.truck!, k));
          near.truck[1]++;
          if (free.filter((k) => d(k) > mine + 1e-6).length <= free.length / 2) near.truck[0]++;
        }
      }
    }
    expect(near.boat[1]).toBeGreaterThan(10);
    // The near side first, if not always the very one nearest them along it.
    expect(near.boat[0] / near.boat[1]).toBeGreaterThan(0.75);
    expect(near.truck[1]).toBeGreaterThan(5);
    expect(near.truck[0] / near.truck[1]).toBeGreaterThan(0.9);
  });

  it('leave the crates on a boat where they lie as it comes alongside, and stack a truck bay from the front', () => {
    const world = World.create(7, 96);
    const m = world.map;
    const structures = new Structures(m, true);
    const entities = new Entities(m);
    structures.truckSlot = (id, k, out) => entities.slotPosition(id, k, out);
    structures.slotShown = (id, k) => entities.slotShown(id, k);
    structures.slotObject = (id, k) => entities.slotObject(id, k);
    entities.containerAt = (at, out) => structures.containerAt(at, out);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries = (entities as any).entries as Map<number, any>;
    const shown = new Map<number, { load: number; on: string }>();
    let still = 0;
    let stacked = 0;
    const p = new Vector3();
    const q = new Vector3();
    let now = 0;
    for (let t = 0; t < 2000; t++) {
      world.step();
      const s = world.snapshot();
      entities.push(s.entities, now, s.tick);
      structures.setBays(s.bays);
      structures.setPiles(s.piles);
      for (const v of s.entities) {
        if (v.kind !== 'boat') continue;
        const on = entries
          .get(v.id)!
          .model.crates.map((c: Object3D) => (c.visible ? 1 : 0))
          .join('');
        const was = shown.get(v.id);
        // With as many on board, the same ones show.
        if (was && was.load === v.load) {
          still++;
          expect(on).toBe(was.on);
        }
        shown.set(v.id, { load: v.load, on });
      }
      for (let f = 0; f < 6; f++) {
        now += 100 / 6;
        entities.update(now, now / 1000);
        structures.update(1 / 60, now / 1000);
      }
      for (const { view, pos } of entities.worldPositions()) {
        const at = view.handAt;
        if (view.kind !== 'dockhand' || view.handStage !== 'drop' || at?.bay === undefined)
          continue;
        // The front row, stacked to the top before the row behind it.
        if ((view.handPhase ?? 0) < 0.75 || (at.slot ?? 0) >= 8) continue;
        // Onto the front row while the back row behind it, nearer them, is free.
        structures.containerAt({ bay: at.bay, slot: at.slot }, p);
        structures.containerAt({ bay: at.bay, slot: (at.slot ?? 0) + 8 }, q);
        expect(p.distanceTo(pos)).toBeGreaterThan(q.distanceTo(pos));
        stacked++;
      }
    }
    expect(still).toBeGreaterThan(1000);
    expect(stacked).toBeGreaterThan(2);
  });

  it('stand still when they stand about together, rather than jostle', () => {
    const world = World.create(7, 96);
    const m = world.map;
    const entities = new Entities(world.map);
    const still = new Map<number, number>();
    const last = new Map<number, [number, number, number]>();
    let checked = 0;
    for (let t = 0, now = 0; t < 1500; t++) {
      world.step();
      const s = world.snapshot();
      entities.push(s.entities, now, s.tick);
      for (const v of s.entities) {
        if (v.kind !== 'dockhand') continue;
        const idle = !v.moving && !v.handStage;
        still.set(v.id, idle ? (still.get(v.id) ?? 0) + 1 : 0);
      }
      for (let f = 0; f < 6; f++) {
        now += 100 / 6;
        entities.update(now, now / 1000);
        for (const { view, pos } of entities.worldPositions()) {
          if (view.kind !== 'dockhand') continue;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const yaw = (entities as any).entries.get(view.id).model.root.rotation.y;
          const was = last.get(view.id);
          last.set(view.id, [pos.x, pos.z, yaw]);
          // Two seconds standing there: settled. Unless in a truck bay, where
          // they step out of the way of a truck coming in.
          if (!was || (still.get(view.id) ?? 0) < 20) continue;
          const tile = m.idx(Math.floor(view.x), Math.floor(view.y));
          if (m.build[tile] === Build.TruckBay) continue;
          checked++;
          expect(Math.hypot(pos.x - was[0], pos.z - was[1])).toBeLessThan(0.002);
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('keep a step apart when they stand about', () => {
    const world = World.create(7, 96);
    const entities = new Entities(world.map);
    const still = new Map<number, number>();
    let pairs = 0;
    for (let t = 0, now = 0; t < 1500; t++) {
      world.step();
      const s = world.snapshot();
      entities.push(s.entities, now, s.tick);
      for (let f = 0; f < 6; f++) {
        now += 100 / 6;
        entities.update(now, now / 1000);
        const crew = entities.worldPositions().filter((w) => w.view.kind === 'dockhand');
        for (const { view } of crew) {
          const idle = !view.moving && !view.handStage;
          still.set(view.id, idle ? (still.get(view.id) ?? 0) + 1 : 0);
        }
        // Once they have stood a second.
        const idle = crew.filter((w) => (still.get(w.view.id) ?? 0) > 60);
        for (let i = 0; i < idle.length; i++) {
          for (let j = i + 1; j < idle.length; j++) {
            pairs++;
            const [a, b] = [idle[i].pos, idle[j].pos];
            expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(0.18);
          }
        }
      }
    }
    expect(pairs).toBeGreaterThan(1000);
  });
});

describe('Jib cranes', () => {
  it('lift each crate off the boat on the hook and set it down in the storage beside them, never showing it nowhere', () => {
    // The starting jetty paved into a quay, a jib crane on its end with
    // crate storage beside it to swing crates into, a forklift to take
    // them on, and no dockhands to unload the boats by hand.
    const world = World.create(7, 96);
    world.boats.length = 0;
    world.tier = 1;
    world.cash = 100_000;
    const m = world.map;
    const r = m.yOf(m.entry);
    const jetty = [...m.build.keys()].filter((i) => m.yOf(i) === r && m.build[i] === Build.Jetty);
    world.command({ type: 'build', kind: 'quay', tiles: jetty });
    const paths = [...m.build.keys()].filter((i) => m.build[i] === Build.Footpath);
    world.command({ type: 'build', kind: 'portRoad', tiles: paths });
    const office = m.build.findIndex((_, i) => !placementError(m, 'office', i));
    world.command({ type: 'build', kind: 'office', tiles: [office] });
    const tip = jetty[jetty.length - 1];
    world.command({ type: 'build', kind: 'jibCrane', tiles: [tip] });
    const store = jetty[jetty.length - 2];
    world.command({ type: 'store', tiles: [store], kind: 'crates', on: true });
    const depot = m.build.findIndex((_, i) => !placementError(m, 'depot', i));
    world.command({ type: 'build', kind: 'depot', tiles: [depot] });
    world.command({ type: 'buyMachine', kind: 'forklift', tile: depot });
    for (const p of world.people.filter((q) => q.kind === 'dockhand')) {
      world.command({ type: 'fire', id: p.id });
    }
    const crane = world.cranes.get(tip)!;
    for (let t = 0; t < TICKS_PER_DAY * 4 && !crane.busy; t++) world.step();
    expect(crane.busy).toBe(true);

    const structures = new Structures(m, true);
    const entities = new Entities(m);
    structures.truckSlot = (id, k, out) => entities.slotPosition(id, k, out);
    structures.slotShown = (id, k) => entities.slotShown(id, k);
    structures.slotObject = (id, k) => entities.slotObject(id, k);
    const scene = new Group();
    scene.add(structures.group, entities.group);
    const parts = (structures as unknown as { cranes: Map<number, any> }).cranes.get(tip)!;
    const jib = parts.jib;
    const stock = (structures as unknown as { stock: any }).stock;
    const place = (): Object3D => stock.crateIn(jib.store, jib.pile, jib.place);
    const hook = new Vector3();
    const at = new Vector3();
    // How far the hook is from coming down square on top of a crate.
    const off = (o: Object3D) => {
      parts.hook.getWorldPosition(hook);
      o.getWorldPosition(at);
      const size = o.children[0].scale.x * o.getWorldScale(new Vector3()).x;
      const flat = Math.hypot(hook.x - at.x, hook.z - at.z);
      return Math.max(flat, Math.abs(hook.y - 0.05 - (at.y + size)));
    };
    let now = 0;
    let lifts = 0;
    let was = 0;
    let taken = '';
    const stored = () => (world.bays.has(store) ? cratesAt(world.bays.get(store)!) : 0);
    for (let tick = 0; tick < 120 && stored() < 9; tick++) {
      world.step();
      const s = world.snapshot();
      entities.push(s.entities, now, s.tick);
      structures.setBays(s.bays);
      structures.setPiles(s.piles);
      structures.setCranes(s.cranes);
      for (let f = 0; f < 6; f++) {
        const dt = 1 / 60;
        now += dt * 1000;
        entities.update(now, now / 1000);
        structures.update(dt, now / 1000);
        scene.updateMatrixWorld(true);
        if (!jib.work) continue;
        const deck: Object3D = entities.slotObject(jib.boat, jib.slot)!;
        // On the boat, on the hook or in storage: never on none of them.
        expect(deck.visible || jib.load.visible || place().visible).toBe(true);
        const p = jib.phase;
        if (was < CRANE_LIFT_TAKEN && p >= CRANE_LIFT_TAKEN) {
          expect(off(deck)).toBeLessThan(0.02);
          expect(deck.visible).toBe(false);
          expect(jib.load.visible).toBe(true);
          taken = jib.key;
          lifts++;
        }
        // Unless the forklift has taken from the storage meanwhile, and the
        // next place in it has moved.
        if (was < CRANE_LIFT_SET && p >= CRANE_LIFT_SET && jib.key === taken) {
          expect(off(place())).toBeLessThan(0.02);
          expect(place().visible).toBe(true);
          expect(jib.load.visible).toBe(false);
        }
        was = p;
      }
    }
    expect(lifts).toBeGreaterThanOrEqual(5);
  });
});

describe('Trucks at a truck bay', () => {
  it('back in to stand away from the crates, and are loaded from beside them, never through them', () => {
    const world = World.create(7, 96);
    smallTruckHauliers(world);
    const m = world.map;
    const entities = new Entities(world.map);
    const structures = new Structures(m, true);
    structures.truckSlot = (id, k, out) => entities.slotPosition(id, k, out);
    structures.slotShown = (id, k) => entities.slotShown(id, k);
    structures.slotObject = (id, k) => entities.slotObject(id, k);
    entities.containerAt = (at, out) => structures.containerAt(at, out);
    const bodies = new Map<number, Box3>();
    const dropping = new Map<number, { x: number; z: number; truck: number }>();
    let docked = 0;
    for (let t = 0, now = 0; t < 3000; t++) {
      world.step();
      const s = world.snapshot();
      entities.push(s.entities, now, s.tick);
      structures.setBays(s.bays);
      structures.setPiles(s.piles);
      for (const v of s.entities) {
        if (v.kind !== 'truck' || !/^Loading/.test(v.activity ?? '')) continue;
        const bay = s.bays.find(
          (b) => Math.floor(v.x) === m.xOf(b.idx) && Math.floor(v.y) === m.yOf(b.idx),
        );
        if (!bay) continue;
        // Facing out of the entrance, on the side away from the crates.
        const [fx, fy] = FACING[m.orient[bay.idx] & 3];
        expect(Math.cos(v.dir - Math.atan2(fy, fx))).toBeGreaterThan(0.99);
        const [cx, cy] = [fy, -fx];
        expect((v.x - m.xOf(bay.idx) - 0.5) * cx + (v.y - m.yOf(bay.idx) - 0.5) * cy).toBeLessThan(
          -0.1,
        );
        docked++;
      }
      for (let f = 0; f < 6; f++) {
        now += 100 / 6;
        entities.update(now, now / 1000);
        structures.update(1 / 60, now / 1000);
        const shown = new Map(entities.worldPositions().map((p) => [p.view.id, p]));
        for (const { view, pos } of shown.values()) {
          if (view.kind !== 'dockhand') continue;
          const to = view.handStage === 'drop' ? shown.get(view.handAt?.truck ?? -1) : undefined;
          if (to?.view.kind === 'truck') {
            dropping.set(view.id, { x: pos.x, z: pos.z, truck: to.view.id });
            continue;
          }
          const was = dropping.get(view.id);
          dropping.delete(view.id);
          const truck = was && shown.get(was.truck);
          if (!was || !truck) continue;
          // As the crate went onto the truck, they stood clear of it.
          const root = entities.group.children.find((c) => c.position === truck.pos)!;
          let body = bodies.get(truck.view.id);
          if (!body) {
            const turn = root.rotation.y;
            const at = root.position.clone();
            root.position.set(0, 0, 0);
            root.rotation.y = 0;
            root.updateMatrixWorld(true);
            body = new Box3().setFromObject(root);
            root.position.copy(at);
            root.rotation.y = turn;
            root.updateMatrixWorld(true);
            bodies.set(truck.view.id, body);
          }
          const dir = -root.rotation.y;
          const px = was.x - truck.pos.x;
          const pz = was.z - truck.pos.z;
          const along = px * Math.cos(dir) + pz * Math.sin(dir);
          const across = -px * Math.sin(dir) + pz * Math.cos(dir);
          const outside =
            along < body.min.x - 0.05 ||
            along > body.max.x + 0.05 ||
            across < body.min.z - 0.05 ||
            across > body.max.z + 0.05;
          expect(outside).toBe(true);
        }
      }
    }
    expect(docked).toBeGreaterThan(20);
  });

  it('are walked round by dockhands, never through, who set each crate down in its place on the bed', () => {
    const world = World.create(7, 96);
    smallTruckHauliers(world);
    const m = world.map;
    const entities = new Entities(m);
    const structures = new Structures(m, true);
    structures.truckSlot = (id, k, out) => entities.slotPosition(id, k, out);
    structures.slotShown = (id, k) => entities.slotShown(id, k);
    structures.slotObject = (id, k) => entities.slotObject(id, k);
    entities.containerAt = (at, out) => structures.containerAt(at, out);
    const scene = new Group();
    scene.add(structures.group, entities.group);
    const entries = (entities as unknown as { entries: Map<number, any> }).entries;
    // How long each truck has stood where it is, in snapshots.
    const still = new Map<number, number>();
    const held = new Map<
      number,
      { shown: boolean; at: Vector3; bed?: { truck: number; slot: number } }
    >();
    let beside = 0;
    for (let t = 0, now = 0; t < 2500; t++) {
      world.step();
      const s = world.snapshot();
      entities.push(s.entities, now, s.tick);
      structures.setBays(s.bays);
      structures.setPiles(s.piles);
      for (const v of s.entities) {
        if (v.kind === 'truck') still.set(v.id, v.moving ? 0 : (still.get(v.id) ?? 0) + 1);
      }
      for (let f = 0; f < 6; f++) {
        now += 100 / 6;
        entities.update(now, now / 1000);
        structures.update(1 / 60, now / 1000);
        scene.updateMatrixWorld(true);
        for (const e of entries.values()) {
          if (e.view.kind !== 'dockhand') continue;
          const p = e.model.root.position;
          for (const truck of entries.values()) {
            if (truck.view.kind !== 'truck' || (still.get(truck.view.id) ?? 0) < 10) continue;
            const r = truck.model.root;
            const body = truck.size as Box3 | undefined;
            if (!body) continue;
            const dir = -r.rotation.y;
            const dx = p.x - r.position.x;
            const dz = p.z - r.position.z;
            const along = dx * Math.cos(dir) + dz * Math.sin(dir);
            const across = -dx * Math.sin(dir) + dz * Math.cos(dir);
            const inside =
              along > body.min.x &&
              along < body.max.x &&
              across > body.min.z &&
              across < body.max.z;
            expect(inside).toBe(false);
            // Nor across the front of its cab: round its back.
            const ahead =
              along > body.max.x &&
              along < body.max.x + 0.3 &&
              across > body.min.z &&
              across < body.max.z;
            expect(ahead).toBe(false);
            beside++;
          }
          // The crate leaves their hands just where it shows on the truck.
          const load = e.model.crates[0];
          const was = held.get(e.view.id);
          if (was?.shown && !load.visible && was.bed) {
            const slot = entries.get(was.bed.truck)?.model.crates[was.bed.slot];
            if (slot)
              expect(slot.getWorldPosition(new Vector3()).distanceTo(was.at)).toBeLessThan(0.03);
          }
          held.set(e.view.id, {
            shown: load.visible,
            at: load.getWorldPosition(new Vector3()),
            bed: e.hand?.bed,
          });
        }
      }
    }
    expect(beside).toBeGreaterThan(100);
  }, 60_000);
});

/**
 * The starting jetty paved into a quay with a jib crane at its tip and
 * crate storage beside it, no dockhands unless `hands`, and a depot of
 * forklifts: they take the crates the crane swings into storage on to the
 * truck bay, and onto the trucks there.
 */
function forkPort(hands = false): World {
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
  for (const p of world.people.filter((q) => q.kind === 'dockhand' && !hands)) {
    world.command({ type: 'fire', id: p.id });
  }
  // Its door onto a port road.
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
  expect(world.people.filter((p) => p.kind === 'forklift')).toHaveLength(2);
  return world;
}

describe('Forklifts handling crates', () => {
  /** Points of a forklift's body, ahead of and to the right of its middle; not its forks. */
  const BODY: [number, number][] = [
    [0.18, -0.15],
    [0.18, 0],
    [0.18, 0.15],
    [-0.04, -0.15],
    [-0.04, 0.15],
    [-0.26, -0.15],
    [-0.26, 0],
    [-0.26, 0.15],
  ];

  it('line up square, drive in with the forks at the height of the load, take it off the top, and keep off trucks and crates', () => {
    const world = forkPort();
    const m = world.map;
    const structures = new Structures(m, true);
    const entities = new Entities(m);
    structures.truckSlot = (id, k, out) => entities.slotPosition(id, k, out);
    structures.slotShown = (id, k) => entities.slotShown(id, k);
    structures.slotObject = (id, k) => entities.slotObject(id, k);
    entities.containerAt = (at, out) => structures.containerAt(at, out);
    entities.crateIn = (x, z, pad) => structures.crateIn(x, z, pad);
    const scene = new Group();
    scene.add(structures.group, entities.group);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries = (entities as any).entries as Map<number, any>;
    const shows = (o: Object3D) => {
      for (let p: Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
      return true;
    };
    // Every crate a forklift may take or set down: in storage, at the truck
    // bay, on the trucks.
    const cratesShown = () => {
      const at = new Map<Object3D, Vector3>();
      const add = (c: Object3D) => shows(c) && at.set(c, c.getWorldPosition(new Vector3()));
      structures.group.traverse((o) => o.userData.size && add(o));
      for (const e of entries.values()) if (e.view.kind === 'truck') e.model.crates.forEach(add);
      return at;
    };
    const still = new Map<number, number>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type Seen = { load: number; lined: boolean; plan?: any };
    const was = new Map<number, Seen>();
    let shown = new Map<Object3D, Vector3>();
    let hands = 0;
    let high = 0;
    let onTrucks = 0;
    let driving = 0;
    let inTrucks = 0;
    let inCrates = 0;
    for (let t = 0, now = 0; t < TICKS_PER_DAY * 6; t++) {
      world.step();
      const s = world.snapshot();
      entities.push(s.entities, now, s.tick);
      structures.setBays(s.bays);
      structures.setPiles(s.piles);
      for (const v of s.entities) {
        if (v.kind === 'truck') still.set(v.id, v.moving ? 0 : (still.get(v.id) ?? 0) + 1);
      }
      for (let f = 0; f < 6; f++) {
        now += 100 / 6;
        entities.update(now, now / 1000);
        structures.update(1 / 60, now / 1000);
        scene.updateMatrixWorld(true);
        const crates = cratesShown();
        for (const e of entries.values()) {
          const v = e.view;
          if (v.kind !== 'forklift') continue;
          const root = e.model.root;
          const dir = -root.rotation.y;
          const w: Seen = was.get(v.id) ?? { load: v.load, lined: false };
          // As it was the frame before: going straight on to the next load,
          // it has a new one by the time this shows the last change hands.
          const plan = w.plan;
          // Lined up square on to it, back from it, before driving in.
          if (e.hand?.plan && v.handStage) {
            const p = e.hand.plan;
            const d = Math.hypot(root.position.x - p.line.x, root.position.z - p.line.z);
            if (d < 0.02 && Math.cos(dir - p.line.dir) > 0.9999 && p === w.plan) w.lined = true;
          }
          if (v.load !== w.load && plan) {
            // The load changed hands: up to it, forks under it, square on.
            const pick = v.load > w.load;
            const moved = (pick ? [...shown] : [...crates]).filter(
              ([c, p]) =>
                !(pick ? crates : shown).has(c) &&
                Math.hypot(p.x - root.position.x, p.z - root.position.z) < 1,
            );
            expect(moved.length).toBeGreaterThan(0);
            hands++;
            if (plan.line.x !== plan.goal.x || plan.line.z !== plan.goal.z) {
              expect(w.lined).toBe(true);
            }
            expect(
              Math.hypot(root.position.x - plan.goal.x, root.position.z - plan.goal.z),
            ).toBeLessThan(0.01);
            const [c0] = moved[0];
            c0.updateWorldMatrix(true, false);
            const el = c0.matrixWorld.elements;
            expect(Math.abs(Math.sin(2 * (dir - Math.atan2(el[2], el[0]))))).toBeLessThan(0.01);
            // The forks at the height of the lowest of them, the pallet among them.
            const forks = e.model.forks.getWorldPosition(new Vector3());
            const low = Math.min(...moved.map(([, p]) => p.y));
            expect(Math.abs(forks.y + 0.04 - low)).toBeLessThan(0.03);
            if (low - surfaceY(m, root.position.x, root.position.z) > 0.1) high++;
            const pallet = e.model.forks.localToWorld(new Vector3(0.3, 0, 0));
            const near = Math.min(
              ...moved.map(([, p]) => Math.hypot(p.x - pallet.x, p.z - pallet.z)),
            );
            // Under them, or as near as it gets from a truck's tail with the
            // bay's stack beside it in the way of coming at it side on.
            expect(near).toBeLessThan(0.26);
            if (moved.some(([c]) => entities.group.getObjectById(c.id))) onTrucks++;
            // Off the top: nothing left on what it took.
            if (pick) {
              for (const [, p] of crates) {
                for (const [, q] of moved) {
                  expect(Math.hypot(p.x - q.x, p.z - q.z) < 0.05 && p.y > q.y + 0.01).toBe(false);
                }
              }
            }
          }
          w.load = v.load;
          if (w.plan !== e.hand?.plan) w.lined = false;
          w.plan = e.hand?.plan;
          was.set(v.id, w);
          // Driving about, out of its depot's door: its body off the trucks
          // standing still and the crates.
          if (e.hand || e.dock || !v.moving) continue;
          driving++;
          const points = BODY.map(([a, b]) => [
            root.position.x + Math.cos(dir) * a - Math.sin(dir) * b,
            root.position.z + Math.sin(dir) * a + Math.cos(dir) * b,
          ]);
          if (points.some(([x, z]) => structures.crateIn(x, z, -0.05))) inCrates++;
          for (const truck of entries.values()) {
            if (truck.view.kind !== 'truck' || (still.get(truck.view.id) ?? 0) < 10) continue;
            const body = truck.size as Box3 | undefined;
            if (!body) continue;
            const r = truck.model.root;
            const td = -r.rotation.y;
            const hit = points.some(([x, z]) => {
              const a = (x - r.position.x) * Math.cos(td) + (z - r.position.z) * Math.sin(td);
              const b = -(x - r.position.x) * Math.sin(td) + (z - r.position.z) * Math.cos(td);
              const q = 0.05;
              return (
                a > body.min.x + q && a < body.max.x - q && b > body.min.z + q && b < body.max.z - q
              );
            });
            if (hit) inTrucks++;
          }
        }
        shown = crates;
      }
    }
    expect(hands).toBeGreaterThan(30);
    // Some up on a stack or a truck's bed, some onto the trucks.
    expect(high).toBeGreaterThan(5);
    expect(onTrucks).toBeGreaterThan(5);
    expect(driving).toBeGreaterThan(1000);
    expect(inCrates).toBe(0);
    expect(inTrucks).toBe(0);
  }, 120_000);

  /**
   * The Coastal Wharf's storage behind its gate, every tile of it full,
   * run for three days, drawn: how often a forklift's body was a little
   * into crates, of the frames it was out of its depot, and the pallet
   * places in storage it took from or set down in, as `store/place`.
   */
  function fullStorage(world: World): { frames: number; inCrates: number; places: Set<string> } {
    for (const b of world.bays.values()) {
      if (b.tiles && !b.outgoing) {
        b.cells = [];
        stockUp(
          world,
          b,
          Array.from({ length: 56 }, () => 25),
        );
      }
    }
    const m = world.map;
    const structures = new Structures(m, true);
    const entities = new Entities(m);
    structures.truckSlot = (id, k, out) => entities.slotPosition(id, k, out);
    structures.slotShown = (id, k) => entities.slotShown(id, k);
    structures.slotObject = (id, k) => entities.slotObject(id, k);
    entities.containerAt = (at, out) => structures.containerAt(at, out);
    entities.crateIn = (x, z, pad) => structures.crateIn(x, z, pad);
    const scene = new Group();
    scene.add(structures.group, entities.group);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries = (entities as any).entries as Map<number, any>;
    let frames = 0;
    let inCrates = 0;
    let hands = 0;
    const places = new Set<string>();
    const loads = new Map<number, number>();
    for (let t = 0, now = 0; t < TICKS_PER_DAY * 3; t++) {
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
          if (v.kind !== 'forklift' || v.parked || e.dock) continue;
          if (v.load !== (loads.get(v.id) ?? 0)) hands++;
          loads.set(v.id, v.load);
          if (v.handAt?.store !== undefined) places.add(`${v.handAt.store}/${v.handAt.place}`);
          // Every frame out of its depot: driving, lining up, driving in
          // and backing out; its body, not its forks, a little into one at most.
          frames++;
          const root = e.model.root;
          const dir = -root.rotation.y;
          const hit = BODY.some(([a, b]) =>
            structures.crateIn(
              root.position.x + Math.cos(dir) * a - Math.sin(dir) * b,
              root.position.z + Math.sin(dir) * a + Math.cos(dir) * b,
              -0.03,
            ),
          );
          if (hit) inCrates++;
        }
      }
    }
    expect(hands).toBeGreaterThan(30);
    expect(frames).toBeGreaterThan(5000);
    return { frames, inCrates, places };
  }

  it('keep their bodies off the crates in full crate storage they drive round, into and out of', () => {
    const { frames, inCrates } = fullStorage(wharf(4, 2));
    // A stack's back row is reached from its far end, round the stack;
    // where a truck stands there, or there is no ground, through the
    // front row once that is empty, never through its crates.
    expect(inCrates / frames).toBeLessThan(0.003);
  }, 240_000);

  it('go round to the far end of a stack for its back row, or take another, never reaching through the crates', () => {
    const world: World = wharf(4, 2);
    const tile = shutIn(world);
    const store = [...world.bays.values()].find((b) => b.tiles?.includes(tile))!;
    const { frames, inCrates, places } = fullStorage(world);
    expect(inCrates / frames).toBeLessThan(0.003);
    // The stack with ground at its south end only: its north row, the
    // first two places, taken once the south row was emptied.
    const n = store.tiles!.indexOf(tile) * 4;
    expect(places.has(`${store.idx}/${n}`) || places.has(`${store.idx}/${n + 1}`)).toBe(true);
  }, 240_000);
});

describe('Crates stacked at a truck bay or in crate storage', () => {
  /**
   * Run `world` on, drawn, with each crate set down at bay `at` painted
   * with one kind or another by turns: each crate shown stays where it is,
   * showing what it holds, as others are taken off the top or set on it.
   * Returns how many times crates were taken from where they were watched.
   */
  function watch(world: World, at: number, ticks: number): number {
    const m = world.map;
    const structures = new Structures(m, true);
    const bay = world.bays.get(at)!;
    const kinds = ['timber', 'goods', 'canned'] as const;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stacks = (structures as any).stock as { areas: Map<number, number[]> };
    const crates = () => {
      const out: Object3D[] = [];
      for (const t of stacks.areas.get(at) ?? [at]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        out.push(...((structures as any).stackAt(t)?.crates ?? []));
      }
      return out;
    };
    let painted = false;
    let was = new Map<Object3D, string>();
    let held = 0;
    let taken = 0;
    for (let t = 0; t < ticks; t++) {
      world.step();
      // Each new crate one kind or another, by turns.
      cratesIn(bay, false).forEach((c, k) => {
        if (!(kinds as readonly string[]).includes(cargoOf(c.fee))) {
          c.fee = withCargo(c.fee % 1000, kinds[k % 3]);
        }
      });
      painted ||= cratesAt(bay) > 0;
      structures.setBays(world.snapshot().bays);
      if (!painted) continue;
      const now = new Map<Object3D, string>();
      for (const c of crates()) if (c.visible) now.set(c, c.userData.icon);
      const n = cratesAt(bay) + cratesAt(bay, true);
      if (n < held) taken++;
      // Those still shown are where they were, as they were; but for one a
      // jib crane lowers in, which shows before it is set down and painted.
      if (n <= held) for (const [c, icon] of now) if (was.has(c)) expect(icon).toBe(was.get(c));
      was = now;
      held = n;
    }
    return taken;
  }

  it('leaves the rest of a truck bay stack as it was as crates are taken off the top', () => {
    const world = World.create(7, 96);
    const at = [...world.bays.values()].find((b) => world.map.build[b.idx] === Build.TruckBay)!.idx;
    expect(watch(world, at, 2500)).toBeGreaterThan(3);
  }, 60_000);

  it('leaves the rest of the crates in crate storage as they were as dockhands and forklifts take them away', () => {
    const world = forkPort(true);
    const at = [...world.bays.values()].find((b) => b.tiles)!.idx;
    expect(watch(world, at, TICKS_PER_DAY * 5)).toBeGreaterThan(3);
  }, 60_000);
});

describe("Shippers' trucks unloaded at crate storage", () => {
  /**
   * The cannery's trucks coming in to the outgoing storage of a Coastal
   * Wharf, with nothing else going on, and only `kind` to unload them.
   */
  function cannery(kind: string): World {
    const world: World = wharf(4, 2);
    for (const c of world.contracts) {
      if (c.terms.kind !== 'shipper') c.nextBoatTick = Infinity;
    }
    world.people = world.people.filter((p) => p.kind === kind);
    return world;
  }

  for (const kind of ['dockhand', 'forklift']) {
    it(`have each crate off the bed in a ${kind}'s hands, never straight into storage, and keep ${kind}s off the truck`, () => {
      const world = cannery(kind);
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entries = (entities as any).entries as Map<number, any>;
      const shows = (o: Object3D) => {
        for (let p: Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
        return true;
      };
      // Crates on the beds of shippers' trucks standing to unload, in hands, and in storage.
      const count = () => {
        let bed = 0;
        let hands = 0;
        let store = 0;
        const on = new Set<Object3D>();
        structures.group.traverse((o) => o.userData.size && shows(o) && store++);
        for (const e of entries.values()) {
          const v = e.view;
          const shown = e.model.crates.filter(shows);
          if (v.kind === 'truck' && /^(Unloading|Waiting for a dockhand)/.test(v.activity ?? '')) {
            bed += shown.length;
            for (const c of shown) on.add(c);
          } else if (v.kind === kind) hands += shown.length;
        }
        return { bed, hands, store, on };
      };
      const still = new Map<number, number>();
      let was = count();
      let off = 0;
      let set = 0;
      let near = 0;
      for (let t = 0, now = 0; t < TICKS_PER_DAY && set < 20; t++) {
        world.step();
        const s = world.snapshot();
        entities.push(s.entities, now, s.tick);
        structures.setBays(s.bays);
        structures.setPiles(s.piles);
        for (const v of s.entities) {
          if (v.kind === 'truck') still.set(v.id, v.moving ? 0 : (still.get(v.id) ?? 0) + 1);
        }
        for (let f = 0; f < 6; f++) {
          now += 100 / 6;
          entities.update(now, now / 1000);
          structures.update(1 / 60, now / 1000);
          scene.updateMatrixWorld(true);
          const c = count();
          const bed = c.bed - was.bed;
          const store = c.store - was.store;
          const hands = c.hands - was.hands;
          // Off the bed into hands, out of hands into storage: none
          // vanishes from one and turns up in the other.
          if (bed < 0 && store === 0) {
            expect(hands).toBe(-bed);
            // Off the top: the rest stay just where they were.
            for (const k of c.on) expect(was.on.has(k)).toBe(true);
            off++;
          }
          if (store > 0 && bed === 0) {
            expect(hands).toBe(-store);
            set++;
          }
          expect(bed < 0 && store > 0 && hands === 0).toBe(false);
          was = c;
          // Never on or across the front of a truck standing there.
          for (const e of entries.values()) {
            if (e.view.kind !== kind) continue;
            const p = e.model.root.position;
            for (const truck of entries.values()) {
              if (truck.view.kind !== 'truck' || (still.get(truck.view.id) ?? 0) < 10) continue;
              const r = truck.model.root;
              const body = truck.size as Box3 | undefined;
              if (!body) continue;
              const dir = -r.rotation.y;
              const dx = p.x - r.position.x;
              const dz = p.z - r.position.z;
              const along = dx * Math.cos(dir) + dz * Math.sin(dir);
              const across = -dx * Math.sin(dir) + dz * Math.cos(dir);
              const q = kind === 'forklift' ? 0.05 : 0;
              const inside =
                along > body.min.x + q &&
                along < body.max.x - q &&
                across > body.min.z + q &&
                across < body.max.z - q;
              expect(inside).toBe(false);
              if (kind === 'dockhand') {
                const ahead =
                  along > body.max.x &&
                  along < body.max.x + 0.3 &&
                  across > body.min.z &&
                  across < body.max.z;
                expect(ahead).toBe(false);
              }
              if (Math.hypot(dx, dz) < 1) near++;
            }
          }
        }
      }
      expect(off).toBeGreaterThan(kind === 'dockhand' ? 10 : 3);
      expect(set).toBeGreaterThan(kind === 'dockhand' ? 10 : 3);
      expect(near).toBeGreaterThan(50);
    }, 120_000);
  }
});

describe('Crates', () => {
  it('are one size wherever they are, so a crate handed from one place to another stays the same crate', () => {
    const world = forkPort();
    const m = world.map;
    const bay = m.build.findIndex((b, i) => b === Build.None && !placementError(m, 'truckBay', i));
    world.command({ type: 'build', kind: 'truckBay', tiles: [bay] });
    expect(m.build[bay]).toBe(Build.TruckBay);
    const structures = new Structures(m, true);
    const scene = new Group();
    scene.add(structures.group);
    // A pile left on the quay by an older game, on pallets and not.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stock = (structures as any).stock;
    const tip = m.build.findIndex((b) => b === Build.JibCrane);
    for (const pallets of [false, true]) scene.add(stock.pile(tip, pallets).group);
    // As big as it shows in the world: its body, under whatever scales it.
    const size = (o: Object3D) => {
      o.updateWorldMatrix(true, false);
      return o.children[0].scale.x * o.getWorldScale(new Vector3()).x;
    };
    const where = new Map<string, number[]>();
    const add = (name: string, crates: Object3D[]) => {
      where.set(name, [...(where.get(name) ?? []), ...crates.map(size)]);
    };
    // In a truck bay's stack, on storage pallets, the jib crane's landing
    // stack and its hook, and quay piles.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jib = (structures as any).cranes.get(tip).jib;
    structures.update(1 / 60, 0);
    const all: Object3D[] = [];
    structures.group.traverse((o) => o.userData.size && o !== jib.load && all.push(o));
    add('structures', all);
    add('jib hook', [jib.load]);
    // In dockhands' arms, however tall they are; on a forklift's forks; on
    // trucks' beds and boats' decks.
    for (let id = 0; id < 12; id++) add('dockhand', person(id).crates);
    add('forklift', forklift().crates);
    for (const cap of [2, 4, 6, 8, 10]) add('truck', truck(0, cap, false, cap).crates);
    for (const id of [1, 2, 3]) {
      add('smack', boat(0, 'smack', id).crates);
      add('lobster boat', boat(0, 'smack', id, true).crates);
      add('coaster', boat(0, 'coaster', id).crates);
    }
    expect(all.length).toBeGreaterThan(20);
    for (const [name, sizes] of where) {
      expect(sizes.length, name).toBeGreaterThan(0);
      for (const s of sizes) expect(s, name).toBeCloseTo(CRATE, 6);
    }
  });
});
