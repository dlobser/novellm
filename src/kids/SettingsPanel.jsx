import React, { useEffect, useState } from 'react';
import { TEXT_PROVIDERS } from './textAI.js';
import { IMAGE_PROVIDERS, comfyCheckpoints, DEFAULT_COMFY_WORKFLOW } from './imageProviders.js';
import { bridgeApi } from './storage.js';
import { Field, Spinner, Check, Img } from './ui.jsx';

function KeyInput({ value, onChange, fallback, placeholder }) {
  const [show, setShow] = useState(false);
  return (
    <div className="flex-row" style={{ flexWrap: 'nowrap' }}>
      <input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={fallback ? 'Using the key from the main page' : placeholder}
        style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}
        autoComplete="off"
      />
      <button className="btn btn-sm" onClick={() => setShow(s => !s)}>{show ? 'Hide' : 'Show'}</button>
    </div>
  );
}

export default function SettingsPanel({ settings, setSettings, keys, imageSettings, ai, run, busy, store, book, notify, openBridgeBook, openLocal, pushToBridge, pullToBrowser }) {
  const [ckpts, setCkpts] = useState([]);
  const [testImg, setTestImg] = useState(null);
  const [bridgeUrl, setBridgeUrl] = useState(settings.bridge.url);
  const [health, setHealth] = useState(null);
  const [books, setBooks] = useState([]);
  const [shareKeys, setShareKeys] = useState(false);

  const setText = patch => setSettings(s => ({ ...s, text: { ...s.text, ...patch } }));
  const setKey = (k, v) => setSettings(s => ({ ...s, keys: { ...s.keys, [k]: v } }));
  const setImg = patch => setSettings(s => ({ ...s, image: { ...s.image, ...patch } }));
  const setImgP = (p, patch) => setSettings(s => ({ ...s, image: { ...s.image, [p]: { ...s.image[p], ...patch } } }));
  const comfy = settings.image.comfy;

  const checkBridge = (url = bridgeUrl) => run('bridge', async () => {
    try {
      const h = await bridgeApi.health(url);
      setHealth(h);
      setBooks(await bridgeApi.listBooks(url));
      setSettings(s => ({ ...s, bridge: { ...s.bridge, url } }));
    } catch (e) {
      setHealth({ error: e.message });
      setBooks([]);
    }
  });

  useEffect(() => { if (store.kind === 'bridge') checkBridge(store.base); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadCkpts = () => run('ckpts', async () => {
    const list = await comfyCheckpoints(comfy.url);
    setCkpts(list);
    if (!comfy.checkpoint && list[0]) setImgP('comfy', { checkpoint: list[0] });
    notify(`ComfyUI connected — ${list.length} checkpoints found.`);
  });

  const testImage = () => run('testImg', async () => {
    const id = await ai.image({ prompt: `A friendly little fox waving hello, children's picture book illustration. Art style: ${book.artStyle}. No text.`, aspect: '1:1' });
    setTestImg(id);
  });

  const shareSettings = () => run('share', async () => {
    const payload = {
      image: {
        provider: settings.image.provider,
        gemini: { model: settings.image.gemini.model, ...(shareKeys ? { key: keys.gemini } : {}) },
        openai: { model: settings.image.openai.model, quality: settings.image.openai.quality, ...(shareKeys ? { key: keys.openai } : {}) },
        comfy: settings.image.comfy,
      },
    };
    await bridgeApi.putSettings(settings.bridge.url, payload);
    notify(`Image settings sent to the MCP server${shareKeys ? ' (including API keys)' : ''}.`);
  });

  const serverPath = health?.serverPath || 'C:\\path\\to\\novellm\\mcp\\server.mjs';
  const claudeConfig = JSON.stringify({
    mcpServers: {
      'kids-book': {
        command: 'node',
        args: [serverPath],
        env: { GEMINI_API_KEY: 'optional — or send keys from this page', OPENAI_API_KEY: 'optional' },
      },
    },
  }, null, 2);

  return (
    <div className="kb-panel kb-settings">
      <div className="kb-card">
        <h3>Writing AI</h3>
        <p className="text-muted mb-sm">Used for the story, cast suggestions, reading your character pictures, and blurbs. To use no API at all, connect the MCP bridge below and let Claude or ChatGPT desktop do the writing.</p>
        <div className="kb-row">
          <Field label="Provider">
            <select value={settings.text.provider} onChange={e => setText({ provider: e.target.value, model: TEXT_PROVIDERS[e.target.value].models[0] })}>
              {Object.entries(TEXT_PROVIDERS).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
            </select>
          </Field>
          <Field label="Model" hint="Type any model id">
            <input type="text" list="kb-text-models" value={settings.text.model} onChange={e => setText({ model: e.target.value })} />
            <datalist id="kb-text-models">{TEXT_PROVIDERS[settings.text.provider].models.map(m => <option key={m} value={m} />)}</datalist>
          </Field>
        </div>
      </div>

      <div className="kb-card">
        <h3>API keys</h3>
        <p className="text-muted mb-sm">Stored only in this browser. Anthropic/OpenAI keys from the main page are reused when these are blank.</p>
        <div className="kb-row">
          <Field label="Anthropic"><KeyInput value={settings.keys.anthropic} onChange={v => setKey('anthropic', v)} fallback={!settings.keys.anthropic && keys.anthropic} placeholder="sk-ant-…" /></Field>
          <Field label="OpenAI"><KeyInput value={settings.keys.openai} onChange={v => setKey('openai', v)} fallback={!settings.keys.openai && keys.openai} placeholder="sk-…" /></Field>
          <Field label="Google Gemini"><KeyInput value={settings.keys.gemini} onChange={v => setKey('gemini', v)} placeholder="AIza…" /></Field>
        </div>
      </div>

      <div className="kb-card">
        <h3>Image generator</h3>
        <div className="kb-seg kb-seg-wide mb-md">
          {Object.entries(IMAGE_PROVIDERS).map(([k, p]) => (
            <button key={k} className={settings.image.provider === k ? 'on' : ''} onClick={() => setImg({ provider: k })}>{p.label}</button>
          ))}
        </div>

        {settings.image.provider === 'gemini' && (
          <Field label="Gemini image model" hint={keys.gemini ? '' : 'Needs a Gemini API key (above).'}>
            <input type="text" list="kb-gem-models" value={settings.image.gemini.model} onChange={e => setImgP('gemini', { model: e.target.value })} />
            <datalist id="kb-gem-models">{IMAGE_PROVIDERS.gemini.models.map(m => <option key={m} value={m} />)}</datalist>
          </Field>
        )}

        {settings.image.provider === 'openai' && (
          <div className="kb-row">
            <Field label="OpenAI image model" hint={keys.openai ? '' : 'Needs an OpenAI API key (above).'}>
              <input type="text" list="kb-oai-models" value={settings.image.openai.model} onChange={e => setImgP('openai', { model: e.target.value })} />
              <datalist id="kb-oai-models">{IMAGE_PROVIDERS.openai.models.map(m => <option key={m} value={m} />)}</datalist>
            </Field>
            <Field label="Quality">
              <select value={settings.image.openai.quality} onChange={e => setImgP('openai', { quality: e.target.value })}>
                {['low', 'medium', 'high', 'auto'].map(q => <option key={q} value={q}>{q}</option>)}
              </select>
            </Field>
          </div>
        )}

        {settings.image.provider === 'comfy' && (
          <>
            <div className="kb-row">
              <Field label="ComfyUI address" hint={'Start ComfyUI with  --enable-cors-header "*"  so this page can talk to it.'}>
                <input type="text" value={comfy.url} onChange={e => setImgP('comfy', { url: e.target.value })} />
              </Field>
              <Field label="Checkpoint (for the built-in workflow)">
                <div className="flex-row" style={{ flexWrap: 'nowrap' }}>
                  {ckpts.length ? (
                    <select value={comfy.checkpoint} onChange={e => setImgP('comfy', { checkpoint: e.target.value })}>
                      {ckpts.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  ) : (
                    <input type="text" value={comfy.checkpoint} onChange={e => setImgP('comfy', { checkpoint: e.target.value })} placeholder="sd_xl_base_1.0.safetensors" />
                  )}
                  {busy.ckpts ? <Spinner /> : <button className="btn btn-sm" onClick={loadCkpts}>Connect</button>}
                </div>
              </Field>
            </div>
            <div className="kb-row">
              <Field label="Steps"><input type="number" value={comfy.steps} onChange={e => setImgP('comfy', { steps: Number(e.target.value) })} /></Field>
              <Field label="CFG"><input type="number" step={0.5} value={comfy.cfg} onChange={e => setImgP('comfy', { cfg: Number(e.target.value) })} /></Field>
              <Field label="Negative prompt" style={{ flex: 3 }}><input type="text" value={comfy.negative} onChange={e => setImgP('comfy', { negative: e.target.value })} /></Field>
            </div>
            <Field
              label="Custom workflow (optional, API format JSON)"
              hint={<>Leave blank for a basic text-to-image workflow. For character consistency use your own workflow (IPAdapter, Flux Kontext, Qwen Image Edit…) exported with “Save (API Format)”. Placeholders: <code>{'{{prompt}}'}</code> <code>{'{{negative}}'}</code> <code>{'{{seed}}'}</code> <code>{'{{width}}'}</code> <code>{'{{height}}'}</code> <code>{'{{checkpoint}}'}</code> <code>{'{{steps}}'}</code> <code>{'{{cfg}}'}</code>, and <code>{'{{image1}}'}</code>, <code>{'{{image2}}'}</code>… in LoadImage nodes for reference sheets (uploaded automatically).</>}
            >
              <textarea rows={5} value={comfy.workflow} onChange={e => setImgP('comfy', { workflow: e.target.value })} placeholder={JSON.stringify(DEFAULT_COMFY_WORKFLOW).slice(0, 160) + '…'} style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }} />
            </Field>
          </>
        )}

        {settings.image.provider === 'placeholder' && <p className="text-muted">Makes free colored placeholder pictures with the prompt written on them, so you can test layouts and printing without spending anything.</p>}

        <div className="flex-row mt-md">
          {busy.testImg ? <Spinner text="Generating test image…" /> : <button className="btn btn-sm" onClick={testImage}>Test image generator</button>}
          {testImg && <Img store={store} id={testImg} className="kb-slot-img" />}
        </div>
      </div>

      <div className="kb-card" id="mcp">
        <h3>MCP bridge — work with Claude or ChatGPT desktop</h3>
        <p className="text-muted">
          A small server on your computer that holds your kids books. Claude Desktop or ChatGPT can read and write them through MCP tools (write the story, add characters, generate sheets and pictures with your local ComfyUI), and this page updates live. Your chat subscription does the writing, so you don’t spend API tokens.
        </p>
        <div className="kb-row mt-md" style={{ alignItems: 'flex-end' }}>
          <Field label="Bridge address" style={{ flex: 2 }}><input type="text" value={bridgeUrl} onChange={e => setBridgeUrl(e.target.value)} /></Field>
          {busy.bridge ? <Spinner text="Checking…" /> : <button className="btn" onClick={() => checkBridge()}>Check connection</button>}
        </div>
        {health && (health.error ? (
          <div className="kb-warn">Not reachable: {health.error}. Start it with <code>npm run kids-mcp</code> in the project folder (or open Claude Desktop once it’s configured). If Chrome asks to allow access to devices on your local network, click Allow.</div>
        ) : (
          <div className="kb-ok">Connected · server v{health.version} · books stored in <code>{health.dataDir}</code></div>
        ))}

        {store.kind === 'bridge' ? (
          <div className="flex-row mt-md">
            <span>Editing <b>{book.title || 'Untitled'}</b> on the bridge.</span>
            <button className="btn btn-sm" onClick={() => run('pull', pullToBrowser)}>{busy.pull ? 'Copying…' : 'Copy into this browser'}</button>
            <button className="btn btn-sm" onClick={openLocal}>Disconnect (use browser copy)</button>
          </div>
        ) : (
          health && !health.error && (
            <div className="flex-row mt-md">
              <button className="btn btn-accent" onClick={() => run('push', () => pushToBridge(bridgeUrl))}>{busy.push ? 'Sending…' : 'Send this book to the bridge'}</button>
              <span className="text-muted">Copies the browser book (with pictures) so Claude/ChatGPT can work on it.</span>
            </div>
          )
        )}

        {books.length > 0 && (
          <table className="kb-table mt-md">
            <thead><tr><th>Books on the bridge</th><th>Pages</th><th>Updated</th><th /></tr></thead>
            <tbody>
              {books.map(b => (
                <tr key={b.id} className={store.kind === 'bridge' && store.bookId === b.id ? 'active' : ''}>
                  <td>{b.title || 'Untitled'}{b.active ? <span className="kb-chip on" style={{ marginLeft: 6 }}>active in MCP</span> : null}</td>
                  <td>{b.pageCount}</td>
                  <td>{b.updatedAt ? new Date(b.updatedAt).toLocaleString() : ''}</td>
                  <td>
                    {store.kind === 'bridge' && store.bookId === b.id ? 'open' : (
                      <button className="btn btn-sm" onClick={() => run('openBridge', () => openBridgeBook(bridgeUrl, b.id))}>Open</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {health && !health.error && (
          <div className="flex-row mt-md">
            <button className="btn btn-sm" onClick={shareSettings}>{busy.share ? 'Sending…' : 'Send image-generator settings to MCP server'}</button>
            <Check checked={shareKeys} onChange={setShareKeys}>include API keys (saved in the bridge’s settings file on this computer)</Check>
          </div>
        )}

        <details className="mt-md">
          <summary>Setup instructions</summary>
          <ol className="kb-steps">
            <li>In the project folder run <code>npm install</code> once.</li>
            <li><b>Claude Desktop:</b> Settings → Developer → Edit Config, add this to <code>claude_desktop_config.json</code>, then restart Claude:
              <pre className="kb-pre">{claudeConfig}</pre>
              Claude starts the server itself, and the bridge for this page comes up with it. Try: “Create a kids book about a hedgehog who is scared of the dark, 16 pages, and write the story.”
            </li>
            <li><b>Bridge without Claude open:</b> run <code>npm run kids-mcp</code> and keep the window open.</li>
            <li><b>ChatGPT desktop / web:</b> ChatGPT only connects to MCP servers over HTTPS. Run <code>npm run kids-mcp</code> with a secret, e.g. <code>set KIDSBOOK_MCP_TOKEN=pick-a-long-secret</code>, expose it with a tunnel such as <code>cloudflared tunnel --url http://127.0.0.1:7801</code>, then in ChatGPT → Settings → Connectors → Advanced → Developer mode, add a connector with URL <code>https://&lt;your-tunnel&gt;/mcp/pick-a-long-secret</code>.</li>
            <li>Pictures generated from Claude/ChatGPT use the image settings you send with the button above (or <code>GEMINI_API_KEY</code> / <code>OPENAI_API_KEY</code> / <code>COMFY_URL</code> environment variables). ComfyUI is free and local.</li>
          </ol>
        </details>
      </div>
    </div>
  );
}
