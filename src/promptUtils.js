// Strip leading chapter title/heading that Claude sometimes adds despite instructions
export function stripLeadingTitle(text, chapterTitle) {
  let t = text.trimStart();
  // Remove leading markdown headings like "# Chapter 1: Title" or "## Title"
  t = t.replace(/^#{1,3}\s*(chapter\s*\d+[:\-–—]?\s*)?/i, '');
  // If the first line closely matches the chapter title, remove it
  const lines = t.split('\n');
  if (lines.length > 1) {
    const firstLine = lines[0].trim().replace(/^#+\s*/, '').replace(/^\*+\s*/, '').replace(/\*+$/, '');
    const titleClean = chapterTitle.trim();
    // Check if first line is just the title (fuzzy match)
    if (
      firstLine.toLowerCase() === titleClean.toLowerCase() ||
      firstLine.toLowerCase().startsWith(`chapter`) && firstLine.toLowerCase().includes(titleClean.toLowerCase()) ||
      firstLine.toLowerCase().replace(/[^a-z0-9\s]/g, '') === titleClean.toLowerCase().replace(/[^a-z0-9\s]/g, '')
    ) {
      lines.shift();
      // Also remove blank line after title if present
      if (lines[0] && !lines[0].trim()) lines.shift();
      t = lines.join('\n');
    }
  }
  return t.trimStart();
}

// Build context string from project data
// chapterIdx is optional — if provided, only background items tagged to that chapter (or "all") are included
export function buildProjectContext(project, chapterIdx = null) {
  let ctx = '';
  ctx += `TITLE: ${project.title}\n\n`;
  ctx += `SYNOPSIS:\n${project.synopsis}\n\n`;

  if (project.characters.length > 0) {
    ctx += `CHARACTERS:\n`;
    project.characters.forEach(c => { ctx += `- ${c}\n`; });
    ctx += '\n';
  }

  if (project.settings.length > 0) {
    ctx += `WORLD & DETAILS:\n`;
    project.settings.forEach(s => { ctx += `- ${s}\n`; });
    ctx += '\n';
  }

  if (project.background.length > 0) {
    // Filter background items by chapter association
    const relevant = project.background.filter(b => {
      if (!b.chapters || b.chapters === 'all' || (Array.isArray(b.chapters) && b.chapters.length === 0)) {
        return true; // global — always included
      }
      if (chapterIdx === null) return true; // no chapter specified, include everything (outline generation)
      return Array.isArray(b.chapters) && b.chapters.includes(chapterIdx);
    });

    if (relevant.length > 0) {
      ctx += `BACKGROUND / REFERENCE MATERIALS:\n`;
      relevant.forEach(b => {
        ctx += `[${(b.type || 'reference').toUpperCase()}] ${b.name}:\n${b.content}\n\n`;
      });
    }
  }

  return ctx;
}

export function buildOutlineContext(outline) {
  if (!outline || outline.length === 0) return '';
  let ctx = 'CHAPTER OUTLINE:\n';
  outline.forEach((ch, i) => {
    ctx += `Chapter ${i + 1}: ${ch.title}\n${ch.description}\n\n`;
  });
  return ctx;
}

export function buildChapterContext(outline, chapters, currentIdx) {
  // Include outline descriptions + factual summaries of written chapters
  // Chapters can be written in any order, so every written chapter gets its summary
  let ctx = 'STORY CONTEXT BY CHAPTER:\n\n';
  for (let i = 0; i < outline.length; i++) {
    if (i === currentIdx) {
      ctx += `--- CURRENT CHAPTER (Chapter ${i + 1}: ${outline[i].title}) ---\n`;
      ctx += `Outline: ${outline[i].description}\n\n`;
    } else if (chapters[i]) {
      ctx += `Chapter ${i + 1}: ${outline[i].title} [WRITTEN]\n`;
      // Always include the factual summary if available
      if (chapters[i].summary) {
        ctx += `Facts & Events: ${chapters[i].summary}\n`;
      }
      ctx += `Outline: ${outline[i].description}\n`;
      // For adjacent chapters (prev and next), include full text for seamless continuity
      if (i === currentIdx - 1 || i === currentIdx + 1) {
        ctx += `Full text:\n${chapters[i].text}\n`;
      }
      ctx += '\n';
    } else {
      ctx += `Chapter ${i + 1}: ${outline[i].title} [NOT YET WRITTEN]\n`;
      ctx += `Outline: ${outline[i].description}\n\n`;
    }
  }
  return ctx;
}

// Generate a factual continuity summary of a chapter
export async function generateChapterSummary(callClaude, chapterText, chapterTitle, chapterIdx) {
  const result = await callClaude([{
    role: 'user',
    content: `Read the following chapter and produce a brief factual summary focused ONLY on continuity-critical details. Include:\n- Character names introduced or present, and what they did\n- Key events, decisions, and actions taken\n- Locations visited or described\n- Objects, items, or information gained or lost\n- Relationship changes between characters\n- Time of day, weather, or temporal details if mentioned\n- Any promises, plans, threats, or foreshadowing\n- Physical descriptions, injuries, or changes to characters\n- Any facts that a future or past chapter would need to remain consistent\n\nDo NOT include literary analysis, themes, or opinions. Just facts.\n\nChapter ${chapterIdx + 1}: ${chapterTitle}\n\n${chapterText}\n\nRespond with ONLY the factual summary, no preamble.`
  }]);
  return result;
}
