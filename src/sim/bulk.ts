// Bulk cargo: coal, grain and ore, by the tonne. It is never crates: it
// lies in a bulk carrier's holds (Boat.crates counts its tonnes), in a grab
// crane's hopper, on each tile of a conveyor belt, on each tile of a
// stockpile, in a rail loadout's bin and in hopper wagons; see
// systems/bulk.ts for how it moves from one to the next.

export const BULK = ['coal', 'grain', 'ore'] as const;
export type BulkKind = (typeof BULK)[number];

/** Tonnes of one kind of bulk cargo, where they lie. */
export interface BulkLoad {
  kind: BulkKind;
  t: number;
}

export function bulkName(k: BulkKind): string {
  return k;
}
