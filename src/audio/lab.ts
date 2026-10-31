// The sound lab (sounds.html on the dev server, and the Sounds tab of the
// dev page, dev.html): every sound in the game on a button, and every
// engine on a switch, to try out and tune by ear.

import './lab.css';
import { VESSEL_SIZE, type Hull, type RoadEngine } from './mix';
import { Music } from './music';
import type { Band } from './score';
import { CONTAINER_STYLES, roadPitch, Synth, type ContainerStyle, type Loop } from './synth';

let synth: Synth | null = null;
const loops = new Map<string, Loop>();
/** How far off the sounds are, 0 close by to 1 across the water, and to which side. */
let far = 0;
let pan = 0;

function live(): Synth {
  if (!synth) {
    synth = new Synth();
    synth.master.gain.value = 0.7;
  }
  if (synth.ctx.state === 'suspended') void synth.ctx.resume();
  return synth;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

function button(text: string, play: (s: Synth) => void): HTMLButtonElement {
  return el('button', { onclick: () => play(live()) }, text);
}

function slider(
  text: string,
  value: number,
  onInput: (v: number) => void,
  min = 0,
  max = 1,
  step = 0.01,
): HTMLLabelElement {
  const input = el('input', {
    type: 'range',
    min: String(min),
    max: String(max),
    step: String(step),
  });
  input.value = String(value);
  input.oninput = () => onInput(Number(input.value));
  return el('label', {}, text, input);
}

function section(title: string, ...kids: Node[]): HTMLElement {
  return el('section', {}, el('h2', {}, title), ...kids);
}

/** A switch for a continuous sound, with its level and any other controls. */
function loopRow(
  name: string,
  make: (s: Synth) => Loop,
  level: number,
  extra: (loop: () => Loop | undefined) => Node[] = () => [],
): HTMLElement {
  let gain = level;
  const toggle = el('button', {}, 'Off');
  toggle.onclick = () => {
    const s = live();
    let loop = loops.get(name);
    if (!loop) {
      loop = make(s);
      loops.set(name, loop);
    }
    const on = toggle.textContent === 'Off';
    toggle.textContent = on ? 'On' : 'Off';
    toggle.classList.toggle('on', on);
    loop.gain.gain.setTargetAtTime(on ? gain : 0, s.now, 0.3);
    loop.pan.pan.setTargetAtTime(pan, s.now, 0.1);
  };
  const volume = slider('Level', level, (v) => {
    gain = v;
    const loop = loops.get(name);
    if (loop && toggle.textContent === 'On') loop.gain.gain.setTargetAtTime(v, live().now, 0.1);
  });
  return el(
    'div',
    { className: 'engine' },
    el('strong', {}, name),
    el('div', { className: 'controls' }, toggle, volume, ...extra(() => loops.get(name))),
  );
}

function roadRow(kind: RoadEngine, name: string, size: number): HTMLElement {
  return loopRow(
    name,
    (s) => {
      const loop = s.roadEngine(kind);
      pitchTo(loop, roadPitch(kind, size), s);
      return loop;
    },
    0.34,
    (loop) =>
      kind === 'truck'
        ? [
            slider('Size', size, (v) => {
              const l = loop();
              if (l) pitchTo(l, roadPitch(kind, v), live());
            }),
            el('small', {}, 'crate truck → two-box container truck'),
          ]
        : [],
  );
}

function pitchTo(loop: Loop, f: number, s: Synth): void {
  const [a, h, chug, knock] = loop.pitch!;
  a.setTargetAtTime(f, s.now, 0.2);
  h.setTargetAtTime(f * 2.007, s.now, 0.2);
  chug.setTargetAtTime(f / 2.3, s.now, 0.2);
  knock.setTargetAtTime(f * 0.45, s.now, 0.2);
}

/** A yard at work: a container landing every second or so, for a while. */
function busyYard(s: Synth, style: ContainerStyle): void {
  let t = 0;
  for (let k = 0; k < 10; k++) {
    t += 600 + Math.random() * 900;
    const onTruck = Math.random() < 0.3;
    setTimeout(() => s.clank(0.7, (Math.random() * 2 - 1) * 0.6, far, onTruck, style), t);
  }
}

/** Each way a container can sound, to compare; the game plays the muffled thump. */
function containerRows(): HTMLElement[] {
  return CONTAINER_STYLES.map((c) =>
    el(
      'div',
      { className: 'engine' },
      el(
        'div',
        {},
        el('strong', {}, c.name),
        el('br'),
        el('small', {}, c.id === 'thump' ? `${c.note}, in the game` : c.note),
      ),
      el(
        'div',
        { className: 'controls' },
        button('On a stack', (s) => s.clank(0.7, pan, far, false, c.id)),
        button('On a truck', (s) => s.clank(0.7, pan, far, true, c.id)),
        button('A busy yard', (s) => busyYard(s, c.id)),
      ),
    ),
  );
}

function busyQuay(s: Synth): void {
  let t = 0;
  for (let k = 0; k < 10; k++) {
    t += 400 + Math.random() * 700;
    setTimeout(() => s.thunk(0.45, (Math.random() * 2 - 1) * 0.6, far), t);
  }
}

const hulls: [Hull, string][] = [
  ['smack', 'Fishing boat'],
  ['tug', 'Tug'],
  ['coaster', 'Coaster'],
  ['feeder', 'Feeder ship'],
];

let band: Music | null = null;

/** The music on and off, a fresh tune, and which band plays. */
function musicRow(): HTMLElement {
  const toggle = el('button', {}, 'Play');
  let only: Band | null = null;
  const start = () => {
    const s = live();
    s.setLevels(1, 1, 0.5);
    band ??= new Music(s.ctx, s.music, s.wetMusic);
    band.setBand(only);
    band.start();
    toggle.textContent = 'Stop';
    toggle.classList.add('on');
  };
  toggle.onclick = () => {
    if (band?.playing) {
      band.stop();
      toggle.textContent = 'Play';
      toggle.classList.remove('on');
    } else start();
  };
  const bands = el('select', {});
  for (const [id, name] of [
    ['', 'Each tune its own band'],
    ['synth', 'Made in code'],
    ['parlour', 'Upright piano and vibraphone'],
    ['fm', 'FM piano and marimba'],
    ['island', 'Marimba and kalimba'],
  ]) {
    bands.append(el('option', { value: id }, name));
  }
  bands.onchange = () => {
    only = (bands.value || null) as Band | null;
    band?.setBand(only);
    band?.nextTune();
  };
  return el(
    'div',
    { className: 'row' },
    toggle,
    el(
      'button',
      {
        onclick: () => {
          if (!band?.playing) start();
          band?.nextTune();
        },
      },
      'Another tune',
    ),
    bands,
    slider('Music level', 0.5, (v) => live().setLevels(1, 1, v * v)),
  );
}

/** Build the sound lab into `lab`. */
export function soundLab(lab: HTMLElement): void {
  lab.classList.add('sound-lab');
  lab.append(
    el('h1', {}, 'Sound lab'),
    el(
      'p',
      { className: 'lead' },
      'Every sound in the game, made in code. Click anything to hear it; engines and beds run until switched off. ',
      'The distance slider plays them as from across the water.',
    ),
    section(
      'Where you are listening from',
      el(
        'div',
        { className: 'row' },
        slider('Distance', 0, (v) => (far = v)),
        slider('Left / right', 0, (v) => (pan = v), -1, 1),
        slider('Volume', 0.7, (v) => (live().master.gain.value = v)),
      ),
    ),
    section('Music', musicRow()),
    section('Containers (steel)', ...containerRows()),
    section(
      'Crates and pallets (wood)',
      el(
        'div',
        { className: 'row' },
        button('Set down', (s) => s.thunk(0.45, pan, far)),
        button('A busy quay', busyQuay),
      ),
    ),
    section(
      'Horns, as each ship sails',
      el(
        'div',
        { className: 'row' },
        ...hulls.map(([h, name]) => button(name, (s) => s.horn(0.55, pan, far, VESSEL_SIZE[h]))),
        button('Train', (s) => s.trainHorn(0.35, pan, far)),
      ),
    ),
    section(
      'Ships’ engines under way',
      ...hulls.map(([h, name]) => loopRow(name, (s) => s.shipEngine(h), 0.35)),
    ),
    section(
      'Engines on land',
      roadRow('truck', 'Truck', 0.3),
      roadRow('tractor', 'Terminal tractor', 0.5),
      roadRow('stacker', 'Reach stacker', 0.8),
      loopRow('Forklift', (s) => s.electric(), 0.06),
      loopRow('Crane winch', (s) => s.winch(), 0.26),
    ),
    section(
      'Other sounds',
      el(
        'div',
        { className: 'row' },
        button('Reversing beep', (s) => s.beep(0.16, pan, far)),
        button('Air brakes', (s) => s.hiss(0.22, pan, far)),
      ),
    ),
    section(
      'The port from afar',
      loopRow('Port hum', (s) => s.hum(), 0.4),
      loopRow('Sea', (s) => s.sea(), 0.15),
      loopRow('Train going by', (s) => s.rumble(), 0.4),
    ),
  );
}

/**
 * For tuning without ears: render each one-off sound offline and report
 * how loud it peaks and on average, `?measure` or from the console.
 */
async function measure(): Promise<Record<string, { peak: number; rms: number }>> {
  const out: Record<string, { peak: number; rms: number }> = {};
  const cases: [string, (s: Synth) => void, number][] = [
    ...CONTAINER_STYLES.flatMap((c) => [
      [`clank ${c.id}`, (s: Synth) => s.clank(0.7, 0, 0, false, c.id), 3] as [
        string,
        (s: Synth) => void,
        number,
      ],
      [`clank ${c.id} truck`, (s: Synth) => s.clank(0.7, 0, 0, true, c.id), 3] as [
        string,
        (s: Synth) => void,
        number,
      ],
    ]),
    ['thunk', (s) => s.thunk(0.45, 0, 0), 1.5],
    ...hulls.map(
      ([h]) =>
        [`horn ${h}`, (s: Synth) => s.horn(0.55, 0, 0, VESSEL_SIZE[h]), 7] as [
          string,
          (s: Synth) => void,
          number,
        ],
    ),
    ['beep', (s) => s.beep(0.16, 0, 0), 2.5],
    ['trainHorn', (s) => s.trainHorn(0.35, 0, 0), 4],
  ];
  for (const [name, play, seconds] of cases) {
    const ctx = new OfflineAudioContext(2, Math.ceil(44100 * seconds), 44100);
    const s = new Synth(ctx);
    s.master.gain.value = 1;
    play(s);
    const buf = await ctx.startRendering();
    const d = buf.getChannelData(0);
    let peak = 0;
    let sum = 0;
    for (const v of d) {
      peak = Math.max(peak, Math.abs(v));
      sum += v * v;
    }
    out[name] = { peak: +peak.toFixed(3), rms: +Math.sqrt(sum / d.length).toFixed(4) };
  }
  for (const [name, make] of [
    ...hulls.map(([h]) => [`engine ${h}`, (s: Synth) => s.shipEngine(h)] as const),
    ...(['truck', 'tractor', 'stacker'] as RoadEngine[]).map(
      (k) => [`engine ${k}`, (s: Synth) => s.roadEngine(k)] as const,
    ),
  ]) {
    const ctx = new OfflineAudioContext(2, 44100 * 2, 44100);
    const s = new Synth(ctx);
    s.master.gain.value = 1;
    const loop = make(s);
    loop.gain.gain.value = 0.35;
    const buf = await ctx.startRendering();
    const d = buf.getChannelData(0);
    let peak = 0;
    let sum = 0;
    for (const v of d.subarray(44100)) {
      peak = Math.max(peak, Math.abs(v));
      sum += v * v;
    }
    out[name] = { peak: +peak.toFixed(3), rms: +Math.sqrt(sum / 44100).toFixed(4) };
  }
  return out;
}

(window as unknown as { __measure: typeof measure }).__measure = measure;

/**
 * The sea on its own, rendered offline at the game's levels zoomed out by
 * the water, from the console: `__renderSea(30)` gives it as a WAV in
 * base64, to listen to, and how loud it is every half second.
 */
async function renderSea(seconds: number, level = 0.28): Promise<{ env: string; wav: string }> {
  const rate = 44100;
  const ctx = new OfflineAudioContext(2, Math.ceil(rate * seconds), rate);
  const s = new Synth(ctx);
  s.master.gain.value = 1;
  s.sea(seconds + 1).gain.gain.value = level;
  const buf = await ctx.startRendering();
  const n = buf.length;
  const l = buf.getChannelData(0);
  const r = buf.getChannelData(1);
  const bytes = new Uint8Array(44 + n * 4);
  const v = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + n * 4, true);
  ascii(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, n * 4, true);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
    v.setInt16(44 + i * 4, Math.max(-1, Math.min(1, l[i])) * 32767, true);
    v.setInt16(46 + i * 4, Math.max(-1, Math.min(1, r[i])) * 32767, true);
  }
  const lines = [`peak ${peak.toFixed(3)}`];
  const step = rate / 2;
  for (let at = 0; at + step <= n; at += step) {
    let sl = 0;
    let sr = 0;
    for (let i = at; i < at + step; i++) {
      sl += l[i] * l[i];
      sr += r[i] * r[i];
    }
    lines.push(
      `${(at / rate).toFixed(1)}s L ${Math.sqrt(sl / step).toFixed(4)} R ${Math.sqrt(sr / step).toFixed(4)}`,
    );
  }
  let b64 = '';
  for (let i = 0; i < bytes.length; i += 32766) {
    b64 += btoa(String.fromCharCode(...bytes.subarray(i, i + 32766)));
  }
  return { env: lines.join('\n'), wav: b64 };
}

(window as unknown as { __renderSea: typeof renderSea }).__renderSea = renderSea;

const page = document.getElementById('lab');
if (page) soundLab(page);
