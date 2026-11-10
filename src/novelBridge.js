// Talks to the local MCP bridge (mcp/server.mjs) for novels, so Claude/ChatGPT can write them.
export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:7801';
export const NOVEL_CLIENT_ID = `web_${Math.random().toString(36).slice(2, 10)}`;

const clean = base => String(base || DEFAULT_BRIDGE_URL).replace(/\/+$/, '');

async function req(base, path, opts = {}) {
  const res = await fetch(`${clean(base)}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Kidsbook-Client': NOVEL_CLIENT_ID, ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let body = null;
    try { body = JSON.parse(text); } catch (e) { /* not json */ }
    throw Object.assign(new Error(`Bridge ${res.status}: ${(body && body.error) || text.slice(0, 300)}`), { status: res.status, body });
  }
  return res.json();
}

export const novelBridge = {
  health: base => req(base, '/api/health'),
  list: base => req(base, '/api/novels'),
  create: (base, data) => req(base, '/api/novels', { method: 'POST', body: JSON.stringify(data || {}) }),
  load: (base, id) => req(base, `/api/novels/${encodeURIComponent(id)}`),
  save: (base, id, novel) => req(base, `/api/novels/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(novel) }),
  events(base, onEvent) {
    const es = new EventSource(`${clean(base)}/api/events`);
    es.onmessage = e => { try { onEvent(JSON.parse(e.data)); } catch (err) { /* ignore */ } };
    return es;
  },
};

// Which bridge novel this browser tab shows: URL ?novel=, then this tab's sessionStorage.
// localStorage (novel_bridge) only supplies the default for a brand-new tab.
const TAB_KEY = 'novel_tab_id';
const PREF_KEY = 'novel_bridge';

export function loadBridgePref() {
  try { return { url: DEFAULT_BRIDGE_URL, enabled: false, novelId: null, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') }; } catch (e) {
    return { url: DEFAULT_BRIDGE_URL, enabled: false, novelId: null };
  }
}
export function saveBridgePref(p) { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch (e) { /* ignore */ } }

export function tabNovelId() {
  const q = new URLSearchParams(window.location.search).get('novel');
  if (q) return q;
  try { return sessionStorage.getItem(TAB_KEY); } catch (e) { return null; }
}

export function rememberTabNovel(id) {
  try { if (id) sessionStorage.setItem(TAB_KEY, id); else sessionStorage.removeItem(TAB_KEY); } catch (e) { /* ignore */ }
  const u = new URL(window.location.href);
  if (u.searchParams.has('novel') || id) {
    if (id) u.searchParams.set('novel', id); else u.searchParams.delete('novel');
    window.history.replaceState(null, '', u);
  }
}

export function novelTabUrl(id) {
  const u = new URL(window.location.href);
  u.searchParams.delete('kidsbook');
  u.searchParams.set('novel', id);
  return u.toString();
}

export function novelChatPrompt(id, title) {
  return `You're working on my novel "${title || 'Untitled'}" with the book-generator tools.\n`
    + `Novel ID: ${id}\n`
    + `Pass novelId "${id}" on every tool call. Don't touch any other novel or kids book, and don't call create_novel. `
    + `For each chapter: get_chapter_brief, write the full chapter, then write_chapter with a continuity summary.`;
}
