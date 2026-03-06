import React, { useState, useMemo } from 'react';
import Loading from '../components/Loading.jsx';

export default function FullBookTab({ project, setProject, outline, chapters, callClaude, callAsEditor, loading, setLoading }) {
  const [activeEditors, setActiveEditors] = useState(new Set());
  const [bookFeedback, setBookFeedback] = useState([]);

  const up = (key, val) => setProject({ ...project, [key]: val });
  const fm = project.frontBackMatter || {};

  const fullText = useMemo(() => {
    let text = '';
    for (let i = 0; i < outline.length; i++) {
      if (chapters[i]) {
        text += `\n\nCHAPTER ${i + 1}: ${outline[i].title.toUpperCase()}\n\n`;
        text += chapters[i].text;
      }
    }
    return text.trim();
  }, [outline, chapters]);

  const totalWords = useMemo(() => fullText.split(/\s+/).filter(Boolean).length, [fullText]);
  const writtenCount = Object.keys(chapters).length;

  // Build a chapter summaries string for AI context
  const buildBookSummary = () => {
    return outline.map((ch, i) => {
      if (chapters[i]) {
        const summary = chapters[i].summary || chapters[i].text.substring(0, 300) + '...';
        return `Chapter ${i + 1}: ${ch.title}\nSummary: ${summary}`;
      }
      return `Chapter ${i + 1}: ${ch.title} [NOT WRITTEN]`;
    }).join('\n\n');
  };

  const generateSection = async (sectionKey, sectionName, extraPrompt = '') => {
    const loadKey = `gen_${sectionKey}`;
    setLoading(l => ({ ...l, [loadKey]: true }));
    try {
      const bookSummary = buildBookSummary();
      const result = await callClaude([{
        role: 'user',
        content: `You are helping finalize a book titled "${project.title}".\n\nSynopsis: ${project.synopsis}\n\nChapter structure:\n${bookSummary}\n\n${extraPrompt}\n\nWrite the ${sectionName} section for this book. Be genuine and appropriate for the book's tone and subject matter. Write ONLY the ${sectionName} text, no preamble.`
      }], project.systemPrompt || '');

      up(`${sectionKey}Text`, result);
    } catch (err) {
      alert('Error generating ' + sectionName + ': ' + err.message);
    } finally {
      setLoading(l => ({ ...l, [loadKey]: false }));
    }
  };

  const getBookEditorial = async () => {
    setLoading(l => ({ ...l, book_editorial: true }));
    try {
      const activeList = activeEditors.size > 0
        ? project.editors.filter((_, i) => activeEditors.has(i))
        : project.editors;

      if (activeList.length === 0) {
        alert('No editors defined.');
        return;
      }

      const newFeedback = [];
      for (const editor of activeList) {
        const chapterSummaries = outline.map((ch, i) => {
          if (chapters[i]) {
            const excerpt = chapters[i].text.substring(0, 500);
            return `Chapter ${i + 1}: ${ch.title}\n(${chapters[i].text.split(/\s+/).length} words)\nExcerpt: ${excerpt}...`;
          }
          return `Chapter ${i + 1}: ${ch.title} [NOT WRITTEN]`;
        }).join('\n\n');

        const result = await callAsEditor(editor, [{
          role: 'user',
          content: `You are "${editor.name}", an editorial reviewer. ${editor.systemPrompt}\n\nYou are reviewing the complete novel "${project.title}" with the following structure:\n\nSynopsis: ${project.synopsis}\n\n${chapterSummaries}\n\nProvide a comprehensive editorial review of the entire book. Comment on:\n- Overall narrative arc and pacing\n- Character development across chapters\n- Thematic consistency\n- Which specific chapters need the most revision and why\n- Suggestions for structural changes\n\nBe specific about which chapters need work and what kind of editing they need.`
        }]);
        newFeedback.push({ editorName: editor.name, text: result });
      }

      setBookFeedback(newFeedback);
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      setLoading(l => ({ ...l, book_editorial: false }));
    }
  };

  const matterSections = [
    {
      key: 'copyright',
      label: 'Copyright Notice',
      enabled: fm.copyrightNotice,
      toggle: () => up('frontBackMatter', { ...fm, copyrightNotice: !fm.copyrightNotice }),
      textKey: 'copyrightText',
      extraPrompt: 'Include standard copyright language, year, author rights, and any relevant legal notices.',
    },
    {
      key: 'acknowledgements',
      label: 'Acknowledgements',
      enabled: fm.acknowledgements,
      toggle: () => up('frontBackMatter', { ...fm, acknowledgements: !fm.acknowledgements }),
      textKey: 'acknowledgementsText',
      extraPrompt: 'Write warm, genuine acknowledgements thanking people who might have contributed to a book like this — editors, family, research subjects, inspirations. Make it feel personal and authentic.',
    },
    {
      key: 'bibliography',
      label: 'Bibliography',
      enabled: fm.bibliography,
      toggle: () => up('frontBackMatter', { ...fm, bibliography: !fm.bibliography }),
      textKey: 'bibliographyText',
      extraPrompt: project.background.length > 0
        ? `The author used these reference materials:\n${project.background.map(b => `- [${b.type}] ${b.name}`).join('\n')}\n\nGenerate a properly formatted bibliography based on these sources and any others that would be appropriate for this book's subject matter.`
        : 'Generate a plausible bibliography of sources that would be appropriate for this book\'s subject matter.',
    },
    {
      key: 'index',
      label: 'Index',
      enabled: fm.index,
      toggle: () => up('frontBackMatter', { ...fm, index: !fm.index }),
      textKey: 'indexText',
      extraPrompt: 'Generate an alphabetical index of key topics, names, places, and concepts from this book. Format as: Topic, Chapter numbers. Be thorough but not exhaustive.',
    },
    {
      key: 'tableOfContents',
      label: 'Table of Contents',
      enabled: fm.tableOfContents,
      toggle: () => up('frontBackMatter', { ...fm, tableOfContents: !fm.tableOfContents }),
      textKey: null, // TOC is auto-generated from outline, no text field needed
    },
  ];

  return (
    <div>
      <div className="flex-row mb-md" style={{ justifyContent: 'space-between' }}>
        <div>
          <span className="text-muted">{writtenCount} of {outline.length} chapters written</span>
          <span className="text-muted" style={{ marginLeft: 16 }}>{totalWords.toLocaleString()} total words</span>
        </div>
      </div>

      {/* FRONT & BACK MATTER */}
      <div className="revise-section mb-lg">
        <h3>Front & Back Matter</h3>
        <p className="text-muted mb-md">Toggle sections on/off, then generate or write them manually. These will be included in your exports.</p>

        {matterSections.map(sec => (
          <div key={sec.key} style={{
            background: 'var(--bg-tertiary)',
            border: `1px solid ${sec.enabled ? 'var(--accent-dim)' : 'var(--border)'}`,
            borderRadius: 'var(--radius)',
            padding: '14px 16px',
            marginBottom: 10,
          }}>
            <div className="flex-row" style={{ justifyContent: 'space-between', marginBottom: sec.enabled && sec.textKey ? 10 : 0 }}>
              <label style={{
                margin: 0,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                cursor: 'pointer',
                fontSize: '0.9rem',
                color: sec.enabled ? 'var(--accent)' : 'var(--text-secondary)',
              }}>
                <input
                  type="checkbox"
                  checked={!!sec.enabled}
                  onChange={sec.toggle}
                  style={{ accentColor: 'var(--accent)' }}
                />
                {sec.label}
              </label>

              {sec.enabled && sec.textKey && (
                <div className="flex-row">
                  {loading[`gen_${sec.key}`] ? (
                    <Loading text={`Generating ${sec.label.toLowerCase()}...`} />
                  ) : (
                    <button
                      className="btn btn-sm btn-accent"
                      onClick={() => generateSection(sec.key, sec.label, sec.extraPrompt)}
                    >
                      {project[sec.textKey] ? 'Regenerate' : 'Generate'} {sec.label}
                    </button>
                  )}
                </div>
              )}

              {sec.enabled && !sec.textKey && (
                <span className="text-muted" style={{ fontSize: '0.78rem' }}>Auto-generated from chapter list</span>
              )}
            </div>

            {sec.enabled && sec.textKey && (
              <textarea
                value={project[sec.textKey] || ''}
                onChange={e => up(sec.textKey, e.target.value)}
                placeholder={`Write your ${sec.label.toLowerCase()} here, or click Generate to have AI write it...`}
                rows={6}
                style={{ width: '100%', marginTop: 4 }}
              />
            )}
          </div>
        ))}
      </div>

      {/* Full Book Text */}
      {fullText ? (
        <div className="full-book-text">{fullText}</div>
      ) : (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
          <p>No chapters written yet.</p>
        </div>
      )}

      {/* Book-level editorial */}
      {project.editors.length > 0 && fullText && (
        <div className="revise-section mt-lg">
          <h3>Book-Level Editorial Review</h3>
          <p className="text-muted mb-md">Get editorial notes on the entire book with specific chapter-level suggestions.</p>

          <div className="editor-toggles mb-md">
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
          </div>

          {loading.book_editorial ? (
            <Loading text="Reviewing entire book..." />
          ) : (
            <button className="btn btn-accent" onClick={getBookEditorial}>
              Get Book Editorial Notes
            </button>
          )}

          {bookFeedback.length > 0 && (
            <div className="editor-feedback mt-md">
              {bookFeedback.map((f, i) => (
                <div key={i} className="editor-feedback-item">
                  <div className="editor-name">{f.editorName}</div>
                  <div className="editor-notes" style={{ whiteSpace: 'pre-wrap' }}>{f.text}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
