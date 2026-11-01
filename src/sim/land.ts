import * as B from './balance';
import type { GameMap } from './map';
import { Build, Terrain } from './types';

// The port's land, bought a plot at a time: a grid of PLOT_SIZE square plots
// over the port's rows, owned or not (GameMap.plots). Anything the player
// builds or changes on a tile needs its plot owned; boats, trucks, and the
// roads, highway and railway already there pass through the rest. Only a
// plot beside one the port owns can be bought, each dearer than the last.

/** Shown for the country past the port's land. */
export const OUTSIDE = 'Beyond the port’s land';

/** Shown when building on a plot the port could buy, before the price. */
export const BUY_FIRST = 'Buy this plot first';

/** Shown when building on a plot the port cannot buy yet. */
export const NOT_NEXT = 'Not the port’s land: buy the plots between it and yours first';

/** The tiles of plot `p`, row by row. */
export function plotTiles(map: GameMap, p: number): number[] {
  const { x0, y0, x1, y1 } = plotBounds(map, p);
  const out: number[] = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out.push(map.idx(x, y));
  return out;
}

/** Plot `p`'s corners in tiles: from x0, y0 up to, not including, x1, y1. */
export function plotBounds(
  map: GameMap,
  p: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const x0 = (p % map.plotsWide) * B.PLOT_SIZE;
  const y0 = Math.floor(p / map.plotsWide) * B.PLOT_SIZE;
  return {
    x0,
    y0,
    x1: Math.min(map.w, x0 + B.PLOT_SIZE),
    y1: Math.min(map.limit, y0 + B.PLOT_SIZE),
  };
}

/** The plots sharing an edge with plot `p`. */
export function plotNeighbours(map: GameMap, p: number): number[] {
  const pw = map.plotsWide;
  const px = p % pw;
  const py = Math.floor(p / pw);
  const out: number[] = [];
  if (px > 0) out.push(p - 1);
  if (px < pw - 1) out.push(p + 1);
  if (py > 0) out.push(p - pw);
  if (py < map.plotsHigh - 1) out.push(p + pw);
  return out;
}

/** A plot that is all sea, leased from the harbour authority for less than land. */
export function seaPlot(map: GameMap, p: number): boolean {
  return plotTiles(map, p).every((i) => map.terrain[i] === Terrain.Water);
}

/**
 * What plot `p` would cost now: the next plot's price, rising with every one
 * bought, and less for seabed.
 */
export function plotPrice(map: GameMap, p: number): number {
  return nextPrice(map, seaPlot(map, p));
}

/** What the next plot of land costs, or of seabed with `sea`, after `bought` more. */
export function nextPrice(map: GameMap, sea = false, bought = 0): number {
  const land = B.PLOT_PRICE * B.PLOT_PRICE_RISE ** (map.plotsBought + bought);
  return Math.round((sea ? land * B.SEA_PLOT_SHARE : land) / 100) * 100;
}

/** Whether the port could buy plot `p`: not its own yet, and beside one that is. */
export function buyable(map: GameMap, p: number): boolean {
  if (p < 0 || p >= map.plots.length || map.plots[p]) return false;
  return plotNeighbours(map, p).some((n) => map.plots[n] === 1);
}

/** Why plot `p` cannot be bought, cash aside, or null if it can. */
export function plotError(map: GameMap, p: number): string | null {
  if (p < 0 || p >= map.plots.length) return OUTSIDE;
  if (map.plots[p]) return 'The port owns this plot already';
  return buyable(map, p) ? null : 'Only a plot beside the port’s own land can be bought';
}

/** Plots the port owns. */
export function ownedPlots(map: GameMap): number {
  let n = 0;
  for (const o of map.plots) n += o;
  return n;
}

/**
 * Why the player cannot build on or change tile `i` for want of land: past
 * the port's land, or on a plot not bought yet. Null on the port's own land.
 */
export function landError(map: GameMap, i: number): string | null {
  if (!map.buildable(i)) return OUTSIDE;
  if (map.owns(i)) return null;
  const p = map.plotOf(i);
  return buyable(map, p)
    ? `${BUY_FIRST} ($${plotPrice(map, p).toLocaleString('en-US')})`
    : NOT_NEXT;
}

/** Whether a reason given is the want of land, which the advisor explains once. */
export function isLandError(err: string): boolean {
  return err.startsWith(BUY_FIRST) || err === NOT_NEXT;
}

/**
 * The plots a new game starts with, free: just those under its first
 * jetty, the water off its end, the path to it and the end of the road in
 * where the pickups turn about; the rest of the shore it buys as it grows.
 * One plot to four, as they straddle lines between plots. The public road
 * in from the highway is the town's and needs none.
 */
export function startPlots(map: GameMap, row: number, shoreX: number): number[] {
  const out = new Set<number>();
  for (let y = row - 1; y <= row + 1; y++) {
    for (let x = shoreX - 6; x <= shoreX + 5; x++) {
      const [cx, cy] = [Math.min(map.w - 1, Math.max(0, x)), Math.min(map.h - 1, Math.max(0, y))];
      out.add(Math.floor(cy / B.PLOT_SIZE) * map.plotsWide + Math.floor(cx / B.PLOT_SIZE));
    }
  }
  return [...out];
}

/** Own just the plots given, and none bought yet: a new game's land. */
export function ownOnly(map: GameMap, plots: number[]): void {
  map.plots.fill(0);
  for (const p of plots) map.plots[p] = 1;
  map.plotsBought = 0;
}

/**
 * For a save from before land was bought: the port owns, free, every plot
 * with anything the player built or changed on it (told apart from the map
 * as it was made, `fresh`), and those a new game would start with. Nothing
 * built is ever lost.
 */
export function ownBuilt(map: GameMap, fresh: GameMap): void {
  const same = fresh.w === map.w && fresh.limit === map.limit;
  const owned = new Uint8Array(map.plots.length);
  if (same) for (let p = 0; p < owned.length; p++) owned[p] = fresh.plots[p];
  for (let i = 0; i < map.w * map.limit; i++) {
    const b = map.build[i];
    const was = same ? fresh.build[i] : Build.None;
    // Not the highway or the railway, laid over the ground as it was, nor
    // the road in that a new game starts with, where it crosses the railway too.
    if (b === Build.Highway || b === Build.Rail || (b === Build.Crossing && was === Build.Road)) {
      continue;
    }
    const ours =
      (b !== Build.None && b !== was) ||
      map.store[i] !== 0 ||
      (same &&
        (map.terrain[i] !== fresh.terrain[i] || Math.abs(map.depth[i] - fresh.depth[i]) > 0.05));
    if (ours) owned[map.plotOf(i)] = 1;
  }
  map.plots.set(owned);
  map.plotsBought = 0;
}
