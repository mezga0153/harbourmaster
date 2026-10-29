import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { Entities, turnAbout } from '../src/render/entities';
import { settle } from '../src/render/structures';
import { World } from '../src/sim/world';

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
    const world = World.create(7);
    const entities = new Entities(world.map);
    const crate = new Vector3();
    const held = new Map<number, { shown: boolean; y: number }>();
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
          if (was && was.shown !== shown) {
            handed++;
            expect(Math.min(y, was.y)).toBeLessThan(0.01);
          }
          held.set(view.id, { shown, y });
        }
      }
    }
    expect(handed).toBeGreaterThan(4);
  });
});
