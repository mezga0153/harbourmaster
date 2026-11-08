import type { Group, Object3D } from 'three';
import type { EntityView } from '../protocol';
import { coasterShip, feederShip, fishingBoat, lobsterBoat, tugBoat } from './craft';
import type { Owns } from './keyed';
import { forklift, stacker, tractor, type Reach } from './machines';
import { container, crate } from './models';
import { berthingMaster, customsOfficer, harbourmaster, worker, type Limbs } from './people';
import { truckModel, type Trailer } from './vehicles';

// The one shape every moving thing drawn has: boats and ships (craft.ts),
// trucks (vehicles.ts), dockhands (people.ts) and the port's machines
// (machines.ts) all build a Model, and Entities moves them about. All face
// +X with the root on the ground (the waterline, for a boat) at y=0.

export interface Model extends Owns {
  root: Group;
  /** Crates or containers, one per unit of load, shown as far as it is loaded. */
  crates: Object3D[];
  /** Parts that bob while walking. */
  body?: Object3D;
  /** People: legs and arms that swing as they walk. */
  limbs?: Limbs;
  /** People: what shows, now and then, round the side of the break hut. */
  stream?: Object3D;
  /** People: the Z over their head, dozing on the bench. */
  snore?: Object3D;
  /** Articulated trucks: the trailer, swinging behind the tractor. */
  trailer?: Trailer;
  /** Forklifts: the carriage that runs up and down the mast, with the forks and the load. */
  forks?: Object3D;
  /** Reach stackers: the boom and spreader, see reachTo. */
  reach?: Reach;
}

/** A dock worker, built from their id so everyone looks different. */
export function person(id = 0): Model {
  return worker(id, (size) => crate(size));
}

/** A boat or ship of the given kind, in its company's colours, unique to its id. */
export function boat(variant: number, vessel = 'smack', id = 0, lobster = false): Model {
  switch (vessel) {
    case 'tug':
      return tugBoat(id);
    case 'feeder':
      return feederShip(id, variant, (k, x, y, z) => container(k, x, y, z));
    case 'coaster':
      return coasterShip(id, variant, crate);
    default:
      return lobster ? lobsterBoat(id, variant, crate) : fishingBoat(id, variant, crate);
  }
}

/** A haulier's truck in company colours, unique to its id. */
export function truck(
  variant: number,
  capacity: number,
  boxes = false,
  id = 0,
  pickup = false,
): Model {
  return truckModel(
    id,
    variant,
    capacity,
    boxes,
    crate,
    (k, x, y, z) => container(k, x, y, z),
    pickup,
  );
}

/** The model for an entity as the game describes it. */
export function modelFor(v: EntityView): Model {
  switch (v.kind) {
    case 'dockhand':
      return person(v.id);
    case 'forklift':
      return forklift();
    case 'stacker':
      return stacker();
    case 'tractor':
      return tractor();
    case 'harbourmaster':
      return harbourmaster(v.id);
    case 'customsOfficer':
      return customsOfficer(v.id);
    case 'berthingMaster':
      return berthingMaster(v.id);
    case 'boat':
      return boat(v.variant, v.vessel, v.id, v.catch === 'lobster');
    default:
      return truck(v.variant, v.capacity, v.boxes, v.id, v.pickup);
  }
}
