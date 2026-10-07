import { TYPES } from './types.js';

export const TAU = 5;          // decay in days: an event loses ~63% of its pull after 5 days
export const RECENT_DAYS = 14; // window that counts as "now"
export const BASE_DAYS = 60;   // baseline window just before the recent window
export const REF = 6;          // raw score that maps to 100. Tune after seeing real data.

const DAY = 86400e3;
export const dayKey = d => new Date(d).toISOString().slice(0, 10);

const decaySum = (() => { let s = 0; for (let a = 0; a < RECENT_DAYS; a++) s += Math.exp(-a / TAU); return s; })();

// rows: [{ d:'YYYY-MM-DD', type, domains }] for ONE market. Returns { score, raw, byType }.
export function scoreMarket(rows, asOf = new Date()) {
  const asOfDay = Date.parse(dayKey(asOf));
  const perType = {};
  for (const r of rows) {
    const age = Math.round((asOfDay - Date.parse(r.d)) / DAY);
    if (age < 0 || age >= RECENT_DAYS + BASE_DAYS) continue;
    (perType[r.type] ||= {})[age] = Math.log1p(+r.domains);
  }
  let raw = 0; const byType = {};
  for (const [type, ages] of Object.entries(perType)) {
    const w = TYPES[type]?.weight ?? 0.3;
    let recent = 0, baseSum = 0;
    for (const [a, s] of Object.entries(ages)) {
      const age = +a;
      if (age < RECENT_DAYS) recent += s * Math.exp(-age / TAU); else baseSum += s;
    }
    const expected = (baseSum / BASE_DAYS) * decaySum;
    const uplift = Math.max(0, recent - expected);
    const v = w * (0.5 * recent + uplift);
    byType[type] = +v.toFixed(2);
    raw += v;
  }
  return { raw, score: Math.min(100, Math.round(raw / REF * 100)), byType };
}

export function actionFor(score) {
  if (score >= 70) return { level: 'Hot', action: 'Bid up +20% to +35%, add to priority geo list', expire: 'Review at day 7, pull back when score < 40' };
  if (score >= 40) return { level: 'Warm', action: 'Bid up +10% to +20%', expire: 'Pull back after 7 days of declining score' };
  if (score >= 20) return { level: 'Watch', action: 'Bid up +5% to +10% or monitor', expire: 'Drop if no new events in 5 days' };
  return { level: 'Quiet', action: 'No change', expire: '' };
}

// Rank markets. groups: Map(marketKey -> rows)
export function rankMarkets(groups, asOf = new Date()) {
  const out = [];
  for (const [key, rows] of groups) {
    const now = scoreMarket(rows, asOf);
    if (now.score <= 0) continue;
    const prev = scoreMarket(rows, new Date(asOf.getTime() - 7 * DAY));
    const top = Object.entries(now.byType).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);
    out.push({ key, score: now.score, prev: prev.score, delta: now.score - prev.score, topTypes: top, byType: now.byType, ...actionFor(now.score) });
  }
  return out.sort((a, b) => b.score - a.score);
}
