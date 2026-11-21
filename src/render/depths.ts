import {
  BufferGeometry,
  CanvasTexture,
  DataTexture,
  Float32BufferAttribute,
  LinearFilter,
  Mesh,
  NearestFilter,
  RGBAFormat,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
} from 'three';
import type { GameMap } from '../sim/map';
import { Build, Terrain } from '../sim/types';

// The sea's depth written on every tile of open water, while a tool that
// digs, fills or builds out into the sea is in hand. One plane over the
// whole map: a texture of the tiles says which depth each shows, and the
// shader writes that depth from an atlas of all of them in the middle of
// the tile, turned to face the camera and stood up against its tilt, so it
// reads as flat text on the screen. Zoomed out too far to read, the numbers
// fade and only the tint of water too deep to build in stays.

/** Depths are kept to a tenth of a metre; the atlas has every one up to this. */
const MOST = 24;
const LABELS = MOST * 10 + 1;
const COLS = 16;
const CELL_W = 128;
const CELL_H = 64;
/** Just over the water, under anything floating on it. */
const Y = 0.02;
/** How wide a number is across the screen, in tiles. */
const WIDE = 1.05;

/** How a depth reads: a tenth of a metre under 10 m, whole metres (rounded down) from there. */
export function depthText(d: number): string {
  return d < 10 ? d.toFixed(1) : String(Math.floor(d));
}

let atlas: CanvasTexture | null = null;

/** Every depth there is, drawn once: white figures outlined in black, a cell each. */
function makeAtlas(): CanvasTexture | null {
  if (atlas) return atlas;
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = COLS * CELL_W;
  cv.height = Math.ceil(LABELS / COLS) * CELL_H;
  const g = cv.getContext('2d');
  if (!g) return null;
  g.font = 'bold 58px "Arial Narrow", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = 9;
  g.strokeStyle = '#000';
  g.fillStyle = '#fff';
  for (let k = 0; k < LABELS; k++) {
    const text = depthText(k / 10);
    const x = (k % COLS) * CELL_W + CELL_W / 2;
    const y = Math.floor(k / COLS) * CELL_H + CELL_H / 2 + 3;
    g.strokeText(text, x, y);
    g.fillText(text, x, y);
  }
  atlas = new CanvasTexture(cv);
  atlas.generateMipmaps = false;
  atlas.minFilter = LinearFilter;
  atlas.magFilter = LinearFilter;
  return atlas;
}

const vertex = /* glsl */ `
  varying vec2 vTile;
  void main() {
    vTile = position.xz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragment = /* glsl */ `
  uniform sampler2D uTiles; // r: the depth in tenths of a metre, a: shown
  uniform sampler2D uAtlas;
  uniform vec2 uSize;
  uniform vec2 uRight; // across the screen, on the ground
  uniform vec2 uUp; // up the screen, on the ground
  uniform float uSquash; // how short a tile's length up the screen looks
  uniform float uDeep; // deeper than this, the tool cannot build: in red
  uniform float uBottom; // this deep or more, it cannot dig further: in grey
  uniform float uPixelRatio; // device pixels to the CSS pixel
  varying vec2 vTile;
  const float COLS = ${COLS}.0;
  const float ROWS = ${Math.ceil(LABELS / COLS)}.0;
  void main() {
    vec2 cell = floor(vTile);
    vec4 t = texture2D(uTiles, (cell + 0.5) / uSize);
    if (t.a < 0.5) discard;
    float k = floor(t.r * 255.0 + 0.5);
    float depth = k / 10.0;
    // How big a tile is on the screen: the numbers only once they can be read.
    vec2 dx = dFdx(vTile);
    vec2 dy = dFdy(vTile);
    float px = inversesqrt(max(abs(dx.x * dy.y - dx.y * dy.x), 1e-8)) / uPixelRatio;
    float readable = smoothstep(18.0, 24.0, px);
    vec2 f = fract(vTile) - 0.5;
    // The number's own square, facing the camera.
    vec2 q = vec2(dot(f, uRight), dot(f, uUp) * uSquash);
    vec2 a = vec2(q.x / ${WIDE} + 0.5, 0.5 - q.y / ${WIDE / 2});
    vec4 glyph = vec4(0.0);
    if (a.x > 0.0 && a.x < 1.0 && a.y > 0.0 && a.y < 1.0) {
      vec2 at = vec2(mod(k, COLS), floor(k / COLS));
      glyph = texture2D(uAtlas, vec2((at.x + a.x) / COLS, 1.0 - (at.y + a.y) / ROWS));
    }
    vec3 ink = depth > uDeep ? vec3(1.0, 0.45, 0.4) : depth >= uBottom ? vec3(0.62, 0.66, 0.7) : vec3(1.0);
    // Faint lines between the tiles, to see which number is whose.
    vec2 edge = 0.5 - abs(f);
    float line = (1.0 - smoothstep(0.0, 1.5 / px, min(edge.x, edge.y))) * 0.16 * readable;
    vec4 c = vec4(vec3(1.0), line);
    if (depth > uDeep) c = mix(c, vec4(1.0, 0.3, 0.25, 0.13), 1.0 - line);
    float ga = glyph.a * readable;
    c.rgb = mix(c.rgb, ink * glyph.r, ga);
    c.a = ga + c.a * (1.0 - ga);
    if (c.a < 0.01) discard;
    gl_FragColor = c;
  }
`;

/** What the tool in hand wants to know of the sea's depth. */
export interface DepthMode {
  /** Deeper than this the tool cannot build: those tiles shown in red. */
  deep?: number;
  /** This deep or more it cannot dig any further: shown in grey. */
  bottom?: number;
}

/** The depth of every tile of open water, written on it. */
export class DepthLabels {
  readonly mesh: Mesh;
  private material: ShaderMaterial;
  private tiles: DataTexture | null = null;

  constructor() {
    this.material = new ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTiles: { value: null },
        uAtlas: { value: null },
        uSize: { value: new Vector2(1, 1) },
        uRight: { value: new Vector2(1, 0) },
        uUp: { value: new Vector2(0, -1) },
        uSquash: { value: 0.577 },
        uDeep: { value: 1e3 },
        uBottom: { value: 1e3 },
        uPixelRatio: { value: 1 },
      },
    });
    this.mesh = new Mesh(new BufferGeometry(), this.material);
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    const u = this.material.uniforms;
    // Turned to the camera as it is drawn, whichever way the view has swung.
    this.mesh.onBeforeRender = (r, _s, camera) => {
      u.uPixelRatio.value = r.getPixelRatio();
      const e = camera.matrixWorld.elements;
      const rl = Math.hypot(e[0], e[2]) || 1;
      (u.uRight.value as Vector2).set(e[0] / rl, e[2] / rl);
      // The camera looks along -z: up the screen is that way on the ground.
      const ul = Math.hypot(e[8], e[10]) || 1;
      const ux = -e[8] / ul;
      const uz = -e[10] / ul;
      (u.uUp.value as Vector2).set(ux, uz);
      u.uSquash.value = Math.max(0.2, Math.abs(e[4] * ux + e[6] * uz));
    };
  }

  /** Shown over `map` as `mode` asks, or hidden with null. */
  set(map: GameMap | null, mode: DepthMode | null): void {
    const atlasTex = makeAtlas();
    if (!map || !mode || !atlasTex) {
      this.mesh.visible = false;
      return;
    }
    const { w, h } = map;
    if (!this.tiles || this.tiles.image.width !== w || this.tiles.image.height !== h) {
      this.tiles?.dispose();
      this.tiles = new DataTexture(new Uint8Array(w * h * 4), w, h, RGBAFormat, UnsignedByteType);
      this.tiles.magFilter = this.tiles.minFilter = NearestFilter;
      const geo = new BufferGeometry();
      geo.setAttribute(
        'position',
        new Float32BufferAttribute([0, Y, 0, 0, Y, h, w, Y, h, 0, Y, 0, w, Y, h, w, Y, 0], 3),
      );
      this.mesh.geometry.dispose();
      this.mesh.geometry = geo;
    }
    const data = this.tiles.image.data as Uint8Array;
    for (let i = 0; i < w * h; i++) {
      const open = map.terrain[i] === Terrain.Water && map.build[i] === Build.None;
      data[i * 4] = open ? Math.min(LABELS - 1, Math.round(map.depth[i] * 10)) : 0;
      data[i * 4 + 3] = open ? 255 : 0;
    }
    this.tiles.needsUpdate = true;
    const u = this.material.uniforms;
    u.uTiles.value = this.tiles;
    u.uAtlas.value = atlasTex;
    (u.uSize.value as Vector2).set(w, h);
    u.uDeep.value = mode.deep ?? 1e3;
    u.uBottom.value = mode.bottom ?? 1e3;
    this.mesh.visible = true;
  }
}
