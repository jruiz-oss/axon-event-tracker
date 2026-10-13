// Market ranking and the national-gated event feed. Shared by the API routes and the AI fit brief.
import { pool } from './db.js';
import { TYPES, ONGOING_RX, RESOLVED_RX, SEVERE_RX, MINOR_RX } from './types.js';
import { loadIncome, affordFor } from './income.js';
import { rankMarkets, actionFor, CALL_ORDER, NAT_MIN } from './score.js';

// Daily rollup per market and type: distinct outlets, plus headline cue counts (severity, unresolved, resolved).
export async function loadGroups(level, typeFilter, days = 75) {
  const mk = level === 'city' ? `(city || ', ' || state)` : 'state';
  const sql = `SELECT to_char(seen_at AT TIME ZONE 'UTC','YYYY-MM-DD') d, ${mk} AS mk, type,
      count(DISTINCT COALESCE(domain,url))::int domains, count(DISTINCT domain) FILTER (WHERE national)::int national, count(*)::int n,
      count(*) FILTER (WHERE title ~* $2)::int severe, count(*) FILTER (WHERE title ~* $3)::int minor,
      count(*) FILTER (WHERE title ~* $4)::int ongoing, count(*) FILTER (WHERE title ~* $5)::int resolved
    FROM articles WHERE NOT dismissed AND trusted ${level === 'city' ? 'AND city IS NOT NULL' : ''} AND seen_at > now() - ($1 || ' days')::interval GROUP BY 1,2,3`;
  const { rows } = await pool.query(sql, [String(days), SEVERE_RX, MINOR_RX, ONGOING_RX, RESOLVED_RX]);
  const groups = new Map();
  for (const r of rows) {
    if (typeFilter && !typeFilter.has(r.type)) continue;
    if (!groups.has(r.mk)) groups.set(r.mk, []);
    groups.get(r.mk).push(r);
  }
  return groups;
}
export const parseTypes = q => (q ? new Set(String(q).split(',').filter(t => TYPES[t])) : null);

// Full ranked list (not sliced). level: 'state' | 'city'. types: Set or null.
export async function rankedMarkets(level, types) {
  await loadIncome();
  let ranked = rankMarkets(await loadGroups(level, types), new Date(), affordFor);
  if (level !== 'state') return ranked;
  // A state is as hot as its hottest city: Cornell in Ithaca shouldn't be averaged away by all of New York's
  // normal coverage. Then attach the hottest affordable cities and rebuild the recommendation.
  const cityRanked = rankMarkets(await loadGroups('city', types), new Date(), affordFor).sort((a, b) => b.score - a.score);
  const byState = new Map(ranked.map(m => [m.key, m]));
  for (const c of cityRanked) {
    const st = c.key.split(', ')[1];
    let m = byState.get(st);
    if (!m) {
      m = { key: st, score: 0, prev: 0, delta: 0, topTypes: [], byType: {}, win: { lastTrigger: null, daysLeft: 0, incidents: 0, note: '' }, afford: affordFor(st) };
      byState.set(st, m); ranked.push(m);
    }
    if (c.score > m.score) {
      Object.assign(m, { score: c.score, prev: c.prev, delta: c.delta, topTypes: c.topTypes, byType: c.byType, ledBy: c.key.split(', ')[0] });
      if (c.win.lastTrigger != null && (m.win.lastTrigger == null || c.win.lastTrigger < m.win.lastTrigger)) m.win = c.win;
    }
  }
  for (const m of ranked) {
    m.cities = cityRanked.filter(c => c.key.endsWith(', ' + m.key) && c.score >= 20 && c.afford?.tier !== 'Low').slice(0, 4).map(c => c.key.split(', ')[0]);
    Object.assign(m, actionFor(m.score, m.topTypes, m.cities, m.win, m.afford));
  }
  return ranked.filter(m => m.score > 0).sort((a, b) => (CALL_ORDER[a.call] - CALL_ORDER[b.call]) || (b.score - a.score));
}

// Event feed: only stories from a state/type/day that cleared the national gate (or the day before, so a story that
// broke late evening UTC keeps its follow-ups). Local crime that never went national stays out of the feed.
// market: 'TX' or 'Houston, TX' or null. types: Set or null.
export async function majorEvents({ days = 14, market = null, types = null, limit = 120 } = {}) {
  const where = ['NOT a.dismissed', 'a.trusted', `a.seen_at > now() - ($1 || ' days')::interval`]; const args = [String(Math.min(+days || 14, 90)), NAT_MIN];
  if (market) {
    if (market.includes(', ')) { const [c, s] = market.split(', '); args.push(c, s); where.push(`a.city = $${args.length - 1} AND a.state = $${args.length}`); }
    else { args.push(market); where.push(`a.state = $${args.length}`); }
  }
  if (types && types.size) { args.push([...types]); where.push(`a.type = ANY($${args.length})`); }
  args.push(Math.max(1, Math.min(+limit || 120, 500)));
  const { rows } = await pool.query(`
    WITH major AS (
      SELECT state, type, (seen_at AT TIME ZONE 'UTC')::date dt FROM articles
      WHERE NOT dismissed AND trusted AND national AND seen_at > now() - ($1 || ' days')::interval - interval '1 day'
      GROUP BY 1, 2, 3 HAVING count(DISTINCT domain) >= $2)
    SELECT a.id,a.title,a.url,a.domain,a.seen_at,a.type,a.state,a.city FROM articles a
    WHERE ${where.join(' AND ')} AND EXISTS (SELECT 1 FROM major m WHERE m.state = a.state AND m.type = a.type
      AND (a.seen_at AT TIME ZONE 'UTC')::date - m.dt BETWEEN 0 AND 1)
    ORDER BY a.seen_at DESC LIMIT $${args.length}`, args);
  return rows;
}
