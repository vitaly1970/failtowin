/* Comments under a story.
   GET  ?slug=...           published comments, oldest first
   POST {slug, name, body}  new comment; checked by the model before it goes up.
   Rows live in the comments table; kind = 'comment' here (tips will share the table). */

const MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
const MIN_LEN = 10;
const MAX_LEN = 2000;
const MAX_NAME = 60;
const PER_IP_10MIN = 5;

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

async function storyId(env, slug) {
  const clean = String(slug || '').trim().slice(0, 200);
  if (!clean) return null;
  const row = await env.DB.prepare(
    'SELECT id FROM stories_published WHERE is_visible = 1 AND (url_path_en = ?1 OR url_path_ru = ?1)'
  ).bind(clean).first();
  return row ? row.id : null;
}

async function moderate(env, text) {
  const prompt =
    'You moderate reader comments on a website of true stories about personal mistakes and failures. ' +
    'Swearing and dark humour are fine. Reject only: spam or advertising, links pushing a product or site, ' +
    'hate speech, threats, harassment aimed at a person, sexual content, personal data of other people, ' +
    'or meaningless gibberish. Answer with exactly one word: APPROVE or REJECT.\n\nComment:\n"""' +
    text + '"""';
  const out = await env.AI.run(MODEL, {
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 5,
    temperature: 0
  });
  const word = String((out && out.response) || '').trim().toUpperCase();
  if (word.indexOf('APPROVE') === 0) return 'approved';
  if (word.indexOf('REJECT') === 0) return 'rejected';
  return null;
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  try {
    const id = await storyId(env, url.searchParams.get('slug'));
    if (!id) return json({ comments: [] });
    const rows = await env.DB.prepare(
      "SELECT name, body, created_at FROM comments " +
      "WHERE story_id = ?1 AND kind = 'comment' AND status = 'approved' ORDER BY created_at ASC, id ASC"
    ).bind(id).all();
    return json({ comments: (rows.results || []).map(r => ({ name: r.name, body: r.body, date: r.created_at })) });
  } catch (err) {
    return json({ error: 'lookup failed' }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  let data;
  try { data = await request.json(); } catch (e) { return json({ error: 'bad request' }, 400); }

  if (data.website) return json({ status: 'pending' });

  const body = String(data.body || '').replace(/\r/g, '').trim();
  const name = String(data.name || '').trim().slice(0, MAX_NAME);
  if (body.length < MIN_LEN) return json({ error: 'too short' }, 400);
  if (body.length > MAX_LEN) return json({ error: 'too long' }, 400);

  const ip = request.headers.get('cf-connecting-ip') || '';

  try {
    const id = await storyId(env, data.slug);
    if (!id) return json({ error: 'not found' }, 404);

    const recent = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM comments WHERE ip = ?1 AND created_at > datetime('now', '-10 minutes')"
    ).bind(ip).first();
    if (recent && recent.n >= PER_IP_10MIN) return json({ error: 'slow down' }, 429);

    const ins = await env.DB.prepare(
      "INSERT INTO comments (story_id, kind, name, body, status, ip) VALUES (?1, 'comment', ?2, ?3, 'pending', ?4)"
    ).bind(id, name || null, body, ip).run();
    const rowId = ins.meta.last_row_id;

    let status = null;
    try { status = await moderate(env, body); } catch (e) { status = null; }

    if (status) {
      await env.DB.prepare('UPDATE comments SET status = ?1 WHERE id = ?2').bind(status, rowId).run();
    }
    if (status === 'approved') {
      return json({ status: 'approved', comment: { name: name || null, body: body, date: new Date().toISOString() } });
    }
    return json({ status: status || 'pending' });
  } catch (err) {
    return json({ error: 'save failed' }, 500);
  }
}
