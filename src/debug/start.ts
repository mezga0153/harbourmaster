import { effect } from '@preact/signals';
import { h, render } from 'preact';
import { Color, Group } from 'three';
import type { Renderer } from '../render/renderer';
import type { GameMap } from '../sim/map';
import { PLOT_SIZE } from '../sim/balance';
import { EXTENSION } from '../sim/orient';
import { craneGround } from '../sim/rules';
import { Build, isCrane } from '../sim/types';
import { selection, snapshot } from '../ui/store';
import './debug.css';
import { FINE, fineGrid, finePlan } from './fine';
import { LineLayer, SquareLayer, gridSquares, slotSquares, type DebugPoint } from './overlay';
import { Panel } from './Panel';
import { lastView, opts, setOpt } from './state';
import type { DebugView, DebugWant, PassKind } from './types';

// Dev server only: the debug overlays, wired into a game (main.ts, the sim
// in its worker) or the dev lab (src/dev/scenes.ts, the sim on the page).
// `request` asks the sim for what the overlays show, each frame, or for
// nothing when they need nothing of it; its answers come to `receive`.

export interface DebugHooks {
  renderer: Renderer;
  map: () => GameMap | null;
  /** Where the menu and the words over the map go. */
  ui: HTMLElement;
  request(want: DebugWant | null): void;
}

const PATH_COLOR: Record<string, number> = {
  dockhand: 0xfff3a0,
  forklift: 0xff9f1c,
  stacker: 0xc77dff,
  tractor: 0xc77dff,
  truck: 0x48e5ff,
  boat: 0x4f7bff,
  tug: 0x2ec4b6,
};
const SELECTED = new Color(0xff2bd6);
const LEG_COLOR: Record<string, Color> = {
  out: new Color(0xbbbbbb),
  via: new Color(0x00e5ff),
  in: new Color(0x3ddc68),
  away: new Color(0xff7ab8),
  walk: new Color(0x00e5ff),
};
const TWO_WAY = new Color(0x4f9dff);
const ONE_WAY = new Color(0xff9f1c);
const REACH = new Color(0x4fb3ff);
const ZONE = new Color(0xff4a3d);
const OWNED = new Color(0x3ddc68);
const NOT_OWNED = new Color(0x8a93a0);

/** How a selected entity's own tiles are best shown, going by what it is. */
function passFor(kind: string | undefined): PassKind | null {
  if (kind === 'dockhand') return 'walk';
  if (kind === 'forklift') return 'fork';
  if (kind === 'stacker' || kind === 'tractor') return 'drive';
  if (kind === 'truck') return 'truck';
  return null;
}

/** A little cross at x, z. */
function cross(p: DebugPoint, r: number, color: Color) {
  return [
    { a: { x: p.x - r, z: p.z - r }, b: { x: p.x + r, z: p.z + r }, color },
    { a: { x: p.x - r, z: p.z + r }, b: { x: p.x + r, z: p.z - r }, color },
  ];
}

export function startDebug(hooks: DebugHooks): { receive(view: DebugView): void } {
  const { renderer, map } = hooks;
  const group = new Group();
  group.name = 'debug overlays';
  renderer.overlay.group.add(group);
  const pass = new SquareLayer(group, 20, 0.38);
  const fine = new SquareLayer(group, 21, 0.5);
  const cranes = new SquareLayer(group, 22, 0.35);
  const slotsFree = new SquareLayer(group, 23, 0.25);
  const slots = new SquareLayer(group, 23, 0.95);
  const plots = new LineLayer(24, 0.8, 0.08);
  const roads = new LineLayer(25, 0.95, 0.035);
  const paths = new LineLayer(26, 0.95, 0.07);
  const plan = new LineLayer(27, 1, 0.045);
  group.add(plots.lines, roads.lines, paths.lines, plan.lines);

  // The menu, and words pinned over the map.
  const menu = document.createElement('div');
  const words = document.createElement('div');
  words.className = 'dbg-words';
  hooks.ui.append(words, menu);
  render(h(Panel, { map }), menu);
  let labels: { x: number; z: number; text: string; bad?: boolean; el?: HTMLElement }[] = [];

  window.addEventListener('hm-debug', () => setOpt('open', !opts.peek().open));
  window.addEventListener('keydown', (e) => {
    if (e.key !== '`' || (e.target as HTMLElement)?.closest?.('input, textarea, select')) return;
    setOpt('open', !opts.peek().open);
  });
  // A small handle to open it by when it is closed.
  const chip = document.createElement('button');
  chip.className = 'dbg-chip';
  chip.textContent = 'dbg';
  chip.title = 'Debug overlays (`)';
  chip.onclick = () => setOpt('open', true);
  hooks.ui.append(chip);

  const selectedId = () => {
    const s = selection.value;
    return s?.type === 'entity' ? s.id : null;
  };

  /** What the sim is asked for, or null when nothing on needs it. */
  const wantNow = (): DebugWant | null => {
    const o = opts.value;
    if (!o.on) return null;
    const id = selectedId();
    const kind = id === null ? undefined : snapshot.peek()?.entities.find((e) => e.id === id)?.kind;
    const p = o.pass === 'auto' ? passFor(kind) : o.pass;
    const want: DebugWant = {
      allPaths: o.allPaths || o.labels,
      selected: id,
      pass: p,
      roads: o.roads,
      slots: o.slots || o.hover,
    };
    const any = want.allPaths || want.selected !== null || want.pass || want.roads || want.slots;
    return any ? want : null;
  };

  effect(() => {
    const want = wantNow();
    hooks.request(want);
    if (!want) clearSim();
  });

  function clearSim(): void {
    lastView.value = null;
    pass.clear();
    slots.clear();
    slotsFree.clear();
    paths.set(null, []);
    roads.set(null, []);
    setLabels([]);
  }

  function setLabels(next: typeof labels): void {
    for (const l of labels) l.el?.remove();
    labels = next;
    for (const l of labels) {
      l.el = document.createElement('div');
      l.el.className = `dbg-word${l.bad ? ' bad' : ''}`;
      l.el.textContent = l.text;
      words.append(l.el);
    }
  }

  function receive(view: DebugView): void {
    const m = map();
    if (!m || !opts.peek().on) return;
    lastView.value = view;
    const o = opts.peek();
    const sel = selectedId();
    const centre = (i: number): DebugPoint => ({ x: m.xOf(i) + 0.5, z: m.yOf(i) + 0.5 });

    // Paths: from where it is through each tile still to go, a cross on its goal.
    const segs: Parameters<LineLayer['set']>[1] = [];
    for (const p of view.paths) {
      const color = p.id === sel ? SELECTED : new Color(PATH_COLOR[p.kind] ?? 0xffffff);
      let at: DebugPoint = { x: p.x, z: p.y };
      for (const i of p.path) {
        const next = centre(i);
        segs.push({ a: at, b: next, color });
        at = next;
      }
      for (let k = 0; k + 3 < (p.round?.length ?? 0); k += 2) {
        const r = p.round!;
        segs.push({ a: { x: r[k], z: r[k + 1] }, b: { x: r[k + 2], z: r[k + 3] }, color });
      }
      if (p.goal >= 0 && (p.path.length > 0 || p.id === sel))
        segs.push(...cross(centre(p.goal), 0.3, color));
    }
    paths.set(m, segs, 0.14);

    if (view.pass) pass.set(m, gridSquares(view.pass.grid, 0.07));
    else pass.clear();

    // The road graph: each step a truck may take as an arrow on the right of
    // the way, so a two-way road shows a pair and a one-way road one.
    const rsegs: Parameters<LineLayer['set']>[1] = [];
    if (view.roads) {
      const r = view.roads;
      const steps = new Set<number>();
      for (let k = 0; k < r.length; k += 2) steps.add(r[k] * m.w * m.h + r[k + 1]);
      for (let k = 0; k < r.length; k += 2) {
        const [a, b] = [centre(r[k]), centre(r[k + 1])];
        const color = steps.has(r[k + 1] * m.w * m.h + r[k]) ? TWO_WAY : ONE_WAY;
        const [dx, dz] = [b.x - a.x, b.z - a.z];
        // Right of the way, looking along it (+x east, +z south on the map).
        const [ox, oz] = [-dz * 0.14, dx * 0.14];
        const from = { x: a.x + dx * 0.2 + ox, z: a.z + dz * 0.2 + oz };
        const to = { x: a.x + dx * 0.8 + ox, z: a.z + dz * 0.8 + oz };
        rsegs.push({ a: from, b: to, color });
        const back = { x: to.x - dx * 0.15, z: to.z - dz * 0.15 };
        rsegs.push({ a: to, b: { x: back.x + dz * 0.08, z: back.z - dx * 0.08 }, color });
        rsegs.push({ a: to, b: { x: back.x - dz * 0.08, z: back.z + dx * 0.08 }, color });
      }
    }
    roads.set(m, rsegs, 0.12);

    if (o.slots && view.slots) {
      const { free, held } = slotSquares(m, view.slots);
      slotsFree.set(m, free);
      slots.set(m, held);
    } else {
      slots.clear();
      slotsFree.clear();
    }

    const next: typeof labels = [];
    if (o.slots) {
      for (const b of view.slots ?? []) {
        if (b.cap === 0 && !b.noAccess) continue;
        const t = centre(b.tiles[0]);
        next.push({ x: t.x, z: t.z - 0.3, text: `${b.name}: ${b.note}`, bad: b.noAccess });
      }
    }
    if (o.labels) {
      for (const p of view.paths) {
        if (p.kind === 'boat' || p.kind === 'tug') continue;
        next.push({ x: p.x, z: p.y, text: `${p.kind[0]}${p.id} ${p.state ?? ''}` });
      }
    }
    setLabels(next);
  }

  /** What is worked out from the map alone: cranes' reach, the plots of land. */
  function drawMap(): void {
    const m = map();
    const o = opts.peek();
    if (!m) return;
    const sq: Parameters<SquareLayer['set']>[1] = [];
    if (o.on && o.cranes) {
      for (let i = 0; i < m.build.length; i++) {
        const b = m.build[i];
        if (!isCrane(b) || m.orient[i] & EXTENSION) continue;
        const kind =
          b === Build.JibCrane ? 'jibCrane' : b === Build.Gantry ? 'gantryCrane' : 'harbourCrane';
        const { zone, reach } = craneGround(m, kind, i, m.orient[i] & 3);
        for (const t of reach)
          sq.push({ x: m.xOf(t) + 0.5, z: m.yOf(t) + 0.5, size: 0.9, color: REACH });
        for (const t of zone)
          sq.push({ x: m.xOf(t) + 0.5, z: m.yOf(t) + 0.5, size: 0.6, color: ZONE, lift: 0.08 });
      }
    }
    cranes.set(m, sq);
    const ls: Parameters<LineLayer['set']>[1] = [];
    if (o.on && o.plots) {
      for (let p = 0; p < m.plots.length; p++) {
        const x0 = (p % m.plotsWide) * PLOT_SIZE + 0.05;
        const z0 = Math.floor(p / m.plotsWide) * PLOT_SIZE + 0.05;
        const x1 = Math.min(m.w, x0 + PLOT_SIZE) - 0.1;
        const z1 = Math.min(m.limit, z0 + PLOT_SIZE) - 0.1;
        const color = m.plots[p] ? OWNED : NOT_OWNED;
        const c = [
          { x: x0, z: z0 },
          { x: x1, z: z0 },
          { x: x1, z: z1 },
          { x: x0, z: z1 },
        ];
        for (let k = 0; k < 4; k++) ls.push({ a: c[k], b: c[(k + 1) % 4], color });
      }
    }
    plots.set(m, ls, 0.5);
  }
  effect(() => {
    void opts.value;
    drawMap();
  });
  setInterval(() => {
    if (opts.peek().on && (opts.peek().cranes || opts.peek().plots)) drawMap();
  }, 2000);

  // Each frame: the selected entity's plan as the view has it, words kept
  // over what they name, and every so often the fine grid round the middle
  // of the view.
  let fineAt = 0;
  const frame = (now: number) => {
    requestAnimationFrame(frame);
    const m = map();
    const o = opts.peek();
    group.visible = o.on;
    chip.style.display = o.open ? 'none' : '';
    if (!m || !o.on) return;
    const id = selectedId();
    const fp = id === null ? null : finePlan(renderer, id);
    const segs: Parameters<LineLayer['set']>[1] = [];
    for (const leg of fp?.legs ?? []) {
      const color = LEG_COLOR[leg.name] ?? LEG_COLOR.via;
      for (let k = 1; k < leg.points.length; k++) {
        segs.push({ a: leg.points[k - 1], b: leg.points[k], color });
        segs.push(...cross(leg.points[k], 0.05, color));
      }
    }
    plan.set(m, segs, 0.18);

    if (o.fine && now - fineAt > 300) {
      fineAt = now;
      const src = FINE[o.fine]?.make(renderer, m);
      const t = renderer.cam.target;
      if (src)
        fine.set(
          m,
          gridSquares(fineGrid(src, t.x, t.z, Math.min(16, renderer.cam.viewSize * 0.6)), 0.09),
        );
    } else if (!o.fine) fine.clear();

    for (const l of labels) {
      if (!l.el) continue;
      const s = renderer.screenOf(l.x, l.z, 0.9);
      l.el.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px)`;
    }
  };
  requestAnimationFrame(frame);

  // For the console or a driver: turn layers on and select things by hand.
  Object.assign(window, { __debug: { opts, setOpt, lastView, selection } });

  return { receive };
}
