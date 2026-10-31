import { PLOT_SIZE } from './balance';
import { FORKLIFT_ONLY } from './orient';
import { Build, Terrain } from './types';

export interface MapData {
  w: number;
  h: number;
  terrain: number[];
  depth: number[];
  ocean: number[];
  deco: number[];
  build: number[];
  orient: number[];
  /** Older saves have no storage areas. */
  store?: number[];
  entry: number;
  /** Rows the player may build on; older saves have none past them. */
  limit?: number;
  /** 1 for each plot of the port's land the port owns, row by row; older saves have none. */
  plots?: number[];
  /** Plots bought so far, not counting those the port was given. */
  plotsBought?: number;
}

/**
 * Tile grid shared by the sim worker (authoritative) and the main thread
 * (a read-only copy kept in sync through tile diffs).
 */
export class GameMap {
  readonly terrain: Uint8Array;
  /** Water depth in metres, 0 on land. */
  readonly depth: Float32Array;
  /** 1 when the tile is water connected to the open sea. */
  readonly ocean: Uint8Array;
  readonly deco: Uint8Array;
  readonly build: Uint8Array;
  /**
   * Which way a building faces (0 +x, 1 +y, 2 -x, 3 -y), plus EXTENSION on
   * the second tile of a two-tile building.
   */
  readonly orient: Uint8Array;
  /** What a port road or quay tile is marked out to store; see `Store`. */
  readonly store: Uint8Array;
  /** Road tile on the map edge where trucks enter and leave. */
  entry = 0;
  /**
   * The port's land in plots of PLOT_SIZE square, row by row: 1 where the
   * port owns it and may build. All owned unless a new game or a save says
   * otherwise; see land.ts.
   */
  readonly plots: Uint8Array;
  /** Plots bought so far, which sets the price of the next; see land.ts. */
  plotsBought = 0;

  constructor(
    readonly w: number,
    readonly h: number,
    /** Rows from the top that are the port's land; past them is country the player cannot build on. */
    readonly limit = h,
  ) {
    const n = w * h;
    this.terrain = new Uint8Array(n);
    this.depth = new Float32Array(n);
    this.ocean = new Uint8Array(n);
    this.deco = new Uint8Array(n);
    this.build = new Uint8Array(n);
    this.orient = new Uint8Array(n);
    this.store = new Uint8Array(n);
    this.plots = new Uint8Array(this.plotsWide * this.plotsHigh).fill(1);
  }

  /** Plots across the map, and down the port's land. */
  get plotsWide(): number {
    return Math.ceil(this.w / PLOT_SIZE);
  }

  get plotsHigh(): number {
    return Math.ceil(this.limit / PLOT_SIZE);
  }

  /** The plot tile `i` lies in, or -1 past the port's land. */
  plotOf(i: number): number {
    const y = this.yOf(i);
    if (y >= this.limit || i < 0) return -1;
    return Math.floor(y / PLOT_SIZE) * this.plotsWide + Math.floor(this.xOf(i) / PLOT_SIZE);
  }

  /** On land the port owns, where the player may build. */
  owns(i: number): boolean {
    const p = this.plotOf(i);
    return p >= 0 && this.plots[p] === 1;
  }

  idx(x: number, y: number): number {
    return y * this.w + x;
  }

  xOf(i: number): number {
    return i % this.w;
  }

  yOf(i: number): number {
    return Math.floor(i / this.w);
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  /** On the port's land, where the player can build. */
  buildable(i: number): boolean {
    return this.yOf(i) < this.limit;
  }

  isLand(i: number): boolean {
    return this.terrain[i] !== Terrain.Water;
  }

  neighbors4(i: number): number[] {
    const x = this.xOf(i);
    const y = this.yOf(i);
    const out: number[] = [];
    if (x > 0) out.push(i - 1);
    if (x < this.w - 1) out.push(i + 1);
    if (y > 0) out.push(i - this.w);
    if (y < this.h - 1) out.push(i + this.w);
    return out;
  }

  isWalkSurface(i: number): boolean {
    const b = this.build[i];
    return (
      b === Build.Footpath ||
      b === Build.PortRoad ||
      b === Build.Jetty ||
      b === Build.TruckBay ||
      b === Build.LargeBay ||
      b === Build.Road
    );
  }

  toData(): MapData {
    return {
      w: this.w,
      h: this.h,
      terrain: Array.from(this.terrain),
      depth: Array.from(this.depth, (d) => Math.round(d * 10) / 10),
      ocean: Array.from(this.ocean),
      deco: Array.from(this.deco),
      build: Array.from(this.build),
      orient: Array.from(this.orient),
      store: Array.from(this.store),
      entry: this.entry,
      limit: this.limit,
      plots: Array.from(this.plots),
      plotsBought: this.plotsBought,
    };
  }

  static fromData(d: MapData): GameMap {
    const m = new GameMap(d.w, d.h, d.limit ?? d.h);
    m.terrain.set(d.terrain);
    m.depth.set(d.depth);
    m.ocean.set(d.ocean);
    m.deco.set(d.deco);
    m.build.set(d.build);
    m.orient.set(d.orient);
    if (d.store) m.store.set(d.store);
    // Older saves own it all; World.fromSave keeps just what they built on.
    if (d.plots?.length === m.plots.length) m.plots.set(d.plots);
    m.plotsBought = d.plotsBought ?? 0;
    // Old forklift lanes are port roads marked forklift-only.
    for (let i = 0; i < m.build.length; i++) {
      if (m.build[i] === Build.ForkliftLane) {
        m.build[i] = Build.PortRoad;
        m.orient[i] = FORKLIFT_ONLY;
      }
    }
    m.entry = d.entry;
    return m;
  }
}
