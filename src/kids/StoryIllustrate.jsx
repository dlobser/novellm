import React, { useRef, useState } from 'react';
import { STORY_LAYOUTS, newPage, newChapter, applyStory, storyPages } from './model.js';
import {
  storySystemPrompt, storyPrompt, chapterPlanPrompt, chapterPagesPrompt, revisePagePrompt, reviseStoryPrompt,
  pagePrompt, pageRefs, coverPrompt, coverRefs,
} from './prompts.js';
import { Field, LazyText, Thumbs, UploadButton, Spinner, Lightbox, Img } from './ui.jsx';
import { PageCountPicker } from './SetupCast.jsx';

function mapPage(book, pageId, fn) {
  return { ...book, chapters: book.chapters.map(ch => ({ ...ch, pages: ch.pages.map(p => (p.id === pageId ? fn(p) : p)) })) };
}

function wordCount(t) {
  return (t || '').split(/\s+/).filter(Boolean).length;
}

export function StoryPanel({ book, update, ai, run, busy, setTab, plan, bookRef }) {
  const [instruction, setInstruction] = useState('');
  const [pageInstr, setPageInstr] = useState({});
  const chapters = book.chapterMode === 'chapters';
  const written = plan.storyCount;
  const sys = storySystemPrompt(book);

  const writeAll = () => run('story', async () => {
    if (written && !confirm('Replace the current story with a new one?')) return;
    const res = await ai.json({ system: sys, prompt: storyPrompt(book, { slots: plan.slots }) });
    update(b => applyStory(b, res));
  });

  const planChapters = () => run('plan', async () => {
    const res = await ai.json({ system: sys, prompt: chapterPlanPrompt(book, { slots: plan.slots }) });
    update(b => ({
      ...b,
      title: b.title || res.title || '',
      chapters: (res.chapters || []).map((c, i) => newChapter({
        title: c.title || '', summary: c.summary || '', targetPages: Number(c.targetPages) || 2,
        pages: b.chapters[i]?.pages || [],
      })),
    }));
  });

  const writeChapter = ci => run(`chapter:${ci}`, async () => {
    const res = await ai.json({ system: sys, prompt: chapterPagesPrompt(book, ci) });
    update(b => applyStory(b, res, { chapterIdx: ci }));
  });

  // Sequential, reading the latest book each time so chapter 2 sees chapter 1.
  const writeAllChapters = () => run('allChapters', async () => {
    for (let ci = 0; ci < bookRef.current.chapters.length; ci++) {
      const res = await ai.json({ system: sys, prompt: chapterPagesPrompt(bookRef.current, ci) });
      update(b => applyStory(b, res, { chapterIdx: ci }));
      await new Promise(r => setTimeout(r, 80));
    }
  });

  const reviseStory = () => run('revise', async () => {
    const res = await ai.json({ system: sys, prompt: reviseStoryPrompt(book, instruction) });
    update(b => {
      // Keep images on pages that still line up.
      const old = storyPages(b);
      const next = applyStory({ ...b, chapters: b.chapters }, res);
      let k = 0;
      next.chapters = next.chapters.map(ch => ({ ...ch, pages: ch.pages.map(p => { const o = old[k++]; return o ? { ...p, id: o.page.id, imageId: o.page.imageId, altImages: o.page.altImages } : p; }) }));
      return next;
    });
    setInstruction('');
  });

  const revisePage = (s, flat, idx) => run(`rev:${s.page.id}`, async () => {
    const res = await ai.json({ system: sys, prompt: revisePagePrompt(book, s.page, pageInstr[s.page.id], { prev: flat[idx - 1]?.page, next: flat[idx + 1]?.page }) });
    update(b => mapPage(b, s.page.id, p => ({ ...p, text: res.text ?? p.text, illustration: res.illustration ?? p.illustration, cast: res.cast || p.cast, layout: STORY_LAYOUTS[res.layout] ? res.layout : p.layout })));
    setPageInstr(x => ({ ...x, [s.page.id]: '' }));
  });

  const setPage = (id, patch) => update(b => mapPage(b, id, p => ({ ...p, ...patch })));
  const setChapter = (ci, patch) => update(b => ({ ...b, chapters: b.chapters.map((c, i) => (i === ci ? { ...c, ...patch } : c)) }));
  const movePage = (ci, pi, dir) => update(b => {
    const chs = b.chapters.map(c => ({ ...c, pages: [...c.pages] }));
    const pages = chs[ci].pages;
    const j = pi + dir;
    if (j < 0 || j >= pages.length) return b;
    [pages[pi], pages[j]] = [pages[j], pages[pi]];
    return { ...b, chapters: chs };
  });
  const insertPage = (ci, at) => update(b => ({ ...b, chapters: b.chapters.map((c, i) => (i === ci ? { ...c, pages: [...c.pages.slice(0, at), newPage(), ...c.pages.slice(at)] } : c)) }));
  const deletePage = (ci, pi) => update(b => ({ ...b, chapters: b.chapters.map((c, i) => (i === ci ? { ...c, pages: c.pages.filter((_, k) => k !== pi) } : c)) }));

  const flat = storyPages(book);
  const physical = {};
  plan.pages.forEach(p => { if (p.kind === 'story') physical[p.page.id] = p.n; });
  const [minW, maxW] = book.wordsPerPage;

  return (
    <div className="kb-panel">
      <div className="kb-card">
        <PageCountPicker book={book} update={update} />
        <div className={`kb-budget ${written === plan.slots ? 'ok' : written > plan.slots ? 'over' : ''}`}>
          <div className="kb-budget-bar"><div style={{ width: `${Math.min(100, (written / Math.max(1, plan.slots)) * 100)}%` }} /></div>
          <span>{written} of {plan.slots} story pages written</span>
          {written > plan.slots && <button className="btn btn-sm" onClick={() => update({ pageCount: plan.suggestedPageCount })}>Use {plan.suggestedPageCount} pages</button>}
        </div>
        {plan.warnings.map(w => <div key={w} className="kb-warn">{w}</div>)}
      </div>

      <div className="kb-card">
        <div className="flex-row" style={{ justifyContent: 'space-between' }}>
          <div className="kb-seg">
            <button className={!chapters ? 'on' : ''} onClick={() => update({ chapterMode: 'single' })}>One story</button>
            <button className={chapters ? 'on' : ''} onClick={() => update({ chapterMode: 'chapters' })}>Chapters</button>
          </div>
          {chapters && (
            <label className="flex-row" style={{ margin: 0 }}>Chapters
              <input type="number" min={2} max={12} value={book.chapterCount} style={{ width: 70 }} onChange={e => update({ chapterCount: Math.max(2, Number(e.target.value) || 2) })} />
            </label>
          )}
        </div>
        <div className="flex-row mt-md">
          {busy.story ? <Spinner text={`Writing ${plan.slots} pages…`} /> : (
            <button className="btn btn-accent" onClick={writeAll} disabled={plan.slots < 1}>✨ Write the whole story ({plan.slots} pages)</button>
          )}
          {chapters && (busy.plan ? <Spinner text="Planning chapters…" /> : <button className="btn" onClick={planChapters}>✨ Plan chapters first</button>)}
          {chapters && book.chapters.some(c => c.summary) && (busy.allChapters ? <Spinner text="Writing chapters…" /> : <button className="btn" onClick={writeAllChapters}>Write all chapters from plan</button>)}
        </div>
        <p className="text-muted mt-sm">
          Using {ai.textProvider}. To avoid API costs, connect the MCP bridge (Settings) and ask Claude or ChatGPT desktop to “write the story for my kids book” — the pages appear here live.
        </p>
        {written > 0 && (
          <div className="flex-row mt-md">
            <input type="text" value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="Revise the whole story… e.g. “make it rhyme”, “add a funny frog”, “simpler words for age 3”" style={{ flex: 1 }} />
            {busy.revise ? <Spinner text="Revising…" /> : <button className="btn" onClick={reviseStory} disabled={!instruction.trim()}>Revise story</button>}
          </div>
        )}
      </div>

      {book.chapters.map((ch, ci) => (
        <div key={ch.id} className="mt-lg">
          {chapters && (
            <div className="kb-card kb-chapter">
              <div className="kb-row">
                <Field label={`Chapter ${ci + 1} title`} style={{ flex: 3 }}><LazyText value={ch.title} onCommit={v => setChapter(ci, { title: v })} /></Field>
                <Field label="Target pages"><input type="number" min={1} value={ch.targetPages || ''} onChange={e => setChapter(ci, { targetPages: Number(e.target.value) })} /></Field>
                <button className="remove-btn" title="Delete chapter" onClick={() => confirm('Delete this chapter and its pages?') && update(b => ({ ...b, chapters: b.chapters.filter((_, i) => i !== ci) }))}>×</button>
              </div>
              <Field label="Summary"><LazyText multiline rows={2} value={ch.summary} onCommit={v => setChapter(ci, { summary: v })} /></Field>
              {busy[`chapter:${ci}`] ? <Spinner text="Writing chapter…" /> : (
                <button className="btn btn-sm" onClick={() => writeChapter(ci)} disabled={!ch.summary && !ch.title}>✨ {ch.pages.length ? 'Rewrite' : 'Write'} chapter {ci + 1} pages</button>
              )}
            </div>
          )}
          <div className="kb-pages">
            {ch.pages.map((pg, pi) => {
              const idx = flat.findIndex(f => f.page.id === pg.id);
              const s = flat[idx];
              const n = physical[pg.id];
              const wc = wordCount(pg.text);
              return (
                <div key={pg.id} className={`kb-card kb-page ${n ? '' : 'unprinted'}`}>
                  <div className="kb-page-head">
                    <span className="kb-pnum">{n ? `p.${n}` : 'won’t print'}</span>
                    <span className="text-muted">story page {idx + 1}</span>
                    <span className={`kb-wc ${wc > maxW ? 'hi' : wc < minW && pg.layout !== 'image-only' ? 'lo' : ''}`}>{wc} words</span>
                    <select value={pg.layout} onChange={e => setPage(pg.id, { layout: e.target.value })} style={{ width: 'auto', marginLeft: 'auto' }}>
                      {Object.entries(STORY_LAYOUTS).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}
                    </select>
                    <button className="btn btn-sm" title="Move up" onClick={() => movePage(ci, pi, -1)}>↑</button>
                    <button className="btn btn-sm" title="Move down" onClick={() => movePage(ci, pi, 1)}>↓</button>
                    <button className="btn btn-sm" title="Insert page after" onClick={() => insertPage(ci, pi + 1)}>＋</button>
                    <button className="remove-btn" title="Delete page" onClick={() => deletePage(ci, pi)}>×</button>
                  </div>
                  <div className="kb-page-body">
                    <div style={{ flex: 3 }}>
                      <label>Words on the page</label>
                      <LazyText multiline rows={3} className="kb-story-text" value={pg.text} onCommit={v => setPage(pg.id, { text: v })} />
                      <label className="mt-sm">Illustration notes</label>
                      <LazyText multiline rows={2} value={pg.illustration} onCommit={v => setPage(pg.id, { illustration: v })} />
                      {book.cast.length > 0 && (
                        <div className="kb-chips">
                          {book.cast.map(c => {
                            const on = (pg.cast || []).some(n2 => n2.toLowerCase() === c.name.toLowerCase());
                            return (
                              <button key={c.id} className={`kb-chip ${on ? 'on' : ''}`} onClick={() => setPage(pg.id, { cast: on ? pg.cast.filter(n2 => n2.toLowerCase() !== c.name.toLowerCase()) : [...(pg.cast || []), c.name] })}>
                                {c.name || '(unnamed)'}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      <div className="flex-row mt-sm">
                        <input type="text" placeholder="Rewrite this page… (optional instruction)" value={pageInstr[pg.id] || ''} onChange={e => setPageInstr(x => ({ ...x, [pg.id]: e.target.value }))} style={{ flex: 1 }} />
                        {busy[`rev:${pg.id}`] ? <Spinner text="Rewriting…" /> : <button className="btn btn-sm" onClick={() => revisePage(s, flat, idx)}>✨ Rewrite</button>}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
            <button className="btn btn-sm" onClick={() => insertPage(ci, ch.pages.length)}>+ Add page{chapters ? ` to chapter ${ci + 1}` : ''}</button>
          </div>
        </div>
      ))}
      {chapters && <button className="btn btn-sm mt-md" onClick={() => update(b => ({ ...b, chapters: [...b.chapters, newChapter({ title: `Chapter ${b.chapters.length + 1}` })] }))}>+ Add chapter</button>}

      <div className="flex-row mt-lg" style={{ justifyContent: 'center' }}>
        <button className="btn btn-accent" onClick={() => setTab('illustrate')}>Next: Illustrations →</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function IllustratePanel({ book, update, store, ai, run, busy, setTab, settings, bookRef, plan }) {
  const [lightbox, setLightbox] = useState(null);
  const [extra, setExtra] = useState({});
  const [progress, setProgress] = useState(null);
  const cancel = useRef(false);
  const useRefs = settings.useRefs;

  const genPage = (pageId, n) => run(`img:${pageId}`, async () => {
    const b = bookRef.current;
    const page = storyPages(b).find(s => s.page.id === pageId)?.page;
    if (!page) return;
    const id = await ai.image({
      prompt: pagePrompt(b, page, { pageNumber: n, extra: extra[pageId] || '' }),
      refs: useRefs ? pageRefs(b, page) : [],
      aspect: STORY_LAYOUTS[page.layout]?.aspect || '1:1',
    });
    update(bk => mapPage(bk, pageId, p => ({ ...p, imageId: id, altImages: [...(p.altImages || []), id] })));
  });

  const genCover = () => run('img:cover', async () => {
    const b = bookRef.current;
    const id = await ai.image({ prompt: coverPrompt(b, extra.cover || ''), refs: useRefs ? coverRefs(b) : [], aspect: b.cover.layout === 'framed' ? '1:1' : b.cover.layout === 'classic' ? '4:3' : '2:3' });
    update(bk => ({ ...bk, cover: { ...bk.cover, imageId: id, altImages: [...(bk.cover.altImages || []), id] } }));
  });

  const genMissing = () => run('allImages', async () => {
    cancel.current = false;
    const todo = [];
    if (!bookRef.current.cover.imageId) todo.push({ cover: true });
    plan.pages.filter(p => p.kind === 'story' && !p.page.imageId && p.page.layout !== 'text-only').forEach(p => todo.push({ id: p.page.id, n: p.n }));
    for (let i = 0; i < todo.length; i++) {
      if (cancel.current) break;
      setProgress(`${i + 1} / ${todo.length}`);
      if (todo[i].cover) await genCover(); else await genPage(todo[i].id, todo[i].n);
    }
    setProgress(null);
  });

  const storyEntries = plan.pages.filter(p => p.kind === 'story');
  const missing = storyEntries.filter(p => !p.page.imageId && p.page.layout !== 'text-only').length + (book.cover.imageId ? 0 : 1);

  return (
    <div className="kb-panel">
      <div className="kb-card flex-row" style={{ justifyContent: 'space-between' }}>
        <div>
          <strong>Image generator: {ai.imageProvider}</strong>
          <span className="text-muted"> · change in Settings · {useRefs ? 'sending cast sheets as references' : 'not sending references'}</span>
        </div>
        <div className="flex-row">
          {busy.allImages ? (
            <>
              <Spinner text={`Illustrating ${progress || ''}`} />
              <button className="btn btn-sm btn-danger" onClick={() => { cancel.current = true; }}>Stop after this one</button>
            </>
          ) : (
            <button className="btn btn-accent" onClick={genMissing} disabled={!missing}>✨ Illustrate all missing ({missing})</button>
          )}
        </div>
      </div>
      {!book.cast.some(c => c.sheets.length) && book.cast.length > 0 && (
        <div className="kb-warn">Tip: generate cast sheets first (Cast &amp; Sheets tab) so characters stay consistent from page to page.</div>
      )}

      <div className="kb-illus-grid">
        <div className="kb-card kb-illus cover">
          <div className="kb-page-head"><span className="kb-pnum">Cover</span><span className="text-muted">{book.cover.layout}</span></div>
          <Img store={store} id={book.cover.imageId} className="kb-illus-img portrait" onClick={() => book.cover.imageId && setLightbox(book.cover.imageId)} />
          <Field label="Cover scene (optional)">
            <LazyText multiline rows={2} value={book.cover.prompt} onCommit={v => update(b => ({ ...b, cover: { ...b.cover, prompt: v } }))} placeholder="Leave blank to use the premise" />
          </Field>
          <Thumbs store={store} ids={book.cover.altImages} activeId={book.cover.imageId} size={44}
            onPick={id => update(b => ({ ...b, cover: { ...b.cover, imageId: id } }))}
            onRemove={id => update(b => ({ ...b, cover: { ...b.cover, altImages: b.cover.altImages.filter(x => x !== id), imageId: b.cover.imageId === id ? null : b.cover.imageId } }))} />
          <div className="flex-row">
            <input type="text" placeholder="Extra direction…" value={extra.cover || ''} onChange={e => setExtra(x => ({ ...x, cover: e.target.value }))} style={{ flex: 1 }} />
          </div>
          <div className="flex-row">
            {busy['img:cover'] ? <Spinner text="Painting cover…" /> : <button className="btn btn-sm btn-accent" onClick={genCover}>{book.cover.imageId ? '↻ Regenerate' : '✨ Generate'}</button>}
            <UploadButton label="Upload" multiple={false} onFiles={async ([f]) => {
              const id = await store.putImage(f);
              update(b => ({ ...b, cover: { ...b.cover, imageId: id, altImages: [...(b.cover.altImages || []), id] } }));
            }} />
          </div>
        </div>

        {storyEntries.map(p => {
          const pg = p.page;
          const refs = useRefs ? pageRefs(book, pg) : [];
          const portrait = STORY_LAYOUTS[pg.layout]?.aspect === '2:3';
          return (
            <div key={pg.id} className="kb-card kb-illus">
              <div className="kb-page-head">
                <span className="kb-pnum">p.{p.n}</span>
                <select value={pg.layout} onChange={e => update(b => mapPage(b, pg.id, x => ({ ...x, layout: e.target.value })))} style={{ width: 'auto', fontSize: '0.75rem', padding: '3px 6px' }}>
                  {Object.entries(STORY_LAYOUTS).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}
                </select>
              </div>
              <Img store={store} id={pg.imageId} className={`kb-illus-img ${portrait ? 'portrait' : 'square'}`} onClick={() => pg.imageId && setLightbox(pg.imageId)} />
              <div className="kb-illus-text">{pg.text || <em className="text-muted">no words</em>}</div>
              <LazyText multiline rows={3} value={pg.illustration} onCommit={v => update(b => mapPage(b, pg.id, x => ({ ...x, illustration: v })))} placeholder="Describe the picture…" />
              {refs.length > 0 && (
                <div className="kb-refs" title="Reference images sent with this prompt">
                  {refs.map(r => <Img key={r.id + r.label} store={store} id={r.id} className="kb-ref" title={r.label} />)}
                  <span className="text-muted">refs</span>
                </div>
              )}
              <Thumbs store={store} ids={pg.altImages} activeId={pg.imageId} size={44}
                onPick={id => update(b => mapPage(b, pg.id, x => ({ ...x, imageId: id })))}
                onRemove={id => update(b => mapPage(b, pg.id, x => ({ ...x, altImages: x.altImages.filter(y => y !== id), imageId: x.imageId === id ? null : x.imageId })))} />
              <input type="text" placeholder="Extra direction for this picture…" value={extra[pg.id] || ''} onChange={e => setExtra(x => ({ ...x, [pg.id]: e.target.value }))} />
              <div className="flex-row">
                {busy[`img:${pg.id}`] ? <Spinner text="Painting…" /> : (
                  <button className="btn btn-sm btn-accent" onClick={() => genPage(pg.id, p.n)}>{pg.imageId ? '↻ Regenerate' : '✨ Generate'}</button>
                )}
                <UploadButton label="Upload" multiple={false} onFiles={async ([f]) => {
                  const id = await store.putImage(f);
                  update(b => mapPage(b, pg.id, x => ({ ...x, imageId: id, altImages: [...(x.altImages || []), id] })));
                }} />
              </div>
            </div>
          );
        })}
      </div>
      {!storyEntries.length && <p className="text-muted mt-md">Write the story first — each story page gets an illustration card here.</p>}

      <div className="flex-row mt-lg" style={{ justifyContent: 'center' }}>
        <button className="btn btn-accent" onClick={() => setTab('design')}>Next: Design →</button>
      </div>
      {lightbox && <Lightbox store={store} id={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}
