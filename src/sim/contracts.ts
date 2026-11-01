import * as B from './balance';
import type { Rng } from './rng';
import { TICKS_PER_DAY } from './types';

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
  /** What its boats land: fish unless said otherwise. */
  catch?: 'fish' | 'lobster' | 'timber' | 'goods';
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
  /**
   * Pickups, the Fishing Jetty's hauliers' trucks: an open bed of one
   * layer of crates, loaded by hand from the road beside a truck bay.
   * Without it, small or big trucks.
   */
  pickup?: boolean;
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
  /** What its crates hold: goods unless said otherwise. */
  goods?: 'ice' | 'goods' | 'canned';
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

/** Ice works, selling ice to the fishing boats. */
const ICE_WORKS = [
  'Harbour Ice Works',
  'Polar Ice Co.',
  'Frost & Sons Ice',
  'Glacier Cold Store',
  'Northern Ice House',
];

/** Lobstermen: a few small boats, their pots and creels, and a fine price. */
const LOBSTERMEN = [
  'Redclaw Lobsters',
  'Creel & Pot Co.',
  'Rocky Point Lobstermen',
  'Pinch & Daughters',
  'Harbour Pot Fishers',
  'Old Shell Creels',
];

const SHIPPING_LINES = [
  'Baltic Coasters',
  'North Sea Shipping',
  'Blue Anchor Line',
  'Atlantic Short Sea',
  'Gannet Shipping',
  'Harbour Line',
];

/** The town's cannery, sending its cans out on the coasters. */
const CANNERIES = ['Northshore Cannery', 'Silver Tin Cannery', 'Harbour Pack Co.', 'Fisher & Tinn'];

/** Timber by coaster for the town's builders' yard: Valley Timber Co. first. */
const TIMBER_LINES = ['Valley Timber Co.', 'Pinewood Coasters', 'Northern Sawmills Line'];

/** Coasters of goods for the town's department store. */
const GOODS_LINES = [
  'Merchant Coasters',
  'Harbour Goods Line',
  'Coastal Traders',
  'Bale & Box Shipping',
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
  'Fenwick Pottery',
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
  capacity: B.PICKUP_CAPACITY,
  dailyFee: B.STARTER_HAULIER_FEE,
  pickup: true,
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
  lobsters = true,
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
  const expires = tick + Math.round(rng.range(4, 8) * TICKS_PER_DAY);

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
      // A container pays half as much again as its eight crates of goods
      // would: it takes costly cranes and machines to handle.
      fee: rng.int(180, 255),
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

  // A lobsterman now and then, from the same roll so the offers otherwise
  // come as they did: a small catch at a fine price.
  const lobster = lobsters && kind === 'fishery' && (roll * 7) % 1 < B.LOBSTER_SHARE;
  if (lobster) {
    const free = LOBSTERMEN.filter((n) => !takenNames.has(n));
    const cratesMin = rng.int(3, 5);
    const terms: FisheryTerms = {
      kind,
      vessel: 'smack',
      name: free.length > 0 ? free[Math.floor(((roll * 13) % 1) * free.length)] : name,
      color: rng.int(0, 3),
      boatEvery: Math.round(rng.range(1, 2) * 20) / 20,
      cratesMin,
      cratesMax: cratesMin + rng.int(1, 3),
      fee: rng.int(40, 60),
      catch: 'lobster',
    };
    const signingFee = Math.round((fisheryDailyValue(terms) * 1.5) / 50) * 50;
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
  // Pickups at the Fishing Jetty; small trucks, which forklifts load too,
  // and big ones for large truck bays with the Coastal Wharf.
  const pickup = tier < 1;
  const capacity = pickup
    ? B.PICKUP_CAPACITY
    : rng.next() < 0.4
      ? B.BIG_TRUCK_CAPACITY
      : B.TRUCK_CAPACITY;
  const perTruck = capacity === B.BIG_TRUCK_CAPACITY ? 30 : 20;
  const terms: HaulierTerms = {
    kind,
    name,
    color: rng.int(0, 4),
    fleet,
    capacity,
    dailyFee: fleet * perTruck + rng.int(0, 2) * 5,
    ...(pickup ? { pickup } : {}),
  };
  return { id, terms, signingFee: fleet * 150, expires };
}

/**
 * An ice works' offer: a truck of ice for the fishing boats now and then,
 * at a few dollars a crate as it goes on board. On offer from the start.
 */
export function makeIceOffer(
  rng: Rng,
  id: number,
  tick: number,
  takenNames: Set<string>,
): Offer | null {
  const free = ICE_WORKS.filter((n) => !takenNames.has(n));
  if (free.length === 0) return null;
  const terms: ShipperTerms = {
    kind: 'shipper',
    name: rng.pick(free),
    color: rng.int(0, 4),
    perDay: rng.int(3, 6),
    capacity: B.TRUCK_CAPACITY,
    fee: rng.int(6, 10),
    goods: 'ice',
  };
  const expires = tick + Math.round(rng.range(4, 8) * TICKS_PER_DAY);
  const signingFee = Math.round((shipperDailyValue(terms) * 1.5) / 25) * 25;
  return { id, terms, signingFee, expires };
}

/**
 * A lobsterman's offer, put on the board as the town opens its ice house:
 * a small catch at a fine price, as the lobstermen among the fishery offers.
 */
export function makeLobsterOffer(
  rng: Rng,
  id: number,
  tick: number,
  takenNames: Set<string>,
): Offer | null {
  const free = LOBSTERMEN.filter((n) => !takenNames.has(n));
  if (free.length === 0) return null;
  const cratesMin = rng.int(3, 5);
  const terms: FisheryTerms = {
    kind: 'fishery',
    vessel: 'smack',
    name: rng.pick(free),
    color: rng.int(0, 3),
    boatEvery: Math.round(rng.range(1, 2) * 20) / 20,
    cratesMin,
    cratesMax: cratesMin + rng.int(1, 3),
    fee: rng.int(40, 60),
    catch: 'lobster',
  };
  const expires = tick + Math.round(rng.range(4, 8) * TICKS_PER_DAY);
  const signingFee = Math.round((fisheryDailyValue(terms) * 1.5) / 50) * 50;
  return { id, terms, signingFee, expires };
}

/**
 * The town's cannery's offer, put on the board as it opens: its trucks
 * bring canned fish to the port, to go out on the coasters.
 */
export function makeCannedOffer(
  rng: Rng,
  id: number,
  tick: number,
  takenNames: Set<string>,
  town?: string,
): Offer | null {
  // Named after its town, as long as that is free.
  const free = [...(town ? [`${town} Cannery`] : []), ...CANNERIES].filter(
    (n) => !takenNames.has(n),
  );
  if (free.length === 0) return null;
  const terms: ShipperTerms = {
    kind: 'shipper',
    name: free[0],
    color: rng.int(0, 4),
    perDay: rng.int(8, 12),
    capacity: B.TRUCK_CAPACITY,
    fee: rng.int(14, 20),
    goods: 'canned',
  };
  const expires = tick + Math.round(rng.range(4, 8) * TICKS_PER_DAY);
  const signingFee = Math.round((shipperDailyValue(terms) * 1.5) / 50) * 50;
  return { id, terms, signingFee, expires };
}

/**
 * A shipping line whose coasters bring the town something it wants, put on
 * the board as a landmark opens: timber for the builders' yard, or goods
 * for the department store. Each is the first of its names not taken.
 */
export function makeTownLineOffer(
  rng: Rng,
  id: number,
  tick: number,
  takenNames: Set<string>,
  cargo: 'timber' | 'goods',
): Offer | null {
  const free = (cargo === 'timber' ? TIMBER_LINES : GOODS_LINES).filter((n) => !takenNames.has(n));
  if (free.length === 0) return null;
  const goods = cargo === 'goods';
  const cratesMin = goods ? rng.int(16, 19) : rng.int(14, 18);
  const terms: FisheryTerms = {
    kind: 'fishery',
    vessel: 'coaster',
    name: free[0],
    color: rng.int(0, 3),
    boatEvery: Math.round(rng.range(1, 1.4) * 20) / 20,
    cratesMin,
    cratesMax: Math.min(B.COASTER_MAX_LOAD, cratesMin + rng.int(3, 6)),
    fee: rng.int(22, 30),
    catch: cargo,
  };
  const expires = tick + Math.round(rng.range(4, 8) * TICKS_PER_DAY);
  const signingFee = Math.round((fisheryDailyValue(terms) * 2) / 50) * 50;
  return { id, terms, signingFee, expires };
}

/** An offer or contract the town's landmarks bring: kept on the board till signed. */
export function townTrade(t: Terms): 'canned' | 'timber' | 'goods' | null {
  if (t.kind === 'shipper' && t.goods === 'canned') return 'canned';
  if (t.kind === 'fishery' && (t.catch === 'timber' || t.catch === 'goods')) return t.catch;
  return null;
}

/**
 * A line whose cargo customs must clear, so it cannot be signed till the
 * port has a customs office: coasters of timber or goods and feeders'
 * containers coming in, and the cannery's canned fish going out on its
 * export papers. Fish, lobster and ice are fresh and go at once, and other
 * shippers do their paperwork outside the port.
 */
export function needsCustomsOffice(t: Terms): boolean {
  // Crates of goods or canned fish going out are inspected in the port.
  if (t.kind === 'shipper') return t.cargo !== 'container' && t.goods !== 'ice';
  if (t.kind === 'fishery')
    return t.vessel === 'feeder' || t.catch === 'timber' || t.catch === 'goods';
  return false;
}

/** An ice works, rather than a shipper of goods. */
export function isIce(t: Terms): boolean {
  return t.kind === 'shipper' && t.goods === 'ice';
}

/** Whether a contract's or offer's fee is per container. */
export function paysPerContainer(t: FisheryTerms | ShipperTerms | { kind: string }): boolean {
  return ('vessel' in t && t.vessel === 'feeder') || ('cargo' in t && t.cargo === 'container');
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
  const expires = tick + Math.round(rng.range(4, 8) * TICKS_PER_DAY);
  const terms: ShipperTerms = boxes
    ? {
        kind: 'shipper',
        name,
        color: rng.int(0, 4),
        cargo: 'container',
        perDay: rng.int(4, 9),
        capacity: rng.int(1, B.CONTAINER_TRUCK_CAPACITY),
        fee: rng.int(135, 210),
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
