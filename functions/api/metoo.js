/* "Same thing happened to me" under a story.
   GET  ?slug=...&voter=...   -> {count, mine}
   POST {slug, voter}         -> toggles this visitor's mark, returns {count, mine}
   voter is a random id kept in the visitor's browser; without it the connection address is used. */

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function voterId(request, raw) {
  const v = String(raw || '').trim();
  if (/^[a-z0-9]{16,40}$/i.test(v)) return 'b:' + v;
  return 'ip:' + (request.headers.get('cf-connecting-ip') || 'unknown');
}

async function storyId(env, slug) {
  const s = String(slug || '').trim().slice(0, 200);
  if (!s) return null;
  const row = await env.DB.prepare(
    'SELECT id FROM stories_published WHERE is_visible = 1 AND (url_path_en = ?1 OR url_path_ru = ?1)'
  ).bind(s).first();
  return row ? row.id : null;
}

async function state(env, id, voter) {
  const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM metoo WHERE story_id = ?1').bind(id).first();
  const m = await env.DB.prepare('SELECT 1 AS x FROM metoo WHERE story_id = ?1 AND voter = ?2').bind(id, voter).first();
  return { count: c ? c.n : 0, mine: !!m };
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  try {
    const id = await storyId(env, url.searchParams.get('slug'));
    if (!id) return json({ count: 0, mine: false });
    return json(await state(env, id, voterId(request, url.searchParams.get('voter'))));
  } catch (e) {
    return json({ error: 'failed' }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  let d;
  try { d = await request.json(); } catch (e) { return json({ error: 'bad request' }, 400); }
  try {
    const id = await storyId(env, d.slug);
    if (!id) return json({ error: 'not found' }, 404);
    const voter = voterId(request, d.voter);
    const had = await env.DB.prepare('SELECT 1 AS x FROM metoo WHERE story_id = ?1 AND voter = ?2').bind(id, voter).first();
    if (had) await env.DB.prepare('DELETE FROM metoo WHERE story_id = ?1 AND voter = ?2').bind(id, voter).run();
    else await env.DB.prepare('INSERT OR IGNORE INTO metoo (story_id, voter) VALUES (?1, ?2)').bind(id, voter).run();
    return json(await state(env, id, voter));
  } catch (e) {
    return json({ error: 'failed' }, 500);
  }
}
