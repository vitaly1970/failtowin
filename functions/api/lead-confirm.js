/* Confirms a help request by the token from the email link.
   GET ?t=token -> {status: 'confirmed' | 'already' | 'invalid'} */

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

export async function onRequestGet({ request, env }) {
  const t = (new URL(request.url).searchParams.get('t') || '').trim();
  if (!/^[0-9a-f]{48}$/.test(t)) return json({ status: 'invalid' });
  try {
    const row = await env.DB.prepare('SELECT id, verified_at FROM leads WHERE token = ?1').bind(t).first();
    if (!row) return json({ status: 'invalid' });
    if (row.verified_at) return json({ status: 'already' });
    await env.DB.prepare("UPDATE leads SET verified_at = datetime('now') WHERE id = ?1").bind(row.id).run();
    return json({ status: 'confirmed' });
  } catch (err) {
    return json({ status: 'error' }, 500);
  }
}
