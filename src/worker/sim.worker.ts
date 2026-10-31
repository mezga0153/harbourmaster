import type { Command, WorkerMessage } from '../protocol';
import { TICKS_PER_DAY } from '../sim/types';
import { World } from '../sim/world';
import { loadSave, writeSave } from './storage';

// The sim worker owns the game state. See plan.md §11, Threads.

const LOOP_MS = 100;

const ctx = self as unknown as {
  postMessage(msg: WorkerMessage): void;
  onmessage: ((e: MessageEvent<Command>) => void) | null;
};

let world: World | null = null;
const queued: Command[] = [];

function randomSeed(): number {
  return Math.floor(Math.random() * 1_000_000);
}

function start(w: World): void {
  world = w;
  ctx.postMessage({ type: 'init', map: w.map.toData(), seed: w.seed });
  // Clear the pending changes; the init message already carries them.
  w.drainTileChanges();
  w.drainPlotChanges();
}

/** Tell the page something went wrong here, for the play log. */
function fault(kind: 'sim' | 'save' | 'autosave', err: unknown): void {
  const e = err as { message?: unknown; stack?: unknown } | null;
  ctx.postMessage({
    type: 'fault',
    kind,
    message: String((e && e.message) || err).slice(0, 500),
    stack: e && e.stack ? String(e.stack).slice(0, 2000) : undefined,
  });
}

function save(manual: boolean): void {
  if (!world) return;
  writeSave(world.toSave()).then(
    () => manual && world && postFrame([{ kind: 'message', text: 'Game saved.', tone: 'good' }]),
    (err) => {
      console.error('Save failed', err);
      fault('save', err);
    },
  );
}

function handle(cmd: Command): void {
  if (!world) {
    queued.push(cmd);
    return;
  }
  if (cmd.type === 'newGame') {
    start(World.create(cmd.seed ?? randomSeed()));
    save(false);
  } else if (cmd.type === 'save') {
    save(true);
  } else if (cmd.type === 'exportSave') {
    ctx.postMessage({ type: 'exported', save: world.toSave(), forReport: cmd.forReport });
  } else if (cmd.type === 'importSave') {
    // Only a save this version can read; the game goes on as it was if not.
    let ok = false;
    try {
      ok = World.isValidSave(cmd.save);
    } catch {
      // Not shaped like a save at all.
    }
    if (!ok) {
      postFrame([
        {
          kind: 'message',
          text: `${cmd.name} is not a Harbourmaster save this version can read.`,
          tone: 'bad',
        },
      ]);
      return;
    }
    try {
      start(World.fromSave(cmd.save as Parameters<typeof World.fromSave>[0]));
    } catch (err) {
      console.error(err);
      fault('sim', err);
      postFrame([{ kind: 'message', text: `${cmd.name} could not be loaded.`, tone: 'bad' }]);
      return;
    }
    save(false);
    postFrame([{ kind: 'message', text: `Loaded ${cmd.name}.`, tone: 'good' }]);
  } else if (cmd.type === 'debug') {
    if (import.meta.env.DEV) world.debug(cmd);
  } else if (cmd.type === 'dumpSave') {
    if (import.meta.env.DEV) ctx.postMessage({ type: 'dump', save: world.toSave() });
  } else if (cmd.type === 'loadSave') {
    if (import.meta.env.DEV && World.isValidSave(cmd.save)) {
      start(World.fromSave(cmd.save));
      save(false);
    }
  } else {
    world.command(cmd);
  }
}

function postFrame(extra: ReturnType<World['drainEvents']> = []): void {
  if (!world) return;
  ctx.postMessage({
    type: 'frame',
    snapshot: world.snapshot(),
    tiles: world.drainTileChanges(),
    plots: world.drainPlotChanges(),
    events: [...world.drainEvents(), ...extra],
  });
}

function loop(): void {
  if (!world) return;
  const dayBefore = Math.floor(world.tick / TICKS_PER_DAY);
  try {
    for (let i = 0; i < world.speed; i++) world.step();
  } catch (err) {
    console.error(err);
    fault('sim', err);
    world.speed = 0;
    postFrame([
      {
        kind: 'message',
        text: 'Something went wrong and the game was paused. Tell us how in Settings: Report a bug.',
        tone: 'bad',
      },
    ]);
    return;
  }
  postFrame();
  if (Math.floor(world.tick / TICKS_PER_DAY) !== dayBefore) save(false);
}

ctx.onmessage = (e) => handle(e.data);

async function boot(): Promise<void> {
  let restored: World | null = null;
  try {
    const data = await loadSave();
    if (data && World.isValidSave(data)) restored = World.fromSave(data);
    else if (data) {
      console.warn('Ignoring an autosave from an older or broken version');
      fault('autosave', 'an autosave this version cannot read was set aside');
    }
  } catch (err) {
    console.warn('Could not load the autosave, starting a new game', err);
    fault('autosave', err);
  }
  start(restored ?? World.create(randomSeed()));
  for (const cmd of queued.splice(0)) handle(cmd);
  setInterval(loop, LOOP_MS);
}

void boot();
