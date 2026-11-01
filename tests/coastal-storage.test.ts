import { describe, expect, it } from 'vitest';
import { cargoOf } from '../src/sim/cargo';
import { TICKS_PER_DAY } from '../src/sim/types';
import { dropRoom } from '../src/sim/systems/cargo/stores';
import { truckLeave } from '../src/sim/systems/roads/traffic';
import { shipOut as shipOutOf } from '../src/sim/systems/cargo/exports';
import { wharf } from './wharf';
import { feesOn } from '../src/sim/systems/cargo/beds';

declare const process: { env: Record<string, string | undefined> };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** Run a port on `days`, counting what goes through it and where it sticks. */
function run(world: Any, days: number) {
  const tally = {
    timber: 0,
    goods: 0,
    canned: 0,
    full: 0,
    leftOnBoard: 0,
    brought: 0,
    anchored: 0,
  };
  const brought = new Set<number>();
  const leave = truckLeave.bind(null, world);
  world.truckLeave = (t: Any) => {
    if (t.state !== 'leaving' && t.state !== 'away') {
      for (const f of feesOn(world, t)) {
        const c = cargoOf(f);
        if (c === 'timber' || c === 'goods') tally[c]++;
      }
    }
    return leave(t);
  };
  const shipOut = shipOutOf.bind(null, world);
  world.shipOut = (b: Any, fees: number[]) => {
    tally.canned += fees.filter((f) => cargoOf(f, 'goods') === 'canned').length;
    return shipOut(b, fees);
  };
  const stores = () => [...world.bays.values()].filter((b: Any) => b.tiles && !b.outgoing);
  const seen = new Map<number, number>();
  for (let k = 0; k < TICKS_PER_DAY * days; k++) {
    world.step();
    if (stores().some((b: Any) => dropRoom(world, b, false) <= 0)) tally.full++;
    for (const b of world.boats) {
      if (b.vessel !== 'coaster') continue;
      if (!brought.has(b.id)) {
        brought.add(b.id);
        tally.brought += b.crates;
      }
      if (b.state === 'anchored') tally.anchored++;
      if (b.state === 'leaving' && !seen.has(b.id)) {
        seen.set(b.id, b.crates);
        tally.leftOnBoard += b.crates;
      }
    }
  }
  return tally;
}

describe('Storage at a busy Coastal Wharf', () => {
  it('fills small storage with timber and goods in customs, and more storage clears it', () => {
    const days = 8;
    const small = run(wharf(2, 2, true), days);
    const big = run(wharf(4, 2, true), days);
    if (process.env.BALANCE) console.log({ small, big });
    // Two tiles of storage for cargo coming in, on the quay by the berths
    // where the dockhands carry it in, hold less than a day of the
    // coasters' timber and goods, which wait there a day for customs: it is
    // full for a good while, and the coasters wait meanwhile. (Before the
    // dockhands stopped setting crates down on the quay, storage up by the
    // road filled for days; carried all that way now, the crates come in
    // too slowly to fill it.)
    expect(small.full).toBeGreaterThan(TICKS_PER_DAY / 2);
    // Four hold it, and are hardly ever full.
    expect(big.full).toBeLessThan(TICKS_PER_DAY / 2);
    // Enough gets through for the Coastal Wharf's landmarks: the builders'
    // yard's 25 crates of canned fish on board, the school's 25 of timber
    // and most of the town hall's 60 of goods trucked out in these days.
    expect(big.canned).toBeGreaterThanOrEqual(25);
    expect(big.timber).toBeGreaterThanOrEqual(25);
    expect(big.goods).toBeGreaterThanOrEqual(30);
  }, 120_000);
});
