// Departure planning in configuration space: each candidate moves the whole
// hull sideways off the berth, then ahead or astern to water it can turn in.
import type { World } from '../../world';
import type { Boat } from '../../state';
import * as B from '../../balance';
import { hullGap } from '../../helpers';
import { boatCostFor, openAlong } from './berthing';
import { clips } from './seamanship';
import { navigable } from './traffic';

/**
 * Choose a safe departure from where the ship actually lies, including when
 * it has already cast off. Leave an existing plan intact if none is clear:
 * waiting for traffic is preferable to committing to a blocked lane.
 */
export function planDeparture(w: World, b: Boat): boolean {
  const berth = b.castOff ?? b.berth;
  const dock = b.castDock ?? b.jetty;
  if (berth < 0 || dock < 0) return false;
  const m = w.map;
  const v = B.VESSELS[b.vessel];
  const ox = m.xOf(berth) - m.xOf(dock);
  const oy = m.yOf(berth) - m.yOf(dock);
  const ax = oy !== 0 ? 1 : 0;
  const ay = 1 - ax;
  const ahead = Math.cos(b.dir) * ax + Math.sin(b.dir) * ay >= 0 ? 1 : -1;
  const water = boatCostFor(w, b.draft);
  const ships = w.boats.filter((o) => o !== b);
  const now = clips(w, b, b.x, b.y, b.dir, []);
  const gaps = ships.map((o) => hullGap(b.x, b.y, b.dir, v, o.x, o.y, o.dir, B.VESSELS[o.vessel]));
  let best: { start: number; end: number; score: number } | undefined;

  for (const off of [1, 2, 3, 0]) {
    for (const s of [ahead, -ahead]) {
      const run = openAlong(w, b, berth, dock, s, v.length / 2 + 0.5, off);
      if (run < 0) continue;
      const sx = m.xOf(berth) + ox * off + 0.5;
      const sy = m.yOf(berth) + oy * off + 0.5;
      const ex = sx + ax * s * run;
      const ey = sy + ay * s * run;
      const along = (ex - b.x) * ax * s + (ey - b.y) * ay * s;
      if (along < 0.5) continue;
      // Project the current position onto the proposed lane. A replan must
      // not first return to its old berth or teleport onto the new line.
      const px = ax ? b.x : sx;
      const py = ay ? b.y : sy;
      let clear = Infinity;
      let safe = true;
      for (const [x0, y0, x1, y1] of [
        [b.x, b.y, px, py],
        [px, py, ex, ey],
      ]) {
        const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.2));
        for (let k = 0; k <= n && safe; k++) {
          const x = x0 + ((x1 - x0) * k) / n;
          const y = y0 + ((y1 - y0) * k) / n;
          if (!navigable(w, x, y, water) || clips(w, b, x, y, b.dir, []) > now) {
            safe = false;
            break;
          }
          for (let j = 0; j < ships.length; j++) {
            const o = ships[j];
            const gap = hullGap(x, y, b.dir, v, o.x, o.y, o.dir, B.VESSELS[o.vessel]);
            // A saved ship already touching another may move out of it.
            if (gap < Math.min(0.1, gaps[j]) - 1e-6) {
              safe = false;
              break;
            }
            if (x0 === px && y0 === py) clear = Math.min(clear, gap);
          }
        }
        if (!safe) break;
      }
      if (!safe) continue;
      // Prefer ample passing room, then a short run ahead over backing or
      // a long sideways move. Extra clearance beyond the target buys no
      // advantage; otherwise ships always choose the outermost lane.
      const score =
        Math.hypot(px - b.x, py - b.y) / 0.2 +
        along / (s === ahead ? 0.75 : 0.5) +
        (off === 0 ? 20 : 0) +
        Math.max(0, B.RUN_OUT_CLEAR - clear) * 30;
      if (!best || score < best.score) {
        best = {
          start: m.idx(Math.floor(sx), Math.floor(sy)),
          end: m.idx(Math.floor(ex), Math.floor(ey)),
          score,
        };
      }
    }
  }
  if (!best) return false;
  b.lineEnd = best.start;
  b.lineup = best.end;
  b.berthing = 'out';
  b.best = Infinity;
  b.stall = 0;
  return true;
}

/**
 * Old saves can contain intersecting hulls from the former squeeze fallback.
 * Reduce their total penetration, without creating any new contact or moving
 * further into a stationary hull. Pairwise "never closer" alone can freeze
 * an already intersecting group, even though there is open water beside it.
 */
export function separateHull(w: World, b: Boat): boolean {
  const v = B.VESSELS[b.vessel];
  const ships = w.boats.filter(
    (o) =>
      o !== b &&
      Math.hypot(o.x - b.x, o.y - b.y) < (v.length + B.VESSELS[o.vessel].length) / 2 + 0.25,
  );
  const gaps = ships.map((o) => hullGap(b.x, b.y, b.dir, v, o.x, o.y, o.dir, B.VESSELS[o.vessel]));
  const energy = (gs: number[]) => gs.reduce((sum, g) => sum + Math.min(0, g) ** 2, 0);
  let best = energy(gaps);
  if (best === 0) return false;
  const water = boatCostFor(w, b.draft);
  const now = clips(w, b, b.x, b.y, b.dir, []);
  let move: [number, number] | undefined;
  const step = v.speed * 0.2;
  for (let k = 0; k < 16; k++) {
    const d = (k * Math.PI) / 8;
    const x = b.x + Math.cos(d) * step;
    const y = b.y + Math.sin(d) * step;
    if (!navigable(w, x, y, water) || clips(w, b, x, y, b.dir, []) > now) continue;
    const next = ships.map((o) => hullGap(x, y, b.dir, v, o.x, o.y, o.dir, B.VESSELS[o.vessel]));
    if (
      next.some(
        (g, j) =>
          (gaps[j] >= 0 || ships[j].state === 'moored' || ships[j].state === 'anchored') &&
          g < Math.min(0.1, gaps[j]) - 1e-6,
      )
    )
      continue;
    const e = energy(next);
    if (e < best - 1e-8) {
      best = e;
      move = [x, y];
    }
  }
  if (!move) return false;
  [b.x, b.y] = move;
  b.speed = b.sternway = 0;
  return true;
}
