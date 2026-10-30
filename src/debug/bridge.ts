import type { Command, Snapshot, WorkerMessage } from '../protocol';
import type { Renderer } from '../render/renderer';
import type { GameMap } from '../sim/map';
import type { SaveData } from '../sim/world';
import { panel, selection, snapshot, tool } from '../ui/store';
import { report } from './report';

// Dev server only: mirrors the running game into .debug/ in the project
// (report.txt, snapshot.json, save.json, screenshot.png, log.txt), so tools
// outside the browser can see what is happening. See vite.config.ts.
// Turned off with ?nodebug, and in automated browsers unless ?bridge.

const STATE_MS = 5_000;
const SAVE_MS = 60_000;
const LOG_LINES = 60;

interface Hooks {
  worker: Worker;
  send: (cmd: Command) => void;
  renderer: Renderer;
  map: () => GameMap | null;
}

export function startBridge({ worker, send, renderer, map }: Hooks): void {
  const hot = import.meta.hot;
  const params = new URLSearchParams(location.search);
  if (!hot || params.has('nodebug') || (navigator.webdriver && !params.has('bridge'))) return;

  const log: string[] = [];
  const note = (line: string) => {
    const entry = `${new Date().toISOString().slice(11, 19)} ${line}`;
    log.push(entry);
    if (log.length > LOG_LINES) log.shift();
    hot.send('hm:log', { line: entry });
  };
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      note(`[console.${level}] ${args.map(String).join(' ')}`);
    };
  }
  window.addEventListener('error', (e) =>
    note(`[error] ${e.message} at ${e.filename}:${e.lineno}`),
  );
  window.addEventListener('unhandledrejection', (e) => note(`[rejection] ${String(e.reason)}`));
  worker.addEventListener('error', (e) => note(`[worker error] ${e.message}`));
  worker.addEventListener('message', (e: MessageEvent<WorkerMessage>) => {
    const msg = e.data;
    if (msg.type === 'dump') hot.send('hm:save', msg.save);
    if (msg.type === 'fault') note(`[${msg.kind} fault] ${msg.message}`);
    if (msg.type !== 'frame') return;
    for (const ev of msg.events) if (ev.kind === 'message') note(`[${ev.tone}] ${ev.text}`);
  });

  const view = (s: Snapshot, w: number): string => {
    const sel = selection.peek();
    const picked = !sel
      ? 'nothing'
      : sel.type === 'entity'
        ? (() => {
            const e = s.entities.find((q) => q.id === sel.id);
            return e ? `${e.kind} #${e.id} ${e.name}` : `entity #${sel.id}`;
          })()
        : 'idx' in sel
          ? `${sel.type} at (${sel.idx % w},${Math.floor(sel.idx / w)})`
          : sel.type;
    const t = renderer.cam.target;
    return (
      `selected ${picked} · tool ${tool.peek()} · panel ${panel.peek() ?? 'none'}` +
      ` · camera on (${t.x.toFixed(1)},${t.z.toFixed(1)}) · tab ${document.visibilityState}`
    );
  };

  const sendState = () => {
    const s = snapshot.peek();
    const m = map();
    if (!s || !m) return;
    const text = report(s, { width: m.w, log, view: view(s, m.w) });
    hot.send('hm:state', { report: text, snapshot: s });
  };

  const screenshot = () => {
    // Read the canvas in a frame callback after the renderer has drawn,
    // before the browser clears it.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        hot.send('hm:screenshot', { png: renderer.canvas.toDataURL('image/png') });
      }),
    );
  };

  // A save posted to /__debug/load: the game carries on from it.
  hot.on('hm:load', (data: { save: SaveData }) => send({ type: 'loadSave', save: data.save }));

  hot.on('hm:request', (req: { what: string }) => {
    if (req.what === 'state') sendState();
    else if (req.what === 'save') send({ type: 'dumpSave' });
    else if (req.what === 'screenshot') screenshot();
  });

  setInterval(sendState, STATE_MS);
  setInterval(() => send({ type: 'dumpSave' }), SAVE_MS);
  setTimeout(() => send({ type: 'dumpSave' }), 3_000);
  note('[bridge] connected');
}
