import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import './kids.css';
import { newBook, computePlan, safeName } from './model.js';
import { LocalStore, BridgeStore, bridgeApi, b64ToBlob, copyBookImages, exportBookFile, importBookFile } from './storage.js';
import { callText, parseJSON } from './textAI.js';
import { generateImage, DEFAULT_IMAGE_SETTINGS } from './imageProviders.js';
import { SetupPanel, CastPanel } from './SetupCast.jsx';
import { StoryPanel, IllustratePanel } from './StoryIllustrate.jsx';
import { DesignPanel, PrintPanel } from './DesignPrint.jsx';
import SettingsPanel from './SettingsPanel.jsx';
import { Spinner, Check } from './ui.jsx';
import { exportPicturesZip } from './exporters.js';

const SETTINGS_KEY = 'kids_settings';
export const CLIENT_ID = `web_${Math.random().toString(36).slice(2, 10)}`;

export const DEFAULT_SETTINGS = {
  text: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
  keys: { anthropic: '', openai: '', gemini: '' },
  image: {
    provider: 'gemini',
    gemini: { model: DEFAULT_IMAGE_SETTINGS.gemini.model },
    openai: { model: DEFAULT_IMAGE_SETTINGS.openai.model, quality: 'medium' },
    comfy: { ...DEFAULT_IMAGE_SETTINGS.comfy },
  },
  bridge: { url: 'http://127.0.0.1:7801', enabled: false, bookId: null },
  useRefs: true,
};

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return {
      ...DEFAULT_SETTINGS,
      ...s,
      text: { ...DEFAULT_SETTINGS.text, ...(s.text || {}) },
      keys: { ...DEFAULT_SETTINGS.keys, ...(s.keys || {}) },
      image: {
        ...DEFAULT_SETTINGS.image,
        ...(s.image || {}),
        gemini: { ...DEFAULT_SETTINGS.image.gemini, ...(s.image?.gemini || {}) },
        openai: { ...DEFAULT_SETTINGS.image.openai, ...(s.image?.openai || {}) },
        comfy: { ...DEFAULT_SETTINGS.image.comfy, ...(s.image?.comfy || {}) },
      },
      bridge: { ...DEFAULT_SETTINGS.bridge, ...(s.bridge || {}) },
    };
  } catch (e) {
    return DEFAULT_SETTINGS;
  }
}

// Keys typed on the main novel page are reused when the kids tab has none of its own.
function mainPageKeys(props) {
  const out = { anthropic: props?.anthropic || '', openai: props?.openai || '', gemini: '' };
  try {
    const pk = JSON.parse(localStorage.getItem('novel_provider_keys') || '{}');
    out.anthropic = out.anthropic || pk.anthropic || '';
    out.openai = out.openai || pk.openai || '';
    out.gemini = pk.gemini || '';
  } catch (e) { /* ignore */ }
  out.anthropic = out.anthropic || localStorage.getItem('novel_api_key') || '';
  out.openai = out.openai || localStorage.getItem('novel_openai_key') || '';
  return out;
}

const TABS = [
  ['setup', 'Book'],
  ['cast', 'Cast & Sheets'],
  ['story', 'Story'],
  ['illustrate', 'Illustrations'],
  ['design', 'Design'],
  ['print', 'Print'],
  ['settings', 'Settings'],
];

function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// safeName lives in model.js

export default function KidsBookStudio({ mainKeys }) {
  const [tab, setTab] = useState(() => localStorage.getItem('kids_tab') || 'setup');
  const [settings, setSettings] = useState(loadSettings);
  const [book, setBookRaw] = useState(null);
  const [store, setStore] = useState(null);
  const [busy, setBusy] = useState({});
  const [notices, setNotices] = useState([]);
  const [bridgeLive, setBridgeLive] = useState(false);
  const dirty = useRef(false);
  const serverRev = useRef(0);
  const saveChain = useRef(Promise.resolve());
  const bookRef = useRef(null);
  bookRef.current = book;

  useEffect(() => { localStorage.setItem('kids_tab', tab); }, [tab]);
  useEffect(() => { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }, [settings]);

  const notify = useCallback((text, kind = 'info') => {
    const id = Math.random();
    setNotices(n => [...n.slice(-4), { id, text, kind }]);
    if (kind !== 'error') setTimeout(() => setNotices(n => n.filter(x => x.id !== id)), 7000);
  }, []);

  // ---------- open storage ----------
  const openLocal = useCallback(async () => {
    const st = new LocalStore();
    const b = (await st.loadBook()) || newBook();
    dirty.current = false;
    setStore(st);
    setBookRaw(b);
    setSettings(s => ({ ...s, bridge: { ...s.bridge, enabled: false } }));
  }, []);

  const openBridgeBook = useCallback(async (url, bookId) => {
    const st = new BridgeStore(url, bookId);
    st.clientId = CLIENT_ID;
    const b = await st.loadBook();
    serverRev.current = b.rev || 0;
    dirty.current = false;
    setStore(st);
    setBookRaw(b);
    setSettings(s => ({ ...s, bridge: { ...s.bridge, url, enabled: true, bookId } }));
    bridgeApi.setActive(url, bookId).catch(() => {});
    return b;
  }, []);

  useEffect(() => {
    (async () => {
      const s = loadSettings();
      if (s.bridge.enabled && s.bridge.bookId) {
        try {
          await openBridgeBook(s.bridge.url, s.bridge.bookId);
          return;
        } catch (e) {
          notify(`Couldn't reach the MCP bridge at ${s.bridge.url}, so I'm using this browser's copy instead. Start it with "npm run kids-mcp" and reconnect in Settings.`, 'error');
        }
      }
      const st = new LocalStore();
      setStore(st);
      setBookRaw((await st.loadBook()) || newBook());
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- edits + autosave ----------
  const update = useCallback(u => {
    dirty.current = true;
    setBookRaw(prev => {
      const next = typeof u === 'function' ? u(prev) : { ...prev, ...u };
      return { ...next, updatedAt: Date.now() };
    });
  }, []);

  useEffect(() => {
    if (!book || !store || !dirty.current) return undefined;
    const snapshot = book;
    const t = setTimeout(() => {
      dirty.current = false;
      saveChain.current = saveChain.current.then(async () => {
        try {
          if (store.kind === 'bridge') {
            const saved = await store.saveBook({ ...snapshot, rev: serverRev.current });
            serverRev.current = saved.rev;
          } else {
            await store.saveBook(snapshot);
          }
        } catch (e) {
          if (e.status === 409) {
            const fresh = await store.loadBook();
            serverRev.current = fresh.rev;
            setBookRaw(fresh);
            notify('This book was just changed from Claude/ChatGPT (MCP), so I reloaded the latest version. Your last few seconds of edits may need redoing.');
          } else {
            notify(`Save failed: ${e.message}`, 'error');
          }
        }
      });
    }, store.kind === 'bridge' ? 600 : 250);
    return () => clearTimeout(t);
  }, [book, store, notify]);

  // Live updates from MCP tools.
  useEffect(() => {
    if (!store || store.kind !== 'bridge') { setBridgeLive(false); return undefined; }
    const es = bridgeApi.events(store.base, async ev => {
      if (ev.type === 'hello') setBridgeLive(true);
      if (ev.type !== 'book' || ev.bookId !== store.bookId || ev.writer === CLIENT_ID) return;
      if (ev.rev <= serverRev.current || dirty.current) return;
      try {
        const fresh = await store.loadBook();
        serverRev.current = fresh.rev;
        setBookRaw(fresh);
        notify(`Updated from ${ev.writer && ev.writer.startsWith('mcp') ? 'Claude/ChatGPT via MCP' : 'another window'}.`);
      } catch (e) { /* ignore */ }
    });
    es.onopen = () => setBridgeLive(true);
    es.onerror = () => setBridgeLive(false);
    return () => es.close();
  }, [store, notify]);

  // ---------- AI helpers ----------
  const keys = useMemo(() => {
    const m = mainPageKeys(mainKeys);
    return {
      anthropic: settings.keys.anthropic || m.anthropic,
      openai: settings.keys.openai || m.openai,
      gemini: settings.keys.gemini || m.gemini,
    };
  }, [settings.keys, mainKeys]);

  const imageSettings = useMemo(() => ({
    provider: settings.image.provider,
    gemini: { ...settings.image.gemini, key: keys.gemini },
    openai: { ...settings.image.openai, key: keys.openai },
    comfy: settings.image.comfy,
  }), [settings.image, keys]);

  const ai = useMemo(() => {
    const text = async ({ system = '', prompt, imageIds = [], json = true, maxTokens }) => {
      const images = [];
      for (const id of imageIds) images.push(await store.base64(id));
      return callText({ provider: settings.text.provider, model: settings.text.model, key: keys[settings.text.provider], system, prompt, images, json, maxTokens });
    };
    return {
      text,
      json: async args => parseJSON(await text({ ...args, json: true })),
      image: async ({ prompt, refs = [], aspect = '1:1' }) => {
        const refImgs = [];
        const missing = [];
        const svgs = [];
        for (const r of refs) {
          try {
            const img = await store.base64(r.id);
            refImgs.push({ ...img, label: r.label });
            if (img.mimeType === 'image/svg+xml') svgs.push(r.name || r.label);
          } catch (e) { missing.push(r.label); }
        }
        if (missing.length) notify(`Couldn't load reference image(s): ${missing.join(', ')} — generating without them.`, 'error');
        // Placeholder sheets are SVG, which Gemini/OpenAI can't read — say so instead of silently dropping them.
        if (svgs.length && (settings.image.provider === 'gemini' || settings.image.provider === 'openai')) {
          notify(`${svgs.join(', ')} ${svgs.length > 1 ? 'are placeholder images' : 'is a placeholder image'}, which ${settings.image.provider === 'gemini' ? 'Gemini' : 'OpenAI'} can't use as a reference. Regenerate ${svgs.length > 1 ? 'those sheets' : 'that sheet'} with a real image generator (Cast & Sheets → ↻ Redo all sheets).`, 'error');
        }
        const out = await generateImage(imageSettings, { prompt, refs: refImgs, aspect });
        return store.putImage(b64ToBlob(out));
      },
      putImage: blob => store.putImage(blob),
      imageProvider: settings.image.provider,
      textProvider: settings.text.provider,
    };
  }, [store, settings.text, keys, imageSettings, settings.image.provider, notify]);

  const run = useCallback(async (key, fn) => {
    setBusy(b => ({ ...b, [key]: true }));
    try {
      return await fn();
    } catch (e) {
      console.error(e);
      notify(e.message || String(e), 'error');
      return undefined;
    } finally {
      setBusy(b => { const n = { ...b }; delete n[key]; return n; });
    }
  }, [notify]);

  // ---------- book file actions ----------
  const newBookAction = async () => {
    if (!confirm('Start a new kids book? Export this one first if you want to keep it.')) return;
    if (store.kind === 'bridge') {
      const created = await bridgeApi.createBook(store.base, newBook());
      await openBridgeBook(store.base, created.id);
    } else {
      const b = newBook();
      dirty.current = true;
      setBookRaw(b);
      store.gc(b).catch(() => {});
    }
    setTab('setup');
  };

  const exportAction = () => run('export', async () => {
    const json = await exportBookFile(book, store);
    download(`${safeName(book.title)}.kidsbook.json`, json, 'application/json');
  });

  const [zipHistory, setZipHistory] = useState(false);
  const exportPictures = () => run('zip', async () => {
    const { blob, name, count } = await exportPicturesZip(book, store, { includeHistory: zipHistory });
    download(name, blob);
    notify(`Saved ${count} pictures to ${name}.`);
  });

  const importAction = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = e => {
      const file = e.target.files[0];
      if (!file) return;
      run('import', async () => {
        const text = await file.text();
        if (store.kind === 'bridge') {
          const parsed = JSON.parse(text);
          const created = await bridgeApi.createBook(store.base, { ...(parsed.book || parsed), id: undefined });
          const st = new BridgeStore(store.base, created.id);
          const withImgs = await importBookFile(text, st);
          await st.saveBook({ ...withImgs, id: created.id, rev: created.rev });
          await openBridgeBook(store.base, created.id);
        } else {
          const b = await importBookFile(text, store);
          dirty.current = true;
          setBookRaw(b);
        }
        notify('Book imported.');
      });
    };
    input.click();
  };

  // Move the current browser book onto the bridge (so Claude/ChatGPT can work on it).
  const pushToBridge = async url => {
    const created = await bridgeApi.createBook(url, { ...book, id: undefined });
    const st = new BridgeStore(url, created.id);
    const local = new LocalStore();
    const remapped = await copyBookImages(book, local, st);
    await st.saveBook({ ...remapped, id: created.id, rev: created.rev });
    await openBridgeBook(url, created.id);
    notify('Book copied to the MCP bridge. Claude/ChatGPT can now see and edit it.');
  };

  const pullToBrowser = async () => {
    const local = new LocalStore();
    const remapped = await copyBookImages(book, store, local);
    await local.saveBook(remapped);
    await openLocal();
    notify('Copied into this browser. You are now editing the browser copy.');
  };

  if (!book || !store) return <div className="kb"><Spinner text="Loading kids book…" /></div>;

  const plan = computePlan(book);
  const shared = { book, update, store, ai, run, busy, notify, setTab, settings, setSettings, bookRef, plan };

  return (
    <div className="kb">
      <div className="kb-top">
        <div className="kb-top-title">
          <span className="kb-badge">Kids Book Studio</span>
          <strong>{book.title || 'Untitled kids book'}</strong>
          <span className="text-muted">{book.pageCount} pages · {book.pageCount / 4} sheets · {plan.storyCount}/{plan.capacity} story pages</span>
        </div>
        <div className="flex-row">
          <span className={`kb-store ${store.kind}`} title={store.label()}>
            {store.kind === 'bridge' ? <>● MCP bridge {bridgeLive ? 'live' : 'offline'}</> : '● Saved in this browser'}
          </span>
          <button className="btn btn-sm" onClick={newBookAction}>New book</button>
          <button className="btn btn-sm" onClick={exportAction} disabled={busy.export} title="Whole book in one .json file, pictures included">{busy.export ? 'Exporting…' : 'Export .json'}</button>
          <button className="btn btn-sm" onClick={exportPictures} disabled={busy.zip} title="Every picture as an image file, in a .zip">{busy.zip ? 'Zipping…' : 'Pictures .zip'}</button>
          <Check checked={zipHistory} onChange={setZipHistory}>+ older versions</Check>
          <button className="btn btn-sm" onClick={importAction} disabled={busy.import}>{busy.import ? 'Importing…' : 'Import'}</button>
        </div>
      </div>

      <div className="tabs-bar kb-tabs">
        {TABS.map(([k, label]) => (
          <button key={k} className={`tab-btn ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      {notices.length > 0 && (
        <div className="kb-notices">
          {notices.map(n => (
            <div key={n.id} className={`kb-notice ${n.kind}`}>
              <span>{n.text}</span>
              <button onClick={() => setNotices(x => x.filter(y => y.id !== n.id))}>×</button>
            </div>
          ))}
        </div>
      )}

      {tab === 'setup' && <SetupPanel {...shared} />}
      {tab === 'cast' && <CastPanel {...shared} />}
      {tab === 'story' && <StoryPanel {...shared} />}
      {tab === 'illustrate' && <IllustratePanel {...shared} />}
      {tab === 'design' && <DesignPanel {...shared} />}
      {tab === 'print' && <PrintPanel {...shared} download={download} />}
      {tab === 'settings' && (
        <SettingsPanel
          {...shared}
          keys={keys}
          imageSettings={imageSettings}
          openBridgeBook={openBridgeBook}
          openLocal={openLocal}
          pushToBridge={pushToBridge}
          pullToBrowser={pullToBrowser}
        />
      )}
    </div>
  );
}
