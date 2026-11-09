import { Music } from '../../audio/music';
import type { Bar, Voice } from '../../audio/score';

export type Layer = 'keys' | 'lead' | 'bass' | 'pad' | 'percussion';
export const layerOf = (voice: Voice): Layer =>
  voice === 'kick' || voice === 'rim' || voice === 'shaker' ? 'percussion' : voice;

/** Owns an audio context so stopping also cancels every queued note and room tail. */
export class LabPlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private room: GainNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private volume = 0.65;
  private space = 0.18;
  readonly muted = new Set<Layer>();

  get running(): boolean {
    return this.ctx !== null;
  }

  setVolume(value: number): void {
    this.volume = value;
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(value * value, this.ctx.currentTime, 0.025);
    }
  }

  setSpace(value: number): void {
    this.space = value;
    if (this.ctx && this.room) {
      this.room.gain.setTargetAtTime(value * 0.7, this.ctx.currentTime, 0.1);
    }
  }

  async play(
    bars: Bar[],
    onPosition: (bar: number, beat: number) => void,
    options: { loop?: boolean; ignoreMutes?: boolean; onEnded?(): void } = {},
  ): Promise<void> {
    this.stop();
    const ctx = new AudioContext({ latencyHint: 'playback' });
    this.ctx = ctx;
    try {
      const master = ctx.createGain();
      this.master = master;
      master.gain.value = this.volume * this.volume;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -14;
      limiter.ratio.value = 5;
      master.connect(limiter).connect(ctx.destination);

      // A filtered stereo echo gives the little synthesized band some sea air.
      const room = ctx.createGain();
      this.room = room;
      room.gain.value = this.space * 0.7;
      const delay = ctx.createDelay(1);
      delay.delayTime.value = 0.375;
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = 2200;
      const feedback = ctx.createGain();
      feedback.gain.value = 0.32;
      const pan = ctx.createStereoPanner();
      pan.pan.value = 0.35;
      room.connect(delay).connect(tone).connect(pan).connect(master);
      tone.connect(feedback).connect(delay);
      const music = new Music(ctx, master, room);

      await ctx.resume();
      await music.prepare('parlour');
      if (this.ctx !== ctx) return;
      const secondsPerBar = (bars[0].beats * 60) / bars[0].tempo;
      let nextTime = ctx.currentTime + 0.08;
      let nextIndex = 0;
      const queued: { index: number; time: number }[] = [];
      const schedule = () => {
        if (ctx.state !== 'running') return;
        // A throttled background tab resumes from now without a burst of old notes.
        if (nextTime < ctx.currentTime - 0.1) nextTime = ctx.currentTime + 0.08;
        while (nextTime < ctx.currentTime + 0.2 && nextIndex < bars.length) {
          const bar = bars[nextIndex];
          music.playBar(
            {
              ...bar,
              notes: bar.notes.filter(
                (note) => options.ignoreMutes || !this.muted.has(layerOf(note.voice)),
              ),
            },
            nextTime,
          );
          queued.push({ index: nextIndex, time: nextTime });
          nextTime += secondsPerBar;
          nextIndex++;
          if (nextIndex === bars.length && options.loop !== false) nextIndex = 0;
        }
      };
      const draw = () => {
        while (queued.length > 1 && queued[1].time <= ctx.currentTime) queued.shift();
        const current = queued[0];
        if (
          options.loop === false &&
          current?.index === bars.length - 1 &&
          ctx.currentTime >= current.time + secondsPerBar
        ) {
          this.stop();
          options.onEnded?.();
          return;
        }
        if (current && current.time <= ctx.currentTime) {
          onPosition(
            current.index,
            Math.min(4, ((ctx.currentTime - current.time) / secondsPerBar) * 4),
          );
        }
        this.frame = requestAnimationFrame(draw);
      };
      schedule();
      this.timer = setInterval(schedule, 50);
      draw();
    } catch (error) {
      if (this.ctx === ctx) this.stop();
      throw error;
    }
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    cancelAnimationFrame(this.frame);
    const ctx = this.ctx;
    if (ctx && ctx.state !== 'closed') {
      this.master?.gain.setTargetAtTime(0, ctx.currentTime, 0.012);
      setTimeout(() => void ctx.close().catch(() => {}), 60);
    }
    this.ctx = null;
    this.master = null;
    this.room = null;
  }
}
