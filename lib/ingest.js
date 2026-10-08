import AdmZip from 'adm-zip';
import { pool, setMeta, getMeta } from './db.js';
import { classify } from './types.js';
import { geoTag, STATES } from './geo.js';
import { isTrusted, isBlocked, isNational, LOCAL_SQL } from './outlets.js';

// Established local outlets learned from the data; refreshed by syncTrust()
let localOutlets = new Set();

// Recompute which domains count and flag every article to match. Cheap: only rows whose flag changes get written.
export async function syncTrust() {
  try {
    localOutlets = new Set((await pool.query(LOCAL_SQL)).rows.map(r => r.d).filter(d => !isBlocked(d)));
    const domains = (await pool.query(`SELECT DISTINCT domain FROM articles WHERE domain IS NOT NULL`)).rows.map(r => r.domain);
    const ok = domains.filter(d => isTrusted(d, localOutlets));
    const r = await pool.query(`UPDATE articles SET trusted = (domain = ANY($1)) WHERE trusted IS DISTINCT FROM (domain = ANY($1))`, [ok]);
    console.log(`trust sync: ${ok.length} of ${domains.length} outlets count (${localOutlets.size} learned local), ${r.rowCount} rows updated`);
  } catch (e) { console.error('trust sync failed:', e.message); }
}

// Source: GDELT's static 15-minute GKG files (no API, no rate limit). Each file lists the articles GDELT saw in that window.
const BASE = 'https://data.gdeltproject.org/gdeltv2';
const SLOT = 900e3;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = n => String(n).padStart(2, '0');
const stamp = ms => { const d = new Date(ms); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00`; };
const slotFloor = ms => Math.floor(ms / SLOT) * SLOT;

const xmlDecode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
function parseSeen(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s || '');
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : new Date();
}

// Fallback geo from GDELT's own location column, only when every US location in the article agrees on one state.
function locationFallback(v2loc = '') {
  const states = new Set(); let city = null;
  for (const block of v2loc.split(';')) {
    const f = block.split('#'); // type#name#country#adm1#adm2#lat#lon#featureId#offset
    if (f[2] !== 'US' || (f[0] !== '2' && f[0] !== '3')) continue;
    const st = (f[3] || '').slice(2);
    if (!STATES[st]) continue;
    states.add(st);
    if (f[0] === '3' && !city) city = f[1].split(',')[0];
  }
  return states.size === 1 ? { state: [...states][0], city } : null;
}

// Text of one GKG file -> [{url,title,domain,seen,type,state,city}]. GKG 2.1 is tab separated with 27 columns.
export function parseGkg(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const f = line.split('\t');
    if (f.length < 27) continue;
    const m = /<PAGE_TITLE>([\s\S]*?)<\/PAGE_TITLE>/.exec(f[26]);
    if (!m) continue;
    const title = xmlDecode(m[1]).trim();
    const types = title ? classify(title) : [];
    if (!types.length || !f[4]) continue;
    const geo = geoTag(title) || locationFallback(f[10]);
    if (!geo) continue; // can't pin to a state or city, doesn't score
    for (const type of types) out.push({ url: f[4], title: title.slice(0, 400), domain: f[3] || null, seen: parseSeen(f[1]), type, state: geo.state, city: geo.city });
  }
  return out;
}

async function download(ts) {
  let lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${BASE}/${ts}.gkg.csv.zip`, { signal: AbortSignal.timeout(90000) });
      if (res.status === 404) return null;
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      lastErr = `HTTP ${res.status}`;
    } catch (e) { lastErr = e.cause?.code || e.message; }
    await sleep(3000 * attempt);
  }
  throw new Error(`${ts}: ${lastErr}`);
}

async function processSlot(ts) {
  const buf = await download(ts);
  if (!buf) return { status: 'missing', kept: 0 };
  const entry = new AdmZip(buf).getEntries()[0];
  if (!entry) return { status: 'missing', kept: 0 };
  let kept = 0;
  for (const a of parseGkg(entry.getData().toString('utf8'))) {
    // re-reads (after a classifier change) refresh the geo tag but keep the dismissed flag
    const r = await pool.query(
      `INSERT INTO articles(url,title,domain,seen_at,type,state,city,trusted,national) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (url,type) DO UPDATE SET state = EXCLUDED.state, city = EXCLUDED.city, national = EXCLUDED.national RETURNING (xmax = 0) AS inserted`,
      [a.url, a.title, a.domain, a.seen, a.type, a.state, a.city, isTrusted(a.domain, localOutlets), isNational(a.domain, a.url)]);
    if (r.rows[0]?.inserted) kept++;
  }
  return { status: 'ok', kept };
}

const markDone = ts => pool.query(`INSERT INTO backfill_progress(key) VALUES($1) ON CONFLICT DO NOTHING`, [`gkg:${ts}`]);
const doneSet = async () => new Set((await pool.query(`SELECT key FROM backfill_progress WHERE key LIKE 'gkg:%'`)).rows.map(r => r.key));

// When the classifier or geo rules change: drop stored rows whose headline no longer matches their type (dropped types
// like ICE included), refresh the national flag, then forget which files were read so the backfill re-reads the full history.
// Re-reading only recent days would make new matches look like a spike against an old baseline. Dismissed flags are kept.
export async function reprocessIfChanged(version) {
  if ((await getMeta('classifier_version')) === String(version)) return false;
  let lastId = 0, removed = 0, flagged = 0;
  for (;;) {
    const { rows } = await pool.query(`SELECT id,title,type,domain,url,national FROM articles WHERE id > $1 ORDER BY id LIMIT 5000`, [lastId]);
    if (!rows.length) break;
    lastId = rows[rows.length - 1].id;
    const drop = [], nat = [], notNat = [];
    for (const r of rows) {
      if (!classify(r.title).includes(r.type)) { drop.push(r.id); continue; }
      const n = isNational(r.domain, r.url);
      if (n !== r.national) (n ? nat : notNat).push(r.id);
    }
    if (drop.length) removed += (await pool.query(`DELETE FROM articles WHERE id = ANY($1)`, [drop])).rowCount;
    if (nat.length) flagged += (await pool.query(`UPDATE articles SET national = TRUE WHERE id = ANY($1)`, [nat])).rowCount;
    if (notNat.length) flagged += (await pool.query(`UPDATE articles SET national = FALSE WHERE id = ANY($1)`, [notNat])).rowCount;
  }
  await pool.query(`DELETE FROM backfill_progress WHERE key LIKE 'gkg:%'`);
  await setMeta('classifier_version', version);
  console.log(`classifier v${version}: removed ${removed} rows that no longer match, ${flagged} national flags updated, re-reading history`);
  return true;
}

export async function probe() {
  try { const r = await fetch(`${BASE}/lastupdate.txt`, { signal: AbortSignal.timeout(20000) }); console.log(`gdelt files reachable: HTTP ${r.status}`); }
  catch (e) { console.error('gdelt files NOT reachable:', e.cause?.code || e.message); }
}

// Catch-up pull. Looks back 36h by default so a missed run or a late file heals itself and yesterday is always covered.
let liveRunning = false;
export async function liveIngest(hours = 36) {
  if (liveRunning) return;
  liveRunning = true;
  try {
    const done = await doneSet(), now = Date.now();
    let total = 0, files = 0;
    for (let t = slotFloor(now - 20 * 60e3); t >= now - hours * 3600e3; t -= SLOT) {
      const ts = stamp(t);
      if (done.has(`gkg:${ts}`)) continue;
      try {
        const r = await processSlot(ts);
        // a file missing for 3h+ is treated as gone; a recent one may just not be published yet
        if (r.status === 'ok' || t < now - 3 * 3600e3) await markDone(ts);
        total += r.kept; files++;
      } catch (e) { console.error('live ingest error', e.message); }
    }
    await syncTrust(); // newly established local outlets start counting, their older rows included
    await setMeta('last_live_ingest', new Date().toISOString());
    await setMeta('last_live_ingest_new', total);
    console.log(`live ingest done: ${files} files, ${total} new articles`);
  } finally { liveRunning = false; }
}

// Historical backfill, newest first, resumable, a few files at a time.
let backfillRunning = false;
export async function backfill(days = 90, workers = 3) {
  if (backfillRunning) return;
  backfillRunning = true;
  try {
    const done = await doneSet();
    const start = slotFloor(Date.now() - 3 * 3600e3), todo = [];
    for (let t = start; t > start - days * 86400e3; t -= SLOT) if (!done.has(`gkg:${stamp(t)}`)) todo.push(stamp(t));
    console.log(`backfill: ${todo.length} files to go`);
    let i = 0, n = 0;
    await Promise.all(Array.from({ length: workers }, async () => {
      while (i < todo.length) {
        const ts = todo[i++];
        try { await processSlot(ts); await markDone(ts); if (++n % 100 === 0) console.log(`backfill: ${n}/${todo.length}`); }
        catch (e) { console.error('backfill error', e.message); }
      }
    }));
    if ((await backfillStatus(days)).pct >= 99) await setMeta('backfill_finished', new Date().toISOString());
    console.log('backfill pass finished');
  } finally { backfillRunning = false; }
}

export async function backfillStatus(days = 90) {
  const total = days * 96;
  const r = await pool.query(`SELECT count(*)::int AS n FROM backfill_progress WHERE key LIKE 'gkg:%' AND key >= $1`, [`gkg:${stamp(Date.now() - days * 86400e3)}`]);
  return { done: r.rows[0].n, total, pct: Math.min(100, Math.round(r.rows[0].n / total * 100)), running: backfillRunning,
    lastLive: await getMeta('last_live_ingest'), lastLiveNew: await getMeta('last_live_ingest_new') };
}
