import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, migrate } from './lib/db.js';
import { TYPES, CLASSIFIER_VERSION } from './lib/types.js';
import { loadIncome, incomeStatus } from './lib/income.js';
import { STATES } from './lib/geo.js';
import { scoreMarket, dayKey } from './lib/score.js';
import { loadGroups, parseTypes, rankedMarkets, majorEvents } from './lib/markets.js';
import { getBrief } from './lib/brief.js';
import { storiesFor, draftPush } from './lib/draft.js';
import { aiOn } from './lib/ai.js';
import { nameStories } from './lib/names.js';
import { listPushes, createPush, updatePush, deletePush, pushesCsv, OUTCOMES } from './lib/pushes.js';
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

app.get('/api/meta', async (_q, res) => {
  res.json({ types: Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [k, { label: v.label, tier: v.tier, weight: v.weight }])), states: STATES, status: await backfillStatus(BACKFILL_DAYS), income: incomeStatus(), outcomes: OUTCOMES, ai: aiOn() });
});

app.get('/api/markets', async (req, res) => {
  try {
    const level = req.query.level === 'city' ? 'city' : 'state';
    const ranked = await rankedMarkets(level, parseTypes(req.query.types));
    res.json(ranked.slice(0, level === 'city' ? 50 : 60));
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.get('/api/events', async (req, res) => {
  try {
    res.json(await majorEvents({ days: req.query.days, market: req.query.market ? String(req.query.market) : null, types: parseTypes(req.query.types) }));
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// AI read on which active market is the best fit for a TASER ad right now. Cached; force=1 asks for a fresh read.
app.get('/api/brief', async (req, res) => {
  try { res.json(await getBrief({ force: req.query.force === '1' })); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// Headlines grouped into stories for one state (the detail panel's feed).
app.get('/api/stories', async (req, res) => {
  try {
    const market = String(req.query.market || '').toUpperCase();
    if (!STATES[market]) return res.status(400).json({ error: 'Pick a state' });
    const stories = await storiesFor(market, { days: Math.min(+req.query.days || 14, 90), types: parseTypes(req.query.types) });
    const pending = await nameStories(stories);
    res.set('X-Names-Pending', pending ? '1' : '0').json(stories);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// Dismiss a whole story (all its articles) in one go.
app.post('/api/events/dismiss', async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger).slice(0, 1000);
  if (ids.length) await pool.query(`UPDATE articles SET dismissed = TRUE WHERE id = ANY($1)`, [ids]);
  res.json({ ok: true, n: ids.length });
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
  const { rows } = await pool.query(`SELECT to_char(seen_at,'YYYY-MM-DD HH24:MI') seen, type, state, city, domain, trusted, national, title, url FROM articles WHERE NOT dismissed ORDER BY seen_at DESC`);
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  res.type('text/csv').send(['seen,type,state,city,domain,counts,national,title,url', ...rows.map(r => [r.seen, r.type, r.state, r.city, r.domain, r.trusted ? 'yes' : 'no', r.national ? 'yes' : 'no', r.title, r.url].map(esc).join(','))].join('\n'));
});

// Push log: manual record of when we actually pushed a market, and how it went. Not tied to Google Ads.
const send = fn => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (e) { const code = e.status || 500; if (code === 500) console.error(e); res.status(code).json({ error: e.message }); }
};
app.get('/api/pushes', send(req => listPushes(req.query.market ? String(req.query.market).toUpperCase() : null)));
// AI draft of a push from a story: fills the form and reads it against the rest of the tracker and the push log.
app.post('/api/pushes/draft', send(req => draftPush(req.body || {})));
app.post('/api/pushes', send(req => createPush(req.body)));
app.patch('/api/pushes/:id', send(req => updatePush(req.params.id, req.body)));
app.delete('/api/pushes/:id', send(async req => { await deletePush(req.params.id); return { ok: true }; }));
app.get('/api/pushes.csv', async (_q, res) => {
  try { res.type('text/csv').set('Content-Disposition', 'attachment; filename="axon-pushes.csv"').send(await pushesCsv()); }
  catch (e) { console.error(e); res.status(500).send(e.message); }
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
