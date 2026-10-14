// Group a market's headlines into stories ("Gunman kills 9 at Erie bar" plus its 14 follow-ups), so you pick a story
// to push on instead of an article. Pure function: no DB, so it's easy to test.
import { SEVERE_RX, ONGOING_RX, RESOLVED_RX } from './types.js';

const STOP = new Set(('the a an and or but of in on at to for from by with as is was were are be been has have had after before over into '
  + 'about amid near says said say new news video watch live update updates report reports latest what who why how when where this that '
  + 'his her their its they them he she it we you our more than not no up out off one two man woman people police officials authorities '
  + 'county city state suspect suspects').split(' '));
const SEVERE = new RegExp(SEVERE_RX, 'i'), ONGOING = new RegExp(ONGOING_RX, 'i'), RESOLVED = new RegExp(RESOLVED_RX, 'i');
const H = 3600e3;
const LINK_HOURS = 96;          // follow-ups more than 4 days apart are treated as a different story
const SIM_ANY = 0.34;           // weighted word overlap needed to join two headlines
const SIM_SAME_CITY = 0.18;     // lower bar when both are tagged to the same city and type within 2 days

const stem = w => w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
export const tokens = t => [...new Set(String(t).toLowerCase().replace(/['’]s\b/g, '').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
  .filter(w => w && (/^\d+$/.test(w) || w.length > 2) && !STOP.has(w)).map(stem))];

// " - CNN", " | Fox News" style outlet tails
export const cleanTitle = t => String(t).replace(/\s+[|\-–—]\s+[^|\-–—]{2,40}$/, m => m.trim().split(/\s+/).length <= 6 ? '' : m).trim();

export function clusterStories(articles, now = Date.now()) {
  // one item per URL (the same article can be stored under two types)
  const byUrl = new Map();
  for (const a of articles) {
    const t = +new Date(a.seen_at);
    const cur = byUrl.get(a.url);
    if (cur) { cur.types.add(a.type); cur.ids.push(+a.id); continue; }
    byUrl.set(a.url, { ...a, id: +a.id, ids: [+a.id], t, types: new Set([a.type]), tok: tokens(cleanTitle(a.title)) });
  }
  const items = [...byUrl.values()];
  const n = items.length;
  if (!n) return [];

  // rare words count more: "erie" or "bar" ties stories together, "shooting" alone does not
  const df = new Map();
  for (const it of items) for (const w of it.tok) df.set(w, (df.get(w) || 0) + 1);
  const idf = w => Math.log(1 + n / (df.get(w) || 1));
  for (const it of items) it.mass = it.tok.reduce((s, w) => s + idf(w), 0) || 1;
  const sim = (a, b) => {
    const B = new Set(b.tok); let s = 0;
    for (const w of a.tok) if (B.has(w)) s += idf(w);
    return s / Math.min(a.mass, b.mass);
  };

  const parent = items.map((_, i) => i);
  const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const S = items.map(() => new Array(n));
  for (let i = 0; i < n; i++) for (let k = i + 1; k < n; k++) {
    const a = items[i], b = items[k];
    if (Math.abs(a.t - b.t) > LINK_HOURS * H) continue;
    const s = S[i][k] = S[k][i] = sim(a, b);
    const sameCity = a.city && a.city === b.city && [...a.types].some(t => b.types.has(t)) && Math.abs(a.t - b.t) <= 48 * H;
    if (s >= SIM_ANY || (sameCity && s >= SIM_SAME_CITY)) parent[find(i)] = find(k);
  }

  const groups = new Map();
  items.forEach((it, i) => { const r = find(i); (groups.get(r) || groups.set(r, []).get(r)).push(i); });

  const stories = [...groups.values()].map(idx => {
    const arts = idx.map(i => items[i]).sort((a, b) => b.t - a.t);
    const count = (key) => { const m = new Map(); for (const a of arts) for (const v of [].concat(key(a))) if (v) m.set(v, (m.get(v) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]); };
    const types = count(a => [...a.types]), cities = count(a => a.city);
    // label: the headline most like the rest of the story, then most recent
    let best = idx[0], bestS = -1;
    for (const i of idx) {
      const s = idx.reduce((sum, k) => sum + (k === i ? 0 : S[i][k] ?? 0), 0);
      if (s > bestS + 1e-9) { best = i; bestS = s; }
    }
    const titles = arts.map(a => a.title).join(' \n ');
    const first = Math.min(...arts.map(a => a.t)), last = Math.max(...arts.map(a => a.t));
    const outlets = new Set(arts.map(a => a.domain || a.url)).size;
    return {
      id: Math.min(...arts.flatMap(a => a.ids)),
      label: cleanTitle(items[best].title),
      type: types[0]?.[0] || null, types: types.map(([t]) => t),
      city: cities[0]?.[0] || null, cities: cities.map(([c]) => c),
      outlets, articles: arts.length, first_seen: new Date(first).toISOString(), last_seen: new Date(last).toISOString(),
      severe: SEVERE.test(titles), at_large: ONGOING.test(titles), arrest: RESOLVED.test(titles),
      // bigger and fresher first; a story keeps most of its weight for about 5 days
      rank: outlets * Math.exp(-Math.max(0, now - last) / (5 * 24 * H)),
      headlines: arts.map(a => ({ id: a.id, ids: a.ids, title: a.title, url: a.url, domain: a.domain, city: a.city, type: [...a.types][0], seen_at: new Date(a.t).toISOString() })),
    };
  });
  return stories.sort((a, b) => b.rank - a.rank);
}
