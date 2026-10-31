// Each truck bay, storage area, container yard and parking lot's designation,
// a letter or two and a number, painted on its sign or on the ground: B3,
// C2, CX1, Y1, YX1, P2. Numbers count up from 1 for each kind, the lowest
// free one going to a new place, so one freed by a demolition is used again.

import type { Bay } from './state';

/** The letters of each kind of place: X for storage of cargo going out. */
export const PREFIX = {
  bay: 'B',
  crates: 'C',
  cratesOut: 'CX',
  boxes: 'Y',
  boxesOut: 'YX',
  parking: 'P',
} as const;

/** The letters a truck bay or storage area's designation starts with. */
export function prefixOf(b: Bay): string {
  if (!b.tiles) return PREFIX.bay;
  if (b.yard) return b.outgoing ? PREFIX.boxesOut : PREFIX.boxes;
  return b.outgoing ? PREFIX.cratesOut : PREFIX.crates;
}

/** The lowest numbered designation with these letters not in `used`. */
export function freeName(prefix: string, used: Set<string>): string {
  for (let n = 1; ; n++) {
    const name = `${prefix}${n}`;
    if (!used.has(name)) return name;
  }
}

/**
 * Designations for areas laid out afresh from what was marked out before:
 * each keeps the one most of its tiles had in `had`, as long as it is of
 * its kind, the largest area first, so of an area split in two the larger
 * part keeps it; the rest get the lowest free, in the order given.
 */
export function handOn<T extends { tiles: number[] }>(
  areas: T[],
  prefix: (a: T) => string,
  had: Map<number, string>,
  set: (a: T, name: string) => void,
  used = new Set<string>(),
): void {
  const named = new Set<T>();
  const largest = [...areas].sort(
    (a, b) => b.tiles.length - a.tiles.length || a.tiles[0] - b.tiles[0],
  );
  for (const a of largest) {
    const counts = new Map<string, number>();
    for (const t of a.tiles) {
      const name = had.get(t);
      if (name && isOf(name, prefix(a))) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    let best: string | null = null;
    for (const [name, n] of counts) {
      if (used.has(name)) continue;
      if (!best || n > counts.get(best)! || (n === counts.get(best) && name < best)) best = name;
    }
    if (!best) continue;
    used.add(best);
    named.add(a);
    set(a, best);
  }
  for (const a of areas) {
    if (named.has(a)) continue;
    const name = freeName(prefix(a), used);
    used.add(name);
    set(a, name);
  }
}

/** Whether a designation has just these letters: C2 is not CX2's kind. */
function isOf(name: string, prefix: string): boolean {
  return name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length));
}

/** Give any truck bay without a designation one, lowest tile first. */
export function nameBays(bays: Iterable<Bay>): void {
  const all = [...bays].filter((b) => !b.tiles);
  const used = new Set(all.flatMap((b) => (b.name ? [b.name] : [])));
  for (const b of all.sort((a, b) => a.idx - b.idx)) {
    if (b.name) continue;
    b.name = freeName(PREFIX.bay, used);
    used.add(b.name);
  }
}

/** A place as the status lines name it: "truck bay B3", "crate storage C2", "container yard Y1". */
export function placeOf(b: Bay): string {
  const what = b.yard ? 'container yard' : b.tiles ? 'crate storage' : 'truck bay';
  return b.name ? `${what} ${b.name}` : `the ${what}`;
}
