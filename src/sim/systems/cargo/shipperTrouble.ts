// What stops a shipper's trucks bringing their cargo in, in the player's
// words: what to build, and where. A signed shipper's first trouble is a
// red mark on the map and a line on its contract; an offer's checks say
// the same before it is signed.

import type { World } from '../../world';
import type { Bay } from '../../state';
import type { Contract, ShipperTerms } from '../../contracts';
import { isIce } from '../../contracts';
import { needsWideSpace } from '../../rules/parking';
import { Build } from '../../types';
import { lots, lotTrouble } from '../roads/bays';

/** One thing a shipper needs, and whether the port has it. */
export interface ShipperCheck {
  kind: 'parking' | 'storage' | 'reach' | 'ships';
  ok: boolean;
  /** Short of it, but the trucks still come: a warning, not a red mark. */
  warn?: boolean;
  text: string;
  /** For 'reach': the outgoing storage its trucks cannot get to. */
  stores?: number[];
}

/** The first thing stopping a signed shipper working; see shipperTrouble. */
export interface ShipperTrouble {
  kind: ShipperCheck['kind'] | 'full';
  text: string;
  /** Its trucks cannot come or unload at all: a red mark on the map. */
  bad: boolean;
  stores?: number[];
}

/** " CX1, CX2" for the designations of `list`, or nothing when none has one. */
function named(list: { name?: string }[]): string {
  const names = list
    .map((b) => b.name)
    .filter((n): n is string => !!n)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  return names.length > 0 ? ` ${names.join(', ')}` : '';
}

/** Outgoing storage of the kind this shipper's cargo goes into. */
function outgoingStores(w: World, t: ShipperTerms): Bay[] {
  return [...(t.cargo === 'container' ? w.yards : w.bays).values()].filter(
    (b) => b.tiles && b.outgoing,
  );
}

/**
 * Each thing a shipper (not the ice works, whose trucks drive straight to
 * a truck bay) needs, in order: truck parking outside the port, outgoing
 * storage, a way for its trucks to that storage, and ships to take its
 * cargo out.
 */
export function shipperChecks(w: World, t: ShipperTerms): ShipperCheck[] {
  const boxes = t.cargo === 'container';
  const store = boxes ? 'container yard' : 'crate storage';
  const out: ShipperCheck[] = [];

  // Parking outside, on a public road, that trucks can drive into.
  const wide = needsWideSpace(t.capacity, boxes);
  const outside = lots(w).filter((l) => l.outside && !lotTrouble(w, l));
  const fits = outside.filter((l) => !wide || l.wide);
  const wait =
    t.goods === 'canned' ? 'before they come in' : 'for a day of paperwork before they come in';
  out.push(
    fits.length > 0
      ? {
          kind: 'parking',
          ok: true,
          text: `Its trucks wait in parking${named([fits[0]])} outside the port ${wait}`,
        }
      : {
          kind: 'parking',
          ok: false,
          text:
            outside.length > 0
              ? `Its trucks are big and wait in parking outside the port ${wait}: mark out truck parking two tiles wide on a public road, with road along both its long sides`
              : `Its trucks wait in parking outside the port ${wait}: mark out truck parking on a public road, with road along both its long sides`,
        },
  );

  // Storage marked out for cargo going out, open.
  const stores = outgoingStores(w, t);
  const open = stores.filter((b) => !b.shut);
  if (open.length === 0) {
    out.push({
      kind: 'storage',
      ok: false,
      text:
        stores.length > 0
          ? `Its trucks unload into ${store} for cargo going out, and all of it is shut: open some, or mark out more`
          : `Its trucks unload into ${store} for cargo going out: mark some out on a port road or quay inside a port gate, with port road beside it for the trucks`,
    });
  } else {
    out.push({
      kind: 'storage',
      ok: true,
      text: `Outgoing ${store}${named(open)} for its ${boxes ? 'containers' : 'crates'}`,
    });
    // A truck can get to a spot beside some of it: from the highway, on a
    // public road or through a port gate, not on machines-only ground.
    const reached = open.filter((b) => w.loadingDocks(b).length > 0);
    if (reached.length === 0) {
      const gate = w.map.build.includes(Build.Gate);
      const what = `the outgoing ${store}${named(open)}`;
      out.push({
        kind: 'reach',
        ok: false,
        stores: open.map((b) => b.idx),
        text: gate
          ? `Its trucks cannot get to ${what}: they unload from a port road or quay beside it, inside the port through a port gate, never from machines-only ground`
          : `Its trucks cannot get to ${what}: they come into the port through a port gate. Build one where a port road meets the public road, with port road on to the storage`,
      });
    } else {
      out.push({
        kind: 'reach',
        ok: true,
        text: `Its trucks can drive to ${reached.length === 1 ? 'it' : 'them'} to unload${reached.length < open.length ? `:${named(reached)}` : ''}`,
      });
    }
  }

  // A line whose ships take the cargo out.
  const vessel = boxes ? 'feeder' : 'coaster';
  const ships = w.contracts.some((c) => c.terms.kind === 'fishery' && c.terms.vessel === vessel);
  out.push({
    kind: 'ships',
    ok: ships,
    warn: !ships,
    text: ships
      ? `${boxes ? 'Feeders' : 'Coasters'} call to take it out`
      : `No ${boxes ? 'container line' : 'shipping line'} sends ${vessel}s yet to take it out: its cargo waits in storage until one does. Sign one from the offers`,
  });
  return out;
}

/**
 * The first thing stopping signed shipper `c` working, or null when
 * nothing does: no parking outside, no outgoing storage, none its trucks
 * can reach, no ships to take its cargo; or, softer, its trucks waiting
 * because the outgoing storage is full. Null for the ice works, whose
 * trucks drive straight to a truck bay.
 */
export function shipperTrouble(w: World, c: Contract): ShipperTrouble | null {
  const t = c.terms;
  if (t.kind !== 'shipper' || isIce(t)) return null;
  const miss = shipperChecks(w, t).find((k) => !k.ok);
  if (miss) return { kind: miss.kind, text: miss.text, bad: !miss.warn, stores: miss.stores };
  const waiting = w.trucks.some(
    (k) =>
      k.contractId === c.id &&
      k.exports &&
      k.state === 'parked' &&
      w.tick >= (k.papers ?? 0) &&
      !w.outgoingRoom(k),
  );
  if (!waiting) return null;
  const store = t.cargo === 'container' ? 'container yards are' : 'crate storage is';
  return {
    kind: 'full',
    bad: false,
    text: `Its trucks are waiting in parking: the outgoing ${store} full. Mark out more, or get ships loading`,
  };
}
