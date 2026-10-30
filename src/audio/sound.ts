import { signal } from '@preact/signals';
import type { Snapshot } from '../protocol';
import type { GameMap } from '../sim/map';
import { railColumn } from '../sim/railway';
import {
  attenuate,
  bed,
  CARRY,
  CueTracker,
  farness,
  hearing,
  nearness,
  panOf,
  PER_SECOND,
  waterNear,
  type Cue,
  type CueKind,
  type Listener,
} from './mix';
import { Synth, type Loop } from './synth';

// The port's soundscape. Zoomed out, the hum of a busy port heard from
// afar, wind and the sea; zoomed in, the particular sounds of what is in
// view: containers landing, engines, reversing beeps, gulls, ships' horns.

export interface SoundSettings {
  on: boolean;
  /** 0 to 1. */
  volume: number;
}

const KEY = 'harbourmaster.sound';

function loadSettings(): SoundSettings {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (s && typeof s.on === 'boolean' && typeof s.volume === 'number') {
      return { on: s.on, volume: Math.min(1, Math.max(0, s.volume)) };
    }
  } catch {
    // No storage here: the defaults.
  }
  return { on: true, volume: 0.6 };
}

export const soundSettings = signal<SoundSettings>(loadSettings());
soundSettings.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Kept for this visit only.
  }
});

/** How loud each kind of one-off sound is, before distance. */
const LEVEL: Record<CueKind, number> = {
  clank: 0.7,
  thunk: 0.45,
  beep: 0.16,
  hiss: 0.22,
  horn: 0.55,
  toot: 0.32,
  trainHorn: 0.35,
};

/** Sounds of the work itself, which fade as the view pulls back; horns carry regardless. */
const NEAR_ONLY: ReadonlySet<CueKind> = new Set(['clank', 'thunk', 'beep', 'hiss']);

const UPDATE_MS = 100;

interface Beds {
  hum: Loop;
  wind: Loop;
  wash: Loop;
  lap: Loop;
  diesel: Loop;
  electric: Loop;
  winch: Loop;
  rumble: Loop;
}

export class Soundscape {
  private synth: Synth | null = null;
  private beds: Beds | null = null;
  private tracker = new CueTracker();
  private snap: Snapshot | null = null;
  /** Sounds of each kind that may still play this second. */
  private tokens = Object.fromEntries(Object.keys(PER_SECOND).map((k) => [k, 1])) as Record<
    CueKind,
    number
  >;
  private trainX = -1;
  private mapSeen: GameMap | null = null;

  constructor(
    private listener: () => Listener,
    private map: () => GameMap | null,
  ) {
    // Browsers only let sound start from something the player does.
    const unlock = () => this.wake();
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    document.addEventListener('visibilitychange', () => this.apply());
    soundSettings.subscribe(() => this.apply());
    setInterval(() => this.update(), UPDATE_MS);
  }

  onSnapshot(s: Snapshot): void {
    this.snap = s;
    const m = this.map();
    if (m !== this.mapSeen) {
      this.mapSeen = m;
      const col = m ? railColumn(m) : -1;
      this.trainX = col >= 0 ? col + 0.5 : -1;
    }
    const cues = this.tracker.update(s, m?.w ?? 1, this.trainX);
    if (this.live() && s.speed > 0) this.play(cues);
  }

  private live(): boolean {
    return (
      this.synth !== null &&
      this.synth.ctx.state === 'running' &&
      soundSettings.value.on &&
      !document.hidden
    );
  }

  private wake(): void {
    if (!soundSettings.value.on) return;
    if (!this.synth) {
      try {
        this.synth = new Synth();
      } catch (err) {
        console.warn('No sound: Web Audio is not available', err);
        return;
      }
      const sea = this.synth.sea();
      this.beds = {
        hum: this.synth.hum(),
        wind: this.synth.wind(),
        wash: sea.wash,
        lap: sea.lap,
        diesel: this.synth.diesel(),
        electric: this.synth.electric(),
        winch: this.synth.winch(),
        rumble: this.synth.rumble(),
      };
    }
    this.apply();
  }

  /** Follow the settings and whether the tab is showing. */
  private apply(): void {
    const s = this.synth;
    if (!s) return;
    const on = soundSettings.value.on && !document.hidden;
    const v = soundSettings.value.volume;
    s.master.gain.setTargetAtTime(on ? v * v : 0, s.now, 0.08);
    if (on && s.ctx.state === 'suspended') void s.ctx.resume();
    if (!on && s.ctx.state === 'running') {
      setTimeout(() => {
        if (!soundSettings.value.on || document.hidden) void s.ctx.suspend();
      }, 400);
    }
  }

  private play(cues: Cue[]): void {
    const s = this.synth!;
    const l = this.listener();
    const near = nearness(l);
    const far = farness(l);
    const zoom = Math.sqrt(Math.min(1, 14 / l.viewSize));
    const heard = cues
      .map((c) => {
        const range = hearing(l) * CARRY[c.kind];
        const a = attenuate(l, c.x, c.y, range);
        const gain = LEVEL[c.kind] * a * (NEAR_ONLY.has(c.kind) ? near * zoom : 0.6 + 0.4 * near);
        const off = Math.hypot(c.x - l.x, c.y - l.y) / range;
        return { c, gain, pan: panOf(l, c.x, c.y, range), far: Math.min(1, far * 0.7 + off * 0.6) };
      })
      .filter((h) => h.gain > 0.004)
      .sort((a, b) => b.gain - a.gain);
    for (const h of heard) {
      if (this.tokens[h.c.kind] < 1) continue;
      this.tokens[h.c.kind]--;
      switch (h.c.kind) {
        case 'clank':
          s.clank(h.gain, h.pan, h.far);
          break;
        case 'thunk':
          s.thunk(h.gain, h.pan, h.far);
          break;
        case 'beep':
          s.beep(h.gain, h.pan, h.far);
          break;
        case 'hiss':
          s.hiss(h.gain, h.pan, h.far);
          break;
        case 'horn':
          s.horn(h.gain, h.pan, h.far, h.c.vessel);
          break;
        case 'toot':
          s.toot(h.gain, h.pan, h.far);
          break;
        case 'trainHorn':
          s.trainHorn(h.gain, h.pan, h.far);
          break;
      }
    }
  }

  private update(): void {
    const dt = UPDATE_MS / 1000;
    for (const k of Object.keys(this.tokens) as CueKind[]) {
      this.tokens[k] = Math.min(Math.max(1, PER_SECOND[k]), this.tokens[k] + PER_SECOND[k] * dt);
    }
    const s = this.synth;
    const b = this.beds;
    const snap = this.snap;
    const m = this.map();
    if (!s || !b || !snap || !m || !this.live()) return;
    const l = this.listener();
    const near = nearness(l);
    const far = farness(l);
    const zoom = Math.sqrt(Math.min(1, 14 / l.viewSize));
    const water = waterNear(m, l);
    const running = snap.speed > 0;
    const mix = bed(snap, l, m.w, this.trainX);
    const t = s.now;
    const set = (loop: Loop, gain: number, pan = 0, lag = 0.3) => {
      loop.gain.gain.setTargetAtTime(gain, t, lag);
      loop.pan.pan.setTargetAtTime(pan, t, lag);
    };
    const act = mix.activity;
    set(b.hum, (0.1 + 0.6 * far) * (0.25 + 0.75 * act) * (running ? 1 : 0.6), 0, 0.8);
    set(b.wind, 0.04 + 0.16 * far, 0, 1);
    set(b.wash, water * (0.1 + 0.1 * far), 0, 1);
    // Waves slap the quay walls in fits and starts.
    set(b.lap, water * near * 0.3 * (0.2 + Math.random() * 0.8), 0, 0.15);
    const work = running ? near * zoom : 0;
    set(b.diesel, mix.diesel.gain * work * 0.38, mix.diesel.pan);
    for (const p of b.diesel.pitch ?? []) {
      p.setTargetAtTime(
        (p === b.diesel.pitch![0] ? 31 : 62.4) * (1 + 0.25 * mix.diesel.gain),
        t,
        0.6,
      );
    }
    set(b.electric, mix.electric.gain * work * 0.06, mix.electric.pan);
    set(b.winch, mix.winch.gain * work * 0.26, mix.winch.pan);
    set(b.rumble, running ? mix.train.gain * (0.35 + 0.25 * near) : 0, mix.train.pan, 0.6);

    if (!running) return;
    // Far off, the work blurs into the odd clang and beep carried on the wind.
    if (Math.random() < act * far * 1.2 * dt) {
      s.clank(0.3 * far * (0.4 + 0.6 * act), (Math.random() * 2 - 1) * 0.6, 1);
    }
    if (Math.random() < act * far * 0.3 * dt) {
      s.beep(0.08 * far, (Math.random() * 2 - 1) * 0.6, 1);
    }
    // Gulls, more over water and close up.
    if (Math.random() < 0.1 * (0.25 + water) * (0.4 + 0.6 * near) * dt) {
      s.gull(0.22 * (0.35 + 0.65 * near), (Math.random() * 2 - 1) * 0.8, far * 0.6);
    }
  }
}
