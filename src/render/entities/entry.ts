import type { Box3, Object3D, Vector3 } from 'three';
import type { EntityView } from '../../protocol';
import type { GameMap } from '../../sim/map';
import { reachTo } from '../machines';
import type { Model } from '../model';
import type { About, Pose } from '../motion';
import type { ForkPlan } from './forks';
import type { Point } from './grid';
import { surfaceY } from '../terrain';
import type { Wash } from '../wakes';

// What Entities keeps for each thing drawn, from one frame to the next,
// beside the view the sim last gave of it.

export interface Entry extends Wash {
  view: EntityView;
  model: Model;
  alert: Object3D | null;
  /** Trucks: how far the body reaches each way from its middle, as it faces +x. */
  size?: Box3;
  /** Dockhands: the truck they are going round, and along which side of it. */
  round?: { truck: number; side: number };
  /** Boats: how far they lean; the wake they lay and the water they stir are in Wash. */
  heel?: number;
  /** Articulated trucks: where each trailer's axles and its fifth wheel were last frame. */
  links?: { axle?: [number, number]; hitch?: [number, number] }[];
  /** A dockhand's hands: how far down to the ground, 0 to 1. */
  down?: number;
  /**
   * How far right of the middle of their way, and ahead, they are drawn,
   * clear of trucks and crates: forklifts, both; dockhands, how far right.
   */
  keep?: [number, number];
  /** Forklifts turning about: where from, which way to, see turnAbout. */
  about?: About;
  /** Forklifts: how far off their way they were when they turned off it part way round. */
  slip?: { x: number; y: number; yaw: number; left: number };
  /**
   * Machines driving into where they park in their depot, from where they
   * were (`in`), or out of it onto their way.
   */
  dock?: { in: boolean; from: Pose; to?: Pose; start: number; out?: number };
  /** Stackers and tractors: how they stood last frame, and the container they are handing over. */
  pose?: Pose;
  hand?: Hand;
  /** Boats and crate trucks: the order their crates go on, see slotOf; and where that was worked out. */
  order?: number[];
  orderAt?: 'bay' | 'quay';
  /** Dockhands: walking up to a load they handle, or back onto their way. */
  stepping?: boolean;
  /**
   * Dockhands and forklifts: the way the view has them going, from where
   * they are drawn by the corners they go by, as last worked out (see
   * Entities.plannedPath), for a debug overlay.
   */
  route?: Point[];
  /** Dockhands: corners they go by round crates to where they make for, where that was, and the grid's stamp then. */
  detour?: { to: Point; via: Point[]; stamp: number };
}

/** A reach stacker or tractor taking a container off where it is, or setting one down. */
export interface Hand {
  stage: 'pick' | 'drop';
  /** How far through it was when first shown, and how it stood. */
  start?: number;
  from: Pose;
  /** Which way it faces to work the container. */
  face?: number;
  /** A tractor under a yard gantry: its container, on the map, which it turns about. */
  pivot?: { x: number; z: number };
  /** Game time the container changed hands, as it goes back to driving. */
  done?: number;
  /**
   * Where it works it, once known: kept for the whole of it, so it does not
   * jump when another load comes or goes there meanwhile.
   */
  goal?: Pose;
  /** Dockhands: how much of it they spend walking up to it. */
  walk?: number;
  /** A dockhand: where the crate they set down goes, or the one they take up lay. */
  place?: Vector3;
  /** Dockhands: how far through it they are. */
  at?: number;
  /** Setting down a crate just taken up: where it lay. */
  taken?: Vector3;
  /** Taking a crate off a boat or truck: in their hands as it changes hands, never on its way. */
  early?: boolean;
  /** Dockhands: corners of a truck they walk round on the way. */
  via?: { x: number; z: number }[];
  /** Forklifts: where they line up and drive in to work it; see forkPlan. */
  plan?: ForkPlan;
  /** Forklifts going straight on from the load before: where they worked it, to back out of first. */
  last?: ForkPlan;
}

/** Stand `e` in `pose`: on the ground there, facing its way, a stacker's boom to its height. */
export function place(map: GameMap, e: Entry, pose: Pose): void {
  e.pose = pose;
  const root = e.model.root;
  root.position.set(pose.x, surfaceY(map, pose.x, pose.z), pose.z);
  root.rotation.y = -pose.dir;
  if (e.model.reach) reachTo(e.model.reach, pose.h);
}
