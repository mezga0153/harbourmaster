import type { World } from '../../world';

// Ways a ship can find its way off its berth, to try against each other
// (dev server only: Debug overlays > Ship pathing, or the dev lab's
// Scenes tab). The game plays with the classic one; the others change
// what a ship does at a few points where the classic one can leave two
// ships waiting on each other for good (the dev lab's mini scenario "Two
// coasters off a pier's end"). Not saved: a game loads with the classic one.

export interface Pilot {
  name: string;
  note: string;
  /**
   * Running out along the dock and held up, it still eases back onto its
   * line, sideways, out from the ship it is passing.
   */
  drift: boolean;
  /**
   * Easing off the dock with a boat in the way, it waits for that one to
   * move (a while) rather than give up easing out and run out short of
   * its line.
   */
  patient: boolean;
  /**
   * Picks the way to run out along the dock that no other boat lies
   * across, bow first or stern first, before it casts off; and running out
   * stern first, looks out astern for what is in its way.
   */
  lookout: boolean;
}

export const PILOTS = {
  classic: {
    name: 'Classic',
    note: 'As the game plays: bow first along the dock, easing out until anything is in the way.',
    drift: false,
    patient: false,
    lookout: false,
  },
  drift: {
    name: 'Drift back',
    note: 'Classic, but a ship held up running out still eases sideways back onto its line.',
    drift: true,
    patient: false,
    lookout: false,
  },
  patient: {
    name: 'Patient',
    note: 'Drift back, and easing off the dock it waits out a boat in the way rather than giving up.',
    drift: true,
    patient: true,
    lookout: false,
  },
  lookout: {
    name: 'Lookout',
    note: 'Patient, and it runs out whichever way along the dock no other boat lies across.',
    drift: true,
    patient: true,
    lookout: true,
  },
} satisfies Record<string, Pilot>;

export type PilotId = keyof typeof PILOTS;

export function isPilot(id: unknown): id is PilotId {
  return typeof id === 'string' && id in PILOTS;
}

/** The ship pathing the world plays with. */
export function pilot(w: World): Pilot {
  return PILOTS[w.pilot];
}
