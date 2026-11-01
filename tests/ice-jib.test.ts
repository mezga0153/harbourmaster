import { describe, expect, it } from 'vitest';
import { SCENARIO_PRESETS, bayAt, patch, presetScenario, replay } from '../src/dev/scenario';
import { cargoOf, withCargo } from '../src/sim/cargo';
import { cratesAt } from '../src/sim/helpers';
import { TICKS_PER_DAY } from '../src/sim/types';
import { iceTrouble } from '../src/sim/systems/cargo/exports';
import { boatWhy, problems } from '../src/sim/systems/snapshot';
import type { World } from '../src/sim/world';
import { stockUp } from './stock';

// Fishing boats take ice on board from the truck bays the ice works' trucks
// bring it to. Dockhands carry it on, but may not walk by a crane: at a
// berth under a jib crane, forklifts bring it to crate storage for cargo
// going out beside the crane, and the crane lifts it on board.

/**
 * The dev lab's jib crane preset (a quay with a jib crane over the berth,
 * crate storage for cargo coming in beside it, a dockhand and a forklift,
 * a fishing boat coming in with its catch), with a truck bay off the port
 * road holding `ice` crates of ice and, with `out`, a tile of storage for cargo going out
 * beside the crane too.
 */
function port(ice: number, out: boolean): World {
  const sc = presetScenario(SCENARIO_PRESETS.find((p) => p.id === 'jib')!);
  const w0 = replay(sc);
  const { shore, row } = patch(w0);
  if (out) {
    sc.steps.push({
      at: 0,
      cmd: { type: 'store', tiles: [w0.map.idx(shore - 1, row - 3)], kind: 'cratesOut', on: true },
    });
  }
  // A truck bay off the port road, for the forklift to get to.
  const at = w0.map.idx(shore - 4, row - 4);
  sc.steps.push({ at: 0, cmd: { type: 'build', kind: 'truckBay', tiles: [at], facing: 1 } });
  const w = replay(sc);
  const bay = bayAt(w, at)!;
  expect(bay && !bay.tiles).toBe(true);
  stockUp(w, bay, Array<number>(ice).fill(withCargo(8, 'ice')), true);
  return w;
}

const iceAboard = (w: World) =>
  w.boats.reduce(
    (n, b) => n + (b.loaded ?? []).filter((c) => c && cargoOf(c.fee, 'goods') === 'ice').length,
    0,
  );

describe('Ice for a fishing boat under a jib crane', () => {
  it('goes to storage beside the crane by forklift, and the crane lifts it on board', () => {
    const w = port(4, true);
    const { shore, row } = patch(w);
    const store = bayAt(w, w.map.idx(shore - 1, row - 3))!;
    expect(store.outgoing).toBe(true);
    let stored = 0;
    for (let t = 0; t < TICKS_PER_DAY * 2 && iceAboard(w) < 4; t++) {
      w.step();
      stored = Math.max(stored, cratesAt(store, true));
    }
    expect(stored).toBeGreaterThan(0);
    expect(iceAboard(w)).toBe(4);
    expect(w.boats[0].vessel).toBe('smack');
  });

  it('says why when nothing can bring it the ice', () => {
    const w = port(4, false);
    let why: string | undefined;
    for (let t = 0; t < TICKS_PER_DAY && !why; t++) {
      w.step();
      why = w.boats[0] && iceTrouble(w, w.boats[0]);
    }
    expect(why).toMatch(/crate storage for cargo going out beside it/);
    expect(boatWhy(w, w.boats[0])).toBe(why);
    expect(problems(w).some((p) => p.type === 'boat' && p.text === why)).toBe(true);
    expect(iceAboard(w)).toBe(0);
  });
});
