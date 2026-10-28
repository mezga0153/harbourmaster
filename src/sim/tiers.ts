import type { BuildKind, MachineKind } from './types';

// Port progression. See plan.md §3.

export interface Tier {
  name: string;
  blurb: string;
  /** Paid to the harbour authority to upgrade. */
  cost: number;
  /** Crates handled since the port opened. */
  crates: number;
  /** Fishery or shipping line contracts active at once. */
  contracts: number;
  unlocks: string[];
  /** Planned but not in the game yet. */
  comingSoon?: boolean;
}

export const TIERS: Tier[] = [
  {
    name: 'Fishing Jetty',
    blurb: 'A wooden pier, a few dockhands and the local fishing boats.',
    cost: 0,
    crates: 0,
    contracts: 0,
    unlocks: ['Wooden jetties', 'Truck bays', 'Break huts', 'Harbour office', 'Fishery contracts'],
  },
  {
    name: 'Coastal Wharf',
    blurb: 'Concrete quays reach deep water, machines move cargo faster and coasters call.',
    cost: 4000,
    crates: 300,
    contracts: 2,
    unlocks: [
      'Concrete quay, up to 8 m deep',
      'Forklifts (4 crates a trip), forklift depots, port roads and forklift lanes',
      'Jib cranes',
      'Shipping lines with coasters (need a 2-wide quay)',
      'Large truck bays for big trucks',
    ],
  },
  {
    name: 'Container Port',
    blurb: 'Feeder ships bring containers: harbour cranes lift them, reach stackers move them.',
    cost: 25000,
    crates: 2000,
    contracts: 4,
    unlocks: [
      'Mobile harbour cranes (on a 2-wide quay)',
      'Reach stackers',
      'Feeder ships with containers (4 m draft)',
      'Container yards and container hauliers',
    ],
  },
  {
    name: 'Bulk Terminal',
    blurb: 'Coal, grain and ore on conveyor belts, silos and trains.',
    cost: 80000,
    crates: 10000,
    contracts: 8,
    unlocks: ['Conveyor belts', 'Grab cranes', 'Silos', 'Rail sidings'],
    comingSoon: true,
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
  containerYard: 2,
  portGate: 1,
  warehouse: 1,
  buoyIn: 1,
  buoyOut: 1,
  office: 0,
  largeBay: 1,
  harbourCrane: 2,
};

export const MACHINE_TIER: Record<MachineKind, number> = {
  forklift: 1,
  stacker: 2,
};
