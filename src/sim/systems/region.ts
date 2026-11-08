// The region as the port serves it: the containers moved for each place
// along the line, counted towards its next step, and what that step brings.

import type { World } from '../world';
import { countFor, nextStep, placeLabel, type Place } from '../region';
import { message, tip } from './output';
import { railOffers } from './economy';

/** The region's place by id. */
export function placeById(w: World, id: number | undefined): Place | undefined {
  return id === undefined ? undefined : w.region.places.find((p) => p.id === id);
}

/**
 * Containers the port moved for a place: taken inland by its trains, or
 * brought by them and put on board ships. Towards its next step; taking
 * one, it says so and offers what it opens.
 */
export function served(w: World, id: number | undefined, what: 'inland' | 'out', n: number): void {
  const p = placeById(w, id);
  if (!p || n <= 0) return;
  const step = countFor(p, what, n);
  if (!step) return;
  const next = nextStep(p);
  message(
    w,
    `${p.name} opens its ${step.name.toLowerCase()}: ${step.opens.toLowerCase()}. It may grow to ${step.cap.toLocaleString('en-US')} people.${next ? ` Next it wants ${next.aim.toLowerCase()}.` : ''}`,
    'good',
  );
  tip(w, 'region');
  // Another city's trains, if this step opened them.
  railOffers(w);
}

/** A place in words: "Ashford (city)". */
export function placeName(p: Place): string {
  return p.kind === 'city' ? p.name : `${p.name} ${placeLabel(p.kind).toLowerCase()}`;
}
