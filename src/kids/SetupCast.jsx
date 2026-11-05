import React, { useState } from 'react';
import { AGE_RANGES, ART_STYLES, PAGE_COUNTS, PAPER, CAST_KINDS, newCastMember, storySlots } from './model.js';
import { analyzeImagePrompt, castFromPremisePrompt, sheetPrompt } from './prompts.js';
import { Field, LazyText, Thumbs, UploadButton, DropZone, Spinner, Lightbox, Check } from './ui.jsx';

export function PageCountPicker({ book, update }) {
  const slots = storySlots(book);
  return (
    <div className="kb-row">
      <Field label="Paper">
        <select value={book.paper} onChange={e => update({ paper: e.target.value })}>
          {Object.entries(PAPER).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
        </select>
      </Field>
      <Field label="Total pages (incl. covers)" hint={`${book.pageCount / 4} sheet${book.pageCount > 4 ? 's' : ''} of paper, printed both sides and folded`}>
        <select value={book.pageCount} onChange={e => update({ pageCount: Number(e.target.value) })}>
          {PAGE_COUNTS.map(n => <option key={n} value={n}>{n} pages</option>)}
        </select>
      </Field>
      <Field label="Story pages available" hint={`= ${book.pageCount} − front cover − back cover − ${book.frontMatter.length} front − ${book.backMatter.length} back matter`}>
        <div className={`kb-stat ${slots < 1 ? 'bad' : ''}`}>{slots}</div>
      </Field>
    </div>
  );
}

export function SetupPanel({ book, update, store, ai, run, busy, setTab }) {
  const [lightbox, setLightbox] = useState(null);
  const up = (k, v) => update({ [k]: v });

  const suggestCast = () => run('castFromPremise', async () => {
    if (!book.premise.trim()) throw new Error('Write a sentence or two about the story first.');
    const res = await ai.json({ prompt: castFromPremisePrompt(book) });
    const list = res.cast || [];
    update(b => ({ ...b, cast: [...b.cast, ...list.filter(c => !b.cast.some(x => x.name.toLowerCase() === (c.name || '').toLowerCase())).map(c => newCastMember(CAST_KINDS[c.kind] ? c.kind : 'character', { name: c.name || '', description: c.description || '' }))] }));
    setTab('cast');
  });

  return (
    <div className="kb-panel">
      <div className="kb-row">
        <Field label="Title" style={{ flex: 2 }}><LazyText value={book.title} onCommit={v => up('title', v)} placeholder="Leave blank and the AI will suggest one" /></Field>
        <Field label="Subtitle"><LazyText value={book.subtitle} onCommit={v => up('subtitle', v)} placeholder="optional" /></Field>
      </div>
      <div className="kb-row">
        <Field label="Author"><LazyText value={book.author} onCommit={v => up('author', v)} /></Field>
        <Field label="Illustrator"><LazyText value={book.illustrator} onCommit={v => up('illustrator', v)} placeholder="optional" /></Field>
        <Field label="Reader age">
          <select value={book.ageRange} onChange={e => up('ageRange', e.target.value)}>
            {AGE_RANGES.map(a => <option key={a} value={a}>Ages {a}</option>)}
          </select>
        </Field>
      </div>

      <Field label="What's the story about?">
        <LazyText multiline className="large" value={book.premise} onCommit={v => up('premise', v)} placeholder="A shy hedgehog who is afraid of the dark discovers the forest at night is full of glowing friends…" />
      </Field>

      <div className="kb-row">
        <Field label="Theme / lesson"><LazyText value={book.lesson} onCommit={v => up('lesson', v)} placeholder="being brave, sharing, trying new food…" /></Field>
        <Field label="Tone"><LazyText value={book.tone} onCommit={v => up('tone', v)} placeholder="warm, silly, rhyming, bedtime-calm…" /></Field>
        <Field label="Words per page" hint="Picture books: 10–60 · early readers: 40–120">
          <div className="flex-row" style={{ flexWrap: 'nowrap' }}>
            <input type="number" min={0} value={book.wordsPerPage[0]} onChange={e => up('wordsPerPage', [Number(e.target.value), book.wordsPerPage[1]])} />
            <span>–</span>
            <input type="number" min={1} value={book.wordsPerPage[1]} onChange={e => up('wordsPerPage', [book.wordsPerPage[0], Number(e.target.value)])} />
          </div>
        </Field>
      </div>

      <div className="kb-card">
        <h3>Art style</h3>
        <Field label="Preset">
          <select value={ART_STYLES.includes(book.artStyle) ? book.artStyle : ''} onChange={e => e.target.value && up('artStyle', e.target.value)}>
            <option value="">Custom…</option>
            {ART_STYLES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Style description (sent with every image prompt)">
          <LazyText multiline value={book.artStyle} onCommit={v => up('artStyle', v)} rows={2} />
        </Field>
        <Field label="Style reference image (optional)" hint="An illustration whose look you want to match. Sent along with sheet and page generations.">
          <div className="flex-row">
            <Thumbs store={store} ids={book.styleRefs} onOpen={setLightbox} onRemove={id => update(b => ({ ...b, styleRefs: b.styleRefs.filter(x => x !== id) }))} />
            <UploadButton label="+ Style image" onFiles={async files => {
              const ids = [];
              for (const f of files) ids.push(await store.putImage(f));
              update(b => ({ ...b, styleRefs: [...b.styleRefs, ...ids] }));
            }} />
          </div>
        </Field>
      </div>

      <div className="kb-card">
        <h3>Book size &amp; structure</h3>
        <PageCountPicker book={book} update={update} />
        <div className="kb-row" style={{ alignItems: 'flex-end' }}>
          <Field label="Structure">
            <div className="kb-seg">
              <button className={book.chapterMode === 'single' ? 'on' : ''} onClick={() => up('chapterMode', 'single')}>One story</button>
              <button className={book.chapterMode === 'chapters' ? 'on' : ''} onClick={() => up('chapterMode', 'chapters')}>Chapters</button>
            </div>
          </Field>
          {book.chapterMode === 'chapters' && (
            <Field label="Number of chapters">
              <input type="number" min={2} max={12} value={book.chapterCount} onChange={e => up('chapterCount', Math.max(2, Number(e.target.value) || 2))} />
            </Field>
          )}
          <div style={{ flex: 2 }} className="text-muted">
            {book.chapterMode === 'chapters'
              ? 'Each chapter opens with a heading on its first page. Add a "Table of contents" page under Design → front matter if you like.'
              : 'Most picture books are one continuous story. Switch to chapters any time.'}
          </div>
        </div>
      </div>

      <div className="flex-row mt-md" style={{ justifyContent: 'center' }}>
        {busy.castFromPremise ? <Spinner text="Thinking up a cast…" /> : (
          <button className="btn" onClick={suggestCast}>✨ Suggest cast from premise</button>
        )}
        <button className="btn btn-accent" onClick={() => setTab('cast')}>Next: Cast &amp; Sheets →</button>
      </div>
      {lightbox && <Lightbox store={store} id={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function CastPanel({ book, update, store, ai, run, busy, setTab, notify, settings, setSettings }) {
  const [lightbox, setLightbox] = useState(null);
  const [analyze, setAnalyze] = useState(true);
  const updateMember = (id, fn) => update(b => ({ ...b, cast: b.cast.map(c => (c.id === id ? (typeof fn === 'function' ? fn(c) : { ...c, ...fn }) : c)) }));

  const addFromImages = files => run('analyze', async () => {
    for (const f of files) {
      const id = await store.putImage(f);
      if (!analyze) {
        update(b => ({ ...b, cast: [...b.cast, newCastMember('character', { name: '', refs: [id] })] }));
        continue;
      }
      const res = await ai.json({ prompt: analyzeImagePrompt(book), imageIds: [id] });
      const found = res.cast || [];
      if (!found.length) notify('No characters found in that image — added it as a blank character instead.');
      update(b => {
        let cast = [...b.cast];
        if (!found.length) cast.push(newCastMember('character', { refs: [id] }));
        found.forEach(c => {
          const existing = cast.find(x => x.name && x.name.toLowerCase() === (c.name || '').toLowerCase());
          if (existing) {
            cast = cast.map(x => (x === existing ? { ...x, refs: x.refs.includes(id) ? x.refs : [...x.refs, id], description: x.description || c.description } : x));
          } else {
            cast.push(newCastMember(CAST_KINDS[c.kind] ? c.kind : 'character', { name: c.name || '', description: c.description || '', refs: [id] }));
          }
        });
        return { ...b, cast };
      });
    }
  });

  const describe = m => run(`describe:${m.id}`, async () => {
    const res = await ai.json({
      prompt: `Describe the ${m.kind} "${m.name || 'shown'}" in these reference images so an illustrator can redraw it consistently. Precise colors, shapes, clothing, markings, proportions. Return ONLY JSON: { "name": string, "description": string }`,
      imageIds: m.refs,
    });
    updateMember(m.id, c => ({ ...c, name: c.name || res.name || '', description: res.description || c.description }));
  });

  const genSheet = m => run(`sheet:${m.id}`, async () => {
    const fresh = book.cast.find(c => c.id === m.id) || m;
    if (!fresh.description && !fresh.refs.length) throw new Error(`Add a description or a reference image for ${fresh.name || 'this cast member'} first.`);
    const refs = [
      ...fresh.refs.map(id => ({ id, label: `${fresh.name || fresh.kind} — original reference` })),
      ...(book.styleRefs || []).slice(0, 1).map(id => ({ id, label: 'art style reference' })),
    ];
    const id = await ai.image({ prompt: sheetPrompt(book, fresh, fresh.refs.length > 0), refs, aspect: fresh.kind === 'environment' ? '16:9' : '3:2' });
    updateMember(m.id, c => ({ ...c, sheets: [...c.sheets, id], activeSheet: id }));
  });

  const genAllMissing = (all = false) => run('allSheets', async () => {
    for (const m of book.cast.filter(c => (all || !c.sheets.length) && (c.description || c.refs.length))) {
      await genSheet(m);
    }
  });

  const kinds = Object.keys(CAST_KINDS);

  return (
    <div className="kb-panel">
      <DropZone onFiles={addFromImages}>
        <div className="kb-drop-inner">
          <div style={{ fontSize: '1.05rem' }}>Drop a picture of your characters here</div>
          <div className="text-muted">A drawing, a photo of toys, a kid's sketch… one character or a whole group.</div>
          <div className="flex-row" style={{ justifyContent: 'center', marginTop: 10 }}>
            {busy.analyze ? <Spinner text="Looking at the picture…" /> : <UploadButton label="Choose image(s)" className="btn btn-accent" onFiles={addFromImages} />}
            <Check checked={analyze} onChange={setAnalyze}>Identify characters with AI ({ai.textProvider})</Check>
          </div>
        </div>
      </DropZone>

      <div className="flex-row mt-md" style={{ justifyContent: 'space-between' }}>
        <div className="flex-row">
          {kinds.map(k => (
            <button key={k} className="btn btn-sm" onClick={() => update(b => ({ ...b, cast: [...b.cast, newCastMember(k)] }))}>+ {CAST_KINDS[k]}</button>
          ))}
        </div>
        <div className="flex-row">
          <Check checked={settings.useRefs} onChange={v => setSettings(s => ({ ...s, useRefs: v }))}>Use sheets as references for pages</Check>
          {busy.allSheets ? <Spinner text="Generating sheets…" /> : (
            <>
              <button className="btn btn-sm btn-accent" onClick={() => genAllMissing(false)} disabled={!book.cast.some(c => !c.sheets.length)}>Generate all missing sheets ({ai.imageProvider})</button>
              <button className="btn btn-sm" onClick={() => confirm(`Redraw all ${book.cast.length} sheets with ${ai.imageProvider}? Old sheets are kept.`) && genAllMissing(true)} disabled={!book.cast.length}>↻ Redo all sheets</button>
            </>
          )}
        </div>
      </div>

      {!book.cast.length && <p className="text-muted mt-md">No cast yet. Upload a picture above, add characters by hand, or use "Suggest cast from premise" on the Book tab.</p>}

      {kinds.map(kind => {
        const members = book.cast.filter(c => c.kind === kind);
        if (!members.length) return null;
        return (
          <div key={kind} className="mt-lg">
            <h3 className="kb-h3">{CAST_KINDS[kind]}s</h3>
            <div className="kb-cast-grid">
              {members.map(m => (
                <div key={m.id} className="kb-card kb-cast">
                  <div className="kb-row">
                    <Field label="Name" style={{ flex: 2 }}><LazyText value={m.name} onCommit={v => updateMember(m.id, { name: v })} placeholder="Name" /></Field>
                    <Field label="Kind">
                      <select value={m.kind} onChange={e => updateMember(m.id, { kind: e.target.value })}>
                        {kinds.map(k => <option key={k} value={k}>{CAST_KINDS[k]}</option>)}
                      </select>
                    </Field>
                    <button className="remove-btn" title="Delete" onClick={() => confirm(`Delete ${m.name || 'this cast member'}?`) && update(b => ({ ...b, cast: b.cast.filter(c => c.id !== m.id) }))}>×</button>
                  </div>
                  <Field label="Visual description">
                    <LazyText multiline rows={3} value={m.description} onCommit={v => updateMember(m.id, { description: v })} placeholder="Colors, shapes, clothing, size, markings…" />
                  </Field>
                  <Field label="Reference images">
                    <div className="flex-row">
                      <Thumbs store={store} ids={m.refs} onOpen={setLightbox} onRemove={id => updateMember(m.id, c => ({ ...c, refs: c.refs.filter(x => x !== id) }))} size={64} />
                      <UploadButton label="+ Ref" onFiles={async files => {
                        const ids = [];
                        for (const f of files) ids.push(await store.putImage(f));
                        updateMember(m.id, c => ({ ...c, refs: [...c.refs, ...ids] }));
                      }} />
                      {m.refs.length > 0 && (busy[`describe:${m.id}`] ? <Spinner text="Describing…" /> : <button className="btn btn-sm" onClick={() => describe(m)}>✨ Describe from refs</button>)}
                    </div>
                  </Field>
                  <Field label={`${CAST_KINDS[m.kind]} sheet${m.sheets.length > 1 ? 's — click one to make it the reference' : ''}`}>
                    <Thumbs store={store} ids={m.sheets} activeId={m.activeSheet} size={112}
                      onPick={id => updateMember(m.id, { activeSheet: id })}
                      onOpen={setLightbox}
                      onRemove={id => updateMember(m.id, c => ({ ...c, sheets: c.sheets.filter(x => x !== id), activeSheet: c.activeSheet === id ? c.sheets.filter(x => x !== id).slice(-1)[0] || null : c.activeSheet }))} />
                  </Field>
                  <div className="flex-row">
                    <LazyText value={m.sheetNotes} onCommit={v => updateMember(m.id, { sheetNotes: v })} placeholder="Extra notes for the sheet (optional)" style={{ flex: 1 }} />
                    {busy[`sheet:${m.id}`] ? <Spinner text="Drawing…" /> : (
                      <button className="btn btn-sm btn-accent" onClick={() => genSheet(m)}>
                        {m.sheets.length ? '↻ New sheet' : '✨ Generate sheet'}
                      </button>
                    )}
                    <UploadButton label="Upload sheet" onFiles={async files => {
                      const ids = [];
                      for (const f of files) ids.push(await store.putImage(f));
                      updateMember(m.id, c => ({ ...c, sheets: [...c.sheets, ...ids], activeSheet: ids[ids.length - 1] }));
                    }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      <div className="flex-row mt-lg" style={{ justifyContent: 'center' }}>
        <button className="btn btn-accent" onClick={() => setTab('story')}>Next: Story →</button>
      </div>
      {lightbox && <Lightbox store={store} id={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}
