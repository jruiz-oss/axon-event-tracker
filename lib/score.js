import { TYPES, isScored } from './types.js';

// HEAT (the 0 to 100 score): how loud buyer-relevant incident coverage is right now vs the market's own normal.
export const TAU = 5;           // decay in days. Spikes matter: fresh coverage counts most.
export const RECENT_DAYS = 14;  // window that counts as "now"
export const BASE_DAYS = 60;    // baseline window just before the recent window
export const REF = 6;           // raw score that maps to 100. Tune after seeing real data.

// RUN WINDOW: a TASER is a considered purchase, so a scary local incident opens a ~2 week buying window
// that outlasts the news itself. Each trigger opens a window; repeat incidents keep it open.
export const WINDOW_DAYS = 14;
export const MIN_RUNWAY = 5;    // fewer days left than this isn't worth a new launch
export const TRIG_MULT = 2.5;   // trigger day: this many times the market's normal daily signal...
export const TRIG_MIN = 1.5;    // ...and at least this much absolute signal
export const MIN_OUTLETS = 4;   // ...and picked up by this many separate outlets (3 if the incident is severe)
export const LOOKBACK = 21;     // repeat incidents are counted over the last 3 weeks

const DAY = 86400e3;
export const dayKey = d => new Date(d).toISOString().slice(0, 10);
const decaySum = (() => { let s = 0; for (let a = 0; a < RECENT_DAYS; a++) s += Math.exp(-a / TAU); return s; })();

// Severity multiplier for one day of one type: murders and stabbings count more, "no one hurt" counts less.
export function severity(r) {
  const n = +r.n || 0;
  if (!n) return 1;
  if ((+r.severe || 0) / n >= 1 / 3) return 1.6;
  if ((+r.minor || 0) / n >= 0.5) return 0.6;
  return 1;
}
const ageOf = (asOfDay, d) => Math.round((asOfDay - Date.parse(d)) / DAY);

// rows: [{ d:'YYYY-MM-DD', type, domains, n?, severe?, minor?, ongoing?, resolved? }] for ONE market.
export function scoreMarket(rows, asOf = new Date()) {
  const asOfDay = Date.parse(dayKey(asOf));
  const perType = {};
  for (const r of rows) {
    if (!isScored(r.type)) continue;
    const age = ageOf(asOfDay, r.d);
    if (age < 0 || age >= RECENT_DAYS + BASE_DAYS) continue;
    (perType[r.type] ||= {})[age] = Math.log1p(+r.domains) * severity(r);
  }
  let raw = 0; const byType = {};
  for (const [type, ages] of Object.entries(perType)) {
    const w = TYPES[type].weight;
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

// Triggers and the run window for ONE market.
export function windowFor(rows, asOf = new Date()) {
  const asOfDay = Date.parse(dayKey(asOf));
  const N = RECENT_DAYS + BASE_DAYS;
  const sig = new Float64Array(N), outlets = new Float64Array(N), sev = new Uint8Array(N);
  const context = {}; let ongoing = 0, resolved = 0;
  for (const r of rows) {
    const age = ageOf(asOfDay, r.d);
    if (age < 0 || age >= N) continue;
    if (!isScored(r.type)) { if (age < 7 && TYPES[r.type]) context[r.type] = (context[r.type] || 0) + (+r.domains); continue; }
    const m = severity(r);
    sig[age] += TYPES[r.type].weight * Math.log1p(+r.domains) * m;
    outlets[age] = Math.max(outlets[age], +r.domains);
    if (m > 1) sev[age] = 1;
    if (age < 3) { ongoing += +r.ongoing || 0; resolved += +r.resolved || 0; }
  }
  let base = 0; for (let a = LOOKBACK; a < N; a++) base += sig[a]; base /= (N - LOOKBACK);
  const thr = Math.max(TRIG_MIN, TRIG_MULT * base);
  const trig = [];
  for (let a = 0; a < LOOKBACK; a++) if (sig[a] >= thr && outlets[a] >= (sev[a] ? MIN_OUTLETS - 1 : MIN_OUTLETS)) trig.push(a);
  // back to back trigger days are one incident; a quiet day in between makes it a repeat
  let incidents = 0; for (let i = 0; i < trig.length; i++) if (i === 0 || trig[i] - trig[i - 1] > 1) incidents++;
  const last = trig.length ? trig[0] : null;
  let daysLeft = 0, note = '';
  if (last != null) {
    daysLeft = WINDOW_DAYS - last;
    if (ongoing > 0) { daysLeft += 4; note = 'unresolved'; }                       // suspect still at large keeps fear up
    else if (resolved > 0 && last >= 2) { daysLeft = Math.min(daysLeft, 7 - last); note = 'resolved'; } // arrest made, fear fades faster
    daysLeft = Math.max(0, daysLeft);
  }
  return { lastTrigger: last, daysLeft, incidents, severe: last != null && !!sev[last], note, context };
}

// Messaging focus per event type. Themes to lean into, not ad copy.
const FOCUS = {
  stalking_abduction: 'solo safety (walking, running, rideshare)',
  home_invasion: 'home protection',
  carjacking: 'safety in and around vehicles',
  violent_crime_spike: 'neighborhood and home safety',
  police_response: 'self-reliance and personal protection',
  campus: 'student and campus safety',
  disaster_looting: 'home protection and preparedness',
  mass_casualty: 'personal safety readiness',
};
const list = a => a.length <= 1 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
export const levelOf = s => s >= 70 ? 'Hot' : s >= 40 ? 'Warm' : s >= 20 ? 'Watch' : 'Quiet';

// call: Launch | Extend | Watch | Wind down | Hold. win from windowFor, afford from income.js ({tier, ratio} or null).
export function actionFor(score, topTypes = [], cities = [], win = null, afford = null) {
  const level = levelOf(score);
  const themes = list([...new Set(topTypes.map(t => FOCUS[t]).filter(Boolean))].slice(0, 2)) || 'personal safety';
  const where = cities.length ? ` Focus on ${list(cities.slice(0, 4))}.` : '';
  const out = (call, action, expire = '') => ({ level, call, action, expire });
  if (!win || win.lastTrigger == null || win.daysLeft <= 0)
    return out('Hold', level === 'Quiet' ? 'No change' : 'No fresh trigger. Coverage is at background level for this market.');
  if (afford && afford.tier === 'Low')
    return out('Hold', `Trigger, but household income is ${Math.round(afford.ratio * 100)}% of the US median. Low purchase power, skip unless Trends shows real demand.`);
  if (level === 'Quiet') return out('Hold', 'Trigger is too small to act on.');
  const income = afford && afford.tier === 'Mid' ? ' Limit to top 50% household income.' : '';
  if (win.daysLeft < MIN_RUNWAY)
    return out('Wind down', `${win.daysLeft} days left in the buying window${win.note === 'resolved' ? ' (arrest made)' : ''}. Don't start new; let running campaigns finish.`);
  if (win.incidents >= 2 && score >= 40)
    return out('Extend', `Repeat incidents (${win.incidents} in 3 weeks). Run the longer flight: lead on ${themes}.${where}${income}`, `${win.daysLeft} days left, resets with each new incident`);
  if (score >= 40)
    return out('Launch', `Launch now, ${win.daysLeft} days left in the buying window. Lead on ${themes}.${where}${income}`,
      win.note === 'unresolved' ? 'Threat still unresolved, window extended' : 'Wind down at day 14 unless incidents repeat');
  return out('Watch', `Small trigger. Prep messaging on ${themes}; launch if it grows or repeats.${where}`, 'Recheck tomorrow');
}

export const CALL_ORDER = { Extend: 0, Launch: 1, Watch: 2, 'Wind down': 3, Hold: 4 };

// Rank markets. groups: Map(marketKey -> rows). affordFn(key) -> {tier, ratio, income, source} | null
export function rankMarkets(groups, asOf = new Date(), affordFn = null) {
  const out = [];
  for (const [key, rows] of groups) {
    const now = scoreMarket(rows, asOf);
    const win = windowFor(rows, asOf);
    if (now.score <= 0) continue;
    const prev = scoreMarket(rows, new Date(asOf.getTime() - 7 * DAY));
    const top = Object.entries(now.byType).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);
    const afford = affordFn ? affordFn(key) : null;
    out.push({ key, score: now.score, prev: prev.score, delta: now.score - prev.score, topTypes: top, byType: now.byType,
      win, afford, ...actionFor(now.score, top, [], win, afford) });
  }
  return out.sort((a, b) => (CALL_ORDER[a.call] - CALL_ORDER[b.call]) || (b.score - a.score));
}
