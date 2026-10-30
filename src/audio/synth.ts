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

  constructor() {
    const ctx = new AudioContext({ latencyHint: 'playback' });
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

  /** A slow wobble added to a parameter. */
  private lfo(param: AudioParam, rate: number, depth: number): void {
    const o = this.osc('sine', rate);
    const g = this.gainNode(depth);
    o.connect(g).connect(param);
    o.start(this.now + Math.random());
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

  /** Diesel engines: trucks, tractors and stackers ticking over and pulling away. */
  diesel(): Loop {
    const out = this.loopOut(this.effects, 0.05);
    const lp = this.filter('lowpass', 240, 2.5);
    const chug = this.gainNode(0.6);
    this.lfo(chug.gain, 15, 0.35);
    const a = this.osc('sawtooth', 33);
    const b = this.osc('square', 66.4);
    const bg = this.gainNode(0.35);
    a.connect(lp);
    b.connect(bg).connect(lp);
    const grit = this.noise('brown');
    const gbp = this.filter('bandpass', 150, 1.4);
    const gg = this.gainNode(0.5);
    grit.connect(gbp).connect(gg).connect(lp);
    lp.connect(chug).connect(out.gain);
    a.start();
    b.start();
    grit.start(this.now, Math.random() * 3);
    out.pitch = [a.frequency, b.frequency];
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

  /** A steel box landing: a thud, a bang and a ring, then the twistlocks seating. */
  clank(gain: number, pan: number, far = 0): void {
    const t = this.now + 0.01;
    const out = this.voice(gain, pan, far, 1.6);
    const hit = (at: number, size: number) => {
      const thud = this.osc('sine', 95);
      thud.frequency.setValueAtTime(rnd(85, 105), at);
      thud.frequency.exponentialRampToValueAtTime(42, at + 0.16);
      const tg = this.gainNode(0);
      this.envelope(tg, at, 0.9 * size, 0.003, 0.3);
      thud.connect(tg).connect(out);
      thud.start(at);
      thud.stop(at + 0.4);

      const bang = this.noise('white', false);
      const bp = this.filter('bandpass', rnd(900, 1700), 0.9);
      const bg = this.gainNode(0);
      this.envelope(bg, at, 0.55 * size, 0.002, 0.09);
      bang.connect(bp).connect(bg).connect(out);
      bang.start(at, Math.random() * 3, 0.2);

      const base = rnd(170, 260);
      [1, 2.76, 5.4, 8.93].forEach((r, k) => {
        const o = this.osc('sine', base * r * rnd(0.98, 1.02));
        const og = this.gainNode(0);
        this.envelope(og, at, [0.22, 0.15, 0.08, 0.05][k] * size, 0.002, rnd(0.4, 0.9) / (k + 1));
        o.connect(og).connect(out);
        o.start(at);
        o.stop(at + 1.2);
      });
    };
    hit(t, 1);
    hit(t + rnd(0.06, 0.12), 0.35);
  }

  /** A crate or pallet set down on concrete. */
  thunk(gain: number, pan: number, far = 0): void {
    const t = this.now + 0.01;
    const out = this.voice(gain, pan, far, 0.5);
    const knock = this.noise('white', false);
    const bp = this.filter('bandpass', rnd(380, 560), 1.6);
    const kg = this.gainNode(0);
    this.envelope(kg, t, 0.8, 0.002, 0.07);
    knock.connect(bp).connect(kg).connect(out);
    knock.start(t, Math.random() * 3, 0.15);
    const body = this.osc('sine', 150);
    body.frequency.exponentialRampToValueAtTime(70, t + 0.1);
    const bg = this.gainNode(0);
    this.envelope(bg, t, 0.7, 0.003, 0.13);
    body.connect(bg).connect(out);
    body.start(t);
    body.stop(t + 0.3);
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

  /** A ship's horn: deep for a feeder, higher for a coaster. */
  horn(gain: number, pan: number, far: number, vessel?: string): void {
    const t = this.now + 0.02;
    const f = vessel === 'feeder' ? 70 : vessel === 'coaster' ? 108 : 150;
    const dur = vessel === 'feeder' ? 2.4 : 1.7;
    const out = this.voice(gain, pan, Math.max(far, 0.35), dur + 4);
    const lp = this.filter('lowpass', f * 9, 1.2);
    const g = this.gainNode(0);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.15);
    g.gain.setValueAtTime(0.5, t + dur);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.7);
    lp.connect(g).connect(out);
    for (const [r, v] of [
      [1, 1],
      [1.004, 0.8],
      [2, 0.35],
    ] as const) {
      const o = this.osc('sawtooth', f * r);
      o.frequency.setValueAtTime(f * r * 0.96, t);
      o.frequency.exponentialRampToValueAtTime(f * r, t + 0.2);
      const og = this.gainNode(v * 0.4);
      o.connect(og).connect(lp);
      o.start(t);
      o.stop(t + dur + 0.8);
    }
  }

  /** Two short toots: a tug setting off, or a fishing boat leaving. */
  toot(gain: number, pan: number, far: number): void {
    const t = this.now + 0.02;
    const out = this.voice(gain, pan, Math.max(far, 0.2), 2);
    const f = rnd(185, 230);
    for (let k = 0; k < 2; k++) {
      const at = t + k * 0.42;
      const o = this.osc('sawtooth', f);
      const lp = this.filter('lowpass', f * 7);
      const g = this.gainNode(0);
      this.envelope(g, at, 0.3, 0.04, 0.12, 0.18);
      o.connect(lp).connect(g).connect(out);
      o.start(at);
      o.stop(at + 0.45);
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
