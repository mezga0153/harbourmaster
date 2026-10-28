import { h, render } from 'preact';
import { Input } from './input';
import type { Command, WorkerMessage } from './protocol';
import { loadAssets } from './render/assets';
import { Renderer } from './render/renderer';
import { isMachineKind } from './sim/machines';
import { GameMap } from './sim/map';
import { driveNetwork } from './sim/rules';
import { isBay } from './sim/types';
import { App, type Actions } from './ui/App';
import { pushMessage, seed, selection, snapshot } from './ui/store';
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
};
render(h(App, { actions }), hud);
selection.subscribe((s) => {
  renderer.select(s?.type === 'entity' ? s.id : null);
  showReach();
});

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
    if (isBay(m.build[i])) (net.has(i) ? bays : cutOff).push(i);
    else if (net.has(i)) route.push(i);
  }
  renderer.overlay.setReach(m, route, bays, cutOff);
}

// Models load in parallel with the worker starting up; messages wait for them.
const assetsReady = loadAssets();
let inbox = Promise.resolve();

worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
  inbox = inbox.then(() => assetsReady).then(() => handle(e.data));
};

function handle(msg: WorkerMessage): void {
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
  for (const c of msg.tiles) {
    if (map.deco[c.i] !== c.deco) treesChanged = true;
    if (map.terrain[c.i] !== c.terrain) terrainChanged = true;
    map.terrain[c.i] = c.terrain;
    map.build[c.i] = c.build;
    map.orient[c.i] = c.orient;
    map.deco[c.i] = c.deco;
  }
  renderer.applyTiles(msg.tiles, treesChanged, terrainChanged);
  if (msg.tiles.length > 0) showReach();
  renderer.applySnapshot(msg.snapshot);
  snapshot.value = msg.snapshot;
  for (const ev of msg.events) {
    if (ev.kind === 'message') pushMessage(ev.text, ev.tone);
    else renderer.showMoney(ev.amount, ev.x, ev.y);
  }
}

if (import.meta.env.DEV) {
  // Handle for poking at the game from the console or a test driver.
  Object.assign(window, { __hm: { renderer, send, map: () => map, snapshot, selection } });
}
