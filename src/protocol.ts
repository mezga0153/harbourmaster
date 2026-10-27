// Messages between the main thread and the sim worker. See plan.md §11, Threads.

import type { Terms } from './sim/contracts';
import type { MapData } from './sim/map';
import type { Candidate, Trait } from './sim/staff';
import type { BuildKind } from './sim/types';

export type Command =
  | { type: 'build'; kind: BuildKind; tiles: number[] }
  | { type: 'bulldoze'; tiles: number[] }
  | { type: 'hire'; candidateId: number }
  | { type: 'fire'; id: number }
  | { type: 'loan'; amount: number }
  | { type: 'raise'; id: number; accept: boolean }
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

export type LedgerCategory =
  | 'cargo'
  | 'construction'
  | 'hiring'
  | 'wages'
  | 'hauliers'
  | 'contracts'
  | 'penalties'
  | 'interest';

/** Money in (positive) and out (negative) for one day, by category. */
export type Ledger = Record<LedgerCategory, number>;

export interface StaffView {
  id: number;
  name: string;
  skill: number;
  trait: Trait | null;
  wage: number;
  energy: number;
  morale: number;
  activity: string;
  thought: string;
  /** Wage this dockhand is asking for, or 0. */
  raiseAsk: number;
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

/** Crates per day: what the fisheries send versus what the port can move. */
export interface Capacity {
  demand: number;
  unloading: number;
  trucking: number;
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
  people: StaffView[];
  candidates: Candidate[];
  /** Daily haulier fees. */
  contractFees: number;
  loan: number;
  /** Interest charged on the loan at the end of today. */
  interest: number;
  today: Ledger;
  yesterday: Ledger | null;
  /** Consecutive days ended in the red; bankrupt at BANKRUPT_DAYS. */
  daysInRed: number;
  bankrupt: boolean;
  stats: Stats;
  entities: EntityView[];
  bays: BayView[];
  contracts: ContractView[];
  offers: OfferView[];
  capacity: Capacity;
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
