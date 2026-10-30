// Every sound in the game, made in code with Web Audio: no sound files, in
// keeping with the art. sound.ts decides what plays, when and how loud.

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

function noiseBuffer(ctx: BaseAudioContext, kind: 'white' | 'pink' | 'brown'): AudioBuffer {
  const len = ctx.sampleRate * 4;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0,
    b1 = 0,
    b2 = 0,
    b3 = 0,
    b4 = 0,
    b5 = 0,
    b6 = 0,
    last = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    if (kind === 'white') d[i] = white;
    else if (kind === 'pink') {
      // Paul Kellet's filter.
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    } else {
      last = (last + 0.02 * white) / 1.02;
      d[i] = last * 3.5;
    }
  }
  // Fade the ends together so the loop does not click.
  const fade = Math.floor(ctx.sampleRate * 0.05);
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    d[len - fade + i] = d[len - fade + i] * (1 - t) + d[i] * t;
  }
  return buf;
}

/** A hall-sized tail, for sounds heard across the water. */
function impulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      lp += (Math.random() * 2 - 1 - lp) * (0.5 - 0.4 * t); // duller as it dies away
      d[i] = lp * (1 - t) ** 3;
    }
  }
  return buf;
}

/** A continuous sound whose loudness and side are steered every update. */
export interface Loop {
  gain: GainNode;
  pan: StereoPannerNode;
  /** Extra controls some loops have: a pitch to glide. */
  pitch?: AudioParam[];
}

/** Each land diesel: its pitch, its injectors' knock, and any whine. */
const ROAD = {
  truck: { f: 36, knock: 0.35, knockAt: 950, whine: 0, whineAt: 0 },
  tractor: { f: 44, knock: 0.3, knockAt: 1200, whine: 0.025, whineAt: 1450 },
  stacker: { f: 31, knock: 0.4, knockAt: 800, whine: 0.02, whineAt: 620 },
};

/**
 * Each ship's engines: the pitch they run at, the beat of the firing (how
 * fast and how deep), the wash at the stern and the weight below the note.
 */
const HULL = {
  smack: { f: 70, rate: 5.5, beat: 0.85, wash: 0.25, sub: 0 },
  tug: { f: 52, rate: 8.5, beat: 0.5, wash: 0.45, sub: 0.3 },
  coaster: { f: 40, rate: 6, beat: 0.4, wash: 0.5, sub: 0.45 },
  feeder: { f: 27, rate: 2.2, beat: 0.35, wash: 0.75, sub: 0.6 },
};

/** A land diesel's note for how big the vehicle is, 0 to 1: the bigger, the deeper. */
export function roadPitch(kind: keyof typeof ROAD, size: number): number {
  return ROAD[kind].f * 0.72 ** (size - 0.5);
}

export class Synth {
  readonly ctx: AudioContext;
  /** Overall volume. */
  readonly master: GainNode;
  /** The beds, under the effects. */
  readonly ambience: GainNode;
  readonly effects: GainNode;
  /** Into the hall: sounds far off, or over water. */
  private readonly wet: GainNode;
  private readonly buffers: Record<'white' | 'pink' | 'brown', AudioBuffer>;

  /** Plays live, or into `into` (an OfflineAudioContext, say, to measure the sounds). */
  constructor(into?: BaseAudioContext) {
    const ctx = (into ?? new AudioContext({ latencyHint: 'playback' })) as AudioContext;
    this.ctx = ctx;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 10;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.005;
    limiter.release.value = 0.25;
    limiter.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.connect(limiter);
    this.ambience = ctx.createGain();
    this.ambience.connect(this.master);
    this.effects = ctx.createGain();
    this.effects.connect(this.master);
    const verb = ctx.createConvolver();
    verb.buffer = impulse(ctx, 3.2);
    const verbOut = ctx.createGain();
    verbOut.gain.value = 0.55;
    verb.connect(verbOut).connect(this.master);
    this.wet = ctx.createGain();
    this.wet.connect(verb);
    this.buffers = {
      white: noiseBuffer(ctx, 'white'),
      pink: noiseBuffer(ctx, 'pink'),
      brown: noiseBuffer(ctx, 'brown'),
    };
  }

  get now(): number {
    return this.ctx.currentTime;
  }

  private noise(kind: 'white' | 'pink' | 'brown', loop = true): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers[kind];
    src.loop = loop;
    // Start somewhere random so loops of the same noise do not line up.
    src.loopStart = 0;
    return src;
  }

  private filter(type: BiquadFilterType, freq: number, q = 0.7): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  private osc(type: OscillatorType, freq: number): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    return o;
  }

  private gainNode(v: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = v;
    return g;
  }

  /** A wobble added to a parameter; its oscillator, to steer its rate. */
  private lfo(param: AudioParam, rate: number, depth: number, type: OscillatorType = 'sine') {
    const o = this.osc(type, rate);
    const g = this.gainNode(depth);
    o.connect(g).connect(param);
    o.start(this.now + Math.random());
    return o;
  }

  /** The output stage of a loop: steered gain, then pan, into a bus. */
  private loopOut(bus: GainNode, send: number): Loop {
    const gain = this.gainNode(0);
    const pan = this.ctx.createStereoPanner();
    gain.connect(pan).connect(bus);
    if (send > 0) pan.connect(this.gainNode(send)).connect(this.wet);
    return { gain, pan };
  }

  // ── Beds ────────────────────────────────────────────────

  /** The port from afar: a low rumble of engines, generators and ships' machinery. */
  hum(): Loop {
    const out = this.loopOut(this.ambience, 0.35);
    const rumble = this.noise('brown');
    const lp = this.filter('lowpass', 150, 0.5);
    const swell = this.gainNode(0.9);
    this.lfo(swell.gain, 0.06, 0.25);
    rumble.connect(lp).connect(swell).connect(out.gain);
    // Big diesels idling, beating slowly against each other.
    const drone = this.gainNode(0.16);
    const dlp = this.filter('lowpass', 130, 1);
    for (const f of [47, 47.6, 94.5, 141]) {
      const o = this.osc('sawtooth', f);
      o.connect(dlp);
      o.start(this.now + Math.random() * 0.1);
    }
    dlp.connect(drone).connect(out.gain);
    // A haze of mid-range clatter, never quite anything in particular.
    const haze = this.noise('pink');
    const bp = this.filter('bandpass', 420, 0.8);
    const hazeGain = this.gainNode(0.12);
    this.lfo(hazeGain.gain, 0.11, 0.05);
    haze.connect(bp).connect(hazeGain).connect(out.gain);
    rumble.start(this.now, Math.random() * 3);
    haze.start(this.now, Math.random() * 3);
    return out;
  }

  /** Water: the sea's wash, and waves slapping at the quay walls up close. */
  sea(): { wash: Loop; lap: Loop } {
    const wash = this.loopOut(this.ambience, 0.2);
    const src = this.noise('pink');
    const bp = this.filter('bandpass', 520, 0.45);
    const lp = this.filter('lowpass', 1400);
    const swell = this.gainNode(0.7);
    this.lfo(swell.gain, 0.09, 0.3);
    src.connect(bp).connect(lp).connect(swell).connect(wash.gain);
    src.start(this.now, Math.random() * 3);

    const lap = this.loopOut(this.ambience, 0.1);
    const lsrc = this.noise('brown');
    const lbp = this.filter('bandpass', 320, 1.1);
    lsrc.connect(lbp).connect(lap.gain);
    lsrc.start(this.now, Math.random() * 3);
    return { wash, lap };
  }

  /** Wind over open ground, heard more as the view pulls back. */
  wind(): Loop {
    const out = this.loopOut(this.ambience, 0);
    const src = this.noise('pink');
    const bp = this.filter('bandpass', 800, 0.6);
    this.lfo(bp.frequency, 0.05, 250);
    const g = this.gainNode(0.6);
    this.lfo(g.gain, 0.07, 0.3);
    src.connect(bp).connect(g).connect(out.gain);
    src.start(this.now, Math.random() * 3);
    return out;
  }

  /**
   * A diesel on land: a truck, a terminal tractor or a reach stacker, its
   * pitch steered by how big the ones heard are. Gritty and quick, with the
   * clatter of the injectors: nothing like a ship's slow, deep beat.
   */
  roadEngine(kind: 'truck' | 'tractor' | 'stacker'): Loop {
    const p = ROAD[kind];
    const out = this.loopOut(this.effects, 0.05);
    const lp = this.filter('lowpass', p.f * 8, 2);
    const chug = this.gainNode(0.65);
    const chugOsc = this.lfo(chug.gain, p.f / 2.3, 0.3);
    const a = this.osc('sawtooth', p.f);
    const b = this.osc('square', p.f * 2.007);
    const bg = this.gainNode(0.3);
    a.connect(lp);
    b.connect(bg).connect(lp);
    const grit = this.noise('brown');
    const gbp = this.filter('bandpass', p.f * 4.5, 1.4);
    const gg = this.gainNode(0.5);
    grit.connect(gbp).connect(gg).connect(lp);
    lp.connect(chug).connect(out.gain);
    // The injectors' knock, ticking with the firing.
    const knock = this.noise('pink');
    const kbp = this.filter('bandpass', p.knockAt, 1.3);
    const kg = this.gainNode(p.knock * 0.5);
    const knockOsc = this.lfo(kg.gain, p.f * 0.45, p.knock * 0.5, 'square');
    knock.connect(kbp).connect(kg).connect(out.gain);
    // A tractor's turbo and a stacker's hydraulics whine faintly over it.
    if (p.whine > 0) {
      const w = this.osc('sine', p.whineAt);
      this.lfo(w.frequency, 0.4, p.whineAt * 0.02);
      const wg = this.gainNode(p.whine);
      w.connect(wg).connect(out.gain);
      w.start();
    }
    a.start();
    b.start();
    grit.start(this.now, Math.random() * 3);
    knock.start(this.now, Math.random() * 3);
    out.pitch = [a.frequency, b.frequency, chugOsc.frequency, knockOsc.frequency];
    return out;
  }

  /**
   * A ship's engine under way, by its hull: the bigger the ship, the deeper
   * and slower its beat and the more water it churns; a fishing boat's
   * single cylinder going putt-putt.
   */
  shipEngine(hull: 'smack' | 'tug' | 'coaster' | 'feeder'): Loop {
    const p = HULL[hull];
    const out = this.loopOut(this.effects, 0.3);
    const lp = this.filter('lowpass', p.f * 5, 1.1);
    const beat = this.gainNode(1 - p.beat / 2);
    this.lfo(beat.gain, p.rate, p.beat / 2);
    const tones: [OscillatorType, number, number][] = [
      ['sawtooth', 1, 0.8],
      ['square', 2.004, 0.25],
      ['sine', 0.5, p.sub],
    ];
    for (const [type, r, v] of tones) {
      if (v <= 0) continue;
      const o = this.osc(type, p.f * r);
      const g = this.gainNode(v);
      o.connect(g).connect(lp);
      o.start(this.now + Math.random() * 0.1);
    }
    lp.connect(beat).connect(out.gain);
    // The wash at the stern.
    const wash = this.noise('brown');
    const wlp = this.filter('lowpass', 160 + 260 * (1 - p.sub), 0.7);
    const wg = this.gainNode(p.wash);
    this.lfo(wg.gain, 0.23, p.wash * 0.3);
    wash.connect(wlp).connect(wg).connect(out.gain);
    wash.start(this.now, Math.random() * 3);
    return out;
  }

  /** Forklifts' electric motors. */
  electric(): Loop {
    const out = this.loopOut(this.effects, 0);
    const a = this.osc('sine', 470);
    const b = this.osc('triangle', 942);
    this.lfo(a.frequency, 4.5, 6);
    this.lfo(b.frequency, 4.5, 12);
    const g = this.gainNode(0.25);
    const bg = this.gainNode(0.12);
    a.connect(g).connect(out.gain);
    b.connect(bg).connect(out.gain);
    a.start();
    b.start();
    out.pitch = [a.frequency, b.frequency];
    return out;
  }

  /** Cranes' winches and hydraulics. */
  winch(): Loop {
    const out = this.loopOut(this.effects, 0.15);
    const a = this.osc('sawtooth', 92);
    const bp = this.filter('bandpass', 560, 4);
    const whine = this.osc('sine', 184);
    const wg = this.gainNode(0.3);
    const ag = this.gainNode(0.7);
    a.connect(bp).connect(ag).connect(out.gain);
    whine.connect(wg).connect(out.gain);
    this.lfo(bp.frequency, 0.3, 120);
    a.start();
    whine.start();
    out.pitch = [a.frequency, whine.frequency];
    return out;
  }

  /** A train rolling by on the main line. */
  rumble(): Loop {
    const out = this.loopOut(this.effects, 0.2);
    const src = this.noise('brown');
    const lp = this.filter('lowpass', 260, 1.5);
    const clack = this.gainNode(0.75);
    this.lfo(clack.gain, 3.1, 0.25);
    src.connect(lp).connect(clack).connect(out.gain);
    src.start(this.now, Math.random() * 3);
    return out;
  }

  // ── One-off sounds ──────────────────────────────────────

  /** Where a one-off sound goes: gain and pan, a filter for distance, a share into the hall. */
  private voice(gain: number, pan: number, far: number, seconds: number): AudioNode {
    const ctx = this.ctx;
    const input = this.gainNode(gain);
    const dull = this.filter('lowpass', 9000 * (1 - far) + 900 * far, 0.5);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    input.connect(dull).connect(p).connect(this.effects);
    const send = this.gainNode(0.12 + far * 0.6);
    p.connect(send).connect(this.wet);
    setTimeout(
      () => {
        input.disconnect();
        dull.disconnect();
        p.disconnect();
        send.disconnect();
      },
      (seconds + 1) * 1000,
    );
    return input;
  }

  private envelope(
    g: GainNode,
    t: number,
    peak: number,
    attack: number,
    decay: number,
    hold = 0,
  ): void {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    if (hold > 0) g.gain.setValueAtTime(peak, t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + decay);
  }

  /**
   * Struck resonances, as a modal model: each mode a decaying sine, with a
   * second slightly detuned against it so that it beats, the way a big
   * panel rings unevenly. `modes` are [frequency, level, seconds to die away].
   */
  private ring(out: AudioNode, at: number, modes: [number, number, number][]): void {
    for (const [f, v, d] of modes) {
      for (const detune of [1, 1.0035]) {
        const o = this.osc('sine', f * detune);
        const g = this.gainNode(0);
        this.envelope(g, at, v * (detune === 1 ? 1 : 0.6), 0.0015, d);
        o.connect(g).connect(out);
        o.start(at);
        o.stop(at + d + 0.05);
      }
    }
  }

  /** A burst of noise through a band: the crack, scrape or rattle of an impact. */
  private burst(
    out: AudioNode,
    at: number,
    type: BiquadFilterType,
    freq: number,
    q: number,
    level: number,
    decay: number,
  ): void {
    const n = this.noise('white', false);
    const f = this.filter(type, freq, q);
    const g = this.gainNode(0);
    this.envelope(g, at, level, 0.001, decay);
    n.connect(f).connect(g).connect(out);
    n.start(at, Math.random() * 3, decay + 0.1);
  }

  /**
   * Thirty tonnes of steel box set down: a deep boom as it lands, the
   * clang of its walls ringing low and hollow, then the twistlocks
   * seating and a rattle of the doors. Onto a trailer, a duller thump with
   * the chassis taking the weight; onto a stack or the ground, more ring.
   */
  clank(gain: number, pan: number, far = 0, onTruck = false): void {
    const t = this.now + 0.01;
    const out = this.voice(gain, pan, far, 2.2);
    // The weight landing.
    const boom = this.osc('sine', rnd(58, 66));
    boom.frequency.exponentialRampToValueAtTime(32, t + 0.35);
    const bg = this.gainNode(0);
    this.envelope(bg, t, 0.9, 0.004, 0.45);
    boom.connect(bg).connect(out);
    boom.start(t);
    boom.stop(t + 0.6);
    this.burst(out, t, 'lowpass', 220, 0.7, 0.9, 0.22);
    // The box's walls and frame ringing: low, inharmonic and hollow.
    const base = rnd(78, 96) * (onTruck ? 0.9 : 1);
    const ring = onTruck ? 0.45 : 1;
    this.ring(
      out,
      t,
      [
        [base, 0.3, 0.9],
        [base * 1.47, 0.24, 0.75],
        [base * 2.09, 0.18, 0.6],
        [base * 2.91, 0.12, 0.45],
        [base * 3.83, 0.08, 0.35],
        [base * 5.17, 0.05, 0.25],
      ].map(([f, v, d]) => [f * rnd(0.98, 1.02), v * ring, d * ring] as [number, number, number]),
    );
    // The clang of the corner castings meeting.
    this.burst(out, t, 'bandpass', rnd(600, 900), 1.2, 0.5, 0.08);
    // Twistlocks seating, and the doors rattling in their frame.
    const lock = t + rnd(0.1, 0.16);
    this.burst(out, lock, 'bandpass', rnd(2200, 3000), 3, 0.28, 0.03);
    this.ring(out, lock, [
      [rnd(1150, 1350), 0.05, 0.18],
      [rnd(1900, 2200), 0.03, 0.12],
    ]);
    for (let k = 0; k < 3; k++) {
      this.burst(out, lock + rnd(0.04, 0.3), 'bandpass', rnd(350, 600), 2.5, 0.12, 0.05);
    }
    if (onTruck) {
      // The trailer's springs taking the weight.
      const sag = this.osc('sine', 45);
      sag.frequency.exponentialRampToValueAtTime(38, t + 0.5);
      const sg = this.gainNode(0);
      this.envelope(sg, t + 0.05, 0.35, 0.05, 0.4);
      sag.connect(sg).connect(out);
      sag.start(t);
      sag.stop(t + 0.7);
    }
  }

  /**
   * A wooden crate or pallet set down: a hollow knock of boards, low and
   * short, with a smaller knock as it settles.
   */
  thunk(gain: number, pan: number, far = 0): void {
    const t = this.now + 0.01;
    const out = this.voice(gain, pan, far, 0.6);
    const knock = (at: number, size: number) => {
      // The boards: a few broad, quickly damped resonances.
      const k = rnd(0.9, 1.12);
      this.ring(out, at, [
        [190 * k, 0.32 * size, 0.12],
        [415 * k, 0.24 * size, 0.08],
        [730 * k, 0.12 * size, 0.05],
        [1180 * k, 0.06 * size, 0.035],
      ]);
      this.burst(out, at, 'bandpass', 520 * k, 1.1, 0.55 * size, 0.035);
      this.burst(out, at, 'highpass', 2500, 0.7, 0.12 * size, 0.012);
      // The weight on the ground.
      const body = this.osc('sine', 120 * k);
      body.frequency.exponentialRampToValueAtTime(70, at + 0.08);
      const bg = this.gainNode(0);
      this.envelope(bg, at, 0.6 * size, 0.003, 0.1);
      body.connect(bg).connect(out);
      body.start(at);
      body.stop(at + 0.2);
    };
    knock(t, 1);
    knock(t + rnd(0.05, 0.09), 0.3);
  }

  /** A machine backing up: beep, beep, beep. */
  beep(gain: number, pan: number, far = 0): void {
    const t = this.now + 0.01;
    const out = this.voice(gain, pan, far, 1.8);
    const f = rnd(1040, 1180);
    for (let k = 0; k < 3; k++) {
      const at = t + k * 0.5;
      const o = this.osc('square', f);
      const lp = this.filter('lowpass', 2600);
      const g = this.gainNode(0);
      this.envelope(g, at, 0.25, 0.01, 0.02, 0.24);
      o.connect(lp).connect(g).connect(out);
      o.start(at);
      o.stop(at + 0.35);
    }
  }

  /** A truck's air brakes as it pulls up. */
  hiss(gain: number, pan: number, far = 0): void {
    const t = this.now + 0.01;
    const out = this.voice(gain, pan, far, 1);
    const n = this.noise('white', false);
    const hp = this.filter('highpass', 2200);
    const bp = this.filter('bandpass', rnd(3800, 5200), 0.6);
    const g = this.gainNode(0);
    this.envelope(g, t, 0.35, 0.015, rnd(0.4, 0.7), 0.05);
    n.connect(hp).connect(bp).connect(g).connect(out);
    n.start(t, Math.random() * 3, 1);
  }

  /**
   * A ship's horn, by how big the ship is (`size`, 0 to 1; see
   * VESSEL_SIZE): the bigger, the deeper, longer and fuller, a feeder's
   * one long low blast heard right across the harbour. Small craft give
   * two short toots; a coaster's is a two-note chord.
   */
  horn(gain: number, pan: number, far: number, size = 0.5): void {
    const t = this.now + 0.02;
    const f = 230 * 0.27 ** size;
    const small = size < 0.4;
    const blasts: [number, number][] = small
      ? [
          [0, 0.2],
          [0.42, 0.2],
        ]
      : [[0, 1.4 + 2.2 * size]];
    const chord = !small && size < 0.8 ? [1, 1.26] : [1];
    const end = blasts[blasts.length - 1];
    const release = 0.2 + 0.7 * size;
    const out = this.voice(gain, pan, Math.max(far, 0.2 + 0.3 * size), end[0] + end[1] + 4);
    const lp = this.filter('lowpass', f * (7 + 3 * size), 1.4);
    // A bright edge where the trumpet flares.
    const formant = this.filter('peaking', f * 4, 1.5);
    formant.gain.value = 4;
    lp.connect(formant).connect(out);
    const attack = small ? 0.03 : 0.12 + 0.2 * size;
    for (const [at, len] of blasts) {
      const g = this.gainNode(0);
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(0.5, t + at + attack);
      g.gain.setValueAtTime(0.5, t + at + len);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + len + release);
      g.connect(lp);
      for (const c of chord) {
        for (const [r, v, type] of [
          [1, 1, 'sawtooth'],
          [1.003, 0.7, 'sawtooth'],
          [2, 0.25 + 0.2 * size, 'square'],
        ] as const) {
          const freq = f * c * r;
          const o = this.osc(type, freq);
          // It comes up to pitch as the air gets going, and wavers.
          o.frequency.setValueAtTime(freq * (small ? 0.97 : 0.93), t + at);
          o.frequency.exponentialRampToValueAtTime(freq, t + at + attack * 1.5);
          const wob = this.osc('sine', rnd(4.5, 6));
          const wg = this.gainNode(freq * 0.004);
          wob.connect(wg).connect(o.frequency);
          const og = this.gainNode((v * 0.4) / chord.length);
          o.connect(og).connect(g);
          o.start(t + at);
          wob.start(t + at);
          o.stop(t + at + len + release + 0.1);
          wob.stop(t + at + len + release + 0.1);
        }
      }
    }
  }

  /** A diesel locomotive's two-tone horn. */
  trainHorn(gain: number, pan: number, far: number): void {
    const t = this.now + 0.02;
    const out = this.voice(gain, pan, Math.max(far, 0.3), 3);
    const lp = this.filter('lowpass', 2200);
    lp.connect(out);
    [
      [0, 0.9],
      [1.1, 0.55],
    ].forEach(([at, len]) => {
      const g = this.gainNode(0);
      this.envelope(g, t + at, 0.3, 0.05, 0.15, len);
      g.connect(lp);
      for (const f of [311, 370, 466]) {
        const o = this.osc('sawtooth', f);
        o.connect(g);
        o.start(t + at);
        o.stop(t + at + len + 0.3);
      }
    });
  }

  /** A herring gull: one long cry, then a few laughing calls. */
  gull(gain: number, pan: number, far = 0): void {
    let t = this.now + 0.02;
    const out = this.voice(gain, pan, far, 3);
    const calls = 2 + Math.floor(Math.random() * 4);
    const top = rnd(1250, 1650);
    for (let k = 0; k < calls; k++) {
      const long = k === 0;
      const len = long ? rnd(0.3, 0.42) : rnd(0.11, 0.17);
      const f = top * (long ? 1 : rnd(0.78, 0.9));
      const o = this.osc('triangle', f * 0.7);
      o.frequency.setValueAtTime(f * 0.7, t);
      o.frequency.exponentialRampToValueAtTime(f * 1.25, t + len * 0.3);
      o.frequency.exponentialRampToValueAtTime(f * 0.75, t + len);
      // The rasp in the cry.
      const rasp = this.osc('sine', rnd(28, 40));
      const rg = this.gainNode(f * 0.06);
      rasp.connect(rg).connect(o.frequency);
      const bp = this.filter('bandpass', f * 1.3, 1.1);
      const g = this.gainNode(0);
      this.envelope(g, t, 0.35, 0.015, len * 0.75, len * 0.2);
      o.connect(bp).connect(g).connect(out);
      o.start(t);
      rasp.start(t);
      o.stop(t + len + 0.1);
      rasp.stop(t + len + 0.1);
      t += len + rnd(0.05, 0.11);
    }
  }
}
