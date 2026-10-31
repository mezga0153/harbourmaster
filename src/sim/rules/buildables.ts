// What the player can build: each kind, what it costs, which tier opens it, and which turn.

import * as B from '../balance';
import { Build, type BuildCode, type BuildKind } from '../types';

export interface Buildable {
  code: BuildCode;
  label: string;
  cost: number;
  hint: string;
  /** Placed by dragging a line rather than single clicks. */
  drag: boolean;
}

export const BUILDABLES: Record<BuildKind, Buildable> = {
  road: {
    code: Build.Road,
    label: 'Public road',
    cost: 20,
    hint: 'For the hauliers’ trucks. Port staff never use public roads',
    drag: true,
  },
  footpath: {
    code: Build.Footpath,
    label: 'Port path',
    cost: 5,
    hint: 'For dockhands on foot. Staff never walk on grass or public roads. Forklifts need a port road or quay',
    drag: true,
  },
  portRoad: {
    code: Build.PortRoad,
    label: 'Port road',
    cost: 25,
    hint: 'Paved road for forklifts and dockhands alike. Build over a port path to upgrade it',
    drag: true,
  },
  jetty: {
    code: Build.Jetty,
    label: 'Jetty',
    cost: 100,
    hint: 'Wooden pier. Boats moor alongside',
    drag: true,
  },
  quay: {
    code: Build.Quay,
    label: 'Quay',
    cost: B.QUAY_COST_LAND,
    hint: `Concrete wharf on the shore or in water up to ${B.MAX_QUAY_DEPTH} m. Forklifts can drive on it. Build over a jetty, from its shore end, to upgrade it`,
    drag: true,
  },
  jibCrane: {
    code: Build.JibCrane,
    label: 'Jib crane',
    cost: 2500,
    hint: `Goes on a quay edge. Lifts crates off moored boats, straight into crate storage up to ${B.JIB_REACH} tiles away, or else onto the quay for forklifts and dockhands. Boats would rather berth under one, and wait for one when there are no dockhands. The 3×3 round a crane is for port machines only: no dockhands, no hauliers' trucks. $${B.CRANE_RUNNING_COST}/day to run`,
    drag: false,
  },
  depot: {
    code: Build.Depot,
    label: 'Forklift depot',
    cost: 1200,
    hint: `Houses ${B.DEPOT_SLOTS} machines, a reach stacker taking two places. They refuel, get repaired and park here, and drive in and out by the door: face it onto a port road or quay, or they cannot get out`,
    drag: false,
  },
  office: {
    code: Build.Office,
    label: 'Harbour office',
    cost: 1500,
    hint: `Coordinates berths. Needed for more than ${B.FREE_DOCKS} jetties or any quay; each office handles ${B.DOCKS_PER_OFFICE} docks. Goes on open ground or over a port path or road, its door facing a port path or road`,
    drag: false,
  },
  harbourHut: {
    code: Build.HarbourHut,
    label: "Harbourmaster's hut",
    cost: 400,
    hint: `A shed by the jetties where the harbourmaster keeps an eye on the boats: looks after ${B.JETTIES_PER_HUT} more jetties, but no quays, which need a harbour office. Goes on open ground or over a port path or road, its door facing a port path or road`,
    drag: false,
  },
  harbourCrane: {
    code: Build.HarbourCrane,
    label: 'Harbour crane',
    cost: 9000,
    hint: `Lifts containers off feeder ships. Goes on a quay edge with quay behind it (2 wide). The 3×3 round it is for port machines only. $${B.HARBOUR_CRANE_RUNNING_COST}/day to run`,
    drag: false,
  },
  gantryCrane: {
    code: Build.Gantry,
    label: 'Gantry crane',
    cost: B.GANTRY_COST,
    hint: `Ship-to-shore crane: lifts containers off feeder ships three times as fast as a harbour crane and sets them down along the quay at the shipside, the length of its rails, ${B.GANTRY_STACK} at most, where reach stackers collect them from behind and it lifts them onto terminal tractors under it, never the hauliers' trucks. 2×2 on quay, two tiles along the quay edge facing open water. It runs on rails along the quay to each bay of the ship in turn, so it needs ${B.GANTRY_RAILS} tiles of clear quay edge, the length of a ship, kept for its rails, and the ground a tile round them is for port machines only. Put two side by side along one berth and they share the rails and the ship out between them, working it twice as fast. $${B.GANTRY_RUNNING_COST}/day to run`,
    drag: false,
  },
  tugBerth: {
    code: Build.TugBerth,
    label: 'Tug berth',
    cost: B.TUG_BERTH_COST,
    hint: `A berth in the water beside a jetty or quay, where one harbour tug lies; buy the tug from the Machines tab. Without a tug, coasters and feeders swing round, come alongside and pull out slowly. A tug sails out to meet them and works them in and out`,
    drag: false,
  },
  yardGantry: {
    code: Build.YardGantry,
    label: 'Yard gantry',
    cost: B.YARD_GANTRY_COST,
    hint: `Spans a container yard from a port road or quay tile beside it, and loads and unloads the trucks there itself; they drive in under it. Without one, reach stackers must lift every container on and off the trucks too, one at a time. $${B.YARD_GANTRY_RUNNING_COST}/day to run`,
    drag: false,
  },
  breakHut: {
    code: Build.BreakHut,
    label: 'Break hut',
    cost: 250,
    hint: `Tired dockhands rest here, ${B.HUT_SLOTS} at a time`,
    drag: false,
  },
  parking: {
    code: Build.Parking,
    label: 'Truck parking',
    cost: B.PARKING_COST,
    hint: 'Marked out on a road you have built: drag over a strip of it one or two tiles wide, with road left all along both its long sides. Trucks drive in off one side, park at an angle across the strip, one to each space along it, and drive out the other side: always forwards. Big trucks need two tiles. On public road it is outside the port: shippers\u2019 trucks wait there for their paperwork. On port road it is inside, behind a port gate: trucks queue there for a free loading spot. Unmark it to have the road back',
    drag: true,
  },
  portGate: {
    code: Build.Gate,
    label: 'Port gate',
    cost: 400,
    hint: 'Lets the hauliers’ trucks into the port: they turn in off the public road at the front and drive on port roads to truck bays and container yards inside. Staff never leave through it',
    drag: false,
  },
  buoyIn: {
    code: Build.BuoyIn,
    label: 'Buoy: way in',
    cost: B.BUOY_COST,
    hint: 'Green buoys mark the way into the port. Place them in pairs: boats come in from the sea beyond the outermost pair and cross between each pair in turn, towards the docks, well clear of the buoys. An odd one out they sail close past',
    drag: true,
  },
  buoyOut: {
    code: Build.BuoyOut,
    label: 'Buoy: way out',
    cost: B.BUOY_COST,
    hint: 'Red buoys mark the way out to sea. Place them in pairs: boats leaving cross between each pair in turn, away from the docks, well clear of the buoys, so they keep clear of boats coming in. An odd one out they sail close past',
    drag: true,
  },
  largeBay: {
    code: Build.LargeBay,
    label: 'Large truck bay',
    cost: 900,
    hint: `Holds ${B.LARGE_BAY_CAPACITY} crates, loads trucks quicker than a truck bay and takes the big 8-crate trucks. Two tiles wide; the entrance faces a public road, or a port road behind a port gate`,
    drag: false,
  },
  truckBay: {
    code: Build.TruckBay,
    label: 'Truck bay',
    cost: 300,
    hint: `Holds ${B.BAY_CAPACITY} crates, loaded onto trucks by hand, one truck at a time. The entrance faces a public road, or a port road behind a port gate`,
    drag: false,
  },
};

/** Buildings with a front door, placed facing one of four ways. */
export const ROTATABLE: ReadonlySet<BuildKind> = new Set([
  'truckBay',
  'largeBay',
  'portGate',
  'depot',
  'office',
  'harbourHut',
  'breakHut',
  'gantryCrane',
]);
