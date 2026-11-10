// File-based storage shared by the MCP tools and the HTTP bridge.
// Layout:  <DATA_DIR>/books/<bookId>/book.json  +  images/<imageId>.<ext>
//          <DATA_DIR>/settings.json   <DATA_DIR>/active.json (last book opened on the website; display only)
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { newBook, normalizeBook, allImageIds, uid } from '../src/kids/model.js';
import { DEFAULT_IMAGE_SETTINGS } from '../src/kids/imageProviders.js';
import { normalizeNovel } from '../src/novelModel.js';

export const DATA_DIR = path.resolve(process.env.KIDSBOOK_DATA_DIR || path.join(os.homedir(), 'AIBookGenerator', 'kids-books'));
export const BOOKS_DIR = path.join(DATA_DIR, 'books');
export const NOVELS_DIR = path.join(DATA_DIR, 'novels');
fs.mkdirSync(BOOKS_DIR, { recursive: true });
fs.mkdirSync(NOVELS_DIR, { recursive: true });

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' };
const MIME = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));

export class ConflictError extends Error {
  constructor(current) { super('Book was changed by someone else'); this.current = current; this.status = 409; }
}

function safeId(id) {
  if (!id || !/^[\w-]{3,80}$/.test(id)) throw Object.assign(new Error(`Bad id: ${id}`), { status: 400 });
  return id;
}

const bookDir = id => path.join(BOOKS_DIR, safeId(id));
const bookFile = id => path.join(bookDir(id), 'book.json');
const imagesDir = id => path.join(bookDir(id), 'images');

async function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, data);
  for (let i = 0; i < 5; i++) {
    try { await fsp.rename(tmp, file); return; } catch (e) {
      if (i === 4) { await fsp.writeFile(file, data); await fsp.rm(tmp, { force: true }); return; }
      await new Promise(r => setTimeout(r, 40 * (i + 1)));
    }
  }
}

export async function bookExists(id) {
  try { await fsp.access(bookFile(id)); return true; } catch (e) { return false; }
}

export async function readBook(id) {
  let raw;
  try { raw = await fsp.readFile(bookFile(id), 'utf8'); } catch (e) {
    throw Object.assign(new Error(`No book with id ${id}`), { status: 404 });
  }
  return normalizeBook(JSON.parse(raw));
}

// One write at a time per book inside this process, so parallel chats / image jobs
// on the same book can't overwrite each other's changes.
const locks = new Map();
export function withBookLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  locks.set(id, tail);
  tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
  return run;
}

async function writeUnlocked(book, { writer, baseRev }) {
  const id = safeId(book.id);
  await fsp.mkdir(imagesDir(id), { recursive: true });
  let currentRev = 0;
  if (await bookExists(id)) {
    const current = await readBook(id);
    currentRev = current.rev || 0;
    if (baseRev !== null && baseRev !== undefined && Number(baseRev) < currentRev) throw new ConflictError(current);
  }
  const saved = normalizeBook({ ...book, id, rev: currentRev + 1, updatedAt: Date.now(), _writer: writer });
  await atomicWrite(bookFile(id), JSON.stringify(saved, null, 1));
  return saved;
}

// baseRev: if given and older than what's on disk -> ConflictError.
export function writeBook(book, { writer = 'unknown', baseRev = null } = {}) {
  return withBookLock(safeId(book.id), () => writeUnlocked(book, { writer, baseRev }));
}

// Read the latest copy of one book, change it, save it. Always targets the given id.
// Retries if another process (e.g. a second MCP server) saved in between.
export function updateBook(id, writer, fn) {
  return withBookLock(safeId(id), async () => {
    for (let attempt = 0; ; attempt++) {
      const book = await readBook(id);
      const next = await fn(book);
      try {
        return await writeUnlocked({ ...next, id }, { writer, baseRev: book.rev || 0 });
      } catch (e) {
        if (!(e instanceof ConflictError) || attempt >= 4) throw e;
      }
    }
  });
}

// Creating a book never changes which book anyone else is looking at.
export async function createBook(partial = {}, writer = 'unknown') {
  const { id: _ignored, rev: _r, ...rest } = partial || {};
  const book = newBook(rest);
  return writeBook({ ...book, id: uid('book') }, { writer });
}

export async function listBooks() {
  const active = await getActive();
  const out = [];
  for (const d of await fsp.readdir(BOOKS_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    try {
      const b = JSON.parse(await fsp.readFile(path.join(BOOKS_DIR, d.name, 'book.json'), 'utf8'));
      out.push({ id: b.id, title: b.title || '', premise: (b.premise || '').slice(0, 140), pageCount: b.pageCount, updatedAt: b.updatedAt, rev: b.rev, openOnWebsite: b.id === active });
    } catch (e) { /* skip broken */ }
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function getActive() {
  try { return JSON.parse(await fsp.readFile(path.join(DATA_DIR, 'active.json'), 'utf8')).bookId || null; } catch (e) { return null; }
}

export async function setActive(bookId) {
  await atomicWrite(path.join(DATA_DIR, 'active.json'), JSON.stringify({ bookId }));
}

export async function saveImage(bookId, buffer, mime = 'image/png') {
  const ext = EXT[mime] || 'png';
  const id = uid('img');
  await fsp.mkdir(imagesDir(bookId), { recursive: true });
  await fsp.writeFile(path.join(imagesDir(bookId), `${id}.${ext}`), buffer);
  return id;
}

export async function imagePath(bookId, imgId) {
  safeId(imgId);
  for (const ext of Object.values(EXT)) {
    const p = path.join(imagesDir(bookId), `${imgId}.${ext}`);
    try { await fsp.access(p); return { path: p, mime: MIME[ext] }; } catch (e) { /* next */ }
  }
  throw Object.assign(new Error(`No image ${imgId}`), { status: 404 });
}

export async function readImage(bookId, imgId) {
  const { path: p, mime } = await imagePath(bookId, imgId);
  return { buffer: await fsp.readFile(p), mime };
}

export async function gcImages(bookId) {
  const book = await readBook(bookId);
  const keep = new Set(allImageIds(book));
  let removed = 0;
  for (const f of await fsp.readdir(imagesDir(bookId)).catch(() => [])) {
    const id = f.replace(/\.[^.]+$/, '');
    if (!keep.has(id)) { await fsp.rm(path.join(imagesDir(bookId), f), { force: true }); removed++; }
  }
  return removed;
}

// ---- novels (adult books): <DATA_DIR>/novels/<novelId>/novel.json = { id, rev, project, outline, chapters } ----
const novelFile = id => path.join(NOVELS_DIR, safeId(id), 'novel.json');

export async function readNovel(id) {
  let raw;
  try { raw = await fsp.readFile(novelFile(id), 'utf8'); } catch (e) {
    throw Object.assign(new Error(`No novel with id ${id}`), { status: 404 });
  }
  return normalizeNovel(JSON.parse(raw));
}

async function writeNovelUnlocked(novel, { writer, baseRev }) {
  const id = safeId(novel.id);
  await fsp.mkdir(path.dirname(novelFile(id)), { recursive: true });
  let currentRev = 0;
  try {
    const current = await readNovel(id);
    currentRev = current.rev || 0;
    if (baseRev !== null && baseRev !== undefined && Number(baseRev) < currentRev) throw new ConflictError(current);
  } catch (e) { if (e instanceof ConflictError) throw e; }
  const n = normalizeNovel(novel);
  const saved = { id, rev: currentRev + 1, updatedAt: Date.now(), _writer: writer, project: n.project, outline: n.outline, chapters: n.chapters };
  await atomicWrite(novelFile(id), JSON.stringify(saved, null, 1));
  return saved;
}

export function writeNovel(novel, { writer = 'unknown', baseRev = null } = {}) {
  return withBookLock(`novel:${safeId(novel.id)}`, () => writeNovelUnlocked(novel, { writer, baseRev }));
}

export function updateNovel(id, writer, fn) {
  return withBookLock(`novel:${safeId(id)}`, async () => {
    for (let attempt = 0; ; attempt++) {
      const novel = await readNovel(id);
      const next = await fn(novel);
      try {
        return await writeNovelUnlocked({ ...next, id }, { writer, baseRev: novel.rev || 0 });
      } catch (e) {
        if (!(e instanceof ConflictError) || attempt >= 4) throw e;
      }
    }
  });
}

export async function createNovel(data = {}, writer = 'unknown') {
  const { project, outline, chapters } = data || {};
  return writeNovel({ id: uid('novel'), project, outline, chapters }, { writer });
}

export async function listNovels() {
  const out = [];
  for (const d of await fsp.readdir(NOVELS_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    try {
      const n = normalizeNovel(JSON.parse(await fsp.readFile(path.join(NOVELS_DIR, d.name, 'novel.json'), 'utf8')));
      out.push({
        id: n.id,
        title: n.project.title || '',
        synopsis: (n.project.synopsis || '').slice(0, 140),
        chapters: n.outline.length,
        chaptersWritten: n.outline.filter((_, i) => n.chapters[i]?.text).length,
        updatedAt: n.updatedAt,
        rev: n.rev,
      });
    } catch (e) { /* skip broken */ }
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// ---- settings (image generator config for MCP-side generation) ----
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

export async function readSettings() {
  try { return JSON.parse(await fsp.readFile(SETTINGS_FILE, 'utf8')); } catch (e) { return {}; }
}

export async function writeSettings(patch) {
  const cur = await readSettings();
  const next = {
    ...cur,
    ...patch,
    image: {
      ...(cur.image || {}),
      ...(patch.image || {}),
      gemini: { ...(cur.image?.gemini || {}), ...(patch.image?.gemini || {}) },
      openai: { ...(cur.image?.openai || {}), ...(patch.image?.openai || {}) },
      comfy: { ...(cur.image?.comfy || {}), ...(patch.image?.comfy || {}) },
    },
  };
  await atomicWrite(SETTINGS_FILE, JSON.stringify(next, null, 1));
  return next;
}

// Effective image settings: the book's own choices (provider/model, never keys),
// then settings.json, then environment variables.
export async function imageSettings(book = null) {
  const s = (await readSettings()).image || {};
  const o = (book && book.imageOverride) || {};
  const d = DEFAULT_IMAGE_SETTINGS;
  return {
    provider: o.provider || process.env.KIDSBOOK_IMAGE_PROVIDER || s.provider || (process.env.COMFY_URL ? 'comfy' : d.provider),
    gemini: { ...d.gemini, ...(s.gemini || {}), ...(o.gemini || {}), key: s.gemini?.key || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '' },
    openai: { ...d.openai, ...(s.openai || {}), ...(o.openai || {}), key: s.openai?.key || process.env.OPENAI_API_KEY || '' },
    comfy: { ...d.comfy, ...(s.comfy || {}), ...(o.comfy || {}), url: o.comfy?.url || s.comfy?.url || process.env.COMFY_URL || d.comfy.url },
  };
}

export function redactSettings(s) {
  const img = s.image || {};
  return {
    ...s,
    image: {
      ...img,
      gemini: { ...(img.gemini || {}), key: img.gemini?.key ? '••••' : '' },
      openai: { ...(img.openai || {}), key: img.openai?.key ? '••••' : '' },
    },
  };
}
