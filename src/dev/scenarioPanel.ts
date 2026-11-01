import { walkableAt } from '../sim/rules';
import { pushMessage, hover } from '../ui/store';
import { button, el, select, slider } from './controls';
import {
  SCENARIO_PRESETS,
  apply,
  bayAt,
  blank,
  isScenario,
  patch,
  presetScenario,
  replay,
  type LabStep,
  type Scenario,
  type Step,
} from './scenario';
import type { Runner } from './scenes';

// The Scenes tab's mini scenarios (scenario.ts): start one from a preset,
// put things on it by hand (the game's own build bar, or the lab's tools
// here, which act on the tile clicked), and save its steps to replay.

type Tool = 'crates' | 'cratesOut' | 'dockhand' | null;

const TOOL_HINT: Record<Exclude<Tool, null>, string> = {
  crates: 'Click a truck bay or crate storage to set crates down in it (Esc to stop).',
  cratesOut: 'Click crate storage for cargo going out to set crates down in it (Esc to stop).',
  dockhand: 'Click a port path, road, quay or jetty to put a dockhand there (Esc to stop).',
};

export function scenarioSection(
  game: HTMLElement,
  runner: () => Runner | null,
  say: (text: string) => void,
): HTMLElement {
  let preset = SCENARIO_PRESETS[1];
  let crates = 6;
  let tool: Tool = null;
  const note = el('p', { className: 'lab-note' }, preset.note);
  const steps = el('span', { className: 'lab-tick' });
  const showSteps = () => {
    const sc = runner()?.scenario;
    steps.textContent = sc
      ? `“${sc.name}”: ${sc.steps.length} steps, seed ${sc.seed}, tier ${sc.tier}`
      : 'Not a scenario: start one to record its steps.';
  };

  /** Play this scenario from where its steps leave it, recording what is done to it. */
  const play = (sc: Scenario) => {
    const r = runner();
    if (!r) return;
    const w = replay(sc, (s, err) => say(`A step failed at tick ${s.at}: ${String(err)}`));
    r.start(w);
    r.scenario = sc;
    r.onRecord = showSteps;
    const { shore, row } = patch(w);
    r.renderer.cam.lookAt(shore - 2, row - 1);
    r.renderer.cam.setViewSize(16);
    showSteps();
  };

  /** Take a lab step on the running scenario now, and record it. */
  const take = (s: LabStep) => {
    const r = runner();
    const w = r?.world;
    const sc = r?.scenario;
    if (!r || !w || !sc) return say('Start a mini scenario first.');
    const step = { ...s, at: w.tick } as Step;
    const text = apply(w, step);
    sc.steps.push(step);
    say(text);
    pushMessage(text, 'info');
    r.step(0);
    showSteps();
  };

  // ── Picking where on the map a tool goes ──
  const toolButtons = new Map<Exclude<Tool, null>, HTMLButtonElement>();
  const arm = (t: Tool) => {
    tool = tool === t ? null : t;
    for (const [k, b] of toolButtons) b.classList.toggle('lab-primary', k === tool);
    say(tool ? TOOL_HINT[tool] : 'Tool put away.');
  };
  const onMap = (e: PointerEvent) => {
    if (!tool || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    if (e.type !== 'pointerdown') return;
    const w = runner()?.world;
    const h = hover.value;
    if (!w || !h) return;
    const i = w.map.idx(h.x, h.y);
    if (tool === 'dockhand') {
      if (!walkableAt(w.map, i))
        return say('Dockhands stand on port paths, roads, quays or jetties.');
      take({ lab: 'dockhand', tile: i });
    } else {
      if (!bayAt(w, i)) return say('That is no truck bay or crate storage.');
      take({ lab: 'crates', tile: i, n: crates, out: tool === 'cratesOut' });
    }
  };
  game.addEventListener('pointerdown', onMap, true);
  game.addEventListener('pointerup', onMap, true);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && tool) arm(null);
  });
  for (const [t, label] of [
    ['crates', 'Put crates'],
    ['cratesOut', 'Put crates going out'],
    ['dockhand', 'Put a dockhand'],
  ] as const) {
    const b = button(label, () => arm(t));
    toolButtons.set(t, b);
  }

  // ── Saving and loading ──
  const save = button('Save to JSON', () => {
    const sc = runner()?.scenario;
    if (!sc) return say('Start a mini scenario first.');
    const blob = new Blob([JSON.stringify(sc, null, 1)], { type: 'application/json' });
    const a = el('a', {
      href: URL.createObjectURL(blob),
      download: `scenario-${sc.name.replace(/[^\w]+/g, '-').toLowerCase()}.json`,
    });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  const file = el('input', { type: 'file', accept: '.json,application/json' });
  file.onchange = async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text()) as unknown;
      if (!isScenario(data)) throw new Error('not a scenario file');
      play(data);
      say(`Replayed ${f.name}: ${data.steps.length} steps.`);
    } catch (err) {
      say(`Could not load ${f.name}: ${String(err)}`);
    }
    file.value = '';
  };

  const root = el(
    'div',
    {},
    select(
      'Preset',
      SCENARIO_PRESETS.map((p) => [p.id, p.name]),
      preset.id,
      (id) => {
        preset = SCENARIO_PRESETS.find((p) => p.id === id)!;
        note.textContent = preset.note;
      },
    ),
    note,
    el(
      'div',
      { className: 'lab-row' },
      button(
        'Build it',
        () => {
          try {
            play(presetScenario(preset));
            say(`Built “${preset.name}”, paused: run it from Run below.`);
          } catch (err) {
            say(`Could not build it: ${String(err)}`);
            console.error(err);
          }
        },
        'lab-primary',
      ),
      button('Replay from its steps', () => {
        const sc = runner()?.scenario;
        if (!sc) return say('Start a mini scenario first.');
        play(sc);
        say('Replayed: the port as its last step left it, paused.');
      }),
      button('Undo last step', () => {
        const sc = runner()?.scenario;
        if (!sc?.steps.length) return say('No steps to undo.');
        sc.steps.pop();
        play(sc);
        say('Took the last step back and replayed the rest.');
      }),
    ),
    steps,
    el('p', { className: 'lab-note' }, 'Build on it from the game’s build bar, or:'),
    slider('Crates', crates, (v) => (crates = v), 1, 30, 1),
    el('div', { className: 'lab-row' }, ...toolButtons.values()),
    el(
      'div',
      { className: 'lab-row' },
      button('Fishing boat with the crates', () => take({ lab: 'boat', vessel: 'smack', crates })),
      button('Coaster with the crates', () => take({ lab: 'boat', vessel: 'coaster', crates })),
      button('Call trucks now', () => take({ lab: 'truck' })),
    ),
    el('div', { className: 'lab-row' }, save, file),
  );
  showSteps();
  // Another game started from the tab is no scenario.
  setInterval(showSteps, 1000);
  // A handle for a driver or the console: build and replay scenarios.
  Object.assign(window, {
    __scenario: { play, take, presetScenario, blank, presets: SCENARIO_PRESETS },
  });
  return root;
}
