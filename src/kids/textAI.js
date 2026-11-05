// Text LLM calls with optional images (vision). Isomorphic.
// images: [{ mimeType, data(base64) }]
import { apiFetch, apiError, cleanKey } from './apiFetch.js';

export const TEXT_PROVIDERS = {
  anthropic: { label: 'Anthropic (Claude)', models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-sonnet-4-20250514'] },
  openai: { label: 'OpenAI', models: ['gpt-5', 'gpt-4.1', 'gpt-4o', 'gpt-4.1-mini'] },
  gemini: { label: 'Google Gemini', models: ['gemini-3.8-flash'] },
};

const VISION_OK = /image\/(png|jpe?g|gif|webp)/;

export async function callText({ provider, model, key: rawKey, system = '', prompt, images = [], maxTokens = 12000, json = false }) {
  const key = cleanKey(rawKey);
  model = String(model || '').trim();
  if (!key) throw new Error(`No ${TEXT_PROVIDERS[provider]?.label || provider} API key. Add one in Kids Book → Settings (or the main API bar).`);
  const imgs = images.filter(i => VISION_OK.test(i.mimeType));

  if (provider === 'anthropic') {
    const content = [
      ...imgs.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mimeType.replace('image/jpg', 'image/jpeg'), data: i.data } })),
      { type: 'text', text: prompt },
    ];
    const body = { model, max_tokens: maxTokens, messages: [{ role: 'user', content }] };
    if (system) body.system = system;
    const res = await apiFetch('Anthropic', 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await apiError('Anthropic', res, model);
    const data = await res.json();
    return data.content.filter(c => c.type === 'text').map(c => c.text).join('');
  }

  if (provider === 'openai') {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        ...imgs.map(i => ({ type: 'image_url', image_url: { url: `data:${i.mimeType};base64,${i.data}` } })),
      ],
    });
    const res = await apiFetch('OpenAI', 'https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, max_completion_tokens: maxTokens }),
    });
    if (!res.ok) throw await apiError('OpenAI', res, model);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }

  if (provider === 'gemini') {
    const parts = [{ text: prompt }, ...imgs.map(i => ({ inlineData: { mimeType: i.mimeType, data: i.data } }))];
    const body = { contents: [{ role: 'user', parts }], generationConfig: { maxOutputTokens: Math.max(maxTokens, 16000) } };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (json) body.generationConfig.responseMimeType = 'application/json';
    const res = await apiFetch('Gemini', `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await apiError('Gemini', res, model);
    const data = await res.json();
    return (data.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
  }

  throw new Error(`Unknown text provider ${provider}`);
}

// Pull a JSON object/array out of an LLM reply.
export function parseJSON(text) {
  const cleaned = String(text || '').replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(cleaned); } catch (e) { /* fall through */ }
  const firstObj = cleaned.indexOf('{');
  const firstArr = cleaned.indexOf('[');
  const start = firstArr !== -1 && (firstObj === -1 || firstArr < firstObj) ? firstArr : firstObj;
  if (start === -1) throw new Error('AI reply contained no JSON');
  const close = cleaned[start] === '[' ? ']' : '}';
  const end = cleaned.lastIndexOf(close);
  return JSON.parse(cleaned.slice(start, end + 1));
}
