/* One-off embedding pass over published stories.
   GET /api/reindex?lang=en|ru[&force=1][&limit=N]
   Splits each story into chunks, embeds them with Workers AI,
   stores the vectors as int8 base64 in emb_en / emb_ru. */

const MODEL = '@cf/baai/bge-base-en-v1.5';
const DIM = 768;
const CHUNK_CHARS = 320;
const MIN_CHUNK = 25;
const MAX_CHUNKS = 16;
const BATCH = 8;

function pickLang(value) {
  return value === 'ru' ? 'ru' : 'en';
}

function json(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

function chunksFor(row, lang) {
  const out = [];
  const push = function (text) {
    const t = String(text || '').trim();
    if (t.length >= MIN_CHUNK) out.push(t);
  };

  push(row['title_' + lang]);
  push(row['what_happened_' + lang]);
  push(row['outcome_' + lang]);
  push(row['lesson_' + lang]);

  const body = String(row['body_' + lang] || '');
  const sentences = body.split(/(?<=[.!?])\s+/);
  let buffer = '';
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    if ((buffer + ' ' + s).trim().length < CHUNK_CHARS) {
      buffer = (buffer + ' ' + s).trim();
    } else {
      push(buffer);
      buffer = s;
    }
  }
  push(buffer);

  return out.slice(0, MAX_CHUNKS);
}

function packInt8(vectors) {
  const bytes = new Uint8Array(vectors.length * DIM);
  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i];
    let norm = 0;
    for (let d = 0; d < DIM; d++) norm += v[d] * v[d];
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < DIM; d++) {
      let q = Math.round((v[d] / norm) * 127);
      if (q > 127) q = 127;
      if (q < -127) q = -127;
      bytes[i * DIM + d] = q < 0 ? q + 256 : q;
    }
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function embed(env, texts) {
  const vectors = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const res = await env.AI.run(MODEL, { text: slice });
    const data = res && res.data ? res.data : [];
    for (let k = 0; k < data.length; k++) vectors.push(data[k]);
  }
  return vectors;
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const lang = pickLang(url.searchParams.get('lang'));
  const force = url.searchParams.get('force') === '1';
  const limit = parseInt(url.searchParams.get('limit') || '200', 10);

  if (!env.AI) return json({ error: 'AI binding missing' }, 500);

  const col = 'emb_' + lang;
  const where =
    'is_visible = 1 AND title_' + lang + ' IS NOT NULL' +
    (force ? '' : ' AND (' + col + ' IS NULL OR ' + col + " = '')");

  let rows;
  try {
    const found = await env.DB.prepare(
      'SELECT id, title_' + lang + ', body_' + lang + ', what_happened_' + lang +
      ', outcome_' + lang + ', lesson_' + lang +
      ' FROM stories_published WHERE ' + where + ' ORDER BY id LIMIT ?1'
    ).bind(limit).all();
    rows = found.results || [];
  } catch (err) {
    return json({ error: 'read failed', detail: String(err) }, 500);
  }

  let done = 0;
  let chunksTotal = 0;
  const failed = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const texts = chunksFor(row, lang);
    if (!texts.length) continue;
    try {
      const vectors = await embed(env, texts);
      if (vectors.length !== texts.length) throw new Error('vector count mismatch');
      const packed = packInt8(vectors);
      await env.DB.prepare(
        'UPDATE stories_published SET ' + col + ' = ?1 WHERE id = ?2'
      ).bind(packed, row.id).run();
      done++;
      chunksTotal += texts.length;
    } catch (err) {
      failed.push({ id: row.id, detail: String(err) });
    }
  }

  return json({
    lang: lang,
    considered: rows.length,
    indexed: done,
    chunks: chunksTotal,
    failed: failed
  });
}
