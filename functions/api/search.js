/* Search over published stories.
   Query string: q (text), lang (en|ru), page (1-based).
   Only stories close in meaning to the query are returned (see _shared/relevance.js);
   there is no word matching. Order: relevance first, interest second.
   Returns at most PAGE_SIZE rows per call. */

import { relevantStories, pickLang } from '../_shared/relevance.js';

const PAGE_SIZE = 20;
const MAX_PAGE = 50;
const SNIPPET = 220;

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300'
    }
  });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const lang = pickLang(url.searchParams.get('lang'));
  const query = String(url.searchParams.get('q') || '').trim().slice(0, 200);

  let page = parseInt(url.searchParams.get('page') || '1', 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (page > MAX_PAGE) page = MAX_PAGE;

  if (!query) return json({ lang: lang, page: 1, total: 0, has_more: false, items: [] });

  const slug = 'url_path_' + lang;
  const title = 'title_' + lang;
  const body = 'body_' + lang;

  try {
    const hits = await relevantStories(env, query, lang);
    const offset = (page - 1) * PAGE_SIZE;
    const slice = hits.slice(offset, offset + PAGE_SIZE);
    let rows = [];
    if (slice.length) {
      const ids = slice.map(x => x.id);
      const ph = ids.map((_, i) => '?' + (i + 1)).join(',');
      const found = await env.DB.prepare(
        'SELECT id, ' + slug + ' AS slug, ' + title + ' AS title, substr(' + body + ', 1, ' + SNIPPET + ') AS snippet, ' +
        'topic, published_at FROM stories_published WHERE is_visible = 1 AND ' + slug + ' IS NOT NULL AND id IN (' + ph + ')'
      ).bind(...ids).all();
      const byId = {};
      (found.results || []).forEach(r => { byId[r.id] = r; });
      rows = ids.map(id => byId[id]).filter(Boolean);
    }
    const items = rows.map(r => ({
      slug: r.slug, title: r.title, snippet: r.snippet, topic: r.topic, date: r.published_at, match: 'meaning'
    }));
    return json({
      lang: lang,
      page: page,
      total: hits.length,
      has_more: offset + slice.length < hits.length,
      items: items
    });
  } catch (err) {
    return json({ error: 'search failed' }, 500);
  }
}
