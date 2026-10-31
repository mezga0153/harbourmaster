import { describe, expect, it } from 'vitest';
import * as B from '../src/sim/balance';
import { withCargo, type Cargo } from '../src/sim/cargo';
import { Build, Terrain, TICKS_PER_DAY } from '../src/sim/types';
import { World } from '../src/sim/world';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** A port with crate storage for cargo coming in and for cargo going out, side by side by the road. */
function port(): { world: Any; into: Any; out: Any } {
  const world: Any = World.create(7, 96);
  world.boats.length = 0;
  for (const c of world.contracts) c.nextBoatTick = Infinity;
  world.tier = 1;
  world.cash = 100_000;
  const m = world.map;
  const r = m.yOf(m.entry);
  const grass = (x: number, y: number) =>
    m.inBounds(x, y) && m.terrain[m.idx(x, y)] === Terrain.Grass && m.build[m.idx(x, y)] === 0;
  const x = [...Array(m.w).keys()].find(
    (x) =>
      [0, 1, 2, 3].every((d) => m.build[m.idx(x + d, r)] === Build.Road) &&
      [0, 1, 2, 3].every((d) => grass(x + d, r + 2)),
  )!;
  const at = m.idx(x, r + 2);
  const row = [at, at + 1, at + 2, at + 3];
  world.command({ type: 'build', kind: 'portRoad', tiles: row });
  world.command({ type: 'store', tiles: [at, at + 1], kind: 'crates', on: true });
  world.command({ type: 'store', tiles: [at + 2, at + 3], kind: 'cratesOut', on: true });
  return { world, into: world.bays.get(at), out: world.bays.get(at + 2) };
}

/** Crates of `c` set down in storage as the crew would: customs or papers start on those that wait. */
function setDown(world: Any, bay: Any, c: Cargo, n: number, out = false): void {
  const fees = Array(n).fill(withCargo(20, c));
  if (out) (bay.exports ??= []).push(...fees);
  else bay.crates.push(...fees);
  world.startHolds(bay, fees, out);
}

/** A haulier's truck loading at `bay`. */
function truckAt(bay: Any): Any {
  return { id: 1, state: 'loading', bayIdx: bay.idx, capacity: 12, cargo: 0, boxes: false };
}

describe('Customs and export papers on crates', () => {
  it('keep timber and goods in storage till customs clear them, but not fish or lobster', () => {
    const { world, into } = port();
    setDown(world, into, 'fish', 2);
    setDown(world, into, 'timber', 3);
    setDown(world, into, 'lobster', 1);
    setDown(world, into, 'goods', 2);
    expect(into.customs).toHaveLength(5);
    // Only the fish and lobster may go.
    expect(world.readyIn(into, false)).toBe(3);
    expect(world.cratesFor(truckAt(into), into)).toBe(3);
    const t = truckAt(into);
    const fees = world.cratesOff(t, into, 0, 8);
    expect(fees.map((f: number) => Math.round((f % 1) * 1e6))).toEqual([1, 1, 3]);
    expect(into.crates).toHaveLength(5);
    // The selected storage says so.
    const view = world.snapshot().bays.find((b: Any) => b.idx === into.idx);
    expect(view.customs.n).toBe(5);
    expect(view.customs.next).toBe(B.CRATE_CUSTOMS_TICKS);
    expect(view.waiting.filter(Boolean)).toHaveLength(5);
    // No truck is sent for them meanwhile.
    expect(world.unclaimed(into, false)).toBe(0);
    world.tick += B.CRATE_CUSTOMS_TICKS;
    expect(world.readyIn(into, false)).toBe(5);
    expect(into.customs).toBeUndefined();
    expect(world.cratesOff(truckAt(into), into, 0, 8)).toHaveLength(5);
  });

  it('clear the oldest first, and take only those cleared', () => {
    const { world, into } = port();
    setDown(world, into, 'timber', 2);
    world.tick += TICKS_PER_DAY / 2;
    setDown(world, into, 'timber', 2);
    world.tick += TICKS_PER_DAY / 2;
    expect(world.readyIn(into, false)).toBe(2);
    const mask = world.waitMask(into, false);
    expect(mask).toEqual([false, false, true, true]);
    // Even asked for the newest, the truck gets the two cleared.
    expect(world.cratesOff(truckAt(into), into, 2, 4)).toHaveLength(2);
    expect(world.readyIn(into, false)).toBe(0);
    expect(into.crates).toHaveLength(2);
  });

  it('keep canned fish in the outgoing storage till its export papers are done', () => {
    const { world, out } = port();
    setDown(world, out, 'canned', 6, true);
    setDown(world, out, 'goods', 2, true);
    expect(out.papers).toHaveLength(6);
    expect(world.readyIn(out, true)).toBe(2);
    // A coaster alongside counts only what may go on board.
    const coaster = { vessel: 'coaster', id: 5 };
    expect(world.exportsFor(coaster)).toBe(2);
    const fees = world.takeReady(out, true, 0, 4);
    expect(fees).toHaveLength(2);
    expect(world.takeReady(out, true, 0, 4)).toHaveLength(0);
    world.tick += B.EXPORT_PAPERS_TICKS - 1;
    expect(world.readyIn(out, true)).toBe(0);
    world.tick += 1;
    expect(world.exportsFor(coaster)).toBe(6);
  });

  it('start nothing in a truck bay, and send timber only to crate storage', () => {
    const { world, into } = port();
    const bay = [...world.bays.values()].find((b: Any) => !b.tiles);
    setDown(world, bay, 'timber', 3);
    expect(bay.customs).toBeUndefined();
    expect(world.readyIn(bay, false)).toBe(3);
    // Timber off a boat goes only into crate storage: not into the truck
    // bay the catch goes to, and here the crew cannot get to the storage.
    const p = world.people.find((q: Any) => q.kind === 'dockhand');
    expect(world.bayWithRoom(p, world.tileOf(p))?.idx).toBe(bay.idx);
    expect(world.bayWithRoom(p, world.tileOf(p), false, true)).toBeNull();
    expect(into.tiles).toBeDefined();
  });

  it('keep their timers in a save, and an older save has them all cleared', () => {
    const { world, into, out } = port();
    setDown(world, into, 'goods', 4);
    setDown(world, out, 'canned', 3, true);
    const save = world.toSave();
    const loaded: Any = World.fromSave(JSON.parse(JSON.stringify(save)));
    const a = loaded.bays.get(into.idx);
    const b = loaded.bays.get(out.idx);
    expect(a.customs).toEqual(into.customs);
    expect(b.papers).toEqual(out.papers);
    expect(loaded.readyIn(a, false)).toBe(0);
    expect(loaded.readyIn(b, true)).toBe(0);
    // From before customs on crates: all clear.
    const old = JSON.parse(JSON.stringify(save));
    for (const bay of old.bays) {
      delete bay.customs;
      delete bay.papers;
    }
    const older: Any = World.fromSave(old);
    expect(older.readyIn(older.bays.get(into.idx), false)).toBe(4);
    expect(older.readyIn(older.bays.get(out.idx), true)).toBe(3);
  });

  it('carry over when storage is marked out again', () => {
    const { world, into } = port();
    setDown(world, into, 'timber', 4);
    const tiles = [...into.tiles];
    world.command({ type: 'store', tiles: [tiles[0] - world.map.w], kind: 'crates', on: true });
    const now = world.bays.get(world.storeOf[tiles[0]]);
    expect(now.crates).toHaveLength(4);
    expect(world.readyIn(now, false)).toBe(0);
  });

  it('say on the Next step card when storage full of crates in customs holds the town up', () => {
    const { world, into } = port();
    expect(world.storeHint(false)).toBeUndefined();
    setDown(world, into, 'timber', B.CRATES_PER_STORE_TILE * into.tiles.length);
    expect(world.storeHint(false)).toMatch(/customs.*full/);
    // Cleared, the trucks take them away: nothing holds it up.
    world.tick += B.CRATE_CUSTOMS_TICKS;
    expect(world.storeHint(false)).toBeUndefined();
    // The canned fish has nowhere to wait for its papers with no outgoing storage.
    world.command({
      type: 'store',
      tiles: world.bays.get(into.idx + 2).tiles,
      kind: 'cratesOut',
      on: false,
    });
    expect(world.storeHint(true)).toMatch(/export papers: mark out/);
  });

  it('let the cannery’s trucks in without the shippers’ day of paperwork outside', () => {
    const { world } = port();
    const t = { exports: true, boxes: false, value: withCargo(20, 'canned') };
    expect(world.cannedTruck(t)).toBe(true);
    expect(world.cannedTruck({ ...t, value: withCargo(20, 'goods') })).toBe(false);
  });
});
