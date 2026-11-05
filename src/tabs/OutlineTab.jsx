import React, { useState } from 'react';
import Loading from '../components/Loading.jsx';
import { buildProjectContext, buildOutlineContext, buildChapterContext, generateChapterSummary, stripLeadingTitle } from '../promptUtils.js';
import { PROVIDER_CATALOG } from '../App.jsx';

export default function OutlineTab({ project, outline, setOutline, chapters, setChapters, callClaude, callClaudeStreaming, callAsEditor, loading, setLoading, setTab, cancelRef, activeProvider }) {
  const compact = (PROVIDER_CATALOG[activeProvider]?.contextWindow || 200000) < 64000;
  const [selected, setSelected] = useState(new Set());
  const [editorsForGenerate, setEditorsForGenerate] = useState(new Set());
  const [outlineNotes, setOutlineNotes] = useState({}); // per-chapter notes for outline regeneration
  const [isBatchRunning, setIsBatchRunning] = useState(false);

  const updateChapter = (idx, field, val) => {
    const next = [...outline];
    next[idx] = { ...next[idx], [field]: val };
    setOutline(next);
  };

  const toggleSelect = (idx) => {
    const next = new Set(selected);
    if (next.has(idx)) next.delete(idx); else next.add(idx);
    setSelected(next);
  };

  const selectAll = () => {
    if (selected.size === outline.length) setSelected(new Set());
    else setSelected(new Set(outline.map((_, i) => i)));
  };

  const moveChapter = (idx, direction) => {
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= outline.length) return;

    const newOutline = [...outline];
    [newOutline[idx], newOutline[newIdx]] = [newOutline[newIdx], newOutline[idx]];
    setOutline(newOutline);

    const newChapters = { ...chapters };
    const chA = chapters[idx];
    const chB = chapters[newIdx];
    if (chA !== undefined || chB !== undefined) {
      if (chA !== undefined) newChapters[newIdx] = chA; else delete newChapters[newIdx];
      if (chB !== undefined) newChapters[idx] = chB; else delete newChapters[idx];
      setChapters(newChapters);
    }

    const newSelected = new Set();
    selected.forEach(s => {
      if (s === idx) newSelected.add(newIdx);
      else if (s === newIdx) newSelected.add(idx);
      else newSelected.add(s);
    });
    setSelected(newSelected);
  };

  const deleteChapter = (idx) => {
    if (!confirm(`Delete Chapter ${idx + 1}: "${outline[idx].title}"? This will also delete any written text for this chapter.`)) return;

    const newOutline = outline.filter((_, i) => i !== idx);
    setOutline(newOutline);

    const newChapters = {};
    Object.keys(chapters).forEach(k => {
      const ki = Number(k);
      if (ki < idx) newChapters[ki] = chapters[ki];
      else if (ki > idx) newChapters[ki - 1] = chapters[ki];
    });
    setChapters(newChapters);

    const newSelected = new Set();
    selected.forEach(s => {
      if (s < idx) newSelected.add(s);
      else if (s > idx) newSelected.add(s - 1);
    });
    setSelected(newSelected);
  };

  const regenerateOutlineChapter = async (idx) => {
    setLoading(l => ({ ...l, [`outline_${idx}`]: true }));
    try {
      const ctx = buildProjectContext(project);
      const outlineCtx = buildOutlineContext(outline);
      const sysPrompt = project.systemPrompt
        ? `You are a master novelist. ${project.systemPrompt}`
        : 'You are a master novelist.';

      const notes = outlineNotes[idx] || '';
      let notesInstruction = '';
      if (notes.trim()) {
        notesInstruction = `\n\nThe author has provided the following editorial notes for this chapter. Use these to guide your revision:\n${notes}`;
      }

      const result = await callClaude([{
        role: 'user',
        content: `Here is the full novel project context:\n${ctx}\n\nHere is the current outline:\n${outlineCtx}\n\nRegenerate ONLY Chapter ${idx + 1} ("${outline[idx].title}"). Provide an updated title and description. Return ONLY valid JSON: {"title": "...", "description": "..."}${notesInstruction}\nNo markdown, no code fences.`
      }], sysPrompt);

      const cleaned = result.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const parsed = JSON.parse(cleaned);
      updateChapter(idx, 'title', parsed.title);
      updateChapter(idx, 'description', parsed.description);
    } catch (err) {
      alert('Error regenerating chapter outline: ' + err.message);
    } finally {
      setLoading(l => ({ ...l, [`outline_${idx}`]: false }));
    }
  };

  const generateChapterText = async (idx, withEditorial = false, batch = false) => {
    const loadKey = `gen_ch_${idx}`;
    setLoading(l => ({ ...l, [loadKey]: true }));
    try {
      const ctx = buildProjectContext(project, idx);
      const chapterCtx = buildChapterContext(outline, chapters, idx, compact);
      const sysPrompt = project.systemPrompt
        ? `You are a master novelist writing a full chapter of a novel. ${project.systemPrompt}`
        : 'You are a master novelist writing a full chapter of a novel.';

      // Use streaming to show text as it generates
      const onChunk = (partialText) => {
        setChapters(prev => ({
          ...prev,
          [idx]: { ...(prev[idx] || {}), text: partialText, summary: prev[idx]?.summary || '', feedback: prev[idx]?.feedback || [], revisionNotes: '' }
        }));
      };

      let text = await callClaudeStreaming([{
        role: 'user',
        content: `PROJECT:\n${ctx}\n\nSTORY CONTEXT:\n${chapterCtx}\n\nWrite Chapter ${idx + 1}: "${outline[idx].title}" in full. Target between ${project.chapterWordCountMin || 2000} and ${project.chapterWordCountMax || 5000} words — use the full range as the content demands; give quieter moments room to breathe and keep action tight. Write the complete chapter text — no summaries, no outlines, just the actual prose of the chapter. Do not include the chapter title at the start, just begin the narrative.`
      }], sysPrompt, onChunk);

      if (withEditorial && project.editors.length > 0) {
        const activeEditors = editorsForGenerate.size > 0
          ? project.editors.filter((_, i) => editorsForGenerate.has(i))
          : project.editors;

        let allFeedback = '';
        for (const editor of activeEditors) {
          // Build editor prompt with optional project knowledge
          let editorPrompt = `You are an editorial reviewer named "${editor.name}". ${editor.systemPrompt}`;
          if (editor.includeProjectKnowledge) {
            editorPrompt += `\n\nProject context:\n${ctx}`;
          }
          const feedback = await callAsEditor(editor, [{
            role: 'user',
            content: `${editorPrompt}\n\nReview the following chapter from the novel "${project.title}":\n\nChapter ${idx + 1}: ${outline[idx].title}\n\n${text}\n\nProvide specific, actionable editorial feedback. Focus on what could be improved. Be detailed and constructive.`
          }]);
          allFeedback += `[${editor.name}]: ${feedback}\n\n`;
        }

        text = await callClaudeStreaming([{
          role: 'user',
          content: `PROJECT:\n${ctx}\n\nSTORY CONTEXT:\n${chapterCtx}\n\nHere is the first draft of Chapter ${idx + 1}:\n\n${text}\n\nHere is editorial feedback:\n\n${allFeedback}\n\nRewrite the chapter incorporating the editorial feedback. Target between ${project.chapterWordCountMin || 2000} and ${project.chapterWordCountMax || 5000} words. Write ONLY the revised chapter prose.`
        }], sysPrompt, onChunk);
      }

      text = stripLeadingTitle(text, outline[idx].title);

      let summary = '';
      try {
        summary = await generateChapterSummary(callClaude, text, outline[idx].title, idx);
      } catch (e) {
        console.warn('Failed to generate summary:', e);
      }

      setChapters(prev => ({
        ...prev,
        [idx]: { text, summary, feedback: [], revisionNotes: '' }
      }));
      if (!batch) setTab(2);
    } catch (err) {
      alert('Error generating chapter: ' + err.message);
    } finally {
      setLoading(l => ({ ...l, [loadKey]: false }));
    }
  };

  const generateMultiple = async (indices, withEditorial = false) => {
    cancelRef.current = false;
    setIsBatchRunning(true);
    for (const idx of indices) {
      if (cancelRef.current) break;
      await generateChapterText(idx, withEditorial, true);
    }
    setIsBatchRunning(false);
    cancelRef.current = false;
    setTab(2);
  };

  const handleCancel = () => {
    cancelRef.current = true;
  };

  if (outline.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
        <p>No outline yet. Go to the Setup tab and generate one.</p>
        <button className="btn mt-md" onClick={() => setTab(0)}>← Go to Setup</button>
      </div>
    );
  }

  return (
    <div>
      {/* CONTROLS */}
      <div className="flex-row mb-md" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div className="flex-row">
          <button className="btn btn-sm" onClick={selectAll}>
            {selected.size === outline.length ? 'Deselect All' : 'Select All'}
          </button>
          <button
            className="btn btn-accent btn-sm"
            disabled={selected.size === 0 || isBatchRunning}
            onClick={() => generateMultiple([...selected])}
          >
            Generate Selected ({selected.size})
          </button>
          <button
            className="btn btn-accent btn-sm"
            disabled={isBatchRunning}
            onClick={() => generateMultiple(outline.map((_, i) => i))}
          >
            Generate All
          </button>
          <button
            className="btn btn-sm"
            disabled={selected.size === 0 || isBatchRunning}
            onClick={() => generateMultiple([...selected], true)}
          >
            Generate Selected w/ Editorial
          </button>
          <button
            className="btn btn-sm"
            disabled={isBatchRunning}
            onClick={() => generateMultiple(outline.map((_, i) => i), true)}
          >
            Generate All w/ Editorial
          </button>
          {isBatchRunning && (
            <button className="btn btn-danger btn-sm" onClick={handleCancel}>
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* EDITOR SELECTION FOR BATCH */}
      {project.editors.length > 0 && (
        <div className="mb-md">
          <label>Editors for batch generation:</label>
          <div className="editor-toggles">
            {project.editors.map((ed, i) => (
              <div
                key={i}
                className={`editor-toggle ${editorsForGenerate.has(i) ? 'active' : ''}`}
                onClick={() => {
                  const next = new Set(editorsForGenerate);
                  if (next.has(i)) next.delete(i); else next.add(i);
                  setEditorsForGenerate(next);
                }}
              >
                {ed.name || `Editor ${i + 1}`}
              </div>
            ))}
            <span className="text-muted" style={{ alignSelf: 'center' }}>
              {editorsForGenerate.size === 0 ? '(all editors will be used)' : ''}
            </span>
          </div>
        </div>
      )}

      {/* CHAPTER CARDS */}
      {outline.map((ch, idx) => (
        <div key={idx} className="chapter-card">
          <div className="chapter-card-header" onClick={() => toggleSelect(idx)}>
            <input
              type="checkbox"
              checked={selected.has(idx)}
              onChange={() => toggleSelect(idx)}
              onClick={e => e.stopPropagation()}
            />
            <span className="ch-num">{String(idx + 1).padStart(2, '0')}</span>
            <input
              type="text"
              className="ch-title"
              value={ch.title}
              onChange={e => updateChapter(idx, 'title', e.target.value)}
              onClick={e => e.stopPropagation()}
              style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', fontFamily: 'var(--font-display)', fontSize: '1.05rem' }}
            />
            {chapters[idx] && <span style={{ color: 'var(--success)', fontSize: '0.75rem' }}>✓ Written</span>}
          </div>
          <div className="chapter-card-body">
            <textarea
              value={ch.description}
              onChange={e => updateChapter(idx, 'description', e.target.value)}
              rows={3}
              style={{ width: '100%' }}
            />
            {/* Outline regeneration notes */}
            <div className="outline-notes-input">
              <textarea
                value={outlineNotes[idx] || ''}
                onChange={e => setOutlineNotes(prev => ({ ...prev, [idx]: e.target.value }))}
                placeholder="Editorial notes for outline regeneration (optional) — e.g. 'focus more on the betrayal subplot' or 'move the confrontation earlier'"
                rows={2}
                style={{ width: '100%' }}
              />
            </div>
          </div>
          <div className="chapter-card-actions">
            {loading[`outline_${idx}`] ? (
              <Loading text="Regenerating outline..." />
            ) : (
              <button className="btn btn-sm" onClick={() => regenerateOutlineChapter(idx)}>
                {outlineNotes[idx]?.trim() ? 'Regenerate Outline w/ Notes' : 'Regenerate Outline'}
              </button>
            )}
            {loading[`gen_ch_${idx}`] ? (
              <Loading text="Writing chapter..." />
            ) : (
              <>
                <button className="btn btn-accent btn-sm" onClick={() => generateChapterText(idx)}>Generate Chapter</button>
                {project.editors.length > 0 && (
                  <button className="btn btn-sm" onClick={() => generateChapterText(idx, true)}>Generate w/ Editorial</button>
                )}
              </>
            )}
            <span style={{ borderLeft: '1px solid var(--border)', height: 20, margin: '0 4px' }} />
            <button className="btn btn-sm" onClick={() => moveChapter(idx, -1)} disabled={idx === 0} title="Move up">↑</button>
            <button className="btn btn-sm" onClick={() => moveChapter(idx, 1)} disabled={idx === outline.length - 1} title="Move down">↓</button>
            <button className="btn btn-sm btn-danger" onClick={() => deleteChapter(idx)} title="Delete chapter">✕</button>
          </div>
        </div>
      ))}

      {/* ADD CHAPTER */}
      <div className="flex-row mt-md">
        <button className="btn btn-sm" onClick={() => setOutline([...outline, { title: `Chapter ${outline.length + 1}`, description: '' }])}>
          + Add Chapter
        </button>
      </div>
    </div>
  );
}
