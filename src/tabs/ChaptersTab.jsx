import React, { useState, useEffect } from 'react';
import Loading from '../components/Loading.jsx';
import { buildProjectContext, buildChapterContext, generateChapterSummary, stripLeadingTitle } from '../promptUtils.js';

export default function ChaptersTab({ project, outline, chapters, setChapters, callClaude, callAsEditor, loading, setLoading }) {
  const writtenIndices = Object.keys(chapters).map(Number).sort((a, b) => a - b);
  const [currentIdx, setCurrentIdx] = useState(writtenIndices[0] ?? 0);
  const [revisionNotes, setRevisionNotes] = useState('');
  const [activeEditors, setActiveEditors] = useState(new Set());
  const [feedback, setFeedback] = useState([]); // Array of { editorName, text }

  // Sync revision notes when switching chapters
  useEffect(() => {
    setRevisionNotes(chapters[currentIdx]?.revisionNotes || '');
    setFeedback(chapters[currentIdx]?.feedback || []);
  }, [currentIdx, chapters]);

  const currentChapter = chapters[currentIdx];

  const updateChapterText = (text) => {
    setChapters(prev => ({
      ...prev,
      [currentIdx]: { ...prev[currentIdx], text }
    }));
  };

  const regenerateChapter = async (notes = '') => {
    const loadKey = 'regen_chapter';
    setLoading(l => ({ ...l, [loadKey]: true }));
    try {
      const ctx = buildProjectContext(project, currentIdx);
      const chapterCtx = buildChapterContext(outline, chapters, currentIdx);
      const sysPrompt = project.systemPrompt
        ? `You are a master novelist writing a full chapter of a novel. ${project.systemPrompt}`
        : 'You are a master novelist writing a full chapter of a novel.';

      let prompt = `PROJECT:\n${ctx}\n\nSTORY CONTEXT:\n${chapterCtx}\n\n`;

      if (notes) {
        prompt += `Here is the previous draft:\n\n${currentChapter?.text || ''}\n\nRevision notes:\n${notes}\n\nRewrite Chapter ${currentIdx + 1}: "${outline[currentIdx]?.title}" incorporating the revision notes. Target between ${project.chapterWordCountMin || 2000} and ${project.chapterWordCountMax || 5000} words. Write ONLY the revised chapter prose.`;
      } else {
        prompt += `Write Chapter ${currentIdx + 1}: "${outline[currentIdx]?.title}" in full. Target between ${project.chapterWordCountMin || 2000} and ${project.chapterWordCountMax || 5000} words — use the full range as the content demands. Write the complete chapter text. Do not include the chapter title, just begin the narrative.`;
      }

      let text = await callClaude([{ role: 'user', content: prompt }], sysPrompt);
      text = stripLeadingTitle(text, outline[currentIdx]?.title || '');

      // Regenerate the factual continuity summary
      let summary = '';
      try {
        summary = await generateChapterSummary(callClaude, text, outline[currentIdx]?.title, currentIdx);
      } catch (e) {
        console.warn('Failed to generate summary:', e);
      }

      setChapters(prev => ({
        ...prev,
        [currentIdx]: { ...prev[currentIdx], text, summary, revisionNotes: notes }
      }));
    } catch (err) {
      alert('Error regenerating: ' + err.message);
    } finally {
      setLoading(l => ({ ...l, [loadKey]: false }));
    }
  };

  const getEditorialFeedback = async () => {
    const loadKey = 'editorial';
    setLoading(l => ({ ...l, [loadKey]: true }));
    try {
      const activeList = activeEditors.size > 0
        ? project.editors.filter((_, i) => activeEditors.has(i))
        : project.editors;

      if (activeList.length === 0) {
        alert('No editors defined. Add editors in the Setup tab.');
        return;
      }

      const newFeedback = [];
      for (const editor of activeList) {
        const result = await callAsEditor(editor, [{
          role: 'user',
          content: `You are an editorial reviewer named "${editor.name}". ${editor.systemPrompt}\n\nReview the following chapter from the novel "${project.title}":\n\nChapter ${currentIdx + 1}: ${outline[currentIdx]?.title}\n\n${currentChapter?.text}\n\nProvide specific, actionable editorial feedback. Be detailed and constructive. Point out specific passages that could be improved and suggest how.`
        }]);
        newFeedback.push({ editorName: editor.name, text: result });
      }

      setFeedback(newFeedback);
      setChapters(prev => ({
        ...prev,
        [currentIdx]: { ...prev[currentIdx], feedback: newFeedback }
      }));
    } catch (err) {
      alert('Error getting feedback: ' + err.message);
    } finally {
      setLoading(l => ({ ...l, [loadKey]: false }));
    }
  };

  const rewriteEditorialFeedback = async () => {
    const loadKey = 'editorial';
    setLoading(l => ({ ...l, [loadKey]: true }));
    try {
      const activeList = activeEditors.size > 0
        ? project.editors.filter((_, i) => activeEditors.has(i))
        : project.editors;

      if (activeList.length === 0) {
        alert('No editors defined.');
        return;
      }

      // Re-generate feedback with potentially updated editor system prompts
      const newFeedback = [];
      for (const editor of activeList) {
        const result = await callAsEditor(editor, [{
          role: 'user',
          content: `You are an editorial reviewer named "${editor.name}". ${editor.systemPrompt}\n\nReview the following chapter from the novel "${project.title}":\n\nChapter ${currentIdx + 1}: ${outline[currentIdx]?.title}\n\n${currentChapter?.text}\n\nProvide specific, actionable editorial feedback. Be detailed and constructive.`
        }]);
        newFeedback.push({ editorName: editor.name, text: result });
      }

      setFeedback(newFeedback);
      setChapters(prev => ({
        ...prev,
        [currentIdx]: { ...prev[currentIdx], feedback: newFeedback }
      }));
    } catch (err) {
      alert('Error rewriting feedback: ' + err.message);
    } finally {
      setLoading(l => ({ ...l, [loadKey]: false }));
    }
  };

  const applyFeedbackToNotes = () => {
    const combined = feedback.map(f => `[${f.editorName}]:\n${f.text}`).join('\n\n---\n\n');
    setRevisionNotes(prev => prev ? prev + '\n\n---\n\n' + combined : combined);
  };

  const applySelectedFeedback = (editorName) => {
    const item = feedback.find(f => f.editorName === editorName);
    if (item) {
      setRevisionNotes(prev => prev ? prev + `\n\n[${item.editorName}]:\n${item.text}` : `[${item.editorName}]:\n${item.text}`);
    }
  };

  if (writtenIndices.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
        <p>No chapters written yet. Generate chapters from the Outline tab.</p>
      </div>
    );
  }

  return (
    <div>
      {/* CHAPTER SELECTOR */}
      <div className="chapter-viewer-header">
        <label style={{ whiteSpace: 'nowrap', margin: 0 }}>Chapter:</label>
        <select value={currentIdx} onChange={e => setCurrentIdx(Number(e.target.value))}>
          {outline.map((ch, i) => (
            <option key={i} value={i} disabled={!chapters[i]}>
              {`Ch ${i + 1}: ${ch.title}`}{chapters[i] ? '' : ' (not written)'}
            </option>
          ))}
        </select>
      </div>

      {currentChapter && (
        <>
          {/* CHAPTER TEXT */}
          <div className="chapter-content-area">
            <h2>Chapter {currentIdx + 1}: {outline[currentIdx]?.title}</h2>
            <textarea
              className="chapter-text"
              value={currentChapter.text}
              onChange={e => updateChapterText(e.target.value)}
              style={{ width: '100%', minHeight: 500 }}
            />
            <div className="flex-row mt-md">
              {loading.regen_chapter ? (
                <Loading text="Regenerating chapter..." />
              ) : (
                <button className="btn btn-accent" onClick={() => regenerateChapter()}>
                  Regenerate
                </button>
              )}
              <span className="text-muted">
                {currentChapter.text.split(/\s+/).filter(Boolean).length} words
              </span>
            </div>
          </div>

          {/* CONTINUITY SUMMARY */}
          <div className="revise-section mb-md" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--accent-dim)' }}>
            <h3 style={{ fontSize: '1rem' }}>Continuity Summary</h3>
            <p className="text-muted mb-sm" style={{ fontSize: '0.78rem' }}>
              Auto-generated factual summary of this chapter. Used to keep other chapters consistent. You can edit this manually.
            </p>
            <textarea
              value={currentChapter.summary || ''}
              onChange={e => setChapters(prev => ({
                ...prev,
                [currentIdx]: { ...prev[currentIdx], summary: e.target.value }
              }))}
              placeholder="No summary yet — will be generated when the chapter is written or regenerated."
              rows={4}
              style={{ fontSize: '0.85rem', lineHeight: '1.6' }}
            />
            <div className="flex-row mt-sm">
              {loading.regen_summary ? (
                <Loading text="Regenerating summary..." />
              ) : (
                <button className="btn btn-sm" onClick={async () => {
                  setLoading(l => ({ ...l, regen_summary: true }));
                  try {
                    const summary = await generateChapterSummary(callClaude, currentChapter.text, outline[currentIdx]?.title, currentIdx);
                    setChapters(prev => ({
                      ...prev,
                      [currentIdx]: { ...prev[currentIdx], summary }
                    }));
                  } catch (err) {
                    alert('Error: ' + err.message);
                  } finally {
                    setLoading(l => ({ ...l, regen_summary: false }));
                  }
                }}>
                  Regenerate Summary
                </button>
              )}
            </div>
          </div>

          {/* REVISE SECTION */}
          <div className="revise-section">
            <h3>Revise</h3>

            {/* Revision prompt */}
            <div className="mb-md">
              <label>Revision Notes / Prompt</label>
              <textarea
                className="large"
                value={revisionNotes}
                onChange={e => setRevisionNotes(e.target.value)}
                placeholder="Enter revision notes, editorial feedback, or specific instructions for rewriting..."
              />
              <div className="flex-row mt-sm">
                {loading.regen_chapter ? (
                  <Loading text="Rewriting..." />
                ) : (
                  <button
                    className="btn btn-accent"
                    onClick={() => regenerateChapter(revisionNotes)}
                    disabled={!revisionNotes.trim()}
                  >
                    Rewrite with Notes
                  </button>
                )}
              </div>
            </div>

            {/* Editor selection */}
            {project.editors.length > 0 && (
              <div className="mb-md">
                <label>Select Editors</label>
                <div className="editor-toggles">
                  {project.editors.map((ed, i) => (
                    <div
                      key={i}
                      className={`editor-toggle ${activeEditors.has(i) ? 'active' : ''}`}
                      onClick={() => {
                        const next = new Set(activeEditors);
                        if (next.has(i)) next.delete(i); else next.add(i);
                        setActiveEditors(next);
                      }}
                    >
                      {ed.name || `Editor ${i + 1}`}
                    </div>
                  ))}
                  <span className="text-muted" style={{ alignSelf: 'center' }}>
                    {activeEditors.size === 0 ? '(all editors)' : ''}
                  </span>
                </div>

                <div className="flex-row mt-sm">
                  {loading.editorial ? (
                    <Loading text="Getting editorial feedback..." />
                  ) : (
                    <>
                      <button className="btn" onClick={getEditorialFeedback}>
                        Write Editorial Comments
                      </button>
                      <button className="btn" onClick={rewriteEditorialFeedback}>
                        Rewrite Editorial Comments
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Feedback display */}
            {feedback.length > 0 && (
              <div className="editor-feedback">
                <label>Editorial Feedback</label>
                {feedback.map((f, i) => (
                  <div key={i} className="editor-feedback-item">
                    <div className="editor-name">{f.editorName}</div>
                    <div className="editor-notes">{f.text}</div>
                    <button
                      className="btn btn-sm mt-sm"
                      onClick={() => applySelectedFeedback(f.editorName)}
                    >
                      Apply to Revision Notes
                    </button>
                  </div>
                ))}
                <button className="btn btn-accent mt-sm" onClick={applyFeedbackToNotes}>
                  Apply All to Revision Notes
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
