import type { CraneFix } from '../protocol';
import type { PictureId } from '../render/guides';
import * as B from '../sim/balance';

// The guides: a few steps, each with a picture of it built up a beat at a
// time (render/guides.ts), shown in Guide.tsx. The Coastal Wharf's comes
// up when the port becomes one; a crane's when its red mark is clicked,
// on the step that puts that trouble right.

export interface GuideStep {
  title: string;
  text: string;
  /** Where the tool is in the build bar. */
  how?: string;
  picture: PictureId;
  /** A crane's troubles this step puts right. */
  fixes?: CraneFix[];
}

export interface Guide {
  kicker: string;
  title: string;
  steps: GuideStep[];
}

const office: GuideStep = {
  title: 'A harbour office',
  how: 'Buildings › Harbour office (O)',
  text: `Boats only use a quay a harbour office looks after: each runs ${B.DOCKS_PER_OFFICE} docks nearby. Put one down near the quay, its door to a port path or road.`,
  picture: 'office',
  fixes: ['office'],
};

const room: GuideStep = {
  title: 'Room alongside',
  how: 'Bulldoze (B)',
  text: 'A ship lies centred on its crane, and needs open water along the quay for its whole hull, either way from the crane. Clear jetties and anything else in the way.',
  picture: 'room',
  fixes: ['room'],
};

const depth: GuideStep = {
  title: 'Deep enough water',
  how: 'Docks › Dredge',
  text: `A feeder draws ${B.FEEDER_DRAFT} m. Dredge the water in front of the crane, along where the ship lies, until it is that deep.`,
  picture: 'depth',
  fixes: ['depth'],
};

export const GUIDES = {
  wharf: {
    kicker: 'Coastal Wharf',
    title: 'Building a wharf',
    steps: [
      {
        title: 'Lay a quay',
        how: 'Docks › Quay (G)',
        text: 'Drag a concrete quay along the shore. It reaches deeper water than a jetty, and coasters, with far more crates than the fishing boats, moor only against one two tiles wide.',
        picture: 'quay',
      },
      office,
      {
        title: 'Crate storage on the quay',
        how: 'Cargo › Crate storage: in',
        text: `Drag storage out on the quay or a port road, right by the berth: dockhands carry each crate only a few steps. Trucks load from the port road or quay beside it (yellow), one at a time for every ${B.STORE_TILES_PER_TRUCK} tiles. Storage is for cargo coming in or going out, never both.`,
        picture: 'storage',
      },
      {
        title: 'A gate and port roads',
        how: 'Roads › Port gate, then Port road',
        text: 'The hauliers come in through a port gate off a public road, and drive on port roads inside it to the storage. Put the gate where the public road meets the port’s own roads.',
        picture: 'gate',
      },
      {
        title: 'A jib crane',
        how: 'Cargo › Jib crane (N)',
        text: 'Put it at the quay’s edge, beside open water. It swings crates straight off the boat into crate storage for cargo coming in right next to it (blue), in the machines-only ground round it (red): mark some out there, or it unloads nothing.',
        picture: 'jib',
      },
      {
        title: 'Forklifts and a depot',
        how: 'Machines › Depot (U), then Forklift (L)',
        text: `A depot keeps forklifts, its door to a port road; buy them there, for $${B.FORKLIFT_PRICE.toLocaleString('en-US')} each. They carry ${B.FORKLIFT_CAPACITY} crates a trip: from storage the trucks cannot reach, like that by a jib crane, on to truck bays and other storage, and onto the trucks.`,
        picture: 'depot',
      },
    ],
  },
  jib: {
    kicker: 'Crane',
    title: 'Getting a jib crane working',
    steps: [
      {
        title: 'At the quay’s edge',
        how: 'Cargo › Jib crane (N)',
        text: 'A jib crane works boats moored beside it, so it stands on the quay’s edge with open water in front.',
        picture: 'jibEdge',
        fixes: ['water'],
      },
      office,
      {
        title: 'Storage in its reach',
        how: 'Cargo › Crate storage: in',
        text: 'It swings crates only into crate storage for cargo coming in right next to it (blue), in the red ground round it: never down at its feet. Mark out a tile or two there.',
        picture: 'jib',
        fixes: ['storage'],
      },
      {
        title: 'Forklifts to empty it',
        how: 'Machines › Depot (U), then Forklift (L)',
        text: 'Trucks cannot get into the machines-only ground by the crane, so forklifts take its crates on to storage or truck bays the trucks can reach.',
        picture: 'depot',
      },
    ],
  },
  harbour: {
    kicker: 'Crane',
    title: 'Getting a harbour crane working',
    steps: [
      {
        title: 'A quay two tiles wide',
        how: 'Docks › Quay (G)',
        text: 'Container ships moor only against a quay two tiles wide. Put the crane at its edge, facing open water, and widen the quay behind it if it is one tile.',
        picture: 'wide',
        fixes: ['water', 'wide'],
      },
      office,
      room,
      depth,
    ],
  },
  gantry: {
    kicker: 'Crane',
    title: 'Getting a gantry crane working',
    steps: [
      {
        title: 'At the quay’s edge',
        how: 'Cargo › Gantry crane',
        text: 'A gantry crane stands on 2×2 of clear quay at the edge, its front two tiles facing open water, on a quay two tiles wide or more. Its rails run along the edge, so keep the quay clear either side.',
        picture: 'gantry',
        fixes: ['water', 'wide'],
      },
      office,
      room,
      depth,
    ],
  },
} satisfies Record<string, Guide>;

export type GuideId = keyof typeof GUIDES;

/** The guide for a crane of this kind. */
export function craneGuide(kind: 'jib' | 'harbour' | 'gantry'): GuideId {
  return kind;
}

/** The step of a guide that puts a crane's trouble right, or its first. */
export function stepFor(id: GuideId, fix: CraneFix | undefined): number {
  const k = (GUIDES[id].steps as GuideStep[]).findIndex((s) => fix && s.fixes?.includes(fix));
  return Math.max(0, k);
}
