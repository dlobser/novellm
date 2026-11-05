// Prompt builders for kids books. Isomorphic (browser + MCP server).
import { STORY_LAYOUTS, CAST_KINDS, computePlan, findCast, storySlots } from './model.js';

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

const PAGE_SCHEMA = `{ "text": string (the words printed on the page), "illustration": string (a detailed visual scene description for the illustrator: who is where doing what, expressions, setting, time of day, composition — no dialogue), "cast": string[] (exact names of cast members visible on the page), "layout": one of ${Object.keys(STORY_LAYOUTS).map(k => `"${k}"`).join(', ')} }`;

export function storyPrompt(book, { slots = null } = {}) {
  const n = slots ?? storySlots(book);
  const chapters = book.chapterMode === 'chapters';
  const structure = chapters
    ? `Split the story into ${book.chapterCount || 3} short chapters, each with a title. The total number of pages across all chapters must be exactly ${n}.`
    : `Write it as one continuous story (a single chapter with an empty title) of exactly ${n} pages.`;
  return `Write a complete children's book.

${bookBrief(book)}

${structure}

Layout guidance: use "image-top" or "image-bottom" for most pages, "full-text-bottom"/"full-text-top" for big dramatic moments, "image-only" sparingly for wordless beats, and "text-only" rarely. Keep each page's text within the word budget so it fits on a 5.5 × 8.5 inch page.
Use the cast names exactly as given when they appear. You may introduce minor background characters in illustration notes, but keep the main cast consistent.

Return ONLY valid JSON (no markdown fences) of the form:
{ "title": string, "blurb": string (2-3 sentence back-cover blurb), "chapters": [ { "title": string, "pages": [ ${PAGE_SCHEMA} ] } ] }`;
}

export function chapterPlanPrompt(book, { slots = null } = {}) {
  const n = slots ?? storySlots(book);
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
  const n = ch.targetPages || Math.max(2, Math.floor(storySlots(book) / book.chapters.length));
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

export function sheetPrompt(book, member, hasRefs) {
  const style = `Art style: ${book.artStyle}.`;
  const match = hasRefs
    ? 'Match the design in the attached reference image(s) exactly — same shapes, proportions, colors, clothing and markings — but render it cleanly in the art style above.'
    : '';
  const notes = member.sheetNotes ? `Extra notes: ${member.sheetNotes}` : '';
  if (member.kind === 'environment') {
    return `Environment concept sheet for a children's picture book: "${member.name}". ${member.description}
Show one wide establishing view on top and two smaller alternate views below (a different angle and a closer detail). No characters. ${style} ${match} ${notes} ${NO_TEXT}`;
  }
  if (member.kind === 'prop') {
    return `Prop design sheet for a children's picture book: "${member.name}". ${member.description}
Show the object from the front, side, three-quarter and back, plus one close-up detail, evenly spaced on a plain white background. ${style} ${match} ${notes} ${NO_TEXT}`;
  }
  return `Character model sheet (turnaround) for a children's picture book: "${member.name}". ${member.description}
Top row: full body front, three-quarter, side and back views at the same scale. Bottom row: four head close-ups showing happy, surprised, sad and determined expressions. Plain white background, even lighting, consistent proportions in every view. ${style} ${match} ${notes} ${NO_TEXT}`;
}

// Which reference images to send with a page illustration.
export function pageRefs(book, page) {
  const refs = [];
  (page.cast || []).forEach(name => {
    const m = findCast(book, name);
    if (!m) return;
    const id = m.activeSheet || m.sheets[m.sheets.length - 1] || m.refs[0];
    if (id) refs.push({ id, label: `${m.name} (${CAST_KINDS[m.kind] || m.kind} reference sheet)` });
  });
  // Environment mentioned in the illustration text but not in cast list.
  book.cast.filter(c => c.kind === 'environment').forEach(m => {
    if (refs.some(r => r.label.startsWith(m.name))) return;
    if (m.name && (page.illustration || '').toLowerCase().includes(m.name.toLowerCase())) {
      const id = m.activeSheet || m.sheets[m.sheets.length - 1] || m.refs[0];
      if (id) refs.push({ id, label: `${m.name} (environment reference)` });
    }
  });
  (book.styleRefs || []).slice(0, 1).forEach(id => refs.push({ id, label: 'art style reference' }));
  return refs.slice(0, 6);
}

export function pagePrompt(book, page, { pageNumber, extra = '' } = {}) {
  const layout = STORY_LAYOUTS[page.layout] || STORY_LAYOUTS['image-top'];
  let comp = '';
  if (page.layout === 'full-text-bottom') comp = 'Full-page portrait composition. Keep the bottom third simple and uncluttered (sky, ground, soft background) because a text box will sit there.';
  else if (page.layout === 'full-text-top') comp = 'Full-page portrait composition. Keep the top third simple and uncluttered because a text box will sit there.';
  else if (page.layout === 'image-only') comp = 'Full-page portrait composition, edge to edge.';
  else comp = `Square vignette composition (${layout.aspect}), subject centered with breathing room around the edges.`;
  const cast = (page.cast || []).map(n => {
    const m = findCast(book, n);
    return m ? `${m.name}: ${m.description}` : n;
  }).join('\n');
  return `Illustration for ${pageNumber ? `page ${pageNumber} of ` : ''}the children's picture book "${book.title || 'Untitled'}" (ages ${book.ageRange}).
Scene: ${page.illustration || page.text}
${page.text ? `The words on this page read: "${page.text}"` : ''}
${cast ? `Characters/props in the scene (keep them exactly on-model with the attached reference sheets):\n${cast}` : ''}
${comp}
Art style: ${book.artStyle}.
${extra}
${NO_TEXT}`.replace(/\n{2,}/g, '\n');
}

export function coverPrompt(book, extra = '') {
  const leads = book.cast.filter(c => c.kind === 'character').slice(0, 3);
  const top = book.cover.layout === 'full-title-bottom' ? 'bottom' : 'top';
  const full = book.cover.layout === 'full-title-top' || book.cover.layout === 'full-title-bottom';
  return `Front cover illustration for the children's picture book "${book.title || 'Untitled'}" (ages ${book.ageRange}).
${book.cover.prompt || `An inviting, iconic scene that captures the story: ${book.premise}`}
${leads.length ? `Feature: ${leads.map(c => `${c.name} (${c.description})`).join('; ')}. Keep them exactly on-model with the attached reference sheets.` : ''}
${full ? `Portrait composition. Leave the ${top} quarter fairly simple (sky or soft background) because the title will be placed there.` : 'Portrait composition with the main characters clearly framed.'}
Art style: ${book.artStyle}. Bold, eye-catching, friendly.
${extra}
${NO_TEXT}`.replace(/\n{2,}/g, '\n');
}

export function coverRefs(book) {
  const refs = [];
  book.cast.filter(c => c.kind === 'character').slice(0, 3).forEach(m => {
    const id = m.activeSheet || m.sheets[m.sheets.length - 1] || m.refs[0];
    if (id) refs.push({ id, label: `${m.name} (character reference sheet)` });
  });
  (book.styleRefs || []).slice(0, 1).forEach(id => refs.push({ id, label: 'art style reference' }));
  return refs;
}

export function matterImagePrompt(book, matter) {
  if (matter.type === 'the-end') return `A small, heartwarming closing vignette for the end of the children's book "${book.title}": ${book.premise}. Art style: ${book.artStyle}. ${NO_TEXT}`;
  if (matter.type === 'title') return `A small spot illustration for the title page of the children's book "${book.title}", featuring the main character in a simple pose, white background. Art style: ${book.artStyle}. ${NO_TEXT}`;
  return `${matter.text || matter.title || 'Decorative illustration'} — for the children's book "${book.title}". Art style: ${book.artStyle}. ${NO_TEXT}`;
}

// Guidance block returned to MCP clients so they write in the right shape.
export function writingGuide(book) {
  const plan = computePlan(book);
  return `${storySystemPrompt(book)}

${storyPrompt(book, { slots: plan.slots })}

When you have the story, call the write_story tool with the chapters array (each page: text, illustration, cast, layout).`;
}
