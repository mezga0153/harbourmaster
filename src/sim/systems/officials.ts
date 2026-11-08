// The port's officials, one to each building that has one: a harbourmaster
// to each harbourmaster's hut, strolling out along the jetties near it and
// pointing out the boats coming and going; a berthing master to each
// harbour office, out at the berths waving the ships in alongside; and a
// customs officer to each customs office, going down to the ships
// alongside to check their papers.
// They are for show: they walk through everyone and everything is free to
// walk through them, and they never touch the game's random numbers.

import type { World } from '../world';
import type { Boat, Official, OfficialRole } from '../state';
import * as B from '../balance';
import { needsCustomsOffice } from '../contracts';
import { Build, isDock } from '../types';
import { findPath } from '../path';
import { frontOf } from '../rules/footprint';

/** What each sort of official comes with, what they are called, and how they go about. */
const ROLES: Record<
  OfficialRole,
  { home: number; title: string; names: string[]; beat: number; stops: (code: number) => boolean }
> = {
  harbourmaster: {
    home: Build.HarbourHut,
    title: 'Harbourmaster',
    names: ['Gunn', 'Mackie', 'Penrose', 'Tregarthen', 'Bligh', 'Haddock', 'Fairweather', 'Quayle'],
    beat: B.HARBOURMASTER_BEAT,
    stops: (c) => c === Build.Jetty,
  },
  berthing: {
    home: Build.Office,
    title: 'Berthing master',
    names: ['Rowe', 'Calder', 'Moffat', 'Pengelly', 'Strand', 'Inglis', 'Baird', 'Trevan'],
    beat: B.CUSTOMS_BEAT,
    stops: isDock,
  },
  customs: {
    home: Build.Customs,
    title: 'Customs officer',
    names: ['Shaw', 'Pryce', 'Lockett', 'Varley', 'Dunmore', 'Hale', 'Ashby', 'Kerr'],
    beat: B.CUSTOMS_BEAT,
    stops: isDock,
  },
};

/** A number from 0 to 1 for this official and `salt`, the same every run. */
function roll(h: Official, salt: number): number {
  const k = Math.imul(h.id * 2654435761 + salt * 40503, 0x9e3779b1) ^ (salt * 97);
  return ((k >>> 0) % 10000) / 10000;
}

/** Where an official comes out of their building: the tile its door faces. */
function doorStep(w: World, home: number): number {
  const m = w.map;
  const front = frontOf(m, home, m.orient[home] & 3);
  return front >= 0 && Number.isFinite(w.walkCost(front)) ? front : -1;
}

/** The tiles an official stops at within their beat, a walk from `from`, their door. */
function beat(w: World, h: Official, from: number): number[] {
  const m = w.map;
  const role = ROLES[h.role];
  const seen = new Map<number, number>([[from, 0]]);
  const queue = [from];
  const stops: number[] = [];
  while (queue.length > 0) {
    const i = queue.shift()!;
    const d = seen.get(i)!;
    if (role.stops(m.build[i])) stops.push(i);
    if (d >= role.beat) continue;
    for (const n of m.neighbors4(i)) {
      if (seen.has(n) || !Number.isFinite(w.walkCost(n, i))) continue;
      seen.set(n, d + 1);
      queue.push(n);
    }
  }
  return stops;
}

/** Boats within `reach` of x, y, the nearest first. */
function inSight(w: World, x: number, y: number, reach: number): Boat[] {
  return w.boats
    .map((b) => ({ b, d: Math.hypot(b.x - x, b.y - y) }))
    .filter((o) => o.d < reach)
    .sort((a, c) => a.d - c.d)
    .map((o) => o.b);
}

/** A building that has an official has gone up: they come out of the door. */
function hire(w: World, role: OfficialRole, home: number, at: number): Official {
  const m = w.map;
  const h: Official = {
    id: w.nextId++,
    role,
    name: '',
    home,
    x: m.xOf(at) + 0.5,
    y: m.yOf(at) + 0.5,
    dir: 0,
    path: [],
    goal: at,
    state: 'watch',
    timer: B.HARBOURMASTER_WATCH,
    boat: -1,
  };
  const { title, names } = ROLES[role];
  h.name = `${title} ${names[Math.floor(roll(h, 1) * names.length)]}`;
  return h;
}

/** Of `tiles`, the one nearest the boat (or the tile `at`), and how far it is from it. */
function nearestTo(w: World, tiles: number[], b: Boat, at = -1): [number, number] {
  const m = w.map;
  const [x, y] = at >= 0 ? [m.xOf(at) + 0.5, m.yOf(at) + 0.5] : [b.x, b.y];
  let best = -1;
  let bestD = Infinity;
  for (const j of tiles) {
    const d = Math.hypot(m.xOf(j) + 0.5 - x, m.yOf(j) + 0.5 - y);
    if (d < bestD) [best, bestD] = [j, d];
  }
  return [best, bestD];
}

/**
 * A harbourmaster's next stop: the jetty nearest a boat on the move, or
 * any on their beat.
 */
function harbourmasterStop(w: World, h: Official, stops: number[]): number {
  const busy = w.boats.filter(
    (b) => b.state === 'arriving' || b.state === 'leaving' || b.state === 'moored',
  );
  if (busy.length > 0 && roll(h, w.tick) < 0.7) {
    const b = busy[Math.floor(roll(h, w.tick + 7) * busy.length)];
    const [best, d] = nearestTo(w, stops, b);
    if (d < B.HARBOURMASTER_SIGHT) return best;
  }
  return stops[Math.floor(roll(h, w.tick + 3) * stops.length)];
}

/** A ship alongside whose cargo customs clears, or failing that any ship alongside. */
function shipToClear(w: World, h: Official): Boat | undefined {
  const moored = w.boats.filter((b) => b.state === 'moored');
  const terms = (b: Boat) => w.contracts.find((c) => c.id === b.contractId)?.terms;
  const theirs = moored.filter((b) => {
    const t = terms(b);
    return t && needsCustomsOffice(t);
  });
  const pick = theirs.length > 0 ? theirs : moored;
  return pick[Math.floor(roll(h, w.tick + 5) * pick.length)];
}

/**
 * A customs officer's next stop: the dock beside a ship alongside, its
 * papers to check; or with none to go to, back to the office door.
 */
function customsStop(w: World, h: Official, stops: number[], door: number): number {
  const b = shipToClear(w, h);
  if (b) {
    const [best, d] = nearestTo(w, stops, b);
    if (d < B.CUSTOMS_REACH + 1) return best;
  }
  return door;
}

/**
 * A berthing master's next stop: the dock a ship is coming in to, to wave
 * it in alongside; or now and then any dock on their beat, or the door.
 */
function berthingStop(w: World, h: Official, stops: number[], door: number): number {
  const coming = w.boats.filter(
    (b) => (b.state === 'arriving' || b.state === 'anchored') && b.jetty >= 0,
  );
  for (const b of coming) {
    const [best, d] = nearestTo(w, stops, b, b.jetty);
    if (best >= 0 && d < 3) return best;
  }
  if (stops.length > 0 && roll(h, w.tick) < 0.5) {
    return stops[Math.floor(roll(h, w.tick + 3) * stops.length)];
  }
  return door;
}

/** The ship a berthing master is waving in: one coming in to a dock beside them. */
export function guiding(w: World, h: Official): Boat | undefined {
  const m = w.map;
  return w.boats.find(
    (b) =>
      b.state === 'arriving' &&
      b.jetty >= 0 &&
      Math.abs(m.xOf(b.jetty) + 0.5 - h.x) + Math.abs(m.yOf(b.jetty) + 0.5 - h.y) <= 2,
  );
}

/** Somewhere on the beat to walk to next, or -1 to stay put. */
function nextStop(w: World, h: Official): number {
  const here = w.tileOf(h);
  const door = doorStep(w, h.home);
  const stops = door >= 0 ? beat(w, h, door).filter((j) => j !== here) : [];
  if (h.role === 'customs') return customsStop(w, h, stops, door);
  if (h.role === 'berthing') return berthingStop(w, h, stops, door);
  return stops.length > 0 ? harbourmasterStop(w, h, stops) : -1;
}

function update(w: World, h: Official): void {
  if (h.state === 'walk') {
    // Through everyone: no waiting at the edge of a tile someone is on.
    const r = w.move(h, w.walkCost, true, () => B.HARBOURMASTER_SPEED);
    if (r === 'moving') return;
    h.state = 'watch';
    const watch = h.role === 'customs' ? B.CUSTOMS_INSPECT : B.HARBOURMASTER_WATCH;
    h.timer = watch + Math.floor(roll(h, w.tick) * watch);
    h.boat = -1;
  }
  // A harbourmaster turns to the nearest boat about, pointing it out; a
  // berthing master to the ship coming in beside them, waving it in, or
  // the nearest one about, watching it through binoculars; a customs
  // officer to the ship beside them, going through its papers.
  const reach = h.role === 'customs' ? B.CUSTOMS_REACH : B.HARBOURMASTER_SIGHT;
  const [b] =
    h.role === 'berthing' && guiding(w, h)
      ? [guiding(w, h)!]
      : inSight(w, h.x, h.y, reach).filter((q) => h.role !== 'customs' || q.state === 'moored');
  h.boat = b ? b.id : -1;
  if (b) h.dir = Math.atan2(b.y - h.y, b.x - h.x);
  // Waving a ship in, they stay till it is alongside.
  if (h.role === 'berthing' && b?.state === 'arriving' && guiding(w, h)) return;
  if (--h.timer > 0) return;
  const goal = nextStop(w, h);
  const path =
    goal >= 0 && goal !== w.tileOf(h)
      ? findPath(w.map.w, w.map.h, w.tileOf(h), goal, w.walkCost, true)
      : null;
  if (!path || path.length === 0) {
    h.timer = B.HARBOURMASTER_WATCH;
    return;
  }
  h.goal = goal;
  h.path = path;
  h.state = 'walk';
  h.boat = -1;
}

/** Once a tick: an official for each building that has one, and each about their beat. */
export function updateOfficials(w: World): void {
  const m = w.map;
  w.officials = w.officials.filter((h) => m.build[h.home] === ROLES[h.role].home);
  if (w.tick % 10 === 0) {
    for (let i = 0; i < m.build.length; i++) {
      const role =
        m.build[i] === Build.HarbourHut
          ? 'harbourmaster'
          : m.build[i] === Build.Customs
            ? 'customs'
            : m.build[i] === Build.Office
              ? 'berthing'
              : null;
      if (!role || w.officials.some((h) => h.home === i)) continue;
      const at = doorStep(w, i);
      if (at >= 0) w.officials.push(hire(w, role, i, at));
    }
  }
  for (const h of w.officials) {
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

/** What an official is up to, for their panel. */
export function officialActivity(w: World, h: Official): string {
  const b = w.boats.find((q) => q.id === h.boat);
  const what = (q: Boat) =>
    `the ${q.company} ${q.vessel === 'feeder' ? 'feeder ship' : q.vessel === 'coaster' ? 'coaster' : 'boat'}`;
  if (h.role === 'customs') {
    if (h.state === 'walk') {
      return w.map.build[h.goal] === Build.Jetty || isDock(w.map.build[h.goal])
        ? 'Going down to a ship alongside'
        : 'Going back to the office';
    }
    return b ? `Checking the papers of ${what(b)}` : 'Waiting for a ship to come alongside';
  }
  if (h.role === 'berthing') {
    if (h.state === 'walk') {
      return isDock(w.map.build[h.goal]) ? 'Going out to the berths' : 'Going back to the office';
    }
    if (!b) return 'Keeping an eye on the berths';
    return b.state === 'arriving' && guiding(w, h)
      ? `Waving ${what(b)} in alongside`
      : `Watching ${what(b)} through binoculars`;
  }
  if (h.state === 'walk') return 'Walking out along the jetties';
  if (!b) return 'Keeping an eye on the harbour';
  const doing =
    b.state === 'arriving'
      ? ' coming in to its berth'
      : b.state === 'leaving'
        ? ' heading out'
        : b.state === 'moored'
          ? ' alongside'
          : ' out at sea';
  return `Pointing out ${what(b)}${doing}`;
}
