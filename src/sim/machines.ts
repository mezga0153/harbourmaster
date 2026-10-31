import * as B from './balance';
import type { MachineKind } from './types';

/** Machines bought at a depot. They refuel, break down and park there. */
export const MACHINES: Record<
  MachineKind,
  {
    label: string;
    price: number;
    wage: number;
    capacity: number;
    /** How many of a depot's DEPOT_SLOTS places it takes. */
    room: number;
    hint: string;
  }
> = {
  forklift: {
    label: 'Forklift',
    price: B.FORKLIFT_PRICE,
    wage: B.FORKLIFT_WAGE,
    capacity: B.FORKLIFT_CAPACITY,
    room: 1,
    hint: `Carries ${B.FORKLIFT_CAPACITY} crates a trip from storage the trucks cannot reach, like that by a jib crane, to a truck bay or storage, and loads crate trucks. Forklifts cannot unload boats: dockhands carry the crates off`,
  },
  stacker: {
    label: 'Reach stacker',
    price: B.STACKER_PRICE,
    wage: B.STACKER_WAGE,
    capacity: 1,
    // Its spreader is too wide for three to stand side by side.
    room: 2,
    hint: 'Carries one container from a harbour or gantry crane to a container yard',
  },
  tractor: {
    label: 'Terminal tractor',
    price: B.TRACTOR_PRICE,
    wage: B.TRACTOR_WAGE,
    capacity: 1,
    room: 1,
    hint: 'Quick and cheap: carries one container at a time between the harbour and gantry cranes and the container yards with a yard gantry, which lifts it off and on. It cannot lift a container itself, so it never works a yard without one, or the trucks',
  },
};

export function isMachineKind(k: string): k is MachineKind {
  return k in MACHINES;
}

/**
 * How far each machine reaches behind and ahead of its middle, and to
 * either side, as drawn (see the models in src/render/models.ts); a
 * forklift is only as wide as its forks (FORK_HALF) further ahead than
 * FORK_NARROW.
 */
export const MACHINE_SIZE: Record<MachineKind, { back: number; front: number; half: number }> = {
  forklift: { back: 0.26, front: 0.42, half: 0.175 },
  stacker: { back: 0.36, front: 0.545, half: 0.288 },
  tractor: { back: 0.47, front: 0.4, half: 0.16 },
};
const FORK_NARROW = 0.185;
const FORK_HALF = 0.11;
/** Where the inside of a depot's back wall is, from the back of the tile. */
export const DEPOT_BACK = 0.035;
/** How far either side of the middle of a depot the inside of its walls is. */
export const DEPOT_HALF = 0.495;

/** Where a machine stands parked in a depot: tile-space position and heading. */
export interface ParkPose {
  x: number;
  y: number;
  dir: number;
}

/**
 * Where the machines of a depot at tile (tx, ty) with its door facing
 * `facing` (0 +x, 1 +y, 2 -x, 3 -y) park, side by side across the garage,
 * each in the order given. They drive in nose first, up to the back wall.
 * A stacker stands at one side, and forklifts next to each other: with
 * two or more, every other one backs in up to the back wall and the ones
 * between drive in nose first further forward, their forks beside the
 * others' bodies, which is how three fit across.
 */
export function parkPoses(
  kinds: readonly MachineKind[],
  tx: number,
  ty: number,
  facing: number,
): ParkPose[] {
  const order = kinds
    .map((kind, k) => ({ kind, k }))
    .sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.k - b.k);
  const forklifts = kinds.filter((k) => k === 'forklift').length;
  // Across the garage (u) and how far in from the back of the tile (v).
  const lanes: { u: number; v: number; out: boolean }[] = [];
  let u = 0;
  let width = 0;
  let fork = 0;
  order.forEach(({ kind }, n) => {
    const s = MACHINE_SIZE[kind];
    const prev = n > 0 ? order[n - 1].kind : null;
    if (prev) {
      u +=
        prev === 'forklift' && kind === 'forklift'
          ? FORK_HALF + s.half + 0.005
          : MACHINE_SIZE[prev].half + s.half;
    }
    const backed = kind === 'forklift' && forklifts > 1 && fork++ % 2 === 0;
    const v = backed
      ? DEPOT_BACK + s.back
      : kind === 'forklift' && forklifts > 1
        ? DEPOT_BACK + s.back + FORK_NARROW * 2
        : DEPOT_BACK + s.front;
    lanes.push({ u, v, out: backed });
    width = u + s.half;
  });
  const first = order.length > 0 ? MACHINE_SIZE[order[0].kind].half : 0;
  const shift = 0.5 - (width + first) / 2 + first;
  const [ox, oy] = [
    Math.round(Math.cos((facing * Math.PI) / 2)),
    Math.round(Math.sin((facing * Math.PI) / 2)),
  ];
  const out: ParkPose[] = [];
  order.forEach(({ k }, n) => {
    const { u: lu, v, out: facesOut } = lanes[n];
    const a = lu + shift - 0.5;
    const d = v - 0.5;
    out[k] = {
      // Across runs (-oy, ox); towards the door (ox, oy).
      x: tx + 0.5 - oy * a + ox * d,
      y: ty + 0.5 + ox * a + oy * d,
      dir: Math.atan2(oy, ox) + (facesOut ? 0 : Math.PI),
    };
  });
  return out;
}

/** Which side of the garage each kind parks on, left to right. */
const RANK: Record<MachineKind, number> = { stacker: 0, forklift: 1, tractor: 2 };
