/* Search over published stories.
   Query string: q (text), lang (en|ru), page (1-based).
   Plain LIKE matching over title, body and topic. No full-text module.
   Returns at most PAGE_SIZE rows per call. */

const PAGE_SIZE = 20;
const MAX_PAGE = 50;
const MAX_WORDS = 6;
const SNIPPET = 220;

function pickLang(value) {
  return value === 'ru' ? 'ru' : 'en';
}

function words(query) {
  return String(query || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, MAX_WORDS);
}

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
  const terms = words(url.searchParams.get('q'));

  let page = parseInt(url.searchParams.get('page') || '1', 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (page > MAX_PAGE) page = MAX_PAGE;

  if (!terms.length) {
    return json({ lang: lang, page: 1, total: 0, has_more: false, items: [] });
  }

  const slug = 'url_path_' + lang;
  const title = 'title_' + lang;
  const body = 'body_' + lang;

  const binds = [];
  const clauses = terms.map(function (word) {
    binds.push('%' + word + '%');
    const n = binds.length;
    return (
      '(lower(' + title + ') LIKE ?' + n +
      ' OR lower(' + body + ') LIKE ?' + n +
      " OR replace(topic,'-',' ') LIKE ?" + n + ')'
    );
  });

  const where =
    'is_visible = 1 AND ' + title + ' IS NOT NULL AND ' + slug + ' IS NOT NULL AND ' +
    clauses.join(' AND ');

  try {
    const counted = await env.DB.prepare(
      'SELECT COUNT(*) AS total FROM stories_published WHERE ' + where
    ).bind(...binds).first();

    const total = counted ? counted.total : 0;
    const offset = (page - 1) * PAGE_SIZE;

    const found = await env.DB.prepare(
      'SELECT ' + slug + ' AS slug, ' + title + ' AS title, ' +
      'substr(' + body + ', 1, ' + SNIPPET + ') AS snippet, ' +
      'topic, published_at ' +
      'FROM stories_published WHERE ' + where + ' ' +
      'ORDER BY published_at DESC, id DESC ' +
      'LIMIT ?' + (binds.length + 1) + ' OFFSET ?' + (binds.length + 2)
    ).bind(...binds, PAGE_SIZE, offset).all();

    const items = (found.results || []).map(function (row) {
      return {
        slug: row.slug,
        title: row.title,
        snippet: row.snippet,
        topic: row.topic,
        date: row.published_at
      };
    });

    return json({
      lang: lang,
      page: page,
      total: total,
      has_more: offset + items.length < total,
      items: items
    });
  } catch (err) {
    return json({ error: 'search failed' }, 500);
  }
}
