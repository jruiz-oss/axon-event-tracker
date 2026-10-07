import { TYPES } from './types.js';

export const TAU = 8;          // decay in days: an event keeps ~29% of its pull after 10 days (was 5, too twitchy for 1.5 week+ planning)
export const RECENT_DAYS = 14; // window that counts as "now"
export const BASE_DAYS = 60;   // baseline window just before the recent window
export const REF = 6;          // raw score that maps to 100. Tune after seeing real data.
export const SUSTAIN_DAYS = 10; // we plan around stories that hold ~1.5 weeks; persistence is judged over this window
export const FULL_CREDIT = 6;   // days with coverage (out of SUSTAIN_DAYS) for a story to get full weight
const SPIKE_FLOOR = 0.3;        // weight a one-day blip keeps

const DAY = 86400e3;
export const dayKey = d => new Date(d).toISOString().slice(0, 10);

const decaySum = (() => { let s = 0; for (let a = 0; a < RECENT_DAYS; a++) s += Math.exp(-a / TAU); return s; })();

// rows: [{ d:'YYYY-MM-DD', type, domains }] for ONE market. Returns { score, raw, byType }.
export function scoreMarket(rows, asOf = new Date()) {
  const asOfDay = Date.parse(dayKey(asOf));
  const perType = {}; const marketDays = new Set();
  for (const r of rows) {
    const age = Math.round((asOfDay - Date.parse(r.d)) / DAY);
    if (age < 0 || age >= RECENT_DAYS + BASE_DAYS) continue;
    (perType[r.type] ||= {})[age] = Math.log1p(+r.domains);
    if (age < SUSTAIN_DAYS && +r.domains > 0) marketDays.add(age);
  }
  let raw = 0; const byType = {}; const daysByType = {};
  for (const [type, ages] of Object.entries(perType)) {
    const w = TYPES[type]?.weight ?? 0.3;
    let recent = 0, baseSum = 0, active = 0;
    for (const [a, s] of Object.entries(ages)) {
      const age = +a;
      if (age < RECENT_DAYS) recent += s * Math.exp(-age / TAU); else baseSum += s;
      if (age < SUSTAIN_DAYS && s > 0) active++;
    }
    const expected = (baseSum / BASE_DAYS) * decaySum;
    const uplift = Math.max(0, recent - expected);
    // Persistence: a story covered on many separate days is one that holds; a one-day blip mostly doesn't count.
    const persist = SPIKE_FLOOR + (1 - SPIKE_FLOOR) * Math.min(1, active / FULL_CREDIT);
    const v = w * (0.5 * recent + uplift) * persist;
    byType[type] = +v.toFixed(2);
    daysByType[type] = active;
    raw += v;
  }
  const activeDays = marketDays.size;
  const lastAge = activeDays ? Math.min(...marketDays) : null;
  return { raw, score: Math.min(100, Math.round(raw / REF * 100)), byType, daysByType, activeDays, lastAge, durability: durabilityOf(activeDays, lastAge) };
}

// How long-lived the coverage looks over the last SUSTAIN_DAYS.
export function durabilityOf(activeDays, lastAge) {
  if (!activeDays) return 'None';
  if (lastAge >= 4) return 'Fading';
  if (activeDays >= FULL_CREDIT) return 'Sustained';
  if (activeDays >= 3) return 'Building';
  return 'Spike';
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

export function actionFor(score, topTypes = [], cities = [], durability = 'Sustained', activeDays = null) {
  const themes = list([...new Set(topTypes.map(t => FOCUS[t]).filter(Boolean))].slice(0, 2));
  const where = cities.length ? ` Focus on ${list(cities.slice(0, 4))}.` : '';
  const days = activeDays != null ? ` (${activeDays} of the last ${SUSTAIN_DAYS} days)` : '';
  const lvl = score >= 70 ? 'Hot' : score >= 40 ? 'Warm' : score >= 20 ? 'Watch' : 'Quiet';
  if (lvl !== 'Quiet') {
    // Only sustained coverage earns a messaging shift. Spikes and fading stories are flagged, not acted on.
    if (durability === 'Spike') return { level: lvl, action: `Short spike so far${days}. Don't shift messaging yet; act only if coverage holds through the week.`, expire: 'Recheck in 3 days' };
    if (durability === 'Fading') return { level: lvl, action: `Coverage is fading${days}. Don't add focus here; wind down if already leaning in.`, expire: 'Drop if nothing new in 5 days' };
    if (durability === 'Building' && score >= 40) return { level: lvl, action: `Building${days}. Prep messaging on ${themes || 'personal safety'} and confirm in Google Trends; switch on once it holds a full week.${where}`, expire: 'Recheck in 3 days' };
  }
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
    out.push({ key, score: now.score, prev: prev.score, delta: now.score - prev.score, topTypes: top, byType: now.byType, daysByType: now.daysByType,
      activeDays: now.activeDays, lastAge: now.lastAge, durability: now.durability, ...actionFor(now.score, top, [], now.durability, now.activeDays) });
  }
  return out.sort((a, b) => b.score - a.score);
}
