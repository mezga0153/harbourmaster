import type { Object3D } from 'three';

// Small sums the renderer does over and over: angles, easing and keeping
// what is drawn in step with what the game says.

/** An angle brought into -π to π. */
export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** From angle `a` part way, `t`, the shorter way round to `b`. */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
}

export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Smoothly in and out, 0 to 1, clamped: the smoothstep curve. */
export function ease(t: number): number {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
}

/**
 * `x` eased towards `target` over a frame `dt` seconds long, closing on it
 * at `rate` per second the way an exponential does: the same curve at any
 * frame rate.
 */
export function approach(x: number, target: number, dt: number, rate: number): number {
  return x + (target - x) * (1 - Math.exp(-dt * rate));
}

/**
 * The phase of a lift as drawn, `shown`, kept in step with the game's,
 * `game`: jumped to it when well off (more than 0.15 of a lift, as after
 * a new lift starts or the tab was in the background), otherwise eased
 * halfway, so a small drift never shows. `wrap` for a phase that goes
 * round from 1 to 0; `most` caps the eased value, not a jump.
 */
export function syncPhase(
  shown: number,
  game: number,
  opts: { wrap?: boolean; most?: number } = {},
): number {
  const off = opts.wrap ? ((game - shown + 1.5) % 1) - 0.5 : game - shown;
  if (Math.abs(off) > 0.15) return game;
  let next = shown + off * 0.5;
  if (opts.wrap) next = (next + 1) % 1;
  if (opts.most !== undefined) next = Math.min(opts.most, next);
  return next;
}

/**
 * Which way an object's +x points in the world, as a heading on the map:
 * the angle from +x towards +z, as the sim gives every entity's `dir`.
 * An object facing heading `d` has `rotation.y = -d`, so a heading is the
 * negative of a turn about y; see turnOf.
 */
export function headingOf(o: Object3D): number {
  o.updateWorldMatrix(true, false);
  const e = o.matrixWorld.elements;
  return Math.atan2(e[2], e[0]);
}

/** Which way an object's +x points in the world, as a turn about y: the negative of headingOf. */
export function turnOf(o: Object3D): number {
  return -headingOf(o);
}
