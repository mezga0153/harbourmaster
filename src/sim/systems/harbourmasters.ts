// Harbourmasters: one to each harbourmaster's hut, strolling out along the
// jetties near it and pointing out the boats coming and going. They are for
// show: they walk through everyone and everything is free to walk through
// them, and they never touch the game's random numbers.

import type { World } from '../world';
import type { Boat, Harbourmaster } from '../state';
import * as B from '../balance';
import { Build } from '../types';
import { findPath } from '../path';
import { frontOf } from '../rules/footprint';

const SURNAMES = [
  'Gunn',
  'Mackie',
  'Penrose',
  'Tregarthen',
  'Bligh',
  'Haddock',
  'Fairweather',
  'Quayle',
];

/** A number from 0 to 1 for this harbourmaster and `salt`, the same every run. */
function roll(h: Harbourmaster, salt: number): number {
  const k = Math.imul(h.id * 2654435761 + salt * 40503, 0x9e3779b1) ^ (salt * 97);
  return ((k >>> 0) % 10000) / 10000;
}

/** Where a hut's harbourmaster comes out of it: the tile its door faces. */
function doorStep(w: World, hut: number): number {
  const m = w.map;
  const front = frontOf(m, hut, m.orient[hut] & 3);
  return front >= 0 && Number.isFinite(w.walkCost(front)) ? front : -1;
}

/** The jetty tiles within a harbourmaster's beat, a walk from `from`, their hut's door. */
function beat(w: World, from: number): number[] {
  const m = w.map;
  const seen = new Map<number, number>([[from, 0]]);
  const queue = [from];
  const jetties: number[] = [];
  while (queue.length > 0) {
    const i = queue.shift()!;
    const d = seen.get(i)!;
    if (m.build[i] === Build.Jetty) jetties.push(i);
    if (d >= B.HARBOURMASTER_BEAT) continue;
    for (const n of m.neighbors4(i)) {
      if (seen.has(n) || !Number.isFinite(w.walkCost(n, i))) continue;
      seen.set(n, d + 1);
      queue.push(n);
    }
  }
  return jetties;
}

/** Boats in sight of x, y, the nearest first. */
function inSight(w: World, x: number, y: number): Boat[] {
  return w.boats
    .map((b) => ({ b, d: Math.hypot(b.x - x, b.y - y) }))
    .filter((o) => o.d < B.HARBOURMASTER_SIGHT)
    .sort((a, c) => a.d - c.d)
    .map((o) => o.b);
}

/** A hut has been built: its harbourmaster comes out of the door. */
function hire(w: World, hut: number, at: number): Harbourmaster {
  const m = w.map;
  const id = w.nextId++;
  const h: Harbourmaster = {
    id,
    name: '',
    home: hut,
    x: m.xOf(at) + 0.5,
    y: m.yOf(at) + 0.5,
    dir: 0,
    path: [],
    goal: at,
    state: 'watch',
    timer: B.HARBOURMASTER_WATCH,
    boat: -1,
  };
  h.name = `Harbourmaster ${SURNAMES[Math.floor(roll(h, 1) * SURNAMES.length)]}`;
  return h;
}

/** Somewhere on the beat to walk to next: the jetty nearest a boat on the move, or any. */
function nextStop(w: World, h: Harbourmaster): number {
  const m = w.map;
  const here = w.tileOf(h);
  const door = doorStep(w, h.home);
  const jetties = door >= 0 ? beat(w, door).filter((j) => j !== here) : [];
  if (jetties.length === 0) return -1;
  const busy = w.boats.filter(
    (b) => b.state === 'arriving' || b.state === 'leaving' || b.state === 'moored',
  );
  const near = busy.length > 0 && roll(h, w.tick) < 0.7;
  if (near) {
    const b = busy[Math.floor(roll(h, w.tick + 7) * busy.length)];
    let best = -1;
    let bestD = Infinity;
    for (const j of jetties) {
      const d = Math.hypot(m.xOf(j) + 0.5 - b.x, m.yOf(j) + 0.5 - b.y);
      if (d < bestD) [best, bestD] = [j, d];
    }
    if (bestD < B.HARBOURMASTER_SIGHT) return best;
  }
  return jetties[Math.floor(roll(h, w.tick + 3) * jetties.length)];
}

function update(w: World, h: Harbourmaster): void {
  if (h.state === 'walk') {
    // Through everyone: no waiting at the edge of a tile someone is on.
    const r = w.move(h, w.walkCost, true, () => B.HARBOURMASTER_SPEED);
    if (r === 'moving') return;
    h.state = 'watch';
    h.timer = B.HARBOURMASTER_WATCH + Math.floor(roll(h, w.tick) * B.HARBOURMASTER_WATCH);
    h.boat = -1;
  }
  // Watching: turned to the nearest boat about, pointing it out.
  const [b] = inSight(w, h.x, h.y);
  h.boat = b ? b.id : -1;
  if (b) h.dir = Math.atan2(b.y - h.y, b.x - h.x);
  if (--h.timer > 0) return;
  const goal = nextStop(w, h);
  const path = goal >= 0 ? findPath(w.map.w, w.map.h, w.tileOf(h), goal, w.walkCost, true) : null;
  if (!path || path.length === 0) {
    h.timer = B.HARBOURMASTER_WATCH;
    return;
  }
  h.goal = goal;
  h.path = path;
  h.state = 'walk';
  h.boat = -1;
}

/** Once a tick: a harbourmaster for each hut, and each about their beat. */
export function updateHarbourmasters(w: World): void {
  const m = w.map;
  w.harbourmasters = w.harbourmasters.filter((h) => m.build[h.home] === Build.HarbourHut);
  if (w.tick % 10 === 0) {
    for (let i = 0; i < m.build.length; i++) {
      if (m.build[i] !== Build.HarbourHut || w.harbourmasters.some((h) => h.home === i)) continue;
      const at = doorStep(w, i);
      if (at >= 0) w.harbourmasters.push(hire(w, i, at));
    }
  }
  for (const h of w.harbourmasters) {
    // Stood somewhere they can no longer walk (built over): back to the door.
    if (!Number.isFinite(w.walkCost(w.tileOf(h)))) {
      const at = doorStep(w, h.home);
      if (at < 0) continue;
      h.x = m.xOf(at) + 0.5;
      h.y = m.yOf(at) + 0.5;
      h.path = [];
      h.state = 'watch';
    }
    update(w, h);
  }
}

/** What a harbourmaster is up to, for their panel. */
export function harbourmasterActivity(w: World, h: Harbourmaster): string {
  if (h.state === 'walk') return 'Walking out along the jetties';
  const b = w.boats.find((q) => q.id === h.boat);
  if (!b) return 'Keeping an eye on the harbour';
  const what = b.vessel === 'feeder' ? 'feeder ship' : b.vessel === 'coaster' ? 'coaster' : 'boat';
  const doing =
    b.state === 'arriving'
      ? ' coming in to its berth'
      : b.state === 'leaving'
        ? ' heading out'
        : b.state === 'moored'
          ? ' alongside'
          : ' out at sea';
  return `Pointing out the ${b.company} ${what}${doing}`;
}
