// Where a request came from and on what, for the visits and the error reports:
// the country, region and city Cloudflare works out for it
// (request.cf, which a local dev server has none of), and the browser's user
// agent with a short name made from it ("iPhone · iOS 17 · Safari"). Never the
// IP address. Chrome keeps the phone's model and its Android version out of
// the user agent; it sends them as client hints once the page has asked for
// them (public/_headers), and they go into the name, not on their own.

const clip = (v, n) =>
  typeof v === 'string' && v.trim()
    ? v
        .replace(/[\u0000-\u001f]/g, ' ')
        .trim()
        .slice(0, n)
    : null;
const hint = (v) => clip(typeof v === 'string' ? v.replace(/^\s*"|"\s*$/g, '') : null, 60); // a client hint is a quoted string

export function where(request) {
  const cf = request.cf || {},
    h = request.headers;
  const ua = clip(h.get('user-agent'), 300);
  return {
    country: clip(cf.country, 8),
    region: clip(cf.region, 80),
    city: clip(cf.city, 80),
    ua,
    device: deviceName(ua, {
      model: hint(h.get('sec-ch-ua-model')),
      version: hint(h.get('sec-ch-ua-platform-version')),
    }),
  };
}

const BOT =
  /bot[\/\-;)]|bot \(|bot$|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|externalhit|monitor|curl\/|wget|python|node-fetch|undici|go-http|okhttp|java\//i;

// what, what it runs and in which browser: "Pixel 7 · Android 14 · Chrome", "Mac · macOS · Safari", "bot · Googlebot"
export function deviceName(ua, { model, version } = {}) {
  if (!ua) return null;
  const m = (re) => {
    const r = ua.match(re);
    return r ? r[1] : null;
  };
  if (BOT.test(ua)) {
    const b = ua.match(
      /[\w.-]*(bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|externalhit|monitor)[\w.-]*/i,
    );
    return ('bot · ' + (b ? b[0] : ua.split(/[\s/;(]/)[0])).slice(0, 60);
  }
  const major = version ? version.split('.')[0] : null;
  let dev = null,
    os = null;
  if (/iPhone|iPod|iPad/.test(ua)) {
    dev = /iPad/.test(ua) ? 'iPad' : /iPod/.test(ua) ? 'iPod' : 'iPhone';
    // Safari 26 and after says iOS 18.6 whatever it runs on, and its own version is the system's
    const v = m(/OS (\d+)[_.]\d/),
      saf = +m(/Version\/(\d+)/);
    os =
      (dev === 'iPad' ? 'iPadOS' : 'iOS') +
      (saf >= 26 && !/CriOS|FxiOS|EdgiOS/.test(ua) ? ' ' + saf : v ? ' ' + v : '');
  } else if (/Android/.test(ua)) {
    // (Linux; Android 14; SM-S918B Build/UP1A) names the phone; Chrome says only (Linux; Android 10; K) now, whatever it runs on
    const said = m(
      /Android [\d.]+; (?:[a-z]{2}[-_][a-zA-Z]{2}; )?([^;)]+?)(?: Build\/[^;)]*)?[;)]/,
    );
    const v = major || (said === 'K' ? null : m(/Android (\d+)/));
    os = 'Android' + (v ? ' ' + v : '');
    dev =
      model ||
      (said && !/^(K|wv|Mobile|Tablet)$/i.test(said) ? said.trim() : null) ||
      (/Mobile/.test(ua) ? 'Android phone' : 'Android tablet');
  } else if (/CrOS/.test(ua)) {
    dev = 'Chromebook';
    os = 'ChromeOS';
  } else if (/Windows/.test(ua)) {
    dev = 'PC';
    os = major ? (+major >= 13 ? 'Windows 11' : 'Windows 10') : 'Windows';
  } else if (/Macintosh|Mac OS X/.test(ua)) {
    dev = 'Mac';
    os = 'macOS' + (major ? ' ' + major : '');
  } else if (/Linux/.test(ua)) {
    dev = 'PC';
    os = 'Linux';
  }
  const browser = /FBAN|FBAV|FB_IAB/.test(ua)
    ? 'Facebook'
    : /Instagram/.test(ua)
      ? 'Instagram'
      : /musical_ly|TikTok|BytedanceWebview/.test(ua)
        ? 'TikTok'
        : /Snapchat/.test(ua)
          ? 'Snapchat'
          : /\bLine\//.test(ua)
            ? 'Line'
            : /WhatsApp/.test(ua)
              ? 'WhatsApp'
              : /EdgA?\/|EdgiOS\//.test(ua)
                ? 'Edge'
                : /OPR\/|OPT\/|Opera/.test(ua)
                  ? 'Opera'
                  : /SamsungBrowser\//.test(ua)
                    ? 'Samsung Internet'
                    : /YaBrowser\//.test(ua)
                      ? 'Yandex'
                      : /DuckDuckGo\//.test(ua)
                        ? 'DuckDuckGo'
                        : /Firefox\/|FxiOS\//.test(ua)
                          ? 'Firefox'
                          : /; wv\)/.test(ua)
                            ? 'WebView'
                            : /CriOS\/|Chrome\//.test(ua)
                              ? 'Chrome'
                              : /Safari\//.test(ua) && /Version\//.test(ua)
                                ? 'Safari'
                                : /iPhone|iPad|iPod/.test(ua)
                                  ? 'WebView'
                                  : null;
  return [dev, os, browser].filter(Boolean).join(' · ').slice(0, 80) || null;
}
