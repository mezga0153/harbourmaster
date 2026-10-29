import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

/**
 * Dev server only: the game in the browser mirrors itself into .debug/
 * (see src/debug/bridge.ts) so tools outside the browser can follow it.
 *
 * - report.txt, snapshot.json: every 5 s
 * - save.json: every minute, loadable with World.fromSave
 * - log.txt: game messages, console errors and warnings as they happen
 * - GET /__debug/capture?what=state|save|screenshot asks the open game for
 *   a fresh copy and answers once it is written (screenshot.png).
 */
export function debugBridge() {
  const dir = resolve(import.meta.dirname, '..', '.debug');
  const files = {
    state: 'report.txt',
    save: 'save.json',
    screenshot: 'screenshot.png',
  };
  /** @type {Map<string, (() => void)[]>} */
  const waiting = new Map();
  /** @param {string} what */
  const written = (what) => {
    for (const done of waiting.get(what) ?? []) done();
    waiting.delete(what);
  };
  /** @param {string} name @param {string | Buffer} data */
  const write = (name, data) => writeFileSync(resolve(dir, name), data);

  return {
    name: 'harbourmaster-debug-bridge',
    apply: 'serve',
    /** @param {import('vite').ViteDevServer} server */
    configureServer(server) {
      mkdirSync(dir, { recursive: true });
      const ws = server.ws;
      ws.on('hm:state', (data) => {
        write('report.txt', data.report);
        write('snapshot.json', JSON.stringify(data.snapshot));
        written('state');
      });
      ws.on('hm:save', (save) => {
        write('save.json', JSON.stringify(save));
        written('save');
      });
      ws.on('hm:screenshot', (data) => {
        write('screenshot.png', Buffer.from(data.png.split(',')[1], 'base64'));
        written('screenshot');
      });
      ws.on('hm:log', (data) => {
        const log = resolve(dir, 'log.txt');
        if (existsSync(log) && statSync(log).size > 1_000_000) renameSync(log, `${log}.old`);
        appendFileSync(log, `${data.line}\n`);
      });

      // POST a save (as save.json is) and the open game carries on from it.
      server.middlewares.use('/__debug/load', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST the save as the request body\n');
          return;
        }
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          try {
            ws.send('hm:load', { save: JSON.parse(body) });
            res.end('Sent to the open game\n');
          } catch (err) {
            res.statusCode = 400;
            res.end(`Not a save: ${err}\n`);
          }
        });
      });

      server.middlewares.use('/__debug/capture', (req, res) => {
        const what = new URL(req.url ?? '', 'http://x').searchParams.get('what') ?? 'state';
        if (!files[what]) {
          res.statusCode = 400;
          res.end(`what must be one of ${Object.keys(files).join(', ')}\n`);
          return;
        }
        const timer = setTimeout(() => {
          res.statusCode = 504;
          res.end('No game answered: is it open in a browser tab?\n');
        }, 8_000);
        const list = waiting.get(what) ?? [];
        list.push(() => {
          clearTimeout(timer);
          res.end(`${resolve(dir, files[what])}\n`);
        });
        waiting.set(what, list);
        ws.send('hm:request', { what });
      });
    },
  };
}
