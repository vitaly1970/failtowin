/* Search over published stories.
   Query string: q (text), lang (en|ru), page (1-based).
   Two mechanisms side by side:
     - meaning: query embedded with Workers AI, compared against stored chunk
       vectors, best chunk wins per story;
     - letters: plain LIKE matching, kept as before.
   Meaning results lead, letter-only matches follow.
   Returns at most PAGE_SIZE rows per call. */

const PAGE_SIZE = 20;
const MAX_PAGE = 50;
const MAX_WORDS = 6;
const SNIPPET = 220;

const MODEL = '@cf/baai/bge-base-en-v1.5';
const DIM = 768;
const FLOOR = 0.55;
const RELATIVE = 0.90;
const MAX_MEANING = 40;

let cache = null;

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

function unpack(packed) {
  const binary = atob(packed);
  const bytes = new Int8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    const c = binary.charCodeAt(i);
    bytes[i] = c > 127 ? c - 256 : c;
  }
  return bytes;
}

async function loadIndex(env, lang) {
  if (cache && cache.lang === lang && Date.now() - cache.at < 300000) return cache.rows;
  const col = 'emb_' + lang;
  const found = await env.DB.prepare(
    'SELECT id, ' + col + ' AS emb FROM stories_published ' +
    'WHERE is_visible = 1 AND ' + col + ' IS NOT NULL AND ' + col + " <> ''"
  ).all();
  const rows = (found.results || []).map(function (row) {
    return { id: row.id, vec: unpack(row.emb) };
  });
  cache = { lang: lang, rows: rows, at: Date.now() };
  return rows;
}

async function meaningHits(env, query, lang) {
  if (!env.AI) return null;
  const index = await loadIndex(env, lang);
  if (!index.length) return null;

  const res = await env.AI.run(MODEL, { text: [query] });
  const raw = res && res.data && res.data[0];
  if (!raw) return null;

  let norm = 0;
  for (let d = 0; d < DIM; d++) norm += raw[d] * raw[d];
  norm = Math.sqrt(norm) || 1;
  const q = new Float32Array(DIM);
  for (let d = 0; d < DIM; d++) q[d] = raw[d] / norm;

  const scored = [];
  for (let i = 0; i < index.length; i++) {
    const vec = index[i].vec;
    const count = Math.floor(vec.length / DIM);
    let best = -1;
    for (let c = 0; c < count; c++) {
      let dot = 0;
      const base = c * DIM;
      for (let d = 0; d < DIM; d++) dot += q[d] * vec[base + d];
      dot = dot / 127;
      if (dot > best) best = dot;
    }
    if (best >= FLOOR) scored.push({ id: index[i].id, score: best });
  }
  if (!scored.length) return [];

  scored.sort(function (a, b) { return b.score - a.score; });
  const top = scored[0].score;
  return scored.filter(function (x) { return x.score >= top * RELATIVE; }).slice(0, MAX_MEANING);
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const lang = pickLang(url.searchParams.get('lang'));
  const query = String(url.searchParams.get('q') || '').trim();
  const terms = words(query);

  let page = parseInt(url.searchParams.get('page') || '1', 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (page > MAX_PAGE) page = MAX_PAGE;

  if (!terms.length) {
    return json({ lang: lang, page: 1, total: 0, has_more: false, items: [] });
  }

  const slug = 'url_path_' + lang;
  const title = 'title_' + lang;
  const body = 'body_' + lang;
  const columns =
    'SELECT id, ' + slug + ' AS slug, ' + title + ' AS title, ' +
    'substr(' + body + ', 1, ' + SNIPPET + ') AS snippet, topic, published_at ';

  try {
    let meaning = null;
    try {
      meaning = await meaningHits(env, query, lang);
    } catch (err) {
      meaning = null;
    }

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

    const letterWhere =
      'is_visible = 1 AND ' + title + ' IS NOT NULL AND ' + slug + ' IS NOT NULL AND ' +
      clauses.join(' AND ');

    const letterFound = await env.DB.prepare(
      columns + 'FROM stories_published WHERE ' + letterWhere +
      ' ORDER BY published_at DESC, id DESC LIMIT 200'
    ).bind(...binds).all();

    const letterRows = letterFound.results || [];

    let ordered = [];
    if (meaning && meaning.length) {
      const ids = meaning.map(function (x) { return x.id; });
      const placeholders = ids.map(function (_, i) { return '?' + (i + 1); }).join(',');
      const meaningFound = await env.DB.prepare(
        columns + 'FROM stories_published WHERE is_visible = 1 AND ' +
        slug + ' IS NOT NULL AND id IN (' + placeholders + ')'
      ).bind(...ids).all();

      const byId = {};
      (meaningFound.results || []).forEach(function (row) { byId[row.id] = row; });
      meaning.forEach(function (hit) {
        const row = byId[hit.id];
        if (row) ordered.push({ row: row, score: hit.score, how: 'meaning' });
      });

      const seen = {};
      ordered.forEach(function (x) { seen[x.row.id] = true; });
      letterRows.forEach(function (row) {
        if (!seen[row.id]) ordered.push({ row: row, score: 0, how: 'letters' });
      });
    } else {
      ordered = letterRows.map(function (row) {
        return { row: row, score: 0, how: 'letters' };
      });
    }

    const total = ordered.length;
    const offset = (page - 1) * PAGE_SIZE;
    const slice = ordered.slice(offset, offset + PAGE_SIZE);

    const items = slice.map(function (x) {
      return {
        slug: x.row.slug,
        title: x.row.title,
        snippet: x.row.snippet,
        topic: x.row.topic,
        date: x.row.published_at,
        match: x.how
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
