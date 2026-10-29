import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { EntityView } from '../src/protocol';
import { Entities } from '../src/render/entities';
import * as B from '../src/sim/balance';
import { World } from '../src/sim/world';

/**
 * A container truck driving as the sim moves one: from tile centre to tile
 * centre at its speed, turning at the centres, on the right of the road,
 * shown at 60 frames a second between snapshots every tenth of a second.
 */
function drive(
  route: [number, number][],
  speed = 1,
  then: (e: Entities, tick: number, moving: boolean) => void,
  extra = 0,
) {
  const map = World.create(7).map;
  const entities = new Entities(map);
  let [x, y] = route[0];
  let dir = Math.atan2(route[1][1] - y, route[1][0] - x);
  const path = route.slice(1);
  const view = (moving: boolean): EntityView => ({
    id: 1,
    kind: 'truck',
    x: x - Math.sin(dir) * B.TRUCK_LANE,
    y: y + Math.cos(dir) * B.TRUCK_LANE,
    dir,
    load: 2,
    moving,
    name: '',
    activity: '',
    variant: 0,
    capacity: 2,
    alert: false,
    boxes: true,
  });
  let now = 0;
  let tick = 0;
  const step = () => {
    let budget = B.TRUCK_SPEED;
    while (budget > 1e-6 && path.length > 0) {
      const [tx, ty] = path[0];
      const d = Math.hypot(tx - x, ty - y);
      if (d > 1e-6) dir = Math.atan2(ty - y, tx - x);
      if (d <= budget) {
        [x, y] = path.shift()!;
        budget -= d;
      } else {
        x += ((tx - x) / d) * budget;
        y += ((ty - y) / d) * budget;
        budget = 0;
      }
    }
  };
  entities.push([view(true)], now, tick);
  const snaps = Math.ceil(route.length / B.TRUCK_SPEED / speed) + 4 + extra;
  for (let s = 0; s < snaps; s++) {
    for (let k = 0; k < speed; k++) step();
    tick += speed;
    const moving = path.length > 0;
    entities.push([view(moving)], now, tick);
    for (let f = 0; f < 6; f++) {
      now += 100 / 6;
      entities.update(now, now / 1000);
      then(entities, tick, moving);
    }
  }
  return entities;
}

/** The truck's tractor and trailer headings, and where the kingpin is against the fifth wheel. */
function rig(e: Entities) {
  const model = e['entries'].get(1)!.model;
  const t = model.trailer!;
  model.root.updateMatrixWorld(true);
  const wheel = model.root.localToWorld(new Vector3(t.hitch, 0, 0));
  const pin = t.root.getWorldPosition(new Vector3());
  return { bend: t.root.rotation.y, gap: wheel.distanceTo(pin), model };
}

const DEG = 180 / Math.PI;

describe('Articulated trucks', () => {
  for (const speed of [1, 4]) {
    it(`pull their trailer round a corner, at ${speed}x`, () => {
      // East along a road, then a left turn north.
      const route: [number, number][] = [];
      for (let k = 0; k <= 8; k++) route.push([k + 0.5, 10.5]);
      for (let k = 1; k <= 8; k++) route.push([8.5, 10.5 - k]);
      let most = 0;
      let gap = 0;
      const bends: number[] = [];
      drive(route, speed, (e) => {
        const r = rig(e);
        most = Math.max(most, Math.abs(r.bend));
        gap = Math.max(gap, r.gap);
        bends.push(r.bend);
      });
      // Kept on the fifth wheel, folding a fair way round the corner but
      // never too far, and straight behind again on the way out.
      expect(gap).toBeLessThan(1e-6);
      expect(most * DEG).toBeGreaterThan(20);
      expect(most * DEG).toBeLessThanOrEqual(80 + 1e-6);
      expect(Math.abs(bends.at(-1)!) * DEG).toBeLessThan(1);
      // Straight behind on the straight before the corner.
      expect(Math.abs(bends[8]) * DEG).toBeLessThan(1);
    });
  }

  it('carries its containers on the trailer as it swings', () => {
    const route: [number, number][] = [];
    for (let k = 0; k <= 6; k++) route.push([k + 0.5, 10.5]);
    for (let k = 1; k <= 6; k++) route.push([6.5, 10.5 + k]);
    let checked = 0;
    drive(route, 1, (e) => {
      const r = rig(e);
      if (Math.abs(r.bend) < 0.3) return;
      // Each container slot is where the trailer has it, not where the rig
      // would have it held straight.
      const t = r.model.trailer!;
      for (let k = 0; k < 2; k++) {
        const slot = r.model.crates[k];
        const at = e.slotPosition(1, k, new Vector3())!;
        const want = t.root.localToWorld(slot.position.clone());
        expect(at.distanceTo(want)).toBeLessThan(1e-6);
        const straight = r.model.root.localToWorld(
          slot.position.clone().add(new Vector3(t.hitch, 0, 0)),
        );
        expect(at.distanceTo(straight)).toBeGreaterThan(0.05);
        checked++;
      }
    });
    expect(checked).toBeGreaterThan(0);
  });

  it('settles straight behind once stopped mid-turn', () => {
    // Stops just round the corner.
    const route: [number, number][] = [];
    for (let k = 0; k <= 5; k++) route.push([k + 0.5, 10.5]);
    route.push([5.5, 9.5]);
    const bends: number[] = [];
    drive(route, 1, (e) => bends.push(rig(e).bend), 20);
    expect(Math.max(...bends.map(Math.abs)) * DEG).toBeGreaterThan(10);
    expect(Math.abs(bends.at(-1)!) * DEG).toBeLessThan(1);
  });

  it('does not jackknife pushed back', () => {
    // Round a corner and then straight back the way it came, still facing on.
    const map = World.create(7).map;
    const entities = new Entities(map);
    const at = (x: number, y: number, dir: number): EntityView => ({
      id: 1,
      kind: 'truck',
      x,
      y,
      dir,
      load: 0,
      moving: true,
      name: '',
      activity: '',
      variant: 0,
      capacity: 2,
      alert: false,
      boxes: true,
    });
    let now = 0;
    let tick = 0;
    let x = 5;
    let y = 5;
    let dir = 0;
    const bends: number[] = [];
    const go = (n: number, turn: number, back: boolean) => {
      for (let s = 0; s < n; s++) {
        dir += turn;
        const v = back ? -0.3 : 0.3;
        x += Math.cos(dir) * v;
        y += Math.sin(dir) * v;
        entities.push([at(x, y, dir)], now, ++tick);
        for (let f = 0; f < 6; f++) {
          now += 100 / 6;
          entities.update(now, now / 1000);
          bends.push(rig(entities).bend);
        }
      }
    };
    go(10, 0, false);
    go(6, 0.15, false);
    const turned = Math.abs(bends.at(-1)!);
    go(20, 0, true);
    expect(turned * DEG).toBeGreaterThan(8);
    expect(Math.max(...bends.slice(16 * 6).map(Math.abs))).toBeLessThanOrEqual(turned + 1e-6);
    expect(Math.abs(bends.at(-1)!) * DEG).toBeLessThan(2);
  });
});
