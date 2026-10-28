import * as B from './balance';
import type { Rng } from './rng';

// Fisheries send boats; hauliers supply the trucks that carry crates away.

/** A supplier of boats: a local fishery or, later, a shipping line with coasters. */
export interface FisheryTerms {
  kind: 'fishery';
  vessel: 'smack' | 'coaster' | 'feeder';
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
  /** Container hauliers carry containers instead of crates. */
  cargo?: 'container';
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

const SHIPPING_LINES = [
  'Baltic Coasters',
  'North Sea Shipping',
  'Blue Anchor Line',
  'Atlantic Short Sea',
  'Gannet Shipping',
  'Harbour Line',
];

const CONTAINER_LINES = [
  'Maersk-ish Feeders',
  'Blue Box Line',
  'Seven Seas Container Co.',
  'Harbour Feeder Services',
  'Coastal Box Lines',
];

const CONTAINER_HAULIERS = ['Box Haul Ltd', 'Twenty Foot Transport', 'Steel Box Logistics'];

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
  vessel: 'smack',
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

/** Average crates a fishery lands per day. */
export function fisheryDailyCrates(t: FisheryTerms): number {
  return (t.cratesMin + t.cratesMax) / 2 / t.boatEvery;
}

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
  tier = 0,
): Offer | null {
  const roll = rng.next();
  const feeder = kind === 'fishery' && tier >= 2 && roll < 0.4;
  const coaster = kind === 'fishery' && !feeder && tier >= 1 && roll < 0.7;
  const boxTrucks = kind === 'haulier' && tier >= 2 && roll < 0.35;
  const pool = feeder
    ? CONTAINER_LINES
    : coaster
      ? SHIPPING_LINES
      : boxTrucks
        ? CONTAINER_HAULIERS
        : kind === 'fishery'
          ? FISHERIES
          : HAULIERS;
  const names = pool.filter((n) => !takenNames.has(n));
  if (names.length === 0) return null;
  const name = rng.pick(names);
  const expires = tick + Math.round(rng.range(4, 8) * 600);

  if (feeder) {
    // Feeders bring few, valuable containers and need a harbour crane.
    const cratesMin = rng.int(12, 16);
    const terms: FisheryTerms = {
      kind: 'fishery',
      vessel: 'feeder',
      name,
      color: rng.int(0, 3),
      boatEvery: Math.round(rng.range(1.2, 2.2) * 20) / 20,
      cratesMin,
      cratesMax: Math.min(B.FEEDER_MAX_LOAD, cratesMin + rng.int(2, 6)),
      fee: rng.int(120, 170),
    };
    const signingFee = Math.round((fisheryDailyValue(terms) * 2) / 100) * 100;
    return { id, terms, signingFee, expires };
  }

  if (boxTrucks) {
    // A truck takes one or two containers; the one-box firms run more trucks.
    const capacity = rng.int(1, B.CONTAINER_TRUCK_CAPACITY);
    const fleet = capacity === 1 ? rng.int(2, 3) : rng.int(1, 2);
    const terms: HaulierTerms = {
      kind,
      name,
      color: rng.int(0, 4),
      fleet,
      capacity,
      dailyFee: fleet * (capacity === 1 ? 35 : 55),
      cargo: 'container',
    };
    return { id, terms, signingFee: fleet * 400, expires };
  }

  if (coaster) {
    // Coasters bring big loads at good rates but need deep water to moor.
    const cratesMin = rng.int(14, 18);
    const terms: FisheryTerms = {
      kind: 'fishery',
      vessel: 'coaster',
      name,
      color: rng.int(0, 3),
      boatEvery: Math.round(rng.range(1, 1.8) * 20) / 20,
      cratesMin,
      cratesMax: Math.min(B.COASTER_MAX_LOAD, cratesMin + rng.int(3, 6)),
      fee: rng.int(22, 30),
    };
    const signingFee = Math.round((fisheryDailyValue(terms) * 2) / 50) * 50;
    return { id, terms, signingFee, expires };
  }

  if (kind === 'fishery') {
    const cratesMin = rng.int(6, 12);
    const terms: FisheryTerms = {
      kind,
      vessel: 'smack',
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
  // Big trucks come with the Coastal Wharf, which unlocks large truck bays.
  const capacity = tier >= 1 && rng.next() < 0.4 ? B.BIG_TRUCK_CAPACITY : B.TRUCK_CAPACITY;
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
