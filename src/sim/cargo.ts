// What a crate holds. A crate in the game is its fee, the sum it earns, as
// it goes from a boat or a shipper's truck through the port; what it holds
// rides along on that fee as a few millionths, so wherever a crate goes
// what it holds goes with it, and the money is unchanged to the cent.

export const CARGO = ['fish', 'ice', 'lobster', 'goods'] as const;
export type Cargo = (typeof CARGO)[number];

const TAG = 1e-6;

/** Fee `fee` for a crate holding `c`. */
export function withCargo(fee: number, c: Cargo): number {
  return Math.round(fee) + (CARGO.indexOf(c) + 1) * TAG;
}

/** What the crate with fee `fee` holds; untagged, as in older saves, `or`. */
export function cargoOf(fee: number, or: Cargo = 'fish'): Cargo {
  const k = Math.round((fee - Math.round(fee)) / TAG);
  return CARGO[k - 1] ?? or;
}
