#!/usr/bin/env node
// Kids Book Studio — MCP server + local HTTP bridge.
//
//   node mcp/server.mjs              stdio MCP (Claude Desktop launches this) + HTTP bridge on 127.0.0.1:7801 if the port is free
//   node mcp/server.mjs --http-only  HTTP bridge + Streamable HTTP MCP at /mcp (for the web page, ChatGPT via a tunnel)
//
// Env: KIDSBOOK_DATA_DIR, KIDSBOOK_PORT (7801), KIDSBOOK_MCP_TOKEN, KIDSBOOK_ALLOWED_ORIGINS,
//      GEMINI_API_KEY, OPENAI_API_KEY, COMFY_URL, KIDSBOOK_IMAGE_PROVIDER
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { Jimp } from 'jimp';

import {
  PAGE_COUNTS, AGE_RANGES, STORY_LAYOUTS, COVER_LAYOUTS, BACK_COVER_LAYOUTS, MATTER_TYPES, CAST_KINDS, PAPER,
  newCastMember, newMatter, newPage, applyStory, storyPages, computePlan, imposition, findCast, bookSummary, normalizeBook, safeName,
} from '../src/kids/model.js';
import { writingGuide, sheetPrompt, pagePrompt, pageRefs, coverPrompt, coverRefs, matterImagePrompt } from '../src/kids/prompts.js';
import { generateImage, IMAGE_PROVIDERS } from '../src/kids/imageProviders.js';
import { renderBookHTML, printInstructions } from '../src/kids/layout.js';
import { KID_FONTS } from '../src/kids/fonts.js';
import {
  DATA_DIR, BOOKS_DIR, ConflictError, readBook, writeBook, createBook, listBooks, getActive, setActive,
  saveImage, readImage, imagePath, gcImages, readSettings, writeSettings, imageSettings, redactSettings,
} from './store.mjs';

const VERSION = '1.0.0';
const SERVER_PATH = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const HTTP_ONLY = args.includes('--http-only');
const NO_HTTP = args.includes('--no-http');
const PORT = Number(process.env.KIDSBOOK_PORT || (args.find(a => a.startsWith('--port=')) || '').split('=')[1] || 7801);
const TOKEN = process.env.KIDSBOOK_MCP_TOKEN || '';
const ALLOWED_ORIGINS = [
  'https://theaibookgenerator.com',
  'https://www.theaibookgenerator.com',
  ...(process.env.KIDSBOOK_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
];
const log = (...a) => console.error('[kids-book]', ...a); // stdout belongs to the stdio protocol

// ===================================================================== MCP tools

const INSTRUCTIONS = `Kids Book Studio (theaibookgenerator.com) — make illustrated children's books that print as a folded booklet on letter paper.
Typical flow:
1. list_books, then open_book or create_book (choose pageCount: a multiple of 4; 16 or 24 are typical).
2. Cast: upsert_cast_member for each character / prop / environment with a precise visual description. If the user has pictures on disk, add_reference_image.
3. generate_cast_sheet for each cast member (model sheets keep characters consistent). Image generation uses the user's configured generator (ComfyUI is free/local; Gemini/OpenAI cost money) — check get_image_settings and confirm before generating lots of images.
4. get_writing_brief, then YOU write the story and save it with write_story using exactly the number of story pages the brief gives.
5. generate_cover and generate_page_illustration (one page per call, or generate_missing_illustrations in small batches). Use view_image to check results.
6. set_design (fonts, colors), set_back_cover (blurb), set_matter_pages (title page, dedication, about the author...).
7. get_print_plan and export_print_file. The user can watch and edit everything live on theaibookgenerator.com → Kids Book tab (Settings → MCP bridge).`;

const ok = obj => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = msg => ({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true });
const wrap = fn => async a => { try { return await fn(a || {}); } catch (e) { log(e.message || e); return fail(e.message || String(e)); } };

async function resolveBookId(bookId) {
  const id = bookId || await getActive();
  if (!id) throw new Error('No book is open. Use list_books, then open_book or create_book.');
  return id;
}

async function mutate(bookId, writer, fn) {
  const id = await resolveBookId(bookId);
  const book = await readBook(id);
  const next = await fn(book);
  return writeBook(next, { writer });
}

async function thumb(buffer, mime, max = 768) {
  try {
    const im = await Jimp.read(buffer);
    im.scaleToFit({ w: max, h: max });
    const out = await im.getBuffer('image/jpeg', { quality: 82 });
    return { type: 'image', data: out.toString('base64'), mimeType: 'image/jpeg' };
  } catch (e) {
    if (mime !== 'image/svg+xml' && buffer.length < 700000) return { type: 'image', data: buffer.toString('base64'), mimeType: mime };
    return { type: 'text', text: `(preview unavailable for ${mime})` };
  }
}

async function generateFor(book, { prompt, refs = [], aspect = '1:1' }) {
  const settings = await imageSettings();
  const refImgs = [];
  for (const r of refs) {
    try {
      const { buffer, mime } = await readImage(book.id, r.id);
      refImgs.push({ mimeType: mime, data: buffer.toString('base64'), label: r.label });
    } catch (e) { /* skip missing refs */ }
  }
  const out = await generateImage(settings, { prompt, refs: refImgs, aspect });
  const buffer = Buffer.from(out.data, 'base64');
  const id = await saveImage(book.id, buffer, out.mimeType);
  return { id, buffer, mime: out.mimeType, provider: settings.provider };
}

function storyPageAt(book, n) {
  const flat = storyPages(book);
  const s = flat[n - 1];
  if (!s) throw new Error(`There is no story page ${n}; the story has ${flat.length} pages.`);
  return s;
}

function mapPage(book, pageId, fn) {
  return { ...book, chapters: book.chapters.map(ch => ({ ...ch, pages: ch.pages.map(p => (p.id === pageId ? fn(p) : p)) })) };
}

function storyOverview(book) {
  const plan = computePlan(book);
  const phys = {};
  plan.pages.forEach(p => { if (p.kind === 'story') phys[p.page.id] = p.n; });
  return {
    ...bookSummary(book),
    subtitle: book.subtitle,
    illustrator: book.illustrator,
    premise: book.premise,
    lesson: book.lesson,
    tone: book.tone,
    artStyle: book.artStyle,
    wordsPerPage: book.wordsPerPage,
    chapterCount: book.chapterCount,
    cast: book.cast.map(c => ({ name: c.name, kind: c.kind, description: c.description, referenceImages: c.refs.length, sheets: c.sheets.length, activeSheet: c.activeSheet })),
    chapters: book.chapters.map((ch, ci) => ({
      chapter: ci + 1,
      title: ch.title,
      summary: ch.summary,
      pages: ch.pages.map(p => ({
        storyPage: storyPages(book).findIndex(s => s.page.id === p.id) + 1,
        printedPage: phys[p.id] || null,
        text: p.text,
        illustration: p.illustration,
        cast: p.cast,
        layout: p.layout,
        imageId: p.imageId,
      })),
    })),
    cover: { layout: book.cover.layout, imageId: book.cover.imageId, scene: book.cover.prompt },
    backCover: { blurb: book.backCover.blurb, tagline: book.backCover.tagline, layout: book.backCover.layout },
    frontMatter: book.frontMatter.map(m => ({ type: m.type, title: m.title, text: m.text, imageId: m.imageId })),
    backMatter: book.backMatter.map(m => ({ type: m.type, title: m.title, text: m.text, imageId: m.imageId })),
    design: book.design,
    webApp: 'https://theaibookgenerator.com → Kids Book tab → Settings → MCP bridge',
  };
}

const pageSchema = z.object({
  text: z.string().describe('Words printed on the page'),
  illustration: z.string().describe('Detailed visual description of the picture for this page'),
  cast: z.array(z.string()).optional().describe('Exact names of cast members visible on the page'),
  layout: z.enum(Object.keys(STORY_LAYOUTS)).optional(),
});

function buildServer(transportName) {
  const writer = `mcp-${transportName}`;
  const server = new McpServer({ name: 'kids-book-studio', version: VERSION }, { instructions: INSTRUCTIONS });
  const tool = (name, description, inputSchema, fn, annotations) => server.registerTool(name, { description, inputSchema, annotations }, wrap(fn));
  const bookIdArg = { bookId: z.string().optional().describe('Defaults to the currently open book') };

  tool('list_books', 'List kids books stored on this computer and which one is open.', {}, async () => {
    const books = await listBooks();
    return ok({ dataDir: DATA_DIR, books, hint: books.length ? 'open_book to switch, create_book to start a new one.' : 'No books yet — create_book.' });
  }, { readOnlyHint: true });

  tool('create_book', 'Create a new kids book and make it the open book.', {
    title: z.string().optional(),
    premise: z.string().optional().describe('What the story is about'),
    author: z.string().optional(),
    ageRange: z.enum(AGE_RANGES).optional(),
    pageCount: z.number().int().optional().describe(`Total printed pages including covers. One of ${PAGE_COUNTS.join(', ')}`),
    chapterMode: z.enum(['single', 'chapters']).optional(),
    chapterCount: z.number().int().min(2).max(12).optional(),
    artStyle: z.string().optional(),
    lesson: z.string().optional(),
    tone: z.string().optional(),
  }, async a => {
    const partial = Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined));
    if (partial.pageCount && !PAGE_COUNTS.includes(partial.pageCount)) partial.pageCount = Math.max(8, Math.ceil(partial.pageCount / 4) * 4);
    const book = await createBook(partial, writer);
    return ok({ created: bookSummary(book), next: 'Add cast with upsert_cast_member, then get_writing_brief → write_story.' });
  });

  tool('open_book', 'Switch the open book.', { bookId: z.string() }, async ({ bookId }) => {
    const b = await readBook(bookId);
    await setActive(b.id);
    return ok(bookSummary(b));
  });

  tool('get_book', 'Get the open book: details, cast, every page (text, illustration notes, layout, image ids), design and warnings.', { ...bookIdArg }, async ({ bookId }) => {
    const b = await readBook(await resolveBookId(bookId));
    return ok(storyOverview(b));
  }, { readOnlyHint: true });

  tool('update_book_details', 'Change title, author, premise, age range, art style, page count, structure, etc.', {
    ...bookIdArg,
    title: z.string().optional(), subtitle: z.string().optional(), author: z.string().optional(), illustrator: z.string().optional(),
    ageRange: z.enum(AGE_RANGES).optional(), premise: z.string().optional(), lesson: z.string().optional(), tone: z.string().optional(),
    artStyle: z.string().optional().describe('Style description sent with every image prompt'),
    pageCount: z.number().int().optional().describe(`One of ${PAGE_COUNTS.join(', ')}`),
    paper: z.enum(Object.keys(PAPER)).optional(),
    chapterMode: z.enum(['single', 'chapters']).optional(), chapterCount: z.number().int().min(2).max(12).optional(),
    wordsPerPageMin: z.number().int().optional(), wordsPerPageMax: z.number().int().optional(),
  }, async ({ bookId, wordsPerPageMin, wordsPerPageMax, ...rest }) => {
    const saved = await mutate(bookId, writer, b => {
      const patch = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
      if (patch.pageCount && !PAGE_COUNTS.includes(patch.pageCount)) patch.pageCount = Math.max(8, Math.ceil(patch.pageCount / 4) * 4);
      const wpp = [wordsPerPageMin ?? b.wordsPerPage[0], wordsPerPageMax ?? b.wordsPerPage[1]];
      return { ...b, ...patch, wordsPerPage: wpp };
    });
    return ok(bookSummary(saved));
  });

  tool('get_writing_brief', 'Get the exact brief for writing the story (page budget, word counts, cast, JSON shape). Read this before write_story.', { ...bookIdArg }, async ({ bookId }) => {
    const b = await readBook(await resolveBookId(bookId));
    return ok(writingGuide(b));
  }, { readOnlyHint: true });

  tool('write_story', 'Save a story you wrote. Replaces all pages (or one chapter if chapterIndex is given). Each page needs text, illustration notes, cast names and a layout.', {
    ...bookIdArg,
    title: z.string().optional(),
    blurb: z.string().optional().describe('Back-cover blurb'),
    chapterIndex: z.number().int().min(1).optional().describe('1-based. Replace only this chapter'),
    chapters: z.array(z.object({
      title: z.string().optional(),
      summary: z.string().optional(),
      pages: z.array(pageSchema),
    })).min(1),
  }, async ({ bookId, title, blurb, chapterIndex, chapters }) => {
    const saved = await mutate(bookId, writer, b => {
      let next = applyStory(b, { title, blurb, chapters }, { chapterIdx: chapterIndex ? chapterIndex - 1 : null });
      if (title) next = { ...next, title };
      if (blurb) next = { ...next, backCover: { ...next.backCover, blurb } };
      if (chapters.length > 1 && next.chapterMode !== 'chapters') next = { ...next, chapterMode: 'chapters', chapterCount: chapters.length };
      return next;
    });
    const plan = computePlan(saved);
    return ok({ saved: bookSummary(saved), warnings: plan.warnings, next: 'generate_cover / generate_page_illustration, or tweak pages with update_page.' });
  });

  tool('update_page', 'Edit one story page (1-based story page number, not the printed page number).', {
    ...bookIdArg,
    storyPage: z.number().int().min(1),
    text: z.string().optional(), illustration: z.string().optional(),
    cast: z.array(z.string()).optional(), layout: z.enum(Object.keys(STORY_LAYOUTS)).optional(),
  }, async ({ bookId, storyPage, ...patch }) => {
    let result;
    await mutate(bookId, writer, b => {
      const s = storyPageAt(b, storyPage);
      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      result = { ...s.page, ...clean };
      return mapPage(b, s.page.id, p => ({ ...p, ...clean }));
    });
    return ok({ storyPage, page: { text: result.text, illustration: result.illustration, cast: result.cast, layout: result.layout } });
  });

  tool('insert_or_delete_page', 'Insert a blank story page after a story page (0 = at the start), or delete a story page.', {
    ...bookIdArg,
    action: z.enum(['insert', 'delete']),
    storyPage: z.number().int().min(0),
  }, async ({ bookId, action, storyPage }) => {
    const saved = await mutate(bookId, writer, b => {
      const flat = storyPages(b);
      if (action === 'delete') {
        const s = storyPageAt(b, storyPage);
        return { ...b, chapters: b.chapters.map((ch, ci) => (ci === s.chapterIdx ? { ...ch, pages: ch.pages.filter(p => p.id !== s.page.id) } : ch)) };
      }
      const anchor = storyPage === 0 ? { chapterIdx: 0, pageIdx: -1 } : flat[storyPage - 1];
      if (!anchor) throw new Error(`No story page ${storyPage}`);
      return {
        ...b,
        chapters: b.chapters.map((ch, ci) => (ci === anchor.chapterIdx
          ? { ...ch, pages: [...ch.pages.slice(0, anchor.pageIdx + 1), newPage(), ...ch.pages.slice(anchor.pageIdx + 1)] }
          : ch)),
      };
    });
    return ok({ ...bookSummary(saved), warnings: computePlan(saved).warnings });
  });

  tool('upsert_cast_member', 'Add or update a character, prop or environment (matched by name).', {
    ...bookIdArg,
    name: z.string(),
    kind: z.enum(Object.keys(CAST_KINDS)).optional(),
    description: z.string().optional().describe('Precise visual description: colors, shapes, clothing, size, markings'),
    sheetNotes: z.string().optional().describe('Extra notes used when generating its sheet'),
    rename: z.string().optional(),
  }, async ({ bookId, name, kind, description, sheetNotes, rename }) => {
    let member;
    await mutate(bookId, writer, b => {
      const existing = b.cast.find(c => c.name.trim().toLowerCase() === name.trim().toLowerCase());
      if (existing) {
        member = { ...existing, ...(kind ? { kind } : {}), ...(description !== undefined ? { description } : {}), ...(sheetNotes !== undefined ? { sheetNotes } : {}), ...(rename ? { name: rename } : {}) };
        return { ...b, cast: b.cast.map(c => (c.id === existing.id ? member : c)) };
      }
      member = newCastMember(kind || 'character', { name: rename || name, description: description || '', sheetNotes: sheetNotes || '' });
      return { ...b, cast: [...b.cast, member] };
    });
    return ok({ cast: { name: member.name, kind: member.kind, description: member.description, sheets: member.sheets.length, refs: member.refs.length } });
  });

  tool('remove_cast_member', 'Remove a cast member by name.', { ...bookIdArg, name: z.string() }, async ({ bookId, name }) => {
    await mutate(bookId, writer, b => ({ ...b, cast: b.cast.filter(c => c.name.trim().toLowerCase() !== name.trim().toLowerCase()) }));
    return ok(`Removed ${name}.`);
  });

  tool('add_reference_image', 'Attach an image file from this computer (or a URL) as a reference for a cast member, as an art-style reference, or as the author photo.', {
    ...bookIdArg,
    target: z.enum(['cast', 'style', 'author-photo']),
    castName: z.string().optional().describe('Required when target is "cast"'),
    path: z.string().optional().describe('Absolute path to a png/jpg/webp file'),
    url: z.string().optional(),
  }, async ({ bookId, target, castName, path: p, url }) => {
    let buffer;
    let mime;
    if (p) {
      buffer = await fsp.readFile(p);
      const ext = path.extname(p).toLowerCase();
      mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
    } else if (url) {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Download failed ${r.status}`);
      buffer = Buffer.from(await r.arrayBuffer());
      mime = r.headers.get('content-type') || 'image/png';
    } else throw new Error('Give a path or a url.');
    const id0 = await resolveBookId(bookId);
    const imgId = await saveImage(id0, buffer, mime);
    await mutate(id0, writer, b => {
      if (target === 'style') return { ...b, styleRefs: [...b.styleRefs, imgId] };
      if (target === 'author-photo') {
        const i = b.backMatter.findIndex(m => m.type === 'about-author');
        if (i === -1) return { ...b, backMatter: [...b.backMatter, newMatter('about-author', { imageId: imgId })] };
        return { ...b, backMatter: b.backMatter.map((m, k) => (k === i ? { ...m, imageId: imgId } : m)) };
      }
      const m = findCast(b, castName);
      if (!m) throw new Error(`No cast member named ${castName}. Add it with upsert_cast_member first.`);
      return { ...b, cast: b.cast.map(c => (c.id === m.id ? { ...c, refs: [...c.refs, imgId] } : c)) };
    });
    return { content: [{ type: 'text', text: `Saved as ${imgId}.` }, await thumb(buffer, mime, 512)] };
  });

  tool('get_image_settings', 'Show which image generator the MCP server will use (keys are hidden).', {}, async () => {
    const s = await imageSettings();
    return ok({
      provider: s.provider,
      providers: Object.keys(IMAGE_PROVIDERS),
      gemini: { model: s.gemini.model, hasKey: !!s.gemini.key },
      openai: { model: s.openai.model, quality: s.openai.quality, hasKey: !!s.openai.key },
      comfy: { url: s.comfy.url, checkpoint: s.comfy.checkpoint, customWorkflow: !!s.comfy.workflow },
      note: 'Keys come from the web page (Settings → "Send image-generator settings") or GEMINI_API_KEY / OPENAI_API_KEY env vars. ComfyUI is free and local; "placeholder" makes free test images.',
    });
  }, { readOnlyHint: true });

  tool('set_image_settings', 'Choose the image generator (no API keys here — set those on the web page or in env vars).', {
    provider: z.enum(Object.keys(IMAGE_PROVIDERS)).optional(),
    geminiModel: z.string().optional(), openaiModel: z.string().optional(), openaiQuality: z.enum(['low', 'medium', 'high', 'auto']).optional(),
    comfyUrl: z.string().optional(), comfyCheckpoint: z.string().optional(),
  }, async a => {
    const patch = { image: {} };
    if (a.provider) patch.image.provider = a.provider;
    if (a.geminiModel) patch.image.gemini = { model: a.geminiModel };
    if (a.openaiModel || a.openaiQuality) patch.image.openai = { ...(a.openaiModel ? { model: a.openaiModel } : {}), ...(a.openaiQuality ? { quality: a.openaiQuality } : {}) };
    if (a.comfyUrl || a.comfyCheckpoint) patch.image.comfy = { ...(a.comfyUrl ? { url: a.comfyUrl } : {}), ...(a.comfyCheckpoint ? { checkpoint: a.comfyCheckpoint } : {}) };
    await writeSettings(patch);
    const s = await imageSettings();
    return ok({ provider: s.provider });
  });

  tool('generate_cast_sheet', 'Generate a model/turnaround sheet for a cast member with the configured image generator (uses its reference images). Costs money unless the generator is ComfyUI or placeholder.', {
    ...bookIdArg,
    name: z.string(),
    extraNotes: z.string().optional(),
    preview: z.boolean().optional().describe('Return a small preview image (default true)'),
  }, async ({ bookId, name, extraNotes, preview = true }) => {
    const b = await readBook(await resolveBookId(bookId));
    const m = findCast(b, name);
    if (!m) throw new Error(`No cast member named ${name}.`);
    const member = extraNotes ? { ...m, sheetNotes: [m.sheetNotes, extraNotes].filter(Boolean).join(' ') } : m;
    const refs = [...m.refs.map(id => ({ id, label: `${m.name} — original reference` })), ...b.styleRefs.slice(0, 1).map(id => ({ id, label: 'art style reference' }))];
    const g = await generateFor(b, { prompt: sheetPrompt(b, member, m.refs.length > 0), refs, aspect: m.kind === 'environment' ? '16:9' : '3:2' });
    await mutate(b.id, writer, bk => ({ ...bk, cast: bk.cast.map(c => (c.id === m.id ? { ...c, sheets: [...c.sheets, g.id], activeSheet: g.id } : c)) }));
    const content = [{ type: 'text', text: `Sheet for ${m.name} saved as ${g.id} (via ${g.provider}). It's now the reference used for page illustrations.` }];
    if (preview) content.push(await thumb(g.buffer, g.mime, 640));
    return { content };
  });

  tool('generate_page_illustration', 'Illustrate one story page (1-based story page number) using its illustration notes and the cast sheets as references.', {
    ...bookIdArg,
    storyPage: z.number().int().min(1),
    extraDirection: z.string().optional(),
    preview: z.boolean().optional(),
  }, async ({ bookId, storyPage, extraDirection, preview = true }) => {
    const b = await readBook(await resolveBookId(bookId));
    const s = storyPageAt(b, storyPage);
    const plan = computePlan(b);
    const n = plan.pages.find(p => p.kind === 'story' && p.page.id === s.page.id)?.n;
    const g = await generateFor(b, { prompt: pagePrompt(b, s.page, { pageNumber: n, extra: extraDirection || '' }), refs: pageRefs(b, s.page), aspect: STORY_LAYOUTS[s.page.layout]?.aspect || '1:1' });
    await mutate(b.id, writer, bk => mapPage(bk, s.page.id, p => ({ ...p, imageId: g.id, altImages: [...(p.altImages || []), g.id] })));
    const content = [{ type: 'text', text: `Story page ${storyPage} (printed page ${n || '—'}) illustrated: ${g.id} via ${g.provider}.` }];
    if (preview) content.push(await thumb(g.buffer, g.mime, 512));
    return { content };
  });

  tool('generate_cover', 'Generate the front-cover illustration.', {
    ...bookIdArg,
    scene: z.string().optional().describe('What the cover should show (saved for next time)'),
    extraDirection: z.string().optional(),
    preview: z.boolean().optional(),
  }, async ({ bookId, scene, extraDirection, preview = true }) => {
    let b = await readBook(await resolveBookId(bookId));
    if (scene) b = await writeBook({ ...b, cover: { ...b.cover, prompt: scene } }, { writer });
    const aspect = b.cover.layout === 'framed' ? '1:1' : b.cover.layout === 'classic' ? '4:3' : '2:3';
    const g = await generateFor(b, { prompt: coverPrompt(b, extraDirection || ''), refs: coverRefs(b), aspect });
    await mutate(b.id, writer, bk => ({ ...bk, cover: { ...bk.cover, imageId: g.id, altImages: [...(bk.cover.altImages || []), g.id] } }));
    const content = [{ type: 'text', text: `Cover saved: ${g.id} via ${g.provider}.` }];
    if (preview) content.push(await thumb(g.buffer, g.mime, 512));
    return { content };
  });

  tool('generate_missing_illustrations', 'Illustrate story pages that have no picture yet, a few at a time (keeps each call short). Call again until none remain.', {
    ...bookIdArg,
    limit: z.number().int().min(1).max(6).optional().describe('Pages to do in this call (default 3)'),
    includeCover: z.boolean().optional(),
  }, async ({ bookId, limit = 3, includeCover = true }) => {
    const id = await resolveBookId(bookId);
    let b = await readBook(id);
    const done = [];
    if (includeCover && !b.cover.imageId && limit > 0) {
      const g = await generateFor(b, { prompt: coverPrompt(b), refs: coverRefs(b), aspect: b.cover.layout === 'framed' ? '1:1' : b.cover.layout === 'classic' ? '4:3' : '2:3' });
      b = await mutate(id, writer, bk => ({ ...bk, cover: { ...bk.cover, imageId: g.id, altImages: [...(bk.cover.altImages || []), g.id] } }));
      done.push('cover');
    }
    const plan = computePlan(b);
    const todo = plan.pages.filter(p => p.kind === 'story' && !p.page.imageId && p.page.layout !== 'text-only').slice(0, Math.max(0, limit - done.length));
    for (const p of todo) {
      const g = await generateFor(b, { prompt: pagePrompt(b, p.page, { pageNumber: p.n }), refs: pageRefs(b, p.page), aspect: STORY_LAYOUTS[p.page.layout]?.aspect || '1:1' });
      b = await mutate(id, writer, bk => mapPage(bk, p.page.id, pg => ({ ...pg, imageId: g.id, altImages: [...(pg.altImages || []), g.id] })));
      done.push(`printed page ${p.n}`);
    }
    const remaining = computePlan(b).pages.filter(p => p.kind === 'story' && !p.page.imageId && p.page.layout !== 'text-only').length + (b.cover.imageId ? 0 : 1);
    return ok({ illustrated: done, remaining });
  });

  tool('generate_matter_image', 'Generate a picture for a front/back matter page (title page spot, "The End" vignette, full-page image).', {
    ...bookIdArg,
    which: z.enum(['front', 'back']),
    index: z.number().int().min(1).describe('1-based position in that list'),
  }, async ({ bookId, which, index }) => {
    const b = await readBook(await resolveBookId(bookId));
    const key = which === 'front' ? 'frontMatter' : 'backMatter';
    const m = b[key][index - 1];
    if (!m) throw new Error(`No ${which} matter page ${index}`);
    const g = await generateFor(b, { prompt: matterImagePrompt(b, m), refs: coverRefs(b), aspect: m.type === 'image' ? '2:3' : '1:1' });
    await mutate(b.id, writer, bk => ({ ...bk, [key]: bk[key].map((x, i) => (i === index - 1 ? { ...x, imageId: g.id } : x)) }));
    return { content: [{ type: 'text', text: `Saved ${g.id}.` }, await thumb(g.buffer, g.mime, 400)] };
  });

  tool('view_image', 'Look at an image: by id, a story page\'s current picture, a cast member\'s active sheet, or the cover.', {
    ...bookIdArg,
    imageId: z.string().optional(), storyPage: z.number().int().min(1).optional(), castName: z.string().optional(), cover: z.boolean().optional(),
    size: z.number().int().min(256).max(1568).optional(),
  }, async ({ bookId, imageId, storyPage, castName, cover, size = 896 }) => {
    const b = await readBook(await resolveBookId(bookId));
    let id = imageId;
    if (!id && storyPage) id = storyPageAt(b, storyPage).page.imageId;
    if (!id && castName) { const m = findCast(b, castName); id = m && (m.activeSheet || m.sheets.slice(-1)[0] || m.refs[0]); }
    if (!id && cover) id = b.cover.imageId;
    if (!id) throw new Error('No image found for that request.');
    const { buffer, mime } = await readImage(b.id, id);
    return { content: [await thumb(buffer, mime, size), { type: 'text', text: id }] };
  }, { readOnlyHint: true });

  tool('set_design', `Fonts, colors and layout. Fonts available: ${KID_FONTS.map(f => f.name).join(', ')}.`, {
    ...bookIdArg,
    titleFont: z.string().optional(), bodyFont: z.string().optional(),
    bodySize: z.number().min(10).max(32).optional().describe('Story text size in pt'), lineHeight: z.number().min(1).max(2.2).optional(),
    align: z.enum(['left', 'center']).optional(),
    textColor: z.string().optional(), accentColor: z.string().optional(), pageBg: z.string().optional(),
    safeMargin: z.number().min(0.15).max(1).optional().describe('inches'), bleed: z.boolean().optional(), pageNumbers: z.boolean().optional(),
    overlayBox: z.enum(['soft', 'solid', 'none']).optional(),
    coverLayout: z.enum(Object.keys(COVER_LAYOUTS)).optional(), coverTitleColor: z.string().optional(), coverTitleOutline: z.string().optional(), coverBgColor: z.string().optional(),
    backCoverLayout: z.enum(Object.keys(BACK_COVER_LAYOUTS)).optional(), backCoverBgColor: z.string().optional(),
  }, async ({ bookId, coverLayout, coverTitleColor, coverTitleOutline, coverBgColor, backCoverLayout, backCoverBgColor, ...design }) => {
    const known = new Set(KID_FONTS.map(f => f.name));
    for (const f of [design.titleFont, design.bodyFont]) if (f && !known.has(f)) throw new Error(`Unknown font ${f}. Choose from: ${[...known].join(', ')}`);
    const saved = await mutate(bookId, writer, b => {
      const d = Object.fromEntries(Object.entries(design).filter(([, v]) => v !== undefined));
      const cover = { ...b.cover };
      if (coverLayout) cover.layout = coverLayout;
      if (coverTitleColor) cover.titleColor = coverTitleColor;
      if (coverTitleOutline !== undefined) cover.titleStroke = coverTitleOutline;
      if (coverBgColor) cover.bgColor = coverBgColor;
      const backCover = { ...b.backCover };
      if (backCoverLayout) backCover.layout = backCoverLayout;
      if (backCoverBgColor) backCover.bgColor = backCoverBgColor;
      return { ...b, design: { ...b.design, ...d }, cover, backCover };
    });
    return ok({ design: saved.design, cover: { layout: saved.cover.layout }, backCover: { layout: saved.backCover.layout } });
  });

  tool('set_back_cover', 'Set the back-cover blurb, tagline and options.', {
    ...bookIdArg,
    blurb: z.string().optional(), tagline: z.string().optional(), showAge: z.boolean().optional(), showBarcodeBox: z.boolean().optional(),
  }, async ({ bookId, ...patch }) => {
    const saved = await mutate(bookId, writer, b => ({ ...b, backCover: { ...b.backCover, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } }));
    return ok(saved.backCover);
  });

  tool('set_matter_pages', `Replace the front pages (after the cover) and/or back pages (before the back cover). Types: ${Object.entries(MATTER_TYPES).map(([k, v]) => `${k} (${v})`).join(', ')}. Every page here takes a story slot, so check get_print_plan after.`, {
    ...bookIdArg,
    front: z.array(z.object({ type: z.enum(Object.keys(MATTER_TYPES)), title: z.string().optional(), text: z.string().optional() })).optional(),
    back: z.array(z.object({ type: z.enum(Object.keys(MATTER_TYPES)), title: z.string().optional(), text: z.string().optional() })).optional(),
  }, async ({ bookId, front, back }) => {
    const keepImg = (old, list) => list.map((m, i) => newMatter(m.type, { ...Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined)), imageId: old[i] && old[i].type === m.type ? old[i].imageId : null }));
    const saved = await mutate(bookId, writer, b => ({
      ...b,
      ...(front ? { frontMatter: keepImg(b.frontMatter, front) } : {}),
      ...(back ? { backMatter: keepImg(b.backMatter, back) } : {}),
    }));
    const plan = computePlan(saved);
    return ok({ storySlots: plan.slots, storyPagesWritten: plan.storyCount, warnings: plan.warnings });
  });

  tool('get_print_plan', 'What prints on every page, the duplex sheet order for the folded booklet, and printing instructions.', { ...bookIdArg }, async ({ bookId }) => {
    const b = await readBook(await resolveBookId(bookId));
    const plan = computePlan(b);
    const label = p => (p.kind === 'story' ? `story ${p.storyIndex + 1}${p.page.imageId ? '' : ' (no picture yet)'}` : p.kind === 'front' || p.kind === 'back' ? `${p.kind} matter: ${p.matter.type}` : p.kind);
    return ok({
      pages: plan.pages.map(p => `${p.n}: ${label(p)}`),
      sheets: imposition(b.pageCount).map(s => ({ sheet: s.sheet, front: `${s.front[0]} | ${s.front[1]}`, back: `${s.back[0]} | ${s.back[1]}` })),
      warnings: plan.warnings,
      instructions: printInstructions(b),
      printUrl: `http://127.0.0.1:${PORT}/print/${b.id}`,
    });
  }, { readOnlyHint: true });

  tool('export_print_file', 'Write a standalone, print-ready HTML booklet (images embedded). Open it in Chrome and print two-sided, flip on short edge, or Save as PDF.', {
    ...bookIdArg,
    outputPath: z.string().optional().describe('Where to write the .html (default: the book folder)'),
    sides: z.enum(['both', 'fronts', 'backs']).optional(),
  }, async ({ bookId, outputPath, sides = 'both' }) => {
    const b = await readBook(await resolveBookId(bookId));
    const urls = {};
    for (const id of new Set(storyPages(b).map(s => s.page.imageId).concat([b.cover.imageId, b.backCover.imageId], b.frontMatter.map(m => m.imageId), b.backMatter.map(m => m.imageId)).filter(Boolean))) {
      try { const { buffer, mime } = await readImage(b.id, id); urls[id] = `data:${mime};base64,${buffer.toString('base64')}`; } catch (e) { /* missing */ }
    }
    const html = renderBookHTML(b, { mode: 'imposed', sides, imageUrl: id => urls[id], title: `${b.title} — print booklet` });
    const out = outputPath || path.join(BOOKS_DIR, b.id, `${safeName(b.title)}-booklet${sides === 'both' ? '' : `-${sides}`}.html`);
    await fsp.writeFile(out, html);
    return ok({ file: out, alsoAt: `http://127.0.0.1:${PORT}/print/${b.id}`, instructions: printInstructions(b) });
  });

  return server;
}

// ===================================================================== HTTP bridge

const sseClients = new Set();
function broadcast(ev) {
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of sseClients) res.write(line);
}

function isLocalHost(hostHeader) {
  const h = String(hostHeader || '').replace(/:\d+$/, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
}

function originAllowed(origin) {
  if (!origin || origin === 'null') return !origin;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const u = new URL(origin);
    return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || u.hostname.endsWith('.localhost');
  } catch (e) { return false; }
}

function cors(req, res) {
  const origin = req.headers.origin;
  // Always vary on Origin: an <img> load (no Origin) must not be reused from cache for a CORS fetch.
  res.setHeader('Vary', 'Origin');
  if (origin && originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Kidsbook-Client, Authorization, Mcp-Session-Id, Mcp-Protocol-Version');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    if (req.headers['access-control-request-private-network']) res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
}

function send(res, status, body, type = 'application/json') {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readBody(req, limit = 60 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleMcp(req, res) {
  const raw = await readBody(req, 5 * 1024 * 1024);
  let body;
  try { body = raw.length ? JSON.parse(raw.toString('utf8')) : undefined; } catch (e) { return send(res, 400, { error: 'Invalid JSON' }); }
  const server = buildServer('http');
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

async function route(req, res) {
  cors(req, res);
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.headers.origin && !originAllowed(req.headers.origin)) return send(res, 403, { error: `Origin ${req.headers.origin} not allowed. Add it to KIDSBOOK_ALLOWED_ORIGINS.` });

  // ---- MCP over Streamable HTTP ----
  const mcp = p.match(/^\/mcp(?:\/([^/]+))?\/?$/);
  if (mcp) {
    const given = mcp[1] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (TOKEN && given !== TOKEN) return send(res, 401, { error: 'Missing or wrong token' });
    if (!TOKEN && !isLocalHost(req.headers.host)) return send(res, 403, { error: 'Remote MCP access needs KIDSBOOK_MCP_TOKEN to be set.' });
    if (req.method !== 'POST') return send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: POST only)' }, id: null });
    return handleMcp(req, res);
  }

  // Everything else is for the local web page only (DNS-rebinding guard).
  if (!isLocalHost(req.headers.host)) return send(res, 403, { error: 'Bridge API is only available on localhost' });

  if (p === '/' || p === '/api/health') {
    const books = await listBooks();
    return send(res, 200, { ok: true, name: 'kids-book-studio', version: VERSION, dataDir: DATA_DIR, serverPath: SERVER_PATH, books: books.length, mcp: `http://127.0.0.1:${PORT}/mcp` });
  }

  if (p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'hello', version: VERSION })}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    return undefined;
  }

  if (p === '/api/books' && req.method === 'GET') return send(res, 200, await listBooks());
  if (p === '/api/books' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    return send(res, 201, await createBook(body, req.headers['x-kidsbook-client'] || 'web'));
  }
  if (p === '/api/active' && req.method === 'PUT') {
    const { bookId } = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    await readBook(bookId);
    await setActive(bookId);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/settings') {
    if (req.method === 'GET') return send(res, 200, redactSettings(await readSettings()));
    if (req.method === 'PUT') {
      const patch = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      return send(res, 200, redactSettings(await writeSettings(patch)));
    }
  }

  let m = p.match(/^\/api\/books\/([\w-]+)$/);
  if (m) {
    if (req.method === 'GET') return send(res, 200, await readBook(m[1]));
    if (req.method === 'PUT') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      try {
        const saved = await writeBook({ ...body, id: m[1] }, { writer: req.headers['x-kidsbook-client'] || 'web', baseRev: body.rev ?? null });
        return send(res, 200, saved);
      } catch (e) {
        if (e instanceof ConflictError) return send(res, 409, e.current);
        throw e;
      }
    }
  }
  m = p.match(/^\/api\/books\/([\w-]+)\/images$/);
  if (m && req.method === 'POST') {
    await readBook(m[1]);
    const buf = await readBody(req);
    const id = await saveImage(m[1], buf, (req.headers['content-type'] || 'image/png').split(';')[0]);
    return send(res, 201, { id });
  }
  m = p.match(/^\/api\/books\/([\w-]+)\/images\/([\w-]+)$/);
  if (m && req.method === 'GET') {
    const { path: file, mime } = await imagePath(m[1], m[2]);
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000, immutable' });
    return fs.createReadStream(file).pipe(res);
  }
  m = p.match(/^\/api\/books\/([\w-]+)\/gc$/);
  if (m && req.method === 'POST') return send(res, 200, { removed: await gcImages(m[1]) });

  m = p.match(/^\/(print|preview)\/([\w-]+)$/);
  if (m && req.method === 'GET') {
    const b = await readBook(m[2]);
    const html = renderBookHTML(b, {
      mode: m[1] === 'print' ? 'imposed' : 'reader',
      sides: url.searchParams.get('sides') || 'both',
      zoom: m[1] === 'print' ? 0.6 : 0.7,
      imageUrl: id => `/api/books/${b.id}/images/${id}`,
    });
    return send(res, 200, html, 'text/html; charset=utf-8');
  }

  return send(res, 404, { error: 'Not found' });
}

function watchBooks() {
  const timers = new Map();
  const changed = id => {
    clearTimeout(timers.get(id));
    timers.set(id, setTimeout(async () => {
      try {
        const raw = JSON.parse(await fsp.readFile(path.join(BOOKS_DIR, id, 'book.json'), 'utf8'));
        broadcast({ type: 'book', bookId: id, rev: raw.rev, writer: raw._writer || '' });
      } catch (e) { /* mid-write */ }
    }, 120));
  };
  try {
    fs.watch(BOOKS_DIR, { recursive: true }, (evt, filename) => {
      if (!filename) return;
      const parts = String(filename).split(/[\\/]/);
      if (parts.length === 2 && parts[1] === 'book.json') changed(parts[0]);
    });
  } catch (e) {
    log('fs.watch unavailable, polling instead');
    const revs = new Map();
    setInterval(async () => {
      for (const b of await listBooks()) {
        if (revs.has(b.id) && revs.get(b.id) !== b.rev) changed(b.id);
        revs.set(b.id, b.rev);
      }
    }, 1500);
  }
}

function startHttp() {
  return new Promise(resolve => {
    const httpServer = http.createServer((req, res) => {
      route(req, res).catch(e => {
        log(e.message);
        if (!res.headersSent) send(res, e.status || 500, { error: e.message });
        else res.end();
      });
    });
    httpServer.on('error', e => {
      if (e.code === 'EADDRINUSE') {
        log(`Port ${PORT} is busy — another bridge is already running; this process will only serve stdio MCP.`);
        resolve(false);
      } else {
        log('HTTP error', e);
        resolve(false);
      }
    });
    httpServer.listen(PORT, process.env.KIDSBOOK_HOST || '127.0.0.1', () => {
      log(`Bridge on http://127.0.0.1:${PORT}  (data: ${DATA_DIR})${TOKEN ? '  MCP token required' : ''}`);
      watchBooks();
      resolve(true);
    });
  });
}

async function main() {
  if (!NO_HTTP) {
    const started = await startHttp();
    if (HTTP_ONLY && !started) process.exit(1);
  }
  if (!HTTP_ONLY) {
    const server = buildServer('stdio');
    await server.connect(new StdioServerTransport());
    log('MCP stdio ready');
  } else {
    log(`MCP over HTTP at http://127.0.0.1:${PORT}/mcp${TOKEN ? '/<token>' : ''}`);
  }
}

main().catch(e => { log(e); process.exit(1); });
