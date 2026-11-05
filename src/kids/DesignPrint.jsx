import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  COVER_LAYOUTS, BACK_COVER_LAYOUTS, MATTER_TYPES, STORY_LAYOUTS, PAPER, newMatter, imposition, allImageIds,
} from './model.js';
import { blurbPrompt, matterImagePrompt, coverRefs } from './prompts.js';
import { renderBookHTML, printInstructions } from './layout.js';
import { KID_FONTS, fontCssUrl, fontStack } from './fonts.js';
import { Field, LazyText, UploadButton, Spinner, Check, Img, Lightbox } from './ui.jsx';
import { PageCountPicker } from './SetupCast.jsx';
import { safeName } from './model.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function resolveUrls(book, store, asData = false) {
  const urls = {};
  await Promise.all(allImageIds(book).map(async id => {
    try {
      if (asData) {
        const b = await store.base64(id);
        urls[id] = `data:${b.mimeType};base64,${b.data}`;
      } else {
        urls[id] = await store.url(id);
      }
    } catch (e) { /* missing image */ }
  }));
  return urls;
}

export function BookPreview({ book, store, mode = 'reader', zoom = 0.5, sides = 'both', selected = null, onSelect, onFit, height = 720 }) {
  const ref = useRef(null);
  const scroll = useRef(0);
  const [html, setHtml] = useState('');

  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      const urls = await resolveUrls(book, store);
      if (alive) setHtml(renderBookHTML(book, { mode, imageUrl: id => urls[id], zoom, sides, selected, interactive: !!onSelect }));
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [book, store, mode, zoom, sides, selected, onSelect]);

  useEffect(() => {
    const f = ref.current;
    if (!f || !html) return;
    try { scroll.current = f.contentWindow?.scrollY || 0; } catch (e) { /* ignore */ }
    f.srcdoc = html;
  }, [html]);

  useEffect(() => {
    const h = e => {
      if (!ref.current || e.source !== ref.current.contentWindow) return;
      const d = e.data;
      if (!d || d.source !== 'kidsbook') return;
      if (d.type === 'fit') onFit?.(d);
      if (d.type === 'select') onSelect?.(d.n);
    };
    window.addEventListener('message', h);
    return () => window.removeEventListener('message', h);
  }, [onFit, onSelect]);

  return (
    <iframe
      ref={ref}
      className="kb-preview"
      style={{ height }}
      title="Book preview"
      onLoad={() => { try { ref.current.contentWindow.scrollTo(0, scroll.current); } catch (e) { /* ignore */ } }}
    />
  );
}

export async function printBook(book, store, sides = 'both') {
  const urls = await resolveUrls(book, store);
  const html = renderBookHTML(book, { mode: 'imposed', imageUrl: id => urls[id], sides });
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;left:-20000px;top:0;width:1300px;height:1000px;border:0;';
  document.body.appendChild(f);
  const loaded = new Promise(res => { f.onload = res; });
  f.srcdoc = html;
  await loaded;
  for (let i = 0; i < 150; i++) {
    if (f.contentDocument?.documentElement.getAttribute('data-ready')) break;
    await sleep(100);
  }
  await Promise.all([...f.contentDocument.images].map(im => (im.complete ? null : new Promise(r => { im.onload = r; im.onerror = r; }))));
  await sleep(150);
  f.contentWindow.focus();
  f.contentWindow.print();
  setTimeout(() => f.remove(), 2000);
}

function useFontLinks() {
  useEffect(() => {
    KID_FONTS.forEach(f => {
      const id = `kbfont-${f.name.replace(/\s/g, '-')}`;
      if (document.getElementById(id)) return;
      const l = document.createElement('link');
      l.id = id;
      l.rel = 'stylesheet';
      l.href = fontCssUrl(f.name).replace('display=block', 'display=swap');
      document.head.appendChild(l);
    });
  }, []);
}

function FontPicker({ label, value, onChange, sample }) {
  const cats = [...new Set(KID_FONTS.map(f => f.cat))];
  return (
    <Field label={label}>
      <select value={value} onChange={e => onChange(e.target.value)}>
        {cats.map(c => (
          <optgroup key={c} label={c}>
            {KID_FONTS.filter(f => f.cat === c).map(f => <option key={f.name} value={f.name}>{f.name}{f.note ? ` — ${f.note}` : ''}</option>)}
          </optgroup>
        ))}
      </select>
      <div className="kb-font-sample" style={{ fontFamily: fontStack(value) }}>{sample}</div>
    </Field>
  );
}

function ColorField({ label, value, onChange }) {
  return (
    <Field label={label}>
      <div className="kb-color">
        <input type="color" value={value || '#ffffff'} onChange={e => onChange(e.target.value)} />
        <input type="text" value={value || ''} onChange={e => onChange(e.target.value)} />
      </div>
    </Field>
  );
}

function ImageSlot({ store, id, onSet, onClear, onGenerate, busyKey, busy, label = 'Picture', aspectHint }) {
  const [lb, setLb] = useState(false);
  return (
    <Field label={label} hint={aspectHint}>
      <div className="flex-row">
        <Img store={store} id={id} className="kb-slot-img" onClick={() => id && setLb(true)} />
        <UploadButton label="Upload" multiple={false} onFiles={async ([f]) => onSet(await store.putImage(f))} />
        {onGenerate && (busy[busyKey] ? <Spinner text="Drawing…" /> : <button className="btn btn-sm" onClick={onGenerate}>✨ Generate</button>)}
        {id && <button className="btn btn-sm" onClick={onClear}>Remove</button>}
      </div>
      {lb && <Lightbox store={store} id={id} onClose={() => setLb(false)} />}
    </Field>
  );
}

function MatterList({ which, book, update, store, ai, run, busy }) {
  const list = book[which];
  const [addType, setAddType] = useState(which === 'frontMatter' ? 'dedication' : 'note');
  const set = (id, patch) => update(b => ({ ...b, [which]: b[which].map(m => (m.id === id ? { ...m, ...patch } : m)) }));
  const move = (i, d) => update(b => {
    const arr = [...b[which]];
    const j = i + d;
    if (j < 0 || j >= arr.length) return b;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    return { ...b, [which]: arr };
  });
  const remove = id => update(b => ({ ...b, [which]: b[which].filter(m => m.id !== id) }));
  const gen = m => run(`matter:${m.id}`, async () => {
    const refs = coverRefs(book);
    const id = await ai.image({ prompt: matterImagePrompt(book, m, refs), refs, aspect: m.type === 'image' ? '2:3' : '1:1' });
    set(m.id, { imageId: id });
  });
  const hasText = t => ['copyright', 'dedication', 'about-author', 'about-illustrator', 'note', 'the-end'].includes(t);
  const hasTitle = t => ['contents', 'about-author', 'about-illustrator', 'note', 'the-end'].includes(t);
  const hasImage = t => ['title', 'about-author', 'about-illustrator', 'note', 'the-end', 'image'].includes(t);

  return (
    <div>
      {list.map((m, i) => (
        <div key={m.id} className="kb-matter">
          <div className="flex-row">
            <select value={m.type} onChange={e => set(m.id, { type: e.target.value })} style={{ width: 'auto' }}>
              {Object.entries(MATTER_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <span className="text-muted" style={{ marginLeft: 'auto' }}>
              {which === 'frontMatter' ? `page ${i + 2}` : `page ${book.pageCount - list.length + i}`}
            </span>
            <button className="btn btn-sm" onClick={() => move(i, -1)}>↑</button>
            <button className="btn btn-sm" onClick={() => move(i, 1)}>↓</button>
            <button className="remove-btn" onClick={() => remove(m.id)}>×</button>
          </div>
          {hasTitle(m.type) && <LazyText value={m.title} onCommit={v => set(m.id, { title: v })} placeholder="Heading" />}
          {hasText(m.type) && <LazyText multiline rows={m.type === 'copyright' ? 4 : 3} value={m.text} onCommit={v => set(m.id, { text: v })} placeholder={m.type === 'about-author' ? 'A few friendly sentences about you…' : 'Text…'} />}
          {m.type === 'title' && <div className="text-muted">Uses the book title, subtitle, author and illustrator.</div>}
          {m.type === 'contents' && <div className="text-muted">Lists chapters with page numbers automatically.</div>}
          {hasImage(m.type) && (
            <ImageSlot store={store} id={m.imageId} busy={busy} busyKey={`matter:${m.id}`}
              label={m.type.startsWith('about') ? 'Photo' : 'Picture'}
              onSet={id => set(m.id, { imageId: id })} onClear={() => set(m.id, { imageId: null })}
              onGenerate={m.type.startsWith('about') ? null : () => gen(m)} />
          )}
        </div>
      ))}
      <div className="flex-row">
        <select value={addType} onChange={e => setAddType(e.target.value)} style={{ width: 'auto' }}>
          {Object.entries(MATTER_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <button className="btn btn-sm" onClick={() => update(b => ({ ...b, [which]: [...b[which], newMatter(addType)] }))}>+ Add page</button>
      </div>
    </div>
  );
}

export function DesignPanel({ book, update, store, ai, run, busy, plan }) {
  useFontLinks();
  const [section, setSection] = useState('type');
  const [fit, setFit] = useState({ over: [], shrunk: [] });
  const [selected, setSelected] = useState(null);
  const [zoom, setZoom] = useState(0.55);
  const d = book.design;
  const setD = patch => update(b => ({ ...b, design: { ...b.design, ...patch } }));
  const setCover = patch => update(b => ({ ...b, cover: { ...b.cover, ...patch } }));
  const setBack = patch => update(b => ({ ...b, backCover: { ...b.backCover, ...patch } }));
  const onFit = useCallback(f => setFit(f), []);
  const onSelect = useCallback(n => setSelected(s => (s === n ? null : n)), []);

  const writeBlurb = () => run('blurb', async () => {
    const res = await ai.json({ prompt: blurbPrompt(book) });
    setBack({ blurb: res.blurb || book.backCover.blurb, tagline: res.tagline || book.backCover.tagline });
  });

  const sel = selected ? plan.pages[selected - 1] : null;
  const selPage = sel && sel.kind === 'story' ? sel.page : null;
  const setSelPage = patch => update(b => ({ ...b, chapters: b.chapters.map(ch => ({ ...ch, pages: ch.pages.map(p => (p.id === selPage.id ? { ...p, ...patch } : p)) })) }));

  return (
    <div className="kb-design">
      <div className="kb-design-controls">
        <div className="kb-seg kb-seg-wide">
          {[['type', 'Type & page'], ['cover', 'Cover'], ['back', 'Back cover'], ['matter', 'Front/back pages']].map(([k, l]) => (
            <button key={k} className={section === k ? 'on' : ''} onClick={() => setSection(k)}>{l}</button>
          ))}
        </div>

        {(fit.over.length > 0 || fit.shrunk.length > 0) && (
          <div className="kb-warn">
            {fit.over.length > 0 && <div>Text doesn’t fit on page {fit.over.join(', ')} — shorten it, pick a roomier layout, or lower the font size.</div>}
            {fit.shrunk.length > 0 && <div className="text-muted">Auto-shrunk to fit: page {fit.shrunk.join(', ')}.</div>}
          </div>
        )}

        {selPage && (
          <div className="kb-card">
            <div className="flex-row" style={{ justifyContent: 'space-between' }}><strong>Page {selected}</strong><button className="btn btn-sm" onClick={() => setSelected(null)}>Close</button></div>
            <Field label="Layout">
              <select value={selPage.layout} onChange={e => setSelPage({ layout: e.target.value })}>
                {Object.entries(STORY_LAYOUTS).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}
              </select>
            </Field>
            <Field label="Words"><LazyText multiline rows={3} value={selPage.text} onCommit={v => setSelPage({ text: v })} /></Field>
          </div>
        )}

        {section === 'type' && (
          <>
            <FontPicker label="Title font" value={d.titleFont} onChange={v => setD({ titleFont: v })} sample={book.title || 'The Brave Little Hedgehog'} />
            <FontPicker label="Story font" value={d.bodyFont} onChange={v => setD({ bodyFont: v })} sample="Once upon a time, a little hedgehog peeked out of her den." />
            <div className="kb-row">
              <Field label={`Story text size: ${d.bodySize}pt`}>
                <input type="range" min={11} max={30} step={0.5} value={d.bodySize} onChange={e => setD({ bodySize: Number(e.target.value) })} />
              </Field>
              <Field label={`Line spacing: ${d.lineHeight}`}>
                <input type="range" min={1.1} max={2} step={0.05} value={d.lineHeight} onChange={e => setD({ lineHeight: Number(e.target.value) })} />
              </Field>
            </div>
            <div className="kb-row">
              <Field label="Align">
                <div className="kb-seg">
                  {['left', 'center'].map(a => <button key={a} className={d.align === a ? 'on' : ''} onClick={() => setD({ align: a })}>{a}</button>)}
                </div>
              </Field>
              <Field label="Words box on full pictures">
                <select value={d.overlayBox} onChange={e => setD({ overlayBox: e.target.value })}>
                  <option value="soft">Soft rounded box</option>
                  <option value="solid">Solid box with border</option>
                  <option value="none">No box (glow)</option>
                </select>
              </Field>
            </div>
            <div className="kb-row">
              <ColorField label="Page color" value={d.pageBg} onChange={v => setD({ pageBg: v })} />
              <ColorField label="Text color" value={d.textColor} onChange={v => setD({ textColor: v })} />
              <ColorField label="Accent color" value={d.accentColor} onChange={v => setD({ accentColor: v })} />
            </div>
            <div className="kb-row">
              <Field label={`Safe margin: ${d.safeMargin}in`} hint="Home printers can't print the outer ~0.2in of a sheet.">
                <input type="range" min={0.2} max={0.75} step={0.05} value={d.safeMargin} onChange={e => setD({ safeMargin: Number(e.target.value) })} />
              </Field>
            </div>
            <div className="flex-row">
              <Check checked={d.bleed} onChange={v => setD({ bleed: v })}>Pictures run to the page edge</Check>
              <Check checked={d.pageNumbers} onChange={v => setD({ pageNumbers: v })}>Page numbers</Check>
              <Check checked={d.autoFit} onChange={v => setD({ autoFit: v })}>Shrink text that doesn’t fit</Check>
            </div>
          </>
        )}

        {section === 'cover' && (
          <>
            <Field label="Cover layout">
              <select value={book.cover.layout} onChange={e => setCover({ layout: e.target.value })}>
                {Object.entries(COVER_LAYOUTS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </Field>
            <div className="kb-row">
              <Field label="Title"><LazyText value={book.title} onCommit={v => update({ title: v })} /></Field>
              <Field label="Subtitle"><LazyText value={book.subtitle} onCommit={v => update({ subtitle: v })} /></Field>
            </div>
            <div className="kb-row">
              <ColorField label="Title color" value={book.cover.titleColor} onChange={v => setCover({ titleColor: v })} />
              <ColorField label="Title outline" value={book.cover.titleStroke} onChange={v => setCover({ titleStroke: v })} />
              <ColorField label="Background" value={book.cover.bgColor} onChange={v => setCover({ bgColor: v })} />
            </div>
            <Check checked={!book.cover.titleStroke} onChange={v => setCover({ titleStroke: v ? '' : '#2b2b4a' })}>No title outline</Check>
            <ImageSlot store={store} id={book.cover.imageId} busy={busy} label="Cover picture (generate it on the Illustrations tab)"
              onSet={id => setCover({ imageId: id, altImages: [...(book.cover.altImages || []), id] })} onClear={() => setCover({ imageId: null })} />
          </>
        )}

        {section === 'back' && (
          <>
            <Field label="Back cover layout">
              <select value={book.backCover.layout} onChange={e => setBack({ layout: e.target.value })}>
                {Object.entries(BACK_COVER_LAYOUTS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </Field>
            <Field label="Tagline"><LazyText value={book.backCover.tagline} onCommit={v => setBack({ tagline: v })} placeholder="A big adventure for a small hedgehog!" /></Field>
            <Field label="Blurb"><LazyText multiline rows={4} value={book.backCover.blurb} onCommit={v => setBack({ blurb: v })} /></Field>
            {busy.blurb ? <Spinner text="Writing blurb…" /> : <button className="btn btn-sm" onClick={writeBlurb}>✨ Write blurb &amp; tagline</button>}
            <ImageSlot store={store} id={book.backCover.imageId} busy={busy} label="Back picture (blank = reuse the cover)"
              onSet={id => setBack({ imageId: id })} onClear={() => setBack({ imageId: null })} />
            <div className="kb-row">
              <ColorField label="Background" value={book.backCover.bgColor} onChange={v => setBack({ bgColor: v })} />
            </div>
            <div className="flex-row">
              <Check checked={book.backCover.showAge} onChange={v => setBack({ showAge: v })}>Show “Ages {book.ageRange}”</Check>
              <Check checked={book.backCover.showBarcodeBox} onChange={v => setBack({ showBarcodeBox: v })}>Leave a barcode box</Check>
            </div>
          </>
        )}

        {section === 'matter' && (
          <>
            <PageCountPicker book={book} update={update} />
            <h3 className="kb-h3 mt-md">Front pages (after the cover)</h3>
            <MatterList which="frontMatter" book={book} update={update} store={store} ai={ai} run={run} busy={busy} />
            <h3 className="kb-h3 mt-lg">Back pages (before the back cover)</h3>
            <MatterList which="backMatter" book={book} update={update} store={store} ai={ai} run={run} busy={busy} />
          </>
        )}
      </div>

      <div className="kb-design-preview">
        <div className="flex-row" style={{ justifyContent: 'space-between' }}>
          <span className="text-muted">Live preview — spreads as they’ll look once folded. Click a story page to edit it.</span>
          <label className="flex-row" style={{ margin: 0 }}>Zoom
            <input type="range" min={0.3} max={1} step={0.05} value={zoom} onChange={e => setZoom(Number(e.target.value))} style={{ width: 100 }} />
          </label>
        </div>
        <BookPreview book={book} store={store} zoom={zoom} selected={selected} onSelect={onSelect} onFit={onFit} height="calc(100vh - 140px)" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function PrintPanel({ book, update, store, run, busy, plan, download }) {
  const sheets = imposition(book.pageCount);
  const [previewSides, setPreviewSides] = useState('both');
  const setP = patch => update(b => ({ ...b, print: { ...b.print, ...patch } }));
  const label = n => {
    const p = plan.pages[n - 1];
    if (!p) return '';
    if (p.kind === 'cover') return 'Front cover';
    if (p.kind === 'back-cover') return 'Back cover';
    if (p.kind === 'story') return `Story ${p.storyIndex + 1}`;
    if (p.kind === 'filler') return 'Empty';
    return MATTER_TYPES[p.matter.type] || p.matter.type;
  };
  const doPrint = sides => run(`print:${sides}`, () => printBook(book, store, sides));
  const downloadHtml = () => run('dlhtml', async () => {
    const urls = await resolveUrls(book, store, true);
    const html = renderBookHTML(book, { mode: 'imposed', imageUrl: id => urls[id], sides: 'both', title: `${book.title} — print booklet` });
    download(`${safeName(book.title)}-booklet.html`, html, 'text/html');
  });
  const missingImgs = plan.pages.filter(p => p.kind === 'story' && !p.page.imageId && p.page.layout !== 'text-only').length;

  return (
    <div className="kb-panel">
      <div className="kb-print-grid">
        <div>
          <div className="kb-card">
            <h3>Booklet</h3>
            <PageCountPicker book={book} update={update} />
            {plan.warnings.map(w => <div key={w} className="kb-warn">{w}</div>)}
            {missingImgs > 0 && <div className="kb-warn">{missingImgs} story page(s) have no picture yet.</div>}
          </div>

          <div className="kb-card">
            <h3>Printer</h3>
            <Field label="Two-sided printing flips on the…">
              <div className="kb-seg">
                <button className={book.print.flip === 'short' ? 'on' : ''} onClick={() => setP({ flip: 'short' })}>Short edge (usual)</button>
                <button className={book.print.flip === 'long' ? 'on' : ''} onClick={() => setP({ flip: 'long' })}>Long edge</button>
              </div>
            </Field>
            <div className="text-muted mb-sm">If the backs come out upside down after a test print, switch this.</div>
            <div className="flex-row">
              <Check checked={book.print.reverseBacks} onChange={v => setP({ reverseBacks: v })}>Reverse order of backs (manual duplex)</Check>
              <Check checked={book.print.foldMarks} onChange={v => setP({ foldMarks: v })}>Fold marks</Check>
              <Check checked={book.print.sheetLabels} onChange={v => setP({ sheetLabels: v })}>Tiny sheet numbers</Check>
            </div>
            <div className="flex-row mt-md">
              {busy['print:both'] ? <Spinner text="Preparing…" /> : <button className="btn btn-accent" onClick={() => doPrint('both')}>🖨 Print booklet (two-sided)</button>}
              {busy['print:fronts'] ? <Spinner text="Preparing…" /> : <button className="btn" onClick={() => doPrint('fronts')}>Fronts only</button>}
              {busy['print:backs'] ? <Spinner text="Preparing…" /> : <button className="btn" onClick={() => doPrint('backs')}>Backs only</button>}
            </div>
            <div className="flex-row mt-sm">
              {busy.dlhtml ? <Spinner text="Packing images…" /> : <button className="btn btn-sm" onClick={downloadHtml}>⬇ Download print file (.html, open &amp; print anytime)</button>}
            </div>
            <p className="text-muted mt-sm">Want a PDF? Click Print and pick “Save as PDF” as the printer (landscape, margins none, background graphics on).</p>
          </div>

          <div className="kb-card">
            <h3>How to print &amp; fold</h3>
            <ol className="kb-steps">{printInstructions(book).map(s => <li key={s}>{s}</li>)}</ol>
          </div>

          <div className="kb-card">
            <h3>Sheet order</h3>
            <table className="kb-table">
              <thead><tr><th>Sheet</th><th>Front (left | right)</th><th>Back (left | right)</th></tr></thead>
              <tbody>
                {sheets.map(s => (
                  <tr key={s.sheet}>
                    <td>{s.sheet}</td>
                    <td><b>{s.front[0]}</b> {label(s.front[0])} | <b>{s.front[1]}</b> {label(s.front[1])}</td>
                    <td><b>{s.back[0]}</b> {label(s.back[0])} | <b>{s.back[1]}</b> {label(s.back[1])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="text-muted mt-sm">Sheet 1 is the outside of the booklet. {PAPER[book.paper].label}.</div>
          </div>
        </div>
        <div>
          <div className="flex-row mb-sm">
            <span className="text-muted">Printed sheets preview:</span>
            <div className="kb-seg">
              {['both', 'fronts', 'backs'].map(s => <button key={s} className={previewSides === s ? 'on' : ''} onClick={() => setPreviewSides(s)}>{s}</button>)}
            </div>
          </div>
          <BookPreview book={book} store={store} mode="imposed" sides={previewSides} zoom={0.42} height="calc(100vh - 120px)" />
        </div>
      </div>
    </div>
  );
}
