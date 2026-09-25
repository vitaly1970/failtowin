/* Tags stories with the kind of mistake, for Fedya's advice.
   POST ?step=raw&limit=20   next untagged stories get a short mistake label from the model
   POST ?step=types          all labels are grouped by meaning into mistake types
   POST ?step=interest&limit=20  next unrated stories get an interest score 0-100
   GET                       progress */

const LABEL_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
const SAME_TYPE = 0.75;

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

async function label(env, row) {
  const prompt =
    'Below is a short breakdown of a true story about a personal mistake. ' +
    'Name the mistake itself as a short generic action, 3 to 7 words, in plain English, ' +
    'written so the same kind of mistake in other stories gets the same wording. ' +
    'Examples: "Paid a large deposit upfront", "Skipped a written contract", "Ignored early warning signs", ' +
    '"Trusted a seller without checking". No names, no places, no details. Answer with the label only.\n\n' +
    'Title: ' + (row.title || '') + '\nPoint of no return: ' + (row.what || '') +
    '\nWhat I would do differently: ' + (row.lesson || '');
  const out = await env.AI.run(LABEL_MODEL, {
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 24,
    temperature: 0
  });
  return String((out && out.response) || '').split('\n')[0].replace(/^["'\s]+|["'.\s]+$/g, '').slice(0, 80);
}

async function stepRaw(env, limit) {
  const rows = (await env.DB.prepare(
    'SELECT id, COALESCE(title_en, title_ru) AS title, COALESCE(what_happened_en, what_happened_ru) AS what, ' +
    'COALESCE(lesson_en, lesson_ru) AS lesson FROM stories_published ' +
    'WHERE mistake_raw IS NULL ORDER BY id LIMIT ?1'
  ).bind(limit).all()).results || [];
  const updates = [];
  let failed = 0;
  for (const row of rows) {
    let text = '';
    try { text = await label(env, row); } catch (e) { text = ''; }
    if (!text) { failed++; continue; }
    updates.push(env.DB.prepare('UPDATE stories_published SET mistake_raw = ?1 WHERE id = ?2').bind(text, row.id));
  }
  if (updates.length) await env.DB.batch(updates);
  return { done: updates.length, failed: failed };
}

function answerText(out) {
  return String((out && (out.response || (out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content))) || '');
}

async function rate(env, row) {
  const prompt =
    'Rate this true story about a personal mistake for a reader browsing a site of such stories. ' +
    'Give four scores from 1 to 10: "unusual" (how rare and surprising the situation is), ' +
    '"stakes" (how much the person lost: money, health, years, relationships), ' +
    '"twist" (how unexpected the turn of events is), "lesson" (how useful the lesson is to someone else). ' +
    'Be strict: an ordinary story gets 3 to 5. Answer with JSON only, like {"unusual":5,"stakes":5,"twist":5,"lesson":5}.\n\n' +
    'Title: ' + (row.title || '') + '\nStory: ' + String(row.body || '').slice(0, 2500);
  const out = await env.AI.run(LABEL_MODEL, { messages: [{ role: 'user', content: prompt }], max_tokens: 60, temperature: 0 });
  let j = null;
  const r = out && out.response;
  if (r && typeof r === 'object') j = r;
  else {
    const t = answerText(out);
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b <= a) { rate.last = t.slice(0, 200); return null; }
    try { j = JSON.parse(t.slice(a, b + 1)); } catch (e) { rate.last = t.slice(0, 200); return null; }
  }
  const v = k => Math.min(10, Math.max(1, Number(j[k]) || 0));
  if (!j.unusual || !j.stakes || !j.twist || !j.lesson) return null;
  // weights: unusual 30, stakes 30, twist 20, lesson 20
  return Math.round((v('unusual') * 3 + v('stakes') * 3 + v('twist') * 2 + v('lesson') * 2) * 10 / 10);
}

async function stepInterest(env, limit) {
  const rows = (await env.DB.prepare(
    'SELECT id, COALESCE(title_en, title_ru) AS title, COALESCE(body_en, body_ru) AS body FROM stories_published ' +
    'WHERE interest IS NULL ORDER BY id LIMIT ?1'
  ).bind(limit).all()).results || [];
  const updates = [];
  let failed = 0;
  for (const row of rows) {
    let n = null;
    try { n = await rate(env, row); } catch (e) { n = null; }
    if (n == null) { failed++; continue; }
    updates.push(env.DB.prepare('UPDATE stories_published SET interest = ?1 WHERE id = ?2').bind(n, row.id));
  }
  if (updates.length) await env.DB.batch(updates);
  return { done: updates.length, failed: failed, sample: failed ? (rate.last || '') : undefined };
}

async function stepTypes(env) {
  const rows = (await env.DB.prepare(
    "SELECT id, mistake_raw FROM stories_published WHERE mistake_raw IS NOT NULL AND mistake_raw <> ''"
  ).all()).results || [];
  const labels = [];
  const idsByLabel = {};
  rows.forEach(function (r) {
    const key = r.mistake_raw.toLowerCase();
    if (!idsByLabel[key]) { idsByLabel[key] = []; labels.push({ key: key, text: r.mistake_raw }); }
    idsByLabel[key].push(r.id);
  });

  const vecs = [];
  for (let i = 0; i < labels.length; i += 100) {
    const res = await env.AI.run(EMBED_MODEL, { text: labels.slice(i, i + 100).map(l => l.text) });
    (res.data || []).forEach(function (v) {
      let n = 0; for (let d = 0; d < v.length; d++) n += v[d] * v[d];
      n = Math.sqrt(n) || 1;
      vecs.push(v.map(x => x / n));
    });
  }

  // biggest labels first so they become the name of their group
  const order = labels.map((l, i) => i).sort((a, b) => idsByLabel[labels[b].key].length - idsByLabel[labels[a].key].length);
  const groups = [];
  order.forEach(function (i) {
    let best = -1, bestG = null;
    groups.forEach(function (g) {
      let dot = 0; const c = vecs[g.head];
      for (let d = 0; d < c.length; d++) dot += c[d] * vecs[i][d];
      if (dot > best) { best = dot; bestG = g; }
    });
    if (bestG && best >= SAME_TYPE) bestG.members.push(i);
    else groups.push({ head: i, members: [i] });
  });

  await env.DB.prepare('UPDATE stories_published SET mistake_type_id = NULL').run();
  await env.DB.prepare('DELETE FROM mistake_types').run();
  const writes = [];
  let typed = 0;
  groups.forEach(function (g, n) {
    const typeId = n + 1;
    const ids = [];
    g.members.forEach(i => ids.push.apply(ids, idsByLabel[labels[i].key]));
    writes.push(env.DB.prepare('INSERT INTO mistake_types (id, label, stories) VALUES (?1, ?2, ?3)')
      .bind(typeId, labels[g.head].text, ids.length));
    for (let k = 0; k < ids.length; k += 90) {
      const part = ids.slice(k, k + 90);
      writes.push(env.DB.prepare('UPDATE stories_published SET mistake_type_id = ?1 WHERE id IN (' +
        part.map((_, j) => '?' + (j + 2)).join(',') + ')').bind(typeId, ...part));
    }
    typed += ids.length;
  });
  for (let k = 0; k < writes.length; k += 200) await env.DB.batch(writes.slice(k, k + 200));
  await env.DB.prepare('DELETE FROM advice_cache').run();
  return { labels: labels.length, types: groups.length, stories: typed };
}

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  const step = url.searchParams.get('step');
  try {
    if (step === 'raw') {
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 1), 40);
      return json(await stepRaw(env, limit));
    }
    if (step === 'types') return json(await stepTypes(env));
    if (step === 'interest') {
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 1), 40);
      return json(await stepInterest(env, limit));
    }
    return json({ error: 'unknown step' }, 400);
  } catch (err) {
    return json({ error: String(err && err.message || err) }, 500);
  }
}

export async function onRequestGet({ env }) {
  const r = await env.DB.prepare(
    'SELECT COUNT(*) AS total, SUM(mistake_raw IS NOT NULL) AS labelled, SUM(mistake_type_id IS NOT NULL) AS typed, SUM(interest IS NOT NULL) AS rated FROM stories_published'
  ).first();
  const t = await env.DB.prepare('SELECT COUNT(*) AS n FROM mistake_types').first();
  return json({ total: r.total, labelled: r.labelled, typed: r.typed, rated: r.rated, types: t.n });
}
