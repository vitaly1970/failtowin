/* Visitor counter, part 2 of 2: records one page view sent by the beacon script
   that functions/_middleware.js appends to every page.
   POST body (JSON as text): {p: pathname, q: search, r: referrer, w: screen width, l: language}
   Not recorded: the owner's browsers (cookie ftw_own), robots by user agent,
   requests from other sites. Robots that do not run scripts never get here at all.
   No cookie is set for visitors: a visitor is a one-day hash of address and browser. */

const BOTS = /bot|crawl|spider|slurp|preview|scan|monitor|headless|lighthouse|pagespeed|gtmetrix|pingdom|uptime|curl|wget|python|httpclient|okhttp|java\/|go-http|node-fetch|axios|phantom|puppeteer|playwright|selenium|facebookexternalhit|whatsapp|telegram|embedly|feed|archive|gpt|claude|anthropic|perplexity|bytespider|ccbot|yandex(?!browser)/i;
const OWN_HOSTS = ['failtowin.org', 'www.failtowin.org', 'failtowin.pages.dev'];
const PER_VISITOR_DAY = 300;
const TASHKENT_OFFSET_MS = 5 * 3600 * 1000;

function done() {
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

function clip(v, n) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);
}

function hostOf(value) {
  try { return new URL(value).hostname.toLowerCase(); } catch (e) { return ''; }
}

async function visitorId(ip, ua, day) {
  const data = new TextEncoder().encode(ip + '|' + ua + '|' + day);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(hash.slice(0, 8), x => x.toString(16).padStart(2, '0')).join('');
}

export async function onRequestPost({ request, env }) {
  try {
    const ua = request.headers.get('user-agent') || '';
    if (!ua || BOTS.test(ua)) return done();

    const cookie = request.headers.get('cookie') || '';
    if (/(?:^|;\s*)ftw_own=1(?:;|$)/.test(cookie)) return done();

    const origin = request.headers.get('origin');
    if (origin && OWN_HOSTS.indexOf(hostOf(origin)) < 0) return done();

    let d;
    try { d = JSON.parse((await request.text()).slice(0, 2000)); } catch (e) { return done(); }
    if (!d || typeof d !== 'object') return done();

    const path = clip(d.p, 200);
    if (path.charAt(0) !== '/' || path.indexOf('/api/') === 0) return done();

    let params;
    try { params = new URLSearchParams(clip(d.q, 300)); } catch (e) { params = new URLSearchParams(''); }
    const slug = clip(params.get('slug'), 200) || null;
    const source = clip(params.get('utm_source') || params.get('ref'), 60).toLowerCase() || null;

    const ref = clip(d.r, 300);
    let refHost = hostOf(ref).replace(/^www\./, '');
    if (OWN_HOSTS.indexOf(hostOf(ref)) >= 0) refHost = '';

    const width = parseInt(d.w, 10) || 0;
    const device = /mobi|android|iphone|ipod/i.test(ua) ? 'mobile'
      : (/ipad|tablet/i.test(ua) ? 'tablet' : (width && width < 700 ? 'mobile' : 'desktop'));

    const day = new Date(Date.now() + TASHKENT_OFFSET_MS).toISOString().slice(0, 10);
    const ip = request.headers.get('cf-connecting-ip') || '';
    const visitor = await visitorId(ip, ua, day);
    const country = clip(request.cf && request.cf.country, 2) || null;

    const seen = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM visits WHERE day = ?1 AND visitor = ?2'
    ).bind(day, visitor).first();
    if (seen && seen.n >= PER_VISITOR_DAY) return done();

    await env.DB.prepare(
      'INSERT INTO visits (day, visitor, path, slug, lang, ref_host, ref, source, country, device) ' +
      'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)'
    ).bind(
      day, visitor, path, slug, clip(d.l, 12).toLowerCase() || null,
      refHost || null, refHost ? ref : null, source, country, device
    ).run();
  } catch (e) { /* statistics must never surface an error to the reader */ }
  return done();
}
