import {
  Color,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  Mesh,
  PlaneGeometry,
  RedFormat,
  RepeatWrapping,
  RGBAFormat,
  ShaderMaterial,
  TextureLoader,
  type Texture,
  UnsignedByteType,
  Vector3,
} from 'three';
import type { GameMap } from '../sim/map';
import { C } from './palette';
import { MARGIN } from './terrain';

/** Depth that maps to the darkest blue, in metres. */
const MAX_DEPTH = 16;
/** Subcells per tile in the water field, for smooth shore contours. */
const SUB = 4;
/** Distance from the coast, in tiles, that the shore field spans. */
const SHORE_TILES = 4;

const vertexShader = /* glsl */ `
  varying vec2 vXZ;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vXZ = wp.xz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uField; // r: depth, g: distance to shore (first few tiles)
  uniform sampler2D uDist; // r: distance to the nearest land, in tiles
  uniform sampler2D uNormals; // tileable water normal map
  uniform vec2 uSize;
  uniform float uTime;
  uniform vec3 uShallow;
  uniform vec3 uMid;
  uniform vec3 uDeep;
  uniform vec3 uFoam;
  uniform vec3 uSun;
  uniform vec3 uView;
  varying vec2 vXZ;

  // Slow swell that follows the coastline; only drives the surf.
  const float K_SWELL = 6.28318 / 1.8;
  const float SWELL_SPEED = 1.5;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  // Distance to land. Past the seaward map edge it keeps growing.
  float distAt(vec2 p) {
    return texture2D(uDist, p / uSize).r + max(0.0, p.x - uSize.x);
  }

  // Crests follow the coastline and travel towards it.
  float swellIn(float d) {
    return sin(d * K_SWELL + uTime * SWELL_SPEED);
  }

  // The bounce: a weaker wave running back out from the shore.
  float swellBack(float d) {
    return sin(d * K_SWELL * 1.07 - uTime * SWELL_SPEED + 1.7);
  }

  // The normal-map technique from three.js's Water: four samples of one
  // tileable normal map at different scales, drifting in different
  // directions (mostly towards the coast, to the west). Together they look
  // like many small irregular waves that never visibly repeat.
  vec3 waterNormal(vec2 p) {
    float t = uTime;
    vec2 uv0 = p / 1.7 + vec2(t / 17.0, t / 53.0);
    vec2 uv1 = p / 1.9 + vec2(t / 19.0, -t / 41.0);
    vec2 uv2 = p / vec2(14.0, 16.0) + vec2(t / 101.0, t / 97.0);
    vec2 uv3 = p / vec2(5.5, 6.1) + vec2(t / 109.0, -t / 113.0);
    vec4 n = texture2D(uNormals, uv0) + texture2D(uNormals, uv1) +
      texture2D(uNormals, uv2) + texture2D(uNormals, uv3);
    n = n * 0.5 - 1.0;
    return normalize(n.xzy * vec3(1.5, 1.0, 1.5));
  }

  void main() {
    vec4 field = texture2D(uField, vXZ / uSize);
    float depth = field.r;
    float shore = field.g;
    float d = distAt(vXZ);

    vec3 col = mix(uShallow, uMid, smoothstep(0.0, 0.2, depth));
    col = mix(col, uDeep, smoothstep(0.2, 0.65, depth));

    vec3 n = waterNormal(vXZ);
    col *= 0.78 + 0.34 * max(dot(n, uSun), 0.0);
    // Soft sheen from the sun, and tight bright glints that flicker as the
    // wave layers drift past each other. The glint light sits a little off
    // the mirror direction so only tilted facets catch it.
    float sheen = pow(max(dot(reflect(-uSun, n), uView), 0.0), 40.0);
    vec3 mirror = reflect(-uView, vec3(0.0, 1.0, 0.0));
    vec3 glintLight = normalize(mirror + vec3(0.32, 0.0, 0.22));
    float glint = pow(max(dot(reflect(-glintLight, n), uView), 0.0), 900.0);
    float spec = sheen * 0.18 + glint * 1.6;
    col += vec3(1.0, 0.97, 0.88) * spec;

    // Foam hugging the coast.
    float edge = 1.0 - smoothstep(0.02, 0.07, shore);
    float breakup = noise(vXZ * 3.0 + uTime * 0.4);
    float foam = edge * smoothstep(0.3, 0.65, breakup + edge * 0.45);

    // Surf: the swell turns white in the last stretch before the beach…
    float near = 1.0 - smoothstep(0.15, 0.9, d);
    float breaking = smoothstep(0.75, 1.0, swellIn(d)) * near;
    breaking *= smoothstep(0.35, 0.7, noise(vXZ * 4.0 + uTime * 0.3));
    // …and the backwash leaves a fainter line as it bounces back out.
    float backwash = smoothstep(0.85, 1.0, swellBack(d)) * (1.0 - smoothstep(0.15, 0.9, d)) * 0.45;
    foam = max(foam, max(breaking * 0.9, backwash));

    col = mix(col, uFoam, foam);
    // Clear in the shallows so the seabed shows, nearly opaque out at sea.
    float alpha = mix(0.45, 0.94, smoothstep(0.0, 0.45, depth));
    alpha = max(alpha, foam * 0.9);
    alpha = min(1.0, alpha + spec * 0.5);
    gl_FragColor = vec4(col, alpha);
    #include <colorspace_fragment>
  }
`;

/**
 * Flat stylised sea. Colour comes from a smoothed depth field and foam from
 * a distance-to-shore field, both baked into one texture at SUB× tile size.
 */
export class Water {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;

  constructor(map: GameMap, sunDir: Vector3) {
    const baked = bakeField(map);
    const tex = new DataTexture(
      baked.field,
      map.w * SUB,
      map.h * SUB,
      RGBAFormat,
      UnsignedByteType,
    );
    // Half floats keep the distance smooth enough for clean wave crests.
    const dist = new DataTexture(baked.dist, map.w * SUB, map.h * SUB, RedFormat, HalfFloatType);
    for (const t of [tex, dist]) {
      t.magFilter = LinearFilter;
      t.minFilter = LinearFilter;
      t.needsUpdate = true;
    }

    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uField: { value: tex },
        uDist: { value: dist },
        uNormals: { value: loadNormals() },
        uSize: { value: [map.w, map.h] },
        uTime: { value: 0 },
        uShallow: { value: new Color(C.waterShallow) },
        uMid: { value: new Color(C.waterMid) },
        uDeep: { value: new Color(C.waterDeep) },
        uFoam: { value: new Color(C.foam) },
        uSun: { value: sunDir.clone() },
        uView: { value: new Vector3(0, 1, 0) },
      },
    });

    const size = Math.max(map.w, map.h) + MARGIN * 2 + 400;
    const geo = new PlaneGeometry(size, size);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new Mesh(geo, this.material);
    this.mesh.position.set(map.w / 2, 0, map.h / 2);
  }

  /** `view` points from the water towards the camera. */
  update(time: number, view: Vector3): void {
    this.material.uniforms.uTime.value = time;
    (this.material.uniforms.uView.value as Vector3).copy(view);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.material.uniforms.uField.value as DataTexture).dispose();
    (this.material.uniforms.uDist.value as DataTexture).dispose();
    (this.material.uniforms.uNormals.value as Texture).dispose();
    this.material.dispose();
  }
}

/** The tileable water normal map, see public/textures/CREDITS.md. */
function loadNormals(): Texture {
  const tex = new TextureLoader().load(`${import.meta.env.BASE_URL}textures/waternormals.jpg`);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  return tex;
}

/**
 * field: RGBA bytes, r = smoothed depth, g = distance to shore over the first
 * few tiles. dist: half floats, distance to the nearest land in tiles.
 */
function bakeField(map: GameMap): { field: Uint8Array; dist: Uint16Array } {
  const W = map.w * SUB;
  const H = map.h * SUB;
  const land = new Uint8Array(W * H);
  const depth = new Float32Array(W * H);

  const tileDepth = (x: number, y: number) => {
    const tx = Math.min(map.w - 1, Math.max(0, x));
    const ty = Math.min(map.h - 1, Math.max(0, y));
    const i = map.idx(tx, ty);
    return map.isLand(i) ? 0 : map.depth[i];
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const tx = Math.floor(x / SUB);
      const ty = Math.floor(y / SUB);
      land[y * W + x] = map.isLand(map.idx(tx, ty)) ? 1 : 0;
      // Bilinear between tile centres.
      const fx = (x + 0.5) / SUB - 0.5;
      const fy = (y + 0.5) / SUB - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const ax = fx - x0;
      const ay = fy - y0;
      const top = tileDepth(x0, y0) * (1 - ax) + tileDepth(x0 + 1, y0) * ax;
      const bottom = tileDepth(x0, y0 + 1) * (1 - ax) + tileDepth(x0 + 1, y0 + 1) * ax;
      depth[y * W + x] = top * (1 - ay) + bottom * ay;
    }
  }
  boxBlur(depth, W, H, SUB);
  boxBlur(depth, W, H, SUB);

  const dist = chamferDistance(land, W, H);
  // The swell needs smooth, round contours: exact distance, then softened.
  const exact = euclideanDistance(land, W, H);
  boxBlur(exact, W, H, SUB);
  boxBlur(exact, W, H, SUB);
  const out = new Uint8Array(W * H * 4);
  const tiles = new Uint16Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const d = land[i] ? 0 : Math.min(1, depth[i] / MAX_DEPTH);
    const s = Math.min(1, dist[i] / SUB / SHORE_TILES);
    out[i * 4] = Math.round(d * 255);
    out[i * 4 + 1] = Math.round(s * 255);
    out[i * 4 + 3] = 255;
    tiles[i] = DataUtils.toHalfFloat(exact[i] / SUB);
  }
  return { field: out, dist: tiles };
}

/**
 * Exact Euclidean distance from land cells, in cells (Felzenszwalb and
 * Huttenlocher's separable squared distance transform).
 */
function euclideanDistance(land: Uint8Array, W: number, H: number): Float32Array {
  const INF = 1e20;
  const grid = new Float64Array(W * H);
  for (let i = 0; i < grid.length; i++) grid[i] = land[i] ? 0 : INF;
  const n = Math.max(W, H);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const transform1d = (len: number) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  };
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = grid[y * W + x];
    transform1d(H);
    for (let y = 0; y < H; y++) grid[y * W + x] = d[y];
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) f[x] = grid[y * W + x];
    transform1d(W);
    for (let x = 0; x < W; x++) grid[y * W + x] = d[x];
  }
  const out = new Float32Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(grid[i]);
  return out;
}

/** Two-pass 3-4 chamfer distance from land cells, in cells. */
function chamferDistance(land: Uint8Array, W: number, H: number): Float32Array {
  const d = new Float32Array(W * H);
  for (let i = 0; i < d.length; i++) d[i] = land[i] ? 0 : 1e9;
  const pass = (x: number, y: number, dx: number, dy: number, cost: number) => {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) return;
    const v = d[ny * W + nx] + cost;
    if (v < d[y * W + x]) d[y * W + x] = v;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      pass(x, y, -1, 0, 3);
      pass(x, y, 0, -1, 3);
      pass(x, y, -1, -1, 4);
      pass(x, y, 1, -1, 4);
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      pass(x, y, 1, 0, 3);
      pass(x, y, 0, 1, 3);
      pass(x, y, 1, 1, 4);
      pass(x, y, -1, 1, 4);
    }
  }
  for (let i = 0; i < d.length; i++) d[i] /= 3;
  return d;
}

/** Separable box blur in place, clamping at the edges. */
function boxBlur(v: Float32Array, W: number, H: number, r: number): void {
  const tmp = new Float32Array(v.length);
  const n = 2 * r + 1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += v[y * W + Math.min(W - 1, Math.max(0, x + k))];
      tmp[y * W + x] = sum / n;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += tmp[Math.min(H - 1, Math.max(0, y + k)) * W + x];
      v[y * W + x] = sum / n;
    }
  }
}
