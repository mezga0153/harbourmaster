import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { Build, Store } from '../src/sim/types';
import { rebuildStores } from '../src/sim/systems/building';
import { addBay, lots } from '../src/sim/systems/roads/bays';
import { buildSnapshot } from '../src/sim/systems/snapshot';

/** A world with storage marked straight onto the map, at row y from x0, n tiles. */
function mark(w: World, kind: number, y: number, x0: number, n: number): number[] {
  const tiles = Array.from({ length: n }, (_, k) => w.map.idx(x0 + k, y));
  for (const t of tiles) w.map.store[t] = kind;
  return tiles;
}

function names(w: World): string[] {
  return [...w.bays.values(), ...w.yards.values()].map((b) => b.name!).sort();
}

function areaAt(w: World, t: number) {
  return w.bays.get(w.storeOf[t]) ?? w.yards.get(w.storeOf[t]);
}

describe('designations', () => {
  it('gives each truck bay, storage area and yard its own, by kind', () => {
    const w = World.create(7, 96);
    const first = [...w.bays.values()][0];
    expect(first.name).toBe('B1');
    addBay(w, w.map.idx(10, 10));
    addBay(w, w.map.idx(5, 10));
    expect(w.bays.get(w.map.idx(10, 10))!.name).toBe('B2');
    expect(w.bays.get(w.map.idx(5, 10))!.name).toBe('B3');
    mark(w, Store.Crates, 40, 40, 3);
    mark(w, Store.Crates, 44, 40, 3);
    mark(w, Store.CratesOut, 48, 40, 2);
    mark(w, Store.Boxes, 52, 40, 4);
    mark(w, Store.BoxesOut, 56, 40, 4);
    rebuildStores(w);
    expect(names(w)).toEqual(['B1', 'B2', 'B3', 'C1', 'C2', 'CX1', 'Y1', 'YX1']);
  });

  it('keeps an area’s when it grows, gives the larger part it when split, and a new one to a new area', () => {
    const w = World.create(7, 96);
    const row = mark(w, Store.Crates, 40, 40, 5);
    rebuildStores(w);
    expect(areaAt(w, row[0])!.name).toBe('C1');
    // Marked out bigger, from its other end: still C1.
    mark(w, Store.Crates, 40, 35, 5);
    rebuildStores(w);
    expect(areaAt(w, row[0])!.name).toBe('C1');
    expect(w.bays.get(w.storeOf[row[0]])!.tiles!.length).toBe(10);
    // A new area elsewhere gets C2.
    const other = mark(w, Store.Crates, 46, 40, 2);
    rebuildStores(w);
    expect(areaAt(w, other[0])!.name).toBe('C2');
    // Split by clearing a tile: the larger part keeps C1, the smaller a new one.
    w.map.store[w.map.idx(37, 40)] = Store.None;
    rebuildStores(w);
    expect(areaAt(w, row[4])!.name).toBe('C1');
    expect(areaAt(w, w.map.idx(35, 40))!.name).toBe('C3');
    // Cleared away, its number is free for the next.
    for (const t of other) w.map.store[t] = Store.None;
    rebuildStores(w);
    mark(w, Store.Crates, 60, 40, 1);
    rebuildStores(w);
    expect(areaAt(w, w.map.idx(40, 60))!.name).toBe('C2');
  });

  it('names parking lots, and keeps them as they are redrawn', () => {
    const w = World.create(7, 96);
    const m = w.map;
    for (let x = 30; x < 34; x++) m.build[m.idx(x, 30)] = Build.Parking;
    for (let x = 30; x < 32; x++) m.build[m.idx(x, 34)] = Build.Parking;
    w.lotsCache = null;
    expect(lots(w).map((l) => l.name)).toEqual(['P1', 'P2']);
    m.build[m.idx(34, 30)] = Build.Parking;
    w.lotsCache = null;
    expect(lots(w).find((l) => l.tiles.includes(m.idx(34, 30)))!.name).toBe('P1');
  });

  it('survive save and load, and the snapshot carries them', () => {
    const w = World.create(7, 96);
    addBay(w, w.map.idx(10, 10));
    mark(w, Store.Crates, 40, 40, 3);
    mark(w, Store.Crates, 44, 40, 3);
    mark(w, Store.Boxes, 52, 40, 4);
    rebuildStores(w);
    for (let x = 30; x < 34; x++) w.map.build[w.map.idx(x, 34)] = Build.Parking;
    for (let x = 30; x < 34; x++) w.map.build[w.map.idx(x, 30)] = Build.Parking;
    w.lotsCache = null;
    // Swap the lots' designations round, so loading cannot just hand them out afresh.
    const [a, b] = lots(w);
    [a.name, b.name] = [b.name, a.name];
    for (const t of a.tiles) w.lotNames.set(t, a.name!);
    for (const t of b.tiles) w.lotNames.set(t, b.name!);
    const before = names(w);
    const back = World.fromSave(JSON.parse(JSON.stringify(w.toSave())));
    expect(names(back)).toEqual(before);
    for (const [i, bay] of w.bays) expect(back.bays.get(i)?.name).toBe(bay.name);
    expect(lots(back).map((l) => l.name)).toEqual([a.name, b.name]);
    const snap = buildSnapshot(back);
    expect(snap.bays.map((b) => b.name).sort()).toEqual(['B1', 'B2', 'C1', 'C2']);
    expect(snap.yards.map((y) => y.name)).toEqual(['Y1']);
    expect(snap.parking.map((p) => p.name)).toEqual([a.name, b.name]);
  });

  it('hands them out to older saves, lowest tile first', () => {
    const w = World.create(7, 96);
    addBay(w, w.map.idx(10, 10));
    mark(w, Store.Crates, 44, 40, 3);
    mark(w, Store.Crates, 40, 40, 3);
    rebuildStores(w);
    const save = JSON.parse(JSON.stringify(w.toSave()));
    for (const b of [...save.bays, ...save.yards]) delete b.name;
    delete save.lotNames;
    const back = World.fromSave(save);
    const bays = [...back.bays.values()].filter((b) => !b.tiles).sort((x, y) => x.idx - y.idx);
    expect(bays.map((b) => b.name)).toEqual(['B1', 'B2']);
    expect(areaAt(back, back.map.idx(40, 40))!.name).toBe('C1');
    expect(areaAt(back, back.map.idx(40, 44))!.name).toBe('C2');
  });
});
