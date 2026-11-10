import React, { useState, useCallback, useRef, useEffect, Suspense, lazy } from 'react';
import SetupTab from './tabs/SetupTab.jsx';
import OutlineTab from './tabs/OutlineTab.jsx';
import ChaptersTab from './tabs/ChaptersTab.jsx';
import FullBookTab from './tabs/FullBookTab.jsx';
import PublishTab from './tabs/PublishTab.jsx';
import SettingsTab from './tabs/SettingsTab.jsx';
import { DEFAULT_PROJECT, normalizeNovel } from './novelModel.js';
import { novelBridge, NOVEL_CLIENT_ID, loadBridgePref, saveBridgePref, tabNovelId, rememberTabNovel } from './novelBridge.js';

// ── Provider Registry ──────────────────────────────────────────────
// type: 'anthropic' uses Anthropic's native API format
// type: 'openai-compat' uses the OpenAI chat/completions format
export const PROVIDER_CATALOG = {
  anthropic: {
    name: 'Anthropic',
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1/messages',
    placeholder: 'sk-ant-...',
    maxTokens: 16384,
    contextWindow: 200000,
    models: [
      { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
      { id: 'claude-opus-4-20250514', label: 'Claude Opus 4' },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    ],
  },
  openai: {
    name: 'OpenAI',
    type: 'openai-compat',
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    placeholder: 'sk-...',
    maxTokens: 8192,
    contextWindow: 128000,
    models: [
      { id: 'gpt-4o', label: 'GPT-4o' },
      { id: 'gpt-4o-mini', label: 'GPT-4o Mini' },
      { id: 'gpt-4.1', label: 'GPT-4.1' },
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
      { id: 'o3', label: 'o3' },
      { id: 'o4-mini', label: 'o4-mini' },
    ],
  },
  venice: {
    name: 'Venice',
    type: 'openai-compat',
    baseUrl: 'https://api.venice.ai/api/v1/chat/completions',
    placeholder: 'venice-...',
    maxTokens: 8192,
    contextWindow: 32000,
    models: [
      { id: 'zai-org-glm-4.7', label: 'GLM 4.7 (Flagship)' },
      { id: 'qwen3-235b-a22b', label: 'Qwen3 235B' },
      { id: 'llama-3.3-70b', label: 'Llama 3.3 70B' },
      { id: 'qwen3-4b', label: 'Qwen3 4B (Fast)' },
      { id: 'venice-uncensored', label: 'Venice Uncensored' },
    ],
  },
};

// Kids Book Studio is self-contained and loaded on demand (keeps the novel pages unchanged).
const KidsBookStudio = lazy(() => import('./kids/KidsBookStudio.jsx'));

function loadProject() {
  try {
    const raw = localStorage.getItem('novel_project');
    if (raw) {
      const p = JSON.parse(raw);
      if (p.chapterWordCount && !p.chapterWordCountMin) {
        p.chapterWordCountMin = p.chapterWordCount;
        p.chapterWordCountMax = p.chapterWordCount;
        delete p.chapterWordCount;
      }
      return p;
    }
  } catch (e) {}
  return null;
}

function loadOutline() {
  try {
    const raw = localStorage.getItem('novel_outline');
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return [];
}

function loadChapters() {
  try {
    const raw = localStorage.getItem('novel_chapters');
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return {};
}

// Migrate old per-key storage to new providers map
function loadProviderKeys() {
  try {
    const raw = localStorage.getItem('novel_provider_keys');
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  // Migrate from old format
  const keys = {};
  const oldAnthropicKey = localStorage.getItem('novel_api_key');
  const oldOpenaiKey = localStorage.getItem('novel_openai_key');
  if (oldAnthropicKey) keys.anthropic = oldAnthropicKey;
  if (oldOpenaiKey) keys.openai = oldOpenaiKey;
  return keys;
}

export default function App() {
  // Two separate modes: a novel (adult book) or a kids' picture book.
  // ?kidsbook=<id> opens a bridge book straight in kids mode (one browser tab per book).
  // ?novel=<id> does the same for a novel on the bridge.
  const [mode, setModeRaw] = useState(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.has('kidsbook')) return 'kids';
    if (q.has('novel')) return 'novel';
    return localStorage.getItem('book_mode') === 'kids' ? 'kids' : 'novel';
  });
  const setMode = m => {
    setModeRaw(m);
    localStorage.setItem('book_mode', m);
    const u = new URL(window.location.href);
    const other = m === 'novel' ? 'kidsbook' : 'novel';
    if (u.searchParams.has(other)) { u.searchParams.delete(other); window.history.replaceState(null, '', u); }
  };
  const [tab, setTab] = useState(0);
  const [activeProvider, setActiveProvider] = useState(() => localStorage.getItem('novel_api_provider') || 'anthropic');
  const [activeModel, setActiveModel] = useState(() => localStorage.getItem('novel_api_model') || 'claude-sonnet-4-20250514');
  const [providerKeys, setProviderKeys] = useState(() => loadProviderKeys());
  const [project, setProjectRaw] = useState(() => loadProject() || { ...DEFAULT_PROJECT });
  const [outline, setOutlineRaw] = useState(() => loadOutline());
  const [chapters, setChaptersRaw] = useState(() => loadChapters());

  // ── Where the novel lives: this browser (localStorage) or the MCP bridge ──
  // On the bridge, edits autosave there and changes made by Claude/ChatGPT show up live.
  // The browser copy in localStorage is left alone while a bridge novel is open.
  const [novelStore, setNovelStore] = useState(null); // { url, novelId }
  const storeRef = useRef(null);
  const [bridgeLive, setBridgeLive] = useState(false);
  const [bridgeNotice, setBridgeNoticeRaw] = useState('');
  const noticeTimer = useRef(null);
  const setBridgeNotice = useCallback(text => {
    setBridgeNoticeRaw(text);
    clearTimeout(noticeTimer.current);
    if (text) noticeTimer.current = setTimeout(() => setBridgeNoticeRaw(''), 8000);
  }, []);
  const novelDirty = useRef(false);
  const novelRev = useRef(0);
  const saveChain = useRef(Promise.resolve());

  // Setters handed to the tabs mark the novel as edited (so it autosaves to the bridge).
  const setProject = useCallback(v => { novelDirty.current = true; setProjectRaw(v); }, []);
  const setOutline = useCallback(v => { novelDirty.current = true; setOutlineRaw(v); }, []);
  const setChapters = useCallback(v => { novelDirty.current = true; setChaptersRaw(v); }, []);

  const applyNovel = useCallback(raw => {
    const n = normalizeNovel(raw);
    novelRev.current = n.rev || 0;
    novelDirty.current = false;
    setProjectRaw(n.project);
    setOutlineRaw(n.outline);
    setChaptersRaw(n.chapters);
  }, []);

  const openNovel = useCallback(async (url, novelId) => {
    const n = await novelBridge.load(url, novelId);
    storeRef.current = { url, novelId };
    applyNovel(n);
    setNovelStore({ url, novelId });
    saveBridgePref({ url, enabled: true, novelId });
    rememberTabNovel(novelId);
    return n;
  }, [applyNovel]);

  const disconnectNovel = useCallback(() => {
    storeRef.current = null;
    setNovelStore(null);
    saveBridgePref({ ...loadBridgePref(), enabled: false });
    rememberTabNovel(null);
    novelDirty.current = false;
    setProjectRaw(loadProject() || { ...DEFAULT_PROJECT });
    setOutlineRaw(loadOutline());
    setChaptersRaw(loadChapters());
  }, []);
  const [loading, setLoading] = useState({});
  const [theme, setTheme] = useState(() => localStorage.getItem('novel_theme') || 'dark');

  const cancelRef = useRef(false);

  // Apply theme
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('novel_theme', theme);
  }, [theme]);

  // Persist (browser copy only — a bridge novel saves to the bridge instead)
  useEffect(() => { if (!storeRef.current) localStorage.setItem('novel_project', JSON.stringify(project)); }, [project]);
  useEffect(() => { if (!storeRef.current) localStorage.setItem('novel_outline', JSON.stringify(outline)); }, [outline]);
  useEffect(() => { if (!storeRef.current) localStorage.setItem('novel_chapters', JSON.stringify(chapters)); }, [chapters]);

  // Reopen this tab's bridge novel (URL ?novel=, this tab's last one, or the last one used).
  const triedBridge = useRef(false);
  useEffect(() => {
    if (mode !== 'novel' || triedBridge.current) return;
    triedBridge.current = true;
    const pref = loadBridgePref();
    const want = tabNovelId() || (pref.enabled && pref.novelId);
    if (!want) return;
    openNovel(pref.url, want).catch(() => {
      setBridgeNotice(`Couldn't open the novel on the MCP bridge at ${pref.url}, so you're seeing this browser's copy. Start the bridge (npm run kids-mcp) and reconnect in Settings.`);
    });
  }, [mode, openNovel, setBridgeNotice]);

  // Autosave to the bridge.
  useEffect(() => {
    if (!novelStore || !novelDirty.current) return undefined;
    const snap = { project, outline, chapters };
    const { url, novelId } = novelStore;
    const t = setTimeout(() => {
      novelDirty.current = false;
      saveChain.current = saveChain.current.then(async () => {
        if (!storeRef.current || storeRef.current.novelId !== novelId) return;
        try {
          const saved = await novelBridge.save(url, novelId, { ...snap, rev: novelRev.current });
          novelRev.current = saved.rev;
        } catch (e) {
          if (e.status === 409 && e.body) {
            applyNovel(e.body);
            setBridgeNotice('This novel was just changed from Claude/ChatGPT (MCP), so I loaded the latest version. Your last few seconds of edits may need redoing.');
          } else {
            setBridgeNotice(`Couldn't save to the bridge: ${e.message}`);
          }
        }
      });
    }, 800);
    return () => clearTimeout(t);
  }, [project, outline, chapters, novelStore, applyNovel, setBridgeNotice]);

  // Live updates from MCP tools.
  useEffect(() => {
    if (!novelStore) { setBridgeLive(false); return undefined; }
    const { url, novelId } = novelStore;
    const es = novelBridge.events(url, async ev => {
      if (ev.type === 'hello') setBridgeLive(true);
      if (ev.type !== 'novel' || ev.novelId !== novelId || ev.writer === NOVEL_CLIENT_ID) return;
      if (ev.rev <= novelRev.current || novelDirty.current) return;
      try {
        const fresh = await novelBridge.load(url, novelId);
        if (storeRef.current?.novelId !== novelId || novelDirty.current) return;
        applyNovel(fresh);
        setBridgeNotice(`Updated from ${ev.writer && ev.writer.startsWith('mcp') ? 'Claude/ChatGPT via MCP' : 'another window'}.`);
      } catch (e) { /* ignore */ }
    });
    es.onopen = () => setBridgeLive(true);
    es.onerror = () => setBridgeLive(false);
    return () => es.close();
  }, [novelStore, applyNovel, setBridgeNotice]);

  const sendNovelToBridge = useCallback(async url => {
    const created = await novelBridge.create(url, { project, outline, chapters });
    await openNovel(url, created.id);
    setBridgeNotice('Novel copied to the MCP bridge. Claude/ChatGPT can now see and edit it.');
  }, [project, outline, chapters, openNovel, setBridgeNotice]);

  const newNovelOnBridge = useCallback(async url => {
    const created = await novelBridge.create(url, { project: { ...DEFAULT_PROJECT } });
    await openNovel(url, created.id);
    setTab(0);
  }, [openNovel]);

  const copyNovelToBrowser = useCallback(async () => {
    if (!confirm('Replace the novel saved in this browser with this one? The bridge copy stays as it is.')) return;
    localStorage.setItem('novel_project', JSON.stringify(project));
    localStorage.setItem('novel_outline', JSON.stringify(outline));
    localStorage.setItem('novel_chapters', JSON.stringify(chapters));
    disconnectNovel();
    setBridgeNotice('Copied into this browser and disconnected from the bridge.');
  }, [project, outline, chapters, disconnectNovel, setBridgeNotice]);
  useEffect(() => { localStorage.setItem('novel_provider_keys', JSON.stringify(providerKeys)); }, [providerKeys]);
  useEffect(() => { localStorage.setItem('novel_api_model', activeModel); }, [activeModel]);
  useEffect(() => { localStorage.setItem('novel_api_provider', activeProvider); }, [activeProvider]);

  // Save/Load JSON
  const exportProject = useCallback(() => {
    const data = { project, outline, chapters };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project.title || 'novel'}_project.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [project, outline, chapters]);

  const importProject = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target.result);
          if (storeRef.current) {
            const { url } = storeRef.current;
            novelBridge.create(url, data)
              .then(created => openNovel(url, created.id))
              .then(() => setBridgeNotice('Imported as a new novel on the MCP bridge.'))
              .catch(err => alert('Import failed: ' + err.message));
            return;
          }
          if (data.project) setProject(data.project);
          if (data.outline) setOutline(data.outline);
          if (data.chapters) setChapters(data.chapters);
        } catch (err) {
          alert('Failed to parse project file');
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }, [openNovel, setBridgeNotice, setProject, setOutline, setChapters]);

  const clearProject = useCallback(() => {
    if (storeRef.current) {
      if (!confirm('Start a new empty novel on the MCP bridge? The current one stays saved there.')) return;
      newNovelOnBridge(storeRef.current.url).catch(err => alert('Could not create a novel: ' + err.message));
      return;
    }
    if (!confirm('Clear everything? This will erase all project data, outline, and chapters. (API keys are kept.) Make sure you\'ve exported your project first!')) return;
    setProject({ ...DEFAULT_PROJECT });
    setOutline([]);
    setChapters({});
    setTab(0);
    setLoading({});
  }, [newNovelOnBridge, setProject, setOutline, setChapters]);

  // ── Unified API call ──────────────────────────────────────────────
  const callAPIStreaming = useCallback(async (messages, systemPrompt = '', overrides = {}, onChunk = null) => {
    const provId = overrides.provider || activeProvider;
    const modelId = overrides.model || activeModel;
    const catalog = PROVIDER_CATALOG[provId];
    if (!catalog) throw new Error(`Unknown provider: ${provId}`);

    const key = providerKeys[provId];
    if (!key) { alert(`Please enter your ${catalog.name} API key`); return null; }

    if (catalog.type === 'openai-compat') {
      const oaiMessages = [];
      if (systemPrompt) oaiMessages.push({ role: 'system', content: systemPrompt });
      oaiMessages.push(...messages);

      if (onChunk) {
        const res = await fetch(catalog.baseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
          body: JSON.stringify({ model: modelId, max_tokens: catalog.maxTokens || 8192, messages: oaiMessages, stream: true }),
        });
        if (!res.ok) { const err = await res.text(); throw new Error(`${catalog.name} API Error ${res.status}: ${err}`); }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let full = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n').filter(l => l.startsWith('data: '));
          for (const line of lines) {
            const data = line.slice(6);
            if (data === '[DONE]') break;
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content || '';
              if (delta) { full += delta; onChunk(full); }
            } catch (e) {}
          }
        }
        return full;
      } else {
        const res = await fetch(catalog.baseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
          body: JSON.stringify({ model: modelId, max_tokens: catalog.maxTokens || 8192, messages: oaiMessages }),
        });
        if (!res.ok) { const err = await res.text(); throw new Error(`${catalog.name} API Error ${res.status}: ${err}`); }
        const data = await res.json();
        return data.choices[0]?.message?.content || '';
      }
    } else {
      // Anthropic native
      const body = { model: modelId, max_tokens: catalog.maxTokens || 8192, messages };
      if (systemPrompt) body.system = systemPrompt;

      if (onChunk) {
        body.stream = true;
        const res = await fetch(catalog.baseUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) { const err = await res.text(); throw new Error(`Anthropic API Error ${res.status}: ${err}`); }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let full = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const parsed = JSON.parse(line.slice(6));
                if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                  full += parsed.delta.text;
                  onChunk(full);
                }
              } catch (e) {}
            }
          }
        }
        return full;
      } else {
        const res = await fetch(catalog.baseUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) { const err = await res.text(); throw new Error(`Anthropic API Error ${res.status}: ${err}`); }
        const data = await res.json();
        return data.content.map(c => c.text || '').join('');
      }
    }
  }, [providerKeys, activeModel, activeProvider]);

  const callClaude = useCallback(async (messages, systemPrompt = '') => {
    return callAPIStreaming(messages, systemPrompt);
  }, [callAPIStreaming]);

  const callClaudeStreaming = useCallback(async (messages, systemPrompt = '', onChunk = null) => {
    return callAPIStreaming(messages, systemPrompt, {}, onChunk);
  }, [callAPIStreaming]);

  const callAsEditor = useCallback(async (editor, messages, systemPrompt = '') => {
    if (editor.overrideModel && editor.overrideProvider && editor.overrideModelId) {
      return callAPIStreaming(messages, systemPrompt, { provider: editor.overrideProvider, model: editor.overrideModelId });
    }
    return callAPIStreaming(messages, systemPrompt);
  }, [callAPIStreaming]);

  const configuredCount = Object.keys(providerKeys).filter(k => providerKeys[k]).length;
  const tabs = ['Setup', 'Outline', 'Chapters', 'Full Book', 'Publish', 'Settings'];
  const SETTINGS_TAB = 5;

  const header = (
    <>
      <header className="app-header">
        <button className="theme-toggle" onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')} title="Toggle light/dark mode">
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
        <h1>The AI Book Generator</h1>
        <div className="subtitle">{mode === 'kids' ? "Illustrated Kids' Picture Books" : 'AI-Assisted Long-Form Text Writing'}</div>
        <div className="instructions">
          {mode === 'kids'
            ? "Write, illustrate and print a children's picture book as a folded booklet. Use your own API keys (Settings tab), free local ComfyUI, or Claude/ChatGPT through the MCP bridge. Keys stay on your machine."
            : "This tool is free to use — just provide your API key (Claude or OpenAI or both). Your key will not be transmitted or shared; it stays local on your machine. Keep it safe and don't share it! One book will cost around a dollar in tokens."}
        </div>
      </header>

      <div className="mode-switch" role="tablist" aria-label="What are you making?">
        <button role="tab" aria-selected={mode === 'novel'} className={`mode-btn ${mode === 'novel' ? 'active' : ''}`} onClick={() => setMode('novel')}>
          <strong>Novel</strong>
          <span>A long-form book, written chapter by chapter</span>
        </button>
        <button role="tab" aria-selected={mode === 'kids'} className={`mode-btn ${mode === 'kids' ? 'active' : ''}`} onClick={() => setMode('kids')}>
          <strong>Kids' picture book</strong>
          <span>An illustrated story that prints as a booklet</span>
        </button>
      </div>
    </>
  );

  if (mode === 'kids') {
    return (
      <div className="app-container">
        {header}
        <Suspense fallback={<div className="text-muted">Loading Kids Book Studio…</div>}>
          <KidsBookStudio mainKeys={providerKeys} />
        </Suspense>
      </div>
    );
  }

  return (
    <div className="app-container">
      {header}

      {/* PROJECT ACTIONS */}
      <div className="flex-row mb-md" style={{ justifyContent: 'flex-end' }}>
        <button
          className={`store-chip ${novelStore ? (bridgeLive ? 'bridge' : 'offline') : ''}`}
          style={{ marginRight: 'auto' }}
          onClick={() => setTab(SETTINGS_TAB)}
          title="Where this novel is saved (Settings)"
        >
          {novelStore
            ? <>● MCP bridge {bridgeLive ? 'live' : 'offline'} · {novelStore.novelId}</>
            : <>● Saved in this browser{configuredCount === 0 ? ' · no API key yet (Settings)' : ''}</>}
        </button>
        <button className="btn btn-sm" onClick={exportProject}>Export JSON</button>
        <button className="btn btn-sm" onClick={importProject}>Import JSON</button>
        <button className="btn btn-sm btn-danger" onClick={clearProject}>New Project</button>
      </div>

      {/* TABS */}
      <div className="tabs-bar">
        {tabs.map((t, i) => (
          <button key={t} className={`tab-btn ${tab === i ? 'active' : ''}`} onClick={() => setTab(i)}>
            {t}
          </button>
        ))}
      </div>

      {bridgeNotice && (
        <div className="bridge-notice">
          <span>{bridgeNotice}</span>
          <button className="btn btn-sm" onClick={() => setBridgeNotice('')}>×</button>
        </div>
      )}

      {/* TAB CONTENT */}
      {tab === 0 && (
        <SetupTab
          project={project}
          setProject={setProject}
          callClaude={callClaude}
          outline={outline}
          setOutline={setOutline}
          loading={loading}
          setLoading={setLoading}
          setTab={setTab}
        />
      )}
      {tab === 1 && (
        <OutlineTab
          project={project}
          outline={outline}
          setOutline={setOutline}
          chapters={chapters}
          setChapters={setChapters}
          callClaude={callClaude}
          callClaudeStreaming={callClaudeStreaming}
          callAsEditor={callAsEditor}
          loading={loading}
          setLoading={setLoading}
          setTab={setTab}
          cancelRef={cancelRef}
          activeProvider={activeProvider}
        />
      )}
      {tab === 2 && (
        <ChaptersTab
          project={project}
          outline={outline}
          chapters={chapters}
          setChapters={setChapters}
          callClaude={callClaude}
          callClaudeStreaming={callClaudeStreaming}
          callAsEditor={callAsEditor}
          loading={loading}
          setLoading={setLoading}
          activeProvider={activeProvider}
        />
      )}
      {tab === 3 && (
        <FullBookTab
          project={project}
          setProject={setProject}
          outline={outline}
          chapters={chapters}
          callClaude={callClaude}
          callAsEditor={callAsEditor}
          loading={loading}
          setLoading={setLoading}
        />
      )}
      {tab === 4 && (
        <PublishTab
          project={project}
          outline={outline}
          chapters={chapters}
        />
      )}
      {tab === SETTINGS_TAB && (
        <SettingsTab
          title={project.title}
          providers={{ catalog: PROVIDER_CATALOG, providerKeys, setProviderKeys, activeProvider, setActiveProvider, activeModel, setActiveModel }}
          bridge={{
            store: novelStore,
            live: bridgeLive,
            url: novelStore?.url || loadBridgePref().url,
            openNovel,
            disconnect: disconnectNovel,
            sendToBridge: sendNovelToBridge,
            copyToBrowser: copyNovelToBrowser,
            newOnBridge: newNovelOnBridge,
            setNotice: setBridgeNotice,
          }}
        />
      )}
    </div>
  );
}
