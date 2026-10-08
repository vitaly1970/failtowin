/* Visitor counter, part 1 of 2 (part 2 is functions/api/hit.js).
   Appends a small beacon script to every HTML page, so pages themselves stay untouched.
   Also lets the site owner switch his own browser out of the statistics:
   /?own=on sets a cookie that hit.js honours, /?own=off removes it.
   Any failure here must never break the page: the original response is returned as is. */

const BEACON =
  '<script>(function(){try{if(navigator.webdriver)return;' +
  'var b=JSON.stringify({p:location.pathname,q:location.search.slice(0,300),' +
  'r:document.referrer.slice(0,300),w:screen.width||0,l:navigator.language||""});' +
  'if(navigator.sendBeacon)navigator.sendBeacon("/api/hit",b);' +
  'else fetch("/api/hit",{method:"POST",body:b,keepalive:true});' +
  '}catch(e){}})();</script>';

const OWNER_COOKIE = 'ftw_own';
const TWO_YEARS = 63072000;

function ownerSwitch(request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('own');
  if (mode !== 'on' && mode !== 'off') return null;
  const on = mode === 'on';
  return new Response(
    on ? 'This browser is now excluded from failtowin.org statistics.'
       : 'This browser is counted in failtowin.org statistics again.',
    {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex',
        'set-cookie': OWNER_COOKIE + '=' + (on ? '1' : '') + '; Path=/; Max-Age=' + (on ? TWO_YEARS : 0) +
          '; Secure; SameSite=Lax'
      }
    }
  );
}

export async function onRequest(context) {
  const request = context.request;

  if (request.method === 'GET') {
    try {
      const sw = ownerSwitch(request);
      if (sw) return sw;
    } catch (e) { /* fall through to the page */ }
  }

  const res = await context.next();

  try {
    if (request.method !== 'GET' || res.status !== 200) return res;
    if ((res.headers.get('content-type') || '').indexOf('text/html') < 0) return res;
    if (new URL(request.url).pathname.indexOf('/api/') === 0) return res;
    return new HTMLRewriter()
      .on('body', { element(el) { el.append(BEACON, { html: true }); } })
      .transform(res);
  } catch (e) {
    return res;
  }
}
