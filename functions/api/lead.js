/* Help request ("lead") from help.html.
   POST {name, email, phone, country, city, message, consent, from, topic, website}
   Saves the lead with consent proof, tags the kind of help with the model,
   and emails a confirmation link. A lead counts only after the link is clicked. */

const MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
const CATEGORIES = ['legal', 'repair', 'insurance', 'money', 'health', 'other'];
const PER_IP_HOUR = 3;
const SENDER = 'Fedya at Fail To Win <help@failtowin.org>';
const SITE = 'https://failtowin.org';

export const CONSENT_TEXT =
  'I agree my details may be shared with a specialist or partner company ' +
  'who may contact me by email or phone about my situation.';

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function clip(v, n) {
  return String(v || '').replace(/\r/g, '').trim().slice(0, n);
}

function token() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

async function categorize(env, message, topic) {
  const prompt =
    'A reader of a website about personal mistakes asks for help from a specialist. ' +
    'Pick the one kind of specialist they need: legal (lawyer, dispute, fraud, contract), ' +
    'repair (builder, mechanic, technician, contractor), insurance (claim, policy), ' +
    'money (debt, refund, bank, taxes, financial advice), health (doctor, therapist, clinic), other. ' +
    'Answer with exactly one word from: legal, repair, insurance, money, health, other.\n\n' +
    'Topic of the story they came from: ' + (topic || 'unknown') + '\n\nTheir message:\n"""' + message + '"""';
  const out = await env.AI.run(MODEL, {
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 4,
    temperature: 0
  });
  const word = String((out && out.response) || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  return CATEGORIES.indexOf(word) >= 0 ? word : 'other';
}

async function sendMail(env, to, name, link) {
  if (!env.RESEND_API_KEY) return false;
  const text =
    'Hi ' + name + ',\n\n' +
    'You asked for help on The Encyclopedia of Fuckups. Click the link below to confirm it was you, ' +
    'and we will pass your request to someone who fixes this kind of thing:\n\n' + link + '\n\n' +
    'If you did not ask for help, just ignore this email.\n\nFedya';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: SENDER, to: [to], subject: 'Confirm your request for help', text: text })
  });
  return res.ok;
}

export async function onRequestPost({ request, env }) {
  let d;
  try { d = await request.json(); } catch (e) { return json({ error: 'bad request' }, 400); }

  if (d.website) return json({ status: 'sent' });

  const name = clip(d.name, 80);
  const email = clip(d.email, 160).toLowerCase();
  const phone = clip(d.phone, 40);
  const country = clip(d.country, 80);
  const city = clip(d.city, 80);
  const message = clip(d.message, 2000);
  const from = clip(d.from, 200);
  const topic = clip(d.topic, 40);

  if (!name || !country || !city) return json({ error: 'missing' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'email' }, 400);
  if (message.length < 10) return json({ error: 'too short' }, 400);
  if (d.consent !== true) return json({ error: 'consent' }, 400);

  const ip = request.headers.get('cf-connecting-ip') || '';

  try {
    const recent = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM leads WHERE ip = ?1 AND created_at > datetime('now', '-1 hour')"
    ).bind(ip).first();
    if (recent && recent.n >= PER_IP_HOUR) return json({ error: 'slow down' }, 429);

    let storyId = null;
    if (from) {
      const s = await env.DB.prepare(
        'SELECT id FROM stories_published WHERE url_path_en = ?1 OR url_path_ru = ?1'
      ).bind(from).first();
      if (s) storyId = s.id;
    }

    let category = 'other';
    try { category = await categorize(env, message, topic); } catch (e) { category = 'other'; }

    const t = token();
    await env.DB.prepare(
      'INSERT INTO leads (story_id, story_slug, topic, name, email, phone, country, city, message, category, ' +
      'consent_text, consent_at, page_url, ip, user_agent, token) ' +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, datetime('now'), ?12, ?13, ?14, ?15)"
    ).bind(
      storyId, from || null, topic || null, name, email, phone || null, country, city, message, category,
      CONSENT_TEXT, request.headers.get('referer') || null, ip,
      (request.headers.get('user-agent') || '').slice(0, 300), t
    ).run();

    let sent = false;
    try { sent = await sendMail(env, email, name, SITE + '/confirm?t=' + t); } catch (e) { sent = false; }
    if (sent) {
      await env.DB.prepare('UPDATE leads SET mail_sent = 1 WHERE token = ?1').bind(t).run();
    }
    return json({ status: 'sent' });
  } catch (err) {
    return json({ error: 'save failed' }, 500);
  }
}
