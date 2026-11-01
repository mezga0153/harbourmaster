import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import * as B from '../src/sim/balance';
import { placementError } from '../src/sim/rules';
import { Build, TICKS_PER_DAY } from '../src/sim/types';
import { World } from '../src/sim/world';
import { Entities, turnOf } from '../src/render/entities';
import { Structures } from '../src/render/structures';
import { addContract } from '../src/sim/systems/economy';
import { craneHeld, putOnCrane } from '../src/sim/systems/cranes';

/**
 * A two-wide pier out to water deep enough for feeders with a harbour crane
 * at its end, a container yard, a depot with two stackers and an office;
 * as tests/sim.test.ts lays out. Returns the crane's tile.
 */
function terminal(world: World): number {
  const m = world.map;
  const r = m.yOf(m.entry);
  let shore = 0;
  while (m.build[m.idx(shore + 1, r)] !== Build.Jetty) shore++;
  const start = shore - 4;
  const tiles = (row: number, x0: number, x1: number) =>
    Array.from({ length: x1 - x0 + 1 }, (_, k) => m.idx(x0 + k, row));
  for (const row of [r - 1, r - 2]) {
    world.command({ type: 'bulldoze', tiles: tiles(row, start, shore + 12) });
  }
  let end = -1;
  for (let x = shore + 1; x < m.w - 3 && end < 0; x++) {
    const out = m.idx(x, r - 3);
    if (m.isLand(m.idx(x, r - 2))) continue;
    if (m.depth[m.idx(x, r - 2)] > B.MAX_QUAY_DEPTH) break;
    if (!m.isLand(out) && m.depth[out] >= B.FEEDER_DRAFT + 0.5) end = x;
  }
  for (const row of [r - 1, r - 2]) {
    for (const i of tiles(row, start, end)) {
      world.command({ type: 'build', kind: m.isLand(i) ? 'portRoad' : 'quay', tiles: [i] });
    }
  }
  const crane = m.idx(end, r - 2);
  world.command({ type: 'build', kind: 'harbourCrane', tiles: [crane] });
  const corner = m.idx(start - 2, r - 2);
  const area = [corner, corner + 1, corner + m.w, corner + m.w + 1];
  world.command({ type: 'bulldoze', tiles: area });
  world.command({ type: 'build', kind: 'portRoad', tiles: area });
  world.command({ type: 'store', tiles: area, kind: 'boxes', on: true });
  world.command({ type: 'bulldoze', tiles: [corner - 1, corner + m.w - 1] });
  world.command({ type: 'build', kind: 'portGate', tiles: [corner + m.w - 1], facing: 1 });
  world.command({ type: 'build', kind: 'portRoad', tiles: [corner - 1] });
  // And a port road along the far side of the yard, for the stackers to
  // work its stacks from: they never drive across them.
  const round = [corner - 1 - m.w, corner - m.w, corner + 1 - m.w];
  world.command({ type: 'bulldoze', tiles: round });
  world.command({ type: 'build', kind: 'portRoad', tiles: round });
  // The machines drive out of the depot's door onto the pier, and on from
  // there round the far side of the yard.
  const link = m.idx(start, r - 3);
  const depot = link + 1;
  world.command({ type: 'bulldoze', tiles: [link, depot] });
  world.command({ type: 'build', kind: 'portRoad', tiles: [link] });
  world.command({ type: 'forkliftOnly', tiles: [link], on: true });
  world.command({ type: 'build', kind: 'depot', tiles: [depot], facing: 1 });
  const office = m.build.findIndex((_, i) => !placementError(m, 'office', i));
  world.command({ type: 'build', kind: 'office', tiles: [office] });
  // A reach stacker takes two of a depot's three places: a depot each, side by side.
  for (let k = 0; k < 3; k++) {
    world.command({ type: 'bulldoze', tiles: [depot + k] });
    world.command({ type: 'build', kind: 'depot', tiles: [depot + k], facing: 1 });
    world.command({ type: 'buyMachine', kind: 'stacker', tile: depot + k });
  }
  return crane;
}

describe('Harbour crane', () => {
  /**
   * Runs a feeder's call with the view drawn as the game goes, `frames` a
   * snapshot at `speed`, and watches the crane hand each container over.
   */
  function watch(speed: number, frames: number) {
    const world = World.create(7, 96);
    world.tier = 2;
    world.cash = 1_000_000;
    const crane = terminal(world);
    expect(world.map.build[crane]).toBe(Build.HarbourCrane);
    addContract(
      world,
      {
        kind: 'fishery',
        vessel: 'feeder',
        name: 'Test Feeders',
        color: 0,
        boatEvery: 1,
        cratesMin: 6,
        cratesMax: 6,
        fee: 150,
      },
      world.tick + 10,
      0,
    );
    for (let k = 0; k < TICKS_PER_DAY * 4; k++) {
      world.step();
      if (world.boats.some((b) => b.vessel === 'feeder' && b.state === 'moored')) break;
    }
    const structures = new Structures(world.map, true);
    const entities = new Entities(world.map);
    structures.truckSlot = (id, k, out) => entities.slotPosition(id, k, out);
    structures.slotShown = (id, k) => entities.slotShown(id, k);
    structures.slotTurn = (id, k) => entities.slotTurn(id, k);
    const c = structures['cranes'].get(crane)!;
    const h = c.mhc!;
    const sim = world.cranes.get(crane)!;
    let now = 0;
    let carried = false;
    let given = false;
    const at = new Vector3();
    const there = new Vector3();
    const seen = { lifts: new Set<string>(), nowhere: 0, twice: 0, off: 0, askew: 0 };
    for (let tick = 0; tick < 1200; tick++) {
      for (let q = 0; q < speed; q++) world.step();
      // Once the ship is empty, exports to take on board.
      const ship = world.boats.find((b) => b.vessel === 'feeder');
      if (!given && ship?.state === 'moored' && ship.crates === 0 && craneHeld(sim) <= 2) {
        for (const fee of [100, 100]) putOnCrane(world, sim, { fee, at: 0 }, true);
        given = true;
      }
      const s = world.snapshot();
      entities.push(s.entities, now, s.tick);
      structures.setSpeed(speed);
      structures.setCranes(s.cranes);
      for (let f = 0; f < frames; f++) {
        now += 100 / frames;
        entities.update(now, now / 1000);
        structures.update(0.1 / frames, now / 1000);
        const carry = h.load.visible;
        if (h.work) {
          seen.lifts.add(`${h.work} ${h.boat}:${h.slot}`);
          // On the spreader, the stack or the ship's deck: once, always.
          const places =
            (carry && h.load.userData.look === h.look ? 1 : 0) +
            c.stack.filter((o) => o.visible && o.userData.look === h.look).length +
            (structures.slotShown(h.boat, h.slot) ? 1 : 0);
          if (places === 0) seen.nowhere++;
          if (places > 1) seen.twice++;
        }
        // Taking hold of it or letting go, the spreader is right on its
        // slot on the deck or the stack, and lies along it.
        if (h.work && carry !== carried) {
          h.load.getWorldPosition(at);
          const slots = c.stack.map((o) => ({ o, d: o.getWorldPosition(there).distanceTo(at) }));
          const deck = entities.slotPosition(h.boat, h.slot, there)?.distanceTo(at) ?? 9;
          const near = slots.reduce((p, q) => (q.d < p.d ? q : p));
          const lie = deck < near.d ? entities.slotTurn(h.boat, h.slot)! : turnOf(near.o);
          if (Math.min(deck, near.d) > 0.02) seen.off++;
          if (Math.abs(Math.sin(turnOf(h.load) - lie)) > 0.02) seen.askew++;
        }
        carried = carry;
      }
    }
    return seen;
  }

  it('lifts each container from its slot on the deck to its stack and back, never losing it', () => {
    for (const [speed, frames] of [
      [1, 6],
      [4, 3],
    ]) {
      const seen = watch(speed, frames);
      const lifts = [...seen.lifts];
      expect(lifts.filter((l) => l.startsWith('unload')).length).toBeGreaterThanOrEqual(6);
      expect(lifts.filter((l) => l.startsWith('load')).length).toBe(2);
      expect(seen).toMatchObject({ nowhere: 0, twice: 0, off: 0, askew: 0 });
    }
  }, 30_000);
});
