// The game's Worker (wrangler.jsonc): the built game in dist/ is served as it
// is, straight from the assets, and what is not one of them comes here: the
// play log's addresses, which take what the game sends about how players get
// on (src/log/, migrations/), and what players tell us (/api/feedback); the
// game's own address, /play, which is the same page as the title screen (see
// src/ui/loading.ts); and anything else, which the assets answer (a 404).
import * as days from './api/days.js';
import * as errors from './api/errors.js';
import * as feedback from './api/feedback.js';
import * as visits from './api/visits.js';

const ROUTES = {
  '/api/visits': visits.take,
  '/api/days': days.take,
  '/api/errors': errors.take,
  '/api/feedback': feedback.take,
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/play' || url.pathname === '/play/') {
      return env.ASSETS.fetch(new Request(new URL('/', url), request));
    }
    const take = ROUTES[url.pathname];
    if (!take) return env.ASSETS.fetch(request);
    if (request.method !== 'POST')
      return new Response('POST only', { status: 405, headers: { allow: 'POST' } });
    try {
      return await take(request, env);
    } catch (e) {
      console.error(e);
      return new Response('could not keep it', { status: 500 });
    }
  },
};
