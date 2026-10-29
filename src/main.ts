import { h, render } from 'preact';
import { Input } from './input';
import type { Command, WorkerMessage } from './protocol';
import { loadAssets } from './render/assets';
import { Renderer } from './render/renderer';
import { isMachineKind } from './sim/machines';
import { GameMap } from './sim/map';
import type { Hints } from './render/overlay';
import * as B from './sim/balance';
import { buoyGates, craneGround, driveNetwork, loadingSpots, truckReach } from './sim/rules';
import { Build, isBay } from './sim/types';
import { App, type Actions } from './ui/App';
import { pushMessage, seed, selection, snapshot, tool } from './ui/store';
import './ui/style.css';

const worker = new Worker(new URL('./worker/sim.worker.ts', import.meta.url), { type: 'module' });
const send = (cmd: Command) => worker.postMessage(cmd);

const uiRoot = document.getElementById('ui')!;
const floaters = document.createElement('div');
floaters.className = 'floaters';
uiRoot.appendChild(floaters);
const hud = document.createElement('div');
hud.className = 'hud';
uiRoot.appendChild(hud);

const renderer = new Renderer(document.getElementById('game')!, floaters);
let map: GameMap | null = null;
const input = new Input(renderer, () => map, send);

const actions: Actions = {
  send,
  setSpeed: (s) => input.setSpeed(s),
  togglePause: () => input.togglePause(),
  focus: (x, y) => renderer.cam.target.set(x, 0, y),
};
render(h(App, { actions }), hud);
selection.subscribe((s) => {
  renderer.select(s?.type === 'entity' ? s.id : null);
  showReach();
  showGround();
});
tool.subscribe(() => showChannels());

/** With a buoy tool in hand, show the lines the pairs of buoys mark. */
function showChannels(): void {
  if (!map) return;
  const m = map;
  const on = tool.peek() === 'buoyIn' || tool.peek() === 'buoyOut';
  const lines = (out: boolean): [number, number][] =>
    on ? buoyGates(m, out).flatMap((g) => (g.b < 0 ? [] : [[g.a, g.b] as [number, number]])) : [];
  renderer.overlay.setChannels(m, [lines(false), lines(true)]);
}

/** With a forklift, stacker or depot selected, show where it can drive. */
function showReach(): void {
  if (!map) return;
  const m = map;
  const s = selection.peek();
  let start = -1;
  if (s?.type === 'depot') start = s.idx;
  if (s?.type === 'entity') {
    const e = snapshot.peek()?.entities.find((q) => q.id === s.id);
    if (e && isMachineKind(e.kind)) start = m.idx(Math.floor(e.x), Math.floor(e.y));
  }
  if (start < 0) return renderer.overlay.setReach(m, [], [], []);
  const net = driveNetwork(m, start);
  const route: number[] = [];
  const bays: number[] = [];
  const cutOff: number[] = [];
  for (let i = 0; i < m.build.length; i++) {
    if (isBay(m.build[i]) || m.store[i]) (net.has(i) ? bays : cutOff).push(i);
    else if (net.has(i)) route.push(i);
  }
  renderer.overlay.setReach(m, route, bays, cutOff);
}

/**
 * With a crane selected, its machines-only ground and a jib crane's reach;
 * with storage, where the trucks load beside it.
 */
function showGround(): void {
  if (!map) return;
  const m = map;
  const s = selection.peek();
  const snap = snapshot.peek();
  let hints: Hints = [];
  if (s?.type === 'crane') {
    const b = m.build[s.idx];
    const kind =
      b === Build.JibCrane ? 'jibCrane' : b === Build.Gantry ? 'gantryCrane' : 'harbourCrane';
    const { zone, reach } = craneGround(m, kind, s.idx, m.orient[s.idx] & 3);
    hints = [
      { kind: 'reach', tiles: reach },
      { kind: 'zone', tiles: zone },
    ];
  } else if (s?.type === 'bay' || s?.type === 'yard') {
    const area =
      s.type === 'bay'
        ? snap?.bays.find((b) => b.idx === s.idx)?.tiles
        : snap?.yards.find((y) => y.idx === s.idx)?.tiles;
    if (area) {
      const most = Math.max(1, Math.floor(area.length / B.STORE_TILES_PER_TRUCK));
      hints = [{ kind: 'spot', tiles: loadingSpots(m, area, truckReach(m)).slice(0, most) }];
    }
  }
  renderer.overlay.setHints(m, 'selection', hints);
}

/** With a boat selected, show where it plots it will be, and the boat it gives way to. */
function showPlots(): void {
  const s = selection.peek();
  const es = snapshot.peek()?.entities;
  const boat = s?.type === 'entity' ? es?.find((e) => e.id === s.id && e.kind === 'boat') : null;
  const other = boat?.givingWayTo !== undefined ? es?.find((e) => e.id === boat.givingWayTo) : null;
  renderer.overlay.setPlots([boat?.plot ?? null, other?.plot ?? null]);
}

// Models load in parallel with the worker starting up; messages wait for them.
const assetsReady = loadAssets();
let inbox = Promise.resolve();

worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
  inbox = inbox.then(() => assetsReady).then(() => handle(e.data));
};

function handle(msg: WorkerMessage): void {
  if (msg.type === 'dump') return;
  if (msg.type === 'init') {
    map = GameMap.fromData(msg.map);
    seed.value = msg.seed;
    selection.value = null;
    renderer.setMap(map);
    return;
  }
  if (!map) return;
  let treesChanged = false;
  let terrainChanged = false;
  let seaChanged = false;
  for (const c of msg.tiles) {
    if (map.deco[c.i] !== c.deco) treesChanged = true;
    if (map.terrain[c.i] !== c.terrain) terrainChanged = true;
    if (map.depth[c.i] !== c.depth || map.ocean[c.i] !== c.ocean) seaChanged = true;
    map.terrain[c.i] = c.terrain;
    map.depth[c.i] = c.depth;
    map.ocean[c.i] = c.ocean;
    map.build[c.i] = c.build;
    map.orient[c.i] = c.orient;
    map.deco[c.i] = c.deco;
    map.store[c.i] = c.store;
  }
  renderer.applyTiles(msg.tiles, treesChanged, terrainChanged, seaChanged);
  if (msg.tiles.length > 0) {
    showReach();
    showGround();
    showChannels();
  }
  renderer.applySnapshot(msg.snapshot);
  snapshot.value = msg.snapshot;
  showPlots();
  for (const ev of msg.events) {
    if (ev.kind === 'message') pushMessage(ev.text, ev.tone);
    else renderer.showMoney(ev.amount, ev.x, ev.y);
  }
}

if (import.meta.env.DEV) {
  // Handle for poking at the game from the console or a test driver.
  Object.assign(window, { __hm: { renderer, send, map: () => map, snapshot, selection } });
  // Mirror the game into .debug/ for tools outside the browser.
  void import('./debug/bridge').then((b) =>
    b.startBridge({ worker, send, renderer, map: () => map }),
  );
}
