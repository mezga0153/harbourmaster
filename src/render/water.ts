import {
  Color,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  Mesh,
  PlaneGeometry,
  RedFormat,
  RGBAFormat,
  ShaderMaterial,
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
  uniform vec2 uSize;
  uniform float uTime;
  uniform vec3 uShallow;
  uniform vec3 uMid;
  uniform vec3 uDeep;
  uniform vec3 uFoam;
  uniform vec3 uSun;
  uniform vec3 uView;
  varying vec2 vXZ;

  const float K = 6.28318 / 1.8; // swell wavelength: 1.8 tiles
  const float SPEED = 1.5; // radians per second; crests travel ~0.4 tiles/s

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

  // Distance to land. Past the seaward map edge it keeps growing, so the
  // swell keeps rolling in from beyond the map.
  float distAt(vec2 p) {
    return texture2D(uDist, p / uSize).r + max(0.0, p.x - uSize.x);
  }

  // Incoming swell: crests follow the coastline (equal distance to land),
  // so they bend around headlands and arrive parallel to the beach. The
  // phase shrinks the distance over time, so crests travel towards land.
  float incoming(float d) {
    return sin(d * K + uTime * SPEED);
  }

  // The bounce: a weaker wave running back out, fading within a few tiles.
  float reflected(float d) {
    return sin(d * K * 1.07 - uTime * SPEED + 1.7) * exp(-d * 0.8);
  }

  // Groups of bigger waves drift through; between them the sea is calmer.
  float waveSets(vec2 p) {
    return 0.35 + 0.65 * smoothstep(0.25, 0.8, noise(p * 0.09 + vec2(uTime * 0.04, uTime * 0.01)));
  }

  float swell(vec2 p) {
    float d = distAt(p);
    // Wave sets: some stretches of a crest are taller than others.
    float sets = waveSets(p);
    float chop = (noise(p * 2.6 + vec2(-uTime * 0.5, uTime * 0.15)) - 0.5) * 0.3;
    return incoming(d) * sets + reflected(d) * 0.55 + chop;
  }

  void main() {
    vec4 field = texture2D(uField, vXZ / uSize);
    float depth = field.r;
    float shore = field.g;
    float d = distAt(vXZ);

    vec3 col = mix(uShallow, uMid, smoothstep(0.0, 0.2, depth));
    col = mix(col, uDeep, smoothstep(0.2, 0.65, depth));

    // Lighting from the swell's slope; waves steepen as they reach the shore.
    float e = 0.08;
    float h0 = swell(vXZ);
    float steep = 0.08 + 0.06 * (1.0 - smoothstep(0.5, 6.0, d));
    vec3 n = normalize(vec3(
      -(swell(vXZ + vec2(e, 0.0)) - h0) / e * steep,
      1.0,
      -(swell(vXZ + vec2(0.0, e)) - h0) / e * steep
    ));
    col *= 0.9 + 0.16 * dot(n, uSun);
    float spec = pow(max(dot(reflect(-uSun, n), uView), 0.0), 110.0);
    col += spec * 0.5;

    // Crests catch the light as thin bands rolling in, mostly in the sets.
    float sets = waveSets(vXZ);
    float crest = smoothstep(0.85, 1.0, incoming(d)) * smoothstep(0.45, 1.0, sets);
    crest *= 0.6 + 0.4 * noise(vXZ * 0.7 + uTime * 0.05);
    col = mix(col, uFoam, crest * 0.06 * smoothstep(0.3, 1.5, d));

    // Foam hugging the coast.
    float edge = 1.0 - smoothstep(0.02, 0.07, shore);
    float breakup = noise(vXZ * 3.0 + uTime * 0.4);
    float foam = edge * smoothstep(0.3, 0.65, breakup + edge * 0.45);

    // Breaking: crests turn white in the last stretch before the beach…
    float near = 1.0 - smoothstep(0.4, 2.0, d);
    float breaking = smoothstep(0.75, 1.0, incoming(d)) * near * sets;
    breaking *= smoothstep(0.25, 0.65, noise(vXZ * 1.6 + uTime * 0.2));
    // …and the backwash leaves a fainter line as it bounces back out.
    float backwash = smoothstep(0.85, 1.0, reflected(d) / max(exp(-d * 0.8), 0.001));
    backwash *= (1.0 - smoothstep(0.15, 0.9, d)) * 0.45;
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
    this.material.dispose();
  }
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
