import { describe, expect, it } from 'vitest';
import { Box3, Group, Vector3, type Object3D } from 'three';
import { CRANE_LIFT_SET, CRANE_LIFT_TAKEN } from '../src/sim/balance';
import { FACING, placementError } from '../src/sim/rules';
import { Build, TICKS_PER_DAY } from '../src/sim/types';
import { World } from '../src/sim/world';
import { Entities, turnAbout } from '../src/render/entities';
import { settle, Structures } from '../src/render/structures';
import { surfaceY } from '../src/render/terrain';

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
  it('have a crate down on the ground as it leaves or reaches their hands', () => {
    const world = World.create(7, 96);
    const entities = new Entities(world.map);
    const crate = new Vector3();
    const held = new Map<number, { shown: boolean; y: number; truck: boolean }>();
    let handed = 0;
    for (let t = 0, now = 0; t < 800; t++) {
      world.step();
      const s = world.snapshot();
      entities.push(s.entities, now, s.tick);
      for (let f = 0; f < 6; f++) {
        now += 100 / 6;
        entities.update(now, now / 1000);
        for (const { view, pos } of entities.worldPositions()) {
          if (view.kind !== 'dockhand') continue;
          const shown = entities.slotShown(view.id, 0);
          const y = entities.slotPosition(view.id, 0, crate)!.y - pos.y;
          const was = held.get(view.id);
          // Onto a truck, it goes up onto the bed; see the trucks below.
          if (was && was.shown !== shown && !was.truck) {
            handed++;
            expect(Math.min(y, was.y)).toBeLessThan(0.01);
          }
          const truck = s.entities.some((e) => e.id === view.handAt?.truck && e.kind === 'truck');
          held.set(view.id, { shown, y, truck });
        }
      }
    }
    expect(handed).toBeGreaterThan(4);
  });

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
    const last = new Map<number, [number, number]>();
    let handled = 0;
    for (let t = 0, now = 0; t < 800; t++) {
      world.step();
      const s = world.snapshot();
      entities.push(s.entities, now, s.tick);
      for (let f = 0; f < 6; f++) {
        now += 100 / 6;
        entities.update(now, now / 1000);
        for (const { view, pos } of entities.worldPositions()) {
          if (view.kind !== 'dockhand') continue;
          if (view.handStage) handled++;
          const was = last.get(view.id);
          // A brisk walk at most: half as fast again as they walk.
          if (was) expect(Math.hypot(pos.x - was[0], pos.z - was[1])).toBeLessThan(0.0601);
          last.set(view.id, [pos.x, pos.z]);
        }
      }
    }
    expect(handled).toBeGreaterThan(50);
  });
});

describe('Jib cranes', () => {
  it('lift each crate off the boat on the hook and set it down on the stack, never showing it nowhere', () => {
    // The starting jetty paved into a quay, a jib crane on its end, a
    // forklift to take on what it lands, and no dockhands to unload the
    // boats by hand.
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
    const place = (): Object3D => parts.stack[jib.place];
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
    for (let tick = 0; tick < 120 && crane.stack.length < 9; tick++) {
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
        // On the boat, on the hook or on the stack: never on none of them.
        expect(deck.visible || jib.load.visible || place().visible).toBe(true);
        const p = jib.phase;
        if (was < CRANE_LIFT_TAKEN && p >= CRANE_LIFT_TAKEN) {
          expect(off(deck)).toBeLessThan(0.02);
          expect(deck.visible).toBe(false);
          expect(jib.load.visible).toBe(true);
          taken = jib.key;
          lifts++;
        }
        // Unless the forklift has taken from the stack meanwhile, and the
        // next place on it has moved.
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
    const m = world.map;
    const entities = new Entities(world.map);
    const bodies = new Map<number, Box3>();
    const dropping = new Map<number, { x: number; z: number; truck: number }>();
    let docked = 0;
    for (let t = 0, now = 0; t < 3000; t++) {
      world.step();
      const s = world.snapshot();
      entities.push(s.entities, now, s.tick);
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
});
