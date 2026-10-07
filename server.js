import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, migrate } from './lib/db.js';
import { TYPES, ONGOING_RX, RESOLVED_RX, SEVERE_RX, MINOR_RX, CLASSIFIER_VERSION } from './lib/types.js';
import { loadIncome, affordFor, incomeStatus } from './lib/income.js';
import { STATES } from './lib/geo.js';
import { rankMarkets, scoreMarket, dayKey, actionFor, CALL_ORDER } from './lib/score.js';
import { liveIngest, backfill, backfillStatus, probe, reprocessIfChanged, syncTrust } from './lib/ingest.js';

const app = express();
const __dir = path.dirname(fileURLToPath(import.meta.url));
const BACKFILL_DAYS = +process.env.BACKFILL_DAYS || 90;

// Optional shared password (set DASH_PASSWORD on Railway). Username is ignored.
app.use((req, res, next) => {
  const pw = process.env.DASH_PASSWORD;
  if (!pw || req.path === '/healthz') return next();
  const h = req.headers.authorization || '';
  const given = h.startsWith('Basic ') ? Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':') : '';
  if (given === pw) return next();
  res.set('WWW-Authenticate', 'Basic realm="Axon Event Tracker"').status(401).send('Auth required');
});
app.use(express.json());
app.use(express.static(path.join(__dir, 'public')));
app.get('/healthz', (_q, r) => r.send('ok'));

// Daily rollup per market and type: distinct outlets, plus headline cue counts (severity, unresolved, resolved).
async function loadGroups(level, typeFilter, days = 75) {
  const mk = level === 'city' ? `(city || ', ' || state)` : 'state';
  const sql = `SELECT to_char(seen_at AT TIME ZONE 'UTC','YYYY-MM-DD') d, ${mk} AS mk, type,
      count(DISTINCT COALESCE(domain,url))::int domains, count(*)::int n,
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
const parseTypes = q => (q ? new Set(String(q).split(',').filter(t => TYPES[t])) : null);

app.get('/api/meta', async (_q, res) => {
  res.json({ types: Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [k, { label: v.label, tier: v.tier, weight: v.weight }])), states: STATES, status: await backfillStatus(BACKFILL_DAYS), income: incomeStatus() });
});

app.get('/api/markets', async (req, res) => {
  try {
    const level = req.query.level === 'city' ? 'city' : 'state';
    const types = parseTypes(req.query.types);
    await loadIncome();
    let ranked = rankMarkets(await loadGroups(level, types), new Date(), affordFor);
    if (level === 'state') {
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
      ranked = ranked.filter(m => m.score > 0).sort((a, b) => (CALL_ORDER[a.call] - CALL_ORDER[b.call]) || (b.score - a.score));
    }
    res.json(ranked.slice(0, level === 'city' ? 50 : 60));
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.get('/api/events', async (req, res) => {
  const where = ['NOT dismissed', 'trusted', `seen_at > now() - ($1 || ' days')::interval`]; const args = [String(Math.min(+req.query.days || 14, 90))];
  if (req.query.market) {
    const m = String(req.query.market);
    if (m.includes(', ')) { const [c, s] = m.split(', '); args.push(c, s); where.push(`city = $${args.length - 1} AND state = $${args.length}`); }
    else { args.push(m); where.push(`state = $${args.length}`); }
  }
  const types = parseTypes(req.query.types);
  if (types && types.size) { args.push([...types]); where.push(`type = ANY($${args.length})`); }
  const { rows } = await pool.query(`SELECT id,title,url,domain,seen_at,type,state,city FROM articles WHERE ${where.join(' AND ')} ORDER BY seen_at DESC LIMIT 120`, args);
  res.json(rows);
});

app.post('/api/events/:id/dismiss', async (req, res) => {
  await pool.query(`UPDATE articles SET dismissed = TRUE WHERE id = $1`, [+req.params.id]);
  res.json({ ok: true });
});

app.get('/api/history', async (req, res) => {
  try {
    const level = req.query.level === 'city' ? 'city' : 'state';
    const days = Math.min(+req.query.days || 90, 180);
    const types = parseTypes(req.query.types), market = String(req.query.market);
    const rows = (await loadGroups(level, types, days + 75)).get(market) || [];
    // states use the same rule as /api/markets: the hotter of the state and its hottest city, day by day
    const cityRows = level === 'state'
      ? [...(await loadGroups('city', types, days + 75)).entries()].filter(([k]) => k.endsWith(', ' + market)).map(([, r]) => r) : [];
    const series = [];
    for (let a = days - 1; a >= 0; a--) {
      const asOf = new Date(Date.now() - a * 86400e3);
      series.push({ d: dayKey(asOf), score: Math.max(scoreMarket(rows, asOf).score, ...cityRows.map(r => scoreMarket(r, asOf).score)) });
    }
    res.json(series);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.get('/api/export.csv', async (_q, res) => {
  const { rows } = await pool.query(`SELECT to_char(seen_at,'YYYY-MM-DD HH24:MI') seen, type, state, city, domain, trusted, title, url FROM articles WHERE NOT dismissed ORDER BY seen_at DESC`);
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  res.type('text/csv').send(['seen,type,state,city,domain,counts,title,url', ...rows.map(r => [r.seen, r.type, r.state, r.city, r.domain, r.trusted ? 'yes' : 'no', r.title, r.url].map(esc).join(','))].join('\n'));
});

app.post('/api/ingest/run', async (_q, res) => { liveIngest(); res.json({ started: true }); });

const port = process.env.PORT || 3000;
await migrate();
if (process.env.DISABLE_JOBS !== '1') { await reprocessIfChanged(CLASSIFIER_VERSION); await syncTrust(); }
app.listen(port, () => console.log('listening on', port));

if (process.env.DISABLE_JOBS !== '1') {
  // Hourly catch-up (36h lookback, so yesterday is always covered), plus a resumable history backfill.
  setTimeout(probe, 5e3);
  setTimeout(loadIncome, 8e3);
  setTimeout(() => liveIngest(), 15e3);
  setInterval(() => liveIngest(), 3600e3);
  setTimeout(() => backfill(BACKFILL_DAYS), 60e3);
  setInterval(() => backfill(BACKFILL_DAYS), 6 * 3600e3);
}
