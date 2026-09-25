/* Which stories are close in meaning to a query. Shared by search and Fedya's advice,
   so both see the same set and the same count. No word matching: if the meaning is not close,
   the story is not shown.
   A story is relevant when its best chunk scores at least STRONG, or within RELATIVE of the best story.
   Order: relevance first, interest second (see rank). */

export const MODELS = {
  en: { name: '@cf/baai/bge-base-en-v1.5', dim: 768 },
  ru: { name: '@cf/baai/bge-m3', dim: 1024 }
};
const FLOOR = 0.55;
const STRONG = 0.63;
const RELATIVE = 0.90;
const W_RELEVANCE = 0.7;
const W_INTEREST = 0.3;

let cache = null;

export function pickLang(v) { return v === 'ru' ? 'ru' : 'en'; }

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
    'SELECT id, interest, ' + col + ' AS emb FROM stories_published ' +
    'WHERE is_visible = 1 AND ' + col + ' IS NOT NULL AND ' + col + " <> ''"
  ).all();
  const rows = (found.results || []).map(r => ({ id: r.id, interest: r.interest, vec: unpack(r.emb) }));
  cache = { lang: lang, rows: rows, at: Date.now() };
  return rows;
}

/* Returns relevant stories as [{id, score, interest, rank}], best first. */
export async function relevantStories(env, query, lang) {
  if (!env.AI) return [];
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
    if (best >= FLOOR) scored.push({ id: row.id, score: best, interest: row.interest });
  }
  if (!scored.length) return [];
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0].score;
  const cut = Math.min(STRONG, top * RELATIVE);
  const kept = scored.filter(x => x.score >= cut);
  const span = Math.max(top - cut, 0.0001);
  kept.forEach(function (x) {
    const rel = (x.score - cut) / span;
    const intr = (x.interest == null ? 50 : x.interest) / 100;
    x.rank = W_RELEVANCE * rel + W_INTEREST * intr;
  });
  kept.sort((a, b) => b.rank - a.rank);
  return kept;
}
