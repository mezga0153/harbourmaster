import { BufferGeometry, Float32BufferAttribute, Group, Mesh, Vector3, type Object3D } from 'three';
import { Rng } from '../sim/rng';
import { BOX_WIDTH } from './assets';
import { C } from './palette';
import { box, cyl, mat } from './parts';

// Procedural boats and ships. Every one is built from a seed, so each boat
// that sails in looks a little different: hull shape, paint, wheelhouse,
// masts and gear. All face +X with the waterline at y=0.

export interface Craft {
  root: Group;
  /** Cargo slots, shown one per unit of load. */
  slots: Object3D[];
}

type Ring = [number, number][];

/** Hull paints, chosen per boat. */
const HULLS = [
  0x24324a, 0xb33a32, 0x2f6fd0, 0x2e7d4f, 0x1f6f78, 0xe3e1d8, 0x3a3f47, 0xd9822b, 0x6b3a7a,
];
/** Company colours for funnels, stripes and wheelhouse roofs, by contract colour. */
const COMPANY = [0xd6453d, 0xf2c230, 0x2f6fd0, 0x3fa34d, 0xf4f4f0];
const ANTIFOUL = [0xa8322b, 0x2d2f33, 0x7a2a2a];
const SUPERSTRUCTURE = [0xf4f4f0, 0xeae3cf, 0xdfe6ea];
const DECK = [0xb9a27a, 0xc9ced3, 0x9a8a6e, 0x8e959c];

/**
 * Deck-level outline of a hull, as seen from above: a square transom at
 * the stern, straight sides and a pointed bow. `bow` is the share of the
 * length that tapers, `stern` the transom width as a share of the beam.
 */
function outline(length: number, beam: number, bow: number, stern: number): Ring {
  const half: Ring = [];
  const back = -length / 2;
  const shoulder = length / 2 - bow * length;
  half.push([back, (stern * beam) / 2]);
  half.push([back + Math.min(0.2, length * 0.08), beam / 2]);
  half.push([shoulder, beam / 2]);
  for (let k = 1; k <= 4; k++) {
    const t = k / 5;
    half.push([shoulder + (length / 2 - shoulder) * t, (beam / 2) * (1 - t ** 1.7)]);
  }
  const tip: [number, number] = [length / 2, 0];
  const other = half.map(([x, z]) => [x, -z] as [number, number]).reverse();
  return [...half, tip, ...other];
}

function scaleRing(ring: Ring, sx: number, sz: number, dx = 0): Ring {
  return ring.map(([x, z]) => [x * sx + dx, z * sz]);
}

function lerpRing(a: Ring, b: Ring, t: number): Ring {
  return a.map(([x, z], k) => [x + (b[k][0] - x) * t, z + (b[k][1] - z) * t]);
}

/**
 * Side walls between two outlines of the same length, plus optional caps.
 * Faces are wound outward from the hull's centre line, so it reads as a
 * solid from any side.
 */
function loft(lower: Ring, y0: number, upper: Ring, y1: number, capTop = false): BufferGeometry {
  const pos: number[] = [];
  const centre = new Vector3(0, (y0 + y1) / 2, 0);
  const tri = (a: Vector3, b: Vector3, c: Vector3, out: Vector3) => {
    const n = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a));
    if (n.dot(out) < 0) [b, c] = [c, b];
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };
  const n = lower.length;
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n;
    const a = new Vector3(lower[k][0], y0, lower[k][1]);
    const b = new Vector3(lower[k2][0], y0, lower[k2][1]);
    const c = new Vector3(upper[k2][0], y1, upper[k2][1]);
    const d = new Vector3(upper[k][0], y1, upper[k][1]);
    const out = new Vector3().addVectors(a, c).multiplyScalar(0.5).sub(centre);
    out.y = 0;
    tri(a, b, c, out);
    tri(a, c, d, out);
  }
  const cap = (ring: Ring, y: number, up: number) => {
    const mid = new Vector3(
      ring.reduce((s, p) => s + p[0], 0) / ring.length,
      y,
      ring.reduce((s, p) => s + p[1], 0) / ring.length,
    );
    for (let k = 0; k < ring.length; k++) {
      const k2 = (k + 1) % ring.length;
      tri(
        mid,
        new Vector3(ring[k][0], y, ring[k][1]),
        new Vector3(ring[k2][0], y, ring[k2][1]),
        new Vector3(0, up, 0),
      );
    }
  };
  cap(lower, y0, -1);
  if (capTop) cap(upper, y1, 1);
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

function mesh(geo: BufferGeometry, color: number): Mesh {
  const m = new Mesh(geo, mat(color));
  m.castShadow = m.receiveShadow = true;
  return m;
}

interface HullSpec {
  length: number;
  beam: number;
  /** Keel to deck. */
  height: number;
  /** Below the waterline. */
  draft: number;
  bow: number;
  stern: number;
  paint: number;
  bottom: number;
  stripe: number;
  deck: number;
}

/**
 * A hull in three bands, keel to deck: antifouling below the waterline, the
 * paint above it, and a stripe of company colour under the rail. The deck
 * sits on top. Returns the deck height.
 */
function hull(root: Group, h: HullSpec): number {
  const top = outline(h.length, h.beam, h.bow, h.stern);
  // The keel is narrower and shorter: a raked bow and a tucked-in stern.
  const keel = scaleRing(top, 0.88, 0.45, -h.length * 0.03);
  const deckY = h.height - h.draft;
  const water = lerpRing(keel, top, h.draft / h.height + 0.04);
  const rail = lerpRing(keel, top, 0.86);
  const y0 = -h.draft;
  const yw = 0.04 * h.height;
  const yr = y0 + h.height * 0.86;
  root.add(mesh(loft(keel, y0, water, yw), h.bottom));
  root.add(mesh(loft(water, yw, rail, yr), h.paint));
  root.add(mesh(loft(rail, yr, top, deckY, true), h.stripe));
  const deck = mesh(
    loft(scaleRing(top, 0.97, 0.9), deckY, scaleRing(top, 0.97, 0.9), deckY + 0.012, true),
    h.deck,
  );
  root.add(deck);
  return deckY + 0.012;
}

/** A row of square windows along one face of a cabin. */
function windows(root: Group, x0: number, x1: number, y: number, z: number, n: number): void {
  const w = ((x1 - x0) / n) * 0.6;
  for (let k = 0; k < n; k++) {
    const x = x0 + ((k + 0.5) * (x1 - x0)) / n;
    root.add(box(w, 0.045, 0.012, C.window, x, y, z));
  }
}

/** A cabin with windows on the front and both sides. */
function cabin(
  root: Group,
  x: number,
  y: number,
  len: number,
  wid: number,
  hgt: number,
  color: number,
  roof: number,
): void {
  root.add(box(len, hgt, wid, color, x, y, 0));
  root.add(box(len + 0.03, 0.025, wid + 0.03, roof, x, y + hgt, 0));
  // Front windows face the bow (+x).
  root.add(box(0.012, 0.05, wid * 0.8, C.window, x + len / 2 + 0.002, y + hgt * 0.62, 0));
  for (const s of [-1, 1]) {
    windows(
      root,
      x - len / 2 + 0.03,
      x + len / 2 - 0.03,
      y + hgt * 0.62,
      s * (wid / 2 + 0.002),
      Math.max(1, Math.round(len / 0.12)),
    );
  }
}

function slotGrid(
  root: Group,
  make: (x: number, y: number, z: number, k: number) => Object3D,
  xs: number[],
  zs: number[],
  y: number,
  layers: number,
  step: number,
): Object3D[] {
  const out: Object3D[] = [];
  for (let layer = 0; layer < layers; layer++) {
    for (const x of xs) {
      for (const z of zs) {
        const o = make(x, y + layer * step, z, out.length);
        o.visible = false;
        root.add(o);
        out.push(o);
      }
    }
  }
  return out;
}

function spread(from: number, to: number, n: number): number[] {
  return Array.from({ length: n }, (_, k) =>
    n === 1 ? (from + to) / 2 : from + ((to - from) * k) / (n - 1),
  );
}

type Crate = (size: number, x: number, y: number, z: number) => Object3D;
type Box = (seed: number, x: number, y: number, z: number) => Object3D;

/**
 * A fishing boat about 1.9 tiles long. Three layouts: a stern trawler with a
 * gantry and net drum, a crabber with its wheelhouse forward and an open
 * deck aft, and a drifter with the wheelhouse aft and a mast forward.
 */
export function fishingBoat(seed: number, company: number, crate: Crate): Craft {
  const rng = new Rng(seed * 7919 + 13);
  const root = new Group();
  const kind = rng.pick(['trawler', 'crabber', 'drifter'] as const);
  const paint = rng.pick(HULLS);
  const accent = COMPANY[company % COMPANY.length];
  const length = 1.9;
  const beam = rng.range(0.54, 0.62);
  const deck = hull(root, {
    length,
    beam,
    height: rng.range(0.34, 0.4),
    draft: 0.16,
    bow: rng.range(0.24, 0.32),
    stern: rng.range(0.7, 0.85),
    paint,
    bottom: rng.pick(ANTIFOUL),
    stripe: accent === paint ? C.cabin : accent,
    deck: rng.pick(DECK),
  });
  const white = rng.pick(SUPERSTRUCTURE);
  // Bulwark at the bow.
  root.add(box(0.3, 0.06, beam * 0.7, paint, 0.62, deck, 0));

  let cargo: number[];
  if (kind === 'trawler') {
    cabin(root, 0.42, deck, 0.34, beam * 0.62, 0.2, white, accent);
    root.add(box(0.2, 0.12, beam * 0.5, white, 0.42, deck + 0.2, 0));
    root.add(box(0.21, 0.02, beam * 0.52, accent, 0.42, deck + 0.32, 0));
    root.add(cyl(0.015, 0.36, C.chassis, 0.4, deck + 0.34));
    // Gantry over the stern and the net drum in front of it.
    for (const s of [-1, 1]) root.add(box(0.04, 0.42, 0.04, accent, -0.86, deck, s * beam * 0.36));
    root.add(box(0.05, 0.05, beam * 0.78, accent, -0.86, deck + 0.4, 0));
    const drum = cyl(0.07, beam * 0.5, 0x2f5d3a, -0.66, deck + 0.1, 0, 8);
    drum.rotation.x = Math.PI / 2;
    drum.position.y = deck + 0.09;
    root.add(drum);
    cargo = [-0.46, -0.29, -0.12, 0.05];
  } else if (kind === 'crabber') {
    cabin(root, 0.42, deck, 0.34, beam * 0.66, 0.24, white, accent);
    root.add(cyl(0.012, 0.3, C.chassis, 0.42, deck + 0.26));
    root.add(box(0.12, 0.012, 0.012, C.chassis, 0.42, deck + 0.5, 0));
    // A davit for hauling pots over the side.
    root.add(box(0.03, 0.3, 0.03, accent, 0.12, deck, beam * 0.38));
    root.add(box(0.03, 0.03, 0.16, accent, 0.12, deck + 0.28, beam * 0.3));
    cargo = [-0.72, -0.52, -0.32, -0.12];
  } else {
    cabin(root, -0.62, deck, 0.34, beam * 0.62, 0.22, white, accent);
    root.add(cyl(0.035, 0.12, accent, -0.72, deck + 0.22));
    root.add(cyl(0.018, 0.62, C.woodDark, 0.48, deck));
    const boom = box(0.5, 0.025, 0.025, C.woodDark, 0.26, deck + 0.42);
    boom.rotation.z = -0.35;
    root.add(boom);
    cargo = [-0.3, -0.1, 0.1, 0.3];
  }
  // Fish boxes: four along, two abreast, two high.
  const slots = slotGrid(
    root,
    (x, y, z) => crate(0.16, x, y, z),
    cargo,
    [-0.1, 0.1],
    deck,
    2,
    0.16,
  );
  return { root, slots };
}

/**
 * A coaster about 2.7 tiles long with crates on pallets in its hold. The
 * bridge is aft; some carry one or two deck cranes, some a derrick mast.
 */
export function coasterShip(seed: number, company: number, crate: Crate): Craft {
  const rng = new Rng(seed * 104729 + 7);
  const root = new Group();
  const paint = rng.pick(HULLS);
  const accent = COMPANY[company % COMPANY.length];
  const beam = rng.range(0.78, 0.86);
  const deck = hull(root, {
    length: 2.7,
    beam,
    height: rng.range(0.5, 0.58),
    draft: 0.24,
    bow: rng.range(0.16, 0.22),
    stern: rng.range(0.72, 0.85),
    paint,
    bottom: rng.pick(ANTIFOUL),
    stripe: rng.next() < 0.5 ? accent : C.cabin,
    deck: rng.pick(DECK),
  });
  const white = rng.pick(SUPERSTRUCTURE);
  // Forecastle and the bridge block aft, two or three decks high.
  root.add(box(0.36, 0.1, beam * 0.86, paint, 1.0, deck, 0));
  const decks = rng.int(2, 3);
  let y = deck;
  for (let k = 0; k < decks; k++) {
    const len = 0.5 - k * 0.07;
    cabin(
      root,
      -1.02 - k * 0.02,
      y,
      len,
      beam * (0.84 - k * 0.08),
      0.16,
      white,
      k === decks - 1 ? accent : white,
    );
    y += 0.185;
  }
  // Bridge wings and a funnel in company colours with a band.
  root.add(box(0.12, 0.02, beam + 0.04, white, -0.86, y - 0.04, 0));
  root.add(cyl(0.07, 0.26, accent, -1.22, deck + 0.2));
  root.add(cyl(0.072, 0.05, C.chassis, -1.22, deck + 0.42));
  // Hold coaming.
  root.add(box(1.62, 0.04, beam * 0.78, 0x8e959c, 0.05, deck, 0));
  const gear = rng.int(0, 2);
  const cranes = gear === 0 ? [] : gear === 1 ? [0.05] : [-0.42, 0.52];
  for (const x of cranes) {
    root.add(cyl(0.05, 0.4, C.craneYellow, x, deck, beam * 0.42 * (x < 0 ? 1 : -1)));
    const jib = box(
      0.56,
      0.035,
      0.035,
      C.craneYellow,
      x + 0.24,
      deck + 0.42,
      beam * 0.42 * (x < 0 ? 1 : -1),
    );
    jib.rotation.z = 0.4;
    root.add(jib);
  }
  if (gear === 0) {
    root.add(cyl(0.025, 0.75, C.chassis, 0.85, deck));
    root.add(box(0.012, 0.012, beam * 0.7, C.chassis, 0.85, deck + 0.6, 0));
  }
  // Pallets of crates: six along, three abreast, two high.
  const slots = slotGrid(
    root,
    (x, sy, z, k) => {
      const c = crate(0.18, x, sy + 0.025, z);
      if (k < 18) c.add(box(0.2, 0.025, 0.2, C.wood, 0, -0.025, 0));
      return c;
    },
    spread(-0.58, 0.62, 6),
    [-0.21, 0, 0.21],
    deck + 0.02,
    2,
    0.205,
  );
  return { root, slots };
}

/**
 * A container feeder, a big ship about 5.6 tiles long. Most have the bridge
 * aft; some have it further forward with containers either side.
 */
export function feederShip(seed: number, company: number, container: Box): Craft {
  const rng = new Rng(seed * 15485863 + 3);
  const root = new Group();
  const paint = rng.pick([0x24324a, 0xb33a32, 0x2f6fd0, 0x2e7d4f, 0x3a3f47, 0x1f6f78, 0xd9822b]);
  const accent = COMPANY[company % COMPANY.length];
  const beam = 0.96;
  const deck = hull(root, {
    length: 5.6,
    beam,
    height: 0.7,
    draft: 0.3,
    bow: rng.range(0.1, 0.14),
    stern: 0.86,
    paint,
    bottom: rng.pick(ANTIFOUL),
    stripe: C.cabin,
    deck: 0x8e959c,
  });
  const white = rng.pick(SUPERSTRUCTURE);
  // Forecastle with a breakwater.
  root.add(box(0.5, 0.14, beam * 0.9, paint, 2.42, deck, 0));
  root.add(box(0.04, 0.12, beam * 0.8, white, 2.15, deck, 0));
  const midBridge = rng.next() < 0.3;
  const bx = midBridge ? 1.95 : -2.3;
  let y = deck;
  for (let k = 0; k < 4; k++) {
    cabin(
      root,
      bx,
      y,
      0.5 - k * 0.04,
      beam * (0.86 - k * 0.04),
      0.17,
      white,
      k === 3 ? accent : white,
    );
    y += 0.19;
  }
  // Bridge wings across the full beam.
  root.add(box(0.14, 0.025, beam + 0.06, white, bx + 0.12, y - 0.05, 0));
  // Funnel: company colour with a black top and a white band.
  const fx = midBridge ? -2.45 : bx - 0.3;
  root.add(box(0.2, 0.34, 0.22, accent, fx, deck + (midBridge ? 0 : 0.42), 0));
  root.add(box(0.205, 0.05, 0.225, C.cabin, fx, deck + (midBridge ? 0.18 : 0.6), 0));
  root.add(box(0.205, 0.05, 0.225, C.chassis, fx, deck + (midBridge ? 0.34 : 0.76), 0));
  root.add(cyl(0.012, 0.4, C.chassis, bx, y));
  // Containers: six bays along, three abreast, two high, clear of the bridge.
  const along = midBridge ? spread(-1.95, 1.3, 6) : spread(-1.75, 1.45, 6);
  const slots = slotGrid(
    root,
    (x, sy, z, k) => container(k + seed, x, sy, z),
    along,
    [-BOX_WIDTH, 0, BOX_WIDTH],
    deck,
    2,
    0.24,
  );
  return { root, slots };
}
