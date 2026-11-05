import React, { useState } from 'react';
import CollapsibleSection from '../components/CollapsibleSection.jsx';
import DynamicArray from '../components/DynamicArray.jsx';
import Loading from '../components/Loading.jsx';
import { buildProjectContext } from '../promptUtils.js';
import { PROVIDER_CATALOG } from '../App.jsx';

const BACKGROUND_TYPES = ['research', 'character bio', 'world building', 'style guide', 'interview', 'source material', 'statistics', 'timeline', 'notes', 'other'];

export default function SetupTab({ project, setProject, callClaude, outline, setOutline, loading, setLoading, setTab, chapterCount }) {
  const up = (key, val) => setProject({ ...project, [key]: val });
  const [autofillMode, setAutofillMode] = useState(null); // null, 'replace', 'append'

  const autofillFromSynopsis = async (mode) => {
    setAutofillMode(null);
    if (!project.synopsis.trim()) {
      alert('Write a synopsis first, then click Autofill.');
      return;
    }
    setLoading(l => ({ ...l, autofill: true }));
    try {
      const sysPrompt = 'You are an expert story analyst and writing assistant.';
      const result = await callClaude([{
        role: 'user',
        content: `Analyze the following synopsis and extract/generate structured information for a novel project. Return ONLY valid JSON with no markdown or code fences.\n\nSynopsis:\n${project.synopsis}\n\n${project.title ? `Title: ${project.title}\n\n` : ''}Return a JSON object with these fields:\n- "title": a suggested title for the novel (generate one even if a title was provided above — the user can choose whether to use it).\n- "characters": array of strings, each describing a character (name, role, brief description). Include all characters mentioned or implied.\n- "settings": array of strings, each describing a key location, time period, object, or world detail.\n- "background": array of objects with {"type": string, "name": string, "content": string, "chapters": "all"}. Type should be one of: "character bio", "world building", "style guide", "timeline", "notes". Generate 2-4 detailed background entries covering the most important elements (key character bios, world details, timeline if relevant).\n- "systemPrompt": a suggested writing style prompt based on the tone and genre implied by the synopsis (1-2 sentences).\n\nBe thorough — extract every character, location, and detail you can infer. For background entries, write substantive content (several sentences each). Respond with ONLY the JSON object.`
      }], sysPrompt);

      const cleaned = result.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch (e) {
        const match = result.match(/\{[\s\S]*\}/);
        if (match) parsed = JSON.parse(match[0]);
        else throw new Error('Could not parse AI response');
      }

      const updates = {};
      if (parsed.characters && Array.isArray(parsed.characters)) {
        updates.characters = mode === 'replace' ? parsed.characters : [...(project.characters || []), ...parsed.characters];
      }
      if (parsed.settings && Array.isArray(parsed.settings)) {
        updates.settings = mode === 'replace' ? parsed.settings : [...(project.settings || []), ...parsed.settings];
      }
      if (parsed.background && Array.isArray(parsed.background)) {
        const newBg = parsed.background.map(b => ({
          type: b.type || 'notes',
          name: b.name || '',
          content: b.content || '',
          chapters: b.chapters || 'all',
        }));
        updates.background = mode === 'replace' ? newBg : [...(project.background || []), ...newBg];
      }
      if (parsed.title && (!project.title || mode === 'replace')) {
        updates.title = parsed.title;
      }
      if (parsed.systemPrompt && (!project.systemPrompt || mode === 'replace')) {
        updates.systemPrompt = parsed.systemPrompt;
      }

      setProject(prev => ({ ...prev, ...updates }));
    } catch (err) {
      alert('Error autofilling: ' + err.message);
    } finally {
      setLoading(l => ({ ...l, autofill: false }));
    }
  };

  const generateOutline = async () => {
    setLoading(l => ({ ...l, outline: true }));
    try {
      const ctx = buildProjectContext(project);
      const sysPrompt = project.systemPrompt
        ? `You are a master novelist and story architect. ${project.systemPrompt}`
        : 'You are a master novelist and story architect.';

      const result = await callClaude([
        {
          role: 'user',
          content: `Based on the following novel project, generate a detailed chapter-by-chapter outline. Each chapter should have a title and a one-paragraph description of what happens. Return ONLY valid JSON — an array of objects with "title" and "description" fields. No markdown, no code fences, no preamble.\n\n${ctx}\n\nGenerate exactly ${project.chapterCount || 25} narrative chapters for a full-length novel. Do NOT include front or back matter (copyright, acknowledgements, bibliography, index, etc.) — only narrative chapters.\n\nRespond with ONLY the JSON array.`
        }
      ], sysPrompt);

      // Parse JSON from response
      let parsed;
      try {
        const cleaned = result.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        parsed = JSON.parse(cleaned);
      } catch (e) {
        // Try to extract JSON array
        const match = result.match(/\[[\s\S]*\]/);
        if (match) {
          parsed = JSON.parse(match[0]);
        } else {
          throw new Error('Could not parse outline from AI response');
        }
      }

      setOutline(parsed);
      setTab(1); // Switch to outline tab
    } catch (err) {
      alert('Error generating outline: ' + err.message);
    } finally {
      setLoading(l => ({ ...l, outline: false }));
    }
  };

  return (
    <div>
      {/* TITLE */}
      <div className="section mb-md">
        <label>Title</label>
        <input
          type="text"
          value={project.title}
          onChange={e => up('title', e.target.value)}
          placeholder="The Great American Novel..."
        />
      </div>

      {/* SYNOPSIS */}
      <div className="section mb-md">
        <label>Synopsis</label>
        <textarea
          className="large"
          value={project.synopsis}
          onChange={e => up('synopsis', e.target.value)}
          placeholder="A sweeping tale of..."
        />
      </div>

      {/* AUTOFILL */}
      <div className="mb-md" style={{ textAlign: 'center' }}>
        {loading.autofill ? (
          <Loading text="Analyzing synopsis..." />
        ) : (
          <button className="btn btn-accent" onClick={() => {
            const hasExisting = (project.characters?.length > 0) || (project.settings?.length > 0) || (project.background?.length > 0) || project.systemPrompt || project.title;
            if (hasExisting) {
              setAutofillMode('pending');
            } else {
              autofillFromSynopsis('replace');
            }
          }} disabled={!project.synopsis.trim()}>
            Autofill from Synopsis
          </button>
        )}
        <p className="text-muted mt-sm" style={{ fontSize: '0.78rem' }}>Generates characters, world details, background, and style from your synopsis.</p>
      </div>

      {/* AUTOFILL MODE MODAL */}
      {autofillMode === 'pending' && (
        <div className="modal-overlay" onClick={() => setAutofillMode(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <h3>Autofill from Synopsis</h3>
            <p>How should the generated content be added?</p>
            <div className="modal-actions">
              <button className="btn btn-accent" onClick={() => autofillFromSynopsis('replace')}>Replace</button>
              <button className="btn" onClick={() => autofillFromSynopsis('append')}>Append</button>
              <button className="btn" onClick={() => setAutofillMode(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* SYSTEM PROMPT */}
      <CollapsibleSection title="System Prompt (Style)" defaultOpen={true}>
        <textarea
          className="large"
          value={project.systemPrompt}
          onChange={e => up('systemPrompt', e.target.value)}
          placeholder="Define the writing style, voice, tone, POV, tense, etc. E.g.: Write in first person present tense with a literary, introspective style reminiscent of Donna Tartt..."
        />
      </CollapsibleSection>

      {/* CHARACTERS */}
      <CollapsibleSection title="Characters" defaultOpen={true}>
        <DynamicArray
          items={project.characters}
          setItems={v => up('characters', v)}
          newItem={() => ''}
          addLabel="+ Add Character"
          renderItem={(item, idx, update) => (
            <input
              type="text"
              value={item}
              onChange={e => update(e.target.value)}
              placeholder={`Character ${idx + 1} — name, role, description...`}
            />
          )}
        />
      </CollapsibleSection>

      {/* SETTINGS */}
      <CollapsibleSection title="World & Details">
        <p className="text-muted mb-md">Locations, time periods, important objects, vibes, rules of the world — anything the story needs to stay consistent on.</p>
        <DynamicArray
          items={project.settings}
          setItems={v => up('settings', v)}
          newItem={() => ''}
          addLabel="+ Add Detail"
          renderItem={(item, idx, update) => (
            <input
              type="text"
              value={item}
              onChange={e => update(e.target.value)}
              placeholder="e.g. 'the power ring — grants invisibility but corrupts the wearer' or '1920s Paris' or 'the valley — always shrouded in mist'"
            />
          )}
        />
      </CollapsibleSection>

      {/* EDITORS */}
      <CollapsibleSection title="Editors">
        <p className="text-muted mb-md">Define editorial personas that will review and critique chapters.</p>
        <DynamicArray
          items={project.editors}
          setItems={v => up('editors', v)}
          newItem={() => ({ name: '', systemPrompt: '', overrideModel: false, overrideProvider: 'anthropic', overrideModelId: 'claude-sonnet-4-20250514', includeProjectKnowledge: false })}
          addLabel="+ Add Editor"
          renderItem={(item, idx, update) => (
            <>
              <div className="fields-row">
                <input
                  type="text"
                  value={item.name}
                  onChange={e => update({ ...item, name: e.target.value })}
                  placeholder="Editor name (e.g., 'Continuity Editor')"
                />
              </div>
              <textarea
                value={item.systemPrompt}
                onChange={e => update({ ...item, systemPrompt: e.target.value })}
                placeholder="Editor system prompt — what they focus on, their critical lens..."
                rows={3}
              />
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                  <input
                    type="checkbox"
                    checked={!!item.includeProjectKnowledge}
                    onChange={e => update({ ...item, includeProjectKnowledge: e.target.checked })}
                    style={{ accentColor: 'var(--accent)' }}
                  />
                  Include project knowledge
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                  <input
                    type="checkbox"
                    checked={!!item.overrideModel}
                    onChange={e => update({ ...item, overrideModel: e.target.checked })}
                    style={{ accentColor: 'var(--accent)' }}
                  />
                  Override model
                </label>
                {item.overrideModel && (
                  <div className="fields-row" style={{ marginTop: 6 }}>
                    <select
                      value={item.overrideProvider || 'anthropic'}
                      onChange={e => {
                        const prov = e.target.value;
                        const cat = PROVIDER_CATALOG[prov];
                        update({ ...item, overrideProvider: prov, overrideModelId: cat?.models[0]?.id || '' });
                      }}
                      style={{ maxWidth: 140 }}
                    >
                      {Object.entries(PROVIDER_CATALOG).map(([id, cat]) => (
                        <option key={id} value={id}>{cat.name}</option>
                      ))}
                    </select>
                    <select
                      value={item.overrideModelId || ''}
                      onChange={e => update({ ...item, overrideModelId: e.target.value })}
                    >
                      {(PROVIDER_CATALOG[item.overrideProvider || 'anthropic']?.models || []).map(m => (
                        <option key={m.id} value={m.id}>{m.label}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            </>
          )}
        />
      </CollapsibleSection>

      {/* BACKGROUND */}
      <CollapsibleSection title="Background / Reference Materials">
        <p className="text-muted mb-md">Add reference texts, research, character bios, source material, etc. Tag items to specific chapters or leave as "All Chapters" for global context.</p>
        <DynamicArray
          items={project.background}
          setItems={v => up('background', v)}
          newItem={() => ({ type: 'research', name: '', content: '', chapters: 'all' })}
          addLabel="+ Add Reference"
          renderItem={(item, idx, update) => {
            const chapterAssign = item.chapters;
            const isAll = chapterAssign === 'all' || chapterAssign === undefined || chapterAssign === null;
            const totalCh = outline.length || project.chapterCount || 25;

            return (
              <>
                <div className="fields-row">
                  <select
                    value={item.type || 'research'}
                    onChange={e => update({ ...item, type: e.target.value })}
                    style={{ maxWidth: 160 }}
                  >
                    {BACKGROUND_TYPES.map(t => (
                      <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={item.name}
                    onChange={e => update({ ...item, name: e.target.value })}
                    placeholder="Name / label..."
                  />
                </div>
                <textarea
                  value={item.content}
                  onChange={e => update({ ...item, content: e.target.value })}
                  placeholder="Paste reference text here..."
                  rows={5}
                />
                <div style={{ marginTop: 6 }}>
                  <div className="flex-row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontSize: '0.82rem' }}>
                      <input
                        type="checkbox"
                        checked={isAll}
                        onChange={e => {
                          update({ ...item, chapters: e.target.checked ? 'all' : [] });
                        }}
                        style={{ accentColor: 'var(--accent)' }}
                      />
                      All Chapters
                    </label>
                    {!isAll && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {Array.from({ length: totalCh }, (_, i) => i).map(ci => {
                          const selected = Array.isArray(item.chapters) && item.chapters.includes(ci);
                          return (
                            <button
                              key={ci}
                              className={`btn btn-sm`}
                              style={{
                                padding: '2px 7px',
                                fontSize: '0.72rem',
                                minWidth: 28,
                                background: selected ? 'var(--accent-dim)' : 'var(--bg-tertiary)',
                                borderColor: selected ? 'var(--accent)' : 'var(--border)',
                                color: selected ? '#fff' : 'var(--text-muted)',
                              }}
                              onClick={() => {
                                const chs = Array.isArray(item.chapters) ? [...item.chapters] : [];
                                if (selected) {
                                  update({ ...item, chapters: chs.filter(c => c !== ci) });
                                } else {
                                  update({ ...item, chapters: [...chs, ci].sort((a, b) => a - b) });
                                }
                              }}
                            >
                              {ci + 1}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  {!isAll && Array.isArray(item.chapters) && item.chapters.length > 0 && (
                    <span className="text-muted" style={{ fontSize: '0.75rem', marginTop: 4, display: 'block' }}>
                      Chapters: {item.chapters.map(c => c + 1).join(', ')}
                    </span>
                  )}
                </div>
              </>
            );
          }}
        />
      </CollapsibleSection>

      {/* OUTLINE GENERATION SETTINGS */}
      <CollapsibleSection title="Outline Generation Settings" defaultOpen={true}>
        <div className="row mb-md">
          <div>
            <label>Number of Chapters</label>
            <input
              type="number"
              value={project.chapterCount || 25}
              onChange={e => up('chapterCount', parseInt(e.target.value) || 25)}
              min={1}
              max={100}
              step={1}
            />
          </div>
          <div>
            <label>Min Words per Chapter</label>
            <input
              type="number"
              value={project.chapterWordCountMin || 2000}
              onChange={e => up('chapterWordCountMin', parseInt(e.target.value) || 2000)}
              min={500}
              max={20000}
              step={500}
            />
          </div>
          <div>
            <label>Max Words per Chapter</label>
            <input
              type="number"
              value={project.chapterWordCountMax || 5000}
              onChange={e => up('chapterWordCountMax', parseInt(e.target.value) || 5000)}
              min={500}
              max={20000}
              step={500}
            />
          </div>
        </div>

        <label>Include Front / Back Matter</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 6 }}>
          {[
            ['tableOfContents', 'Table of Contents'],
            ['copyrightNotice', 'Copyright Notice'],
            ['acknowledgements', 'Acknowledgements'],
            ['bibliography', 'Bibliography'],
            ['index', 'Index'],
          ].map(([key, label]) => (
            <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: '0.88rem', color: 'var(--text-secondary)' }}>
              <input
                type="checkbox"
                checked={!!(project.frontBackMatter || {})[key]}
                onChange={e => up('frontBackMatter', { ...project.frontBackMatter, [key]: e.target.checked })}
                style={{ accentColor: 'var(--accent)' }}
              />
              {label}
            </label>
          ))}
        </div>

        {(project.frontBackMatter || {}).copyrightNotice && (
          <div className="mt-md">
            <label>Copyright Text</label>
            <textarea
              value={project.copyrightText || ''}
              onChange={e => up('copyrightText', e.target.value)}
              placeholder="© 2026 Author Name. All rights reserved..."
              rows={2}
            />
          </div>
        )}

        {(project.frontBackMatter || {}).acknowledgements && (
          <div className="mt-md">
            <label>Acknowledgements Text</label>
            <textarea
              value={project.acknowledgementsText || ''}
              onChange={e => up('acknowledgementsText', e.target.value)}
              placeholder="Leave blank to have AI generate, or write your own..."
              rows={3}
            />
          </div>
        )}

        {(project.frontBackMatter || {}).bibliography && (
          <div className="mt-md">
            <label>Bibliography Text</label>
            <textarea
              value={project.bibliographyText || ''}
              onChange={e => up('bibliographyText', e.target.value)}
              placeholder="Leave blank to have AI generate, or write your own..."
              rows={3}
            />
          </div>
        )}
      </CollapsibleSection>

      {/* GENERATE */}
      <div className="mt-lg" style={{ textAlign: 'center' }}>
        {loading.outline ? (
          <Loading text="Generating outline..." />
        ) : (
          <button className="btn btn-accent" onClick={generateOutline} style={{ fontSize: '1rem', padding: '14px 40px' }}>
            Generate Outline →
          </button>
        )}
      </div>
    </div>
  );
}
