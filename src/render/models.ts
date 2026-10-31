import type { Cargo } from '../sim/cargo';
import {
  BoxGeometry,
  CanvasTexture,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  type Material,
  SRGBColorSpace,
  type BufferGeometry,
  type Object3D,
} from 'three';
import { hash01 } from '../sim/noise';
import { BOX_HEIGHT, BOX_LENGTH, BOX_WIDTH, CONTAINERS, instance } from './assets';
import { C } from './palette';
import { box, mat } from './parts';
import type { Model } from './model';
import { headingOf } from './util/math';

// Containers and crates, what is painted on them, and the marker over
// what needs attention. The models that carry them are in model.ts.

export { headingOf };

/** The crates on a pallet, as a forklift carries them and storage keeps them, two by two. */
export const PALLET_CRATE = 0.15;

/**
 * Paints a container can come in, as [column, row] of a shaded swatch in
 * Kenney's colour map: 32 px columns, 128 px rows from the first colour row.
 */
const PAINTS: [number, number][] = [
  [11, 0], // red
  [13, 0], // blue
  [5, 0], // green
  [7, 0], // yellow
  [9, 0], // orange
  [15, 0], // sky blue
  [11, 1], // white
  [5, 1], // grey
  [3, 1], // charcoal
  [13, 1], // rust
  [15, 1], // brown
];
const FALLBACK_PAINTS = [C.funnel, C.sign, C.stripe, C.cabin, C.chassis];
const painted = new Map<number, BufferGeometry>();

/**
 * Kenney's red container with its body moved to another swatch of the colour
 * map. The frame and doors keep their own colour.
 */
function paintedBox(source: BufferGeometry, paint: number): BufferGeometry {
  let geo = painted.get(paint);
  if (geo) return geo;
  geo = source.clone();
  const uv = geo.getAttribute('uv');
  const [col, row] = PAINTS[paint];
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i) * 512;
    const v = uv.getY(i) * 512;
    // The body samples the red swatch, x 352–384 px of the first colour row.
    if (u >= 352 && u < 384 && v >= 256 && v < 384) {
      uv.setXY(i, (u + (col - 11) * 32) / 512, (v + row * 128) / 512);
    }
  }
  painted.set(paint, geo);
  return geo;
}

/** A shipping container, lying along X with its base at y=0, in a random paint. */
export function container(seed: number, x = 0, y = 0, z = 0): Object3D {
  const pick = hash01(seed, 7, 13);
  const kenney = instance(CONTAINERS[0]);
  const g = new Group();
  if (kenney) {
    const paint = Math.floor(pick * PAINTS.length);
    kenney.root.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      // Kept to repaint it by (see paintContainer).
      mesh.userData.base = mesh.geometry;
      mesh.geometry = paintedBox(mesh.geometry, paint);
    });
    g.add(kenney.root);
  } else {
    const color = FALLBACK_PAINTS[Math.floor(pick * FALLBACK_PAINTS.length)];
    g.add(box(BOX_LENGTH, BOX_HEIGHT, BOX_WIDTH, color));
  }
  g.position.set(x, y, z);
  return g;
}

/**
 * Repaint a container for how it looks (the sim's boxLook), so it keeps its
 * colours as it goes from ship to crane, stacker, yard and truck.
 */
export function paintContainer(box: Object3D, look: number): void {
  if (box.userData.look === look) return;
  box.userData.look = look;
  const pick = hash01(look, 7, 13);
  box.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    if (mesh.userData.base) {
      mesh.geometry = paintedBox(mesh.userData.base, Math.floor(pick * PAINTS.length));
    } else {
      mesh.material = mat(FALLBACK_PAINTS[Math.floor(pick * FALLBACK_PAINTS.length)]);
    }
  });
}

/** Repaint the containers a model carries, in load order. */
export function paintLoad(model: Model, looks: number[]): void {
  model.crates.forEach((c, k) => {
    if (k < looks.length) paintContainer(c, looks[k]);
  });
}

/**
 * What a crate holds, as painted on its sides; goods as yet a plain crate,
 * each kind to have its own picture.
 */
const CRATE_ICONS: Cargo[] = ['fish', 'ice', 'lobster', 'canned', 'timber'];
/** Per picture, the materials of a box's six faces: on the four sides, none top and bottom. */
let iconMats: Partial<Record<Cargo, Material[]>> | null | undefined;
const iconBand = new BoxGeometry(1, 1, 1);
const none = new MeshBasicMaterial({ visible: false });

/** A little picture of each, drawn once; none where there is nothing to draw on, as in tests. */
function iconMaterials(): Partial<Record<Cargo, Material[]>> | null {
  if (iconMats !== undefined) return iconMats;
  if (typeof document === 'undefined') return (iconMats = null);
  iconMats = {};
  for (const name of CRATE_ICONS) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    drawIcon(cv.getContext('2d')!, name);
    const tex = new CanvasTexture(cv);
    tex.colorSpace = SRGBColorSpace;
    const side = new MeshLambertMaterial({ map: tex, transparent: true, alphaTest: 0.4 });
    iconMats[name] = [side, side, none, none, side, side];
  }
  return iconMats;
}

function drawIcon(g: CanvasRenderingContext2D, name: Cargo): void {
  g.lineJoin = 'round';
  g.lineCap = 'round';
  switch (name) {
    case 'fish': {
      // A round, friendly fish: a fat body, a forked tail, a fin on top,
      // a big eye and a little smile, outlined dark to read from afar.
      const ink = '#1d3557';
      g.lineWidth = 4;
      g.strokeStyle = ink;
      // Tail.
      g.fillStyle = '#f4a259';
      g.beginPath();
      g.moveTo(20, 32);
      g.lineTo(5, 17);
      g.quadraticCurveTo(10, 32, 5, 47);
      g.closePath();
      g.fill();
      g.stroke();
      // Fin on top.
      g.beginPath();
      g.moveTo(26, 18);
      g.quadraticCurveTo(36, 6, 46, 18);
      g.closePath();
      g.fill();
      g.stroke();
      // Body.
      g.fillStyle = '#4ea8de';
      g.beginPath();
      g.ellipse(36, 33, 22, 16, 0, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      // Pale belly.
      g.fillStyle = '#a9def9';
      g.beginPath();
      g.ellipse(38, 39, 14, 7, 0, 0, Math.PI * 2);
      g.fill();
      // Big eye with a shine.
      g.fillStyle = '#fff';
      g.beginPath();
      g.arc(46, 28, 6.5, 0, Math.PI * 2);
      g.fill();
      g.lineWidth = 2;
      g.stroke();
      g.fillStyle = ink;
      g.beginPath();
      g.arc(47.5, 28.5, 3.5, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#fff';
      g.beginPath();
      g.arc(48.5, 27, 1.3, 0, Math.PI * 2);
      g.fill();
      // Smile.
      g.lineWidth = 2.5;
      g.beginPath();
      g.arc(51, 36, 4, Math.PI * 0.1, Math.PI * 0.8);
      g.stroke();
      // A rosy cheek.
      g.fillStyle = '#f7a1b5';
      g.beginPath();
      g.arc(42, 37, 2.5, 0, Math.PI * 2);
      g.fill();
      break;
    }
    case 'ice': {
      // Two chunky ice cubes, one leaning on the other, with a shine and a
      // little happy face on the front one.
      const ink = '#1d3557';
      const cube = (x: number, y: number, w: number, turn: number) => {
        g.save();
        g.translate(x, y);
        g.rotate(turn);
        g.fillStyle = '#dff4ff';
        g.strokeStyle = ink;
        g.lineWidth = 4;
        g.beginPath();
        g.roundRect(-w / 2, -w / 2, w, w, 6);
        g.fill();
        g.stroke();
        g.fillStyle = '#9fd8f5';
        g.beginPath();
        g.roundRect(-w / 2 + 4, w / 2 - 12, w - 8, 8, 3);
        g.fill();
        g.fillStyle = '#fff';
        g.beginPath();
        g.roundRect(-w / 2 + 5, -w / 2 + 5, 6, 12, 3);
        g.fill();
        g.restore();
      };
      cube(22, 26, 24, -0.25);
      cube(40, 38, 30, 0.12);
      // Its face.
      g.fillStyle = ink;
      for (const x of [35, 46]) {
        g.beginPath();
        g.arc(x, 35, 2.4, 0, Math.PI * 2);
        g.fill();
      }
      g.strokeStyle = ink;
      g.lineWidth = 2.5;
      g.beginPath();
      g.arc(40.5, 39, 4, Math.PI * 0.15, Math.PI * 0.85);
      g.stroke();
      g.fillStyle = '#f7a1b5';
      for (const x of [31, 50]) {
        g.beginPath();
        g.arc(x, 40, 2.2, 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
    case 'lobster': {
      // A plump red lobster seen from above: two big claws up front,
      // feelers, a segmented tail fanning out behind, and big eyes.
      const ink = '#5a1414';
      g.strokeStyle = ink;
      g.lineWidth = 3;
      // Feelers.
      g.beginPath();
      g.moveTo(28, 20);
      g.quadraticCurveTo(20, 6, 8, 6);
      g.moveTo(36, 20);
      g.quadraticCurveTo(44, 6, 56, 6);
      g.stroke();
      g.fillStyle = '#e63946';
      g.lineWidth = 3.5;
      // Claws.
      for (const s of [-1, 1]) {
        g.beginPath();
        g.ellipse(32 + s * 17, 22, 8, 10, s * 0.4, 0, Math.PI * 2);
        g.fill();
        g.stroke();
        // The pincer's notch.
        g.beginPath();
        g.moveTo(32 + s * 17, 13);
        g.lineTo(32 + s * 17, 20);
        g.stroke();
      }
      // Tail, three segments and a fan.
      g.beginPath();
      g.moveTo(24, 56);
      g.lineTo(40, 56);
      g.lineTo(36, 50);
      g.lineTo(28, 50);
      g.closePath();
      g.fill();
      g.stroke();
      for (const [y, w] of [
        [44, 12],
        [38, 14],
      ]) {
        g.beginPath();
        g.roundRect(32 - w / 2, y, w, 7, 3);
        g.fill();
        g.stroke();
      }
      // Body.
      g.beginPath();
      g.ellipse(32, 30, 10, 11, 0, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      // Eyes.
      for (const x of [28, 36]) {
        g.fillStyle = '#fff';
        g.beginPath();
        g.arc(x, 26, 3.6, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#222';
        g.beginPath();
        g.arc(x + 0.6, 26.5, 1.9, 0, Math.PI * 2);
        g.fill();
      }
      g.strokeStyle = ink;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(32, 31, 3, Math.PI * 0.15, Math.PI * 0.85);
      g.stroke();
      break;
    }
    case 'canned': {
      // Three tins of fish, two standing and one on top: silver rims and a
      // yellow label with a little blue fish on each.
      const ink = '#1d3557';
      const tin = (x: number, y: number, w: number, h: number) => {
        g.strokeStyle = ink;
        g.lineWidth = 3;
        g.fillStyle = '#c9d2da';
        g.beginPath();
        g.roundRect(x - w / 2, y - h / 2, w, h, 4);
        g.fill();
        g.stroke();
        g.fillStyle = '#f2c230';
        g.fillRect(x - w / 2 + 1.5, y - h / 2 + 5, w - 3, h - 10);
        g.fillStyle = '#2f6fd0';
        g.beginPath();
        g.ellipse(x + 1, y, w * 0.24, h * 0.14, 0, 0, Math.PI * 2);
        g.moveTo(x - w * 0.18, y);
        g.lineTo(x - w * 0.34, y - h * 0.14);
        g.lineTo(x - w * 0.34, y + h * 0.14);
        g.closePath();
        g.fill();
        g.fillStyle = '#fff';
        g.fillRect(x - w / 2 + 3, y - h / 2 + 7, 3, h - 14);
      };
      tin(17, 45, 28, 34);
      tin(47, 45, 28, 34);
      tin(32, 16, 28, 28);
      break;
    }
    case 'timber': {
      // Ends of a stack of logs, three, two and one, each with its rings,
      // and a red strap round them.
      const ink = '#5a3a1c';
      for (const [x, y] of [
        [11, 52],
        [32, 52],
        [53, 52],
        [21.5, 32],
        [42.5, 32],
        [32, 12],
      ]) {
        g.fillStyle = '#e8c48c';
        g.strokeStyle = ink;
        g.lineWidth = 3.5;
        g.beginPath();
        g.arc(x, y, 10, 0, Math.PI * 2);
        g.fill();
        g.stroke();
        g.lineWidth = 1.5;
        g.strokeStyle = '#b07a43';
        g.beginPath();
        g.arc(x, y, 6, 0, Math.PI * 2);
        g.stroke();
        g.fillStyle = '#b07a43';
        g.beginPath();
        g.arc(x, y, 2, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = '#d6453d';
      g.fillRect(2, 41, 60, 4);
      break;
    }
    case 'goods':
      break;
  }
}

/** Paint crate `c` as holding `k`: its picture on its sides, or none. */
export function setCrateIcon(c: Object3D | undefined, k: Cargo | undefined): void {
  if (!c || k === undefined || c.userData.icon === k) return;
  c.userData.icon = k;
  const mats = iconMaterials();
  if (!mats) return;
  for (const d of c.children) {
    if (!d.userData.decal) continue;
    const m = mats[k];
    d.visible = !!m;
    if (m) (d as Mesh).material = m;
  }
}

/**
 * A crate waiting in storage on customs or its export papers shows a slip
 * of paper on its lid under a red seal; one cleared, nothing.
 */
export function setCrateSeal(c: Object3D | undefined, waiting: boolean): void {
  if (!c || !!c.userData.sealed === waiting) return;
  c.userData.sealed = waiting;
  let tag = c.children.find((d) => d.userData.seal);
  if (!tag && waiting) {
    const size = (c.userData.size as number | undefined) ?? 0.3;
    tag = new Group();
    tag.userData.seal = true;
    tag.add(
      box(size * 0.46, size * 0.02, size * 0.34, C.sealPaper, size * 0.1, size, -size * 0.08),
    );
    tag.add(box(size * 0.13, size * 0.035, size * 0.13, C.seal, size * 0.18, size, 0));
    c.add(tag);
  }
  if (tag) tag.visible = waiting;
}

/** Paint each of `crates` as holding what `cargo` says, in order, as far as it says. */
export function paintCargo(crates: Object3D[], cargo: Cargo[] | undefined): void {
  if (!cargo) return;
  crates.forEach((c, k) => {
    if (k < cargo.length) setCrateIcon(c, cargo[k]);
  });
}

export function crate(size: number, x = 0, y = 0, z = 0): Group {
  const g = new Group();
  g.userData.size = size;
  // Body and lid are stacked, not overlapping, so no faces share a plane.
  g.add(box(size, size * 0.82, size, C.crate));
  g.add(box(size * 1.04, size * 0.18, size * 1.04, C.crateLid, 0, size * 0.82));
  // What it holds, painted on its four sides: fish until told otherwise.
  const k: Cargo = 'fish';
  g.userData.icon = k;
  const mats = iconMaterials();
  if (mats) {
    const d = new Mesh(iconBand, mats[k]!);
    d.userData.decal = true;
    d.scale.set(size + 0.004, size * 0.62, size + 0.004);
    d.position.y = size * 0.41;
    g.add(d);
  }
  g.position.set(x, y, z);
  return g;
}

/** Floating warning marker for things that need the player's attention. */
export function alertMarker(): Object3D {
  const g = new Group();
  g.add(box(0.06, 0.16, 0.06, C.funnel, 0, 0.1));
  g.add(box(0.06, 0.06, 0.06, C.funnel, 0, 0));
  return g;
}

/** Show just the containers in these slots on a ship's deck, each looking as given. */
export function showDeck(model: Model, slots: number[], looks: number[]): void {
  const shown = new Set(slots);
  model.crates.forEach((c, k) => (c.visible = shown.has(k)));
  slots.forEach((k, j) => {
    const c = model.crates[k];
    if (c && j < looks.length) paintContainer(c, looks[j]);
  });
}

export function showLoad(model: Model, load: number): void {
  model.crates.forEach((c, k) => (c.visible = k < load));
}
