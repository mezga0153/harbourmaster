import { h, render } from 'preact';
import { BufferGeometry, Float32BufferAttribute, Group, Line, LineBasicMaterial } from 'three';
import { Soundscape } from '../audio/sound';
import { collect } from '../debug/collect';
import { startDebug } from '../debug/start';
import type { DebugWant } from '../debug/types';
import { Input } from '../input';
import type { Command, Snapshot } from '../protocol';
import { Renderer } from '../render/renderer';
import { nextPrice, ownedPlots } from '../sim/land';
import { GameMap } from '../sim/map';
import { harbourCentre } from '../sim/rules/harbour';
import { docks } from '../sim/systems/boats/berthing';
import { TICKS_PER_DAY } from '../sim/types';
import { World, type SaveData } from '../sim/world';
import { App } from '../ui/App';
import type { Actions } from '../ui/actions';
import { downloadSave } from '../ui/download';
import { wireOverlays } from '../ui/mapOverlays';
import { graphics } from '../ui/prefs';
import { advise, land, pushMessage, seed, selection, snapshot } from '../ui/store';
import { button, defaults, el, paramPanel, select, toggle, type Params } from './controls';
import { PRESETS, sendBoat, sendTug } from './situations';

// The Scenes tab: the whole game, drawn and played as it is, with the sim
// run here on the page rather than in its worker, so a port can be set up
// in any situation (src/dev/situations.ts) and boats, tugs and trains sent
// into it while it runs, a tick at a time if need be.

const LOOP_MS = 100;

class Runner {
  world: World | null = null;
  map: GameMap | null = null;
  readonly renderer: Renderer;
  private input: Input;
  private overlays: ReturnType<typeof wireOverlays>;
  /** Where every boat under way plots it will be. */
  private courses = new Group();
  private courseOf = new Map<number, Line>();
  showCourses = false;
  /** Keys and commands are taken only while the tab is showing. */
  active = false;
  onFrame?: (s: Snapshot) => void;
  /** The debug overlays (src/debug/), and what they want of the sim each frame. */
  private debug: ReturnType<typeof startDebug>;
  private debugWant: DebugWant | null = null;

  constructor(game: HTMLElement, floaters: HTMLElement, hud: HTMLElement) {
    this.renderer = new Renderer(game, floaters);
    this.input = new Input(
      this.renderer,
      () => this.map,
      (cmd) => this.send(cmd),
    );
    new Soundscape(
      () => {
        const c = this.renderer.cam;
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
      () => this.map,
    );
    graphics.subscribe((g) => this.renderer.setGraphics(g));
    this.overlays = wireOverlays(this.renderer, () => this.map);
    this.renderer.overlay.group.add(this.courses);
    this.debug = startDebug({
      renderer: this.renderer,
      map: () => this.map,
      ui: hud.parentElement ?? hud,
      request: (want) => {
        this.debugWant = want;
        if (want && this.world) this.debug?.receive(collect(this.world, want));
      },
    });
    const actions: Actions = {
      send: (cmd) => this.send(cmd),
      setSpeed: (s) => this.input.setSpeed(s),
      togglePause: () => this.input.togglePause(),
      focus: (x, y) => this.renderer.cam.target.set(x, 0, y),
      rotateView: (dir) => this.renderer.cam.rotate(dir),
      zoom: (f) => this.renderer.cam.zoom(f),
      rotateBuilding: () => this.input.rotate(),
    };
    render(h(App, { actions }), hud);
    setInterval(() => this.loop(), LOOP_MS);
  }

  /** Play this game from here. */
  start(w: World): void {
    this.world = w;
    this.map = GameMap.fromData(w.map.toData());
    w.drainTileChanges();
    w.drainPlotChanges();
    seed.value = w.seed;
    selection.value = null;
    this.renderer.setMap(this.map);
    this.showLand();
    this.lookAtHarbour();
    this.frame();
  }

  /** The view over the harbour, where the boats are. */
  lookAtHarbour(): void {
    const w = this.world;
    if (!w) return;
    const b = w.boats.find((b) => b.state !== 'approaching') ?? w.boats[0];
    const d = docks(w)[0]?.tiles[0];
    const at = b
      ? { x: b.x, y: b.y }
      : d !== undefined
        ? { x: w.map.xOf(d) + 0.5, y: w.map.yOf(d) + 0.5 }
        : harbourCentre(w.map);
    this.renderer.cam.lookAt(at.x, at.y);
    this.renderer.cam.setViewSize(26);
  }

  send(cmd: Command): void {
    if (!this.active) return;
    const w = this.world;
    if (cmd.type === 'newGame')
      return this.start(World.create(cmd.seed ?? Math.floor(Math.random() * 1_000_000)));
    if (!w) return;
    if (cmd.type === 'save')
      return pushMessage('Lab games are not saved: download one from Settings instead.', 'info');
    if (cmd.type === 'exportSave' || cmd.type === 'dumpSave') return downloadSave(w.toSave());
    if (cmd.type === 'importSave' || cmd.type === 'loadSave') {
      try {
        if (!World.isValidSave(cmd.save)) throw new Error('not a save this version can read');
        this.start(World.fromSave(cmd.save));
      } catch (err) {
        pushMessage(`Could not load that: ${String(err)}`, 'bad');
      }
      return;
    }
    if (cmd.type === 'debug') return w.debug(cmd);
    w.command(cmd);
  }

  /** Run the game on by `ticks`, however fast it is set to run, and draw it. */
  step(ticks: number): void {
    const w = this.world;
    if (!w) return;
    try {
      for (let k = 0; k < ticks; k++) w.step();
    } catch (err) {
      console.error(err);
      pushMessage(`The sim threw: ${String(err)}`, 'bad');
      w.speed = 0;
    }
    this.frame();
  }

  private loop(): void {
    const w = this.world;
    if (!w || !this.active) return;
    this.step(w.speed);
  }

  private frame(): void {
    const w = this.world;
    const map = this.map;
    if (!w || !map) return;
    const s = w.snapshot();
    const tiles = w.drainTileChanges();
    const plots = w.drainPlotChanges();
    const events = w.drainEvents();
    let treesChanged = false;
    let terrainChanged = false;
    let seaChanged = false;
    for (const c of tiles) {
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
    this.renderer.applyTiles(tiles, treesChanged, terrainChanged, seaChanged);
    if (plots) {
      map.plots.set(plots.plots);
      map.plotsBought = plots.bought;
      this.showLand();
    }
    if (tiles.length > 0) this.overlays.onTiles();
    this.renderer.applySnapshot(s);
    snapshot.value = s;
    this.overlays.onSnapshot();
    this.drawCourses(s);
    if (this.debugWant) this.debug.receive(collect(w, this.debugWant));
    for (const ev of events) {
      if (ev.kind === 'message') pushMessage(ev.text, ev.tone);
      else if (ev.kind === 'tip') advise(ev.id);
      else this.renderer.showMoney(ev.amount, ev.x, ev.y);
    }
    this.onFrame?.(s);
  }

  private showLand(): void {
    const map = this.map;
    if (!map) return;
    land.value = {
      owned: ownedPlots(map),
      next: nextPrice(map),
      nextSea: nextPrice(map, true),
      after: nextPrice(map, false, 1),
    };
    this.input.refreshLand();
  }

  private drawCourses(s: Snapshot): void {
    const boats = this.showCourses
      ? s.entities.filter((e) => e.kind === 'boat' && e.plot && e.plot.length >= 4)
      : [];
    const seen = new Set(boats.map((b) => b.id));
    for (const [id, line] of this.courseOf) {
      if (seen.has(id)) continue;
      this.courses.remove(line);
      line.geometry.dispose();
      this.courseOf.delete(id);
    }
    for (const b of boats) {
      let line = this.courseOf.get(b.id);
      if (!line) {
        line = new Line(
          new BufferGeometry(),
          new LineBasicMaterial({ color: 0xffd23f, depthTest: false }),
        );
        line.renderOrder = 10;
        this.courses.add(line);
        this.courseOf.set(b.id, line);
      }
      const pos: number[] = [];
      for (let j = 0; j + 1 < b.plot!.length; j += 2) pos.push(b.plot![j], 0.08, b.plot![j + 1]);
      line.geometry.setAttribute('position', new Float32BufferAttribute(pos, 3));
      line.geometry.computeBoundingSphere();
    }
  }
}

export function scenesTab(): HTMLElement & { activate(on: boolean): void } {
  const root = el('div', { className: 'lab-scenes' });
  const game = el('div', { id: 'game' });
  const ui = el('div', { id: 'ui' });
  const floaters = el('div', { className: 'floaters' });
  const hud = el('div', { className: 'hud' });
  ui.append(floaters, hud);
  const drawer = el('div', { className: 'lab-drawer panel' });
  root.append(game, ui, drawer);

  let runner: Runner | null = null;
  const status = el('div', { className: 'lab-status' });

  // ── Which port to start from ──
  let preset = PRESETS[0];
  let values: Params = defaults(preset.params);
  let presetParams = paramPanel(
    preset.params,
    values,
    () => {},
    () => {},
  );
  const note = el('p', { className: 'lab-note' }, preset.note);
  const presetBox = el('div', {});
  const pick = select(
    'Port',
    PRESETS.map((p) => [p.id, p.name]),
    preset.id,
    (id) => {
      preset = PRESETS.find((p) => p.id === id)!;
      values = defaults(preset.params);
      note.textContent = preset.note;
      presetParams.replaceWith(
        (presetParams = paramPanel(
          preset.params,
          values,
          () => {},
          () => {},
        )),
      );
    },
  );
  let building = false;
  const start = button(
    'Start',
    async () => {
      if (building || !runner) return;
      building = true;
      start.disabled = true;
      try {
        const w = await preset.build(values, (t) => (status.textContent = t));
        runner.start(w);
        status.textContent = `Started: ${preset.name}, seed ${w.seed}.`;
      } catch (err) {
        status.textContent = `Could not build it: ${String(err)}`;
        console.error(err);
      }
      building = false;
      start.disabled = false;
    },
    'primary',
  );
  presetBox.append(pick, note, presetParams, start);

  // ── Or carry on from a save ──
  const file = el('input', { type: 'file', accept: '.json,application/json' });
  file.onchange = async () => {
    const f = file.files?.[0];
    if (!f || !runner) return;
    try {
      const data = JSON.parse(await f.text()) as unknown;
      if (!World.isValidSave(data)) throw new Error('not a save this version can read');
      runner.start(World.fromSave(data));
      status.textContent = `Loaded ${f.name}.`;
    } catch (err) {
      status.textContent = `Could not load ${f.name}: ${String(err)}`;
    }
  };
  const devGame = button('The dev game (.debug/save.json)', async () => {
    if (!runner) return;
    try {
      const r = await fetch('/.debug/save.json', { cache: 'no-store' });
      if (!r.ok) throw new Error(`${r.status}: run the game in another tab first`);
      const data = (await r.json()) as SaveData;
      if (!World.isValidSave(data)) throw new Error('not a save this version can read');
      runner.start(World.fromSave(data));
      status.textContent = 'Loaded the dev game as last mirrored.';
    } catch (err) {
      status.textContent = `Could not load the dev game: ${String(err)}`;
    }
  });

  // ── Running it ──
  const tick = el('span', { className: 'lab-tick' });
  const run = el(
    'div',
    { className: 'lab-row' },
    button('Pause', () => runner?.send({ type: 'setSpeed', speed: 0 })),
    ...[1, 2, 4, 8].map((s) => button(`${s}×`, () => runner?.send({ type: 'setSpeed', speed: s }))),
    button('+1 tick', () => runner?.step(1)),
    button('+10', () => runner?.step(10)),
    button('+100', () => runner?.step(100)),
    tick,
  );

  // ── What to send into it ──
  let close = false;
  const say = (text: string) => {
    status.textContent = text;
    pushMessage(text, 'info');
  };
  const wrap = (f: (w: World) => string) => () => {
    if (!runner?.world) return (status.textContent = 'Start a port first.');
    say(f(runner.world));
    runner.step(0);
  };
  const sendRow = el(
    'div',
    { className: 'lab-row' },
    button(
      'Fishing boat',
      wrap((w) => sendBoat(w, 'smack', close)),
    ),
    button(
      'Lobster boat',
      wrap((w) => sendBoat(w, 'smack', close, true)),
    ),
    button(
      'Coaster',
      wrap((w) => sendBoat(w, 'coaster', close)),
    ),
    button(
      'Feeder ship',
      wrap((w) => sendBoat(w, 'feeder', close)),
    ),
    button(
      '3 fishing boats',
      wrap((w) => [0, 1, 2].map(() => sendBoat(w, 'smack', close)).join('; ')),
    ),
    toggle('From just off the anchorage', false, (v) => (close = v)),
    button('A tug', wrap(sendTug)),
    button(
      'The train',
      wrap((w) => (w.debug({ type: 'debug', train: true }), 'The train is on its way')),
    ),
    button(
      '+$1M',
      wrap((w) => (w.debug({ type: 'debug', cash: 1_000_000 }), 'A million in the bank')),
    ),
    select(
      'Tier',
      [0, 1, 2, 3, 4].map((t) => [String(t), `Tier ${t}`]),
      '0',
      (t) => runner?.world?.debug({ type: 'debug', tier: Number(t) }),
    ),
    toggle('Show every boat’s course', false, (v) => runner && (runner.showCourses = v)),
    button('Look at the harbour', () => runner?.lookAtHarbour()),
  );

  // ── The boats, as the sim and the view have them ──
  const boats = el('table', { className: 'lab-boats' });
  const listBoats = (s: Snapshot) => {
    const w = runner?.world;
    if (!w) return;
    tick.textContent = `day ${Math.floor(s.tick / TICKS_PER_DAY) + 1}, tick ${s.tick % TICKS_PER_DAY}, ${s.speed}× · ${w.boats.length} boats, ${w.tugs.length} tugs`;
    const rows = s.entities
      .filter((e) => e.kind === 'boat')
      .map((e) => {
        const b = w.boats.find((b) => b.id === e.id);
        const v = e.visit;
        const held = v?.heldBy ? `held by ${v.heldBy} for ${v.heldFor} ticks` : '';
        const giving = e.givingWayTo !== undefined ? `giving way to #${e.givingWayTo}` : '';
        const tr = el(
          'tr',
          {
            className:
              selection.value?.type === 'entity' && selection.value.id === e.id ? 'on' : '',
          },
          el('td', {}, `#${e.id}`),
          el('td', {}, `${e.vessel}${e.catch === 'lobster' ? ' (lobster)' : ''}`),
          el('td', {}, b?.state ?? '?'),
          el('td', {}, e.activity),
          el('td', { className: 'lab-why' }, [e.why, giving, held].filter(Boolean).join(' · ')),
        );
        tr.onclick = () => {
          selection.value = { type: 'entity', id: e.id };
          runner?.renderer.cam.flyTo(e.x, e.y, 14);
        };
        return tr;
      });
    boats.replaceChildren(
      el(
        'tr',
        {},
        el('th', {}, 'Boat'),
        el('th', {}, 'Kind'),
        el('th', {}, 'State'),
        el('th', {}, 'Doing'),
        el('th', {}, 'Held up by'),
      ),
      ...rows,
    );
  };

  const section = (title: string, ...kids: (Node | string)[]) =>
    el('section', {}, el('h2', {}, title), ...kids);
  const shut = button('Hide', () => drawer.classList.toggle('lab-shut'));
  drawer.append(
    el('div', { className: 'lab-head' }, el('strong', {}, 'Scene lab'), shut),
    el(
      'div',
      { className: 'lab-body' },
      section('Start from', presetBox, el('div', { className: 'lab-row' }, devGame, file)),
      section('Run', run),
      section('Send in', sendRow),
      status,
      section('Boats', boats),
    ),
  );

  let on = false;
  return Object.assign(root, {
    /** Start from the preset named in the page's address (#scenes/busy). */
    open(id?: string) {
      if (!id || !PRESETS.some((p) => p.id === id)) return;
      pick.querySelector('select')!.value = id;
      pick.querySelector('select')!.dispatchEvent(new Event('change'));
      start.click();
    },
    activate(show: boolean) {
      on = show;
      if (show && !runner) {
        runner = new Runner(game, floaters, hud);
        // A handle for poking at the scene from the console or a test driver.
        Object.assign(window, { __scene: runner });
        runner.onFrame = listBoats;
        runner.active = true;
        status.textContent = 'Pick a port and start it, or load a save.';
      }
      if (runner) runner.active = on;
      if (show) window.dispatchEvent(new Event('resize'));
    },
  });
}
