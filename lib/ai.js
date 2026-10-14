// Shared Claude call used by the fit brief and the push drafter. Needs ANTHROPIC_API_KEY on Railway.
const API = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1';
const FALLBACK_MODEL = 'claude-sonnet-4-5';
let model = null, fastModel = null;

export const aiOn = () => !!process.env.ANTHROPIC_API_KEY;
const headers = () => ({ 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' });

async function listModels() {
  try {
    const r = await fetch(`${API}/models?limit=100`, { headers: headers(), signal: AbortSignal.timeout(15000) });
    return ((await r.json()).data || []).map(m => m.id);
  } catch (e) { console.error('model list failed:', e.message); return []; }
}

// AI_MODEL env wins; otherwise the newest Sonnet this key can use. fast: newest Haiku (AI_FAST_MODEL env wins), for small jobs.
async function pickModel(skipEnv = false, fast = false) {
  if (fast) {
    if (fastModel) return fastModel;
    if (!skipEnv && process.env.AI_FAST_MODEL) return (fastModel = process.env.AI_FAST_MODEL);
    fastModel = (await listModels()).find(id => /haiku/.test(id)) || await pickModel(skipEnv);
    return fastModel;
  }
  if (model) return model;
  if (!skipEnv && process.env.AI_MODEL) return (model = process.env.AI_MODEL);
  const ids = await listModels();
  model = ids.find(id => /sonnet/.test(id)) || ids[0] || null;
  return model || FALLBACK_MODEL;
}

async function call(body, timeout = 120000) {
  const r = await fetch(`${API}/messages`, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`Anthropic ${r.status}: ${j.error?.message || 'request failed'}`); e.status = r.status; throw e; }
  return j;
}

export const noDashes = v => typeof v === 'string' ? v.replace(/\s*[–—]\s*/g, ', ')
  : Array.isArray(v) ? v.map(noDashes) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, noDashes(x)])) : v;

// Fallback when the model answers in text: take the outermost {...} block.
function jsonFromText(content = []) {
  const t = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

// One tool-shaped answer. Returns { out, model }.
export async function askTool({ system, tool, user, maxTokens = 8000, fast = false, timeout }) {
  // tool_choice stays "auto": newer models reject a forced tool. The prompt tells it to call the tool, and a JSON
  // reply in plain text is accepted as a fallback.
  const body = { model: await pickModel(false, fast), max_tokens: maxTokens, system, tools: [tool], tool_choice: { type: 'auto' }, messages: [{ role: 'user', content: user }] };
  let j;
  try { j = await call(body, timeout); }
  catch (e) { // bad or retired model name: fall back to whatever the key lists
    if (e.status !== 404) throw e;
    if (fast) fastModel = null; else model = null;
    body.model = await pickModel(true, fast); j = await call(body, timeout);
  }
  return { out: noDashes(j.content?.find(c => c.type === 'tool_use')?.input || jsonFromText(j.content)), model: body.model };
}
