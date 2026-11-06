import { describe, expect, it } from 'vitest';
import {
  SCENARIO_PRESETS,
  bayAt,
  isScenario,
  patch,
  presetScenario,
  replay,
} from '../src/dev/scenario';
import { cratesAt } from '../src/sim/helpers';
import { TICKS_PER_DAY } from '../src/sim/types';

// The dev lab's mini scenarios (src/dev/scenario.ts): each preset builds,
// replays the same from its JSON, and the port does what it says.

const preset = (id: string) => presetScenario(SCENARIO_PRESETS.find((p) => p.id === id)!);

describe('Mini scenarios', () => {
  it('replay the same from JSON', () => {
    for (const p of SCENARIO_PRESETS) {
      const sc = presetScenario(p);
      const json = JSON.parse(JSON.stringify(sc)) as unknown;
      expect(isScenario(json)).toBe(true);
      const a = replay(sc);
      const b = replay(json as typeof sc);
      for (let t = 0; t < 300; t++) {
        a.step();
        b.step();
      }
      // Crates set down in one tick are told apart by a count kept across games (hold.ts stamp).
      const same = (x: unknown) => JSON.stringify(x).replace(/"at":(\d+)\.\d+/g, '"at":$1');
      expect(same(b.toSave()) === same(a.toSave()), p.id).toBe(true);
    }
  });

  it('has two dockhands carry a boat’s crates to the truck bay, and a truck take them', () => {
    const w = replay(preset('hands'));
    expect(w.people.filter((p) => p.kind === 'dockhand')).toHaveLength(2);
    expect(w.boats).toHaveLength(1);
    const handled = w.stats.cratesHandled;
    let truck = false;
    for (let t = 0; t < TICKS_PER_DAY && w.stats.cratesHandled - handled < 6; t++) {
      w.step();
      truck ||= w.trucks.length > 0;
    }
    expect(w.boats.every((b) => b.crates === 0)).toBe(true);
    expect(truck).toBe(true);
  });

  it('has the forklift load the truck from the storage tile', () => {
    const w = replay(preset('forklift'));
    const { shore, row } = patch(w);
    const store = bayAt(w, w.map.idx(shore - 5, row - 3))!;
    expect(store?.tiles).toHaveLength(1);
    expect(cratesAt(store)).toBe(8);
    expect(w.people.filter((p) => p.kind === 'forklift')).toHaveLength(1);
    let truck = false;
    for (let t = 0; t < TICKS_PER_DAY && cratesAt(store) > 0; t++) {
      w.step();
      truck ||= w.trucks.length > 0;
    }
    expect(truck).toBe(true);
    expect(cratesAt(store)).toBe(0);
  });

  it('has the jib crane lift the boat’s crates into storage, and the forklift load a truck from it', () => {
    const w = replay(preset('jib'));
    const { shore, row } = patch(w);
    const store = bayAt(w, w.map.idx(shore - 1, row - 2))!;
    expect(w.cranes.size).toBe(1);
    let most = 0;
    for (let t = 0; t < TICKS_PER_DAY && (most < 6 || cratesAt(store) > 0); t++) {
      w.step();
      most = Math.max(most, cratesAt(store));
    }
    expect(most).toBe(6);
    expect(cratesAt(store)).toBe(0);
  });

  it('sets crates down in the truck bay for a dockhand to load onto a truck', () => {
    const sc = preset('empty');
    const w0 = replay(sc);
    const { shore, row } = patch(w0);
    const bay = w0.map.idx(shore - 4, row);
    sc.steps.push(
      { at: 0, lab: 'crates', tile: bay, n: 4 },
      { at: 0, lab: 'dockhand', tile: bay + 1 },
      { at: 0, lab: 'truck' },
    );
    const w = replay(sc);
    expect(cratesAt(bayAt(w, bay)!)).toBe(4);
    for (let t = 0; t < TICKS_PER_DAY && cratesAt(bayAt(w, bay)!) > 0; t++) w.step();
    expect(cratesAt(bayAt(w, bay)!)).toBe(0);
  });

  // The knot from a player's port (day 2338): the first coaster, put off
  // easing out by the fishing boat beside it, runs out along the pier's end
  // too close to the second to pass it, holding the lane the second needs.
  // Fails while they wait on each other; a way of pathing that unties it
  // makes this pass: take the .fails off then.
  it.fails('gets both coasters off the pier’s end out to sea', () => {
    const w = replay(preset('pierEnd'));
    const coasters = w.boats.filter((b) => b.vessel === 'coaster').map((b) => b.id);
    expect(coasters).toHaveLength(2);
    for (let t = 0; t < TICKS_PER_DAY && w.boats.some((b) => coasters.includes(b.id)); t++) {
      w.step();
    }
    expect(w.boats.filter((b) => coasters.includes(b.id))).toHaveLength(0);
  });
});
