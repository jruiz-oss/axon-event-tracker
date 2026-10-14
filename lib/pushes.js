// Push log: a manual record of each time we actually pushed a market (start, end, results). Not connected to
// Google Ads. Heat is snapshotted from the tracker at start and end so we can look back at what the signal said.
import { pool } from './db.js';
import { STATES } from './geo.js';
import { scoreMarket } from './score.js';
import { loadGroups, rankedMarkets } from './markets.js';

export const OUTCOMES = ['Worked', 'Mixed', 'Flat', 'Did not work'];
const TEXT = ['cities', 'campaign', 'angle', 'reason', 'notes'];
const NUM = ['daily_budget', 'spend', 'impressions', 'clicks', 'conversions', 'conv_value'];
const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
const bad = msg => Object.assign(new Error(msg), { status: 400 });
const today = () => new Date().toISOString().slice(0, 10);

// State heat on a given day, same rule as /api/history: the hotter of the state and its hottest city.
export async function heatOn(market, day) {
  const asOf = new Date(Math.min(Date.now(), Date.parse(day + 'T23:59:59Z')));
  const back = Math.ceil((Date.now() - asOf) / 86400e3) + 75;
  const rows = (await loadGroups('state', null, back)).get(market) || [];
  const cityRows = [...(await loadGroups('city', null, back)).entries()].filter(([k]) => k.endsWith(', ' + market)).map(([, r]) => r);
  return Math.max(scoreMarket(rows, asOf).score, ...cityRows.map(r => scoreMarket(r, asOf).score));
}

// Validate and normalize a body. partial=true for edits (only fields present are touched).
function clean(b = {}, partial = false) {
  const out = {};
  if (!partial || 'market' in b) {
    const m = String(b.market || '').toUpperCase();
    if (!STATES[m]) throw bad('Pick a state');
    out.market = m;
  }
  for (const k of TEXT) if (k in b) out[k] = String(b[k] ?? '').trim().slice(0, 2000) || null;
  for (const k of NUM) if (k in b) {
    const v = b[k] === '' || b[k] == null ? null : Number(String(b[k]).replace(/[$,]/g, ''));
    if (v != null && (!Number.isFinite(v) || v < 0)) throw bad(`${k.replace('_', ' ')} must be a positive number`);
    out[k] = v;
  }
  for (const k of ['started_on', 'ended_on']) if (k in b) {
    const v = b[k] || null;
    if (v && !DATE_RX.test(v)) throw bad(`${k.replace('_', ' ')} must be a date`);
    out[k] = v;
  }
  if (!partial && !out.started_on) out.started_on = today();
  if ('outcome' in b) {
    if (b.outcome && !OUTCOMES.includes(b.outcome)) throw bad('Unknown outcome');
    out.outcome = b.outcome || null;
  }
  return out;
}

// Dates come back as plain YYYY-MM-DD strings (pg would otherwise turn DATE into a local-time JS Date).
async function query(where = '', args = []) {
  const { rows } = await pool.query(
    `SELECT id, market, cities, campaign, angle, reason, daily_budget, heat_start, call_start, heat_end, spend, impressions, clicks,
       conversions, conv_value, outcome, notes, to_char(started_on,'YYYY-MM-DD') started_on, to_char(ended_on,'YYYY-MM-DD') ended_on
     FROM pushes ${where} ORDER BY (ended_on IS NULL) DESC, started_on DESC, id DESC`, args);
  return rows.map(r => { r.id = +r.id; for (const k of NUM) if (r[k] != null) r[k] = +r[k]; return r; });
}
export const listPushes = market => market ? query('WHERE market = $1', [market]) : query();
async function getPush(id) {
  const [r] = await query('WHERE id = $1', [+id]);
  if (!r) throw Object.assign(new Error('Not found'), { status: 404 });
  return r;
}

export async function createPush(body) {
  const p = clean(body);
  if (p.ended_on && p.ended_on < p.started_on) throw bad('End date is before start date');
  p.heat_start = await heatOn(p.market, p.started_on);
  // The call is only meaningful for a push starting now (+-1 day covers time zones); backdated pushes just keep the heat.
  if (Math.abs(Date.parse(p.started_on) - Date.parse(today())) <= 86400e3) p.call_start = (await rankedMarkets('state', null)).find(m => m.key === p.market)?.call || 'Hold';
  if (p.ended_on) p.heat_end = await heatOn(p.market, p.ended_on);
  const keys = Object.keys(p);
  const { rows } = await pool.query(`INSERT INTO pushes (${keys.join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`, keys.map(k => p[k]));
  return getPush(rows[0].id);
}

// Edit or end a push. Ending (setting ended_on) snapshots heat_end; changing a date re-snapshots its heat.
export async function updatePush(id, body) {
  const cur = await getPush(id);
  const p = clean(body, true);
  const market = p.market || cur.market;
  const start = p.started_on || cur.started_on, end = 'ended_on' in p ? p.ended_on : cur.ended_on;
  if (end && end < start) throw bad('End date is before start date');
  if (p.market && p.market !== cur.market || p.started_on && p.started_on !== cur.started_on) p.heat_start = await heatOn(market, start);
  if ('ended_on' in p || p.market && p.market !== cur.market) p.heat_end = end ? await heatOn(market, end) : null;
  const keys = Object.keys(p);
  if (keys.length) await pool.query(`UPDATE pushes SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(',')}, updated_at=now() WHERE id=$1`, [+id, ...keys.map(k => p[k])]);
  return getPush(id);
}

export async function deletePush(id) {
  await pool.query(`DELETE FROM pushes WHERE id=$1`, [+id]);
}

export async function pushesCsv() {
  const rows = await listPushes();
  const cols = ['started_on', 'ended_on', 'market', 'cities', 'campaign', 'angle', 'reason', 'daily_budget', 'heat_start', 'call_start', 'heat_end',
    'spend', 'impressions', 'clicks', 'conversions', 'conv_value', 'ctr', 'cvr', 'cpa', 'roas', 'outcome', 'notes'];
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const r2 = v => v == null || !Number.isFinite(v) ? '' : Math.round(v * 100) / 100;
  return [cols.join(','), ...rows.map(r => {
    const d = { ...r,
      ctr: r.impressions ? r2(r.clicks / r.impressions * 100) : '', cvr: r.clicks ? r2(r.conversions / r.clicks * 100) : '',
      cpa: r.conversions ? r2(r.spend / r.conversions) : '', roas: r.spend && r.conv_value != null ? r2(r.conv_value / r.spend) : '' };
    return cols.map(c => esc(d[c])).join(',');
  })].join('\n');
}
