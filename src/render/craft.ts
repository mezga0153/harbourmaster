import { BufferGeometry, Float32BufferAttribute, Group, Vector3, type Object3D } from 'three';
import { FEEDER_BAYS, FEEDER_ROWS, FEEDER_TIERS } from '../sim/balance';
import { Rng } from '../sim/rng';
import { BOX_WIDTH } from './assets';
import { C } from './palette';
import { lamp, LIGHT, pool } from './lights';
import { box, cyl } from './parts';
import type { Model } from './model';
import { CRATE } from './models';
import { mesh } from './util/mesh';

// Procedural boats and ships. Every one is built from a seed, so each boat
// that sails in looks a little different: hull shape, paint, wheelhouse,
// masts and gear. All face +X with the waterline at y=0. The hull's lofted
// geometry is each boat's own (Model.owned) and is freed when it goes.

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
function hull(root: Group, h: HullSpec, owned: BufferGeometry[]): number {
  const top = outline(h.length, h.beam, h.bow, h.stern);
  // The keel is narrower and shorter: a raked bow and a tucked-in stern.
  const keel = scaleRing(top, 0.88, 0.45, -h.length * 0.03);
  const deckY = h.height - h.draft;
  const water = lerpRing(keel, top, h.draft / h.height + 0.04);
  const rail = lerpRing(keel, top, 0.86);
  const y0 = -h.draft;
  const yw = 0.04 * h.height;
  const yr = y0 + h.height * 0.86;
  const band = (geo: BufferGeometry, color: number) => {
    owned.push(geo);
    root.add(mesh(geo, color));
  };
  band(loft(keel, y0, water, yw), h.bottom);
  band(loft(water, yw, rail, yr), h.paint);
  band(loft(rail, yr, top, deckY, true), h.stripe);
  band(
    loft(scaleRing(top, 0.97, 0.9), deckY, scaleRing(top, 0.97, 0.9), deckY + 0.012, true),
    h.deck,
  );
  // The white stern light.
  root.add(lamp(LIGHT.white, 0.025, -h.length / 2 + 0.05, deckY + 0.04, 0));
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

/**
 * A cabin with windows on the front and both sides; the wheelhouse, with
 * `lights`, carries the sidelights, red to port and green to starboard
 * (see sidelights), and the white masthead light on its roof; a ship's
 * bridge, with 'mast', only the masthead light, its sidelights out on the
 * ends of its bridge wings.
 */
function cabin(
  root: Group,
  x: number,
  y: number,
  len: number,
  wid: number,
  hgt: number,
  color: number,
  roof: number,
  lights: boolean | 'mast' = true,
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
  if (lights === true) sidelights(root, x + len / 2 - 0.04, y + hgt * 0.75, wid / 2, 0.05);
  if (lights) root.add(lamp(LIGHT.white, 0.03, x, y + hgt + 0.045, 0));
}

/**
 * A ship's sidelights at x, y, `out` either side of the middle: red to
 * port (-z) and green to starboard, shining by day too so which way a
 * ship is heading shows; `size` across.
 */
function sidelights(root: Group, x: number, y: number, out: number, size: number): void {
  root.add(lamp(LIGHT.port, size, x, y, -(out + size / 2)));
  root.add(lamp(LIGHT.starboard, size, x, y, out + size / 2));
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

/** Each kind of boat's layouts, one picked by its seed unless one is asked for (the dev lab). */
export const LAYOUTS = {
  smack: ['trawler', 'crabber', 'drifter', 'shrimper', 'seiner', 'longliner'],
  lobster: ['downeast', 'hardtop', 'flybridge', 'potter'],
  coaster: ['classic', 'telescopic', 'forebridge', 'poop'],
  tug: ['harbour', 'tractor', 'fireboat', 'classic'],
  feeder: ['aft', 'forward', 'streamlined', 'twinstack'],
  bulker: ['geared', 'gearless', 'selfunloader', 'laker'],
} as const;

/** The seed's layout, or the one asked for; the seed's pick is taken either way, so the rest stays the same. */
function layoutOf<T extends string>(rng: Rng, from: readonly T[], asked?: string): T {
  const picked = rng.pick(from);
  return from.includes(asked as T) ? (asked as T) : picked;
}

/** A spar of `len` along +x from `at`, turned `up` above the level and `out` round about y. */
function spar(
  len: number,
  thick: number,
  color: number,
  at: [number, number, number],
  up: number,
  out = 0,
): Group {
  const g = new Group();
  g.position.set(...at);
  g.rotation.set(0, out, up, 'YZX');
  g.add(box(len, thick, thick, color, len / 2, -thick / 2, 0));
  return g;
}

/**
 * A fishing boat about 1.9 tiles long. Six layouts: a stern trawler with a
 * gantry and net drum, a crabber with its wheelhouse forward and an open
 * deck aft, a drifter with the wheelhouse aft and a mast forward, a
 * shrimper with its outriggers raised either side, a seiner with a boom
 * and power block over its net pile and a skiff on the stern, and a
 * longliner with a whaleback shelter forward and marker flags aft.
 */
export function fishingBoat(seed: number, company: number, crate: Crate, layout?: string): Model {
  const rng = new Rng(seed * 7919 + 13);
  const root = new Group();
  const kind = layoutOf(rng, LAYOUTS.smack, layout);
  const paint = rng.pick(HULLS);
  const accent = COMPANY[company % COMPANY.length];
  const length = 1.9;
  const beam = rng.range(0.54, 0.62);
  const owned: BufferGeometry[] = [];
  const deck = hull(
    root,
    {
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
    },
    owned,
  );
  const white = rng.pick(SUPERSTRUCTURE);
  // Bulwark at the bow.
  root.add(box(0.3, 0.06, beam * 0.7, paint, 0.62, deck, 0));

  let cargo: number[];
  if (kind === 'trawler') {
    cabin(root, 0.42, deck, 0.34, beam * 0.62, 0.2, white, accent);
    root.add(box(0.2, 0.12, beam * 0.5, white, 0.42, deck + 0.2, 0));
    root.add(box(0.21, 0.02, beam * 0.52, accent, 0.42, deck + 0.32, 0));
    root.add(cyl(0.015, 0.36, C.chassis, 0.4, deck + 0.34));
    root.add(lamp(LIGHT.white, 0.03, 0.4, deck + 0.72, 0));
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
    root.add(lamp(LIGHT.white, 0.03, 0.42, deck + 0.58, 0));
    root.add(box(0.12, 0.012, 0.012, C.chassis, 0.42, deck + 0.5, 0));
    // A davit for hauling pots over the side.
    root.add(box(0.03, 0.3, 0.03, accent, 0.12, deck, beam * 0.38));
    root.add(box(0.03, 0.03, 0.16, accent, 0.12, deck + 0.28, beam * 0.3));
    cargo = [-0.72, -0.52, -0.32, -0.12];
  } else if (kind === 'drifter') {
    cabin(root, -0.62, deck, 0.34, beam * 0.62, 0.22, white, accent);
    root.add(cyl(0.035, 0.12, accent, -0.72, deck + 0.22));
    root.add(cyl(0.018, 0.62, C.woodDark, 0.48, deck));
    root.add(lamp(LIGHT.white, 0.03, 0.48, deck + 0.64, 0));
    const boom = box(0.5, 0.025, 0.025, C.woodDark, 0.26, deck + 0.42);
    boom.rotation.z = -0.35;
    root.add(boom);
    cargo = [-0.3, -0.1, 0.1, 0.3];
  } else if (kind === 'shrimper') {
    cabin(root, 0.44, deck, 0.32, beam * 0.64, 0.22, white, accent);
    // A mast behind the wheelhouse, its outriggers raised in a V either
    // side with the try nets hanging from their ends.
    const mx = 0.14;
    root.add(cyl(0.018, 0.66, C.chassis, mx, deck));
    root.add(lamp(LIGHT.white, 0.03, mx, deck + 0.68, 0));
    const net = rng.pick([0x2f5d3a, 0x3a5f8a, 0x7a3a2a]);
    for (const s of [-1, 1]) {
      const len = 0.66;
      const up = 1.0;
      root.add(spar(len, 0.022, accent, [mx, deck + 0.12, s * 0.03], up, (-s * Math.PI) / 2));
      const tx = mx;
      const ty = deck + 0.12 + len * Math.sin(up);
      const tz = s * (0.03 + len * Math.cos(up));
      root.add(box(0.006, 0.2, 0.006, C.chassis, tx, ty - 0.2, tz));
      root.add(box(0.1, 0.07, 0.05, net, tx, ty - 0.27, tz));
      // The stay from the masthead to the boom's end.
      root.add(box(0.006, 0.006, Math.abs(tz), C.chassis, tx, ty + 0.06, tz / 2));
    }
    cargo = [-0.72, -0.52, -0.32, -0.12];
  } else if (kind === 'seiner') {
    cabin(root, 0.46, deck, 0.3, beam * 0.66, 0.24, white, accent);
    // A tall mast with a boom raked up over the stern, the power block
    // hanging from its end, the net piled on the stern and the skiff that
    // pulls it round riding on the ramp.
    root.add(cyl(0.02, 0.62, C.chassis, 0.2, deck));
    root.add(lamp(LIGHT.white, 0.03, 0.2, deck + 0.64, 0));
    const len = 0.68;
    const up = 0.62;
    root.add(spar(len, 0.028, accent, [0.2, deck + 0.18, 0], up, Math.PI));
    const tx = 0.2 - len * Math.cos(up);
    const ty = deck + 0.18 + len * Math.sin(up);
    const block = cyl(0.045, 0.035, C.chassis, tx, 0, 0, 8);
    block.rotation.x = Math.PI / 2;
    block.position.y = ty - 0.1;
    root.add(block);
    root.add(box(0.006, 0.06, 0.006, C.chassis, tx, ty - 0.08, 0));
    root.add(box(0.34, 0.1, beam * 0.6, 0x2b3530, -0.76, deck, 0));
    const floats = rng.pick([0xf2c230, 0xe8892f, 0xf4f4f0]);
    for (let k = 0; k < 5; k++)
      root.add(box(0.04, 0.03, 0.04, floats, -0.9 + k * 0.07, deck + 0.1, beam * 0.24));
    root.add(
      box(0.26, 0.1, beam * 0.42, rng.pick([0xd9822b, 0xb33a32, 0xe3e1d8]), -0.94, deck - 0.07, 0),
    );
    cargo = [-0.5, -0.32, -0.14, 0.04];
  } else {
    // A whaleback shelter over the foredeck with the wheelhouse on it, a
    // line hauler at the rail and marker buoys with their flags aft.
    root.add(box(0.36, 0.14, beam * 0.74, paint, 0.46, deck, 0));
    cabin(root, 0.44, deck + 0.14, 0.26, beam * 0.56, 0.2, white, accent);
    root.add(cyl(0.012, 0.16, C.chassis, 0.36, deck + 0.36));
    root.add(box(0.14, 0.015, 0.03, C.cabin, 0.36, deck + 0.52, 0));
    root.add(cyl(0.04, 0.04, C.chassis, 0.2, deck + 0.12, beam * 0.36, 8));
    root.add(box(0.03, 0.12, 0.03, accent, 0.2, deck, beam * 0.36));
    const flag = rng.pick(BUOYS);
    for (const s of [-1, 1]) {
      const z = s * beam * 0.36;
      root.add(cyl(0.008, 0.48, C.woodDark, -0.88, deck, z, 4));
      root.add(cyl(0.03, 0.05, rng.pick(BUOYS), -0.88, deck + 0.08, z, 6));
      root.add(box(0.07, 0.05, 0.006, flag, -0.845, deck + 0.42, z));
    }
    cargo = [-0.72, -0.52, -0.32, -0.12];
  }
  // Fish boxes: four along, two abreast, two high.
  const slots = slotGrid(
    root,
    (x, y, z) => crate(CRATE, x, y, z),
    cargo,
    [-0.1, 0.1],
    deck,
    2,
    CRATE,
  );
  return { root, crates: slots, owned };
}

/** Lobster boats: white or pale hulls, a band of bright colour. */
const LOBSTER_HULLS = [0xf4f4f0, 0xe3e1d8, 0xdfe9ef, 0x1f6f78];
/** The yellow, orange and red of wire lobster pots, and the buoys' stripes. */
const POTS = [0xf2c230, 0xe8892f, 0xd6453d];
const BUOYS = [0xd6453d, 0xf2c230, 0x3fa34d, 0x2f6fd0, 0xf4f4f0];

/**
 * A lobster boat, the length of a fishing boat but low and open: its little
 * wheelhouse well forward, a hauler for the pot lines at its side, lobster
 * pots stacked on the open deck aft, and its painted buoys hung along the
 * wheelhouse; the catch in crates amidships. The wheelhouse is a closed
 * downeaster's, an open hardtop on posts, one with a flybridge and radar
 * arch on its roof, or a potter's with a canvas dodger aft and an A-frame
 * over its pots stacked three high.
 */
export function lobsterBoat(seed: number, company: number, crate: Crate, layout?: string): Model {
  const rng = new Rng(seed * 6007 + 29);
  const root = new Group();
  const kind = layoutOf(rng, LAYOUTS.lobster, layout);
  const paint = rng.pick(LOBSTER_HULLS);
  const accent = COMPANY[company % COMPANY.length];
  const length = 1.9;
  const beam = rng.range(0.56, 0.62);
  const owned: BufferGeometry[] = [];
  const deck = hull(
    root,
    {
      length,
      beam,
      height: rng.range(0.28, 0.32),
      draft: 0.14,
      bow: rng.range(0.3, 0.36),
      stern: rng.range(0.82, 0.9),
      paint,
      bottom: rng.pick(ANTIFOUL),
      stripe: accent === paint ? C.funnel : accent,
      deck: rng.pick(DECK),
    },
    owned,
  );
  // Wheelhouse forward, with an open back.
  const white = rng.pick(SUPERSTRUCTURE);
  const wid = beam * 0.7;
  if (kind === 'hardtop') {
    // A windscreen and half walls under a roof on four posts, open aft.
    const [x, len, h] = [0.42, 0.3, 0.26];
    root.add(box(0.03, h * 0.5, wid, white, x + len / 2, deck, 0));
    root.add(box(0.014, h * 0.38, wid * 0.86, C.window, x + len / 2 + 0.006, deck + h * 0.5, 0));
    for (const s of [-1, 1]) {
      root.add(box(len, h * 0.42, 0.02, white, x, deck, (s * wid) / 2));
      for (const px of [x - len / 2, x + len / 2])
        root.add(box(0.02, h, 0.02, white, px, deck, (s * wid) / 2));
    }
    root.add(box(len + 0.14, 0.025, wid + 0.03, accent, x - 0.06, deck + h, 0));
    root.add(box(0.05, 0.1, 0.06, C.chassis, x + 0.08, deck, 0.04));
    sidelights(root, x + len / 2 - 0.04, deck + h * 0.75, wid / 2, 0.05);
    root.add(lamp(LIGHT.white, 0.03, x, deck + h + 0.045, 0));
    root.add(cyl(0.04, 0.03, C.cabin, x - 0.04, deck + h + 0.025, 0, 10));
  } else {
    cabin(root, 0.42, deck, 0.3, wid, 0.26, white, accent);
    root.add(cyl(0.012, 0.22, C.chassis, 0.38, deck + 0.28));
  }
  if (kind === 'flybridge') {
    // A rail and a second helm on the roof, and a radar arch.
    const top = deck + 0.285;
    for (const s of [-1, 1]) root.add(box(0.3, 0.06, 0.01, white, 0.42, top, (s * wid) / 2));
    root.add(box(0.01, 0.06, wid, white, 0.57, top, 0));
    root.add(box(0.06, 0.07, 0.1, white, 0.48, top, 0.05));
    for (const s of [-1, 1]) root.add(box(0.025, 0.16, 0.025, white, 0.3, top, s * wid * 0.45));
    root.add(box(0.03, 0.025, wid * 0.92, white, 0.3, top + 0.16, 0));
    root.add(cyl(0.045, 0.035, C.cabin, 0.3, top + 0.185, 0, 10));
  } else if (kind === 'potter') {
    // A canvas dodger aft of the wheelhouse over the hauler, and an A-frame
    // for swinging the pots aboard.
    const canvas = rng.pick([0x2f5d3a, 0x24324a, 0x8a6a2f]);
    root.add(box(0.14, 0.02, wid * 0.96, canvas, 0.2, deck + 0.24, 0));
    for (const s of [-1, 1])
      root.add(box(0.012, 0.24, 0.012, C.chassis, 0.14, deck, (s * wid) / 2));
    for (const s of [-1, 1]) {
      const leg = box(0.025, 0.5, 0.025, accent, -0.88, deck, s * beam * 0.36);
      leg.rotation.x = -s * 0.12;
      root.add(leg);
    }
    root.add(box(0.03, 0.03, beam * 0.6, accent, -0.88, deck + 0.48, 0));
    root.add(box(0.006, 0.12, 0.006, C.chassis, -0.88, deck + 0.36, 0));
  }
  // Buoys hung along both sides of the wheelhouse, each in two colours.
  const buoys = rng.pick(BUOYS);
  const band = rng.pick(BUOYS.filter((c) => c !== buoys));
  for (const z of [-1, 1]) {
    for (const x of [0.34, 0.46]) {
      const y = deck + 0.1;
      const zz = z * (beam * 0.35 + 0.025);
      root.add(cyl(0.022, 0.06, buoys, x, y, zz, 6));
      root.add(cyl(0.023, 0.02, band, x, y + 0.06, zz, 6));
    }
  }
  // The pot hauler at the starboard rail, by the wheelhouse.
  root.add(cyl(0.035, 0.05, C.chassis, 0.18, deck + 0.14, beam * 0.36, 8));
  root.add(box(0.03, 0.14, 0.03, accent, 0.18, deck, beam * 0.36));
  // Lobster pots stacked on the open deck aft: wire boxes with a frame.
  const pot = rng.pick(POTS);
  const pots = [
    [-0.7, -0.14, 0],
    [-0.7, 0.14, 0],
    [-0.52, -0.14, 0],
    [-0.52, 0.14, 0],
    [-0.7, 0, 0.1],
    [-0.52, 0, 0.1],
  ];
  if (kind === 'potter') pots.push([-0.7, 0, 0.2], [-0.52, 0, 0.2]);
  for (const [x, z, y] of pots) {
    root.add(box(0.16, 0.1, 0.13, pot, x, deck + y, z));
    root.add(box(0.165, 0.012, 0.135, C.chassis, x, deck + y + 0.05, z));
  }
  // The catch in crates amidships.
  const slots = slotGrid(
    root,
    (x, y, z) => crate(CRATE, x, y, z),
    [-0.33, -0.16, 0.01, 0.18],
    [-0.09, 0.09],
    deck,
    2,
    CRATE,
  );
  return { root, crates: slots, owned };
}

/** The pallet board under each of a coaster's crates, as thick as a jib crane's hook shows it. */
const PALLET = CRATE * 0.14;

/**
 * A coaster about 2.7 tiles long with crates on pallets in its hold. The
 * bridge is aft, two or three decks high; on a raised poop; or a wheelhouse
 * on a column that lowers for bridges; or it is forward, with the engine's
 * twin funnels aft. Some carry one or two deck cranes, some a derrick
 * mast, some a gantry crane on rails along the hold.
 */
export function coasterShip(seed: number, company: number, crate: Crate, layout?: string): Model {
  const rng = new Rng(seed * 104729 + 7);
  const root = new Group();
  const kind = layoutOf(rng, LAYOUTS.coaster, layout);
  const paint = rng.pick(HULLS);
  const accent = COMPANY[company % COMPANY.length];
  const beam = rng.range(0.78, 0.86);
  const owned: BufferGeometry[] = [];
  const deck = hull(
    root,
    {
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
    },
    owned,
  );
  const white = rng.pick(SUPERSTRUCTURE);
  const decks = rng.int(2, 3);
  const wings = (x: number, y: number, across: number) => {
    root.add(box(0.12, 0.02, across, white, x, y - 0.04, 0));
    sidelights(root, x, y - 0.02 + 0.035, across / 2, 0.07);
  };
  if (kind === 'forebridge') {
    // The bridge on the bow, narrow as the bow is, and the engine aft
    // under a low casing with its two funnels side by side.
    root.add(box(0.34, 0.1, beam * 0.62, paint, 0.98, deck, 0));
    cabin(root, 0.97, deck + 0.1, 0.3, beam * 0.5, 0.16, white, white, false);
    cabin(root, 0.95, deck + 0.285, 0.24, beam * 0.46, 0.16, white, accent, 'mast');
    wings(0.98, deck + 0.47, beam * 0.86);
    root.add(box(0.42, 0.12, beam * 0.6, white, -1.06, deck, 0));
    for (const s of [-1, 1]) {
      root.add(cyl(0.05, 0.24, accent, -1.12, deck + 0.12, s * 0.13));
      root.add(cyl(0.052, 0.04, C.chassis, -1.12, deck + 0.36, s * 0.13));
    }
    const winch = cyl(0.04, beam * 0.3, C.chassis, -1.24, 0, 0, 8);
    winch.rotation.x = Math.PI / 2;
    winch.position.y = deck + 0.05;
    root.add(winch);
  } else {
    // Forecastle with a foremast, and the bridge block aft.
    root.add(box(0.36, 0.1, beam * 0.86, paint, 1.0, deck, 0));
    if (kind !== 'classic') {
      root.add(cyl(0.015, 0.36, C.chassis, 1.02, deck + 0.1));
      root.add(lamp(LIGHT.white, 0.03, 1.02, deck + 0.48, 0));
    }
    let y = deck;
    if (kind === 'poop') {
      // A raised poop deck aft, the bridge on it and a square funnel.
      root.add(box(0.62, 0.1, beam * 0.94, paint, -1.04, deck, 0));
      y += 0.1;
    }
    const tall = kind === 'telescopic' ? 1 : decks;
    for (let k = 0; k < tall; k++) {
      const len = 0.5 - k * 0.07;
      cabin(
        root,
        -1.02 - k * 0.02,
        y,
        len,
        beam * (0.84 - k * 0.08),
        0.16,
        white,
        k === tall - 1 ? accent : white,
        k === tall - 1 && kind !== 'telescopic' && 'mast',
      );
      y += 0.185;
    }
    if (kind === 'telescopic') {
      // The wheelhouse on a column, wider than the deck below it.
      root.add(box(0.12, 0.3, 0.14, C.chassis, -0.96, y, 0));
      y += 0.3;
      cabin(root, -0.94, y, 0.3, beam * 0.88, 0.15, white, accent, 'mast');
      y += 0.175;
    }
    // Bridge wings and a funnel in company colours with a band.
    wings(-0.86, y, beam + 0.04);
    if (kind === 'poop') {
      const funnel = box(0.16, 0.36, 0.18, accent, -1.24, deck + 0.18, 0);
      funnel.rotation.z = 0.12;
      root.add(funnel);
      const top = box(0.165, 0.06, 0.185, C.chassis, -1.27, deck + 0.52, 0);
      top.rotation.z = 0.12;
      root.add(top);
    } else {
      root.add(cyl(0.07, 0.26, accent, -1.22, deck + 0.2));
      root.add(cyl(0.072, 0.05, C.chassis, -1.22, deck + 0.42));
    }
  }
  // Hold coaming, and the deck lights on over it at night.
  root.add(box(1.62, 0.04, beam * 0.78, 0x8e959c, 0.05, deck, 0));
  root.add(pool(0.95, beam * 0.45, 0.05, deck + 0.045, 0, 0.22));
  const gear = rng.int(0, 3);
  const cranes = gear === 1 ? [0.05] : gear === 2 ? [-0.42, 0.52] : [];
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
    const mx = kind === 'forebridge' ? -0.73 : 0.85;
    root.add(cyl(0.025, 0.75, C.chassis, mx, deck));
    root.add(box(0.012, 0.012, beam * 0.7, C.chassis, mx, deck + 0.6, 0));
  } else if (gear === 3) {
    // A gantry crane on rails along the hold's coaming, parked at its end.
    for (const s of [-1, 1]) {
      root.add(box(1.62, 0.015, 0.02, C.chassis, 0.05, deck + 0.04, s * beam * 0.41));
      root.add(box(0.05, 0.55, 0.05, C.craneYellow, 0.75, deck + 0.04, s * beam * 0.41));
    }
    root.add(box(0.08, 0.06, beam * 0.88, C.craneYellow, 0.75, deck + 0.59, 0));
    root.add(box(0.1, 0.06, 0.12, C.chassis, 0.75, deck + 0.53, beam * 0.15));
  }
  // Pallets of crates: six along, three abreast, two high, each crate on
  // its own pallet as a crane lifts it.
  const slots = slotGrid(
    root,
    (x, sy, z) => {
      const c = crate(CRATE, x, sy + PALLET, z);
      c.add(box(CRATE * 1.1, PALLET, CRATE * 1.1, C.wood, 0, -PALLET, 0));
      return c;
    },
    spread(-0.58, 0.62, 6),
    [-0.21, 0, 0.21],
    deck + 0.02,
    2,
    CRATE + PALLET,
  );
  return { root, crates: slots, owned };
}

/**
 * A harbour tug about 1.1 tiles long: a beamy hull in fenders all round, a
 * wheelhouse forward with a raised bridge, a funnel and a towing winch aft.
 * A tractor tug has its tall wheelhouse amidships, twin stacks and the
 * winch on the bow; a fireboat carries water cannon on a tower; an old
 * classic a tall funnel, a mast forward and a towing hook on a bar aft.
 */
export function tugBoat(seed: number, layout?: string): Model {
  const rng = new Rng(seed * 4973 + 29);
  const root = new Group();
  const kind = layoutOf(rng, LAYOUTS.tug, layout);
  const paint = rng.pick([0xb33a32, 0x24324a, 0x2e7d4f, 0xd9822b]);
  const length = 1.1;
  const beam = 0.48;
  const owned: BufferGeometry[] = [];
  const deck = hull(
    root,
    {
      length,
      beam,
      height: 0.3,
      draft: 0.12,
      bow: 0.32,
      stern: 0.88,
      paint,
      bottom: rng.pick(ANTIFOUL),
      stripe: C.cabin,
      deck: rng.pick(DECK),
    },
    owned,
  );
  // Rubber fenders all round, heaviest at the bow, where it pushes.
  const fender = 0x1d1f22;
  for (const s of [-1, 1])
    root.add(box(length * 0.62, 0.07, 0.05, fender, -0.06, deck - 0.12, s * beam * 0.48));
  root.add(box(0.1, 0.1, beam * 0.55, fender, length / 2 - 0.06, deck - 0.14, 0));
  root.add(box(0.06, 0.07, beam * 0.8, fender, -length / 2 + 0.02, deck - 0.12, 0));
  const white = rng.pick(SUPERSTRUCTURE);
  const winch = (x: number) => {
    // Lying across the deck: cyl stands on its base, so set its middle.
    const w = cyl(0.05, beam * 0.4, C.chassis, x, 0, 0, 8);
    w.rotation.x = Math.PI / 2;
    w.position.y = deck + 0.06;
    root.add(w);
  };
  if (kind === 'tractor') {
    // A deckhouse amidships and the wheelhouse over it, windows all round
    // and overhanging; two stacks behind, the winch on the bow and a towing
    // staple aft.
    cabin(root, 0.02, deck, 0.34, beam * 0.62, 0.15, white, white, false);
    cabin(root, 0.04, deck + 0.175, 0.24, beam * 0.74, 0.12, white, paint);
    root.add(box(0.012, 0.045, beam * 0.6, C.window, -0.082, deck + 0.24, 0));
    for (const s of [-1, 1]) {
      root.add(cyl(0.028, 0.24, paint, -0.18, deck + 0.06, s * 0.07));
      root.add(cyl(0.03, 0.04, fender, -0.18, deck + 0.3, s * 0.07));
    }
    winch(0.33);
    for (const s of [-1, 1]) root.add(box(0.03, 0.12, 0.03, C.chassis, -0.4, deck, s * 0.08));
    root.add(box(0.03, 0.03, 0.2, C.chassis, -0.4, deck + 0.1, 0));
    return { root, crates: [], owned };
  }
  if (kind === 'classic') {
    // A low wheelhouse forward with a mast before it, a tall funnel with
    // a band, and the towing hook on a bar across the after deck.
    cabin(root, 0.14, deck, 0.24, beam * 0.6, 0.19, white, C.woodDark);
    root.add(cyl(0.012, 0.42, C.chassis, 0.34, deck));
    root.add(lamp(LIGHT.white, 0.03, 0.34, deck + 0.44, 0));
    root.add(cyl(0.05, 0.36, paint, -0.08, deck));
    root.add(cyl(0.052, 0.04, C.cabin, -0.08, deck + 0.24));
    root.add(cyl(0.052, 0.05, fender, -0.08, deck + 0.36));
    for (const s of [-1, 1])
      root.add(box(0.025, 0.14, 0.025, C.chassis, -0.3, deck, s * beam * 0.36));
    root.add(box(0.025, 0.025, beam * 0.74, C.chassis, -0.3, deck + 0.14, 0));
    root.add(box(0.03, 0.06, 0.03, C.chassis, -0.34, deck + 0.04, 0));
    return { root, crates: [], owned };
  }
  cabin(root, 0.1, deck, 0.36, beam * 0.62, 0.17, white, paint);
  // The bridge on top, all round windows.
  root.add(box(0.2, 0.1, beam * 0.5, white, 0.14, deck + 0.19, 0));
  root.add(box(0.012, 0.045, beam * 0.42, C.window, 0.245, deck + 0.22, 0));
  root.add(box(0.23, 0.02, beam * 0.54, paint, 0.14, deck + 0.29, 0));
  root.add(lamp(LIGHT.white, 0.03, 0.14, deck + 0.33, 0));
  // Funnel in the company paint with a black top, and the winch aft.
  const fx = kind === 'fireboat' ? -0.16 : -0.12;
  root.add(cyl(0.045, 0.16, paint, fx, deck + 0.13));
  root.add(cyl(0.047, 0.04, fender, fx, deck + 0.29));
  winch(-0.36);
  if (kind === 'fireboat') {
    // Water cannon: one on a tower over the bridge, one on each wing.
    const red = C.funnel;
    const monitor = (x: number, y: number, z: number, aim: number) => {
      root.add(cyl(0.018, 0.04, red, x, y, z, 6));
      root.add(spar(0.09, 0.022, red, [x, y + 0.035, z], 0.25, aim));
    };
    root.add(box(0.04, 0.24, 0.04, red, -0.03, deck + 0.17, 0));
    root.add(box(0.1, 0.015, 0.1, red, -0.03, deck + 0.41, 0));
    monitor(-0.03, deck + 0.425, 0, 0);
    for (const s of [-1, 1]) monitor(0, deck + 0.195, s * beam * 0.27, -s * 0.5);
  }
  return { root, crates: [], owned };
}

/**
 * A container feeder, a big ship about 5.6 tiles long. Most have the bridge
 * aft; some have it further forward with containers either side. Of those
 * aft, some are streamlined, the bridge enclosed the full beam and the
 * funnel a tall casing behind it, and some have two funnels side by side
 * and a freefall lifeboat on the stern.
 */
export function feederShip(seed: number, company: number, container: Box, layout?: string): Model {
  const rng = new Rng(seed * 15485863 + 3);
  const root = new Group();
  const kind = layoutOf(rng, ['aft', 'aft', ...LAYOUTS.feeder], layout);
  const paint = rng.pick([0x24324a, 0xb33a32, 0x2f6fd0, 0x2e7d4f, 0x3a3f47, 0x1f6f78, 0xd9822b]);
  const accent = COMPANY[company % COMPANY.length];
  const beam = 0.96;
  const owned: BufferGeometry[] = [];
  const deck = hull(
    root,
    {
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
    },
    owned,
  );
  const white = rng.pick(SUPERSTRUCTURE);
  // Forecastle with a breakwater.
  root.add(box(0.5, 0.14, beam * 0.9, paint, 2.42, deck, 0));
  root.add(box(0.04, 0.12, beam * 0.8, white, 2.15, deck, 0));
  const midBridge = kind === 'forward';
  const bx = midBridge ? 1.95 : -2.3;
  let y = deck;
  // Six decks, so the bridge looks out over containers stacked four high;
  // a streamlined one's step back from a straight front.
  const sleek = kind === 'streamlined';
  for (let k = 0; k < 6; k++) {
    const len = 0.5 - k * 0.03;
    const top = k === 5;
    cabin(
      root,
      sleek ? bx + 0.25 - (top ? 0.56 : len) / 2 : bx,
      y,
      sleek && top ? 0.56 : len,
      sleek && top ? beam + 0.06 : beam * (0.86 - k * 0.03),
      0.17,
      white,
      top ? accent : white,
      top && 'mast',
    );
    y += 0.19;
  }
  if (sleek) {
    // The bridge the full beam, its sidelights at the ends.
    sidelights(root, bx + 0.12, y - 0.07, beam / 2 + 0.03, 0.08);
    // A tall casing aft for the funnel, banded at the top, and a foremast.
    const fx = bx - 0.32;
    const casing = box(0.22, 1.22, 0.3, white, fx, deck, 0);
    casing.rotation.z = 0.06;
    root.add(casing);
    const band = box(0.225, 0.16, 0.305, accent, fx - 0.032, deck + 1.06, 0);
    band.rotation.z = 0.06;
    root.add(band);
    root.add(cyl(0.015, 0.5, C.chassis, 2.4, deck + 0.14));
    root.add(lamp(LIGHT.white, 0.035, 2.4, deck + 0.66, 0));
  } else {
    // Bridge wings across the full beam.
    root.add(box(0.14, 0.025, beam + 0.06, white, bx + 0.12, y - 0.05, 0));
    sidelights(root, bx + 0.12, y - 0.025 + 0.04, beam / 2 + 0.03, 0.08);
  }
  // Funnel: company colour with a black top and a white band.
  const fx = midBridge ? -2.45 : bx - 0.3;
  const fy = deck + (midBridge ? 0 : 0.8);
  const funnel = (z: number, w: number) => {
    root.add(box(0.2, 0.34, w, accent, fx, fy, z));
    root.add(box(0.205, 0.05, w + 0.005, C.cabin, fx, fy + 0.18, z));
    root.add(box(0.205, 0.05, w + 0.005, C.chassis, fx, fy + 0.34, z));
  };
  if (kind === 'twinstack') {
    funnel(-0.22, 0.14);
    funnel(0.22, 0.14);
    root.add(box(0.06, 0.04, 0.3, accent, fx, fy + 0.26, 0));
    // The freefall lifeboat on its ramp off the stern.
    const boat = box(0.32, 0.12, 0.14, 0xe8892f, -2.68, deck + 0.36, 0);
    boat.rotation.z = 0.35;
    root.add(boat);
    const ramp = box(0.34, 0.02, 0.18, C.chassis, -2.66, deck + 0.32, 0);
    ramp.rotation.z = 0.35;
    root.add(ramp);
  } else if (!sleek) funnel(0, 0.22);
  root.add(cyl(0.012, 0.4, C.chassis, bx, y));
  // Containers: six bays along, three abreast, up to four high, clear of
  // the bridge. They fill a tier at a time, so a light load sits low.
  const bays = FEEDER_BAYS;
  const along = midBridge ? spread(-1.95, 1.3, bays) : spread(-1.75, 1.45, bays);
  const across = spread(-BOX_WIDTH, BOX_WIDTH, FEEDER_ROWS);
  const slots = slotGrid(
    root,
    (x, sy, z, k) => container(k + seed, x, sy, z),
    along,
    across,
    deck,
    FEEDER_TIERS,
    0.24,
  );
  return { root, crates: slots, owned };
}

/**
 * A handysize bulk carrier, about 5.6 tiles long: a long low hull with
 * five hatch covers along its holds and the bridge and funnel right aft.
 * Most carry deck cranes between the holds; some none, their hatches
 * rolling open sideways; a self-unloader its long boom along the deck;
 * and a laker its wheelhouse right forward on the bow.
 */
export function bulkCarrier(seed: number, company: number, layout?: string): Model {
  const rng = new Rng(seed * 7919 + 11);
  const root = new Group();
  const kind = layoutOf(rng, ['geared', ...LAYOUTS.bulker], layout);
  const paint = rng.pick([0x5a2f2a, 0x24324a, 0x2e3a2f, 0x7a2a2a, 0x3a3f47]);
  const accent = COMPANY[company % COMPANY.length];
  const beam = 1;
  const owned: BufferGeometry[] = [];
  const deck = hull(
    root,
    {
      length: 5.6,
      beam,
      height: 0.62,
      draft: 0.34,
      bow: rng.range(0.12, 0.16),
      stern: 0.9,
      paint,
      bottom: rng.pick(ANTIFOUL),
      stripe: C.cabin,
      deck: 0x7d6e5a,
    },
    owned,
  );
  const white = rng.pick(SUPERSTRUCTURE);
  root.add(box(0.46, 0.12, beam * 0.9, paint, 2.45, deck, 0));
  // Five holds, each a raised coaming with its hatch cover, and a deck
  // crane between each pair.
  const hatch = rng.pick([0xb33a32, 0x2f6b4f, 0x3a5f8a, 0x8a6a2f]);
  const laker = kind === 'laker';
  for (let k = 0; k < 5; k++) {
    const x = laker ? -1.45 + k * 0.78 : -1.25 + k * 0.82;
    root.add(box(0.66, 0.08, beam * 0.7, 0x8e959c, x, deck, 0));
    root.add(box(0.62, 0.05, beam * 0.64, hatch, x, deck + 0.08, 0));
    if (kind === 'gearless') {
      // Side-rolling covers: two halves meeting on the centre line.
      root.add(box(0.62, 0.012, 0.02, 0x26282b, x, deck + 0.13, 0));
      for (const s of [-1, 1])
        root.add(box(0.7, 0.02, 0.03, 0x26282b, x, deck + 0.08, s * beam * 0.36));
    } else root.add(box(0.62, 0.012, 0.02, 0x26282b, x, deck + 0.13, 0));
    if (k < 4 && kind === 'geared') {
      const cx = x + 0.41;
      root.add(cyl(0.035, 0.3, white, cx, deck, beam * 0.3, 8));
      const jib = box(0.42, 0.025, 0.025, white, cx + 0.15, deck + 0.3, beam * 0.3);
      jib.rotation.z = 0.35;
      root.add(jib);
    }
  }
  if (kind === 'gearless') {
    root.add(cyl(0.016, 0.55, C.chassis, 2.45, deck + 0.12));
    root.add(lamp(LIGHT.white, 0.035, 2.45, deck + 0.7, 0));
  }
  if (kind === 'selfunloader') {
    // The unloading boom along the deck, beside the hatches, from its
    // A-frame aft to a crutch forward.
    const z = beam * 0.4;
    const boom = rng.pick([0xd9822b, 0xf2c230, 0xe3e1d8, C.chassis]);
    root.add(spar(3.7, 0.07, boom, [-1.86, deck + 0.42, z], -0.06));
    for (const s of [-1, 1]) {
      const leg = box(0.04, 0.5, 0.04, C.chassis, -1.86, deck, z + s * 0.08);
      root.add(leg);
    }
    root.add(box(0.04, 0.16, 0.04, C.chassis, 1.7, deck, z));
  }
  let y = deck;
  if (laker) {
    // The pilothouse right forward on the forecastle, the engine and the
    // crew's quarters aft under a short funnel.
    y += 0.12;
    root.add(box(0.3, 0.12, beam * 0.86, paint, 2.15, deck, 0));
    cabin(root, 2.3, y, 0.34, beam * 0.62, 0.17, white, white, false);
    y += 0.19;
    cabin(root, 2.3, y, 0.28, beam * 0.58, 0.17, white, accent, 'mast');
    y += 0.19;
    root.add(box(0.14, 0.025, beam * 0.9, white, 2.36, y - 0.05, 0));
    sidelights(root, 2.36, y - 0.025 + 0.04, beam * 0.45, 0.08);
    for (let k = 0; k < 2; k++)
      cabin(root, -2.28, deck + k * 0.19, 0.5 - k * 0.04, beam * 0.84, 0.17, white, white, false);
    root.add(box(0.2, 0.3, 0.22, accent, -2.42, deck + 0.38, 0));
    root.add(box(0.205, 0.05, 0.225, C.chassis, -2.42, deck + 0.68, 0));
    return { root, crates: [], owned };
  }
  // The bridge right aft, four decks over the holds.
  for (let k = 0; k < 4; k++) {
    cabin(
      root,
      -2.28,
      y,
      0.5 - k * 0.03,
      beam * (0.86 - k * 0.04),
      0.17,
      white,
      k === 3 ? accent : white,
      k === 3 && 'mast',
    );
    y += 0.19;
  }
  root.add(box(0.14, 0.025, beam + 0.06, white, -2.16, y - 0.05, 0));
  sidelights(root, -2.16, y - 0.025 + 0.04, beam / 2 + 0.03, 0.08);
  root.add(box(0.2, 0.32, 0.22, accent, -2.5, deck + 0.7, 0));
  root.add(box(0.205, 0.05, 0.225, C.chassis, -2.5, deck + 1.0, 0));
  return { root, crates: [], owned };
}
