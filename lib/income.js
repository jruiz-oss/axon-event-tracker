// Purchase power per market from Census ACS 5-year median household income.
// States use the state median. Cities use their METRO median, since ad targeting covers the metro, not city limits.
import { getMeta, setMeta } from './db.js';
import { STATES } from './geo.js';

const API = 'https://api.census.gov/data/2023/acs/acs5';
const KEY = process.env.CENSUS_API_KEY ? `&key=${process.env.CENSUS_API_KEY}` : '';
const TTL = 30 * 86400e3;
// Cities whose metro is named after a different principal city
const ALIAS = {
  'New York City': 'New York', Brooklyn: 'New York', Manhattan: 'New York', Queens: 'New York', 'The Bronx': 'New York', Paterson: 'New York',
  Compton: 'Los Angeles', 'Santa Ana': 'Anaheim', Hialeah: 'Miami', Ferguson: 'St. Louis', Kenosha: 'Chicago', Plano: 'Dallas',
  Glendale: 'Phoenix', Tempe: 'Phoenix', Scottsdale: 'Phoenix', Henderson: 'Las Vegas', Annapolis: 'Baltimore',
  Honolulu: 'Urban Honolulu', Boise: 'Boise City',
};
// Tiers vs the US median. Low = skip, Mid = run but limit to top 50% household income, High = run.
export const TIERS = { high: 1.10, low: 0.85 };

let data = null, loading = null, failedAt = 0;
const RETRY = 3600e3; // after a failed fetch, wait an hour before trying Census again
const nameToAbbr = Object.fromEntries(Object.entries(STATES).map(([k, v]) => [v, k]));

async function get(q) {
  const r = await fetch(`${API}?get=NAME,B19013_001E&${q}${KEY}`, { signal: AbortSignal.timeout(30000) });
  const body = await r.text();
  if (!r.ok || !body.startsWith('[')) throw new Error(`Census HTTP ${r.status} for ${q.slice(0, 40)}: ${body.replace(/\s+/g, ' ').slice(0, 160)}`);
  return JSON.parse(body).slice(1);
}

async function fetchAll() {
  const [us, st, cbsa] = await Promise.all([get('for=us:1'), get('for=state:*'), get('for=metropolitan%20statistical%20area/micropolitan%20statistical%20area:*')]);
  const states = {};
  for (const [name, v] of st) if (nameToAbbr[name] && +v > 0) states[nameToAbbr[name]] = +v;
  const metros = [];
  for (const [name, v] of cbsa) {
    if (!/Metro Area$/.test(name) || !(+v > 0)) continue;
    const base = name.replace(/ Metro Area$/, '');
    const i = base.lastIndexOf(', ');
    metros.push({ name: base, cities: base.slice(0, i).split(/[-/]+/).map(s => s.trim()).filter(Boolean), states: base.slice(i + 2).split('-'), income: +v });
  }
  return { at: Date.now(), us: +us[0][1], states, metros };
}

// Load from cache (meta table) or Census. Never throws; data stays null if both fail.
export function loadIncome() {
  if (data && Date.now() - data.at < TTL) return Promise.resolve(data);
  if (!data && Date.now() - failedAt < RETRY) return Promise.resolve(null);
  return loading ||= (async () => {
    try {
      const cached = await getMeta('income_v1');
      if (cached) { const c = JSON.parse(cached); if (Date.now() - c.at < TTL) return (data = c); data = c; }
      const fresh = await fetchAll();
      if (fresh.us && Object.keys(fresh.states).length > 40) { await setMeta('income_v1', JSON.stringify(fresh)); data = fresh; }
    } catch (e) { failedAt = Date.now(); console.error('income load failed:', e.message, process.env.CENSUS_API_KEY ? '' : '(no CENSUS_API_KEY set)'); }
    finally { loading = null; }
    return data;
  })();
}

const tierOf = ratio => ratio >= TIERS.high ? 'High' : ratio < TIERS.low ? 'Low' : 'Mid';

// key: 'TX' (state) or 'Houston, TX' (city). Returns { income, ratio, tier, source } or null.
// campus: college towns have low medians because of student households, and campus stories reach parents
// well beyond the town, so campus-driven city markets use the state median instead.
export function affordFor(key, d = data, { campus = false } = {}) {
  if (!d) return null;
  let income = null, source = '';
  if (campus && key.includes(', ')) {
    const st = key.split(', ')[1];
    if (d.states[st]) { income = d.states[st]; source = `${st} statewide (campus story)`; }
  } else if (key.includes(', ')) {
    const [city, st] = key.split(', ');
    const want = ALIAS[city] || city;
    const m = d.metros.find(x => x.states.includes(st) && x.cities.includes(want));
    if (m) { income = m.income; source = `${m.name} metro`; }
    else if (d.states[st]) { income = d.states[st]; source = `${st} statewide (no metro match)`; }
  } else if (d.states[key]) { income = d.states[key]; source = 'statewide'; }
  if (!income) return null;
  const ratio = income / d.us;
  return { income, ratio: +ratio.toFixed(2), tier: tierOf(ratio), source };
}
export const incomeStatus = () => data ? { loaded: true, us: data.us, at: data.at } : { loaded: false };
