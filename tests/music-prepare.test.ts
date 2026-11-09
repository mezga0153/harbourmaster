import { afterEach, describe, expect, it, vi } from 'vitest';
import { Music } from '../src/audio/music';

afterEach(() => vi.unstubAllGlobals());

function player(): Music {
  const ctx = {
    sampleRate: 8000,
    createBuffer: () => ({ getChannelData: () => new Float32Array(4000) }),
    createGain: () => ({ gain: { value: 0 }, connect: vi.fn() }),
    decodeAudioData: vi.fn(async () => ({})),
  } as unknown as BaseAudioContext;
  return new Music(ctx, {} as AudioNode);
}

describe('Preparing a recorded band for the lab', () => {
  it('loads only its instruments, deduplicates concurrent requests, and never starts the game composer', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }));
    vi.stubGlobal('fetch', fetcher);
    const music = player();
    await Promise.all([music.prepare('parlour'), music.prepare('parlour')]);
    const paths = fetcher.mock.calls.map((call) => String((call as unknown[])[0]));
    expect(paths).toHaveLength(23);
    expect(paths.every((path) => /music\/(piano|vibes|shaker|claves)\//.test(path))).toBe(true);
    await music.prepare('parlour');
    expect(fetcher).toHaveBeenCalledTimes(23);
    expect(music.playing).toBe(false);
  });

  it('reports missing samples instead of claiming the recorded instruments are ready', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404 })),
    );
    const music = player();
    await expect(music.prepare('parlour')).rejects.toThrow('404');
    expect(music.playing).toBe(false);
  });
});
