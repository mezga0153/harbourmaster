// Messages between the main thread and the sim worker. See plan.md §11, Threads.

import type { DebugView, DebugWant } from '../debug/types';
import type { MapData } from '../sim/map';
import type { SaveData } from '../sim/state';
import type { BuildKind, MachineKind, StoreKind } from '../sim/types';
import type { Snapshot } from './views';

export type Command =
  | { type: 'build'; kind: BuildKind; tiles: number[]; facing?: number }
  | { type: 'bulldoze'; tiles: number[] }
  /** Mark port road and quay tiles for port machines only, or clear the mark. */
  | { type: 'forkliftOnly'; tiles: number[]; on: boolean }
  /** Clear storage and machines-only marks, wherever they can be. */
  | { type: 'unmark'; tiles: number[] }
  /** Mark port road and quay tiles out as storage, or clear them. */
  | { type: 'store'; tiles: number[]; kind: StoreKind; on: boolean }
  /** Stop a storage area (by its first tile) taking any more cargo, so it empties out, or open it again. */
  | { type: 'shutStore'; idx: number; shut: boolean }
  /** A ship taking exports on board sails now with those it has. */
  | { type: 'sailNow'; id: number }
  /** Open an exit off the highway at row `row`, with a road off it. */
  | { type: 'exit'; row: number }
  /** Make road tiles one way, the way the drag ran along them; or (`on` false) two way again. */
  | { type: 'oneWay'; tiles: number[]; on: boolean }
  /** Put up traffic lights at a junction, or take them down. */
  | { type: 'lights'; tile: number }
  /** Let trucks through a port gate both ways, only in, or only out. */
  | { type: 'gateWay'; tile: number; way: 'both' | 'in' | 'out' }
  /** A roundabout: a ring of one-way road round an island at `tile`. */
  | { type: 'roundabout'; tile: number }
  /** Dredge (dig the seabed deeper, or the shore out into sea) or reclaim (fill it in). */
  | { type: 'terraform'; tiles: number[]; raise: boolean }
  /** Buy plot `plot` of the port's land (see land.ts), beside land it owns. */
  | { type: 'buyPlot'; plot: number }
  | { type: 'hire'; candidateId: number }
  | { type: 'fire'; id: number }
  | { type: 'loan'; amount: number }
  | { type: 'upgrade' }
  | { type: 'buyMachine'; kind: MachineKind; tile?: number }
  /** A harbour tug, at the tug berth at `tile` or any free one. */
  | { type: 'buyTug'; tile?: number }
  | { type: 'raise'; id: number; accept: boolean }
  | { type: 'signContract'; id: number }
  | { type: 'cancelContract'; id: number }
  | { type: 'setSpeed'; speed: number }
  /** The player has found out for themselves what this advisor tip would teach them. */
  | { type: 'learnt'; tip: string }
  /** Carry on from the game saved in this browser (a new port if there is none): the title screen's pick. */
  | { type: 'continue' }
  | { type: 'newGame'; seed?: number }
  | { type: 'save' }
  /**
   * The game as a save, for the player to keep in a file, or (forReport) to
   * send with a bug report; answered with `exported`.
   */
  | { type: 'exportSave'; forReport?: boolean }
  /** Carry on from a save the player picked from a file, if it is one this version can read. */
  | { type: 'importSave'; save: unknown; name: string }
  /** Dev server only: jump ahead for testing. */
  | {
      type: 'debug';
      cash?: number;
      tier?: number;
      coaster?: boolean;
      containers?: boolean;
      /** People wanting to live in town. */
      town?: number;
      /** Send the next train now. */
      train?: boolean;
    }
  /** Dev server only: post the whole game state back, for the debug bridge. */
  | { type: 'dumpSave' }
  /** Dev server only: carry on from this game instead, from the debug bridge. */
  | { type: 'loadSave'; save: SaveData }
  /** Dev server only: what the debug overlays show, sent back each frame; null stops it. */
  | { type: 'debugView'; want: DebugWant | null };

export type SimEvent =
  | { kind: 'message'; text: string; tone: 'info' | 'good' | 'bad' }
  | { kind: 'money'; amount: number; x: number; y: number }
  /** Something the advisor explains, the first time it matters. */
  | { kind: 'tip'; id: string };

export interface TileChange {
  i: number;
  terrain: number;
  depth: number;
  ocean: number;
  build: number;
  orient: number;
  deco: number;
  store: number;
}

export type WorkerMessage =
  | { type: 'init'; map: MapData; seed: number }
  | {
      type: 'frame';
      snapshot: Snapshot;
      tiles: TileChange[];
      events: SimEvent[];
      /** The port's plots, owned or not, and how many bought: only when that changes. */
      plots?: { plots: number[]; bought: number };
    }
  /** Dev server only: the game as a save, for the debug bridge. */
  | { type: 'dump'; save: SaveData }
  /** Dev server only: what the debug overlays asked for; see src/debug/. */
  | { type: 'debugView'; view: DebugView }
  /** The game as a save, to keep in a file; see exportSave. */
  | { type: 'exported'; save: SaveData; forReport?: boolean }
  /** What the game saved in this browser holds, for the title screen; null if there is none. */
  | { type: 'autosave'; save: { seed: number; tick: number; cash: number; tier: number } | null }
  /** A pick on the title screen that could not start a game (a save file it cannot read), and why. */
  | { type: 'refused'; text: string }
  /** Something went wrong in the worker, for the play log's error reports (src/log/errors.ts). */
  | { type: 'fault'; kind: 'sim' | 'save' | 'autosave'; message: string; stack?: string };
