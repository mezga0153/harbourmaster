import { Group, type Object3D } from 'three';
import { Rng } from '../sim/rng';
import { BOX_LENGTH } from './assets';
import { C } from './palette';
import type { Model } from './model';
import { CRATE } from './models';
import { LIGHT, pool } from './lights';
import { box, cyl } from './parts';

// Procedural trucks. Each is built from its id, in its haulier's colours:
// small rigid flatbeds for crates, articulated rigs for the big loads, and
// tractors with skeletal trailers for containers. Faces +X, wheels on y=0.

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
  /**
   * A second trailer coupled behind this one: its `hitch` is measured from
   * this trailer's kingpin, along it, and its root is a child of this one's.
   */
  next?: Trailer;
}

const WHITE = 0xf4f4f0;
const GREY = 0x8e959c;
const DARK = 0x2b2f35;
const LAMP = 0xfff2b0;
const TAIL = LIGHT.tail;

type Crate = (size: number, x: number, y: number, z: number) => Object3D;
type Box = (seed: number, x: number, y: number, z: number) => Object3D;

/**
 * The cabs and bodies a truck may have, one of each picked by its id unless
 * asked for (the dev lab). The cab: flat-fronted over the engine (`cabover`,
 * a `sleeper` with a high roof, a low `city` cab with a deep windscreen) or
 * with a bonnet (`bonnet`, a chromed `longnose`). The body, by kind of truck.
 */
export const TRUCK_LOOKS = {
  cab: ['cabover', 'sleeper', 'city', 'bonnet', 'longnose'],
  rigid: ['dropside', 'stake', 'curtain', 'crane'],
  flatbed: ['stake', 'curtain', 'lowside'],
  container: ['skeletal', 'guarded'],
  pickup: ['plain', 'rack', 'workhorse'],
} as const;

/** What to build a truck as, rather than what its id picks. */
export interface TruckLook {
  cab?: string;
  body?: string;
}

/** The id's pick from `from`, or the one asked for; the id's is taken either way. */
function lookOf<T extends string>(rng: Rng, from: readonly T[], asked?: string): T {
  const picked = rng.pick(from);
  return from.includes(asked as T) ? (asked as T) : picked;
}

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
  kind: (typeof TRUCK_LOOKS.cab)[number];
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
  const long = s.kind === 'longnose';
  if (!s.over) {
    // Bonnet, grille and bumper ahead of the cab; a long nose's taller,
    // with a chrome grille.
    root.add(box(0.16, long ? 0.15 : 0.12, w * 0.86, s.paint, front - 0.08, y, 0));
    if (long) root.add(box(0.012, 0.13, w * 0.5, 0xc9ced3, front + 0.001, y + 0.01, 0));
    else root.add(box(0.012, 0.08, w * 0.6, DARK, front + 0.001, y + 0.02, 0));
    cabFront = front - 0.16;
  } else {
    root.add(box(0.012, 0.07, w * 0.7, DARK, front + 0.001, y + 0.015, 0));
  }
  const len = 0.2;
  const city = s.kind === 'city';
  const h = city ? 0.23 : s.over ? 0.27 : long ? 0.24 : 0.22;
  root.add(box(len, h, w, s.paint, cabFront - len / 2, y, 0));
  // Windscreen, side windows and a stripe in the trim colour; a city cab's
  // windscreen comes down low for seeing what is round it.
  const glass = city ? [0.25, 0.6] : [0.5, 0.36];
  root.add(box(0.012, h * glass[1], w * 0.86, C.window, cabFront + 0.001, y + h * glass[0], 0));
  if (s.kind === 'sleeper') {
    // A high roof over the bunk, with marker lamps along its front.
    root.add(box(len, 0.1, w, s.paint, cabFront - len / 2, y + h, 0));
    for (const z of [-0.09, 0, 0.09])
      root.add(box(0.01, 0.015, 0.03, 0xf5a623, cabFront + 0.004, y + h + 0.075, z));
  }
  if (long) {
    // A sun visor over the windscreen, chrome stacks either side and air horns.
    root.add(box(0.04, 0.012, w * 0.9, s.trim, cabFront + 0.015, y + h * 0.9, 0));
    root.add(box(0.06, 0.02, 0.03, 0xc9ced3, cabFront - len * 0.4, y + h, 0.06));
  }
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
  // The road ahead lit by its headlamps, at night.
  root.add(pool(0.32, 0.2, front + 0.34, 0.006, 0));
  const roof = y + h + (s.kind === 'sleeper' ? 0.1 : 0);
  if (s.spoiler && s.kind !== 'sleeper' && !city)
    root.add(box(len * 0.7, 0.07, w * 0.9, s.trim, cabFront - len * 0.55, roof, 0));
  if (s.beacon) root.add(box(0.03, 0.025, 0.06, 0xf5a623, cabFront - len * 0.4, roof, 0));
  // Exhaust stack behind the cab, a long nose's either side in chrome.
  if (long)
    for (const z of [-1, 1])
      root.add(cyl(0.014, h + 0.12, 0xc9ced3, cabFront - len - 0.01, y, z * (w / 2 - 0.02)));
  else if (!city) root.add(cyl(0.012, h + 0.06, GREY, cabFront - len - 0.01, y, w / 2 - 0.02));
  return cabFront - len;
}

function tailLights(root: Group, x: number, y: number): void {
  for (const z of [-1, 1]) root.add(box(0.01, 0.025, 0.05, TAIL, x - 0.006, y, z * 0.12));
}

function style(rng: Rng, company: number, asked?: string): CabStyle {
  const brand = C.trucks[company % C.trucks.length];
  // Some fleets paint the cab, others run white cabs with a company stripe.
  const white = rng.next() < 0.35 && brand !== WHITE;
  const kind = lookOf(rng, TRUCK_LOOKS.cab, asked);
  return {
    paint: white ? WHITE : brand,
    trim: white ? brand : brand === WHITE ? 0x2f6fd0 : WHITE,
    over: kind === 'cabover' || kind === 'sleeper' || kind === 'city',
    kind,
    spoiler: rng.next() < 0.4,
    beacon: rng.next() < 0.25,
  };
}

/**
 * A flatbed's sides when it is no plain dropside: tall stakes with rails
 * along them, or a curtainsider's frame, its curtains drawn back to the
 * ends to load, on `g` along a bed from `tail` to `head` at `y`.
 */
function sideFrame(
  g: Group,
  kind: string,
  tail: number,
  head: number,
  y: number,
  frame: number,
  curtain: number,
): void {
  const len = head - tail;
  const mid = (head + tail) / 2;
  if (kind === 'stake') {
    for (const z of [-1, 1]) {
      for (let x = tail + 0.05; x < head - 0.02; x += 0.19)
        g.add(box(0.015, 0.2, 0.015, frame, x, y, z * 0.165));
      g.add(box(len, 0.015, 0.015, frame, mid, y + 0.1, z * 0.165));
      g.add(box(len, 0.015, 0.015, frame, mid, y + 0.19, z * 0.165));
    }
  } else if (kind === 'curtain') {
    const top = 0.36;
    for (const z of [-1, 1]) {
      for (const x of [tail + 0.01, head - 0.01])
        g.add(box(0.02, top, 0.02, frame, x, y, z * 0.16));
      g.add(box(len, 0.025, 0.02, frame, mid, y + top - 0.025, z * 0.16));
      // The curtains bunched at either end.
      for (const x of [tail + 0.04, head - 0.04])
        g.add(box(0.05, top - 0.04, 0.018, curtain, x, y, z * 0.162));
    }
    for (const x of [tail + 0.01, head - 0.01])
      g.add(box(0.02, 0.02, 0.34, frame, x, y + top - 0.02, 0));
  }
}

/** A rigid flatbed with dropsides, for up to six crates. */
function rigid(rng: Rng, company: number, capacity: number, crate: Crate, look: TruckLook): Model {
  const root = new Group();
  const s = style(rng, company, look.cab);
  const body = lookOf(rng, TRUCK_LOOKS.rigid, look.body);
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
  root.add(box(0.015, body === 'curtain' ? 0.36 : 0.12, 0.34, sides, back - 0.02, bedY, 0));
  if (body === 'stake' || body === 'curtain')
    sideFrame(root, body, tail, back - 0.03, bedY, body === 'stake' ? DARK : GREY, s.trim);
  if (body === 'crane') {
    // A loader crane folded up behind the bed, on its outriggers.
    const x = tail - 0.06;
    root.add(box(0.12, 0.04, 0.22, DARK, x, 0.06, 0));
    root.add(box(0.03, 0.03, 0.32, DARK, x, 0.07, 0));
    root.add(box(0.07, 0.3, 0.08, s.trim, x, 0.1, -0.05));
    root.add(box(0.05, 0.26, 0.06, s.trim, x - 0.005, 0.12, 0.04));
    root.add(box(0.08, 0.05, 0.18, s.trim, x, 0.4, 0));
    root.add(box(0.006, 0.08, 0.006, DARK, x, 0.32, 0.09));
    tailLights(root, x - 0.06, bedY - 0.02);
  } else tailLights(root, tail, bedY - 0.02);
  axle(root, front - 0.12, 0.065, 0.3);
  axle(root, tail + 0.12, 0.065, 0.3, true);
  // Its bed's places, two layers of them, as beds.ts numbers them.
  const slots: Object3D[] = [];
  for (let layer = 0; layer < 2; layer++) {
    for (let k = 0; k < cols; k++) {
      for (const z of [-0.08, 0.08]) {
        if (k * 2 + (z > 0 ? 1 : 0) >= capacity) continue;
        const c = crate(CRATE, back - 0.04 - 0.1 - k * 0.19, bedY + layer * CRATE, z);
        c.visible = false;
        root.add(c);
        slots.push(c);
      }
    }
  }
  return { root, crates: slots };
}

/**
 * A pickup: a bonneted cab and a low open bed behind it with a tailgate,
 * for one layer of crates, two by two, loaded by hand over its sides.
 */
function pickupTruck(
  rng: Rng,
  company: number,
  capacity: number,
  crate: Crate,
  look: TruckLook,
): Model {
  const root = new Group();
  const s = style(rng, company);
  const kit = lookOf(rng, TRUCK_LOOKS.pickup, look.body);
  const paint = s.paint;
  const cols = Math.ceil(capacity / 2);
  const bedLen = cols * 0.19 + 0.03;
  const front = 0.38;
  const y = 0.08;
  const w = 0.3;
  // Bonnet, grille and bumper.
  root.add(box(0.15, 0.08, w * 0.9, paint, front - 0.075, y, 0));
  root.add(box(0.012, 0.05, w * 0.6, DARK, front + 0.001, y + 0.015, 0));
  root.add(box(0.025, 0.035, w + 0.02, DARK, front, y - 0.015, 0));
  for (const z of [-1, 1]) root.add(box(0.01, 0.02, 0.05, LAMP, front + 0.014, y + 0.03, z * 0.1));
  root.add(pool(0.28, 0.18, front + 0.3, 0.006, 0));
  // The cab, its windscreen raked back over the bonnet.
  const cabFront = front - 0.15;
  const cabLen = 0.17;
  root.add(box(cabLen, 0.17, w, paint, cabFront - cabLen / 2, y, 0));
  root.add(box(0.012, 0.07, w * 0.86, C.window, cabFront + 0.001, y + 0.09, 0));
  for (const z of [-1, 1]) {
    root.add(
      box(
        cabLen * 0.5,
        0.06,
        0.012,
        C.window,
        cabFront - cabLen * 0.4,
        y + 0.095,
        z * (w / 2 + 0.001),
      ),
    );
    root.add(
      box(
        cabLen + 0.15,
        0.02,
        0.014,
        s.trim,
        front - (cabLen + 0.15) / 2,
        y + 0.035,
        z * (w / 2 + 0.001),
      ),
    );
  }
  if (s.beacon) root.add(box(0.03, 0.02, 0.06, 0xf5a623, cabFront - cabLen * 0.5, y + 0.17, 0));
  // The bed, low and open, in the cab's paint, with a tailgate.
  const back = cabFront - cabLen - 0.015;
  const tail = back - bedLen;
  const bedY = 0.1;
  root.add(box(front - tail, 0.03, 0.2, DARK, (front + tail) / 2, 0.05, 0));
  root.add(box(bedLen, 0.02, w, paint, tail + bedLen / 2, bedY - 0.02, 0));
  for (const z of [-1, 1])
    root.add(box(bedLen, 0.045, 0.015, paint, tail + bedLen / 2, bedY, z * (w / 2 - 0.0075)));
  root.add(box(0.015, 0.045, w, paint, tail + 0.0075, bedY, 0));
  root.add(box(0.015, 0.06, w, paint, back - 0.0075, bedY, 0));
  tailLights(root, tail, bedY - 0.01);
  if (kit === 'rack') {
    // A ladder rack high over the bed, clear of the crates.
    const top = bedY + 0.3;
    for (const x of [back - 0.01, tail + 0.02])
      for (const z of [-1, 1])
        root.add(box(0.015, top - bedY, 0.015, DARK, x, bedY, z * (w / 2 - 0.01)));
    for (const x of [back - 0.01, tail + 0.02]) root.add(box(0.02, 0.02, w, DARK, x, top, 0));
    for (const z of [-1, 1])
      root.add(box(back - tail, 0.015, 0.015, DARK, (back + tail) / 2, top, z * (w / 2 - 0.01)));
  } else if (kit === 'workhorse') {
    // A bull bar, a light bar on the roof and a snorkel up the side.
    root.add(box(0.02, 0.09, w * 0.8, DARK, front + 0.03, y - 0.01, 0));
    for (const z of [-1, 1])
      root.add(box(0.03, 0.012, 0.012, DARK, front + 0.015, y + 0.07, z * 0.11));
    root.add(box(0.03, 0.025, w * 0.8, DARK, cabFront - 0.03, y + 0.17, 0));
    for (const z of [-0.08, 0, 0.08])
      root.add(box(0.008, 0.015, 0.04, LAMP, cabFront - 0.013, y + 0.175, z));
    root.add(box(0.025, 0.2, 0.025, DARK, cabFront + 0.02, y + 0.02, w / 2 - 0.005));
  }
  axle(root, front - 0.1, 0.055, 0.28);
  axle(root, tail + 0.1, 0.055, 0.28);
  const slots: Object3D[] = [];
  for (let k = 0; k < cols; k++) {
    for (const z of [-0.075, 0.075]) {
      const c = crate(CRATE, back - 0.02 - 0.09 - k * 0.19, bedY, z);
      c.visible = false;
      root.add(c);
      slots.push(c);
    }
  }
  return { root, crates: slots.slice(0, capacity) };
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
  look: TruckLook,
): Model {
  const root = new Group();
  const s = style(rng, company, look.cab);
  const body = boxes
    ? lookOf(rng, TRUCK_LOOKS.container, look.body)
    : lookOf(rng, TRUCK_LOOKS.flatbed, look.body);
  // Containers go one to a trailer, the second on a trailer of its own
  // coupled behind the first: the rig bends at each.
  if (boxes && capacity > 1) return roadTrain(root, s, seed, capacity, container, body);
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
    if (body === 'guarded') guards(trailer, tail, head, deckY, s.paint);
  } else {
    const color = rng.pick([GREY, C.wood, s.paint]);
    trailer.add(box(trailerLen, 0.03, 0.34, color, (head + tail) / 2, deckY - 0.03, 0));
    for (const z of [-1, 1]) {
      trailer.add(box(trailerLen, 0.05, 0.015, color, (head + tail) / 2, deckY, z * 0.165));
      // Stakes along the sides.
      if (body === 'stake')
        for (let x = tail + 0.06; x < head - 0.04; x += 0.19)
          trailer.add(box(0.015, 0.1, 0.015, DARK, x, deckY, z * 0.165));
    }
    const curtain = body === 'curtain';
    trailer.add(box(0.015, curtain ? 0.36 : 0.14, 0.34, color, head - 0.01, deckY, 0));
    if (curtain)
      sideFrame(
        trailer,
        body,
        tail,
        head - 0.02,
        deckY,
        GREY,
        s.paint === WHITE ? s.trim : s.paint,
      );
    if (body === 'lowside') {
      // A toolbox and the spare wheel slung under the deck.
      trailer.add(box(0.14, 0.06, 0.06, DARK, head - 0.32, deckY - 0.1, 0.12));
      const spare = cyl(0.055, 0.04, C.tyre, tail + 0.42, 0, 0, 10);
      spare.position.y = deckY - 0.08;
      trailer.add(spare);
    }
    const cols = Math.ceil(capacity / 2);
    for (let layer = 0; layer < 2; layer++) {
      for (let k = 0; k < cols; k++) {
        for (const z of [-0.08, 0.08]) {
          if (k * 2 + (z > 0 ? 1 : 0) >= capacity) continue;
          const c = crate(CRATE, head - 0.13 - k * 0.19, deckY + layer * CRATE, z);
          c.visible = false;
          trailer.add(c);
          slots.push(c);
        }
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
  return {
    root,
    crates: boxes ? slots.slice(0, capacity) : slots,
    trailer: { root: trailer, hitch, length },
  };
}

/**
 * Side guards along a container trailer from `tail` to `head`, between its
 * axles and its front, in the fleet's paint, and mudflaps behind the wheels.
 */
function guards(g: Group, tail: number, head: number, deckY: number, paint: number): void {
  const [from, to] = [tail + 0.3, head - 0.2];
  for (const z of [-1, 1]) {
    if (to > from)
      for (const y of [deckY - 0.1, deckY - 0.06])
        g.add(box(to - from, 0.02, 0.01, paint, (from + to) / 2, y, z * 0.15));
    g.add(box(0.01, 0.08, 0.06, DARK, tail + 0.02, 0.02, z * 0.13));
  }
}

/** Gap between one container trailer's tail and the next one's front, over the coupling. */
const COUPLING = 0.12;

/**
 * A container tractor pulling a trailer for each container, one behind the
 * other, each on a fifth wheel at the back of the one ahead of it.
 */
function roadTrain(
  root: Group,
  s: CabStyle,
  seed: number,
  capacity: number,
  container: Box,
  body: string,
): Model {
  const one = BOX_LENGTH + 0.07;
  const total = capacity * one + (capacity - 1) * COUPLING;
  const front = 0.27 + total / 2;
  const back = cab(root, front, s);
  const hitch = back - 0.14;
  const end = hitch - 0.1;
  root.add(box(front - 0.02 - end, 0.04, 0.22, DARK, (front - 0.02 + end) / 2, 0.06, 0));
  root.add(cyl(0.06, 0.02, DARK, hitch, 0.1, 0, 10));
  axle(root, front - 0.1, 0.065, 0.3);
  axle(root, hitch - 0.01, 0.065, 0.3, true);
  const deckY = 0.15;
  const slots: Object3D[] = [];
  let parent: Group = root;
  let at = hitch;
  let first: Trailer | undefined;
  let last: Trailer | undefined;
  for (let k = 0; k < capacity; k++) {
    const g = new Group();
    g.position.x = at;
    parent.add(g);
    const head = 0.025;
    const tail = head - one;
    for (const z of [-1, 1]) {
      g.add(box(one, 0.03, 0.03, DARK, (head + tail) / 2, deckY - 0.03, z * 0.1));
    }
    for (const x of [head - 0.02, tail + 0.02])
      g.add(box(0.03, 0.02, 0.3, DARK, x, deckY - 0.02, 0));
    const c = container(seed + k, head - 0.035 - BOX_LENGTH / 2, deckY, 0);
    c.visible = false;
    g.add(c);
    slots.push(c);
    if (body === 'guarded') guards(g, tail, head, deckY, s.paint);
    // The front of the lead trailer stands on landing legs when it is dropped.
    if (k === 0) {
      for (const z of [-1, 1]) g.add(box(0.02, deckY - 0.03, 0.02, GREY, head - 0.16, 0, z * 0.12));
    }
    const axles = [tail + 0.1, tail + 0.22];
    for (const x of axles) axle(g, x, 0.065, 0.3, true);
    const more = k < capacity - 1;
    if (more) {
      // A fifth wheel on a drawbar out behind it, for the next trailer.
      const coupling = tail - COUPLING + 0.025;
      g.add(box(tail - coupling + 0.04, 0.03, 0.05, DARK, (tail + coupling) / 2, deckY - 0.05, 0));
      g.add(cyl(0.05, 0.02, DARK, coupling, deckY - 0.04, 0, 10));
    } else tailLights(g, tail, deckY - 0.04);
    const link: Trailer = { root: g, hitch: at, length: -axles.reduce((n, x) => n + x, 0) / 2 };
    if (last) last.next = link;
    else first = link;
    last = link;
    parent = g;
    at = tail - COUPLING + 0.025;
  }
  return { root, crates: slots, trailer: first };
}

/** A haulier's truck, in company colours, unique to its id. */
export function truckModel(
  seed: number,
  company: number,
  capacity: number,
  boxes: boolean,
  crate: Crate,
  container: Box,
  pickup = false,
  look: TruckLook = {},
): Model {
  const rng = new Rng(seed * 48271 + 101);
  if (pickup && !boxes) return pickupTruck(rng, company, capacity, crate, look);
  if (boxes || capacity > 6) {
    return articulated(rng, company, seed, capacity, boxes, crate, container, look);
  }
  return rigid(rng, company, capacity, crate, look);
}
