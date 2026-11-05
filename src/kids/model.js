// Kids book data model, page planning and booklet imposition.
// Isomorphic: imported by the browser app AND the MCP server (Node). No DOM / React here.

export const PAPER = {
  letter: { label: 'US Letter 8.5 × 11 in (folds to 5.5 × 8.5)', unit: 'in', sheetW: 11, sheetH: 8.5, pageW: 5.5, pageH: 8.5 },
  a4: { label: 'A4 (folds to A5)', unit: 'mm', sheetW: 297, sheetH: 210, pageW: 148.5, pageH: 210 },
};

// Saddle-stitched booklets need a multiple of 4 pages (each folded sheet = 4 pages).
export const PAGE_COUNTS = [8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48];

export const AGE_RANGES = ['0-3', '3-5', '4-8', '6-9', '8-12'];

export const STORY_LAYOUTS = {
  'image-top': { label: 'Picture top, words below', aspect: '1:1' },
  'image-bottom': { label: 'Words top, picture below', aspect: '1:1' },
  'full-text-bottom': { label: 'Full picture, words box at bottom', aspect: '2:3' },
  'full-text-top': { label: 'Full picture, words box at top', aspect: '2:3' },
  'image-only': { label: 'Full picture, no words', aspect: '2:3' },
  'text-only': { label: 'Words only', aspect: null },
};

export const COVER_LAYOUTS = {
  'full-title-top': 'Full picture, title on top',
  'full-title-bottom': 'Full picture, title band at bottom',
  framed: 'Framed picture on color',
  classic: 'Title block over picture',
};

export const BACK_COVER_LAYOUTS = {
  'blurb-center': 'Blurb on color with small picture',
  'blurb-over-image': 'Blurb box over faded picture',
};

export const MATTER_TYPES = {
  title: 'Title page',
  copyright: 'Copyright + dedication',
  dedication: 'Dedication',
  contents: 'Table of contents',
  'about-author': 'About the author',
  'about-illustrator': 'About the illustrator',
  'the-end': 'The End',
  note: 'Custom text page',
  image: 'Full-page picture',
  blank: 'Blank page',
};

export const CAST_KINDS = { character: 'Character', prop: 'Prop', environment: 'Environment' };

export const ART_STYLES = [
  'Soft watercolor with gentle ink outlines, warm light, lots of white space',
  'Bright flat digital cartoon, bold shapes, thick clean outlines',
  'Gouache painting, textured brush strokes, rich muted colors',
  'Colored pencil and crayon, hand-drawn texture, cozy and playful',
  'Cut-paper collage, layered textures, bold simple shapes',
  'Vintage mid-century picture book, limited palette, screen-print texture',
  'Pen and ink with light washes, detailed and whimsical',
  'Soft 3D clay / plasticine look, rounded forms, studio lighting',
];

export function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}

export function newPage(p = {}) {
  return {
    id: uid('pg'),
    text: '',
    illustration: '',
    cast: [],
    layout: 'image-top',
    split: null,
    imageId: null,
    altImages: [],
    ...p,
  };
}

export function newMatter(type, p = {}) {
  const defaults = {
    title: { title: '' },
    copyright: { text: '' },
    dedication: { text: '' },
    contents: { title: 'Contents' },
    'about-author': { title: 'About the Author', text: '' },
    'about-illustrator': { title: 'About the Illustrator', text: '' },
    'the-end': { title: 'The End' },
    note: { title: '', text: '' },
    image: {},
    blank: {},
  }[type] || {};
  return { id: uid('mt'), type, title: '', text: '', imageId: null, ...defaults, ...p };
}

export function newCastMember(kind = 'character', p = {}) {
  return { id: uid('cast'), kind, name: '', description: '', refs: [], sheets: [], activeSheet: null, sheetNotes: '', ...p };
}

export function newChapter(p = {}) {
  return { id: uid('ch'), title: '', summary: '', targetPages: 0, pages: [], ...p };
}

export function newBook(overrides = {}) {
  const year = new Date().getFullYear();
  return normalizeBook({
    version: 1,
    id: uid('book'),
    rev: 0,
    title: '',
    subtitle: '',
    author: '',
    illustrator: '',
    ageRange: '4-8',
    premise: '',
    lesson: '',
    tone: 'warm, funny and reassuring',
    wordsPerPage: [15, 60],
    artStyle: ART_STYLES[0],
    styleRefs: [],
    pageCount: 16,
    paper: 'letter',
    chapterMode: 'single',
    chapterCount: 3,
    cast: [],
    chapters: [newChapter({ title: '' })],
    frontMatter: [
      newMatter('title'),
      newMatter('copyright', { text: `Text © ${year} [Author]\nIllustrations © ${year}\nAll rights reserved.\n\nFor [someone special]` }),
    ],
    backMatter: [newMatter('about-author', { text: '' })],
    cover: { layout: 'full-title-top', imageId: null, altImages: [], prompt: '', bgColor: '#fff4dc', titleColor: '#ffffff', titleStroke: '#2b2b4a', titleSize: 46, titleY: null, titleWidth: 100, titleAlign: 'center', titleLineHeight: 1.02, titleStrokeWidth: 0.045, subtitleSize: null, bylineSize: 15, bylinePos: 'bottom' },
    backCover: { layout: 'blurb-center', blurb: '', tagline: '', imageId: null, bgColor: '#fff4dc', showAge: true, showBarcodeBox: false },
    design: {
      titleFont: 'Fredoka',
      bodyFont: 'Andika',
      bodySize: 17,
      lineHeight: 1.45,
      align: 'center',
      textColor: '#2b2b3a',
      accentColor: '#e0663d',
      pageBg: '#fffdf7',
      safeMargin: 0.35,
      bleed: true,
      pageNumbers: true,
      overlayBox: 'soft',
      autoFit: true,
      pageMode: 'together',
      splitOrder: 'words-first',
    },
    print: { flip: 'short', reverseBacks: false, foldMarks: false, sheetLabels: false },
    updatedAt: Date.now(),
    ...overrides,
  });
}

// Fill in anything missing (older saves, MCP-created books, imports).
export function normalizeBook(b) {
  const base = b || {};
  const d = base.design || {};
  const book = {
    version: 1,
    rev: 0,
    title: '',
    subtitle: '',
    author: '',
    illustrator: '',
    ageRange: '4-8',
    premise: '',
    lesson: '',
    tone: '',
    wordsPerPage: [15, 60],
    artStyle: ART_STYLES[0],
    styleRefs: [],
    pageCount: 16,
    paper: 'letter',
    chapterMode: 'single',
    chapterCount: 3,
    cast: [],
    chapters: [],
    frontMatter: [],
    backMatter: [],
    ...base,
  };
  book.id = book.id || uid('book');
  book.cast = (book.cast || []).map(c => newCastMember(c.kind || 'character', c));
  book.chapters = (book.chapters && book.chapters.length ? book.chapters : [newChapter()]).map(ch => ({
    ...newChapter(),
    ...ch,
    pages: (ch.pages || []).map(p => newPage(p)),
  }));
  book.frontMatter = (book.frontMatter || []).map(m => newMatter(m.type || 'note', m));
  book.backMatter = (book.backMatter || []).map(m => newMatter(m.type || 'note', m));
  book.cover = { layout: 'full-title-top', imageId: null, altImages: [], prompt: '', bgColor: '#fff4dc', titleColor: '#ffffff', titleStroke: '#2b2b4a', titleSize: 46, titleY: null, titleWidth: 100, titleAlign: 'center', titleLineHeight: 1.02, titleStrokeWidth: 0.045, subtitleSize: null, bylineSize: 15, bylinePos: 'bottom', ...(base.cover || {}) };
  book.backCover = { layout: 'blurb-center', blurb: '', tagline: '', imageId: null, bgColor: '#fff4dc', showAge: true, showBarcodeBox: false, ...(base.backCover || {}) };
  book.design = {
    titleFont: 'Fredoka', bodyFont: 'Andika', bodySize: 17, lineHeight: 1.45, align: 'center',
    textColor: '#2b2b3a', accentColor: '#e0663d', pageBg: '#fffdf7', safeMargin: 0.35, bleed: true,
    pageNumbers: true, overlayBox: 'soft', autoFit: true, pageMode: 'together', splitOrder: 'words-first', ...d,
  };
  book.print = { flip: 'short', reverseBacks: false, foldMarks: false, sheetLabels: false, ...(base.print || {}) };
  if (!PAGE_COUNTS.includes(book.pageCount)) book.pageCount = roundUpTo4(book.pageCount || 16);
  if (!PAPER[book.paper]) book.paper = 'letter';
  if (!Array.isArray(book.wordsPerPage)) book.wordsPerPage = [15, 60];
  return book;
}

export function roundUpTo4(n) {
  return Math.max(8, Math.ceil(n / 4) * 4);
}

// Flatten chapters into an ordered list of story pages.
export function storyPages(book) {
  const out = [];
  book.chapters.forEach((ch, ci) => {
    ch.pages.forEach((page, pi) => {
      out.push({ chapterIdx: ci, pageIdx: pi, chapter: ch, page, isChapterStart: pi === 0 });
    });
  });
  return out;
}

export function storySlots(book) {
  return book.pageCount - 2 - book.frontMatter.length - book.backMatter.length;
}

// Map every physical page (1..N) to what goes on it.
// Does this story page put its picture and its words on two separate (facing) pages?
// page.split: true / false overrides the book-wide design.pageMode ('together' | 'split').
export function isSplit(book, page) {
  if (page.split === true || page.split === false) return page.split;
  return book.design.pageMode === 'split' && page.layout !== 'text-only' && page.layout !== 'image-only';
}

// Printed pages one story page uses.
export function pageWeight(book, page) {
  return isSplit(book, page) ? 2 : 1;
}

// Aspect ratio to request for a story page's picture.
export function pageAspect(book, page) {
  if (isSplit(book, page)) return '2:3';
  return STORY_LAYOUTS[page.layout]?.aspect || '1:1';
}

// How many story pages fit, assuming every page follows the book-wide setting.
export function storyCapacity(book) {
  const slots = Math.max(0, storySlots(book));
  return book.design.pageMode === 'split' ? Math.floor(slots / 2) : slots;
}

export function computePlan(book) {
  const N = book.pageCount;
  const warnings = [];
  const slots = storySlots(book);
  const story = storyPages(book);
  const pages = [];
  const wordsFirst = book.design.splitOrder !== 'picture-first';

  pages.push({ kind: 'cover' });
  book.frontMatter.forEach((m, i) => pages.push({ kind: 'front', matter: m, index: i }));

  const usable = Math.max(0, slots);
  let used = 0;
  let placed = 0;
  const notFacing = [];
  for (let i = 0; i < story.length; i++) {
    const s = story[i];
    const w = pageWeight(book, s.page);
    if (used + w > usable) break;
    if (w === 2) {
      const first = pages.length + 1;
      if (first % 2 === 1) notFacing.push(i + 1);
      const parts = wordsFirst ? ['words', 'picture'] : ['picture', 'words'];
      parts.forEach(part => pages.push({ kind: 'story', ...s, storyIndex: i, part }));
    } else {
      pages.push({ kind: 'story', storyIndex: i, ...s });
    }
    used += w;
    placed++;
  }
  for (let i = used; i < usable; i++) pages.push({ kind: 'filler' });

  book.backMatter.forEach((m, i) => pages.push({ kind: 'back', matter: m, index: i }));
  pages.push({ kind: 'back-cover' });

  const needed = story.reduce((a, s) => a + pageWeight(book, s.page), 0);
  const fixed = N - slots;
  if (slots < 0) {
    warnings.push(`Front + back matter need ${fixed - 2} pages but the book only has ${N}. Remove matter pages or raise the page count.`);
  }
  if (placed < story.length) {
    warnings.push(`The story needs ${needed} printed pages but only ${usable} fit in ${N} pages, so ${story.length - placed} story page(s) won't print. Use ${roundUpTo4(needed + fixed)} pages, trim the story, or remove matter pages.`);
  }
  if (story.length > 0 && used < usable && placed === story.length) {
    warnings.push(`${usable - used} printed page(s) are empty and will print blank. Add story pages, add back matter, or lower the page count.`);
  }
  if (notFacing.length) {
    warnings.push(`Story page${notFacing.length > 1 ? 's' : ''} ${notFacing.join(', ')}: the picture and words start on a right-hand page, so they won't face each other. Add or remove one front-matter page, or switch one page before ${notFacing.length > 1 ? 'them' : 'it'} to together/separate.`);
  }

  // Trim/pad to exactly N (only matters when slots < 0).
  while (pages.length > N) pages.splice(pages.length - 2, 1);
  pages.forEach((p, i) => { p.n = i + 1; });

  // Chapter start pages for a contents page.
  const chapterStarts = {};
  pages.forEach(p => {
    if (p.kind === 'story' && p.isChapterStart && chapterStarts[p.chapterIdx] === undefined) chapterStarts[p.chapterIdx] = p.n;
  });

  // First printed page of each story page (by page id), and the full range for split pages.
  const pageNumbers = {};
  pages.forEach(p => {
    if (p.kind !== 'story') return;
    const r = pageNumbers[p.page.id];
    pageNumbers[p.page.id] = r ? { ...r, last: p.n } : { first: p.n, last: p.n, picture: null };
    if (p.part !== 'words') pageNumbers[p.page.id].picture = p.n;
  });

  return {
    pages, slots: usable, used, capacity: storyCapacity(book), storyCount: story.length, placed,
    warnings, chapterStarts, pageNumbers, suggestedPageCount: roundUpTo4(needed + fixed),
  };
}

// Saddle-stitch imposition. Sheet 1 is the outermost sheet.
// Each sheet is printed landscape, two pages side by side, both sides.
export function imposition(totalPages) {
  const N = totalPages;
  const sheets = [];
  for (let i = 0; i < N / 4; i++) {
    sheets.push({
      sheet: i + 1,
      front: [N - 2 * i, 2 * i + 1],
      back: [2 * i + 2, N - 2 * i - 1],
    });
  }
  return sheets;
}

export function describeImposition(totalPages) {
  return imposition(totalPages)
    .map(s => `Sheet ${s.sheet}: front [${s.front[0]} | ${s.front[1]}]  back [${s.back[0]} | ${s.back[1]}]`)
    .join('\n');
}

export function findCast(book, name) {
  if (!name) return null;
  const n = String(name).trim().toLowerCase();
  return book.cast.find(c => c.name.trim().toLowerCase() === n)
    || book.cast.find(c => c.name.trim().toLowerCase().split(/\s+/)[0] === n.split(/\s+/)[0])
    || null;
}

// Every image id the book references (for export / garbage collection).
export function allImageIds(book) {
  const ids = new Set();
  const add = id => { if (id) ids.add(id); };
  (book.styleRefs || []).forEach(add);
  book.cast.forEach(c => { c.refs.forEach(add); c.sheets.forEach(add); add(c.activeSheet); });
  book.chapters.forEach(ch => ch.pages.forEach(p => { add(p.imageId); (p.altImages || []).forEach(add); }));
  [...book.frontMatter, ...book.backMatter].forEach(m => add(m.imageId));
  add(book.cover.imageId);
  (book.cover.altImages || []).forEach(add);
  add(book.backCover.imageId);
  return [...ids];
}

// Apply a story JSON (from AI or MCP) to the book. Keeps existing images where page ids line up.
export function applyStory(book, story, { chapterIdx = null } = {}) {
  const toPage = p => newPage({
    text: p.text || '',
    illustration: p.illustration || p.illustrationPrompt || '',
    cast: Array.isArray(p.cast) ? p.cast : Array.isArray(p.characters) ? p.characters : [],
    layout: STORY_LAYOUTS[p.layout] ? p.layout : 'image-top',
  });
  const next = { ...book };
  if (story.title && !book.title) next.title = story.title;
  if (story.blurb && !book.backCover.blurb) next.backCover = { ...book.backCover, blurb: story.blurb };
  const chs = story.chapters || (story.pages ? [{ title: story.chapterTitle || '', pages: story.pages }] : []);
  if (chapterIdx !== null) {
    const chapters = [...book.chapters];
    const src = chs[0] || { pages: [] };
    chapters[chapterIdx] = { ...chapters[chapterIdx], title: src.title || chapters[chapterIdx].title, pages: (src.pages || []).map(toPage) };
    next.chapters = chapters;
  } else {
    next.chapters = chs.map(ch => newChapter({ title: ch.title || '', summary: ch.summary || '', pages: (ch.pages || []).map(toPage) }));
    if (!next.chapters.length) next.chapters = [newChapter()];
  }
  return next;
}

export function bookSummary(book) {
  const plan = computePlan(book);
  return {
    id: book.id,
    rev: book.rev,
    title: book.title,
    author: book.author,
    ageRange: book.ageRange,
    pageCount: book.pageCount,
    storyPagesFit: plan.capacity,
    storyPagesWritten: plan.storyCount,
    printedStoryPages: `${plan.used} of ${plan.slots}`,
    pageMode: book.design.pageMode,
    chapterMode: book.chapterMode,
    warnings: plan.warnings,
  };
}

export const safeName = s => (s || 'kids-book').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'kids-book';
