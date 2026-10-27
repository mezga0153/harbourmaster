import {
  Color,
  DataTexture,
  LinearFilter,
  Mesh,
  PlaneGeometry,
  RedFormat,
  ShaderMaterial,
  UnsignedByteType,
} from 'three';
import type { GameMap } from '../sim/map';
import { C } from './palette';
import { MARGIN } from './terrain';

const MAX_DEPTH = 16;

const vertexShader = /* glsl */ `
  varying vec2 vXZ;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vXZ = wp.xz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uDepth;
  uniform vec2 uSize;
  uniform float uTime;
  uniform vec3 uShallow;
  uniform vec3 uDeep;
  uniform vec3 uFoam;
  varying vec2 vXZ;

  void main() {
    float d = texture2D(uDepth, vXZ / uSize).r;
    vec3 col = mix(uShallow, uDeep, smoothstep(0.02, 0.22, d));

    float w = sin(vXZ.x * 3.1 + uTime * 1.3 + sin(vXZ.y * 1.7))
            * sin(vXZ.y * 2.6 - uTime * 1.1 + sin(vXZ.x * 1.3));
    col += 0.012 * w;

    float shore = 1.0 - smoothstep(0.0, 0.07, d);
    float pulse = 0.65 + 0.35 * sin(uTime * 1.8 + d * 90.0);
    col = mix(col, uFoam, shore * pulse * 0.75);

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

/** Flat animated sea, coloured by depth from a per-tile texture. */
export class Water {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;

  constructor(map: GameMap) {
    const data = new Uint8Array(map.w * map.h);
    for (let i = 0; i < data.length; i++) {
      data[i] = map.isLand(i) ? 0 : Math.round(Math.min(1, map.depth[i] / MAX_DEPTH) * 255);
    }
    const tex = new DataTexture(data, map.w, map.h, RedFormat, UnsignedByteType);
    tex.magFilter = LinearFilter;
    tex.minFilter = LinearFilter;
    tex.needsUpdate = true;

    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uDepth: { value: tex },
        uSize: { value: [map.w, map.h] },
        uTime: { value: 0 },
        uShallow: { value: new Color(C.waterShallow) },
        uDeep: { value: new Color(C.waterDeep) },
        uFoam: { value: new Color(C.foam) },
      },
    });

    const size = Math.max(map.w, map.h) + MARGIN * 2 + 400;
    const geo = new PlaneGeometry(size, size);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new Mesh(geo, this.material);
    this.mesh.position.set(map.w / 2, 0, map.h / 2);
  }

  update(time: number): void {
    this.material.uniforms.uTime.value = time;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.material.uniforms.uDepth.value as DataTexture).dispose();
    this.material.dispose();
  }
}
