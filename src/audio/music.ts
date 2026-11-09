// Plays the music score.ts writes, on a little band made in Web Audio: an
// electric piano, a round bass, a vibraphone for the tune, a soft pad and
// brushed percussion, like an old General MIDI soundtrack heard through a
// warm speaker. No sound files, in keeping with the rest of the sound.

import { SAMPLES, type Instrument } from './samples';
import { Composer, type Band, type Bar, type Note, type Voice } from './score';

/** How far ahead notes are put on the clock, in seconds: enough to ride out a slow frame. */
const AHEAD = 0.6;
const TICK_MS = 120;

/** Each instrument's level in the mix. */
const LEVEL: Record<Voice, number> = {
  keys: 0.1,
  bass: 0.2,
  lead: 0.13,
  pad: 0.035,
  kick: 0.32,
  shaker: 0.035,
  rim: 0.06,
};

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/**
 * The recorded bands: which instrument plays which part. The bass and the
 * kick are always the ones made in code; anything not listed too.
 */
export const BAND_PARTS: Record<Band, Partial<Record<Voice, Instrument>>> = {
  synth: {},
  parlour: { keys: 'piano', lead: 'vibes', shaker: 'shaker', rim: 'claves' },
  fm: { keys: 'fmpiano', lead: 'marimba', shaker: 'shaker', rim: 'claves' },
  island: { keys: 'marimba', lead: 'kalimba', shaker: 'shaker', rim: 'claves' },
};

/**
 * Each recorded instrument: how loud, to sound as loud over a note's first
 * moments as the band made in code (the recordings all peak alike, but some
 * ring on louder than others; measured), and how quickly a note dies away
 * once let go, in seconds.
 */
const RECORDED: Record<Instrument, { level: number; release: number }> = {
  piano: { level: 3.9, release: 0.25 },
  fmpiano: { level: 3, release: 0.3 },
  vibes: { level: 1.7, release: 0.7 },
  marimba: { level: 2.8, release: 0.4 },
  kalimba: { level: 4.3, release: 0.6 },
  shaker: { level: 4.3, release: 0.05 },
  claves: { level: 4.6, release: 0.05 },
};

export class Music {
  private composer = new Composer();
  /** When the next bar starts, on the audio clock; null while stopped. */
  private nextBar: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private noise: AudioBuffer;
  /** Into the room, for the keys, the tune and the pad. */
  private room: GainNode;
  /** The recorded notes, by instrument, as they come in. */
  private recorded = new Map<Instrument, { key: number | string; buffer: AudioBuffer }[]>();
  private loading = new Map<Instrument, Promise<void>>();

  constructor(
    private ctx: BaseAudioContext,
    private out: AudioNode,
    send?: AudioNode,
  ) {
    const len = Math.floor(ctx.sampleRate * 0.5);
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.room = ctx.createGain();
    this.room.gain.value = 0.35;
    if (send) this.room.connect(send);
  }

  /** Only this band from the next tune on, or each tune its own (null). */
  setBand(band: Band | null): void {
    this.composer.only = band;
  }

  /** On to a fresh tune at the next bar. */
  nextTune(): void {
    this.composer.skip();
  }

  get playing(): boolean {
    return this.nextBar !== null;
  }

  /** Strike up, from a moment from now. */
  start(): void {
    this.load();
    if (this.timer) return;
    this.nextBar = this.ctx.currentTime + 0.3;
    this.timer = setInterval(() => this.schedule(), TICK_MS);
    this.schedule();
  }

  /** Stop where it is; anything already sounding rings out. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.nextBar = null;
  }

  /** Put every bar that starts before long on the clock. */
  private schedule(): void {
    if (this.nextBar === null) return;
    const now = this.ctx.currentTime;
    // Fallen far behind, as after the tab slept: pick up from now.
    if (this.nextBar < now - 1) this.nextBar = now + 0.1;
    while (this.nextBar < now + AHEAD) {
      const bar = this.composer.next();
      this.playBar(bar, this.nextBar);
      this.nextBar += (bar.beats * 60) / bar.tempo;
    }
  }

  /**
   * Fetch the recorded instruments, once, in the background. Until an
   * instrument is in, the band made in code plays its part.
   */
  private load(): void {
    if (typeof fetch !== 'function') return;
    for (const inst of Object.keys(SAMPLES) as Instrument[]) {
      if (!this.loading.has(inst))
        void this.loadInstrument(inst).catch((err) =>
          console.warn('Music: playing on without', inst, err),
        );
    }
  }

  /** Let the lab wait for a recorded band without starting the game's composer. */
  async prepare(band: Band): Promise<void> {
    await Promise.all(Object.values(BAND_PARTS[band]).map((inst) => this.loadInstrument(inst)));
  }

  private loadInstrument(inst: Instrument): Promise<void> {
    if (this.recorded.has(inst)) return Promise.resolve();
    const pending = this.loading.get(inst);
    if (pending) return pending;
    const base = import.meta.env?.BASE_URL ?? '/';
    const keys: readonly (number | string)[] = SAMPLES[inst];
    const loading = Promise.all(
      keys.map(async (key) => {
        const res = await fetch(`${base}music/${inst}/${key}.mp3`);
        if (!res.ok) throw new Error(`${inst} ${key}: ${res.status}`);
        return { key, buffer: await this.ctx.decodeAudioData(await res.arrayBuffer()) };
      }),
    ).then((notes) => {
      this.recorded.set(inst, notes);
    });
    this.loading.set(inst, loading);
    return loading;
  }

  /** Every note of a bar, put on the clock from `t0`. */
  playBar(bar: Bar, t0: number): void {
    const beat = 60 / bar.tempo;
    for (const n of bar.notes) this.play(n, t0 + n.at * beat, n.dur * beat, bar.band);
  }

  private play(n: Note, t: number, dur: number, band: Band = 'synth'): void {
    const v = n.vel * LEVEL[n.voice];
    const inst = BAND_PARTS[band][n.voice];
    if (inst && this.recorded.has(inst)) return this.sample(inst, n, t, dur, v);
    switch (n.voice) {
      case 'keys':
        return this.epiano(hz(n.midi), t, dur, v);
      case 'bass':
        return this.bassNote(hz(n.midi), t, dur, v);
      case 'lead':
        return this.vibes(hz(n.midi), t, dur, v);
      case 'pad':
        return this.padNote(hz(n.midi), t, dur, v);
      case 'kick':
        return this.kick(t, v);
      case 'shaker':
        return this.hit(t, v, 'highpass', 7000, 0.6, 0.05);
      case 'rim':
        return this.hit(t, v, 'bandpass', 1800, 6, 0.03);
    }
  }

  /**
   * A recorded note: the nearest one recorded, sped up or slowed down to
   * the note wanted, let go when it ends. A drum hit, any of its takes.
   */
  private sample(inst: Instrument, n: Note, t: number, dur: number, v: number): void {
    const notes = this.recorded.get(inst)!;
    const pitched = typeof notes[0].key === 'number';
    const pick = pitched
      ? notes.reduce((a, b) =>
          Math.abs((b.key as number) - n.midi) < Math.abs((a.key as number) - n.midi) ? b : a,
        )
      : notes[Math.floor(Math.random() * notes.length)];
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = pick.buffer;
    if (pitched) src.playbackRate.value = 2 ** ((n.midi - (pick.key as number)) / 12);
    const { level, release } = RECORDED[inst];
    const amp = c.createGain();
    const peak = v * level;
    amp.gain.setValueAtTime(peak, t);
    amp.gain.setTargetAtTime(0, t + dur, release);
    src.connect(amp);
    this.voiceOut(amp, pitched);
    src.start(t);
    src.stop(t + dur + release * 5);
    src.onended = () => src.disconnect();
  }

  // ── The band ─────────────────────────────────────────────

  /** An envelope on a gain: up in `attack`, down to `sustain`, released at `end`. */
  private env(
    g: AudioParam,
    t: number,
    peak: number,
    attack: number,
    decay: number,
    sustain: number,
    end: number,
    release: number,
  ): void {
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(peak, t + attack);
    g.setTargetAtTime(peak * sustain, t + attack, decay);
    g.setTargetAtTime(0, Math.max(end, t + attack), release);
  }

  private voiceOut(level: AudioNode, wet: boolean): void {
    level.connect(this.out);
    if (wet) level.connect(this.room);
  }

  /** Oscillators started at t and stopped, and let go, when done. */
  private oscs(nodes: OscillatorNode[], t: number, stop: number): void {
    for (const o of nodes) {
      o.start(t);
      o.stop(stop);
    }
    nodes[0].onended = () => {
      for (const o of nodes) o.disconnect();
    };
  }

  /** A Rhodes-like electric piano: a sine rung by another at the same pitch, with a bell on top. */
  private epiano(f: number, t: number, dur: number, v: number): void {
    const c = this.ctx;
    const car = c.createOscillator();
    car.frequency.value = f;
    const mod = c.createOscillator();
    mod.frequency.value = f;
    const depth = c.createGain();
    depth.gain.setValueAtTime(f * 1.4, t);
    depth.gain.setTargetAtTime(f * 0.25, t, 0.25);
    mod.connect(depth).connect(car.frequency);
    const bell = c.createOscillator();
    bell.frequency.value = f * 4.01;
    const bellAmp = c.createGain();
    this.env(bellAmp.gain, t, v * 0.12, 0.002, 0.08, 0, t + 0.2, 0.05);
    const amp = c.createGain();
    this.env(amp.gain, t, v, 0.004, 0.6, 0.35, t + dur, 0.25);
    const tone = c.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = Math.min(5000, f * 6);
    car.connect(amp);
    bell.connect(bellAmp).connect(amp);
    amp.connect(tone);
    this.voiceOut(tone, true);
    this.oscs([car, mod, bell], t, t + dur + 1.5);
  }

  /** A round, plucked bass. */
  private bassNote(f: number, t: number, dur: number, v: number): void {
    const c = this.ctx;
    const a = c.createOscillator();
    a.type = 'triangle';
    a.frequency.value = f;
    const sub = c.createOscillator();
    sub.frequency.value = f;
    const subAmp = c.createGain();
    subAmp.gain.value = 0.8;
    const amp = c.createGain();
    this.env(amp.gain, t, v, 0.008, 0.35, 0.55, t + dur, 0.08);
    const tone = c.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.setValueAtTime(900, t);
    tone.frequency.setTargetAtTime(380, t, 0.12);
    a.connect(amp);
    sub.connect(subAmp).connect(amp);
    amp.connect(tone);
    this.voiceOut(tone, false);
    this.oscs([a, sub], t, t + dur + 0.6);
  }

  /** A vibraphone for the tune: a soft bar with its high partial, and a slow tremolo. */
  private vibes(f: number, t: number, dur: number, v: number): void {
    const c = this.ctx;
    const a = c.createOscillator();
    a.frequency.value = f;
    const hi = c.createOscillator();
    hi.frequency.value = f * 4;
    const hiAmp = c.createGain();
    this.env(hiAmp.gain, t, 0.25, 0.002, 0.06, 0, t + 0.15, 0.04);
    const amp = c.createGain();
    this.env(amp.gain, t, v, 0.006, 1.2, 0.45, t + dur, 0.35);
    // The motor's tremolo, kicking in as the note settles: a wobble on the
    // note's level, so it dies away with it.
    const wobble = c.createGain();
    const trem = c.createOscillator();
    trem.frequency.value = 4.5;
    const tremDepth = c.createGain();
    tremDepth.gain.setValueAtTime(0, t);
    tremDepth.gain.linearRampToValueAtTime(0.25, t + 0.4);
    trem.connect(tremDepth).connect(wobble.gain);
    a.connect(amp);
    hi.connect(hiAmp).connect(amp);
    amp.connect(wobble);
    this.voiceOut(wobble, true);
    this.oscs([a, hi, trem], t, t + dur + 1.6);
  }

  /** A soft string pad: two saws a hair apart, dulled, swelling in slowly. */
  private padNote(f: number, t: number, dur: number, v: number): void {
    const c = this.ctx;
    const a = c.createOscillator();
    a.type = 'sawtooth';
    a.frequency.value = f;
    a.detune.value = -7;
    const b = c.createOscillator();
    b.type = 'sawtooth';
    b.frequency.value = f;
    b.detune.value = 7;
    const tone = c.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 900;
    const amp = c.createGain();
    this.env(amp.gain, t, v, 0.9, 2, 0.9, t + dur, 0.6);
    a.connect(tone);
    b.connect(tone);
    tone.connect(amp);
    this.voiceOut(amp, true);
    this.oscs([a, b], t, t + dur + 3);
  }

  /** A soft kick, felt more than heard. */
  private kick(t: number, v: number): void {
    const c = this.ctx;
    const o = c.createOscillator();
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    const amp = c.createGain();
    amp.gain.setValueAtTime(v, t);
    amp.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(amp);
    this.voiceOut(amp, false);
    this.oscs([o], t, t + 0.35);
  }

  /** A brushed hit of noise: a shaker or a rim. */
  private hit(
    t: number,
    v: number,
    type: BiquadFilterType,
    freq: number,
    q: number,
    len: number,
  ): void {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const amp = c.createGain();
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(v, t + 0.003);
    amp.gain.exponentialRampToValueAtTime(0.0005, t + len);
    src.connect(f).connect(amp);
    this.voiceOut(amp, false);
    src.start(t, Math.random() * 0.4);
    src.stop(t + len + 0.02);
    src.onended = () => src.disconnect();
  }
}
