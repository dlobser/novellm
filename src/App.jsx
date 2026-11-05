import React, { useState, useCallback, useRef, useEffect, Suspense, lazy } from 'react';
import SetupTab from './tabs/SetupTab.jsx';
import OutlineTab from './tabs/OutlineTab.jsx';
import ChaptersTab from './tabs/ChaptersTab.jsx';
import FullBookTab from './tabs/FullBookTab.jsx';
import PublishTab from './tabs/PublishTab.jsx';
import CollapsibleSection from './components/CollapsibleSection.jsx';

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

const DEFAULT_PROJECT = {
  title: '',
  synopsis: '',
  characters: [],
  settings: [],
  systemPrompt: '',
  editors: [],
  background: [],
  chapterWordCountMin: 2000,
  chapterWordCountMax: 5000,
  chapterCount: 25,
  frontBackMatter: {
    tableOfContents: true,
    bibliography: false,
    index: false,
    acknowledgements: false,
    copyrightNotice: false,
  },
  acknowledgementsText: '',
  copyrightText: '',
  bibliographyText: '',
  indexText: '',
};

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
  const [tab, setTab] = useState(0);
  const [activeProvider, setActiveProvider] = useState(() => localStorage.getItem('novel_api_provider') || 'anthropic');
  const [activeModel, setActiveModel] = useState(() => localStorage.getItem('novel_api_model') || 'claude-sonnet-4-20250514');
  const [providerKeys, setProviderKeys] = useState(() => loadProviderKeys());
  const [project, setProject] = useState(() => loadProject() || { ...DEFAULT_PROJECT });
  const [outline, setOutline] = useState(() => loadOutline());
  const [chapters, setChapters] = useState(() => loadChapters());
  const [loading, setLoading] = useState({});
  const [theme, setTheme] = useState(() => localStorage.getItem('novel_theme') || 'dark');

  const cancelRef = useRef(false);

  // Apply theme
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('novel_theme', theme);
  }, [theme]);

  // Persist
  useEffect(() => { localStorage.setItem('novel_project', JSON.stringify(project)); }, [project]);
  useEffect(() => { localStorage.setItem('novel_outline', JSON.stringify(outline)); }, [outline]);
  useEffect(() => { localStorage.setItem('novel_chapters', JSON.stringify(chapters)); }, [chapters]);
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
  }, []);

  const clearProject = useCallback(() => {
    if (!confirm('Clear everything? This will erase all project data, outline, and chapters. (API keys are kept.) Make sure you\'ve exported your project first!')) return;
    setProject({ ...DEFAULT_PROJECT });
    setOutline([]);
    setChapters({});
    setTab(0);
    setLoading({});
  }, []);

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

  // Count configured providers
  const configuredCount = Object.keys(providerKeys).filter(k => providerKeys[k]).length;

  const tabs = ['Setup', 'Outline', 'Chapters', 'Full Book', 'Publish', 'Kids Book'];

  return (
    <div className="app-container">
      <header className="app-header">
        <button className="theme-toggle" onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')} title="Toggle light/dark mode">
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
        <h1>The AI Book Generator</h1>
        <div className="subtitle">AI-Assisted Long-Form Text Writing</div>
        <div className="instructions">
          This tool is free to use — just provide your API key (Claude or OpenAI or both). Your key will not be transmitted or shared; it stays local on your machine. Keep it safe and don't share it! One book will cost around a dollar in tokens.
        </div>
      </header>

      {/* PROVIDERS */}
      <CollapsibleSection
        title={`API Providers — ${configuredCount > 0 ? `${configuredCount} configured, active: ${PROVIDER_CATALOG[activeProvider]?.name || activeProvider}` : 'none configured'}`}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {Object.entries(PROVIDER_CATALOG).map(([provId, catalog]) => {
            const hasKey = !!providerKeys[provId];
            const isActive = activeProvider === provId;
            return (
              <div key={provId} style={{
                background: isActive ? 'var(--accent-glow)' : 'var(--bg-tertiary)',
                border: `1px solid ${isActive ? 'var(--accent)' : hasKey ? 'var(--success)' : 'var(--border)'}`,
                borderRadius: 'var(--radius)',
                padding: '12px 14px',
              }}>
                <div className="flex-row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
                  <div className="flex-row">
                    <strong style={{ fontSize: '0.9rem', color: isActive ? 'var(--accent)' : 'var(--text-primary)' }}>{catalog.name}</strong>
                    {hasKey && <span style={{ fontSize: '0.72rem', color: 'var(--success)' }}>✓ key set</span>}
                  </div>
                  {hasKey && (
                    <button
                      className={`btn btn-sm ${isActive ? 'btn-accent' : ''}`}
                      onClick={() => {
                        setActiveProvider(provId);
                        // Pick first model from this provider
                        setActiveModel(catalog.models[0].id);
                      }}
                    >
                      {isActive ? 'Active' : 'Set Active'}
                    </button>
                  )}
                </div>
                <div className="flex-row" style={{ gap: 8 }}>
                  <input
                    type="text"
                    value={providerKeys[provId] || ''}
                    onChange={e => setProviderKeys(prev => ({ ...prev, [provId]: e.target.value }))}
                    placeholder={catalog.placeholder}
                    style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem', flex: 1 }}
                  />
                  {isActive && (
                    <select
                      value={activeModel}
                      onChange={e => setActiveModel(e.target.value)}
                      style={{ maxWidth: 200 }}
                    >
                      {catalog.models.map(m => (
                        <option key={m.id} value={m.id}>{m.label}</option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            );
          })}
        </div>

      </CollapsibleSection>

      {/* PROJECT ACTIONS */}
      <div className="flex-row mb-md" style={{ justifyContent: 'flex-end' }}>
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
      {tab === 5 && (
        <Suspense fallback={<div className="text-muted">Loading Kids Book Studio…</div>}>
          <KidsBookStudio mainKeys={providerKeys} />
        </Suspense>
      )}
    </div>
  );
}
