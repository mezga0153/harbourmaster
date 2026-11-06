import { h, render } from 'preact';
import { Soundscape } from './audio/sound';
import { Input } from './input';
import { logCommand, logFrame, logInit, logPanel } from './log/days';
import { gpu, report, watchErrors } from './log/errors';
import { setReportHooks } from './log/feedback';
import { visitOpen } from './log/visit';
import type { Command, WorkerMessage } from './protocol';
import type { SaveData } from './sim/world';
import { loadAssets } from './render/assets';
import { Renderer } from './render/renderer';
import { GameMap } from './sim/map';
import { App } from './ui/App';
import type { Actions } from './ui/actions';
import { downloadSave } from './ui/download';
import { wireOverlays } from './ui/mapOverlays';
import { assetsLoaded, failed, loaded, loading, refused, titleMenu } from './ui/loading';
import { graphics } from './ui/prefs';
import { nextPrice, ownedPlots } from './sim/land';
import {
  advise,
  land,
  openGuide,
  panel,
  pushMessage,
  seed,
  selection,
  snapshot,
  tool,
} from './ui/store';
import './ui/style.css';
import { applyView, readView, trackView } from './view-url';

// Wiring: the worker that runs the sim, the renderer, the input, the sound,
// the UI and the play log, joined up; what each does is in its own place.

const worker = new Worker(new URL('./worker/sim.worker.ts', import.meta.url), { type: 'module' });
const send = (cmd: Command) => {
  logCommand(cmd);
  worker.postMessage(cmd);
};

const uiRoot = document.getElementById('ui')!;
const floaters = document.createElement('div');
floaters.className = 'floaters';
uiRoot.appendChild(floaters);
const hud = document.createElement('div');
hud.className = 'hud';
uiRoot.appendChild(hud);

// Some browsers, after the graphics have crashed on a page a few times, turn
// 3D off for that site till they are restarted: say so rather than hang.
if (!webglWorks()) {
  failed(
    'Your browser has turned off 3D graphics for this game, or has none to give it. Close the browser completely and open it again (on a phone, swipe it away from the recent apps), then come back. If it happens again, lower the graphics in Settings.',
  );
  report('webgl', 'no WebGL to start with');
  throw new Error('No WebGL');
}
const renderer = new Renderer(document.getElementById('game')!, floaters);
watchErrors(worker, renderer.canvas);
let map: GameMap | null = null;
const input = new Input(renderer, () => map, send);
const sound = new Soundscape(
  () => {
    const c = renderer.cam;
    // The camera's right, laid flat on the ground (tile x is world x, tile y world z).
    const e = c.camera.matrixWorld.elements;
    const len = Math.hypot(e[0], e[2]) || 1;
    return {
      x: c.target.x,
      y: c.target.z,
      rightX: e[0] / len,
      rightY: e[2] / len,
      viewSize: c.viewSize,
    };
  },
  () => map,
);

// Where the player was looking, from the address: the first port shown, if
// it is the same port, opens there. A new game or another save starts afresh.
let urlView = readView();
trackView(
  renderer.cam,
  () => seed.peek(),
  () => map !== null,
);

// Drawn as the player set it, from the start and whenever they change it.
graphics.subscribe((g) => renderer.setGraphics(g));

const actions: Actions = {
  send,
  setSpeed: (s) => input.setSpeed(s),
  togglePause: () => input.togglePause(),
  focus: (x, y) => renderer.cam.target.set(x, 0, y),
  rotateView: (dir) => renderer.cam.rotate(dir),
  zoom: (factor) => renderer.cam.zoom(factor),
  rotateBuilding: () => input.rotate(),
};
render(h(App, { actions }), hud);
{
  const g = graphics.peek();
  visitOpen(`${g.water}/${g.shadows}/${g.resolution}`, gpu());
}
// Found the finance or statistics screen: the advisor need not point it out.
panel.subscribe((p) => {
  logPanel(p);
  if (p === 'finance' || p === 'stats') send({ type: 'learnt', tip: 'screens' });
});
// What the selection and the tool in hand draw over the map, and the flight to the town.
const overlays = wireOverlays(renderer, () => map);

/** The port's land as it now stands, for the bar and panels, and drawn over the map. */
function showLand(): void {
  if (!map) return;
  land.value = {
    owned: ownedPlots(map),
    next: nextPrice(map),
    nextSea: nextPrice(map, true),
    after: nextPrice(map, false, 1),
  };
  input.refreshLand();
}

// Models load in parallel with the worker starting up; messages wait for them.
loading(0.1, 'Loading the models…');
const assetsReady = loadAssets((done, of) =>
  loading(0.1 + (0.75 * done) / Math.max(1, of), `Loading the models… ${done} of ${of}`),
).then(assetsLoaded);
let inbox = Promise.resolve();

worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
  // The title screen's, while the models are still loading behind it.
  if (e.data.type === 'autosave') return titleMenu(e.data.save, send);
  if (e.data.type === 'refused') return refused(e.data.text);
  inbox = inbox.then(() => assetsReady).then(() => handle(e.data));
};

/** Bug reports waiting for the game as it is, to send with them. */
const wantSave: ((s: SaveData) => void)[] = [];
setReportHooks({
  save: () =>
    new Promise((resolve) => {
      wantSave.push(resolve);
      send({ type: 'exportSave', forReport: true });
    }),
  picture: () => renderer.picture(),
});

function handle(msg: WorkerMessage): void {
  if (msg.type === 'dump' || msg.type === 'debugView') return;
  if (msg.type === 'autosave' || msg.type === 'refused') return;
  if (msg.type === 'exported') {
    if (!msg.forReport) return downloadSave(msg.save);
    for (const take of wantSave.splice(0)) take(msg.save);
    return;
  }
  if (msg.type === 'fault') return report(msg.kind, msg.message, msg.stack);
  if (msg.type === 'init') {
    map = GameMap.fromData(msg.map);
    seed.value = msg.seed;
    logInit();
    selection.value = null;
    renderer.setMap(map);
    showLand();
    if (urlView?.seed === msg.seed) applyView(renderer.cam, urlView);
    urlView = null;
    loading(0.95, 'Drawing the port…');
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
  if (msg.plots) {
    map.plots.set(msg.plots.plots);
    map.plotsBought = msg.plots.bought;
    showLand();
  }
  if (msg.tiles.length > 0) overlays.onTiles();
  renderer.applySnapshot(msg.snapshot);
  snapshot.value = msg.snapshot;
  loaded();
  sound.onSnapshot(msg.snapshot);
  logFrame(msg.snapshot, msg.events, map);
  overlays.onSnapshot();
  for (const ev of msg.events) {
    if (ev.kind === 'message') pushMessage(ev.text, ev.tone);
    else if (ev.kind === 'tip') advise(ev.id);
    else renderer.showMoney(ev.amount, ev.x, ev.y);
  }
}

if (import.meta.env.DEV) {
  // Handle for poking at the game from the console or a test driver.
  Object.assign(window, {
    __hm: { renderer, send, map: () => map, snapshot, selection, tool, sound, openGuide },
  });
  // Mirror the game into .debug/ for tools outside the browser.
  void import('./debug/bridge').then((b) =>
    b.startBridge({ worker, send, renderer, map: () => map }),
  );
  // Paths, passability, slots and more drawn over the map: Settings, or `.
  void import('./debug/start').then(({ startDebug }) => {
    const dbg = startDebug({
      renderer,
      map: () => map,
      ui: uiRoot,
      request: (want) => worker.postMessage({ type: 'debugView', want } satisfies Command),
    });
    worker.addEventListener('message', (e: MessageEvent<WorkerMessage>) => {
      if (e.data.type === 'debugView') dbg.receive(e.data.view);
    });
  });
}

/** Whether the browser will give the game a WebGL 2 context. */
function webglWorks(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}
