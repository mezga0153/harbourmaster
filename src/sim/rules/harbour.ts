// The harbour as the boats find it: its middle, and the buoys in order.

import type { GameMap } from '../map';
import { Build, isDock } from '../types';

/** The middle of the docks, which buoys are ordered from. */
export function harbourCentre(map: GameMap): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let n = 0;
  for (let i = 0; i < map.build.length; i++) {
    if (!isDock(map.build[i])) continue;
    x += map.xOf(i) + 0.5;
    y += map.yOf(i) + 0.5;
    n++;
  }
  if (n === 0) return { x: map.xOf(map.entry) + 0.5, y: map.yOf(map.entry) + 0.5 };
  return { x: x / n, y: y / n };
}

/**
 * Buoys of one colour in the order boats take them: the green way in from
 * the one furthest from the docks, the red way out from the nearest.
 */
export function buoyOrder(map: GameMap, out: boolean): number[] {
  const c = harbourCentre(map);
  const d = (i: number) => Math.hypot(map.xOf(i) + 0.5 - c.x, map.yOf(i) + 0.5 - c.y);
  const code = out ? Build.BuoyOut : Build.BuoyIn;
  const buoys: number[] = [];
  for (let i = 0; i < map.build.length; i++) if (map.build[i] === code) buoys.push(i);
  return buoys.sort((p, q) => (out ? d(p) - d(q) : d(q) - d(p)));
}

/**
 * Buoys of one colour paired off in the order boats take them: each pair
 * marks a line boats cross between the two (`b` is -1 for a buoy left over,
 * which boats pass close by instead).
 */
export function buoyGates(map: GameMap, out: boolean): { a: number; b: number }[] {
  const buoys = buoyOrder(map, out);
  const gates: { a: number; b: number }[] = [];
  for (let k = 0; k < buoys.length; k += 2) gates.push({ a: buoys[k], b: buoys[k + 1] ?? -1 });
  return gates;
}
