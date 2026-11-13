import {
  ACESFilmicToneMapping,
  DirectionalLight,
  Group,
  HemisphereLight,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
  type Object3D,
} from 'three';
import type { Model } from './model';
import type { Limbs } from './people';
import { box } from './parts';
import { clamp01 } from './util/math';

// The town's mayor, built like the port's people (people.ts) out of boxes,
// a little rounder and with a bigger head for the portrait in the corner
// (ui/TownMayor.tsx): a navy tailcoat over a burgundy waistcoat, the gold
// chain of office, spectacles, a white moustache of great ambition and a
// tall top hat. Faces +X, feet at y=0. animateMayor() moves them by mood.

/** How the mayor feels saying it; ui/mayorTalk.ts picks one for each line. */
export type MayorMood = 'cheer' | 'hope' | 'worry' | 'ponder' | 'proud';

export interface MayorModel extends Model {
  body: Object3D;
  limbs: Limbs;
  /** Turns at the neck: nods, shakes and tilts. */
  head: Object3D;
  hat: Object3D;
  /** Scaled down to blink. */
  eyes: Object3D;
  /** Opens and shuts under the moustache. */
  mouth: Object3D;
  browL: Object3D;
  browR: Object3D;
}

const SKIN = 0xf1c59b;
const CHEEK = 0xe99a8a;
const WHITE_HAIR = 0xe6e8ec;
const TAILCOAT = 0x26304f;
const WAISTCOAT = 0x8a2a35;
const SHIRT = 0xf4f4f0;
const TROUSERS = 0x2b2f3a;
const SHOES = 0x1a1a1a;
const GOLD = 0xd9b84a;
const HAT = 0x1b1c22;
const BAND = 0xb8332e;
const FRAME = 0x4a3a2a;
const EYE = 0x1a1a1a;

export function mayor(): MayorModel {
  const root = new Group();
  const body = new Group();
  root.add(body);

  const leg = (z: number) => {
    const hip = new Group();
    hip.position.set(0, 0.15, z);
    hip.add(box(0.058, 0.12, 0.055, TROUSERS, 0, -0.12, 0));
    hip.add(box(0.075, 0.035, 0.06, SHOES, 0.01, -0.15, 0));
    body.add(hip);
    return hip;
  };
  const legL = leg(-0.04);
  const legR = leg(0.04);

  // A round middle: the waistcoat bulging out at the front, the tailcoat
  // open over it with its tails behind, a shirt collar and a bow tie.
  const tw = 0.16;
  body.add(box(0.1, 0.16, tw, TAILCOAT, -0.005, 0.12, 0));
  body.add(box(0.03, 0.12, 0.09, WAISTCOAT, 0.05, 0.135, 0));
  body.add(box(0.02, 0.08, 0.07, WAISTCOAT, 0.07, 0.15, 0));
  for (const y of [0.17, 0.2, 0.23]) body.add(box(0.008, 0.01, 0.01, GOLD, 0.081, y, 0));
  body.add(box(0.03, 0.09, tw * 0.8, TAILCOAT, -0.05, 0.06, 0));
  body.add(box(0.02, 0.03, 0.05, SHIRT, 0.055, 0.255, 0));
  body.add(box(0.012, 0.018, 0.045, BAND, 0.068, 0.262, 0));

  // The chain of office: links over the shoulders and down the front to
  // the medallion.
  const links: [number, number, number][] = [];
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * Math.PI;
    links.push([0.05 + Math.sin(a) * 0.032, 0.268 - Math.sin(a) * 0.07, Math.cos(a) * 0.058]);
  }
  for (const [x, y, z] of links) body.add(box(0.014, 0.012, 0.016, GOLD, x, y, z));
  body.add(box(0.012, 0.036, 0.036, GOLD, 0.086, 0.16, 0));
  body.add(box(0.006, 0.016, 0.016, BAND, 0.093, 0.17, 0));

  // Arms from the shoulders: tailcoat sleeves, white cuffs, hands.
  const arm = (z: number) => {
    const shoulder = new Group();
    shoulder.position.set(0, 0.27, z);
    shoulder.add(box(0.05, 0.1, 0.045, TAILCOAT, 0, -0.1, 0));
    shoulder.add(box(0.052, 0.014, 0.047, SHIRT, 0, -0.112, 0));
    shoulder.add(box(0.04, 0.035, 0.038, SKIN, 0, -0.145, 0));
    body.add(shoulder);
    return shoulder;
  };
  const armL = arm(-(tw / 2 + 0.024));
  const armR = arm(tw / 2 + 0.024);

  // The head turns at the neck.
  const head = new Group();
  head.position.set(0, 0.28, 0);
  body.add(head);
  head.add(box(0.035, 0.02, 0.035, SKIN, 0, 0, 0));
  head.add(box(0.1, 0.1, 0.1, SKIN, 0, 0.015, 0));
  // White hair round the back and over the ears.
  head.add(box(0.05, 0.05, 0.106, WHITE_HAIR, -0.03, 0.05, 0));
  for (const z of [-0.052, 0.052]) head.add(box(0.03, 0.035, 0.008, WHITE_HAIR, -0.01, 0.06, z));
  // Ears.
  for (const z of [-0.053, 0.053]) head.add(box(0.016, 0.022, 0.008, CHEEK, 0.005, 0.05, z));

  // Eyes, which blink, behind round-ish spectacles.
  const eyes = new Group();
  eyes.position.set(0.051, 0.073, 0);
  for (const z of [-0.022, 0.022]) eyes.add(box(0.004, 0.014, 0.01, EYE, 0, -0.007, z));
  head.add(eyes);
  for (const z of [-0.022, 0.022]) {
    head.add(box(0.004, 0.004, 0.028, FRAME, 0.054, 0.086, z));
    head.add(box(0.004, 0.004, 0.028, FRAME, 0.054, 0.058, z));
    head.add(box(0.004, 0.028, 0.004, FRAME, 0.054, 0.06, z - 0.013));
    head.add(box(0.004, 0.028, 0.004, FRAME, 0.054, 0.06, z + 0.013));
  }
  head.add(box(0.004, 0.004, 0.018, FRAME, 0.054, 0.076, 0));
  // Bushy white brows, tilted by mood.
  const brow = (z: number) => {
    const b = new Group();
    b.position.set(0.054, 0.096, z);
    b.add(box(0.008, 0.009, 0.03, WHITE_HAIR, 0, -0.0045, 0));
    head.add(b);
    return b;
  };
  const browL = brow(-0.024);
  const browR = brow(0.024);

  // Nose, rosy cheeks, the mouth and the moustache over it.
  head.add(box(0.022, 0.022, 0.02, CHEEK, 0.058, 0.042, 0));
  for (const z of [-0.036, 0.036]) head.add(box(0.004, 0.014, 0.018, CHEEK, 0.051, 0.035, z));
  const mouth = new Group();
  mouth.position.set(0.051, 0.022, 0);
  mouth.add(box(0.004, 0.012, 0.026, 0x5a1d18, 0, -0.012, 0));
  head.add(mouth);
  head.add(box(0.014, 0.014, 0.05, WHITE_HAIR, 0.058, 0.026, 0));
  for (const side of [-1, 1]) {
    const curl = box(0.012, 0.012, 0.036, WHITE_HAIR, 0.056, 0.032, side * 0.036);
    curl.rotation.x = side * 0.5;
    head.add(curl);
    head.add(box(0.01, 0.014, 0.01, WHITE_HAIR, 0.054, 0.04, side * 0.054));
  }

  // The top hat, its own group so it can be raised.
  const hat = new Group();
  hat.position.set(0, 0.112, 0);
  hat.add(box(0.14, 0.01, 0.14, HAT, 0, 0, 0));
  hat.add(box(0.09, 0.11, 0.09, HAT, 0, 0.008, 0));
  hat.add(box(0.092, 0.02, 0.092, BAND, 0, 0.018, 0));
  hat.rotation.x = -0.08;
  head.add(hat);

  return {
    root,
    crates: [],
    body,
    limbs: { legL, legR, armL, armR },
    head,
    hat,
    eyes,
    mouth,
    browL,
    browR,
  };
}

const smooth = (a: number) => {
  const f = clamp01(a);
  return f * f * (3 - 2 * f);
};

/** In and out over `len` seconds of every `every`: 0, up to 1, held, back to 0. */
function bout(t: number, every: number, len: number, offset = 0): number {
  const k = (t + offset) % every;
  if (k > len) return 0;
  return smooth(Math.min(k, len - k) / Math.min(0.4, len / 2));
}

export interface MayorAct {
  mood: MayorMood;
  /** Saying something just now: the mouth goes, the hands help. */
  talking: boolean;
  /** Waving at the player, with news waiting. */
  wave: boolean;
}

/** The mayor `m` at `t` seconds, doing `act`. */
export function animateMayor(m: MayorModel, act: MayorAct, t: number): void {
  const { body, head, hat, eyes, mouth, browL, browR } = m;
  const { armL, armR, legL, legR } = m.limbs;
  for (const o of [body, head, armL, armR, legL, legR]) o.rotation.set(0, 0, 0);
  hat.position.set(0, 0.112, 0);
  hat.rotation.set(-0.08, 0, 0);
  m.root.position.y = 0;
  body.scale.set(1, 1, 1);

  // Breathing, a look about now and then, and a blink every few seconds.
  body.scale.y = 1 + Math.sin(t * 2.2) * 0.012;
  head.rotation.y = Math.sin(t * 0.45) * 0.12;
  const blink = t % 3.7 < 0.12 || t % 11.3 < 0.1;
  eyes.scale.y = blink ? 0.15 : 1;

  // Brows: the outer end and the inner, lifted (+) or knitted (-).
  const brows: Record<MayorMood, [number, number]> = {
    cheer: [0.006, 0.006],
    proud: [0.003, 0.002],
    hope: [0.002, 0.004],
    worry: [-0.002, 0.007],
    ponder: [0.007, -0.002],
  };
  const [outer, inner] = brows[act.mood];
  browL.position.y = 0.096 + (outer + inner) / 2;
  browR.position.y = 0.096 + (outer + inner) / 2;
  browL.rotation.x = (inner - outer) * 30;
  browR.rotation.x = -(inner - outer) * 30;

  // The mouth: talking, opening and shutting; smiling wide when pleased.
  const pleased = act.mood === 'cheer' || act.mood === 'proud';
  mouth.scale.set(1, act.talking ? 0.4 + Math.abs(Math.sin(t * 13)) * 1.4 : pleased ? 1 : 0.5, 1);
  mouth.scale.z = pleased ? 1.3 : 1;

  if (act.mood === 'cheer') {
    // Both arms up, waving, and a little hop.
    const w = Math.sin(t * 8);
    armL.rotation.x = 2.5 + w * 0.25;
    armR.rotation.x = -2.5 + w * 0.25;
    m.root.position.y = Math.abs(Math.sin(t * 5)) * 0.018;
    head.rotation.z = -0.1;
  } else if (act.mood === 'proud') {
    // Chest out, a hand on the hip, and the hat raised every few seconds.
    body.scale.x = 1.04;
    armL.rotation.x = 0.55;
    armL.rotation.z = -0.35;
    const lift = bout(t, 3.2, 1.6);
    armR.rotation.z = 2.7 * lift;
    armR.rotation.x = -0.35 * lift;
    hat.position.y = 0.112 + 0.05 * lift;
    hat.position.x = 0.02 * lift;
    hat.rotation.z = -0.35 * lift;
    head.rotation.z = -0.08;
  } else if (act.mood === 'worry') {
    // Wringing their hands in front, shaking their head.
    const w = Math.sin(t * 7);
    armL.rotation.z = 1.05 + w * 0.12;
    armR.rotation.z = 1.05 - w * 0.12;
    armL.rotation.x = -0.35;
    armR.rotation.x = 0.35;
    head.rotation.y = Math.sin(t * 3) * 0.28;
    head.rotation.z = 0.08;
    body.rotation.z = 0.04;
  } else if (act.mood === 'ponder') {
    // A hand to the chin, tapping; the head tilted, looking up.
    armR.rotation.z = 1.7 + Math.sin(t * 5) * 0.06;
    armR.rotation.x = 0.55;
    armL.rotation.z = 0.9;
    armL.rotation.x = -0.6;
    head.rotation.x = -0.15;
    head.rotation.z = -0.15;
    head.rotation.y = 0.15;
  } else if (act.talking) {
    // Hopeful, explaining: the right hand making the points.
    armR.rotation.z = 1.1 + Math.sin(t * 3.1) * 0.35;
    armR.rotation.x = -0.25 + Math.sin(t * 1.7) * 0.15;
    armL.rotation.z = 0.3 + Math.sin(t * 2.3 + 1) * 0.15;
  } else {
    // Waiting: now and then a look at the pocket watch.
    const watch = bout(t, 9, 2.6, 4);
    armL.rotation.z = 1.4 * watch;
    armL.rotation.x = -0.5 * watch;
    head.rotation.z += 0.3 * watch;
    head.rotation.y *= 1 - watch;
  }
  if (act.talking) head.rotation.z += Math.sin(t * 6.5) * 0.05;

  // News waiting: a cheery wave at the player over everything else.
  if (act.wave) {
    armR.rotation.z = 0.3;
    armR.rotation.x = -2.6 + Math.sin(t * 9) * 0.35;
    head.rotation.x = -0.1;
  }
}

/**
 * The mayor in the round portrait: a small renderer of its own drawing
 * head and shoulders, animated as long as it is on the page.
 */
export class MayorStage {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderer;
  private scene = new Scene();
  private cam: PerspectiveCamera;
  private model = mayor();
  private act: MayorAct = { mood: 'hope', talking: false, wave: false };
  private frame = 0;
  private last = 0;
  private start = performance.now();

  constructor() {
    this.canvas = document.createElement('canvas');
    this.gl = new WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.gl.outputColorSpace = SRGBColorSpace;
    this.gl.toneMapping = ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.15;
    this.gl.setClearColor(0x000000, 0);
    this.scene.add(new HemisphereLight(0xeaf4ff, 0x8a7f6a, 1.7));
    const sun = new DirectionalLight(0xfff1dc, 2.2);
    sun.position.set(3, 4, 2);
    this.scene.add(sun, this.model.root);
    // Head and shoulders, from a little to the right and above.
    this.cam = new PerspectiveCamera(24, 1, 0.1, 10);
    const yaw = 0.35;
    this.cam.position.set(Math.cos(yaw) * 0.84, 0.41, Math.sin(yaw) * 0.84);
    this.cam.lookAt(0, 0.36, 0);
  }

  /** Draw `px` CSS pixels square. */
  size(px: number): void {
    this.gl.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.gl.setSize(px, px, false);
  }

  set(act: MayorAct): void {
    this.act = act;
  }

  /** Animate, about 30 frames a second, till stopped; nothing while the tab is hidden. */
  play(): void {
    if (this.frame) return;
    const tick = (now: number) => {
      this.frame = requestAnimationFrame(tick);
      if (document.hidden || now - this.last < 32) return;
      this.last = now;
      animateMayor(this.model, this.act, (now - this.start) / 1000);
      this.gl.render(this.scene, this.cam);
    };
    this.frame = requestAnimationFrame(tick);
  }

  stop(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }
}

let stage: MayorStage | null | undefined;

/** The one portrait stage, made on first asking; null where WebGL will not start. */
export function mayorStage(): MayorStage | null {
  if (stage === undefined) {
    try {
      stage = new MayorStage();
    } catch {
      stage = null;
    }
  }
  return stage;
}
