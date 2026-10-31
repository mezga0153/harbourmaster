import { describe, expect, it } from 'vitest';
import * as B from '../src/sim/balance';
import {
  buyable,
  landError,
  nextPrice,
  ownedPlots,
  plotPrice,
  plotTiles,
  seaPlot,
} from '../src/sim/land';
import { findPath } from '../src/sim/path';
import { placementError } from '../src/sim/rules';
import { Build, Terrain } from '../src/sim/types';
import { World } from '../src/sim/world';

/** What trucks drive on from the highway, outside the port. */
const ROADS: number[] = [Build.Road, Build.Crossing, Build.Highway];

/** A new game owning just the plots it starts with, as a player's does. */
const fresh = (seed = 16) => World.create(seed, undefined, false);

/** A plot the port does not own beside one it does. */
function plotsFor(w: World) {
  const m = w.map;
  return { next: m.plots.findIndex((_, p) => buyable(m, p) && !seaPlot(m, p)) };
}

/** A tile in plot `p` a public road could go on: clear land. */
function clearLand(w: World, p: number): number {
  const m = w.map;
  return plotTiles(m, p).find(
    (i) => m.terrain[i] === Terrain.Grass && m.build[i] === Build.None && !m.deco[i],
  )!;
}

describe('Land', () => {
  it('starts a new game with a few plots round the jetty, and nothing built off them', () => {
    const w = fresh();
    const m = w.map;
    expect(ownedPlots(m)).toBeGreaterThanOrEqual(2);
    expect(ownedPlots(m)).toBeLessThanOrEqual(4);
    expect(m.plotsBought).toBe(0);
    // The jetty, bay and the path between them are on the port's own land.
    for (let i = 0; i < m.build.length; i++) {
      const b = m.build[i];
      if (b === Build.Jetty || b === Build.TruckBay || b === Build.Footpath) {
        expect(m.owns(i)).toBe(true);
      }
    }
  });

  it('refuses building on a plot the port does not own, saying why, and the advisor explains once', () => {
    const w = fresh();
    const m = w.map;
    const { next } = plotsFor(w);
    const tile = clearLand(w, next) ?? plotTiles(m, next)[0];
    expect(landError(m, tile)).toBe(
      `Buy this plot first ($${B.PLOT_PRICE.toLocaleString('en-US')})`,
    );
    w.drainEvents();
    const cash = w.cash;
    w.command({ type: 'build', kind: 'footpath', tiles: [tile] });
    expect(m.build[tile]).toBe(Build.None);
    expect(w.cash).toBe(cash);
    const events = w.drainEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'message',
        text: expect.stringContaining('Buy this plot first'),
      }),
    );
    expect(events).toContainEqual({ kind: 'tip', id: 'land' });
    // Further off, it says the land between comes first.
    const far = m.plots.findIndex((o, p) => !o && !buyable(m, p));
    expect(landError(m, plotTiles(m, far)[0])).toMatch(/buy the plots between/);
    // Past the port's land, as before.
    expect(landError(m, m.idx(5, m.limit + 2))).toBe('Beyond the port’s land');
  });

  it('builds a drag only on the port’s own land', () => {
    const w = fresh();
    const m = w.map;
    // A port path dragged out along the start row, from owned into unowned plots.
    const row = m.yOf(m.entry);
    const owned = [] as number[];
    const line = [] as number[];
    for (let x = 0; x < m.w; x++) {
      const i = m.idx(x, row - 1);
      if (m.terrain[i] === Terrain.Water) break;
      line.push(i);
      if (m.owns(i)) owned.push(i);
    }
    expect(owned.length).toBeGreaterThan(0);
    expect(owned.length).toBeLessThan(line.length);
    w.cash = 100_000;
    const before = line.map((i) => m.build[i]);
    w.command({ type: 'build', kind: 'footpath', tiles: line });
    line.forEach((i, k) => {
      if (!m.owns(i)) expect(m.build[i]).toBe(before[k]);
    });
    expect(line.some((i) => m.owns(i) && m.build[i] === Build.Footpath)).toBe(true);
  });

  it('sells only plots beside the port’s land, for the cash, each dearer than the last', () => {
    const w = fresh();
    const m = w.map;
    const far = m.plots.findIndex((o, p) => !o && !buyable(m, p));
    w.cash = 100_000;
    w.command({ type: 'buyPlot', plot: far });
    expect(m.plots[far]).toBe(0);
    expect(w.cash).toBe(100_000);

    const { next } = plotsFor(w);
    w.cash = plotPrice(m, next) - 1;
    w.drainEvents();
    w.command({ type: 'buyPlot', plot: next });
    expect(m.plots[next]).toBe(0);
    expect(w.drainEvents()).toContainEqual(
      expect.objectContaining({
        text: expect.stringMatching(/^Not enough money: this plot costs \$/),
      }),
    );

    // The price rises by a quarter with each plot bought.
    const prices: number[] = [];
    w.cash = 1_000_000;
    for (let k = 0; k < 10; k++) {
      const p = m.plots.findIndex((_, q) => buyable(m, q) && !seaPlot(m, q));
      prices.push(plotPrice(m, p));
      const before = w.cash;
      w.command({ type: 'buyPlot', plot: p });
      expect(m.plots[p]).toBe(1);
      expect(w.cash).toBe(before - prices[k]);
    }
    expect(prices.slice(0, 6)).toEqual([2000, 2500, 3100, 3900, 4900, 6100]);
    expect(m.plotsBought).toBe(10);
    expect(nextPrice(m)).toBe(18600);
    // Bought land can be built on, and stays bought through a save.
    const back = World.fromSave(w.toSave());
    expect(Array.from(back.map.plots)).toEqual(Array.from(m.plots));
    expect(back.map.plotsBought).toBe(10);
  });

  it('leases plots all of sea for less than land', () => {
    const w = fresh();
    const m = w.map;
    const sea = m.plots.findIndex((_, p) => seaPlot(m, p));
    const land = m.plots.findIndex((_, p) => !seaPlot(m, p));
    expect(plotPrice(m, sea)).toBe(Math.round((B.PLOT_PRICE * B.SEA_PLOT_SHARE) / 100) * 100);
    expect(plotPrice(m, land)).toBe(B.PLOT_PRICE);
  });

  it('gives an older save, free, every plot it built on, and the plots it started with', () => {
    const w = fresh();
    const m = w.map;
    const start = Array.from(m.plots);
    // Built far off the start, as anywhere could be before land was bought.
    const far = m.plots.findIndex((o, p) => !o && !buyable(m, p) && !seaPlot(m, p));
    const tile = clearLand(w, far) ?? plotTiles(m, far).find((i) => m.isLand(i))!;
    const save = w.toSave();
    save.map.build[tile] = Build.Footpath;
    delete save.map.plots;
    delete save.map.plotsBought;
    const old = World.fromSave(save);
    expect(old.map.build[tile]).toBe(Build.Footpath);
    expect(old.map.owns(tile)).toBe(true);
    expect(old.map.plotsBought).toBe(0);
    start.forEach((o, p) => o && expect(old.map.plots[p]).toBe(1));
    // The road in from the highway that every game starts with needs none.
    expect(ownedPlots(old.map)).toBe(start.filter(Boolean).length + 1);
  });

  it('starts every map with room for a second jetty and truck bay, reached by road from the highway', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const w = fresh(seed);
      const m = w.map;
      const mine = [] as number[];
      for (let i = 0; i < m.w * m.limit; i++) if (m.owns(i)) mine.push(i);
      const row = m.yOf(m.entry);
      // A jetty off the shore, away from the first.
      const jetty = mine.filter(
        (i) =>
          Math.abs(m.yOf(i) - row) >= 3 &&
          m.terrain[i] === Terrain.Water &&
          !placementError(m, 'jetty', i) &&
          m.depth[i] >= B.BOAT_DRAFT - 0.5,
      );
      expect(jetty.length, `seed ${seed}: room for a jetty`).toBeGreaterThan(0);
      // A truck bay beside the road in.
      const bay = mine.filter(
        (i) => m.build[i] === Build.None && !placementError(m, 'truckBay', i),
      );
      expect(bay.length, `seed ${seed}: room for a truck bay`).toBeGreaterThan(0);
      // Some of the road in is the port's to build off, with land to build on beside it.
      expect(mine.filter((i) => m.build[i] === Build.Road).length).toBeGreaterThanOrEqual(6);
      const land = mine.filter((i) => m.build[i] === Build.None && !placementError(m, 'road', i));
      expect(land.length, `seed ${seed}: room to build`).toBeGreaterThan(60);
      // That road runs on public road all the way from the highway.
      const firstBay = mine.find((i) => m.build[i] === Build.TruckBay)!;
      const path = findPath(
        m.w,
        m.h,
        m.entry,
        firstBay,
        (i) => (i === firstBay || ROADS.includes(m.build[i]) ? 1 : Infinity),
        false,
      );
      expect(path, `seed ${seed}: road to the highway`).not.toBeNull();
    }
  });
});
