import * as B from './balance';
import type { Rng } from './rng';

// Fisheries send boats; hauliers supply the trucks that carry crates away.

export interface FisheryTerms {
  kind: 'fishery';
  name: string;
  /** Paint colour index for this fishery's boats. */
  color: number;
  /** Average days between boats. */
  boatEvery: number;
  cratesMin: number;
  cratesMax: number;
  /** Paid per crate when it leaves the port on a truck. */
  fee: number;
}

export interface HaulierTerms {
  kind: 'haulier';
  name: string;
  color: number;
  /** Trucks this haulier can have at the port at once. */
  fleet: number;
  capacity: number;
  dailyFee: number;
}

export type Terms = FisheryTerms | HaulierTerms;

export interface Contract {
  id: number;
  terms: Terms;
  /** Paid to sign; sets the breach penalty and the fee for ending early. */
  signingFee: number;
  /** Fisheries only: 0 to 100. The fishery walks away at 0. */
  satisfaction: number;
  /** Fisheries only. */
  nextBoatTick: number;
  warned: boolean;
}

export interface Offer {
  id: number;
  terms: Terms;
  signingFee: number;
  expires: number;
}

const FISHERIES = [
  'Saltmarsh Fishing Co-op',
  'Northwind Trawlers',
  'Kelp & Sons',
  'Blue Fin Fisheries',
  'Herring Hollow Fleet',
  'Silver Tide Fishing',
  'Old Cod Partnership',
  'Lobster Pot Ltd',
  'Gull Rock Fishers',
  'Deepwater Catch Co.',
];

const HAULIERS = [
  'Bramble Transport',
  'Quick Lorry Ltd',
  'Ferris Freight',
  'Atlas Haulage',
  'Red Road Carriers',
  'Milestone Logistics',
  'Hilltop Hauliers',
  'Two Wheels Short Ltd',
];

export const STARTER_FISHERY: FisheryTerms = {
  kind: 'fishery',
  name: "Harbour Fishermen's Co-op",
  color: 0,
  boatEvery: B.BOAT_INTERVAL_DAYS,
  cratesMin: B.BOAT_CRATES_MIN,
  cratesMax: B.BOAT_CRATES_MAX,
  fee: B.CRATE_FEE,
};

export const STARTER_HAULIER: HaulierTerms = {
  kind: 'haulier',
  name: "Pip's Haulage",
  color: 0,
  fleet: 1,
  capacity: B.TRUCK_CAPACITY,
  dailyFee: B.STARTER_HAULIER_FEE,
};

/** Rough income a fishery brings per day if every crate is handled. */
export function fisheryDailyValue(t: FisheryTerms): number {
  return (((t.cratesMin + t.cratesMax) / 2) * t.fee) / t.boatEvery;
}

export function makeOffer(
  rng: Rng,
  id: number,
  tick: number,
  kind: Terms['kind'],
  takenNames: Set<string>,
): Offer | null {
  const names = (kind === 'fishery' ? FISHERIES : HAULIERS).filter((n) => !takenNames.has(n));
  if (names.length === 0) return null;
  const name = rng.pick(names);
  const expires = tick + Math.round(rng.range(4, 8) * 600);

  if (kind === 'fishery') {
    const cratesMin = rng.int(6, 12);
    const terms: FisheryTerms = {
      kind,
      name,
      color: rng.int(0, 3),
      boatEvery: Math.round(rng.range(0.35, 1) * 20) / 20,
      cratesMin,
      cratesMax: Math.min(B.BOAT_MAX_LOAD, cratesMin + rng.int(2, 5)),
      fee: rng.int(12, 22),
    };
    const signingFee = Math.round((fisheryDailyValue(terms) * 1.5) / 50) * 50;
    return { id, terms, signingFee, expires };
  }

  const fleet = rng.int(1, 3);
  const capacity = rng.next() < 0.35 ? B.BIG_TRUCK_CAPACITY : B.TRUCK_CAPACITY;
  const perTruck = capacity === B.BIG_TRUCK_CAPACITY ? 30 : 20;
  const terms: HaulierTerms = {
    kind,
    name,
    color: rng.int(0, 4),
    fleet,
    capacity,
    dailyFee: fleet * perTruck + rng.int(0, 2) * 5,
  };
  return { id, terms, signingFee: fleet * 150, expires };
}
