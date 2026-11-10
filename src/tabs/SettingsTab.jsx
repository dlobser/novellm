import React, { useEffect, useState } from 'react';
import { novelBridge, novelTabUrl, novelChatPrompt } from '../novelBridge.js';

async function copyText(text, setNotice) {
  try { await navigator.clipboard.writeText(text); setNotice('Copied.'); } catch (e) { window.prompt('Copy this:', text); }
}

function ProvidersSection({ catalog, providerKeys, setProviderKeys, activeProvider, setActiveProvider, activeModel, setActiveModel }) {
  return (
    <div className="section">
      <h3>API providers</h3>
      <p className="text-muted mb-md">Used when this page writes for you. Keys stay in this browser. To write without an API key, use the MCP bridge below and let Claude or ChatGPT do the writing.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {Object.entries(catalog).map(([provId, cat]) => {
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
                  <strong style={{ fontSize: '0.9rem', color: isActive ? 'var(--accent)' : 'var(--text-primary)' }}>{cat.name}</strong>
                  {hasKey && <span style={{ fontSize: '0.72rem', color: 'var(--success)' }}>✓ key set</span>}
                </div>
                {hasKey && (
                  <button className={`btn btn-sm ${isActive ? 'btn-accent' : ''}`} onClick={() => { setActiveProvider(provId); setActiveModel(cat.models[0].id); }}>
                    {isActive ? 'Active' : 'Set Active'}
                  </button>
                )}
              </div>
              <div className="flex-row" style={{ gap: 8 }}>
                <input
                  type="text"
                  value={providerKeys[provId] || ''}
                  onChange={e => setProviderKeys(prev => ({ ...prev, [provId]: e.target.value }))}
                  placeholder={cat.placeholder}
                  style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem', flex: 1 }}
                />
                {isActive && (
                  <select value={activeModel} onChange={e => setActiveModel(e.target.value)} style={{ maxWidth: 200 }}>
                    {cat.models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BridgeSection({ bridge, title }) {
  const { store, live, url: savedUrl, openNovel, disconnect, sendToBridge, copyToBrowser, newOnBridge, setNotice } = bridge;
  const [url, setUrl] = useState(savedUrl);
  const [health, setHealth] = useState(null);
  const [novels, setNovels] = useState([]);
  const [busy, setBusy] = useState('');

  const run = async (key, fn) => {
    setBusy(key);
    try { await fn(); } catch (e) { setNotice(e.message); } finally { setBusy(''); }
  };

  const check = (u = url) => run('check', async () => {
    try {
      const h = await novelBridge.health(u);
      if (!(h.features || []).includes('novels')) {
        setHealth({ error: 'this bridge is an older version without novel support. Restart it (npm run kids-mcp, or reopen Claude Desktop) to load the new code.' });
        setNovels([]);
        return;
      }
      setHealth(h);
      setNovels(await novelBridge.list(u));
    } catch (e) {
      setHealth({ error: e.message === 'Failed to fetch' ? 'nothing answered' : e.message });
      setNovels([]);
    }
  });

  useEffect(() => { if (store) check(store.url); }, [store?.novelId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="section">
      <h3>MCP bridge — write with Claude or ChatGPT</h3>
      <p className="text-muted mb-md">
        The bridge is a small local server (<code>mcp/server.mjs</code>) that keeps novels on this computer and gives Claude Desktop or ChatGPT tools to write them.
        The chat writes the outline and chapters, and they show up here live. Several chats can each work on a different novel at the same time.
      </p>

      <div className="flex-row" style={{ gap: 8, alignItems: 'flex-end' }}>
        <div style={{ flex: 2 }}>
          <label>Bridge address</label>
          <input type="text" value={url} onChange={e => setUrl(e.target.value)} />
        </div>
        <button className="btn" onClick={() => check()} disabled={busy === 'check'}>{busy === 'check' ? 'Checking…' : 'Check connection'}</button>
      </div>

      {health && (health.error ? (
        <div className="mt-md" style={{ color: 'var(--danger, #d66)' }}>
          Not reachable: {health.error}. Start it with <code>npm run kids-mcp</code> in the project folder (or open Claude Desktop once it's configured). If Chrome asks to allow access to devices on your local network, click Allow.
        </div>
      ) : (
        <div className="mt-md" style={{ color: 'var(--success)' }}>Connected · server v{health.version} · novels stored in <code>{health.dataDir}</code></div>
      ))}

      {store ? (
        <div className="flex-row mt-md" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span>Editing <b>{title || 'Untitled'}</b> on the bridge {live ? '(live)' : '(offline)'} · ID <code>{store.novelId}</code></span>
          <button className="btn btn-sm" onClick={() => copyText(novelChatPrompt(store.novelId, title), setNotice)}>Copy chat prompt</button>
          <button className="btn btn-sm" onClick={() => run('pull', copyToBrowser)}>{busy === 'pull' ? 'Copying…' : 'Copy into this browser'}</button>
          <button className="btn btn-sm" onClick={disconnect}>Disconnect (use browser copy)</button>
        </div>
      ) : (
        health && !health.error && (
          <div className="flex-row mt-md" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-accent" onClick={() => run('push', () => sendToBridge(url))}>{busy === 'push' ? 'Sending…' : 'Send this novel to the bridge'}</button>
            <span className="text-muted">Copies the novel in this browser so Claude/ChatGPT can work on it.</span>
          </div>
        )
      )}

      {health && !health.error && (
        <div className="mt-md">
          <div className="flex-row" style={{ justifyContent: 'space-between' }}>
            <strong>Novels on the bridge</strong>
            <button className="btn btn-sm" onClick={() => run('new', () => newOnBridge(url))}>{busy === 'new' ? 'Creating…' : 'New empty novel'}</button>
          </div>
          {novels.length === 0 ? <p className="text-muted">None yet.</p> : (
            <div style={{ overflowX: 'auto' }}>
              <table className="novel-table mt-sm">
                <thead><tr><th>Title</th><th>Novel ID</th><th>Chapters</th><th>Updated</th><th /></tr></thead>
                <tbody>
                  {novels.map(n => {
                    const here = store && store.novelId === n.id;
                    return (
                      <tr key={n.id} className={here ? 'active' : ''}>
                        <td>{n.title || 'Untitled'}</td>
                        <td><code style={{ fontSize: '0.75rem' }}>{n.id}</code></td>
                        <td>{n.chaptersWritten}/{n.chapters}</td>
                        <td>{n.updatedAt ? new Date(n.updatedAt).toLocaleString() : ''}</td>
                        <td>
                          <div className="flex-row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                            {here ? <span className="text-muted">open here</span> : (
                              <button className="btn btn-sm" onClick={() => run('open', () => openNovel(url, n.id))}>Open</button>
                            )}
                            <a className="btn btn-sm" href={novelTabUrl(n.id)} target="_blank" rel="noreferrer" title="Watch this novel in its own browser tab">New tab</a>
                            <button className="btn btn-sm" onClick={() => copyText(novelChatPrompt(n.id, n.title), setNotice)} title="Paste into a new Claude/ChatGPT chat so it works only on this novel">Copy chat prompt</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <details className="mt-md">
        <summary>How to connect Claude or ChatGPT</summary>
        <ol style={{ paddingLeft: 20, lineHeight: 1.6 }}>
          <li><b>Claude Desktop:</b> Settings → Developer → Edit Config, add a <code>kids-book</code> server that runs <code>node &lt;project&gt;/mcp/server.mjs</code> (see KIDS_BOOK.md). Claude starts the bridge itself.</li>
          <li><b>Bridge without Claude open:</b> run <code>npm run kids-mcp</code> and keep the window open.</li>
          <li><b>ChatGPT:</b> set <code>KIDSBOOK_MCP_TOKEN</code>, run <code>npm run kids-mcp</code> and <code>cloudflared tunnel --url http://127.0.0.1:7801</code>, then add <code>https://&lt;tunnel-host&gt;/mcp/&lt;token&gt;</code> under Settings → Connectors → Developer mode.</li>
          <li><b>One chat per novel:</b> click <i>Copy chat prompt</i> on a novel and paste it into a new chat. Try: “Write the outline, then write chapter 1.”</li>
        </ol>
      </details>
    </div>
  );
}

export default function SettingsTab({ providers, bridge, title }) {
  return (
    <div>
      <BridgeSection bridge={bridge} title={title} />
      <ProvidersSection {...providers} />
    </div>
  );
}
