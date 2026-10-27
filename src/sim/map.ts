import { Build, Terrain } from './types';

export interface MapData {
  w: number;
  h: number;
  terrain: number[];
  depth: number[];
  ocean: number[];
  deco: number[];
  build: number[];
  entry: number;
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
  /** Road tile on the map edge where trucks enter and leave. */
  entry = 0;

  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    const n = w * h;
    this.terrain = new Uint8Array(n);
    this.depth = new Float32Array(n);
    this.ocean = new Uint8Array(n);
    this.deco = new Uint8Array(n);
    this.build = new Uint8Array(n);
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
      entry: this.entry,
    };
  }

  static fromData(d: MapData): GameMap {
    const m = new GameMap(d.w, d.h);
    m.terrain.set(d.terrain);
    m.depth.set(d.depth);
    m.ocean.set(d.ocean);
    m.deco.set(d.deco);
    m.build.set(d.build);
    m.entry = d.entry;
    return m;
  }
}
