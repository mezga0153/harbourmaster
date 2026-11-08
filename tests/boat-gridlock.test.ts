import { describe, expect, it } from 'vitest';
import * as B from '../src/sim/balance';
import { hullGap } from '../src/sim/helpers';
import type { Boat } from '../src/sim/state';
import { approachPath, route, updateBoat } from '../src/sim/systems/boats/berthing';
import { clips, nip } from '../src/sim/systems/boats/seamanship';
import { giveWay, seaWay } from '../src/sim/systems/boats/traffic';
import { Build, Terrain } from '../src/sim/types';
import { World } from '../src/sim/world';

function water() {
  const w = World.create(7, 96);
  const template = w.boats[0];
  w.boats = [];
  const m = w.map;
  for (let y = 25; y < 103; y++) {
    for (let x = 30; x < m.w; x++) {
      const i = m.idx(x, y);
      m.terrain[i] = Terrain.Water;
      m.depth[i] = 10;
      m.ocean[i] = 1;
      m.build[i] = Build.None;
    }
  }
  w.forget();
  const boat = (fields: Partial<Boat>): Boat => {
    const b: Boat = { ...template, speed: 0, crates: 12, path: [], ...fields };
    w.boats.push(b);
    return b;
  };
  return { w, m, boat };
}

function stoppedPair() {
  const { w, m, boat } = water();
  const b = boat({
    id: 77940,
    vessel: 'coaster',
    draft: B.COASTER_DRAFT,
    state: 'leaving',
    x: 67.74855320164203,
    y: 40.08301637377191,
    dir: 0.6170208153095148,
    goal: m.idx(68, 30),
    held: B.BOAT_REROUTE_AFTER,
  });
  const other = boat({
    id: 78094,
    vessel: 'feeder',
    draft: B.FEEDER_DRAFT,
    state: 'arriving',
    x: 69.07142782220643,
    y: 43.68959327768039,
    dir: 1.683504664501056,
    goal: m.idx(49, 89),
    berth: m.idx(49, 89),
    jetty: m.idx(49, 88),
  });
  b.path = [b.goal];
  return { w, b, other };
}

const gap = (a: Boat, b: Boat) =>
  hullGap(a.x, a.y, a.dir, B.VESSELS[a.vessel], b.x, b.y, b.dir, B.VESSELS[b.vessel]);

describe('Collision-safe recovery from a ship traffic knot', () => {
  it('tries the clear crawl when a zero-speed step would otherwise hide it', () => {
    const { w, b, other } = stoppedPair();
    const way = giveWay(w, b);
    expect(way.speed).toBe(0);
    expect(gap(b, other)).toBeGreaterThan(0.1);
    const y = b.y;
    expect(nip(w, b, 0, 0, 68.5, 30.5, way.speed)).toBeGreaterThan(0);
    expect(b.y).toBeLessThan(y);
    expect(gap(b, other)).toBeGreaterThanOrEqual(0.1);
  });

  it('continues to wait for traffic before the recovery threshold', () => {
    const { w, b } = stoppedPair();
    b.held = B.BOAT_REROUTE_AFTER - 1;
    const before = [b.x, b.y];
    expect(nip(w, b, 0, 0, 68.5, 30.5, giveWay(w, b).speed)).toBe(0);
    expect([b.x, b.y]).toEqual(before);
  });

  it('keeps the hull check when the crawl points into the blocking ship', () => {
    const { w, b, other } = stoppedPair();
    for (let t = 0; t < 100; t++) {
      nip(w, b, 0, 0, other.x, other.y, 0);
      expect(gap(b, other)).toBeGreaterThanOrEqual(0.099999);
    }
  });

  it('clears the nine-ship knot near (67,64) without overlapping hulls', () => {
    const { w, m, boat } = water();
    // Boats from the player's paused game, including the stern-first feeder
    // running out from (53,64) and three feeders on their approach legs.
    const knot = [
      [
        77555,
        'feeder',
        'arriving',
        66.85507126462495,
        69.40549554320643,
        1.9648367917647336,
        37,
        92,
      ],
      [
        77796,
        'feeder',
        'arriving',
        65.2479816752763,
        68.75437607936256,
        1.7235775826917443,
        52,
        79,
      ],
      [77928, 'feeder', 'leaving', 61.627148052187955, 64.49999999989878, Math.PI, 95, 82],
      [
        77940,
        'coaster',
        'leaving',
        67.74855320164203,
        60.08301637377191,
        0.6170208153095148,
        95,
        74,
      ],
      [
        77946,
        'coaster',
        'leaving',
        67.30500448973473,
        62.51533841987863,
        1.0288227595642847,
        95,
        82,
      ],
      [
        78022,
        'coaster',
        'leaving',
        65.19513407213383,
        63.290511201571455,
        0.3562071571291883,
        95,
        84,
      ],
      [
        78037,
        'coaster',
        'leaving',
        66.79215238840517,
        65.5895272743673,
        0.7286132817434224,
        95,
        79,
      ],
      [
        78094,
        'feeder',
        'arriving',
        69.07142782220643,
        63.68959327768039,
        1.683504664501056,
        49,
        89,
      ],
      [78112, 'smack', 'leaving', 66.09309114699012, 60.18599845598801, 1.6867698090174892, 95, 84],
    ] as const;
    for (const [id, vessel, state, x, y, dir, gx, gy] of knot) {
      const b = boat({
        id,
        vessel,
        state,
        x,
        y,
        dir,
        goal: m.idx(gx, gy),
        draft:
          vessel === 'feeder'
            ? B.FEEDER_DRAFT
            : vessel === 'coaster'
              ? B.COASTER_DRAFT
              : B.BOAT_DRAFT,
        berth: state === 'arriving' ? m.idx(gx, gy) : -1,
        jetty: state === 'arriving' ? m.idx(gx, gy - 1) : -1,
        held: 150,
        stall: 200,
        squeeze: 150,
      });
      if (state === 'arriving') m.build[b.jetty] = Build.Quay;
      if (id === 77928) {
        Object.assign(b, {
          castOff: m.idx(53, 64),
          castDock: m.idx(53, 65),
          lineEnd: m.idx(53, 64),
          lineup: m.idx(63, 64),
          berthing: 'out',
          astern: true,
          turned: true,
        });
        m.build[b.castDock!] = Build.Quay;
      }
    }
    w.forget();
    for (const b of w.boats) {
      b.path = (
        b.state === 'arriving'
          ? approachPath(w, b, w.tileOf(b), b.berth, b.jetty)
          : route(w, b, w.tileOf(b), b.goal, seaWay(w, b))
      )!;
    }
    const starts = new Map(w.boats.map((b) => [b.id, [b.x, b.y]]));
    for (let t = 0; t < 1200; t++) {
      w.tick++;
      for (const b of [...w.boats]) updateBoat(w, b);
      for (let i = 0; i < w.boats.length; i++) {
        const a = w.boats[i];
        expect(clips(w, a, a.x, a.y, a.dir, [])).toBe(0);
        for (const b of w.boats.slice(i + 1)) expect(gap(a, b)).toBeGreaterThanOrEqual(-1e-6);
      }
    }
    for (const b of w.boats) {
      const [x, y] = starts.get(b.id)!;
      expect(Math.hypot(b.x - x, b.y - y), `boat #${b.id}`).toBeGreaterThan(3);
    }
  });
});
