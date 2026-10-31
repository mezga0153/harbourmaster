// What the game tells the player as it goes: messages, the advisor's tips, money floating up off the map, and the changes to the tiles and plots the view is sent each frame.

import type { World } from '../world';

/** The advisor's first steps, one each time a boat leaves; see departTips. */
export const FIRST_STEPS = ['speed', 'jetty', 'contract', 'screens'];
import { isLandError } from '../land';
import { Build, TICKS_PER_DAY } from '../types';
import * as B from '../balance';
import type { SimEvent, TileChange } from '../../protocol/messages';

export function message(w: World, text: string, tone: 'info' | 'good' | 'bad'): void {
  w.events.push({ kind: 'message', text, tone });
  // Refused for want of land: the advisor says how land is bought, once.
  if (tone === 'bad' && isLandError(text)) tip(w, 'land');
}

/**
 * A warning that comes back while the trouble lasts: given at once, then
 * again after a day, two, four and at most eight, so it is never noise.
 */
export function nag(w: World, key: string, text: string, tone: 'info' | 'good' | 'bad'): void {
  const n = w.nags.get(key);
  if (n && w.tick < n.next) return;
  const gap = n ? Math.min(n.gap * 2, TICKS_PER_DAY * 8) : TICKS_PER_DAY;
  w.nags.set(key, { next: w.tick + gap, gap });
  message(w, text, tone);
}

/** Have the advisor explain something, the first time it comes up in a game. */
export function tip(w: World, id: string): void {
  if (w.tipsSeen.has(id)) return;
  w.tipsSeen.add(id);
  w.events.push({ kind: 'tip', id });
}

/** As tip, but not if the player has already `done` what it would teach them. */
export function tipUnless(w: World, id: string, done: boolean): void {
  if (done) w.tipsSeen.add(id);
  else tip(w, id);
}

/**
 * The first steps, a boat leaving at a time: speeding the game up, then
 * another jetty, another contract and the finance and statistics screens.
 * Each comes after the one before, the next boat but one, and none the
 * player has already got round to.
 */
export function departTips(w: World): void {
  const n = ++w.departed;
  const at = FIRST_STEPS.findIndex((id) => !w.tipsSeen.has(id));
  // One a boat, the first after the first boat has left.
  if (at < 0 || n <= at) return;
  const id = FIRST_STEPS[at];
  tipUnless(w, id, id === 'jetty' && w.docks().length > 1);
}

export function moneyAt(w: World, amount: number, i: number): void {
  w.events.push({ kind: 'money', amount, x: w.map.xOf(i) + 0.5, y: w.map.yOf(i) + 0.5 });
}

export function depotViews(w: World): { idx: number; forklifts: number }[] {
  const out: { idx: number; forklifts: number }[] = [];
  for (let i = 0; i < w.map.build.length; i++) {
    if (w.map.build[i] === Build.Depot) {
      out.push({ idx: i, forklifts: B.DEPOT_SLOTS - w.depotRoom(i) });
    }
  }
  return out;
}

export function drainEvents(w: World): SimEvent[] {
  const out = w.events;
  w.events = [];
  return out;
}

export function drainTileChanges(w: World): TileChange[] {
  const out = [...w.dirty].map((i) => ({
    i,
    terrain: w.map.terrain[i],
    depth: w.map.depth[i],
    ocean: w.map.ocean[i],
    build: w.map.build[i],
    orient: w.map.orient[i],
    deco: w.map.deco[i],
    store: w.map.store[i],
  }));
  w.dirty.clear();
  return out;
}

/** The port's plots and how many were bought, when that has changed since last asked. */
export function drainPlotChanges(w: World): { plots: number[]; bought: number } | undefined {
  if (!w.plotsChanged) return undefined;
  w.plotsChanged = false;
  return { plots: Array.from(w.map.plots), bought: w.map.plotsBought };
}
