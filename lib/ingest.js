import { pool, setMeta, getMeta } from './db.js';
import { TYPES, gdeltQuery } from './types.js';
import { geoTag } from './geo.js';

const GDELT = 'https://api.gdeltproject.org/api/v2/doc/doc';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = d => d.toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHMMSS

// One global gate so live pulls and backfill never hit GDELT at the same time (it allows 1 request per 5s).
let gate = Promise.resolve();
let lastCall = 0;
function throttled(fn) {
  const run = gate.then(async () => {
    const wait = 5500 - (Date.now() - lastCall);
    if (wait > 0) await sleep(wait);
    try { return await fn(); } finally { lastCall = Date.now(); }
  });
  gate = run.catch(() => {});
  return run;
}

async function gdeltFetch(typeKey, start, end) {
  const params = new URLSearchParams({
    query: gdeltQuery(typeKey), mode: 'artlist', format: 'json', maxrecords: '250', sort: 'datedesc',
    startdatetime: fmt(start), enddatetime: fmt(end),
  });
  let lastErr = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const { status, text } = await throttled(async () => {
        const res = await fetch(`${GDELT}?${params}`, { headers: { 'User-Agent': 'axon-event-tracker/1.0' }, signal: AbortSignal.timeout(45000) });
        return { status: res.status, text: await res.text() };
      });
      if (status === 200 && text.trim() === '') return []; // zero hits
      if (status === 200) {
        try { return JSON.parse(text).articles || []; } catch { /* notice or error page, fall through */ }
      }
      lastErr = `HTTP ${status}: ${text.slice(0, 160).replace(/\s+/g, ' ')}`;
    } catch (e) { lastErr = `fetch error: ${e.cause?.code || e.message}`; }
    console.error(`gdelt attempt ${attempt} failed for ${typeKey}: ${lastErr}`);
    await sleep(6000 * attempt);
  }
  throw new Error(`GDELT failed for ${typeKey} ${fmt(start)} (${lastErr})`);
}

function parseSeen(s) { // 20261007T123000Z
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s || '');
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : new Date();
}

export async function pullWindow(typeKey, start, end) {
  const arts = await gdeltFetch(typeKey, start, end);
  let kept = 0;
  for (const a of arts) {
    if (!a.url || !a.title) continue;
    const geo = geoTag(a.title);
    if (!geo) continue; // can't pin to a state or city, doesn't score
    const r = await pool.query(
      `INSERT INTO articles(url,title,domain,seen_at,type,state,city) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (url,type) DO NOTHING`,
      [a.url, a.title.slice(0, 400), a.domain || null, parseSeen(a.seendate), typeKey, geo.state, geo.city]);
    kept += r.rowCount;
  }
  return { fetched: arts.length, kept };
}

let liveRunning = false;
export async function liveIngest(hours = 6) {
  if (liveRunning) return;
  liveRunning = true;
  try {
    const end = new Date(), start = new Date(end.getTime() - hours * 3600e3);
    let total = 0;
    for (const key of Object.keys(TYPES)) {
      try { total += (await pullWindow(key, start, end)).kept; }
      catch (e) { console.error('live ingest error', key, e.message); }
    }
    await setMeta('last_live_ingest', new Date().toISOString());
    await setMeta('last_live_ingest_new', total);
    console.log(`live ingest done, ${total} new`);
  } finally { liveRunning = false; }
}

// Historical backfill: one day at a time per type, resumable. GDELT DOC only reaches back ~3 months.
let backfillRunning = false;
export async function backfill(days = 90) {
  if (backfillRunning) return;
  backfillRunning = true;
  try {
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    for (let age = 1; age <= days; age++) {
      const dayStart = new Date(today.getTime() - age * 86400e3), dayEnd = new Date(dayStart.getTime() + 86400e3 - 1000);
      for (const key of Object.keys(TYPES)) {
        const pk = `${key}:${dayStart.toISOString().slice(0, 10)}`;
        const done = await pool.query(`SELECT 1 FROM backfill_progress WHERE key=$1`, [pk]);
        if (done.rowCount) continue;
        try {
          await pullWindow(key, dayStart, dayEnd);
          await pool.query(`INSERT INTO backfill_progress(key) VALUES($1) ON CONFLICT DO NOTHING`, [pk]);
        } catch (e) { console.error('backfill error', pk, e.message); }
      }
    }
    await setMeta('backfill_finished', new Date().toISOString());
    console.log('backfill finished');
  } finally { backfillRunning = false; }
}

export async function backfillStatus(days = 90) {
  const total = days * Object.keys(TYPES).length;
  const r = await pool.query(`SELECT count(*)::int AS n FROM backfill_progress`);
  return { done: r.rows[0].n, total, pct: Math.min(100, Math.round(r.rows[0].n / total * 100)), running: backfillRunning,
    lastLive: await getMeta('last_live_ingest'), lastLiveNew: await getMeta('last_live_ingest_new') };
}
