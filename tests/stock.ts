import type { Bay } from '../src/sim/state';
import type { World } from '../src/sim/world';
import { setDown } from '../src/sim/systems/cargo/places';

export { cratesAt } from '../src/sim/helpers';
export { feesIn, usedSlots } from '../src/sim/systems/cargo/places';

/**
 * Crates set down at a bay as if they had been there a while: in the slots
 * `at` if given, else where they would go now, none of them waiting on
 * customs or papers.
 */
export function stockUp(w: World, b: Bay, fees: number[], out = false, at?: number[]): void {
  setDown(w, b, fees, out, undefined, { cleared: true, at });
}
