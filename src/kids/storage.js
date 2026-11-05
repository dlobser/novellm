// Browser storage for kids books.
// - LocalStore: book JSON in localStorage, images (big) in IndexedDB.
// - BridgeStore: everything lives on the local MCP bridge server (shared with Claude / ChatGPT desktop).
import { bytesToB64, b64ToBytes } from './imageProviders.js';
import { uid, normalizeBook, allImageIds } from './model.js';

const DB_NAME = 'kidsbook';
const IMG_STORE = 'images';
const BOOK_KEY = 'kids_book';

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IMG_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function idb(mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const tx = d.transaction(IMG_STORE, mode);
    const req = fn(tx.objectStore(IMG_STORE));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export async function blobToB64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  return { mimeType: blob.type || 'image/png', data: bytesToB64(buf) };
}

export function b64ToBlob({ mimeType, data }) {
  return new Blob([b64ToBytes(data)], { type: mimeType });
}

// Downscale big uploads and convert odd formats so every provider accepts them.
export async function normalizeUpload(file, maxSide = 2048) {
  if (file.type === 'image/svg+xml') return file;
  const url = URL.createObjectURL(file);
  try {
    const im = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error(`Could not read image ${file.name}`));
      i.src = url;
    });
    const okType = /image\/(png|jpeg|webp)/.test(file.type);
    const scale = Math.min(1, maxSide / Math.max(im.naturalWidth, im.naturalHeight));
    if (okType && scale === 1) return file;
    const c = document.createElement('canvas');
    c.width = Math.round(im.naturalWidth * scale);
    c.height = Math.round(im.naturalHeight * scale);
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    return await new Promise(r => c.toBlob(r, type, 0.92));
  } finally {
    URL.revokeObjectURL(url);
  }
}

const urlCache = new Map();

export class LocalStore {
  constructor() { this.kind = 'local'; }

  label() { return 'This browser'; }

  async loadBook() {
    try {
      const raw = localStorage.getItem(BOOK_KEY);
      if (raw) return normalizeBook(JSON.parse(raw));
    } catch (e) { /* ignore */ }
    return null;
  }

  async saveBook(book) {
    localStorage.setItem(BOOK_KEY, JSON.stringify(book));
    return book;
  }

  async putImage(blob) {
    const id = uid('img');
    await idb('readwrite', s => s.put(blob, id));
    return id;
  }

  async getBlob(id) {
    return idb('readonly', s => s.get(id));
  }

  async url(id) {
    if (!id) return null;
    if (urlCache.has(id)) return urlCache.get(id);
    const blob = await this.getBlob(id);
    if (!blob) return null;
    const u = URL.createObjectURL(blob);
    urlCache.set(id, u);
    return u;
  }

  syncUrl(id) { return urlCache.get(id) || null; }

  async base64(id) {
    const blob = await this.getBlob(id);
    if (!blob) throw new Error(`Image ${id} is missing`);
    return blobToB64(blob);
  }

  async deleteImage(id) {
    urlCache.delete(id);
    await idb('readwrite', s => s.delete(id));
  }

  // Remove images no longer referenced by the book.
  async gc(book) {
    const keep = new Set(allImageIds(book));
    const keys = await idb('readonly', s => s.getAllKeys());
    for (const k of keys || []) if (!keep.has(k)) await this.deleteImage(k);
  }
}

// ---------------- MCP bridge (local Node server) ----------------
export class BridgeStore {
  constructor(baseUrl, bookId) {
    this.kind = 'bridge';
    this.base = baseUrl.replace(/\/+$/, '');
    this.bookId = bookId;
  }

  label() { return `MCP bridge (${this.base})`; }

  async req(path, opts = {}) {
    const res = await fetch(`${this.base}${path}`, opts);
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      const err = new Error(`Bridge ${res.status}: ${t.slice(0, 300)}`);
      err.status = res.status;
      err.body = t;
      throw err;
    }
    return res;
  }

  async loadBook() {
    const r = await this.req(`/api/books/${this.bookId}`);
    return normalizeBook(await r.json());
  }

  // Returns the saved book (with server rev). Throws status 409 on conflict.
  async saveBook(book) {
    const r = await this.req(`/api/books/${this.bookId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Kidsbook-Client': this.clientId || '' },
      body: JSON.stringify(book),
    });
    return normalizeBook(await r.json());
  }

  async putImage(blob) {
    const r = await this.req(`/api/books/${this.bookId}/images`, {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
    });
    return (await r.json()).id;
  }

  async url(id) { return this.syncUrl(id); }

  syncUrl(id) { return id ? `${this.base}/api/books/${this.bookId}/images/${id}` : null; }

  async base64(id) {
    return blobToB64(await this.getBlob(id));
  }

  async getBlob(id) {
    // no-store: an earlier <img> load may have cached this response without CORS headers.
    const r = await this.req(`/api/books/${this.bookId}/images/${id}`, { cache: 'no-store' });
    return r.blob();
  }

  async deleteImage() { /* the bridge garbage-collects on demand */ }

  async gc() { await this.req(`/api/books/${this.bookId}/gc`, { method: 'POST' }); }
}

export const bridgeApi = {
  async health(base) {
    const r = await fetch(`${base.replace(/\/+$/, '')}/api/health`);
    if (!r.ok) throw new Error(`Bridge responded ${r.status}`);
    return r.json();
  },
  async listBooks(base) {
    const r = await fetch(`${base.replace(/\/+$/, '')}/api/books`);
    if (!r.ok) throw new Error(`Bridge responded ${r.status}`);
    return r.json();
  },
  async createBook(base, book) {
    const r = await fetch(`${base.replace(/\/+$/, '')}/api/books`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(book) });
    if (!r.ok) throw new Error(`Bridge responded ${r.status}: ${await r.text()}`);
    return normalizeBook(await r.json());
  },
  async setActive(base, bookId) {
    await fetch(`${base.replace(/\/+$/, '')}/api/active`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bookId }) });
  },
  async putSettings(base, settings) {
    const r = await fetch(`${base.replace(/\/+$/, '')}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
    if (!r.ok) throw new Error(`Bridge responded ${r.status}`);
  },
  events(base, onEvent) {
    const es = new EventSource(`${base.replace(/\/+$/, '')}/api/events`);
    es.onmessage = e => { try { onEvent(JSON.parse(e.data)); } catch (err) { /* ignore */ } };
    return es;
  },
};

// Copy a book and all its images from one store to another (local <-> bridge, export/import).
export async function copyBookImages(book, from, to, onProgress) {
  const ids = allImageIds(book);
  const map = {};
  let i = 0;
  for (const id of ids) {
    try {
      const blob = await from.getBlob(id);
      if (blob) map[id] = await to.putImage(blob);
    } catch (e) { /* skip missing */ }
    onProgress?.(++i, ids.length);
  }
  return remapImageIds(book, map);
}

export function remapImageIds(book, map) {
  const m = id => (id && map[id]) || id;
  return {
    ...book,
    styleRefs: (book.styleRefs || []).map(m),
    cast: book.cast.map(c => ({ ...c, refs: c.refs.map(m), sheets: c.sheets.map(m), activeSheet: m(c.activeSheet) })),
    chapters: book.chapters.map(ch => ({ ...ch, pages: ch.pages.map(p => ({ ...p, imageId: m(p.imageId), altImages: (p.altImages || []).map(m) })) })),
    frontMatter: book.frontMatter.map(x => ({ ...x, imageId: m(x.imageId) })),
    backMatter: book.backMatter.map(x => ({ ...x, imageId: m(x.imageId) })),
    cover: { ...book.cover, imageId: m(book.cover.imageId), altImages: (book.cover.altImages || []).map(m) },
    backCover: { ...book.backCover, imageId: m(book.backCover.imageId) },
  };
}

// Export JSON with embedded images (portable file).
export async function exportBookFile(book, store) {
  const images = {};
  for (const id of allImageIds(book)) {
    try { images[id] = await store.base64(id); } catch (e) { /* skip */ }
  }
  return JSON.stringify({ kind: 'kidsbook', version: 1, book, images });
}

export async function importBookFile(text, store) {
  const data = JSON.parse(text);
  const book = normalizeBook(data.book || data);
  const map = {};
  for (const [id, img] of Object.entries(data.images || {})) {
    map[id] = await store.putImage(b64ToBlob(img));
  }
  return remapImageIds(book, map);
}
