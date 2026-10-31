import { describe, expect, it } from 'vitest';
import { dragTiles } from '../src/input/pointer';
import { previewFor } from '../src/preview';
import { previewLand } from '../src/preview/land';
import { previewRoad } from '../src/preview/roads';
import { previewTerraform } from '../src/preview/terraform';
import * as B from '../src/sim/balance';
import { buyable, plotPrice } from '../src/sim/land';
import { HIGHWAY_COLUMNS } from '../src/sim/roads';
import { placementCost, placementError, terraformCost, terraformError } from '../src/sim/rules';
import { TIERS } from '../src/sim/tiers';
import { Build, Terrain } from '../src/sim/types';
import { World } from '../src/sim/world';

// What a tool in hand shows before anything is built, worked out from the
// map alone (src/preview/).

const world = World.create(16);
const map = world.map;
const snap = world.snapshot();

/** The first tile `pred` likes, scanning the map. */
function tileWhere(pred: (i: number) => boolean): number {
  for (let i = 0; i < map.build.length; i++) if (pred(i)) return i;
  throw new Error('no such tile on this map');
}

describe('The tiles a drag covers', () => {
  it('runs an L from the start along x, then along y, for a line tool', () => {
    const tiles = dragTiles(map, 'road', map.idx(2, 2), map.idx(5, 4));
    expect(tiles).toEqual([
      map.idx(2, 2),
      map.idx(3, 2),
      map.idx(4, 2),
      map.idx(5, 2),
      map.idx(5, 3),
      map.idx(5, 4),
    ]);
  });

  it('fills the rectangle for an area tool, and is just the tile for a click', () => {
    expect(dragTiles(map, 'portRoad', map.idx(3, 3), map.idx(2, 2))).toEqual([
      map.idx(2, 2),
      map.idx(3, 2),
      map.idx(2, 3),
      map.idx(3, 3),
    ]);
    expect(dragTiles(map, 'crateStore', map.idx(1, 1), map.idx(1, 1))).toEqual([map.idx(1, 1)]);
    expect(dragTiles(map, 'road', null, 7)).toEqual([7]);
  });
});

describe('Previewing a build', () => {
  it('shows nothing with the select tool, or off the map', () => {
    expect(previewFor(map, snap, 'select', 5, [5], 5, null).preview).toBeNull();
    const off = previewFor(map, snap, 'road', null, [], 0, null);
    expect(off.preview).toBeNull();
    expect(off.ghosts.tiles).toEqual([]);
    expect(off.hints).toEqual([]);
  });

  it('prices a road on clear ground and marks the tile green', () => {
    const i = tileWhere(
      (k) =>
        map.terrain[k] === Terrain.Grass &&
        map.build[k] === Build.None &&
        !placementError(map, 'road', k, new Set()),
    );
    const r = previewFor(map, snap, 'road', i, [i], i, null);
    expect(r.ghosts).toEqual({ tiles: [i], ok: [true] });
    expect(r.preview).toMatchObject({
      count: 1,
      rotatable: false,
      value: -placementCost(map, 'road', i),
      error: null,
    });
  });
});

describe('Previewing the rules of the road', () => {
  it('says when a highway exit is not yet to be had, and where to click for one', () => {
    const i = map.idx(HIGHWAY_COLUMNS + 4, 20);
    const locked = previewRoad(map, 0, 'highwayExit', [i]);
    expect(locked.preview?.error).toBe(`Unlocks at the ${TIERS[B.EXIT_TIER].name}`);
    expect(locked.preview?.count).toBe(0);
    expect(locked.ghosts.tiles).toHaveLength(HIGHWAY_COLUMNS + 1);
    expect(locked.ghosts.ok.every((ok) => !ok)).toBe(true);

    const away = previewRoad(map, B.EXIT_TIER, 'highwayExit', [i]);
    expect(away.preview?.error).toBe('Click the highway, down the west edge');
    expect(away.preview?.value).toBe(-B.EXIT_COST);
  });

  it('asks for a port gate before changing its way', () => {
    const i = tileWhere((k) => map.build[k] === Build.None && map.terrain[k] === Terrain.Grass);
    const r = previewRoad(map, 9, 'gateWay', [i]);
    expect(r.preview).toMatchObject({ count: 0, value: 0, error: 'Click a port gate' });
    expect(r.ghosts).toEqual({ tiles: [i], ok: [false] });
  });
});

describe('Previewing dredging', () => {
  it('prices the seabed that can be dug, and says why not where it cannot', () => {
    const sea = tileWhere(
      (k) => map.terrain[k] === Terrain.Water && !terraformError(map, k, false, new Set()),
    );
    const dig = previewTerraform(map, [sea], false);
    expect(dig.ghosts).toEqual({ tiles: [sea], ok: [true] });
    expect(dig.preview).toMatchObject({
      count: 1,
      value: -terraformCost(map, sea, false),
      error: null,
    });

    const rock = tileWhere((k) => !!terraformError(map, k, false, new Set()));
    const no = previewTerraform(map, [rock], false);
    expect(no.ghosts.ok).toEqual([false]);
    expect(no.preview).toMatchObject({
      count: 0,
      value: 0,
      error: terraformError(map, rock, false, new Set()),
    });
  });
});

describe('Previewing a plot of land', () => {
  const port = World.create(7, undefined, false);
  const m = port.map;
  const forSale = (() => {
    for (let p = 0; p < m.plots.length; p++) if (!m.plots[p] && buyable(m, p)) return p;
    throw new Error('nothing for sale');
  })();
  const tile = m.idx(
    (forSale % m.plotsWide) * B.PLOT_SIZE,
    Math.floor(forSale / m.plotsWide) * B.PLOT_SIZE,
  );

  it('offers a plot beside the port at its price, counted as a plot', () => {
    const r = previewLand(m, 1_000_000, tile);
    expect(r.preview).toMatchObject({
      count: 1,
      unit: 'plot',
      value: -plotPrice(m, forSale),
      error: null,
    });
    expect(r.ghosts.tiles).toEqual([]);
  });

  it('refuses one the port cannot afford, or already owns', () => {
    expect(previewLand(m, 0, tile).preview).toMatchObject({
      count: 0,
      error: 'Not enough money',
      value: -plotPrice(m, forSale),
    });
    const owned = (() => {
      for (let p = 0; p < m.plots.length; p++) if (m.plots[p]) return p;
      throw new Error('nothing owned');
    })();
    const ownedTile = m.idx(
      (owned % m.plotsWide) * B.PLOT_SIZE,
      Math.floor(owned / m.plotsWide) * B.PLOT_SIZE,
    );
    const r = previewLand(m, 1_000_000, ownedTile);
    expect(r.preview?.count).toBe(0);
    expect(r.preview?.error).not.toBeNull();
    expect(r.preview?.value).toBe(0);
  });
});
