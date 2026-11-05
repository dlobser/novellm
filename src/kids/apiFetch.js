// Shared fetch helpers for AI providers: readable errors and clean keys. Isomorphic.

export const cleanKey = k => String(k || '').trim().replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '');

// fetch() throws a bare "Failed to fetch" when a provider rejects a request without CORS headers
// (OpenAI does this for a bad key), so the real reason is invisible. Translate it into something useful.
export async function apiFetch(label, url, opts, hint) {
  try {
    return await fetch(url, opts);
  } catch (e) {
    throw new Error(hint || `${label} refused the request before the browser could read why. That almost always means the API key was rejected (wrong, expired, revoked, or pasted with extra characters). Check it in Kids Book → Settings. (${e.message})`);
  }
}

// Turn an error response into a short, useful message.
export async function apiError(label, res, model) {
  let raw = '';
  try { raw = await res.text(); } catch (e) { /* ignore */ }
  let msg = raw;
  try {
    const j = JSON.parse(raw);
    msg = j.error?.message || j.error || j.message || raw;
    if (typeof msg !== 'string') msg = JSON.stringify(msg);
  } catch (e) { /* not json */ }
  msg = String(msg).slice(0, 500);
  const suggest = msg.match(/use (?:models\/)?([\w.-]+-[\w.-]+)/i);
  if (res.status === 404 && model) {
    return new Error(`${label}: the model "${model}" isn't available to your account.${suggest ? ` Google suggests "${suggest[1]}".` : ''} Pick another in Kids Book → Settings (click "Load my models"). Details: ${msg}`);
  }
  if (res.status === 401 || res.status === 403) {
    return new Error(`${label} rejected the API key or its permissions (${res.status}). Check the key in Kids Book → Settings. Details: ${msg}`);
  }
  if (res.status === 429) return new Error(`${label} rate limit or quota reached (429). Wait a bit or check billing. Details: ${msg}`);
  return new Error(`${label} error ${res.status}: ${msg}`);
}

// ---------- model lists (so we don't depend on hard-coded names that get retired) ----------
const byNewest = (a, b) => b.localeCompare(a, undefined, { numeric: true });

export async function listModels(provider, key) {
  key = cleanKey(key);
  if (!key) throw new Error('Add the API key first.');
  if (provider === 'gemini') {
    const all = [];
    let token = '';
    do {
      const res = await apiFetch('Gemini', `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000${token ? `&pageToken=${token}` : ''}`, { headers: { 'x-goog-api-key': key } });
      if (!res.ok) throw await apiError('Gemini', res);
      const j = await res.json();
      all.push(...(j.models || []));
      token = j.nextPageToken || '';
    } while (token);
    const ids = all.filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace(/^models\//, ''));
    return {
      text: ids.filter(id => /^gemini/.test(id) && !/image|tts|audio|embed|live|native|robotics|computer/.test(id)).sort(byNewest),
      image: ids.filter(id => /image/.test(id) && !/imagen/.test(id)).sort(byNewest),
    };
  }
  if (provider === 'openai') {
    const res = await apiFetch('OpenAI', 'https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw await apiError('OpenAI', res);
    const ids = ((await res.json()).data || []).map(m => m.id);
    return {
      text: ids.filter(id => /^(gpt-|o\d|chatgpt)/.test(id) && !/image|audio|realtime|tts|transcribe|search|embed|instruct|codex|dall/.test(id)).sort(byNewest),
      image: ids.filter(id => /^(gpt-image|dall-e)/.test(id)).sort(byNewest),
    };
  }
  if (provider === 'anthropic') {
    const res = await apiFetch('Anthropic', 'https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    });
    if (!res.ok) throw await apiError('Anthropic', res);
    return { text: ((await res.json()).data || []).map(m => m.id), image: [] };
  }
  return { text: [], image: [] };
}
