import {
  Color,
  DataTexture,
  LinearFilter,
  Mesh,
  PlaneGeometry,
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
  uniform sampler2D uField; // r: depth, g: distance to shore
  uniform vec2 uSize;
  uniform float uTime;
  uniform vec3 uShallow;
  uniform vec3 uMid;
  uniform vec3 uDeep;
  uniform vec3 uFoam;
  uniform vec3 uSun;
  uniform vec3 uView;
  varying vec2 vXZ;

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

  // Wind waves and finer ripples, only used for lighting.
  float waves(vec2 p) {
    float t = uTime;
    float h = sin(dot(p, vec2(0.9, 0.4)) * 1.6 + t * 1.1) * 0.5;
    h += sin(dot(p, vec2(-0.3, 1.0)) * 2.3 + t * 1.4) * 0.35;
    h += sin(dot(p, vec2(0.7, -0.8)) * 3.7 - t * 1.8) * 0.2;
    h += sin(dot(p, vec2(-0.8, -0.5)) * 6.1 + t * 2.6) * 0.12;
    h += (noise(p * 1.3 + vec2(t * 0.25, -t * 0.18)) - 0.5) * 0.8;
    h += (noise(p * 4.1 - vec2(t * 0.6, t * 0.45)) - 0.5) * 0.35;
    return h;
  }

  void main() {
    vec4 field = texture2D(uField, vXZ / uSize);
    float depth = field.r;
    float shore = field.g;

    vec3 col = mix(uShallow, uMid, smoothstep(0.0, 0.2, depth));
    col = mix(col, uDeep, smoothstep(0.2, 0.65, depth));

    float e = 0.06;
    float h0 = waves(vXZ);
    vec3 n = normalize(vec3(
      -(waves(vXZ + vec2(e, 0.0)) - h0) / e * 0.13,
      1.0,
      -(waves(vXZ + vec2(0.0, e)) - h0) / e * 0.13
    ));
    col *= 0.9 + 0.16 * dot(n, uSun);
    float spec = pow(max(dot(reflect(-uSun, n), uView), 0.0), 110.0);
    col += spec * 0.55;

    // Soft ripple lines drifting across the surface, stronger out at sea.
    float rn = noise(vXZ * 0.55 + vec2(uTime * 0.05, uTime * 0.03));
    float ripple = smoothstep(0.86, 1.0, abs(sin((rn + vXZ.x * 0.02) * 22.0 - uTime * 0.6)));
    // Broken into short dashes so they read as wind ripples, not contours.
    ripple *= smoothstep(0.55, 0.8, noise(vXZ * 1.7 - uTime * 0.12));
    col = mix(col, uFoam, ripple * (0.04 + 0.06 * smoothstep(0.05, 0.4, depth)));

    // Broken foam line hugging the coast.
    float edge = 1.0 - smoothstep(0.02, 0.07, shore);
    float breakup = noise(vXZ * 3.0 + uTime * 0.4);
    float foam = edge * smoothstep(0.3, 0.65, breakup + edge * 0.45);

    // Gentle swell lines rolling in towards the beach.
    float band = fract(shore * 5.0 + uTime * 0.28);
    float roll = smoothstep(0.0, 0.06, band) * (1.0 - smoothstep(0.06, 0.16, band));
    roll *= (1.0 - smoothstep(0.05, 0.24, shore));
    roll *= smoothstep(0.35, 0.7, noise(vXZ * 1.4 - uTime * 0.15));
    foam = max(foam, roll * 0.55);

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
    const tex = new DataTexture(
      bakeField(map),
      map.w * SUB,
      map.h * SUB,
      RGBAFormat,
      UnsignedByteType,
    );
    tex.magFilter = LinearFilter;
    tex.minFilter = LinearFilter;
    tex.needsUpdate = true;

    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uField: { value: tex },
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
    this.material.dispose();
  }
}

/** RGBA bytes: r = smoothed depth, g = distance to the nearest land. */
function bakeField(map: GameMap): Uint8Array {
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
  const out = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const d = land[i] ? 0 : Math.min(1, depth[i] / MAX_DEPTH);
    const s = Math.min(1, dist[i] / SUB / SHORE_TILES);
    out[i * 4] = Math.round(d * 255);
    out[i * 4 + 1] = Math.round(s * 255);
    out[i * 4 + 3] = 255;
  }
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
