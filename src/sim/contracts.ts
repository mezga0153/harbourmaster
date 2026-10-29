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

/**
 * A shipper sends goods in by truck to go out on the ships: crates on the
 * coasters, containers on the feeders.
 */
export interface ShipperTerms {
  kind: 'shipper';
  name: string;
  color: number;
  /** Ships containers rather than crates. */
  cargo?: 'container';
  /** Crates or containers sent in a day. */
  perDay: number;
  /** A truck's load. */
  capacity: number;
  /** Paid for each crate or container as it goes on board a ship. */
  fee: number;
}

export type Terms = FisheryTerms | HaulierTerms | ShipperTerms;

/** Rough income a shipper brings per day if everything it sends is shipped. */
export function shipperDailyValue(t: ShipperTerms): number {
  return t.perDay * t.fee;
}

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
  /** Hauliers only: when each truck that has left the port is back for more. */
  returns?: number[];
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

const SHIPPERS = [
  'Harbour Mills',
  'Northshore Canning',
  'Valley Timber Co.',
  'Brightwater Brewery',
  'Saltworks Ltd',
  'Copperhill Works',
];

const CONTAINER_SHIPPERS = [
  'Ironbridge Manufacturing',
  'Westcliff Textiles',
  'Fenwick Machine Tools',
];

/**
 * Once every name in a list is taken, firms are named after a place and
 * their trade, so offers never dry up in a big port.
 */
const PLACES = [
  'Ashby',
  'Brigg',
  'Carrick',
  'Dunmore',
  'Fenwick',
  'Gorse Bay',
  'Holt',
  'Kestrel',
  'Larchmont',
  'Morwen',
  'Ness Point',
  'Oldhaven',
  'Penrith',
  'Redcliff',
  'Stanmore',
  'Thornby',
  'Wexham',
  'Yarrow',
];
const TRADES = {
  fishery: ['Fishing Co.', 'Trawlers', 'Fisheries', 'Fleet'],
  coaster: ['Shipping', 'Coasters', 'Short Sea Line'],
  feeder: ['Container Line', 'Box Lines', 'Feeder Services'],
  haulier: ['Haulage', 'Freight', 'Transport', 'Logistics'],
  boxHaulier: ['Box Haulage', 'Container Transport'],
  shipper: ['Mills', 'Works', 'Exports'],
  boxShipper: ['Manufacturing', 'Export Co.'],
};

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
  fleet: 2,
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

/** How much bigger container ships get with the containers a port has handled. */
export function feederGrowth(containersHandled: number): number {
  return 1 + Math.min(B.FEEDER_GROWTH_MAX - 1, containersHandled / B.FEEDER_GROWTH_CONTAINERS);
}

/**
 * A new offer. `containersHandled` is the port's record with containers:
 * the lines offer bigger and bigger loads as it grows.
 */
export function makeOffer(
  rng: Rng,
  id: number,
  tick: number,
  kind: Terms['kind'],
  takenNames: Set<string>,
  tier = 0,
  containersHandled = 0,
): Offer | null {
  const roll = rng.next();
  if (kind === 'shipper') return makeShipper(rng, id, tick, takenNames, tier, roll);
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
  let names = pool.filter((n) => !takenNames.has(n));
  if (names.length === 0) {
    const trade =
      TRADES[
        feeder
          ? 'feeder'
          : coaster
            ? 'coaster'
            : boxTrucks
              ? 'boxHaulier'
              : kind === 'fishery'
                ? 'fishery'
                : 'haulier'
      ];
    names = PLACES.flatMap((p) => trade.map((t) => `${p} ${t}`)).filter((n) => !takenNames.has(n));
  }
  if (names.length === 0) return null;
  const name = rng.pick(names);
  const expires = tick + Math.round(rng.range(4, 8) * 600);

  if (feeder) {
    // Feeders bring few, valuable containers and need a harbour crane. The
    // more containers the port has handled, the bigger the loads on offer.
    const grow = feederGrowth(containersHandled);
    const cratesMin = Math.min(B.FEEDER_MAX_LOAD - 4, Math.round(rng.int(12, 16) * grow));
    const terms: FisheryTerms = {
      kind: 'fishery',
      vessel: 'feeder',
      name,
      color: rng.int(0, 3),
      boatEvery: Math.round(rng.range(1.2, 2.2) * 20) / 20,
      cratesMin,
      cratesMax: Math.min(B.FEEDER_MAX_LOAD, cratesMin + Math.round(rng.int(2, 6) * grow)),
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

/**
 * A shipper's offer: crates for the coasters from the Coastal Wharf on,
 * containers for the feeders from the Container Port on. Null before then,
 * or when every name is taken.
 */
function makeShipper(
  rng: Rng,
  id: number,
  tick: number,
  takenNames: Set<string>,
  tier: number,
  roll: number,
): Offer | null {
  if (tier < 1) return null;
  const boxes = tier >= 2 && roll < 0.4;
  let names = (boxes ? CONTAINER_SHIPPERS : SHIPPERS).filter((n) => !takenNames.has(n));
  if (names.length === 0) {
    const trade = TRADES[boxes ? 'boxShipper' : 'shipper'];
    names = PLACES.flatMap((p) => trade.map((t) => `${p} ${t}`)).filter((n) => !takenNames.has(n));
  }
  if (names.length === 0) return null;
  const name = rng.pick(names);
  const expires = tick + Math.round(rng.range(4, 8) * 600);
  const terms: ShipperTerms = boxes
    ? {
        kind: 'shipper',
        name,
        color: rng.int(0, 4),
        cargo: 'container',
        perDay: rng.int(4, 9),
        capacity: rng.int(1, B.CONTAINER_TRUCK_CAPACITY),
        fee: rng.int(90, 140),
      }
    : {
        kind: 'shipper',
        name,
        color: rng.int(0, 4),
        perDay: rng.int(8, 16),
        capacity: B.TRUCK_CAPACITY,
        fee: rng.int(14, 24),
      };
  const signingFee = Math.round((shipperDailyValue(terms) * 1.5) / 50) * 50;
  return { id, terms, signingFee, expires };
}
