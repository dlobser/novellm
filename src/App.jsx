import React, { useState, useCallback, useRef, useEffect } from 'react';
import SetupTab from './tabs/SetupTab.jsx';
import OutlineTab from './tabs/OutlineTab.jsx';
import ChaptersTab from './tabs/ChaptersTab.jsx';
import FullBookTab from './tabs/FullBookTab.jsx';
import PublishTab from './tabs/PublishTab.jsx';

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
      // Migrate old single chapterWordCount to min/max
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

export default function App() {
  const [tab, setTab] = useState(0);
  const [apiProvider, setApiProvider] = useState(() => localStorage.getItem('novel_api_provider') || 'anthropic');
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('novel_api_key') || '');
  const [openaiKey, setOpenaiKey] = useState(() => localStorage.getItem('novel_openai_key') || '');
  const [apiModel, setApiModel] = useState(() => localStorage.getItem('novel_api_model') || 'claude-sonnet-4-20250514');
  const [project, setProject] = useState(() => loadProject() || { ...DEFAULT_PROJECT });
  const [outline, setOutline] = useState(() => loadOutline());
  const [chapters, setChapters] = useState(() => loadChapters());
  const [loading, setLoading] = useState({});

  // Persist
  useEffect(() => { localStorage.setItem('novel_project', JSON.stringify(project)); }, [project]);
  useEffect(() => { localStorage.setItem('novel_outline', JSON.stringify(outline)); }, [outline]);
  useEffect(() => { localStorage.setItem('novel_chapters', JSON.stringify(chapters)); }, [chapters]);
  useEffect(() => { localStorage.setItem('novel_api_key', apiKey); }, [apiKey]);
  useEffect(() => { localStorage.setItem('novel_openai_key', openaiKey); }, [openaiKey]);
  useEffect(() => { localStorage.setItem('novel_api_model', apiModel); }, [apiModel]);
  useEffect(() => { localStorage.setItem('novel_api_provider', apiProvider); }, [apiProvider]);

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

  // Clear everything and start fresh
  const clearProject = useCallback(() => {
    if (!confirm('Clear everything? This will erase all project data, outline, and chapters. (API keys are kept.) Make sure you\'ve exported your project first!')) return;
    setProject({ ...DEFAULT_PROJECT });
    setOutline([]);
    setChapters({});
    setTab(0);
    setLoading({});
  }, []);

  // Low-level API call with explicit provider/model/key
  const callAPI = useCallback(async (messages, systemPrompt = '', overrides = {}) => {
    const prov = overrides.provider || apiProvider;
    const mod = overrides.model || apiModel;
    const aKey = overrides.provider === 'anthropic' ? apiKey : overrides.provider === 'openai' ? openaiKey : (prov === 'anthropic' ? apiKey : openaiKey);

    if (prov === 'openai') {
      if (!aKey && !openaiKey) { alert('Please enter your OpenAI API key'); return null; }
      const oaiMessages = [];
      if (systemPrompt) oaiMessages.push({ role: 'system', content: systemPrompt });
      oaiMessages.push(...messages);

      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aKey || openaiKey}` },
        body: JSON.stringify({ model: mod, max_tokens: 8192, messages: oaiMessages }),
      });
      if (!res.ok) { const err = await res.text(); throw new Error(`OpenAI API Error ${res.status}: ${err}`); }
      const data = await res.json();
      return data.choices[0]?.message?.content || '';
    } else {
      if (!aKey && !apiKey) { alert('Please enter your Anthropic API key'); return null; }
      const body = { model: mod, max_tokens: 8192, messages };
      if (systemPrompt) body.system = systemPrompt;

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': aKey || apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) { const err = await res.text(); throw new Error(`Anthropic API Error ${res.status}: ${err}`); }
      const data = await res.json();
      return data.content.map(c => c.text || '').join('');
    }
  }, [apiKey, openaiKey, apiModel, apiProvider]);

  // Default call using current provider settings
  const callClaude = useCallback(async (messages, systemPrompt = '') => {
    return callAPI(messages, systemPrompt);
  }, [callAPI]);

  // Call with editor-specific overrides (if editor has overrideModel set)
  const callAsEditor = useCallback(async (editor, messages, systemPrompt = '') => {
    if (editor.overrideModel && editor.overrideProvider && editor.overrideModelId) {
      return callAPI(messages, systemPrompt, { provider: editor.overrideProvider, model: editor.overrideModelId });
    }
    return callAPI(messages, systemPrompt);
  }, [callAPI]);

  const tabs = ['Setup', 'Outline', 'Chapters', 'Full Book', 'Publish'];

  return (
    <div className="app-container">
      <header className="app-header">
        <h1>Novel Generator</h1>
        <div className="subtitle">AI-Powered Long-Form Fiction</div>
      </header>

      {/* API KEY BAR */}
      <div className="api-key-bar" style={{ flexWrap: 'wrap' }}>
        <div className="field" style={{ maxWidth: 160 }}>
          <label>Provider</label>
          <select value={apiProvider} onChange={(e) => {
            setApiProvider(e.target.value);
            // Set a sensible default model when switching
            if (e.target.value === 'openai') setApiModel('gpt-4o');
            else setApiModel('claude-sonnet-4-20250514');
          }}>
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
          </select>
        </div>

        <div className="field">
          <label>Anthropic API Key</label>
          <input
            type="text"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-ant-..."
            style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem' }}
          />
        </div>
        <div className="field">
          <label>OpenAI API Key</label>
          <input
            type="text"
            value={openaiKey}
            onChange={(e) => setOpenaiKey(e.target.value)}
            placeholder="sk-..."
            style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem' }}
          />
        </div>

        <div className="field" style={{ maxWidth: 260 }}>
          <label>Model</label>
          {apiProvider === 'anthropic' ? (
            <select value={apiModel} onChange={(e) => setApiModel(e.target.value)}>
              <option value="claude-sonnet-4-20250514">Claude Sonnet 4</option>
              <option value="claude-opus-4-20250514">Claude Opus 4</option>
              <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
            </select>
          ) : (
            <select value={apiModel} onChange={(e) => setApiModel(e.target.value)}>
              <option value="gpt-4o">GPT-4o</option>
              <option value="gpt-4o-mini">GPT-4o Mini</option>
              <option value="gpt-4.1">GPT-4.1</option>
              <option value="gpt-4.1-mini">GPT-4.1 Mini</option>
              <option value="o3">o3</option>
              <option value="o4-mini">o4-mini</option>
            </select>
          )}
        </div>

        <div className="flex-row">
          <button className="btn btn-sm" onClick={exportProject}>Export JSON</button>
          <button className="btn btn-sm" onClick={importProject}>Import JSON</button>
          <button className="btn btn-sm btn-danger" onClick={clearProject}>New Project</button>
        </div>
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
          callAsEditor={callAsEditor}
          loading={loading}
          setLoading={setLoading}
          setTab={setTab}
        />
      )}
      {tab === 2 && (
        <ChaptersTab
          project={project}
          outline={outline}
          chapters={chapters}
          setChapters={setChapters}
          callClaude={callClaude}
          callAsEditor={callAsEditor}
          loading={loading}
          setLoading={setLoading}
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
    </div>
  );
}
