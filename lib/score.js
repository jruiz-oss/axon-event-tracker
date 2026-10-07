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

// Messaging focus per event type. These are themes to lean into, not ad copy.
const FOCUS = {
  mass_casualty: 'personal safety readiness',
  ice_enforcement: 'home and family protection',
  unrest: 'personal safety in public spaces',
  violent_crime_spike: 'neighborhood and home safety',
  carjacking: 'safety in and around vehicles',
  stalking_abduction: 'solo safety (walking, running, rideshare)',
  home_invasion: 'home protection',
  disaster_looting: 'home protection and preparedness',
  police_response: 'self-reliance and personal protection',
  campus: 'student and campus safety',
};
const list = a => a.length <= 1 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];

export function actionFor(score, topTypes = [], cities = []) {
  const themes = list([...new Set(topTypes.map(t => FOCUS[t]).filter(Boolean))].slice(0, 2));
  const where = cities.length ? ` Focus on ${list(cities.slice(0, 4))}.` : '';
  if (score >= 70) return { level: 'Hot', action: `Prioritize this market. Lead messaging on ${themes || 'personal safety'}.${where}`, expire: 'Revisit in 7 days, ease off once the score drops below 40' };
  if (score >= 40) return { level: 'Warm', action: `Lean messaging toward ${themes || 'personal safety'} here.${where}`, expire: 'Revisit in 7 days' };
  if (score >= 20) return { level: 'Watch', action: `Keep an eye on it. Light test on ${themes || 'personal safety'} if it holds.${where}`, expire: 'Drop if nothing new in 5 days' };
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
    out.push({ key, score: now.score, prev: prev.score, delta: now.score - prev.score, topTypes: top, byType: now.byType, ...actionFor(now.score, top) });
  }
  return out.sort((a, b) => b.score - a.score);
}
