import {
  AnimationMixer,
  Box3,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  type MeshStandardMaterial,
  Vector3,
  type AnimationAction,
  type AnimationClip,
  type Object3D,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

// Third-party low-poly models (Kenney, CC0). See public/models/kenney/CREDITS.md.

const BASE = `${import.meta.env.BASE_URL}models/kenney/`;

/** A container is 0.6 tiles long, 0.3 wide and 0.24 high (the Kenney model's 2.3 : 1.15 : 0.92). */
export const BOX_LENGTH = 0.6;
export const BOX_WIDTH = 0.3;
export const BOX_HEIGHT = 0.24;

/** How to fit a model into the game: size and which way it faces. */
interface Fit {
  file: string;
  /** Scale so the longest horizontal side is this many tiles… */
  length?: number;
  /** …or so the height is this many tiles. */
  height?: number;
  /** Yaw that turns the model's front towards +X (our models' forward). */
  yaw: number;
  /** Squeeze the width (Z) to at most this, so boats fit their berths. */
  maxBeam?: number;
}

const FIT = {
  'container-a': { file: 'watercraft/cargo-container-a.glb', length: BOX_LENGTH, yaw: Math.PI / 2 },
  'container-b': { file: 'watercraft/cargo-container-b.glb', length: BOX_LENGTH, yaw: Math.PI / 2 },
  'container-c': { file: 'watercraft/cargo-container-c.glb', length: BOX_LENGTH, yaw: Math.PI / 2 },
  truck: { file: 'cars/truck-flat.glb', length: 0.95, yaw: Math.PI / 2 },
  ...Object.fromEntries(
    [
      'tree_default',
      'tree_oak',
      'tree_detailed',
      'tree_fat',
      'tree_pineRoundA',
      'tree_pineRoundC',
      'tree_pineDefaultA',
    ].map((n) => [n, { file: `nature/${n}.glb`, height: 1.15, yaw: 0 }]),
  ),
  ...Object.fromEntries(
    [
      'stone_largeA',
      'stone_largeB',
      'stone_largeC',
      'stone_smallA',
      'stone_smallB',
      'stone_smallC',
    ].map((n) => [n, { file: `nature/${n}.glb`, length: 0.55, yaw: 0 }]),
  ),
} satisfies Record<string, Fit>;

export type AssetName = keyof typeof FIT;

export const TREES = Object.keys(FIT).filter((k) => k.startsWith('tree_')) as AssetName[];
export const CONTAINERS: AssetName[] = ['container-a', 'container-b', 'container-c'];
export const ROCKS = Object.keys(FIT).filter((k) => k.startsWith('stone_')) as AssetName[];

interface Loaded {
  /** Normalised: base on y=0, centred, facing +X, at game scale. */
  template: Group;
  clips: AnimationClip[];
  /** Size after fitting, in tiles. */
  size: Vector3;
}

/** Kenney nature colours retuned to match our grass and rocks. */
const RECOLOUR: Record<string, number> = {
  leafsGreen: 0x4fa65a,
  leafsDark: 0x3a8a4a,
  woodBark: 0x8a5a3a,
  woodBarkDark: 0x6e4a32,
  stone: 0xa4aab0,
};

const loaded = new Map<AssetName, Loaded>();

/** Load every model once. Call before the first map is shown. */
export async function loadAssets(): Promise<void> {
  const loader = new GLTFLoader();
  await Promise.all(
    (Object.entries(FIT) as [AssetName, Fit][]).map(async ([name, fit]) => {
      try {
        const gltf = await loader.loadAsync(BASE + fit.file);
        loaded.set(name, normalise(gltf.scene, gltf.animations, fit));
      } catch (err) {
        // A missing model falls back to the built-in art.
        console.warn(`Could not load ${fit.file}`, err);
      }
    }),
  );
}

function normalise(scene: Object3D, clips: AnimationClip[], fit: Fit): Loaded {
  scene.rotation.y = fit.yaw;
  scene.updateMatrixWorld(true);
  const box = new Box3().setFromObject(scene);
  const size = box.getSize(new Vector3());
  const scale = fit.height ? fit.height / size.y : (fit.length ?? 1) / Math.max(size.x, size.z);
  scene.scale.setScalar(scale);
  scene.updateMatrixWorld(true);
  box.setFromObject(scene);
  const beam = box.max.z - box.min.z;
  if (fit.maxBeam && beam > fit.maxBeam) {
    // After the yaw, the model's local X runs across the boat.
    scene.scale.x *= fit.maxBeam / beam;
    scene.updateMatrixWorld(true);
    box.setFromObject(scene);
  }
  const centre = box.getCenter(new Vector3());
  scene.position.set(-centre.x, -box.min.y, -centre.z);
  scene.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Same lighting model as the rest of the scene; the PBR materials these
    // ship with look dark without an environment map.
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const lambert = mats.map((m) => {
      const std = m as MeshStandardMaterial;
      return new MeshLambertMaterial({
        color: RECOLOUR[std.name] !== undefined ? new Color(RECOLOUR[std.name]) : std.color,
        map: std.map,
        vertexColors: std.vertexColors,
        transparent: std.transparent,
        opacity: std.opacity,
        side: std.side,
      });
    });
    mesh.material = Array.isArray(mesh.material) ? lambert : lambert[0];
  });
  const template = new Group();
  template.add(scene);
  return { template, clips, size: box.getSize(new Vector3()) };
}

export function hasAsset(name: AssetName): boolean {
  return loaded.has(name);
}

export function assetSize(name: AssetName): Vector3 | null {
  return loaded.get(name)?.size ?? null;
}

export interface Instance {
  root: Group;
  mixer: AnimationMixer | null;
  actions: Map<string, AnimationAction>;
}

/** A fresh copy of a model, with its animations ready to play. */
export function instance(name: AssetName): Instance | null {
  const a = loaded.get(name);
  if (!a) return null;
  const root = cloneSkinned(a.template) as Group;
  const actions = new Map<string, AnimationAction>();
  let mixer: AnimationMixer | null = null;
  if (a.clips.length > 0) {
    mixer = new AnimationMixer(root);
    for (const clip of a.clips) actions.set(clip.name, mixer.clipAction(clip));
  }
  return { root, mixer, actions };
}

/** The template itself, for building instanced meshes. Do not modify. */
export function template(name: AssetName): Group | null {
  return loaded.get(name)?.template ?? null;
}

/**
 * Many copies of a static model as instanced meshes, one per part of the
 * model, so thousands of trees or rocks cost a handful of draw calls.
 */
export function instanced(name: AssetName, placements: Matrix4[]): Group | null {
  const t = loaded.get(name)?.template;
  if (!t) return null;
  t.updateMatrixWorld(true);
  const group = new Group();
  const m = new Matrix4();
  t.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const inst = new InstancedMesh(mesh.geometry, mesh.material, Math.max(1, placements.length));
    placements.forEach((place, k) =>
      inst.setMatrixAt(k, m.multiplyMatrices(place, mesh.matrixWorld)),
    );
    inst.count = placements.length;
    inst.castShadow = true;
    inst.receiveShadow = true;
    group.add(inst);
  });
  return group;
}
