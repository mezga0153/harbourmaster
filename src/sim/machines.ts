import * as B from './balance';
import type { MachineKind } from './types';

/** Machines bought at a depot. They refuel, break down and park there. */
export const MACHINES: Record<
  MachineKind,
  { label: string; price: number; wage: number; capacity: number; hint: string }
> = {
  forklift: {
    label: 'Forklift',
    price: B.FORKLIFT_PRICE,
    wage: B.FORKLIFT_WAGE,
    capacity: B.FORKLIFT_CAPACITY,
    hint: `Carries ${B.FORKLIFT_CAPACITY} crates a trip from a crane or the quay to a truck bay or storage. Forklifts cannot unload boats: dockhands and jib cranes land the cargo for them`,
  },
  stacker: {
    label: 'Reach stacker',
    price: B.STACKER_PRICE,
    wage: B.STACKER_WAGE,
    capacity: 1,
    hint: 'Carries one container from a harbour crane to a container yard',
  },
};

export function isMachineKind(k: string): k is MachineKind {
  return k in MACHINES;
}
