// Prompt builders for kids books. Isomorphic (browser + MCP server).
import { STORY_LAYOUTS, CAST_KINDS, computePlan, findCast, isSplit, storyCapacity } from './model.js';

const NO_TEXT = 'Do not draw any words, letters, captions, signatures or watermarks in the image.';

export function castList(book) {
  if (!book.cast.length) return '(none defined yet)';
  return book.cast
    .map(c => `- ${c.name || '(unnamed)'} [${CAST_KINDS[c.kind] || c.kind}]: ${c.description || 'no description'}`)
    .join('\n');
}

export function bookBrief(book) {
  const [minW, maxW] = book.wordsPerPage || [15, 60];
  return [
    book.title ? `Title: ${book.title}` : 'Title: (not chosen yet — suggest one)',
    book.subtitle ? `Subtitle: ${book.subtitle}` : '',
    `Reader age: ${book.ageRange}`,
    `Premise: ${book.premise || '(none given — invent a charming one)'}`,
    book.lesson ? `Theme / lesson: ${book.lesson}` : '',
    book.tone ? `Tone: ${book.tone}` : '',
    `Words per page: about ${minW}-${maxW}`,
    `Art style (for illustration notes): ${book.artStyle}`,
    `Cast:\n${castList(book)}`,
  ].filter(Boolean).join('\n');
}

export function storySystemPrompt(book) {
  return `You are an award-winning children's picture-book author and art director. You write for ages ${book.ageRange}: concrete, vivid, rhythmic language; short sentences; read-aloud musicality; gentle humor; page turns that create anticipation; a satisfying ending. Every page must be illustratable as a single clear scene.`;
}

const PAGE_SCHEMA = `{ "text": string (the words printed on the page), "illustration": string (a detailed visual scene description for the illustrator: who is where doing what, expressions, setting, time of day, composition — no dialogue, and no art-style words), "cast": string[] (exact names of cast members visible on the page), "layout": one of ${Object.keys(STORY_LAYOUTS).map(k => `"${k}"`).join(', ')} }`;

function layoutGuidance(book) {
  if (book.design.pageMode === 'split') {
    return 'Each page\'s picture and words will be printed on separate facing pages (a full-page picture opposite a page of words), so every page needs one strong, clear full-page scene. Use "image-top" as the layout for every page.';
  }
  return 'Layout guidance: use "image-top" or "image-bottom" for most pages, "full-text-bottom"/"full-text-top" for big dramatic moments, "image-only" sparingly for wordless beats, and "text-only" rarely.';
}

export function storyPrompt(book, { slots = null } = {}) {
  const n = slots ?? storyCapacity(book);
  const chapters = book.chapterMode === 'chapters';
  const structure = chapters
    ? `Split the story into ${book.chapterCount || 3} short chapters, each with a title. The total number of pages across all chapters must be exactly ${n}.`
    : `Write it as one continuous story (a single chapter with an empty title) of exactly ${n} pages.`;
  return `Write a complete children's book.

${bookBrief(book)}

${structure}

${layoutGuidance(book)} Keep each page's text within the word budget so it fits on a 5.5 × 8.5 inch page.
Illustration notes describe only what is in the picture (who, where, doing what, expressions, composition). Don't describe the art style or medium — that is applied separately.
Use the cast names exactly as given when they appear. You may introduce minor background characters in illustration notes, but keep the main cast consistent.

Return ONLY valid JSON (no markdown fences) of the form:
{ "title": string, "blurb": string (2-3 sentence back-cover blurb), "chapters": [ { "title": string, "pages": [ ${PAGE_SCHEMA} ] } ] }`;
}

export function chapterPlanPrompt(book, { slots = null } = {}) {
  const n = slots ?? storyCapacity(book);
  return `Plan a children's chapter book.

${bookBrief(book)}

Plan exactly ${book.chapterCount || 3} chapters. Distribute exactly ${n} pages total across them (each chapter at least 2 pages).

Return ONLY valid JSON (no markdown fences): { "title": string, "chapters": [ { "title": string, "summary": string (3-5 sentences of what happens), "targetPages": number } ] }`;
}

export function chapterPagesPrompt(book, chapterIdx) {
  const ch = book.chapters[chapterIdx];
  const outline = book.chapters
    .map((c, i) => `Chapter ${i + 1}: ${c.title || '(untitled)'}${i === chapterIdx ? '  <-- WRITE THIS ONE' : ''}\n${c.summary || ''}${c.pages.length && i !== chapterIdx ? `\n(already written: ${c.pages.map(p => p.text).join(' ').slice(0, 600)}…)` : ''}`)
    .join('\n\n');
  const n = ch.targetPages || Math.max(2, Math.floor(storyCapacity(book) / book.chapters.length));
  return `Write chapter ${chapterIdx + 1} of a children's book.

${bookBrief(book)}

Chapter plan:
${outline}

Write exactly ${n} pages for chapter ${chapterIdx + 1} ("${ch.title}"). Pick up seamlessly from the previous chapter and set up the next.

Return ONLY valid JSON (no markdown fences): { "chapters": [ { "title": string, "pages": [ ${PAGE_SCHEMA} ] } ] }`;
}

export function revisePagePrompt(book, page, instruction, neighbours = {}) {
  return `Revise one page of a children's book.

${bookBrief(book)}

${neighbours.prev ? `Previous page text: ${neighbours.prev.text}\n` : ''}Current page:
${JSON.stringify({ text: page.text, illustration: page.illustration, cast: page.cast, layout: page.layout })}
${neighbours.next ? `Next page text: ${neighbours.next.text}\n` : ''}
Instruction: ${instruction || 'Make it more delightful to read aloud while keeping the same story beat.'}

Return ONLY valid JSON (no markdown fences): ${PAGE_SCHEMA}`;
}

export function reviseStoryPrompt(book, instruction) {
  const story = book.chapters.map(ch => ({ title: ch.title, pages: ch.pages.map(p => ({ text: p.text, illustration: p.illustration, cast: p.cast, layout: p.layout })) }));
  const n = book.chapters.reduce((a, c) => a + c.pages.length, 0);
  return `Revise this children's book according to the instruction. Keep exactly ${n} pages total and the same chapter structure unless the instruction says otherwise.

${bookBrief(book)}

Current story JSON:
${JSON.stringify({ chapters: story })}

Instruction: ${instruction}

Return ONLY valid JSON (no markdown fences): { "chapters": [ { "title": string, "pages": [ ${PAGE_SCHEMA} ] } ] }`;
}

export function analyzeImagePrompt(book) {
  return `This image shows characters (and maybe props or places) for a children's book${book.title ? ` called "${book.title}"` : ''}.
Identify each distinct character, important prop, and environment shown. For each, write a precise visual description an illustrator could use to redraw it consistently: species/body type, size, colors (name exact colors), clothing, hair/fur, distinguishing marks, accessories, personality as suggested by the pose.
${book.cast.length ? `Already defined (don't duplicate unless this image adds detail):\n${castList(book)}\n` : ''}
Return ONLY valid JSON (no markdown fences): { "cast": [ { "kind": "character" | "prop" | "environment", "name": string (invent a fitting name if unknown), "description": string } ] }`;
}

export function castFromPremisePrompt(book) {
  return `Suggest the main cast for this children's book: characters, 1-3 important props, and 1-3 key environments.

${bookBrief(book)}

Return ONLY valid JSON (no markdown fences): { "cast": [ { "kind": "character" | "prop" | "environment", "name": string, "description": string (precise visual description for an illustrator) } ] }`;
}

export function blurbPrompt(book) {
  const text = book.chapters.flatMap(c => c.pages.map(p => p.text)).join(' ').slice(0, 4000);
  return `Write a back-cover blurb (2-4 short sentences, warm and enticing, for parents and kids ages ${book.ageRange}) and a one-line tagline for this children's book.

${bookBrief(book)}

Story text: ${text || '(not written yet — use the premise)'}

Return ONLY valid JSON (no markdown fences): { "blurb": string, "tagline": string }`;
}

// ---- Image prompts ----
// Every image prompt has the same shape: ART STYLE first (the thing models most often drift on),
// then what each attached reference image is for, then the scene, then the style again as a reminder.

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function styleBlock(book, refs = []) {
  const hasStyleRef = refs.some(r => r.role === 'style');
  return `ART STYLE — follow this exactly: ${book.artStyle || "warm, friendly children's picture-book illustration"}.`
    + (hasStyleRef ? ' An "art style reference" image is attached: match its medium, line work, brush texture, color palette and lighting as closely as possible, but do NOT copy its subject, characters or composition.' : '');
}

function refBlock(refs = []) {
  const chars = refs.filter(r => r.role === 'character' || r.role === 'prop');
  const envs = refs.filter(r => r.role === 'environment');
  const lines = [];
  if (chars.length) {
    const many = chars.length > 1;
    lines.push(`REFERENCE SHEETS — the attached sheets show exactly how ${chars.map(r => r.name).join(', ')} ${many ? 'look' : 'looks'}. Keep ${many ? 'each one' : 'it'} on-model: same face, head and body shape, proportions, colors, clothing, markings and accessories. Draw ${many ? 'them' : 'it'} fresh in a pose that fits this scene. Do NOT reproduce the sheet itself — no turnaround rows, no duplicate copies, no plain white sheet background.`);
  }
  if (envs.length) lines.push(`SETTING REFERENCE — keep ${envs.map(r => r.name).join(', ')} consistent with the attached environment sheet.`);
  return lines.join('\n');
}

function sheetFor(m) {
  return m.activeSheet || m.sheets[m.sheets.length - 1] || m.refs[0] || null;
}

function castRef(m) {
  const id = sheetFor(m);
  if (!id) return null;
  const role = m.kind === 'environment' ? 'environment' : m.kind === 'prop' ? 'prop' : 'character';
  return { id, role, name: m.name, label: `${m.name} — ${role} reference sheet` };
}

function styleRefList(book) {
  return (book.styleRefs || []).slice(0, 1).map(id => ({ id, role: 'style', name: 'art style', label: 'art style reference (match the style, not the content)' }));
}

// Who is in a page's picture: the ticked cast, plus anyone named in the illustration notes
// (and, if nobody is ticked, anyone named in the page text). Names match loosely ("Pip the dragon" → Pip).
export function pageCast(book, page) {
  const found = new Map();
  (page.cast || []).forEach(n => { const m = findCast(book, n); if (m) found.set(m.id, m); });
  const scan = [page.illustration, found.size ? '' : page.text].join(' ').toLowerCase();
  book.cast.forEach(m => {
    const name = (m.name || '').trim().toLowerCase();
    if (name && new RegExp(`(^|[^a-z0-9])${escRe(name)}([^a-z0-9]|$)`).test(scan)) found.set(m.id, m);
  });
  return [...found.values()];
}

// Reference images to send with a page illustration, in the order the prompt describes them.
export function pageRefs(book, page) {
  const order = { character: 0, prop: 1, environment: 2 };
  const refs = pageCast(book, page)
    .sort((a, b) => (order[a.kind] ?? 3) - (order[b.kind] ?? 3))
    .map(castRef)
    .filter(Boolean);
  return [...refs.slice(0, 5), ...styleRefList(book)];
}

export function pagePrompt(book, page, { pageNumber, extra = '', refs = null } = {}) {
  const r = refs || pageRefs(book, page);
  const layout = STORY_LAYOUTS[page.layout] || STORY_LAYOUTS['image-top'];
  let comp = '';
  if (isSplit(book, page)) comp = 'Full-page portrait illustration, edge to edge. The words are printed on the facing page, so no empty space for text is needed.';
  else if (page.layout === 'full-text-bottom') comp = 'Full-page portrait composition. Keep the bottom third simple and uncluttered (sky, ground, soft background) because a text box will sit there.';
  else if (page.layout === 'full-text-top') comp = 'Full-page portrait composition. Keep the top third simple and uncluttered because a text box will sit there.';
  else if (page.layout === 'image-only') comp = 'Full-page portrait composition, edge to edge.';
  else comp = `Square vignette composition (${layout.aspect}), subject centered with breathing room around the edges.`;
  const cast = pageCast(book, page).map(m => `- ${m.name}: ${m.description}`).join('\n');
  return [
    styleBlock(book, r),
    refBlock(r),
    `SCENE — illustration for ${pageNumber ? `page ${pageNumber} of ` : ''}the children's picture book "${book.title || 'Untitled'}" (ages ${book.ageRange}): ${page.illustration || page.text}`,
    page.text ? `The words printed on this page: "${page.text}"` : '',
    cast ? `In the picture:\n${cast}` : '',
    `COMPOSITION — ${comp}`,
    extra ? `EXTRA DIRECTION — ${extra}` : '',
    `Remember the art style: ${book.artStyle}. ${NO_TEXT}`,
  ].filter(Boolean).join('\n');
}

export function sheetPrompt(book, member, opts = {}) {
  const { hasRefs = false, hasStyleRef = false } = typeof opts === 'boolean' ? { hasRefs: opts } : opts;
  const style = styleBlock(book, hasStyleRef ? [{ role: 'style' }] : []);
  const match = hasRefs
    ? `DESIGN REFERENCE — the attached "original reference" image(s) show ${member.name || 'this design'}. Keep the design exactly (shapes, proportions, colors, clothing, markings) but redraw it in the ART STYLE above.`
    : '';
  const notes = member.sheetNotes ? `EXTRA NOTES — ${member.sheetNotes}` : '';
  let body;
  if (member.kind === 'environment') {
    body = `Environment concept sheet for a children's picture book: "${member.name}". ${member.description}
Show one wide establishing view on top and two smaller alternate views below (a different angle and a closer detail). No characters.`;
  } else if (member.kind === 'prop') {
    body = `Prop design sheet for a children's picture book: "${member.name}". ${member.description}
Show the object from the front, side, three-quarter and back, plus one close-up detail, evenly spaced on a plain white background.`;
  } else {
    body = `Character model sheet (turnaround) for a children's picture book: "${member.name}". ${member.description}
Top row: full body front, three-quarter, side and back views at the same scale. Bottom row: four head close-ups showing happy, surprised, sad and determined expressions. Plain white background, even lighting, consistent proportions in every view.`;
  }
  return [style, match, body, notes, `Remember the art style: ${book.artStyle}. ${NO_TEXT}`].filter(Boolean).join('\n');
}

// Reference images for a cast sheet: the member's own uploads, then the style reference.
export function sheetRefs(book, member) {
  return [
    ...member.refs.map(id => ({ id, role: 'design', name: member.name, label: `${member.name || member.kind} — original reference` })),
    ...styleRefList(book),
  ];
}

export function coverRefs(book) {
  const leads = book.cast.filter(c => c.kind === 'character').slice(0, 3).map(castRef).filter(Boolean);
  return [...leads, ...styleRefList(book)];
}

export function coverPrompt(book, extra = '', refs = null) {
  const r = refs || coverRefs(book);
  const leads = book.cast.filter(c => c.kind === 'character').slice(0, 3);
  const top = book.cover.layout === 'full-title-bottom' ? 'bottom' : 'top';
  const full = book.cover.layout === 'full-title-top' || book.cover.layout === 'full-title-bottom';
  return [
    styleBlock(book, r),
    refBlock(r),
    `SCENE — front cover illustration for the children's picture book "${book.title || 'Untitled'}" (ages ${book.ageRange}): ${book.cover.prompt || `an inviting, iconic scene that captures the story: ${book.premise}`}`,
    leads.length ? `Featuring:\n${leads.map(c => `- ${c.name}: ${c.description}`).join('\n')}` : '',
    `COMPOSITION — ${full ? `Portrait. Leave the ${top} quarter fairly simple (sky or soft background) because the title will be placed there.` : 'Portrait, with the main characters clearly framed.'} Bold, eye-catching, friendly.`,
    extra ? `EXTRA DIRECTION — ${extra}` : '',
    `Remember the art style: ${book.artStyle}. ${NO_TEXT}`,
  ].filter(Boolean).join('\n');
}

export function matterImagePrompt(book, matter, refs = null) {
  const r = refs || coverRefs(book);
  const scene = matter.type === 'the-end'
    ? `a small, heartwarming closing vignette for the end of the children's book "${book.title}": ${book.premise}`
    : matter.type === 'title'
      ? `a small spot illustration for the title page of the children's book "${book.title}", featuring the main character in a simple pose on a white background`
      : `${matter.text || matter.title || 'a decorative illustration'} — for the children's book "${book.title}"`;
  return [styleBlock(book, r), refBlock(r), `SCENE — ${scene}`, `Remember the art style: ${book.artStyle}. ${NO_TEXT}`].filter(Boolean).join('\n');
}

// Guidance block returned to MCP clients so they write in the right shape.
export function writingGuide(book) {
  const plan = computePlan(book);
  return `${storySystemPrompt(book)}

${storyPrompt(book, { slots: plan.capacity })}

When you have the story, call the write_story tool with the chapters array (each page: text, illustration, cast, layout).`;
}
