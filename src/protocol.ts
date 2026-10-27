// Messages between the main thread and the sim worker. See plan.md §11, Threads.

import type { Terms } from './sim/contracts';
import type { MapData } from './sim/map';
import type { BuildKind } from './sim/types';

export type Command =
  | { type: 'build'; kind: BuildKind; tiles: number[] }
  | { type: 'bulldoze'; tiles: number[] }
  | { type: 'hire' }
  | { type: 'fire'; id: number }
  | { type: 'signContract'; id: number }
  | { type: 'cancelContract'; id: number }
  | { type: 'setSpeed'; speed: number }
  | { type: 'newGame'; seed?: number }
  | { type: 'save' };

export type EntityKind = 'dockhand' | 'boat' | 'truck';

export interface EntityView {
  id: number;
  kind: EntityKind;
  /** Tile-space position; tile (x, y) has its centre at (x + 0.5, y + 0.5). */
  x: number;
  y: number;
  /** Heading in radians, atan2(dy, dx) in tile space. */
  dir: number;
  /** Crates carried. */
  load: number;
  moving: boolean;
  name: string;
  activity: string;
  /** Per-entity paint colour index (trucks, boats). */
  variant: number;
  /** Most crates it can hold. */
  capacity: number;
}

export interface ContractView {
  id: number;
  terms: Terms;
  satisfaction: number;
  /** What it costs you to end this contract. */
  cancelFee: number;
  /** Boats or trucks of this company currently at the port. */
  active: number;
}

export interface OfferView {
  id: number;
  terms: Terms;
  signingFee: number;
  expiresIn: number;
}

export interface BayView {
  idx: number;
  stock: number;
  noAccess: boolean;
}

export interface Stats {
  cratesHandled: number;
  boats: number;
  trucks: number;
  earned: number;
  /** Demurrage, breach penalties and contract buyouts paid. */
  penalties: number;
}

export interface Snapshot {
  tick: number;
  cash: number;
  speed: number;
  seed: number;
  staff: number;
  wages: number;
  /** Daily haulier fees. */
  contractFees: number;
  /** Consecutive days ended in the red; bankrupt at BANKRUPT_DAYS. */
  daysInRed: number;
  bankrupt: boolean;
  stats: Stats;
  entities: EntityView[];
  bays: BayView[];
  contracts: ContractView[];
  offers: OfferView[];
}

export type SimEvent =
  | { kind: 'message'; text: string; tone: 'info' | 'good' | 'bad' }
  | { kind: 'money'; amount: number; x: number; y: number };

export interface TileChange {
  i: number;
  terrain: number;
  build: number;
  deco: number;
}

export type WorkerMessage =
  | { type: 'init'; map: MapData; seed: number }
  | { type: 'frame'; snapshot: Snapshot; tiles: TileChange[]; events: SimEvent[] };
