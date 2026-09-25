/* Fedya's advice: a summary of where people usually got burned doing what the reader plans.
   GET ?q=...&lang=en|ru
   Takes the same relevant stories as search (_shared/relevance.js), counts mistake types,
   asks the model to phrase the top ones, caches the answer per query. */

import { relevantStories, pickLang } from '../_shared/relevance.js';

const WRITE_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const MIN_STORIES = 5;
const TOP_TYPES = 5;
const MAX_WORDS = 6;

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300' }
  });
}

function words(q) {
  return String(q || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean).slice(0, MAX_WORDS);
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
    let hits = [];
    try { hits = await relevantStories(env, query, lang); } catch (e) { hits = []; }
    const ids = hits.map(x => x.id);

    if (ids.length < MIN_STORIES) return json({ show: false, total: ids.length });

    const slug = 'url_path_' + lang, title = 'title_' + lang, lesson = 'lesson_' + lang;
    const rows = [];
    for (let i = 0; i < ids.length; i += 90) {
      const part = ids.slice(i, i + 90);
      const ph = part.map((_, k) => '?' + (k + 1)).join(',');
      const found = await env.DB.prepare(
        'SELECT s.id, s.' + slug + ' AS slug, s.' + title + ' AS title, s.' + lesson + ' AS lesson, ' +
        's.mistake_type_id AS type_id, s.interest AS interest, t.label AS label FROM stories_published s ' +
        'LEFT JOIN mistake_types t ON t.id = s.mistake_type_id WHERE s.id IN (' + ph + ')'
      ).bind(...part).all();
      rows.push.apply(rows, found.results || []);
    }

    rows.sort((a, b) => (b.interest == null ? 50 : b.interest) - (a.interest == null ? 50 : a.interest));
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
