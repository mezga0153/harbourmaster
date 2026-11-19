import { describe, expect, it } from 'vitest';
import * as B from '../src/sim/balance';
import { previewBuilding } from '../src/preview/build';
import {
  bayPath,
  bayTrouble,
  bestFacing,
  frontOf,
  placementCost,
  placementError,
  walkableAt,
} from '../src/sim/rules';
import { warnWaiting } from '../src/sim/systems/boats/berthing';
import { cashReserve, newDay } from '../src/sim/systems/economy';
import { landmarkShort } from '../src/sim/systems/townBusiness';
import { townCap, townTarget } from '../src/sim/town';
import { Build, TICKS_PER_DAY } from '../src/sim/types';
import { World } from '../src/sim/world';

// What players were found stuck on (see the play log): truck bays put up
// with nothing behind them for the dockhands, boats giving up unwarned, the
// town held back by a daily goal just missed, and no cash in hand for bad days.

/** A spot for a truck bay facing the public road, with bare ground behind it. */
function baySpot(w: World): { i: number; f: number; way: number[] } {
  const m = w.map;
  for (let i = 0; i < m.build.length; i++) {
    if (m.build[i] !== Build.None || placementError(m, 'truckBay', i)) continue;
    const f = bestFacing(m, 'truckBay', i);
    if (m.build[frontOf(m, i, f)] !== Build.Road) continue;
    const way = bayPath(m, 'truckBay', i, f);
    if (way.length >= 2) return { i, f, way };
  }
  throw new Error('No spot for a truck bay with bare ground behind it');
}

function messages(w: World): string[] {
  return w.drainEvents().flatMap((e) => (e.kind === 'message' ? [e.text] : []));
}

describe('A truck bay put up with nothing behind it', () => {
  it('shows the port path that goes in behind it, up to where people walk, and its cost', () => {
    const w = World.create(7, 96);
    const m = w.map;
    const { i, f, way } = baySpot(w);
    expect(way[0]).toBe(frontOf(m, i, (f + 2) & 3));
    // The far end meets where people already walk.
    const end = way[way.length - 1];
    expect(m.neighbors4(end).some((n) => walkableAt(m, n) && m.build[n] !== Build.TruckBay)).toBe(
      true,
    );
    expect(way.length).toBeLessThanOrEqual(B.BAY_PATH_REACH);
    const r = previewBuilding(m, null, 'truckBay', i, f);
    for (const t of way) expect(r.ghosts.tiles).toContain(t);
    const paths = way.reduce((n, t) => n + placementCost(m, 'footpath', t), 0);
    expect(r.preview?.value).toBe(-placementCost(m, 'truckBay', i) - paths);
    expect(r.preview?.note).toMatch(/port path goes in behind it/);
  });

  it('is built with it, so it has no red mark', () => {
    const w = World.create(7, 96);
    const m = w.map;
    const { i, f, way } = baySpot(w);
    expect(bayTrouble(m, i, f)).toMatch(/behind it/);
    w.command({ type: 'build', kind: 'truckBay', tiles: [i], facing: f });
    expect(m.build[i]).toBe(Build.TruckBay);
    for (const t of way) expect(m.build[t]).toBe(Build.Footpath);
    expect(bayTrouble(m, i, f)).toBeNull();
  });
});

describe('A boat kept waiting', () => {
  it('is warned of once, half way to giving up, with what it will claim and why it waits', () => {
    const w = World.create(7, 96);
    let b = w.boats.find((q) => q.crates > 0);
    for (let k = 0; !b && k < TICKS_PER_DAY; k++) {
      w.step();
      b = w.boats.find((q) => q.crates > 0);
    }
    expect(b).toBeDefined();
    const boat = b!;
    w.drainEvents();
    boat.state = 'anchored';
    boat.anchorTicks = B.BOAT_GIVE_UP_TICKS * 0.4;
    boat.mooredTicks = 0;
    warnWaiting(w, boat, B.BOAT_GIVE_UP_TICKS);
    expect(messages(w)).toEqual([]);
    boat.anchorTicks = B.BOAT_GIVE_UP_TICKS * 0.55;
    warnWaiting(w, boat, B.BOAT_GIVE_UP_TICKS);
    const said = messages(w);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/gives up and claims \$\d/);
    expect(said[0]).toMatch(/every berth it can use is taken/);
    expect(w.tipsSeen.has('patience')).toBe(true);
    warnWaiting(w, boat, B.BOAT_GIVE_UP_TICKS);
    expect(messages(w)).toEqual([]);
  });
});

describe('The town held back by its next landmark', () => {
  it('says each day the goal is missed how far short it was, and what the port lacks', () => {
    const w = World.create(7, 96);
    const t = w.town!;
    expect(t).toBeDefined();
    // Jobs and trade enough for more people than it may have, and short of
    // the fish market's 12 a day.
    t.goal = 10;
    t.jobs = 0;
    t.goods = 0;
    t.supplied = 0;
    expect(townTarget(t)).toBeLessThanOrEqual(townCap(t));
    expect(landmarkShort(w)).toBeNull();
    t.jobs = 40;
    expect(townTarget(t)).toBeGreaterThan(townCap(t));
    const short = landmarkShort(w)!;
    expect(short).toMatch(/fish market/);
    expect(short).toMatch(/12 crates of fish trucked out a day, 3 days running, and 10 went today/);
    t.goal = 12;
    expect(landmarkShort(w)).toBeNull();
    // Said at the end of a day it fell short.
    t.goal = 10;
    w.drainEvents();
    newDay(w);
    expect(messages(w).some((m) => /can grow no bigger till its fish market opens/.test(m))).toBe(
      true,
    );
  });
});

describe('Cash in hand', () => {
  it('is worth a few days of what goes out, claims included; the advisor says so on going into the red', () => {
    const w = World.create(7, 96);
    const base = cashReserve(w);
    expect(base).toBeGreaterThan(0);
    w.yesterday = { ...w.today, penalties: -400 };
    expect(cashReserve(w)).toBe(base + B.RESERVE_DAYS * 400);
    w.cash = -100;
    w.drainEvents();
    newDay(w);
    expect(w.tipsSeen.has('savings')).toBe(true);
  });
});
