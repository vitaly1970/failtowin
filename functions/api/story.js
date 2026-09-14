/* One published story by its url path.
   Query string: slug (url path), lang (en|ru). */

function pickLang(value) {
  return value === 'ru' ? 'ru' : 'en';
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
  const slug = (url.searchParams.get('slug') || '').trim().slice(0, 200);

  if (!slug) return json({ error: 'not found' }, 404);

  const path = 'url_path_' + lang;

  try {
    const row = await env.DB.prepare(
      'SELECT ' + path + ' AS slug, ' +
      'title_' + lang + ' AS title, ' +
      'body_' + lang + ' AS body, ' +
      'person_' + lang + ' AS person, ' +
      'what_happened_' + lang + ' AS what_happened, ' +
      'outcome_' + lang + ' AS outcome, ' +
      'lesson_' + lang + ' AS lesson, ' +
      'topic, happened_year, source_name, source_url, published_at ' +
      'FROM stories_published WHERE is_visible = 1 AND ' + path + ' = ?1'
    ).bind(slug).first();

    if (!row || !row.title) return json({ error: 'not found' }, 404);

    return json({
      lang: lang,
      slug: row.slug,
      title: row.title,
      body: row.body,
      person: row.person,
      what_happened: row.what_happened,
      outcome: row.outcome,
      lesson: row.lesson,
      topic: row.topic,
      happened_year: row.happened_year,
      source_name: row.source_name,
      source_url: row.source_url,
      date: row.published_at
    });
  } catch (err) {
    return json({ error: 'lookup failed' }, 500);
  }
}
