import { TOWN_STAGES } from './town';
import type { BuildKind, MachineKind } from './types';

// Port progression. See plan.md §3.

export interface Tier {
  name: string;
  blurb: string;
  /** Paid to the harbour authority to upgrade. */
  cost: number;
  /**
   * People living in the town up the coast: the harbour authority lets the
   * port grow as the town it serves does, a step as it becomes a town, a
   * large town and a city (see TOWN_STAGES).
   */
  town: number;
  /**
   * From the Bulk Terminal on, people in the whole region the port serves
   * (the town's and its places', see region.ts), besides the town's own.
   */
  region?: number;
  unlocks: string[];
  /** Planned but not in the game yet. */
  comingSoon?: boolean;
}

export const TIERS: Tier[] = [
  {
    name: 'Fishing Jetty',
    blurb: 'A wooden pier, a few dockhands and the local fishing boats.',
    cost: 0,
    town: 0,
    unlocks: [
      'Wooden jetties',
      "Hauliers with pickups, loaded by hand from the crates heaped at the road's end",
      'Truck bays, once 30 crates have come ashore for the pickups',
      'Break huts',
      "Harbourmaster's huts, each for 3 more jetties",
      'Fishery contracts',
    ],
  },
  {
    name: 'Coastal Wharf',
    blurb: 'Concrete quays reach deep water, machines move cargo faster and coasters call.',
    cost: 4000,
    town: TOWN_STAGES[2].from,
    unlocks: [
      'Concrete quay, up to 8 m deep',
      'The harbour office, for quays and more docks',
      'The customs office, for timber, goods and canned fish',
      'Truck parking, for shippers’ trucks waiting on their paperwork',
      'Forklifts (4 crates a trip), forklift depots, port roads and machines-only areas',
      'Small trucks in place of pickups, backing into truck bays: a layer of crates by hand, two by forklift',
      'Crate storage marked out on port roads and quays',
      'Jib cranes',
      'Shipping lines with coasters (need a 2-wide quay)',
      'Large truck bays for big trucks',
      'Tug berths and harbour tugs, to work coasters and feeders in and out',
      'One-way roads and one-way port gates',
    ],
  },
  {
    name: 'Container Port',
    blurb: 'Feeder ships bring containers: harbour cranes lift them, reach stackers move them.',
    cost: 25000,
    town: TOWN_STAGES[3].from,
    unlocks: [
      'Mobile harbour cranes (on a 2-wide quay)',
      'Ship-to-shore gantry cranes, quick, with a bay between their legs for reach stackers',
      'Reach stackers',
      'Feeder ships with containers (4 m draft)',
      'Container yards marked out on port roads and quays, and container hauliers',
      'Yard gantries, which load the trucks at a container yard where reach stackers otherwise must',
      'Terminal tractors, which shuttle containers between the cranes and yards with a yard gantry',
      'New exits off the highway, traffic lights and roundabouts',
    ],
  },
  {
    name: 'Bulk Terminal',
    blurb: 'Coal, grain and ore on conveyor belts, silos and trains.',
    cost: 80000,
    town: TOWN_STAGES[4].from,
    region: 11000,
    unlocks: [
      'Bulk carriers of coal (5 m draft), landed by the tonne',
      'Grab cranes, lifting it out of the holds into their hoppers',
      'Conveyor belts, carrying it tonne by tonne',
      'Stockpiles, heaping it up',
      'Rail loadouts over a siding, filling the power station’s hopper wagons',
    ],
  },
];

export const BUILD_TIER: Record<BuildKind, number> = {
  road: 0,
  footpath: 0,
  jetty: 0,
  truckBay: 0,
  breakHut: 0,
  quay: 1,
  jibCrane: 1,
  depot: 1,
  portRoad: 1,
  portGate: 1,
  parking: 1,
  buoyIn: 1,
  buoyOut: 1,
  office: 1,
  harbourHut: 0,
  customs: 1,
  largeBay: 1,
  harbourCrane: 2,
  gantryCrane: 2,
  tugBerth: 1,
  yardGantry: 2,
  siding: 2,
  grabCrane: 3,
  belt: 3,
  stockpile: 3,
  loadout: 3,
};

export const MACHINE_TIER: Record<MachineKind, number> = {
  forklift: 1,
  stacker: 2,
  tractor: 2,
};
