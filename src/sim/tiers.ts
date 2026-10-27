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
    unlocks: ['Wooden jetties', 'Truck bays', 'Break huts', 'Fishery contracts'],
  },
  {
    name: 'Coastal Wharf',
    blurb: 'Concrete quays reach deep water, machines move cargo faster and coasters call.',
    cost: 4000,
    crates: 300,
    contracts: 2,
    unlocks: [
      'Concrete quay, up to 8 m deep',
      'Forklifts (4 crates a trip) and forklift depots',
      'Jib cranes',
      'Shipping lines with coasters',
    ],
  },
  {
    name: 'Container Port',
    blurb: 'Containers, reach stackers, mobile harbour cranes and feeder ships.',
    cost: 25000,
    crates: 3000,
    contracts: 5,
    unlocks: ['Containers', 'Reach stackers', 'Mobile harbour cranes', 'Feeder ships'],
    comingSoon: true,
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
};

export const MACHINE_TIER: Record<MachineKind, number> = {
  forklift: 1,
};
