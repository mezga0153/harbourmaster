import { describe, expect, it } from 'vitest';
import * as B from '../src/sim/balance';
import { hullGap } from '../src/sim/helpers';
import type { Boat } from '../src/sim/state';
import { planDeparture, separateHull } from '../src/sim/systems/boats/navigation';
import { isPilot, DEFAULT_PILOT } from '../src/sim/systems/boats/pilots';
import { runOut } from '../src/sim/systems/boats/seamanship';
import { crowds, plot, plotCourses, underWay } from '../src/sim/systems/boats/traffic';
import { Build, Terrain } from '../src/sim/types';
import { World } from '../src/sim/world';
import { patch, presetScenario, replay, SCENARIO_PRESETS } from '../src/dev/scenario';
import { updateBoat } from '../src/sim/systems/boats/berthing';
import { depart, takeFairway } from '../src/sim/systems/boats/traffic';

function harbour() {
  const w = World.create(7, 96);
  const template = w.boats[0];
  w.boats.length = 0;
  const m = w.map;
  for (let y = 25; y < 57; y++) {
    for (let x = 60; x < 90; x++) {
      const i = m.idx(x, y);
      m.terrain[i] = Terrain.Water;
      m.ocean[i] = 1;
      m.depth[i] = 10;
      m.build[i] = Build.None;
    }
  }
  w.boatCosts.clear();
  const boat = (overrides: Partial<Boat> = {}): Boat => {
    const b: Boat = {
      ...template,
      id: 1000 + w.boats.length,
      vessel: 'coaster',
      draft: B.COASTER_DRAFT,
      x: 70.5,
      y: 40.5,
      dir: Math.PI / 2,
      state: 'leaving',
      speed: 0,
      path: [],
      berth: m.idx(70, 40),
      jetty: m.idx(69, 40),
      goal: m.idx(90, 40),
      ...overrides,
    };
    w.boats.push(b);
    return b;
  };
  const cx = (i: number) => m.xOf(i) + 0.5;
  const cy = (i: number) => m.yOf(i) + 0.5;
  const step = (b: Boat) => {
    w.tick++;
    return runOut(w, b, b.lineup!, b.lineEnd!, b.goal, cx, cy);
  };
  const gap = (a: Boat, b: Boat) =>
    hullGap(a.x, a.y, a.dir, B.VESSELS[a.vessel], b.x, b.y, b.dir, B.VESSELS[b.vessel]);
  return { w, m, boat, step, gap };
}

describe('Navigator', () => {
  it('clears a loaded-game departure stalled by a fishing boat while another coaster needs its fairway', () => {
    const w = replay(presetScenario(SCENARIO_PRESETS.find((p) => p.id === 'pierEnd')!));
    const { shore, row } = patch(w);
    const [out, waiting, fishing] = w.boats;
    expect(takeFairway(w, out, true)).toBe(true);
    depart(w, out, false);
    // The state of the player's boats near (52,43), translated to this
    // scenario's pier. The old pilot had already committed to this exit.
    Object.assign(out, {
      x: shore + 7.5,
      y: row + 0.05606704991238,
      speed: 2.9570242088272637e-15,
      held: 0,
      stall: 20,
      undock: undefined,
      turned: true,
      room: undefined,
      lineEnd: w.map.idx(shore + 7, row - 3),
      lineup: w.map.idx(shore + 7, row + 3),
      berthing: 'out',
      squeeze: 181,
    });
    Object.assign(fishing, {
      x: shore + 8.57631265950206,
      y: row + 1.91744967173685,
      dir: 2.999642720868286,
      state: 'arriving',
      speed: 0,
    });
    const ids = [out.id, waiting.id];
    const start = out.y;
    for (let t = 0; t < 1800 && w.boats.some((b) => ids.includes(b.id)); t++) {
      w.tick++;
      // Keep the fishing boat in place, as in the player's wait cycle.
      for (const b of [...w.boats]) if (ids.includes(b.id)) updateBoat(w, b);
      if (t === 150) expect(out.y).toBeLessThan(start - 1);
      for (const b of w.boats.filter((b) => ids.includes(b.id))) {
        for (const o of w.boats) {
          if (o === b) continue;
          expect(
            hullGap(b.x, b.y, b.dir, B.VESSELS[b.vessel], o.x, o.y, o.dir, B.VESSELS[o.vessel]),
          ).toBeGreaterThanOrEqual(-1e-6);
        }
      }
    }
    expect(w.boats.filter((b) => ids.includes(b.id))).toHaveLength(0);
  });

  it.each([0, 150, 600, 1800])(
    'clears the pier-end knot without hull contact, blocker waiting %i ticks',
    (wait) => {
      const sc = presetScenario(SCENARIO_PRESETS.find((p) => p.id === 'pierEnd')!);
      for (const s of sc.steps) {
        if ('lab' in s && s.lab === 'moored' && s.vessel === 'smack') s.wait = wait;
      }
      const w = replay(sc);
      const ids = w.boats.filter((b) => b.vessel === 'coaster').map((b) => b.id);
      for (let t = 0; t < 2400 && w.boats.some((b) => ids.includes(b.id)); t++) {
        w.step();
        for (let i = 0; i < w.boats.length; i++) {
          for (let j = i + 1; j < w.boats.length; j++) {
            const a = w.boats[i];
            const b = w.boats[j];
            expect(
              hullGap(a.x, a.y, a.dir, B.VESSELS[a.vessel], b.x, b.y, b.dir, B.VESSELS[b.vessel]),
            ).toBeGreaterThanOrEqual(-1e-6);
          }
        }
      }
      expect(w.boats.filter((b) => ids.includes(b.id))).toHaveLength(0);
    },
  );

  it('is the default for new and restored worlds, with legacy pilots available', () => {
    const { w } = harbour();
    expect(w.pilot).toBe(DEFAULT_PILOT);
    w.pilot = 'classic';
    expect(World.fromSave(w.toSave()).pilot).toBe('navigator');
    expect(isPilot('lookout')).toBe(true);
    expect(isPilot('toString')).toBe(false);
    expect(isPilot('__proto__')).toBe(false);
  });

  it('chooses a clear stern-first exit instead of running towards a moored hull', () => {
    const { w, m, boat } = harbour();
    const b = boat();
    boat({ y: 45, vessel: 'feeder', state: 'moored' });
    expect(planDeparture(w, b)).toBe(true);
    expect(m.yOf(b.lineup!)).toBeLessThan(40);
  });

  it('gets into its passing lane before moving along the dock', () => {
    const { w, boat, step } = harbour();
    const b = boat();
    expect(planDeparture(w, b)).toBe(true);
    const y = b.y;
    step(b);
    expect(b.x).toBeGreaterThan(70.5);
    expect(b.y).toBe(y);
    for (let t = 0; t < 180; t++) step(b);
    expect(b.x).toBeCloseTo(71.5, 1);
    expect(b.y).toBeGreaterThan(y);
  });

  it.each([
    [-1, 0, Math.PI / 2],
    [0, 1, 0],
    [0, -1, 0],
  ])('handles a dock facing (%i, %i)', (ox, oy, dir) => {
    const { w, m, boat, step } = harbour();
    const b = boat({ jetty: m.idx(70 - ox, 40 - oy), dir });
    expect(planDeparture(w, b)).toBe(true);
    for (let t = 0; t < 180; t++) step(b);
    const away = (b.x - 70.5) * ox + (b.y - 40.5) * oy;
    const along = (b.x - 70.5) * Math.cos(dir) + (b.y - 40.5) * Math.sin(dir);
    expect(away).toBeCloseTo(1, 1);
    expect(along).toBeGreaterThan(0.1);
  });

  it('rejects a sideways departure that clears the centre but clips the stern', () => {
    const { w, m, boat } = harbour();
    const b = boat();
    m.build[m.idx(71, 39)] = Build.Quay;
    expect(planDeparture(w, b)).toBe(true);
    expect(m.xOf(b.lineEnd!)).toBe(70);
  });

  it('keeps its existing plan if every exit is obstructed', () => {
    const { w, m, boat } = harbour();
    const b = boat({ lineEnd: m.idx(71, 40), lineup: m.idx(71, 46), berthing: 'out' });
    const before = [b.lineEnd, b.lineup, b.berthing];
    boat({ y: 43.5, state: 'moored' });
    boat({ y: 37.5, state: 'moored' });
    boat({ x: 71.5, state: 'moored' });
    expect(planDeparture(w, b)).toBe(false);
    expect([b.lineEnd, b.lineup, b.berthing]).toEqual(before);
  });

  it('gathers sternway without also reporting forward speed', () => {
    const { w, m, boat, step } = harbour();
    const b = boat({ x: 71.5, lineEnd: m.idx(71, 40), lineup: m.idx(71, 34), berthing: 'out' });
    for (let t = 0; t < 20; t++) {
      step(b);
      expect(b.speed).toBe(0);
    }
    expect(b.sternway).toBeGreaterThan(B.VESSELS.coaster.speed * B.BOAT_ACCEL * 10);
    expect(b.astern).toBe(true);
    expect(b.y).toBeLessThan(40.3);
    const course = plot(w, b, 1);
    expect(course[course.length - 2]).toBeLessThan(b.y);
    w.stillFor.set(b, 20);
    plotCourses(w);
    expect(underWay(w, w.plots.get(b)!)).toBe(true);
  });

  it('replans from its current position when a new boat blocks the exit', () => {
    const { w, m, boat, step, gap } = harbour();
    const b = boat({
      x: 71.5,
      castOff: m.idx(70, 40),
      castDock: m.idx(69, 40),
      berth: -1,
      jetty: -1,
      lineEnd: m.idx(71, 40),
      lineup: m.idx(71, 46),
      berthing: 'out',
      held: B.BOAT_REROUTE_AFTER,
    });
    const other = boat({ x: 71.5, y: 44, state: 'moored' });
    step(b);
    expect(m.yOf(b.lineup!)).toBeLessThan(40);
    expect(gap(b, other)).toBeGreaterThan(0);
    expect(w.boats).toHaveLength(2);
  });

  it('counts negligible forward or sternway as held up instead of hiding a deadlock', () => {
    for (const dir of [Math.PI / 2, -Math.PI / 2]) {
      const { w, m, boat, step } = harbour();
      const b = boat({
        x: 71.5,
        dir,
        lineEnd: m.idx(71, 40),
        lineup: m.idx(71, 46),
        berthing: 'out',
      });
      // A yielding boat with an arbitrarily small remaining speed allowance.
      const blockerDir = 2.999642720868286;
      const across = Math.abs(Math.sin(blockerDir - Math.PI / 2));
      const along = Math.abs(Math.cos(blockerDir - Math.PI / 2));
      const reach = (along * B.VESSELS.smack.length) / 2 + (across * B.VESSELS.smack.beam) / 2;
      boat({
        x: b.x + 1.07631265950213,
        y: b.y + B.VESSELS.coaster.length / 2 + reach + 0.08 + 1e-14,
        dir: blockerDir,
        vessel: 'smack',
        state: 'arriving',
      });
      const y = b.y;
      for (let t = 0; t < B.BOAT_REROUTE_AFTER - 1; t++) step(b);
      expect(b.held).toBeGreaterThanOrEqual(B.BOAT_REROUTE_AFTER - 1);
      expect(Math.abs(b.y - y)).toBeLessThan(1e-5);
      expect(w.pilot).toBe('navigator');
    }
  });

  it('checks the moving hull on every run-out step, even during squeeze recovery', () => {
    const { w, m, boat, step, gap } = harbour();
    const b = boat({ x: 71.5, lineEnd: m.idx(71, 40), lineup: m.idx(71, 46), berthing: 'out' });
    const other = boat({ x: 71.5, y: 43.5, state: 'arriving' });
    b.squeeze = 200;
    b.squeezePast = [other.id];
    expect(crowds(w, b, other.x, other.y)).toBe(true);
    for (let t = 0; t < 40; t++) {
      step(b);
      expect(gap(b, other)).toBeGreaterThanOrEqual(0.099);
    }
  });

  it('untangles old overlapping hulls without making a new contact', () => {
    const { w, boat, gap } = harbour();
    const b = boat();
    const other = boat({ x: 70.8 });
    const still = boat({ x: 68.5, state: 'moored' });
    expect(gap(b, other)).toBeLessThan(0);
    for (let t = 0; t < 40; t++) {
      separateHull(w, b);
      separateHull(w, other);
      expect(gap(b, still)).toBeGreaterThan(0);
      expect(gap(other, still)).toBeGreaterThan(0);
    }
    expect(gap(b, other)).toBeGreaterThanOrEqual(0);
  });
});
