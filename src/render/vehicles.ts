import { Group, type Object3D } from 'three';
import { Rng } from '../sim/rng';
import { BOX_LENGTH } from './assets';
import { C } from './palette';
import { box, cyl } from './parts';

// Procedural trucks. Each is built from its id, in its haulier's colours:
// small rigid flatbeds for crates, articulated rigs for the big loads, and
// tractors with skeletal trailers for containers. Faces +X, wheels on y=0.

export interface Vehicle {
  root: Group;
  /** Cargo slots, shown one per unit of load. */
  slots: Object3D[];
  /** Articulated trucks: the trailer, with the slots on it. */
  trailer?: Trailer;
}

/**
 * An articulated truck's trailer: a group of its own, turning about the
 * kingpin at its origin, which sits on the tractor's fifth wheel.
 */
export interface Trailer {
  root: Group;
  /** Where the fifth wheel is along the tractor, from the truck's origin. */
  hitch: number;
  /** From the kingpin back to the middle of the trailer's axles, which it turns about. */
  length: number;
}

const WHITE = 0xf4f4f0;
const GREY = 0x8e959c;
const DARK = 0x2b2f35;
const LAMP = 0xfff2b0;
const TAIL = 0xd6453d;

type Crate = (size: number, x: number, y: number, z: number) => Object3D;
type Box = (seed: number, x: number, y: number, z: number) => Object3D;

/** A pair of wheels on one axle, tyres with a light hub. */
function axle(root: Group, x: number, r: number, track: number, dual = false): void {
  for (const s of [-1, 1]) {
    for (const k of dual ? [0, 1] : [0]) {
      const z = s * (track / 2 - k * 0.045);
      const tyre = cyl(r, 0.045, C.tyre, x, 0, z, 10);
      tyre.rotation.x = Math.PI / 2;
      tyre.position.y = r;
      root.add(tyre);
      if (k === 0) {
        const hub = cyl(r * 0.45, 0.05, GREY, x, 0, z + s * 0.002, 8);
        hub.rotation.x = Math.PI / 2;
        hub.position.y = r;
        root.add(hub);
      }
    }
  }
}

interface CabStyle {
  paint: number;
  trim: number;
  /** Flat-fronted cab over the engine, or a bonnet out in front. */
  over: boolean;
  spoiler: boolean;
  beacon: boolean;
}

/**
 * The cab, its front end at `front`. Returns the x where the cab ends at
 * the back, for the chassis behind it.
 */
function cab(root: Group, front: number, s: CabStyle): number {
  const y = 0.1;
  const w = 0.32;
  let cabFront = front;
  if (!s.over) {
    // Bonnet, grille and bumper ahead of the cab.
    root.add(box(0.16, 0.12, w * 0.86, s.paint, front - 0.08, y, 0));
    root.add(box(0.012, 0.08, w * 0.6, DARK, front + 0.001, y + 0.02, 0));
    cabFront = front - 0.16;
  } else {
    root.add(box(0.012, 0.07, w * 0.7, DARK, front + 0.001, y + 0.015, 0));
  }
  const len = 0.2;
  const h = s.over ? 0.27 : 0.22;
  root.add(box(len, h, w, s.paint, cabFront - len / 2, y, 0));
  // Windscreen, side windows and a stripe in the trim colour.
  root.add(box(0.012, h * 0.36, w * 0.86, C.window, cabFront + 0.001, y + h * 0.5, 0));
  for (const z of [-1, 1]) {
    root.add(
      box(
        len * 0.45,
        h * 0.3,
        0.012,
        C.window,
        cabFront - len * 0.3,
        y + h * 0.52,
        z * (w / 2 + 0.001),
      ),
    );
    root.add(box(len, 0.03, 0.014, s.trim, cabFront - len / 2, y + h * 0.22, z * (w / 2 + 0.001)));
  }
  // Bumper and lamps.
  root.add(box(0.03, 0.04, w + 0.02, DARK, front, y - 0.02, 0));
  for (const z of [-1, 1])
    root.add(box(0.01, 0.025, 0.05, LAMP, front + 0.016, y + 0.02, z * 0.11));
  if (s.spoiler) root.add(box(len * 0.7, 0.07, w * 0.9, s.trim, cabFront - len * 0.55, y + h, 0));
  if (s.beacon) root.add(box(0.03, 0.025, 0.06, 0xf5a623, cabFront - len * 0.4, y + h, 0));
  // Exhaust stack behind the cab.
  root.add(cyl(0.012, h + 0.06, GREY, cabFront - len - 0.01, y, w / 2 - 0.02));
  return cabFront - len;
}

function tailLights(root: Group, x: number, y: number): void {
  for (const z of [-1, 1]) root.add(box(0.01, 0.025, 0.05, TAIL, x - 0.006, y, z * 0.12));
}

function style(rng: Rng, company: number): CabStyle {
  const brand = C.trucks[company % C.trucks.length];
  // Some fleets paint the cab, others run white cabs with a company stripe.
  const white = rng.next() < 0.35 && brand !== WHITE;
  return {
    paint: white ? WHITE : brand,
    trim: white ? brand : brand === WHITE ? 0x2f6fd0 : WHITE,
    over: rng.next() < 0.6,
    spoiler: rng.next() < 0.4,
    beacon: rng.next() < 0.25,
  };
}

/** A rigid flatbed with dropsides, for up to six crates. */
function rigid(rng: Rng, company: number, capacity: number, crate: Crate): Vehicle {
  const root = new Group();
  const s = style(rng, company);
  const cols = Math.ceil(capacity / 2);
  const bedLen = cols * 0.19 + 0.04;
  const front = 0.47;
  const back = cab(root, front, s);
  const tail = back - 0.03 - bedLen;
  root.add(box(front - tail, 0.04, 0.22, DARK, (front + tail) / 2, 0.06, 0));
  const bedY = 0.13;
  const sides = rng.pick([GREY, C.wood, s.trim]);
  root.add(box(bedLen, 0.025, 0.34, sides, tail + bedLen / 2, bedY - 0.025, 0));
  for (const z of [-1, 1])
    root.add(box(bedLen, 0.05, 0.015, sides, tail + bedLen / 2, bedY, z * 0.165));
  root.add(box(0.015, 0.05, 0.34, sides, tail, bedY, 0));
  root.add(box(0.015, 0.12, 0.34, sides, back - 0.02, bedY, 0));
  tailLights(root, tail, bedY - 0.02);
  axle(root, front - 0.12, 0.065, 0.3);
  axle(root, tail + 0.12, 0.065, 0.3, true);
  const slots: Object3D[] = [];
  for (let k = 0; k < cols; k++) {
    for (const z of [-0.08, 0.08]) {
      const c = crate(0.16, back - 0.04 - 0.1 - k * 0.19, bedY, z);
      c.visible = false;
      root.add(c);
      slots.push(c);
    }
  }
  return { root, slots: slots.slice(0, capacity) };
}

/**
 * A tractor unit pulling a trailer: a flatbed for crates or a skeletal
 * chassis with twist-locks for containers. The trailer is a group of its
 * own, to swing behind the tractor about the fifth wheel.
 */
function articulated(
  rng: Rng,
  company: number,
  seed: number,
  capacity: number,
  boxes: boolean,
  crate: Crate,
  container: Box,
): Vehicle {
  const root = new Group();
  const s = style(rng, company);
  const trailerLen = boxes
    ? capacity * (BOX_LENGTH + 0.03) + 0.04
    : Math.ceil(capacity / 2) * 0.19 + 0.06;
  // Roughly centred on the middle of the rig.
  const front = 0.27 + trailerLen / 2;
  const back = cab(root, front, s);
  // Tractor chassis with the fifth wheel over the drive axle, far enough
  // behind the cab for the front of the trailer to swing clear of it.
  const hitch = back - 0.14;
  const end = hitch - 0.1;
  root.add(box(front - 0.02 - end, 0.04, 0.22, DARK, (front - 0.02 + end) / 2, 0.06, 0));
  root.add(cyl(0.06, 0.02, DARK, hitch, 0.1, 0, 10));
  axle(root, front - 0.1, 0.065, 0.3);
  axle(root, hitch - 0.01, 0.065, 0.3, true);
  // The trailer, from its kingpin on the fifth wheel: it starts just ahead.
  const trailer = new Group();
  trailer.position.x = hitch;
  root.add(trailer);
  const head = 0.025;
  const tail = head - trailerLen;
  const deckY = 0.15;
  const slots: Object3D[] = [];
  if (boxes) {
    // Skeletal chassis: two rails and cross-members.
    for (const z of [-1, 1])
      trailer.add(box(trailerLen, 0.03, 0.03, DARK, (head + tail) / 2, deckY - 0.03, z * 0.1));
    for (let k = 0; k <= capacity; k++) {
      const x = head - 0.02 - k * (BOX_LENGTH + 0.03);
      trailer.add(box(0.03, 0.02, 0.3, DARK, x, deckY - 0.02, 0));
    }
    for (let k = 0; k < capacity; k++) {
      const x = head - 0.02 - (BOX_LENGTH + 0.03) * (k + 0.5);
      const c = container(seed + k, x, deckY, 0);
      c.visible = false;
      trailer.add(c);
      slots.push(c);
    }
  } else {
    const color = rng.pick([GREY, C.wood, s.paint]);
    trailer.add(box(trailerLen, 0.03, 0.34, color, (head + tail) / 2, deckY - 0.03, 0));
    for (const z of [-1, 1]) {
      trailer.add(box(trailerLen, 0.05, 0.015, color, (head + tail) / 2, deckY, z * 0.165));
      // Stakes along the sides.
      for (let x = tail + 0.06; x < head - 0.04; x += 0.19)
        trailer.add(box(0.015, 0.1, 0.015, DARK, x, deckY, z * 0.165));
    }
    trailer.add(box(0.015, 0.14, 0.34, color, head - 0.01, deckY, 0));
    const cols = Math.ceil(capacity / 2);
    for (let k = 0; k < cols; k++) {
      for (const z of [-0.08, 0.08]) {
        const c = crate(0.16, head - 0.13 - k * 0.19, deckY, z);
        c.visible = false;
        trailer.add(c);
        slots.push(c);
      }
    }
  }
  // Landing legs at the front of the trailer, two or three axles at the back.
  for (const z of [-1, 1])
    trailer.add(box(0.02, deckY - 0.03, 0.02, GREY, head - 0.16, 0, z * 0.12));
  const axles = capacity >= 2 || !boxes ? [tail + 0.1, tail + 0.24] : [tail + 0.1];
  if (trailerLen > 1.1) axles.push(tail + 0.38);
  for (const x of axles) axle(trailer, x, 0.065, 0.3, true);
  tailLights(trailer, tail, deckY - 0.04);
  const length = -axles.reduce((n, x) => n + x, 0) / axles.length;
  return { root, slots: slots.slice(0, capacity), trailer: { root: trailer, hitch, length } };
}

/** A haulier's truck, in company colours, unique to its id. */
export function truckModel(
  seed: number,
  company: number,
  capacity: number,
  boxes: boolean,
  crate: Crate,
  container: Box,
): Vehicle {
  const rng = new Rng(seed * 48271 + 101);
  if (boxes || capacity > 6) {
    return articulated(rng, company, seed, capacity, boxes, crate, container);
  }
  return rigid(rng, company, capacity, crate);
}
