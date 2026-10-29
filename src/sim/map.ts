import { FORKLIFT_ONLY } from './rules';
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
  entry: number;
  /** Rows the player may build on; older saves have none past them. */
  limit?: number;
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
  /** Road tile on the map edge where trucks enter and leave. */
  entry = 0;

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
      entry: this.entry,
      limit: this.limit,
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
