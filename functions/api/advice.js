/* Fedya's advice: a summary of where people usually got burned doing what the reader plans.
   GET ?q=...&lang=en|ru
   Finds every story close in meaning (no page cap), counts mistake types,
   asks the model to phrase the top ones, caches the answer per query. */

const MODELS = {
  en: { name: '@cf/baai/bge-base-en-v1.5', dim: 768 },
  ru: { name: '@cf/baai/bge-m3', dim: 1024 }
};
const WRITE_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const FLOOR = 0.55;
const STRONG = 0.63;
const RELATIVE = 0.90;
const MIN_STORIES = 5;
const TOP_TYPES = 5;
const MAX_WORDS = 6;

let cache = null;

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300' }
  });
}

function pickLang(v) { return v === 'ru' ? 'ru' : 'en'; }

function words(q) {
  return String(q || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean).slice(0, MAX_WORDS);
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
    'SELECT id, ' + col + ' AS emb FROM stories_published WHERE is_visible = 1 AND ' + col + ' IS NOT NULL AND ' + col + " <> ''"
  ).all();
  const rows = (found.results || []).map(r => ({ id: r.id, vec: unpack(r.emb) }));
  cache = { lang: lang, rows: rows, at: Date.now() };
  return rows;
}

async function meaningIds(env, query, lang) {
  const index = await loadIndex(env, lang);
  if (!index.length) return [];
  const DIM = MODELS[lang].dim;
  const res = await env.AI.run(MODELS[lang].name, { text: [query] });
  const raw = res && res.data && res.data[0];
  if (!raw) return [];
  let norm = 0;
  for (let d = 0; d < DIM; d++) norm += raw[d] * raw[d];
  norm = Math.sqrt(norm) || 1;
  const q = new Float32Array(DIM);
  for (let d = 0; d < DIM; d++) q[d] = raw[d] / norm;
  const scored = [];
  for (const row of index) {
    const count = Math.floor(row.vec.length / DIM);
    let best = -1;
    for (let c = 0; c < count; c++) {
      let dot = 0; const base = c * DIM;
      for (let d = 0; d < DIM; d++) dot += q[d] * row.vec[base + d];
      dot = dot / 127;
      if (dot > best) best = dot;
    }
    if (best >= FLOOR) scored.push({ id: row.id, score: best });
  }
  if (!scored.length) return [];
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0].score;
  return scored.filter(x => x.score >= STRONG || x.score >= top * RELATIVE).map(x => x.id);
}

function parseJson(text) {
  const s = String(text || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

async function write(env, query, groups) {
  const lines = groups.map(function (g, i) {
    return (i + 1) + '. Mistake: ' + g.label + ' (' + g.count + ' stories)\n' +
      g.examples.map(e => '   - Story "' + e.title + '". Lesson: ' + (e.lesson || '')).join('\n');
  }).join('\n');
  const prompt =
    'A reader is planning to: "' + query + '". Below are the most common mistakes people made in similar situations, ' +
    'with example stories.\n\n' + lines + '\n\n' +
    'Write the answer as JSON with two keys.\n' +
    '"items": an array with one object per mistake above, in the same order. Each object has "title" ' +
    '(the mistake in 3 to 8 plain words, sentence case) and "check" (one short sentence starting with "Check first:" ' +
    'saying what to verify before starting).\n' +
    '"checks": an array of exactly three short things to check before going ahead, each under 12 words. ' +
    'This array is at the top level, not inside items.\n' +
    'Plain, friendly English, a little wry. Answer with the JSON only, like this:\n' +
    '{"items":[{"title":"...","check":"Check first: ..."}],"checks":["...","...","..."]}';
  const out = await env.AI.run(WRITE_MODEL, {
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1200,
    temperature: 0.2
  });
  const textOut = out && (out.response || (out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content));
  if (textOut && typeof textOut === 'object') return textOut;
  return parseJson(textOut);
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const lang = pickLang(url.searchParams.get('lang'));
  const query = String(url.searchParams.get('q') || '').trim().slice(0, 200);
  const terms = words(query);
  if (!terms.length) return json({ show: false });

  const key = lang + ':' + terms.join(' ');
  try {
    const hit = await env.DB.prepare('SELECT body FROM advice_cache WHERE key = ?1').bind(key).first();
    if (hit) return json(JSON.parse(hit.body));
  } catch (e) { /* no cache */ }

  try {
    let ids = [];
    try { ids = await meaningIds(env, query, lang); } catch (e) { ids = []; }

    if (ids.length < MIN_STORIES) return json({ show: false, total: ids.length });

    const slug = 'url_path_' + lang, title = 'title_' + lang, lesson = 'lesson_' + lang;
    const rows = [];
    for (let i = 0; i < ids.length; i += 90) {
      const part = ids.slice(i, i + 90);
      const ph = part.map((_, k) => '?' + (k + 1)).join(',');
      const found = await env.DB.prepare(
        'SELECT s.id, s.' + slug + ' AS slug, s.' + title + ' AS title, s.' + lesson + ' AS lesson, ' +
        's.mistake_type_id AS type_id, t.label AS label FROM stories_published s ' +
        'LEFT JOIN mistake_types t ON t.id = s.mistake_type_id WHERE s.id IN (' + ph + ')'
      ).bind(...part).all();
      rows.push.apply(rows, found.results || []);
    }

    const byType = {};
    rows.forEach(function (r) {
      if (!r.type_id || !r.slug) return;
      if (!byType[r.type_id]) byType[r.type_id] = { label: r.label, count: 0, examples: [] };
      const g = byType[r.type_id];
      g.count++;
      if (g.examples.length < 3) g.examples.push({ slug: r.slug, title: r.title, lesson: r.lesson });
    });
    const groups = Object.keys(byType).map(k => byType[k]).sort((a, b) => b.count - a.count).slice(0, TOP_TYPES);
    if (!groups.length) return json({ show: false, total: ids.length });

    let text = null;
    try { text = await write(env, query, groups); } catch (e) { text = null; }
    const items = groups.map(function (g, i) {
      const t = text && text.items && text.items[i] || {};
      return {
        title: t.title || g.label,
        count: g.count,
        check: t.check || '',
        stories: g.examples.map(e => ({ slug: e.slug, title: e.title }))
      };
    });
    let checks = text && Array.isArray(text.checks) ? text.checks : [];
    if (!checks.length && text && text.items && text.items[0] && Array.isArray(text.items[0].checks)) checks = text.items[0].checks;
    checks = checks.slice(0, 3).filter(Boolean);
    const body = { show: true, total: rows.length, items: items, checks: checks };

    if (text) {
      try {
        await env.DB.prepare('INSERT OR REPLACE INTO advice_cache (key, lang, body) VALUES (?1, ?2, ?3)')
          .bind(key, lang, JSON.stringify(body)).run();
      } catch (e) { /* cache is optional */ }
    }
    return json(body);
  } catch (err) {
    return json({ show: false, error: 'failed' }, 500);
  }
}
