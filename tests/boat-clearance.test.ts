import { describe, expect, it } from 'vitest';
import * as B from '../src/sim/balance';
import { hullGap } from '../src/sim/helpers';
import type { Boat } from '../src/sim/state';
import { approachPath, route } from '../src/sim/systems/boats/berthing';
import { sail } from '../src/sim/systems/boats/seamanship';
import { seaWay, wideOf } from '../src/sim/systems/boats/traffic';
import { Build, Terrain } from '../src/sim/types';
import { World } from '../src/sim/world';

/** The occupied pier and berth from the player's approach to (37,92). */
function harbour(occupied = true) {
  const w = World.create(7, 96);
  const template = w.boats[0];
  w.boats.length = 0;
  const m = w.map;
  for (let y = 65; y < 110; y++) {
    for (let x = 20; x < 90; x++) {
      const i = m.idx(x, y);
      m.terrain[i] = Terrain.Water;
      m.ocean[i] = 1;
      m.depth[i] = 10;
      m.build[i] = Build.None;
    }
  }
  for (let y = 85; y <= 88; y++) {
    for (let x = 27; x <= 50; x++) m.build[m.idx(x, y)] = Build.Quay;
  }
  for (let y = 89; y <= 91; y++) {
    for (let x = 27; x <= 36; x++) m.build[m.idx(x, y)] = Build.Quay;
  }
  m.build[m.idx(37, 91)] = Build.Quay;
  w.forget();
  const b: Boat = {
    ...template,
    id: 1000,
    vessel: 'feeder',
    draft: B.FEEDER_DRAFT,
    x: 62.5,
    y: 78.5,
    dir: Math.PI / 2,
    speed: 0,
    state: 'arriving',
    berth: m.idx(37, 92),
    jetty: m.idx(37, 91),
    goal: m.idx(37, 92),
    path: [],
  };
  const other: Boat = {
    ...b,
    id: 1001,
    state: 'moored',
    x: 49.5,
    y: 89.5,
    dir: Math.PI,
    berth: m.idx(49, 89),
    jetty: m.idx(49, 88),
  };
  w.boats.push(b);
  if (occupied) w.boats.push(other);
  const plan = () => approachPath(w, b, w.tileOf(b), b.berth, b.jetty)!;
  const nearest = (path: number[], x: number, y: number) =>
    Math.min(...path.map((i) => Math.hypot(m.xOf(i) + 0.5 - x, m.yOf(i) + 0.5 - y)));
  return { w, m, b, other, plan, nearest };
}

describe('Ship clearance around piers', () => {
  it('swings wide of the occupied pier on the way to (37,92)', () => {
    const { m, b, plan, nearest } = harbour();
    const path = plan();
    expect(path).not.toBeNull();
    const past = path.filter((i) => m.yOf(i) === 89);
    expect(past.length).toBeGreaterThan(0);
    expect(Math.min(...past.map((i) => m.xOf(i)))).toBeGreaterThanOrEqual(56);
    expect(nearest(path, 52.5, 89.5)).toBeGreaterThanOrEqual(4);
    expect(path).toContain(b.lineup);
    expect(path.at(-1)).toBe(m.idx(37, 92));
  });

  it('leaves more room when a ship occupies the pier', () => {
    const empty = harbour(false);
    const occupied = harbour();
    const bare = empty.plan();
    const busy = occupied.plan();
    const passingX = (h: typeof empty, path: number[]) =>
      Math.min(...path.filter((i) => h.m.yOf(i) === 89).map((i) => h.m.xOf(i)));
    expect(passingX(occupied, busy)).toBeGreaterThan(passingX(empty, bare));
  });

  it('gives a feeder more turning room than a small boat', () => {
    const { w, m, b, nearest } = harbour(false);
    b.goal = m.idx(37, 94);
    const large = route(w, b, w.tileOf(b), b.goal, seaWay(w, b))!;
    b.vessel = 'smack';
    b.draft = B.BOAT_DRAFT;
    const small = route(w, b, w.tileOf(b), b.goal, seaWay(w, b))!;
    expect(nearest(large, 50.5, 88.5)).toBeGreaterThan(nearest(small, 50.5, 88.5) + 0.5);
  });

  it('updates an approach when another ship takes the pier, preserving its final alignment', () => {
    const { w, m, b, other, plan } = harbour(false);
    b.x = 54.5;
    b.y = 88.5;
    b.dir = Math.PI * 0.75;
    b.path = plan();
    const tail = b.path.slice(b.path.indexOf(b.lineup!));
    b.path = [m.idx(53, 89), m.idx(52, 90), m.idx(51, 91), m.idx(50, 92), ...tail];
    w.boats.push(other);
    w.tick = 50; // Staggered soft-clearance check for boat #1000.
    sail(w, b, 0);
    expect(b.berthing).toBe('lead');
    expect(b.path).toContain(b.lineup);
    expect(b.path.slice(-2)).toEqual([m.idx(37, 93), m.idx(37, 92)]);
    expect(b.path).not.toContain(m.idx(52, 90));
    expect(b.path.some((i) => m.yOf(i) >= 94)).toBe(true);
  });

  it('keeps the wider arc while steering and can still come alongside', () => {
    const { w, m, b, other, plan } = harbour();
    b.path = plan();
    let closest = Infinity;
    let passingX = Infinity;
    let result = 'moving';
    for (let t = 0; t < 1100 && result === 'moving'; t++) {
      w.tick++;
      result = sail(w, b, 0);
      closest = Math.min(
        closest,
        hullGap(
          b.x,
          b.y,
          b.dir,
          B.VESSELS[b.vessel],
          other.x,
          other.y,
          other.dir,
          B.VESSELS[other.vessel],
        ),
      );
      if (b.y >= 88.5 && b.y <= 90.5) passingX = Math.min(passingX, b.x);
    }
    expect(result).toBe('arrived');
    expect(passingX).toBeGreaterThan(54.5);
    expect(closest).toBeGreaterThan(2);
    expect(w.tileOf(b)).toBe(m.idx(37, 92));
  });

  it('invalidates the larger clearance fields when a pier changes', () => {
    const { w, m, b } = harbour(false);
    const at = m.idx(60, 80);
    expect(wideOf(w, b)(at)).toBe(0);
    expect(w.wideRingCache.size).toBeGreaterThan(0);
    m.build[m.idx(60, 79)] = Build.Quay;
    w.forget();
    expect(w.wideRingCache.size).toBe(0);
    expect(wideOf(w, b)(at)).toBeGreaterThan(0);
  });
});
