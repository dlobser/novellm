// Novel data model, shared by the website and the MCP server.
// A novel is { project, outline, chapters } — the same shape as the website's Export JSON.
//   outline:  [{ title, description }]
//   chapters: { [zeroBasedIndex]: { text, summary, feedback: [{ editorName, text }], revisionNotes } }
// On the bridge it also carries id, rev, updatedAt.
import { buildProjectContext, buildOutlineContext, buildChapterContext, stripLeadingTitle } from './promptUtils.js';

export const DEFAULT_PROJECT = {
  title: '',
  synopsis: '',
  characters: [],
  settings: [],
  systemPrompt: '',
  editors: [],
  background: [],
  chapterWordCountMin: 2000,
  chapterWordCountMax: 5000,
  chapterCount: 25,
  frontBackMatter: {
    tableOfContents: true,
    bibliography: false,
    index: false,
    acknowledgements: false,
    copyrightNotice: false,
  },
  acknowledgementsText: '',
  copyrightText: '',
  bibliographyText: '',
  indexText: '',
};

export function normalizeProject(p) {
  const out = { ...DEFAULT_PROJECT, ...(p || {}) };
  if (out.chapterWordCount && !(p || {}).chapterWordCountMin) {
    out.chapterWordCountMin = out.chapterWordCount;
    out.chapterWordCountMax = out.chapterWordCount;
  }
  delete out.chapterWordCount;
  for (const k of ['characters', 'settings', 'editors', 'background']) if (!Array.isArray(out[k])) out[k] = [];
  out.frontBackMatter = { ...DEFAULT_PROJECT.frontBackMatter, ...(out.frontBackMatter || {}) };
  return out;
}

export function normalizeNovel(n) {
  const base = n || {};
  const chapters = {};
  for (const [k, v] of Object.entries(base.chapters || {})) {
    if (!v) continue;
    chapters[k] = { text: '', summary: '', feedback: [], revisionNotes: '', ...v };
  }
  return {
    ...base,
    project: normalizeProject(base.project),
    outline: Array.isArray(base.outline) ? base.outline.map(o => ({ title: o?.title || '', description: o?.description || '' })) : [],
    chapters,
  };
}

export const wordCount = t => (t || '').split(/\s+/).filter(Boolean).length;

const novelistSys = (project, role) => (project.systemPrompt ? `You are ${role}. ${project.systemPrompt}` : `You are ${role}.`);

// What to write for the outline (mirrors the website's "Generate outline").
export function outlineBrief(novel) {
  const { project } = novel;
  return {
    role: novelistSys(project, 'a master novelist and story architect'),
    task: `Write a detailed chapter-by-chapter outline. Each chapter needs a title and a one-paragraph description of what happens. `
      + `Write exactly ${project.chapterCount || 25} narrative chapters for a full-length novel. Do NOT include front or back matter (copyright, acknowledgements, bibliography, index, etc.) — only narrative chapters.`,
    projectContext: buildProjectContext(project),
    save: 'Save it with save_outline (chapters: [{ title, description }]).',
  };
}

// What to write for one chapter (mirrors the website's chapter writing / revising / editor review).
export function chapterBrief(novel, idx, { purpose = 'write', notes = '' } = {}) {
  const { project, outline, chapters } = novel;
  const o = outline[idx];
  if (!o) throw new Error(`There is no chapter ${idx + 1}; the outline has ${outline.length} chapters.`);
  const range = `between ${project.chapterWordCountMin || 2000} and ${project.chapterWordCountMax || 5000} words`;
  const current = chapters[idx];
  const head = { chapter: idx + 1, title: o.title, outline: o.description };
  if (purpose === 'review') {
    if (!current?.text) throw new Error(`Chapter ${idx + 1} hasn't been written yet.`);
    return {
      ...head,
      task: `Review Chapter ${idx + 1} of "${project.title}" as each editor below and give specific, actionable editorial feedback. Point out passages that could be improved and suggest how. Save each editor's feedback with save_chapter_feedback.`,
      editors: project.editors.length
        ? project.editors.map(e => ({ name: e.name, instructions: e.systemPrompt, sees: e.includeProjectKnowledge ? 'the project context too' : 'the chapter only' }))
        : [{ name: 'Editor', instructions: 'A thoughtful developmental and line editor.' }],
      projectContext: project.editors.some(e => e.includeProjectKnowledge) ? buildProjectContext(project, idx) : undefined,
      chapterText: current.text,
    };
  }
  const revising = purpose === 'revise';
  const revisionNotes = notes || current?.revisionNotes || '';
  if (revising && !current?.text) throw new Error(`Chapter ${idx + 1} hasn't been written yet, so there's nothing to revise.`);
  if (revising && !revisionNotes) throw new Error('Give revision notes (or save editor feedback first).');
  return {
    ...head,
    role: novelistSys(project, 'a master novelist writing a full chapter of a novel'),
    task: revising
      ? `Rewrite Chapter ${idx + 1}: "${o.title}" incorporating the revision notes. Target ${range}. Write ONLY the revised chapter prose.`
      : `Write Chapter ${idx + 1}: "${o.title}" in full. Target ${range} — use the full range as the content demands; give quieter moments room to breathe and keep action tight. Write the complete chapter text — no summaries, no outlines, just the prose. Do not include the chapter title at the start, just begin the narrative.`,
    ...(revising ? { previousDraft: current.text, revisionNotes } : {}),
    projectContext: buildProjectContext(project, idx),
    storyContext: buildChapterContext(outline, chapters, idx),
    save: 'Save it with write_chapter, including a short factual continuity summary (characters present, events, places, objects, relationship changes, time, promises/foreshadowing). Later chapters rely on these summaries.',
  };
}

export function chapterStatus(novel) {
  return novel.outline.map((o, i) => {
    const c = novel.chapters[i];
    return { chapter: i + 1, title: o.title, written: !!c?.text, words: wordCount(c?.text), hasSummary: !!c?.summary, feedback: c?.feedback?.length || 0 };
  });
}

export function novelSummary(novel) {
  const st = chapterStatus(novel);
  return {
    novelId: novel.id,
    title: novel.project.title,
    rev: novel.rev,
    chapters: novel.outline.length,
    chaptersWritten: st.filter(s => s.written).length,
    words: st.reduce((a, s) => a + s.words, 0),
  };
}

export function saveChapterText(novel, idx, { text, summary }) {
  const o = novel.outline[idx];
  if (!o) throw new Error(`There is no chapter ${idx + 1}; the outline has ${novel.outline.length} chapters. Add it with update_outline_chapter first.`);
  const prev = novel.chapters[idx] || {};
  const clean = stripLeadingTitle(text, o.title);
  return {
    ...novel,
    chapters: {
      ...novel.chapters,
      [idx]: { feedback: [], ...prev, text: clean, summary: summary ?? prev.summary ?? '', revisionNotes: '' },
    },
  };
}

// Insert or remove an outline entry and shift the written chapters with it.
export function insertChapterAt(novel, idx, entry) {
  const outline = [...novel.outline.slice(0, idx), entry, ...novel.outline.slice(idx)];
  const chapters = {};
  for (const [k, v] of Object.entries(novel.chapters)) chapters[Number(k) >= idx ? Number(k) + 1 : k] = v;
  return { ...novel, outline, chapters };
}

export function removeChapterAt(novel, idx) {
  const outline = novel.outline.filter((_, i) => i !== idx);
  const chapters = {};
  for (const [k, v] of Object.entries(novel.chapters)) {
    const n = Number(k);
    if (n < idx) chapters[n] = v;
    else if (n > idx) chapters[n - 1] = v;
  }
  return { ...novel, outline, chapters };
}

export function manuscript(novel, format = 'markdown') {
  const { project, outline, chapters } = novel;
  const md = format === 'markdown';
  let out = md ? `# ${project.title || 'Untitled'}\n\n` : `${(project.title || 'Untitled').toUpperCase()}\n\n`;
  outline.forEach((o, i) => {
    if (!chapters[i]?.text) return;
    out += md ? `## Chapter ${i + 1}: ${o.title}\n\n` : `\n\nCHAPTER ${i + 1}: ${o.title.toUpperCase()}\n\n`;
    out += `${chapters[i].text.trim()}\n\n`;
  });
  return out;
}

export { buildOutlineContext };
