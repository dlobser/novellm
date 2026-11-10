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
  newCastMember, newMatter, newPage, applyStory, storyPages, computePlan, pageAspect, isSplit, imposition, findCast, bookSummary, normalizeBook, safeName,
} from '../src/kids/model.js';
import { writingGuide, sheetPrompt, sheetRefs, pagePrompt, pageRefs, coverPrompt, coverRefs, matterImagePrompt } from '../src/kids/prompts.js';
import { generateImage, IMAGE_PROVIDERS } from '../src/kids/imageProviders.js';
import { renderBookHTML, printInstructions } from '../src/kids/layout.js';
import { KID_FONTS } from '../src/kids/fonts.js';
import {
  outlineBrief, chapterBrief, chapterStatus, novelSummary, saveChapterText, insertChapterAt, removeChapterAt, manuscript, wordCount,
} from '../src/novelModel.js';
import {
  DATA_DIR, BOOKS_DIR, NOVELS_DIR, ConflictError, readBook, writeBook, updateBook, createBook, listBooks, setActive,
  readNovel, writeNovel, updateNovel, createNovel, listNovels,
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

const INSTRUCTIONS = `The AI Book Generator (theaibookgenerator.com) — two kinds of book, each with its own tools:
- NOVELS (adult books, written chapter by chapter): list_novels / create_novel, get_novel, update_novel_details, set_background_item, get_outline_brief → save_outline, then for each chapter get_chapter_brief → write_chapter (with a continuity summary). Optional: get_chapter_brief purpose=review → save_chapter_feedback, then purpose=revise → write_chapter. export_novel writes the manuscript. Every novel tool needs an explicit novelId.
  YOU write the outline and the prose. Write chapters in order so each brief has the story so far.
- KIDS BOOKS (illustrated picture books, the tools below with bookId).

Kids books — make illustrated children's books that print as a folded booklet on letter paper.
Several chats can work on different books at the same time. Every book tool needs an explicit bookId; there is no "current book".
If the user gave you a book ID, use only that one. Never edit a book you weren't asked to work on.
Typical flow:
1. list_books to find the user's book, or create_book (choose pageCount: a multiple of 4; 16 or 24 are typical). Note the bookId it returns and pass it to every call.
2. Cast: upsert_cast_member for each character / prop / environment with a precise visual description. If the user has pictures on disk, add_reference_image.
3. generate_cast_sheet for each cast member (model sheets keep characters consistent). Image generation uses the configured generator (ComfyUI is free/local; Gemini/OpenAI cost money) — check get_image_settings and confirm before generating lots of images.
4. get_writing_brief, then YOU write the story and save it with write_story using exactly the number of story pages the brief gives.
5. generate_cover and generate_page_illustration (one page per call, or generate_missing_illustrations in small batches). Use view_image to check results.
6. set_design (fonts, colors), set_back_cover (blurb), set_matter_pages (title page, dedication, about the author...).
7. get_print_plan and export_print_file. The user can watch and edit live on theaibookgenerator.com → Kids Book tab (Settings → MCP bridge → Open).`;

const ok = obj => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = msg => ({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true });
const wrap = fn => async a => { try { return await fn(a || {}); } catch (e) { log(e.message || e); return fail(e.message || String(e)); } };

// Book tools never fall back to "whatever book is open": several chats may be working at once.
async function resolveBookId(bookId) {
  if (!bookId) throw new Error('bookId is required. Use list_books (or create_book) to get the id of the book you were asked to work on, and pass it on every call.');
  return bookId;
}

async function mutate(bookId, writer, fn) {
  return updateBook(await resolveBookId(bookId), writer, fn);
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
  const settings = await imageSettings(book);
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
  const nums = plan.pageNumbers;
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
        printedPages: nums[p.id] ? (nums[p.id].first === nums[p.id].last ? String(nums[p.id].first) : `${nums[p.id].first}-${nums[p.id].last}`) : null,
        separatePages: isSplit(book, p),
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
  const bookIdArg = { bookId: z.string().describe('Id of the book to work on (from list_books or create_book). Required — always the same book you were asked to work on.') };

  tool('import_book_image', 'Import an already generated local illustration into one specific book.', {
    ...bookIdArg, path: z.string(), target: z.enum(['cast', 'cover', 'page']),
    castName: z.string().optional(), storyPage: z.number().int().min(1).optional(),
  }, async ({bookId, path: file, target, castName, storyPage}) => {
    const b = await readBook(bookId);
    if (target === 'cast' && !findCast(b, castName)) throw new Error('Unknown cast member');
    if (target === 'page') storyPageAt(b, storyPage);
    const buffer = await fsp.readFile(file);
    const id = await saveImage(bookId, buffer, 'image/png');
    await mutate(bookId, writer, bk => {
      if (target === 'cast') return {...bk, cast: bk.cast.map(m => m.name === castName ? {...m, sheets: [...m.sheets, id], activeSheet: id} : m)};
      if (target === 'cover') return {...bk, cover: {...bk.cover, imageId: id, altImages: [...bk.cover.altImages, id]}};
      const p = storyPageAt(bk, storyPage);
      return mapPage(bk, p.page.id, pg => ({...pg, imageId: id, altImages: [...(pg.altImages || []), id]}));
    });
    return ok({bookId, target, imageId: id});
  });

  tool('list_books', 'List kids books stored on this computer with their ids.', {}, async () => {
    const books = await listBooks();
    return ok({ dataDir: DATA_DIR, books, hint: books.length ? 'Pass the bookId of the book you are working on to every other tool. create_book starts a new one.' : 'No books yet — create_book.' });
  }, { readOnlyHint: true });

  tool('create_book', 'Create a new kids book. Returns its bookId — pass that id to every later call. Does not change what anyone else is working on.', {
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
    return ok({ bookId: book.id, created: bookSummary(book), next: `Use bookId "${book.id}" on every call. Add cast with upsert_cast_member, then get_writing_brief → write_story.` });
  });

  tool('get_book', 'Get a book: details, cast, every page (text, illustration notes, layout, image ids), design and warnings.', { ...bookIdArg }, async ({ bookId }) => {
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
    pages: z.enum(['book-setting', 'together', 'separate']).optional().describe('Picture and words on one page, or a picture page facing a words page'),
  }, async ({ bookId, storyPage, pages, ...patch }) => {
    if (pages) patch.split = pages === 'separate' ? true : pages === 'together' ? false : null;
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

  tool('get_image_settings', 'Show which image generator will be used (keys are hidden). With bookId, shows the settings for that book, including its own overrides.', {
    bookId: z.string().optional(),
  }, async ({ bookId }) => {
    const book = bookId ? await readBook(bookId) : null;
    const s = await imageSettings(book);
    return ok({
      ...(book ? { bookId: book.id, bookOverride: book.imageOverride || null } : {}),
      provider: s.provider,
      providers: Object.keys(IMAGE_PROVIDERS),
      gemini: { model: s.gemini.model, hasKey: !!s.gemini.key },
      openai: { model: s.openai.model, quality: s.openai.quality, hasKey: !!s.openai.key },
      comfy: { url: s.comfy.url, checkpoint: s.comfy.checkpoint, customWorkflow: !!s.comfy.workflow },
      note: 'Keys come from the web page (Settings → "Send image-generator settings") or GEMINI_API_KEY / OPENAI_API_KEY env vars. ComfyUI is free and local; "placeholder" makes free test images.',
    });
  }, { readOnlyHint: true });

  tool('set_image_settings', 'Choose the image generator for ONE book (pass bookId; other books are unaffected). Without bookId it changes the default for every book, which affects other chats — only do that if the user asks. No API keys here.', {
    bookId: z.string().optional().describe('Book to change. Leave out only to change the default for all books.'),
    provider: z.enum(Object.keys(IMAGE_PROVIDERS)).optional(),
    geminiModel: z.string().optional(), openaiModel: z.string().optional(), openaiQuality: z.enum(['low', 'medium', 'high', 'auto']).optional(),
    comfyUrl: z.string().optional(), comfyCheckpoint: z.string().optional(),
    clearBookOverride: z.boolean().optional().describe('With bookId: go back to the default settings for this book'),
  }, async ({ bookId, clearBookOverride, ...a }) => {
    const patch = {};
    if (a.provider) patch.provider = a.provider;
    if (a.geminiModel) patch.gemini = { model: a.geminiModel };
    if (a.openaiModel || a.openaiQuality) patch.openai = { ...(a.openaiModel ? { model: a.openaiModel } : {}), ...(a.openaiQuality ? { quality: a.openaiQuality } : {}) };
    if (a.comfyUrl || a.comfyCheckpoint) patch.comfy = { ...(a.comfyUrl ? { url: a.comfyUrl } : {}), ...(a.comfyCheckpoint ? { checkpoint: a.comfyCheckpoint } : {}) };
    if (bookId) {
      const saved = await mutate(bookId, writer, b => {
        if (clearBookOverride) return { ...b, imageOverride: null };
        const o = b.imageOverride || {};
        return {
          ...b,
          imageOverride: {
            ...o, ...patch,
            gemini: { ...(o.gemini || {}), ...(patch.gemini || {}) },
            openai: { ...(o.openai || {}), ...(patch.openai || {}) },
            comfy: { ...(o.comfy || {}), ...(patch.comfy || {}) },
          },
        };
      });
      const s = await imageSettings(saved);
      return ok({ bookId: saved.id, provider: s.provider, bookOverride: saved.imageOverride });
    }
    await writeSettings({ image: patch });
    const s = await imageSettings();
    return ok({ defaultProvider: s.provider, note: 'Changed the default for all books (books with their own setting keep it).' });
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
    const refs = sheetRefs(b, m);
    const g = await generateFor(b, { prompt: sheetPrompt(b, member, { hasRefs: m.refs.length > 0, hasStyleRef: refs.some(r => r.role === 'style') }), refs, aspect: m.kind === 'environment' ? '16:9' : '3:2' });
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
    const n = plan.pageNumbers[s.page.id]?.picture;
    const g = await generateFor(b, { prompt: pagePrompt(b, s.page, { pageNumber: n, extra: extraDirection || '' }), refs: pageRefs(b, s.page), aspect: pageAspect(b, s.page) });
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
    const id = await resolveBookId(bookId);
    let b = await readBook(id);
    if (scene) b = await mutate(id, writer, bk => ({ ...bk, cover: { ...bk.cover, prompt: scene } }));
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
    const needsPic = p => p.kind === 'story' && p.part !== 'words' && !p.page.imageId && (p.page.layout !== 'text-only' || p.part === 'picture');
    const todo = plan.pages.filter(needsPic).slice(0, Math.max(0, limit - done.length));
    for (const p of todo) {
      const g = await generateFor(b, { prompt: pagePrompt(b, p.page, { pageNumber: p.n }), refs: pageRefs(b, p.page), aspect: pageAspect(b, p.page) });
      b = await mutate(id, writer, bk => mapPage(bk, p.page.id, pg => ({ ...pg, imageId: g.id, altImages: [...(pg.altImages || []), g.id] })));
      done.push(`printed page ${p.n}`);
    }
    const remaining = computePlan(b).pages.filter(needsPic).length + (b.cover.imageId ? 0 : 1);
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
    pageMode: z.enum(['together', 'split']).optional().describe('together = picture and words on one page; split = picture page facing a words page (uses 2 printed pages per story page)'),
    splitOrder: z.enum(['words-first', 'picture-first']).optional().describe('For split pages: words on the left (words-first) or picture on the left'),
    coverTitleSize: z.number().min(12).max(140).optional().describe('pt'),
    coverTitleY: z.number().min(4).max(96).optional().describe('Vertical centre of the title, % of page height'),
    coverTitleWidth: z.number().min(30).max(100).optional().describe('% of the page width inside the margins'),
    coverTitleAlign: z.enum(['left', 'center', 'right']).optional(),
    coverTitleLineHeight: z.number().min(0.7).max(2).optional(),
    coverTitleOutlineWidth: z.number().min(0).max(0.2).optional().describe('em; 0 = no outline'),
    coverTitleShadow: z.boolean().optional().describe('Soft drop shadow under the cover title (off by default)'),
    coverSubtitleSize: z.number().min(6).max(80).optional().describe('pt'),
    coverBylineSize: z.number().min(6).max(48).optional().describe('pt'),
    coverBylinePosition: z.enum(['bottom', 'under-title', 'top']).optional(),
  }, async ({ bookId, coverLayout, coverTitleColor, coverTitleOutline, coverBgColor, backCoverLayout, backCoverBgColor,
    coverTitleSize, coverTitleY, coverTitleWidth, coverTitleAlign, coverTitleLineHeight, coverTitleOutlineWidth, coverTitleShadow, coverSubtitleSize, coverBylineSize, coverBylinePosition, ...design }) => {
    const known = new Set(KID_FONTS.map(f => f.name));
    for (const f of [design.titleFont, design.bodyFont]) if (f && !known.has(f)) throw new Error(`Unknown font ${f}. Choose from: ${[...known].join(', ')}`);
    const saved = await mutate(bookId, writer, b => {
      const d = Object.fromEntries(Object.entries(design).filter(([, v]) => v !== undefined));
      const cover = { ...b.cover };
      if (coverLayout) cover.layout = coverLayout;
      if (coverTitleColor) cover.titleColor = coverTitleColor;
      if (coverTitleOutline !== undefined) cover.titleStroke = coverTitleOutline;
      if (coverBgColor) cover.bgColor = coverBgColor;
      const ct = { titleSize: coverTitleSize, titleY: coverTitleY, titleWidth: coverTitleWidth, titleAlign: coverTitleAlign, titleLineHeight: coverTitleLineHeight,
        titleStrokeWidth: coverTitleOutlineWidth, titleShadow: coverTitleShadow, subtitleSize: coverSubtitleSize, bylineSize: coverBylineSize, bylinePos: coverBylinePosition };
      Object.entries(ct).forEach(([k, v]) => { if (v !== undefined) cover[k] = v; });
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
    return ok({ storyPagesFit: plan.capacity, printedStoryPages: plan.slots, storyPagesWritten: plan.storyCount, warnings: plan.warnings });
  });

  tool('get_print_plan', 'What prints on every page, the duplex sheet order for the folded booklet, and printing instructions.', { ...bookIdArg }, async ({ bookId }) => {
    const b = await readBook(await resolveBookId(bookId));
    const plan = computePlan(b);
    const label = p => (p.kind === 'story' ? `story ${p.storyIndex + 1}${p.part ? ` ${p.part}` : ''}${p.page.imageId || p.part === 'words' ? '' : ' (no picture yet)'}` : p.kind === 'front' || p.kind === 'back' ? `${p.kind} matter: ${p.matter.type}` : p.kind);
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

  // ================================================================ novels (adult books)
  const novelIdArg = { novelId: z.string().describe('Id of the novel to work on (from list_novels or create_novel). Required — always the same novel you were asked to work on.') };
  const needNovel = id => {
    if (!id) throw new Error('novelId is required. Use list_novels (or create_novel) to get the id of the novel you were asked to work on, and pass it on every call.');
    return id;
  };
  const changeNovel = (novelId, fn) => updateNovel(needNovel(novelId), writer, fn);
  const chIdx = (novel, chapter) => {
    if (!novel.outline[chapter - 1]) throw new Error(`There is no chapter ${chapter}; the outline has ${novel.outline.length} chapters.`);
    return chapter - 1;
  };
  const bgChapters = v => (v === undefined || v === 'all' || (Array.isArray(v) && !v.length) ? 'all' : v.map(n => n - 1));

  tool('list_novels', 'List the novels (adult books, chapter by chapter) stored on this computer with their ids.', {}, async () => {
    const novels = await listNovels();
    return ok({ novels, hint: novels.length ? 'Pass the novelId of the novel you are working on to every other novel tool. create_novel starts a new one.' : 'No novels yet — create_novel.' });
  }, { readOnlyHint: true });

  tool('create_novel', 'Create a new novel. Returns its novelId — pass that id to every later call. Does not change what anyone else is working on.', {
    title: z.string().optional(),
    synopsis: z.string().optional().describe('What the novel is about'),
    style: z.string().optional().describe('Writing style / voice instructions used for every chapter'),
    chapterCount: z.number().int().min(1).max(200).optional(),
    chapterWordCountMin: z.number().int().min(200).optional(),
    chapterWordCountMax: z.number().int().min(200).optional(),
    characters: z.array(z.string()).optional().describe('One string per character: name, role, short description'),
    settings: z.array(z.string()).optional().describe('One string per place, period, object or world detail'),
  }, async ({ style, ...a }) => {
    const project = Object.fromEntries(Object.entries({ ...a, systemPrompt: style }).filter(([, v]) => v !== undefined));
    const n = await createNovel({ project }, writer);
    return ok({ novelId: n.id, created: novelSummary(n), next: `Use novelId "${n.id}" on every call. Fill in details with update_novel_details / set_background_item, then get_outline_brief → save_outline.` });
  });

  tool('get_novel', 'Get a novel: project details (synopsis, characters, world, background, style, editors), the outline, and which chapters are written (with word counts and continuity summaries). Chapter text is not included — use read_chapter.', { ...novelIdArg }, async ({ novelId }) => {
    const n = await readNovel(needNovel(novelId));
    return ok({
      ...novelSummary(n),
      project: { ...n.project, style: n.project.systemPrompt },
      chapters: chapterStatus(n).map(s => ({ ...s, outline: n.outline[s.chapter - 1].description, summary: n.chapters[s.chapter - 1]?.summary || undefined })),
      webApp: 'https://theaibookgenerator.com → Novel → Settings → MCP bridge',
    });
  }, { readOnlyHint: true });

  tool('update_novel_details', 'Change the title, synopsis, style, chapter count, word range, characters or world details of a novel. Lists you pass replace the old list.', {
    ...novelIdArg,
    title: z.string().optional(), synopsis: z.string().optional(),
    style: z.string().optional().describe('Writing style / voice instructions used for every chapter'),
    chapterCount: z.number().int().min(1).max(200).optional().describe('Chapters the outline should have'),
    chapterWordCountMin: z.number().int().min(200).optional(), chapterWordCountMax: z.number().int().min(200).optional(),
    characters: z.array(z.string()).optional(), settings: z.array(z.string()).optional(),
    acknowledgementsText: z.string().optional(), copyrightText: z.string().optional(),
  }, async ({ novelId, style, ...rest }) => {
    const patch = Object.fromEntries(Object.entries({ ...rest, systemPrompt: style }).filter(([, v]) => v !== undefined));
    const n = await changeNovel(novelId, nv => ({ ...nv, project: { ...nv.project, ...patch } }));
    return ok(novelSummary(n));
  });

  tool('set_background_item', 'Add, update (matched by name) or remove a background / reference entry: character bio, world building, style guide, timeline, notes. Entries can apply to all chapters or only some.', {
    ...novelIdArg,
    name: z.string(),
    type: z.string().optional().describe('e.g. character bio, world building, style guide, timeline, research, notes'),
    content: z.string().optional(),
    chapters: z.union([z.literal('all'), z.array(z.number().int().min(1))]).optional().describe('"all" or 1-based chapter numbers it applies to'),
    remove: z.boolean().optional(),
  }, async ({ novelId, name, type, content, chapters, remove }) => {
    const n = await changeNovel(novelId, nv => {
      const key = name.trim().toLowerCase();
      const list = nv.project.background;
      const i = list.findIndex(b => (b.name || '').trim().toLowerCase() === key);
      let next;
      if (remove) next = list.filter((_, k) => k !== i);
      else if (i >= 0) next = list.map((b, k) => (k === i ? { ...b, ...(type ? { type } : {}), ...(content !== undefined ? { content } : {}), ...(chapters !== undefined ? { chapters: bgChapters(chapters) } : {}) } : b));
      else next = [...list, { type: type || 'notes', name, content: content || '', chapters: bgChapters(chapters) }];
      return { ...nv, project: { ...nv.project, background: next } };
    });
    return ok({ background: n.project.background.map(b => ({ name: b.name, type: b.type, chapters: b.chapters === 'all' ? 'all' : (b.chapters || []).map(c => c + 1) })) });
  });

  tool('get_outline_brief', 'Get the brief for writing the chapter outline (project context, chapter count). Read this before save_outline.', { ...novelIdArg }, async ({ novelId }) => {
    return ok(outlineBrief(await readNovel(needNovel(novelId))));
  }, { readOnlyHint: true });

  tool('save_outline', 'Save the chapter-by-chapter outline you wrote. Replaces the whole outline. Already-written chapter text stays with its chapter number.', {
    ...novelIdArg,
    chapters: z.array(z.object({ title: z.string(), description: z.string().describe('One paragraph: what happens') })).min(1),
  }, async ({ novelId, chapters }) => {
    let orphaned = 0;
    const n = await changeNovel(novelId, nv => {
      const keep = {};
      for (const [k, v] of Object.entries(nv.chapters)) { if (Number(k) < chapters.length) keep[k] = v; else if (v?.text) orphaned++; }
      return { ...nv, outline: chapters, chapters: keep, project: { ...nv.project, chapterCount: chapters.length } };
    });
    return ok({ ...novelSummary(n), ...(orphaned ? { warning: `${orphaned} written chapter(s) beyond chapter ${chapters.length} were dropped.` } : {}), next: 'get_chapter_brief for chapter 1, write it, then write_chapter.' });
  });

  tool('update_outline_chapter', 'Change one outline entry, insert a new chapter (shifting later chapters and their text along), or delete a chapter.', {
    ...novelIdArg,
    chapter: z.number().int().min(1).describe('1-based. For insert: the new chapter\'s position'),
    action: z.enum(['update', 'insert', 'delete']).optional(),
    title: z.string().optional(), description: z.string().optional(),
  }, async ({ novelId, chapter, action = 'update', title, description }) => {
    const n = await changeNovel(novelId, nv => {
      if (action === 'insert') {
        if (chapter > nv.outline.length + 1) throw new Error(`Chapter ${chapter} is past the end (the outline has ${nv.outline.length}).`);
        return insertChapterAt(nv, chapter - 1, { title: title || `Chapter ${chapter}`, description: description || '' });
      }
      const i = chIdx(nv, chapter);
      if (action === 'delete') return removeChapterAt(nv, i);
      return { ...nv, outline: nv.outline.map((o, k) => (k === i ? { title: title ?? o.title, description: description ?? o.description } : o)) };
    });
    return ok({ ...novelSummary(n), outline: n.outline.map((o, i) => `${i + 1}. ${o.title}`) });
  });

  tool('get_chapter_brief', 'Get everything needed to write, revise or review one chapter: style, project context, the story so far (continuity summaries, neighbouring chapters in full) and the task. purpose: write (default), revise (uses revision notes) or review (editor feedback).', {
    ...novelIdArg,
    chapter: z.number().int().min(1),
    purpose: z.enum(['write', 'revise', 'review']).optional(),
    revisionNotes: z.string().optional().describe('For revise: what to change. Defaults to notes saved with the chapter'),
  }, async ({ novelId, chapter, purpose = 'write', revisionNotes }) => {
    const n = await readNovel(needNovel(novelId));
    return ok(chapterBrief(n, chIdx(n, chapter), { purpose, notes: revisionNotes || '' }));
  }, { readOnlyHint: true });

  tool('write_chapter', 'Save the full text of one chapter you wrote (or revised), plus a short factual continuity summary that later chapters rely on.', {
    ...novelIdArg,
    chapter: z.number().int().min(1),
    text: z.string().min(1).describe('The chapter prose only — no chapter heading'),
    summary: z.string().optional().describe('Factual continuity notes: who was there, what happened, places, objects, relationship changes, time, promises/foreshadowing'),
  }, async ({ novelId, chapter, text, summary }) => {
    const n = await changeNovel(novelId, nv => saveChapterText(nv, chIdx(nv, chapter), { text, summary }));
    const c = n.chapters[chapter - 1];
    return ok({ chapter, words: wordCount(c.text), summarySaved: !!c.summary, progress: novelSummary(n), ...(summary ? {} : { warning: 'No continuity summary saved — later chapters will only see the outline for this one. Call write_chapter again with a summary, or set_chapter_notes.' }) });
  });

  tool('read_chapter', 'Read one chapter: full text, continuity summary, editor feedback and revision notes.', {
    ...novelIdArg,
    chapter: z.number().int().min(1),
  }, async ({ novelId, chapter }) => {
    const n = await readNovel(needNovel(novelId));
    const i = chIdx(n, chapter);
    const c = n.chapters[i];
    return ok({ chapter, title: n.outline[i].title, outline: n.outline[i].description, written: !!c?.text, words: wordCount(c?.text), text: c?.text || '', summary: c?.summary || '', feedback: c?.feedback || [], revisionNotes: c?.revisionNotes || '' });
  }, { readOnlyHint: true });

  tool('set_chapter_notes', 'Set a chapter\'s continuity summary and/or its revision notes without changing its text.', {
    ...novelIdArg,
    chapter: z.number().int().min(1),
    summary: z.string().optional(), revisionNotes: z.string().optional(),
  }, async ({ novelId, chapter, summary, revisionNotes }) => {
    await changeNovel(novelId, nv => {
      const i = chIdx(nv, chapter);
      const c = nv.chapters[i];
      if (!c) throw new Error(`Chapter ${chapter} hasn't been written yet.`);
      return { ...nv, chapters: { ...nv.chapters, [i]: { ...c, ...(summary !== undefined ? { summary } : {}), ...(revisionNotes !== undefined ? { revisionNotes } : {}) } } };
    });
    return ok(`Saved notes for chapter ${chapter}.`);
  });

  tool('save_chapter_feedback', 'Save editorial feedback on a chapter (as one of the novel\'s editors). It shows on the website next to the chapter and can become revision notes.', {
    ...novelIdArg,
    chapter: z.number().int().min(1),
    editorName: z.string(),
    feedback: z.string(),
    useAsRevisionNotes: z.boolean().optional().describe('Also append it to the chapter\'s revision notes'),
  }, async ({ novelId, chapter, editorName, feedback, useAsRevisionNotes }) => {
    await changeNovel(novelId, nv => {
      const i = chIdx(nv, chapter);
      const c = nv.chapters[i];
      if (!c?.text) throw new Error(`Chapter ${chapter} hasn't been written yet.`);
      const notes = useAsRevisionNotes ? [c.revisionNotes, `[${editorName}]:\n${feedback}`].filter(Boolean).join('\n\n') : c.revisionNotes;
      return { ...nv, chapters: { ...nv.chapters, [i]: { ...c, feedback: [...(c.feedback || []), { editorName, text: feedback }], revisionNotes: notes } } };
    });
    return ok(`Feedback from ${editorName} saved on chapter ${chapter}.`);
  });

  tool('export_novel', 'Write the written chapters as one manuscript file (Markdown or plain text). Returns the file path.', {
    ...novelIdArg,
    format: z.enum(['markdown', 'text']).optional(),
    outputPath: z.string().optional().describe('Where to write it (default: the novel\'s folder)'),
  }, async ({ novelId, format = 'markdown', outputPath }) => {
    const n = await readNovel(needNovel(novelId));
    const out = outputPath || path.join(NOVELS_DIR, n.id, `${safeName(n.project.title || 'novel')}.${format === 'markdown' ? 'md' : 'txt'}`);
    await fsp.writeFile(out, manuscript(n, format));
    return ok({ file: out, ...novelSummary(n) });
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
    const novels = await listNovels();
    return send(res, 200, { ok: true, name: 'kids-book-studio', version: VERSION, dataDir: DATA_DIR, serverPath: SERVER_PATH, books: books.length, novels: novels.length, features: ['books', 'novels'], mcp: `http://127.0.0.1:${PORT}/mcp` });
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

  if (p === '/api/novels' && req.method === 'GET') return send(res, 200, await listNovels());
  if (p === '/api/novels' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    return send(res, 201, await createNovel(body, req.headers['x-kidsbook-client'] || 'web'));
  }
  let m = p.match(/^\/api\/novels\/([\w-]+)$/);
  if (m) {
    if (req.method === 'GET') return send(res, 200, await readNovel(m[1]));
    if (req.method === 'PUT') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      await readNovel(m[1]);
      try {
        const saved = await writeNovel({ ...body, id: m[1] }, { writer: req.headers['x-kidsbook-client'] || 'web', baseRev: body.rev ?? null });
        return send(res, 200, saved);
      } catch (e) {
        if (e.status === 409) return send(res, 409, e.current);
        throw e;
      }
    }
  }

  m = p.match(/^\/api\/books\/([\w-]+)$/);
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

function watchDir(dir, file, type, idKey, list) {
  const timers = new Map();
  const changed = id => {
    clearTimeout(timers.get(id));
    timers.set(id, setTimeout(async () => {
      try {
        const raw = JSON.parse(await fsp.readFile(path.join(dir, id, file), 'utf8'));
        broadcast({ type, [idKey]: id, rev: raw.rev, writer: raw._writer || '' });
      } catch (e) { /* mid-write */ }
    }, 120));
  };
  try {
    fs.watch(dir, { recursive: true }, (evt, filename) => {
      if (!filename) return;
      const parts = String(filename).split(/[\\/]/);
      if (parts.length === 2 && parts[1] === file) changed(parts[0]);
    });
  } catch (e) {
    log(`fs.watch unavailable for ${type}s, polling instead`);
    const revs = new Map();
    setInterval(async () => {
      for (const b of await list()) {
        if (revs.has(b.id) && revs.get(b.id) !== b.rev) changed(b.id);
        revs.set(b.id, b.rev);
      }
    }, 1500);
  }
}

function watchBooks() {
  watchDir(BOOKS_DIR, 'book.json', 'book', 'bookId', listBooks);
  watchDir(NOVELS_DIR, 'novel.json', 'novel', 'novelId', listNovels);
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
