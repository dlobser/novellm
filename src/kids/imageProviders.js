// Image generation back-ends: Gemini, OpenAI, local ComfyUI, and a free placeholder.
// Isomorphic: uses only fetch / FormData / Blob, so it runs in the browser and in Node 18+.
// Every generator takes { prompt, refs: [{mimeType, data(base64), label}], aspect } and returns { mimeType, data }.
import { apiFetch, apiError, cleanKey } from './apiFetch.js';

export const IMAGE_PROVIDERS = {
  gemini: { label: 'Google Gemini', models: ['gemini-2.5-flash-image', 'gemini-3-pro-image-preview'] },
  openai: { label: 'OpenAI (GPT Image)', models: ['gpt-image-1', 'gpt-image-1-mini'] },
  comfy: { label: 'ComfyUI (local)', models: [] },
  placeholder: { label: 'Placeholder (free, for layout testing)', models: [] },
};

export const DEFAULT_IMAGE_SETTINGS = {
  provider: 'gemini',
  gemini: { key: '', model: 'gemini-2.5-flash-image' },
  openai: { key: '', model: 'gpt-image-1', quality: 'medium' },
  comfy: { url: 'http://127.0.0.1:8188', checkpoint: '', workflow: '', negative: 'text, letters, watermark, signature, blurry, deformed', steps: 28, cfg: 6 },
};

// ---------- base64 helpers (no Buffer in the browser, no atob guarantees in old Node) ----------
export function b64ToBytes(b64) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(s);
}

function textToB64(str) {
  return bytesToB64(new TextEncoder().encode(str));
}

async function readError(res) {
  let t = '';
  try { t = await res.text(); } catch (e) { /* ignore */ }
  try {
    const j = JSON.parse(t);
    t = j.error?.message || j.error || j.message || t;
  } catch (e) { /* not json */ }
  return `${res.status} ${typeof t === 'string' ? t.slice(0, 600) : JSON.stringify(t).slice(0, 600)}`;
}

// ---------- Gemini ----------
async function geminiImage(cfg, { prompt, refs, aspect }) {
  cfg = { ...cfg, key: cleanKey(cfg.key), model: String(cfg.model || '').trim() };
  if (!cfg.key) throw new Error('Add a Gemini API key in Kids Book → Settings (or GEMINI_API_KEY for the MCP server).');
  const usable = refs.filter(r => /image\/(png|jpe?g|webp|heic|heif)/.test(r.mimeType));
  const parts = [];
  if (usable.length) parts.push({ text: `${usable.length} reference image${usable.length > 1 ? 's follow' : ' follows'}, each labeled. Use them as the instructions after them describe.` });
  usable.forEach((r, i) => {
    parts.push({ text: `Reference ${i + 1}: ${r.label || 'reference image'}` });
    parts.push({ inlineData: { mimeType: r.mimeType, data: r.data } });
  });
  parts.push({ text: usable.length ? `Now create ONE new illustration.\n${prompt}` : prompt });
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: aspect ? { aspectRatio: aspect } : undefined },
  };
  const model = cfg.model || 'gemini-2.5-flash-image';
  const res = await apiFetch('Gemini', `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.key },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await apiError('Gemini (images)', res, model);
  const json = await res.json();
  const cand = json.candidates?.[0];
  const img = cand?.content?.parts?.find(p => p.inlineData || p.inline_data);
  if (!img) {
    const said = cand?.content?.parts?.map(p => p.text).filter(Boolean).join(' ');
    const why = json.promptFeedback?.blockReason || cand?.finishReason || 'no image returned';
    throw new Error(`Gemini returned no image (${why}). ${said || ''}`.trim());
  }
  const d = img.inlineData || img.inline_data;
  return { mimeType: d.mimeType || d.mime_type || 'image/png', data: d.data };
}

// ---------- OpenAI ----------
function openaiSize(aspect) {
  if (aspect === '2:3' || aspect === '3:4' || aspect === '9:16') return '1024x1536';
  if (aspect === '3:2' || aspect === '4:3' || aspect === '16:9') return '1536x1024';
  return '1024x1024';
}

async function openaiImage(cfg, { prompt, refs, aspect }) {
  cfg = { ...cfg, key: cleanKey(cfg.key), model: String(cfg.model || '').trim() };
  if (!cfg.key) throw new Error('Add an OpenAI API key in Kids Book → Settings (or OPENAI_API_KEY for the MCP server).');
  const model = cfg.model || 'gpt-image-1';
  const size = openaiSize(aspect);
  let res;
  const usable = refs.filter(r => /image\/(png|jpe?g|webp)/.test(r.mimeType));
  if (usable.length) {
    const labels = usable.map((r, i) => `Image ${i + 1}: ${r.label || 'reference'}`).join('\n');
    const makeForm = fidelity => {
      const fd = new FormData();
      fd.append('model', model);
      fd.append('prompt', `Attached reference images:\n${labels}\n\nCreate ONE new illustration (do not just edit image 1).\n${prompt}`);
      fd.append('size', size);
      if (cfg.quality) fd.append('quality', cfg.quality);
      if (fidelity) fd.append('input_fidelity', 'high');
      fd.append('n', '1');
      usable.forEach((r, i) => {
        const ext = r.mimeType.split('/')[1].replace('jpeg', 'jpg');
        fd.append('image[]', new Blob([b64ToBytes(r.data)], { type: r.mimeType }), `ref${i + 1}.${ext}`);
      });
      return fd;
    };
    const send = fidelity => apiFetch('OpenAI', 'https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${cfg.key}` }, body: makeForm(fidelity) });
    const wantFidelity = /^gpt-image-1(\.|$)/.test(model);
    res = await send(wantFidelity);
    // Older/other models may not know input_fidelity — retry once without it.
    if (wantFidelity && res.status === 400) {
      const t = await res.clone().text();
      if (/input_fidelity/i.test(t)) res = await send(false);
    }
  } else {
    res = await apiFetch('OpenAI', 'https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({ model, prompt, size, n: 1, ...(cfg.quality ? { quality: cfg.quality } : {}) }),
    });
  }
  if (!res.ok) throw await apiError('OpenAI (images)', res, model);
  const json = await res.json();
  const item = json.data?.[0];
  if (item?.b64_json) return { mimeType: 'image/png', data: item.b64_json };
  if (item?.url) {
    const r = await fetch(item.url);
    const buf = new Uint8Array(await r.arrayBuffer());
    return { mimeType: r.headers.get('content-type') || 'image/png', data: bytesToB64(buf) };
  }
  throw new Error('OpenAI returned no image');
}

// ---------- ComfyUI ----------
// A plain text-to-image workflow (API format). Any checkpoint works; pick one in Settings.
export const DEFAULT_COMFY_WORKFLOW = {
  3: { class_type: 'KSampler', inputs: { seed: '{{seed}}', steps: '{{steps}}', cfg: '{{cfg}}', sampler_name: 'euler_ancestral', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
  4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '{{checkpoint}}' } },
  5: { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}', batch_size: 1 } },
  6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}', clip: ['4', 1] } },
  7: { class_type: 'CLIPTextEncode', inputs: { text: '{{negative}}', clip: ['4', 1] } },
  8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  9: { class_type: 'SaveImage', inputs: { filename_prefix: 'kidsbook', images: ['8', 0] } },
};

const COMFY_SIZES = {
  '1:1': [1024, 1024], '2:3': [832, 1216], '3:2': [1216, 832], '3:4': [896, 1152], '4:3': [1152, 896], '9:16': [768, 1344], '16:9': [1344, 768],
};

function comfyBase(url) {
  return (url || 'http://127.0.0.1:8188').replace(/\/+$/, '');
}

const COMFY_HINT = url => `Couldn't reach ComfyUI at ${comfyBase(url)}. Is it running, and was it started with --enable-cors-header "*"?`;

export async function comfyCheckpoints(url) {
  const res = await apiFetch('ComfyUI', `${comfyBase(url)}/object_info/CheckpointLoaderSimple`, undefined, COMFY_HINT(url));
  if (!res.ok) throw new Error(`ComfyUI ${await readError(res)}`);
  const j = await res.json();
  return j.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
}

function fillPlaceholders(node, vars) {
  if (Array.isArray(node)) return node.map(n => fillPlaceholders(n, vars));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = fillPlaceholders(v, vars);
    return out;
  }
  if (typeof node === 'string') {
    const whole = node.match(/^\{\{(\w+)\}\}$/);
    if (whole && whole[1] in vars) return vars[whole[1]];
    return node.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  }
  return node;
}

async function comfyUpload(base, ref, i) {
  const ext = (ref.mimeType.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
  const fd = new FormData();
  fd.append('image', new Blob([b64ToBytes(ref.data)], { type: ref.mimeType }), `kidsbook_ref_${Date.now()}_${i}.${ext}`);
  fd.append('overwrite', 'true');
  const res = await fetch(`${base}/upload/image`, { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`ComfyUI upload ${await readError(res)}`);
  const j = await res.json();
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function comfyImage(cfg, { prompt, refs, aspect, seed }) {
  const base = comfyBase(cfg.url);
  let workflow = DEFAULT_COMFY_WORKFLOW;
  if (cfg.workflow && cfg.workflow.trim()) {
    try { workflow = JSON.parse(cfg.workflow); } catch (e) { throw new Error('ComfyUI workflow is not valid JSON (export it with "Save (API Format)").'); }
  }
  const raw = JSON.stringify(workflow);
  if (raw.includes('{{checkpoint}}') && !cfg.checkpoint) throw new Error('Pick a ComfyUI checkpoint in Kids Book → Settings.');
  const [width, height] = COMFY_SIZES[aspect] || COMFY_SIZES['1:1'];
  const vars = {
    prompt, negative: cfg.negative || '', seed: seed ?? Math.floor(Math.random() * 2 ** 31), width, height,
    checkpoint: cfg.checkpoint || '', steps: Number(cfg.steps) || 28, cfg: Number(cfg.cfg) || 6,
  };
  // Upload reference images if the workflow wants them: {{image1}}, {{image2}} ...
  const wanted = [...new Set([...raw.matchAll(/\{\{image(\d+)\}\}/g)].map(m => Number(m[1])))];
  for (const n of wanted) {
    const ref = refs[n - 1] || refs[0];
    if (!ref) throw new Error(`Workflow uses {{image${n}}} but no reference image is available for this generation.`);
    vars[`image${n}`] = await comfyUpload(base, ref, n);
  }
  const filled = fillPlaceholders(workflow, vars);
  const clientId = `kidsbook-${Math.random().toString(36).slice(2)}`;
  const res = await apiFetch('ComfyUI', `${base}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: filled, client_id: clientId }) }, COMFY_HINT(base));
  if (!res.ok) throw new Error(`ComfyUI ${await readError(res)}`);
  const { prompt_id: promptId, node_errors: nodeErrors } = await res.json();
  if (nodeErrors && Object.keys(nodeErrors).length) throw new Error(`ComfyUI node errors: ${JSON.stringify(nodeErrors).slice(0, 500)}`);
  const started = Date.now();
  while (Date.now() - started < 15 * 60 * 1000) {
    await sleep(1200);
    const h = await fetch(`${base}/history/${promptId}`);
    if (!h.ok) continue;
    const hist = (await h.json())[promptId];
    if (!hist) continue;
    if (hist.status?.status_str === 'error') throw new Error(`ComfyUI run failed: ${JSON.stringify(hist.status.messages || '').slice(0, 500)}`);
    const outputs = Object.values(hist.outputs || {});
    const imgs = outputs.flatMap(o => o.images || []);
    const pick = imgs.find(i => i.type === 'output') || imgs[0];
    if (pick) {
      const q = new URLSearchParams({ filename: pick.filename, subfolder: pick.subfolder || '', type: pick.type || 'output' });
      const r = await fetch(`${base}/view?${q}`);
      if (!r.ok) throw new Error(`ComfyUI view ${await readError(r)}`);
      const buf = new Uint8Array(await r.arrayBuffer());
      return { mimeType: r.headers.get('content-type') || 'image/png', data: bytesToB64(buf) };
    }
    if (hist.status?.completed) throw new Error('ComfyUI finished but produced no image output (does the workflow end in SaveImage?).');
  }
  throw new Error('ComfyUI timed out after 15 minutes');
}

// ---------- Placeholder ----------
const PALETTES = [['#ffd6a5', '#ff9b85'], ['#caffbf', '#7bdff2'], ['#bdb2ff', '#ffc6ff'], ['#fdffb6', '#ffadad'], ['#a0c4ff', '#b9fbc0']];

function escXml(s) {
  return String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

export function placeholderImage({ prompt, aspect }) {
  const [w, h] = COMFY_SIZES[aspect] || COMFY_SIZES['1:1'];
  let hash = 0;
  for (const ch of prompt) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const [a, b] = PALETTES[hash % PALETTES.length];
  const words = prompt.replace(/\s+/g, ' ').split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).length > 38) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
    if (lines.length >= 9) break;
  }
  if (line && lines.length < 10) lines.push(line);
  const text = lines.map((l, i) => `<text x="50%" y="${h / 2 - lines.length * 18 + i * 38}" text-anchor="middle" font-family="sans-serif" font-size="28" fill="#333" opacity="0.75">${escXml(l)}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${w * 0.78}" cy="${h * 0.2}" r="${Math.min(w, h) * 0.09}" fill="#fff" opacity="0.6"/><path d="M0 ${h * 0.82} Q ${w * 0.3} ${h * 0.7} ${w * 0.55} ${h * 0.8} T ${w} ${h * 0.76} V ${h} H 0 Z" fill="#fff" opacity="0.35"/>${text}</svg>`;
  return { mimeType: 'image/svg+xml', data: textToB64(svg) };
}

// ---------- entry point ----------
export async function generateImage(settings, { prompt, refs = [], aspect = '1:1', seed } = {}) {
  const s = { ...DEFAULT_IMAGE_SETTINGS, ...(settings || {}) };
  const provider = s.provider || 'gemini';
  if (provider === 'gemini') return geminiImage({ ...DEFAULT_IMAGE_SETTINGS.gemini, ...s.gemini }, { prompt, refs, aspect });
  if (provider === 'openai') return openaiImage({ ...DEFAULT_IMAGE_SETTINGS.openai, ...s.openai }, { prompt, refs, aspect });
  if (provider === 'comfy') return comfyImage({ ...DEFAULT_IMAGE_SETTINGS.comfy, ...s.comfy }, { prompt, refs, aspect, seed });
  if (provider === 'placeholder') return placeholderImage({ prompt, aspect });
  throw new Error(`Unknown image provider: ${provider}`);
}
