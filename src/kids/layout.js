// Renders a kids book to a self-contained HTML document.
// One layout engine for: on-screen spread preview, imposed duplex print sheets, and standalone export.
// Isomorphic (returns a string) so the MCP server can write print files too.
import { PAPER, computePlan, imposition } from './model.js';
import { fontCssUrl, fontStack, boldWeight } from './fonts.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inline = s => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>');
function rich(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  return t.split(/\n\s*\n/).map(par => `<p>${inline(esc(par)).replace(/\n/g, '<br>')}</p>`).join('');
}

function hexToRgba(hex, a) {
  const h = String(hex || '#ffffff').replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h.padEnd(6, '0');
  const n = parseInt(full.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// Outline effect for titles over pictures (works in every browser, unlike text-stroke on HTML).
function outline(color, w = 0.045) {
  const d = [[0, 1], [1, 0], [0, -1], [-1, 0], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]];
  return d.map(([x, y]) => `${(x * w).toFixed(3)}em ${(y * w).toFixed(3)}em 0 ${color}`).join(', ') + `, 0 ${w * 2}em ${w * 3}em rgba(0,0,0,.35)`;
}

export function renderBookHTML(book, opts = {}) {
  const {
    mode = 'reader', // 'reader' | 'imposed'
    imageUrl = () => null,
    zoom = 1,
    sides = 'both', // imposed: 'both' | 'fronts' | 'backs'
    selected = null,
    interactive = false,
    title = book.title || 'Kids book',
  } = opts;
  const paper = PAPER[book.paper] || PAPER.letter;
  const u = paper.unit;
  const d = book.design;
  const plan = computePlan(book);
  const M = u === 'mm' ? d.safeMargin * 25.4 : d.safeMargin;
  const pw = paper.pageW;
  const ph = paper.pageH;
  const chapters = book.chapterMode === 'chapters';

  const img = (id, alt = 'illustration') => {
    const url = id ? imageUrl(id) : null;
    return url
      ? `<img src="${esc(url)}" alt="" draggable="false">`
      : `<div class="noimg"><span>${esc(alt)}</span></div>`;
  };

  const pageNum = n => (d.pageNumbers ? `<div class="pn"><span>${n}</span></div>` : '');

  const chapterHead = p => {
    if (!chapters || !p.isChapterStart) return '';
    return `<div class="ch-head"><div class="ch-num">Chapter ${p.chapterIdx + 1}</div>${p.chapter.title ? `<div class="ch-title">${esc(p.chapter.title)}</div>` : ''}</div>`;
  };

  // ---------------- page renderers ----------------
  function storyPage(p) {
    const pg = p.page;
    const words = `${chapterHead(p)}${rich(pg.text)}`;
    const layout = pg.layout || 'image-top';
    const bleed = d.bleed ? 'bleed' : 'inset';
    if (layout === 'image-top' || layout === 'image-bottom') {
      return `<div class="story ${layout} ${bleed}">
        <div class="pic">${img(pg.imageId, pg.illustration || 'illustration')}</div>
        <div class="words" data-fit="0.55"><div class="inner">${words}</div></div>
      </div>${pageNum(p.n)}`;
    }
    if (layout === 'full-text-top' || layout === 'full-text-bottom') {
      return `<div class="story full ${layout} ${bleed}">
        <div class="pic">${img(pg.imageId, pg.illustration || 'illustration')}</div>
        ${words ? `<div class="overlay box-${d.overlayBox}" data-fit="0.55"><div class="inner">${words}</div></div>` : ''}
      </div>${pageNum(p.n)}`;
    }
    if (layout === 'image-only') {
      return `<div class="story full image-only ${bleed}"><div class="pic">${img(pg.imageId, pg.illustration || 'illustration')}</div></div>${pageNum(p.n)}`;
    }
    // text-only
    return `<div class="story text-only">
      ${pg.imageId ? `<div class="spot">${img(pg.imageId)}</div>` : ''}
      <div class="words" data-fit="0.55"><div class="inner">${words}</div></div>
      <div class="orn">✦ ✦ ✦</div>
    </div>${pageNum(p.n)}`;
  }

  function coverPage() {
    const c = book.cover;
    const L = c.layout || 'full-title-top';
    const titleStyle = `color:${esc(c.titleColor)};${c.titleStroke ? `text-shadow:${outline(c.titleStroke)}` : ''}`;
    const titleBlock = `<div class="ttl" style="${titleStyle}">${esc(book.title || 'Untitled')}</div>${book.subtitle ? `<div class="sub" style="${titleStyle}">${esc(book.subtitle)}</div>` : ''}`;
    const byline = [book.author ? `by ${esc(book.author)}` : '', book.illustrator && book.illustrator !== book.author ? `illustrated by ${esc(book.illustrator)}` : ''].filter(Boolean).join('<br>');
    const by = byline ? `<div class="by" style="${titleStyle}">${byline}</div>` : '';
    const bleed = d.bleed ? 'bleed' : 'inset';
    return `<div class="cover ${L} ${bleed}" style="background:${esc(c.bgColor)}">
      <div class="pic">${img(c.imageId, 'cover illustration')}</div>
      ${L === 'full-title-bottom' ? `<div class="band" style="background:${hexToRgba(c.bgColor, 0.92)}"></div>` : ''}
      <div class="title-zone" data-fit="0.4"><div class="inner">${titleBlock}</div></div>
      ${by ? `<div class="by-zone">${by}</div>` : ''}
    </div>`;
  }

  function backCoverPage() {
    const b = book.backCover;
    const picId = b.imageId || book.cover.imageId;
    const age = b.showAge && book.ageRange ? `<div class="age">Ages ${esc(book.ageRange)}</div>` : '';
    const credits = [book.author ? esc(book.author) : '', book.illustrator && book.illustrator !== book.author ? `Illustrated by ${esc(book.illustrator)}` : ''].filter(Boolean).join(' · ');
    const barcode = b.showBarcodeBox ? '<div class="barcode"></div>' : '';
    if (b.layout === 'blurb-over-image') {
      return `<div class="back-cover over" style="background:${esc(b.bgColor)}">
        <div class="pic faded">${img(picId, 'back cover picture')}</div>
        <div class="blurb-box" data-fit="0.6"><div class="inner">${b.tagline ? `<div class="tag">${esc(b.tagline)}</div>` : ''}${rich(b.blurb)}</div></div>
        <div class="foot">${credits ? `<div class="cred">${credits}</div>` : ''}${age}</div>${barcode}
      </div>`;
    }
    return `<div class="back-cover center" style="background:${esc(b.bgColor)}">
      ${picId ? `<div class="medallion">${img(picId)}</div>` : ''}
      <div class="blurb-zone" data-fit="0.6"><div class="inner">${b.tagline ? `<div class="tag">${esc(b.tagline)}</div>` : ''}${rich(b.blurb)}</div></div>
      <div class="foot">${credits ? `<div class="cred">${credits}</div>` : ''}${age}</div>${barcode}
    </div>`;
  }

  function matterPage(m) {
    switch (m.type) {
      case 'title':
        return `<div class="matter title-page${m.imageId ? '' : ' no-spot'}">
          <div class="tp-title" data-fit="0.5"><div class="inner"><div class="ttl">${esc(book.title || 'Untitled')}</div>${book.subtitle ? `<div class="sub">${esc(book.subtitle)}</div>` : ''}</div></div>
          ${m.imageId ? `<div class="spot">${img(m.imageId)}</div>` : ''}
          <div class="tp-by">${book.author ? `<div>by ${esc(book.author)}</div>` : ''}${book.illustrator && book.illustrator !== book.author ? `<div class="ill">illustrated by ${esc(book.illustrator)}</div>` : ''}</div>
        </div>`;
      case 'copyright':
        return `<div class="matter copyright"><div class="cr-text">${rich(m.text)}</div></div>`;
      case 'dedication':
        return `<div class="matter dedication"><div class="ded" data-fit="0.6"><div class="inner">${rich(m.text)}</div></div></div>`;
      case 'contents': {
        const rows = book.chapters.map((ch, i) => `<div class="toc-row"><span class="toc-t">${esc(ch.title || `Chapter ${i + 1}`)}</span><span class="dots"></span><span class="toc-n">${plan.chapterStarts[i] || ''}</span></div>`).join('');
        return `<div class="matter contents"><div class="m-title">${esc(m.title || 'Contents')}</div><div class="toc" data-fit="0.6"><div class="inner">${rows}</div></div></div>`;
      }
      case 'about-author':
      case 'about-illustrator':
      case 'note':
        return `<div class="matter about">
          ${m.title ? `<div class="m-title">${esc(m.title)}</div>` : ''}
          ${m.imageId ? `<div class="photo">${img(m.imageId)}</div>` : ''}
          <div class="m-text" data-fit="0.55"><div class="inner">${rich(m.text)}</div></div>
        </div>`;
      case 'the-end':
        return `<div class="matter the-end">${m.imageId ? `<div class="spot">${img(m.imageId)}</div>` : ''}<div class="end">${esc(m.title || 'The End')}</div>${m.text ? `<div class="m-text small">${rich(m.text)}</div>` : ''}</div>`;
      case 'image':
        return `<div class="story full image-only ${d.bleed ? 'bleed' : 'inset'}"><div class="pic">${img(m.imageId, 'full-page picture')}</div></div>`;
      default:
        return '<div class="matter blank"></div>';
    }
  }

  const kindLabel = p => ({
    cover: 'Front cover', 'back-cover': 'Back cover', filler: 'Empty story slot',
    story: `Story ${p.storyIndex + 1}${chapters ? ` · Ch ${p.chapterIdx + 1}` : ''}`,
    front: p.matter && p.matter.type, back: p.matter && p.matter.type,
  }[p.kind] || p.kind);

  function renderPage(n) {
    const p = plan.pages[n - 1];
    if (!p) return `<div class="page" data-n="${n}"></div>`;
    let inner = '';
    if (p.kind === 'cover') inner = coverPage();
    else if (p.kind === 'back-cover') inner = backCoverPage();
    else if (p.kind === 'story') inner = storyPage(p);
    else if (p.kind === 'front' || p.kind === 'back') inner = matterPage(p.matter);
    else inner = `<div class="matter blank"><div class="filler-note">Empty story slot</div></div>${pageNum(n)}`;
    const sel = selected === n ? ' selected' : '';
    return `<div class="page${sel}" data-n="${n}" data-kind="${p.kind}">${inner}</div>`;
  }

  // ---------------- document body ----------------
  let body = '';
  const N = book.pageCount;
  if (mode === 'imposed') {
    let sheets = imposition(N);
    const parts = [];
    const sideList = sides === 'fronts' ? ['front'] : sides === 'backs' ? ['back'] : ['front', 'back'];
    if (sides === 'backs' && book.print.reverseBacks) sheets = [...sheets].reverse();
    sheets.forEach(s => {
      sideList.forEach(side => {
        const [l, r] = s[side];
        const flip = side === 'back' && book.print.flip === 'long' ? ' flip' : '';
        parts.push(`<section class="sheet ${side}${flip}">
          <div class="sheet-label screen-only">Sheet ${s.sheet} of ${sheets.length} — ${side} &nbsp;·&nbsp; pages ${l} | ${r}</div>
          <div class="sheet-inner">
            ${renderPage(l)}${renderPage(r)}
            ${book.print.foldMarks ? '<div class="fold top"></div><div class="fold bottom"></div>' : ''}
            ${book.print.sheetLabels ? `<div class="tiny-label">${s.sheet}${side === 'front' ? 'F' : 'B'}</div>` : ''}
          </div>
        </section>`);
      });
    });
    body = parts.join('\n');
  } else {
    const spreads = [[null, 1]];
    for (let n = 2; n < N; n += 2) spreads.push([n, n + 1 < N ? n + 1 : null]);
    spreads.push([N, null]);
    body = spreads.map(([l, r]) => {
      const cell = n => (n ? `<figure>${renderPage(n)}<figcaption>${n} · ${esc(kindLabel(plan.pages[n - 1] || {}))}</figcaption></figure>` : '<figure class="ghost"></figure>');
      return `<div class="spread">${cell(l)}${cell(r)}</div>`;
    }).join('\n');
  }

  const fonts = [...new Set([d.titleFont, d.bodyFont])];
  const tw = boldWeight(d.titleFont);
  const sheetW = `${paper.sheetW}${u}`;
  const sheetH = `${paper.sheetH}${u}`;

  const css = `
@page { size: ${sheetW} ${sheetH}; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: #dcd8cf; }
body { -webkit-print-color-adjust: exact; print-color-adjust: exact; font-family: ${fontStack(d.bodyFont)}; }
:root {
  --pw: ${pw}${u}; --ph: ${ph}${u}; --m: ${M}${u};
  --text: ${d.textColor}; --accent: ${d.accentColor}; --bg: ${d.pageBg};
  --body: ${fontStack(d.bodyFont)}; --title: ${fontStack(d.titleFont)};
  --size: ${d.bodySize}pt; --lh: ${d.lineHeight}; --align: ${d.align}; --tw: ${tw};
}
.page { width: var(--pw); height: var(--ph); position: relative; overflow: hidden; background: var(--bg); color: var(--text);
  font-family: var(--body); font-size: var(--size); line-height: var(--lh); flex: none; }
.page img { width: 100%; height: 100%; object-fit: cover; display: block; }
.noimg { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; text-align: center; padding: 0.3in;
  background: repeating-linear-gradient(45deg, #f3efe6, #f3efe6 10px, #ebe6da 10px, #ebe6da 20px); color: #9a9284; font: 9pt/1.3 sans-serif; overflow: hidden; }
.noimg span { display: -webkit-box; -webkit-line-clamp: 6; -webkit-box-orient: vertical; overflow: hidden; }
.inner p + p { margin-top: 0.55em; }
[data-fit] { overflow: hidden; }

/* story pages */
.story { position: absolute; inset: 0; }
.story .pic { position: absolute; overflow: hidden; }
.story .words { position: absolute; left: var(--m); right: var(--m); display: flex; text-align: var(--align); }
.story .words .inner { margin: auto 0; width: 100%; }
.story.image-top.bleed .pic { top: 0; left: 0; right: 0; height: 60%; }
.story.image-top.inset .pic { top: var(--m); left: var(--m); right: var(--m); height: calc(60% - var(--m)); border-radius: 0.12in; }
.story.image-top .words { top: calc(60% + 0.16in); bottom: calc(var(--m) + 0.18in); }
.story.image-bottom.bleed .pic { bottom: 0; left: 0; right: 0; height: 60%; }
.story.image-bottom.inset .pic { bottom: var(--m); left: var(--m); right: var(--m); height: calc(60% - var(--m)); border-radius: 0.12in; }
.story.image-bottom .words { top: var(--m); bottom: calc(60% + 0.16in); }
.story.full.bleed .pic { inset: 0; }
.story.full.inset .pic { inset: var(--m); border-radius: 0.12in; }
.overlay { position: absolute; left: calc(var(--m) + 0.05in); right: calc(var(--m) + 0.05in); max-height: 40%; text-align: var(--align); padding: 0.14in 0.2in; }
.full-text-bottom .overlay { bottom: calc(var(--m) + 0.25in); }
.full-text-top .overlay { top: calc(var(--m) + 0.1in); }
.box-soft { background: ${hexToRgba(d.pageBg, 0.88)}; border-radius: 0.16in; box-shadow: 0 0.03in 0.12in rgba(0,0,0,.18); }
.box-solid { background: var(--bg); border-radius: 0.06in; border: 0.03in solid var(--accent); }
.box-none { text-shadow: 0 0 0.06in ${d.pageBg}, 0 0 0.12in ${d.pageBg}, 0 0 0.18in ${d.pageBg}; }
.story.text-only .spot { position: absolute; top: var(--m); left: 25%; right: 25%; height: 30%; border-radius: 50%; overflow: hidden; }
.story.text-only .words { top: calc(var(--m) + 0.2in); bottom: calc(var(--m) + 0.6in); }
.story.text-only .spot + .words { top: calc(30% + var(--m) + 0.2in); }
.story.text-only .words .inner { font-size: 1.12em; }
.orn { position: absolute; left: 0; right: 0; bottom: calc(var(--m) + 0.3in); text-align: center; color: var(--accent); letter-spacing: 0.4em; font-size: 10pt; }
.ch-head { margin-bottom: 0.6em; text-align: center; }
.ch-num { font-family: var(--title); color: var(--accent); font-size: 0.7em; text-transform: uppercase; letter-spacing: 0.18em; }
.ch-title { font-family: var(--title); font-weight: var(--tw); font-size: 1.35em; line-height: 1.1; }
.pn { position: absolute; left: 0; right: 0; bottom: calc(var(--m) * 0.55); text-align: center; font-size: 8.5pt; line-height: 1; }
.pn span { display: inline-block; padding: 0.03in 0.09in; border-radius: 1in; background: ${hexToRgba(d.pageBg, 0.8)}; opacity: 0.85; }

/* cover */
.cover { position: absolute; inset: 0; font-family: var(--title); text-align: center; }
.cover .pic { position: absolute; overflow: hidden; }
.cover.bleed.full-title-top .pic, .cover.bleed.full-title-bottom .pic { inset: 0; }
.cover.inset.full-title-top .pic, .cover.inset.full-title-bottom .pic { inset: var(--m); border-radius: 0.14in; }
.cover .title-zone { position: absolute; left: calc(var(--m) + 0.05in); right: calc(var(--m) + 0.05in); display: flex; font-size: 46pt; }
.cover .title-zone .inner { margin: auto 0; width: 100%; }
.cover .ttl { font-weight: var(--tw); line-height: 1.02; }
.cover .sub { font-size: 0.42em; margin-top: 0.25em; font-family: var(--body); font-weight: 700; }
.cover .by-zone { position: absolute; left: var(--m); right: var(--m); bottom: calc(var(--m) + 0.05in); font-size: 15pt; line-height: 1.25; }
.cover .by { font-family: var(--body); font-weight: 700; }
.cover.full-title-top .title-zone { top: calc(var(--m) + 0.1in); height: 34%; }
.cover.full-title-bottom .band { position: absolute; left: 0; right: 0; bottom: 0; height: 34%; }
.cover.full-title-bottom .title-zone { bottom: calc(var(--m) + 0.55in); height: calc(34% - var(--m) - 0.6in); }
.cover.framed .title-zone { top: var(--m); height: 24%; }
.cover.framed .pic { top: calc(24% + var(--m) + 0.05in); bottom: calc(var(--m) + 0.75in); left: calc(var(--m) + 0.1in); right: calc(var(--m) + 0.1in);
  border-radius: 0.2in; border: 0.07in solid #fff; box-shadow: 0 0.05in 0.2in rgba(0,0,0,.25); }
.cover.classic .title-zone { top: var(--m); height: calc(33% - var(--m) - 0.05in); }
.cover.classic .pic { left: 0; right: 0; bottom: 0; top: 34%; }
.cover.inset.classic .pic { left: var(--m); right: var(--m); bottom: var(--m); border-radius: 0.14in; }

/* back cover */
.back-cover { position: absolute; inset: 0; text-align: center; }
.back-cover .medallion { position: absolute; top: calc(var(--m) + 0.15in); left: 32%; right: 32%; aspect-ratio: 1; border-radius: 50%; overflow: hidden;
  border: 0.06in solid #fff; box-shadow: 0 0.04in 0.15in rgba(0,0,0,.2); }
.back-cover .blurb-zone { position: absolute; left: calc(var(--m) + 0.15in); right: calc(var(--m) + 0.15in); top: 34%; bottom: 26%; display: flex; font-size: 1.05em; }
.back-cover .blurb-zone .inner, .back-cover .blurb-box .inner { margin: auto 0; width: 100%; }
.back-cover .tag { font-family: var(--title); font-weight: var(--tw); color: var(--accent); font-size: 1.35em; line-height: 1.15; margin-bottom: 0.5em; }
.back-cover .foot { position: absolute; left: var(--m); right: var(--m); bottom: calc(var(--m) + 0.05in); font-size: 10pt; line-height: 1.4; }
.back-cover .age { display: inline-block; margin-top: 0.08in; padding: 0.03in 0.14in; border-radius: 1in; background: var(--accent); color: #fff; font-weight: 700; font-size: 9pt; }
.back-cover .barcode { position: absolute; right: var(--m); bottom: var(--m); width: 1.9in; height: 1.1in; background: #fff; border: 1px solid #ccc; }
.back-cover.over .pic { position: absolute; inset: 0; }
.back-cover.over .pic.faded img { opacity: 0.55; }
.back-cover.over .blurb-box { position: absolute; left: calc(var(--m) + 0.1in); right: calc(var(--m) + 0.1in); top: 22%; max-height: 52%; padding: 0.2in 0.25in;
  background: ${hexToRgba(d.pageBg, 0.9)}; border-radius: 0.16in; display: flex; }

/* front / back matter */
.matter { position: absolute; inset: var(--m); text-align: center; display: flex; flex-direction: column; }
.title-page .tp-title { flex: 0 0 34%; display: flex; font-family: var(--title); font-size: 34pt; color: var(--accent); }
.title-page .tp-title .inner { margin: auto 0; width: 100%; }
.title-page .ttl { font-weight: var(--tw); line-height: 1.05; }
.title-page .sub { font-size: 0.42em; color: var(--text); margin-top: 0.3em; font-family: var(--body); }
.title-page .spot { flex: 1 1 auto; min-height: 0; margin: 0.15in 0.4in; border-radius: 0.14in; overflow: hidden; }
.title-page.no-spot .tp-title { flex: 1 1 auto; font-size: 40pt; }
.title-page .tp-by { flex: none; font-size: 13pt; padding-bottom: 0.1in; }
.title-page .ill { font-size: 0.85em; opacity: 0.8; margin-top: 0.05in; }
.copyright { justify-content: flex-end; }
.copyright .cr-text { font-size: 8.5pt; line-height: 1.5; opacity: 0.85; padding-bottom: 0.2in; }
.dedication .ded { flex: 1; display: flex; font-style: italic; font-size: 1.15em; }
.dedication .ded .inner { margin: auto 0; width: 100%; }
.m-title { font-family: var(--title); font-weight: var(--tw); color: var(--accent); font-size: 22pt; line-height: 1.1; margin: 0.15in 0 0.2in; flex: none; }
.about .photo { flex: none; width: 1.7in; height: 1.7in; margin: 0 auto 0.2in; border-radius: 50%; overflow: hidden; border: 0.05in solid var(--accent); }
.m-text { flex: 1 1 auto; min-height: 0; display: flex; font-size: 0.82em; text-align: var(--align); }
.m-text .inner { margin: 0 0 auto; width: 100%; }
.m-text.small { flex: none; font-size: 0.75em; }
.contents .toc { flex: 1; min-height: 0; text-align: left; }
.toc-row { display: flex; align-items: baseline; gap: 0.08in; margin-bottom: 0.4em; }
.toc-t { flex: none; max-width: 80%; }
.toc-row .dots { flex: 1; border-bottom: 1.5px dotted currentColor; opacity: 0.4; transform: translateY(-0.25em); }
.toc-n { flex: none; font-weight: 700; }
.the-end { justify-content: center; }
.the-end .spot { flex: 0 1 45%; min-height: 0; margin: 0 0.5in 0.25in; border-radius: 50%; overflow: hidden; aspect-ratio: 1; align-self: center; }
.the-end .end { font-family: var(--title); font-weight: var(--tw); color: var(--accent); font-size: 40pt; line-height: 1.1; }
.filler-note { margin: auto; font: 9pt sans-serif; color: #b9b1a3; }

/* ------------- screen preview chrome ------------- */
@media screen {
  body { zoom: ${zoom}; padding: 24px; }
  .spread { display: flex; justify-content: center; margin: 0 auto 28px; width: max-content; }
  .spread figure { margin: 0; display: flex; flex-direction: column; align-items: center; }
  .spread figure.ghost { width: var(--pw); }
  .spread figure .page { box-shadow: 0 2px 14px rgba(0,0,0,.25); }
  .spread figure:first-child .page { box-shadow: -2px 2px 14px rgba(0,0,0,.25), inset -10px 0 14px -10px rgba(0,0,0,.25); }
  .spread figure:last-child .page { box-shadow: 2px 2px 14px rgba(0,0,0,.25), inset 10px 0 14px -10px rgba(0,0,0,.2); }
  figcaption { font: 13px/1.2 sans-serif; color: #6b6458; margin-top: 8px; text-transform: capitalize; }
  ${interactive ? '.page { cursor: pointer; } .page:hover { outline: 3px solid rgba(224,102,61,.45); }' : ''}
  .page.selected { outline: 4px solid #e0663d; outline-offset: 2px; }
  .sheet { margin: 0 auto 36px; width: max-content; }
  .sheet-label { font: 14px/1.2 sans-serif; color: #5b554b; margin-bottom: 8px; }
  .sheet-inner { box-shadow: 0 3px 18px rgba(0,0,0,.3); }
}
@media print {
  html, body { background: #fff; }
  .screen-only, figcaption { display: none !important; }
  .noimg { background: none; color: transparent; }
  .filler-note { display: none; }
  .page.selected { outline: none; }
}
.sheet { break-after: page; page-break-after: always; }
.sheet:last-child { break-after: auto; page-break-after: auto; }
.sheet-inner { width: ${sheetW}; height: ${sheetH}; display: flex; position: relative; overflow: hidden; background: #fff; }
.sheet.flip .sheet-inner { transform: rotate(180deg); }
.fold { position: absolute; left: 50%; width: 0; height: 0.28in; border-left: 1px dashed #999; }
.fold.top { top: 0; } .fold.bottom { bottom: 0; }
.tiny-label { position: absolute; top: 0.05in; left: 50%; transform: translateX(-50%); font: 6pt sans-serif; color: #aaa; background: #fff; padding: 0 3px; }
`;

  const script = `
(function(){
  var AUTOFIT = ${d.autoFit ? 'true' : 'false'};
  function fit(){
    var over = [], shrunk = [];
    document.querySelectorAll('[data-fit]').forEach(function(box){
      var inner = box.firstElementChild; if (!inner) return;
      box.style.fontSize = '';
      var size = parseFloat(getComputedStyle(box).fontSize);
      var min = size * parseFloat(box.getAttribute('data-fit') || '0.6');
      var n = 0;
      function overflows(){ return inner.scrollHeight > box.clientHeight + 1 || inner.scrollWidth > inner.clientWidth + 1; }
      while (AUTOFIT && overflows() && size > min && n < 200) { size -= 0.5; box.style.fontSize = size + 'px'; n++; }
      var pg = box.closest('[data-n]'); pg = pg ? Number(pg.getAttribute('data-n')) : null;
      if (overflows()) { if (over.indexOf(pg) < 0) over.push(pg); }
      else if (n && shrunk.indexOf(pg) < 0) shrunk.push(pg);
    });
    try { parent.postMessage({ source: 'kidsbook', type: 'fit', over: over, shrunk: shrunk }, '*'); } catch (e) {}
    document.documentElement.setAttribute('data-ready', '1');
  }
  function go(){ (document.fonts ? document.fonts.ready : Promise.resolve()).then(function(){ setTimeout(fit, 30); }); }
  if (document.readyState === 'complete') go(); else window.addEventListener('load', go);
  if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', go);
  ${interactive ? `document.addEventListener('click', function(e){ var p = e.target.closest('[data-n]'); if (p) parent.postMessage({ source: 'kidsbook', type: 'select', n: Number(p.getAttribute('data-n')) }, '*'); });` : ''}
  window.addEventListener('message', function(e){ if (e.data && e.data.source === 'kidsbook-parent' && e.data.type === 'scrollTo') { var el = document.querySelector('[data-n="' + e.data.n + '"]'); if (el) el.scrollIntoView({ block: 'center' }); } });
})();`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${fonts.map(f => `<link rel="stylesheet" href="${fontCssUrl(f)}">`).join('\n')}
<style>${css}</style></head>
<body class="mode-${mode}">
${body}
<script>${script}</script>
</body></html>`;
}

export function printInstructions(book) {
  const sheets = book.pageCount / 4;
  const flip = book.print.flip === 'long' ? 'long' : 'short';
  return [
    `You need ${sheets} sheet${sheets > 1 ? 's' : ''} of ${book.paper === 'a4' ? 'A4' : '8.5 × 11'} paper.`,
    `Printer settings: Landscape · Scale 100% / Actual size · Margins None · Background graphics ON · Two-sided, flip on ${flip} edge.`,
    'No duplex printer? Print "Fronts only", put the stack back in the tray (printed side as your printer needs, usually face-down for a top-feed), then print "Backs only". Tick "reverse backs" if your printer outputs face-up.',
    'Keep the sheets in order (sheet 1 on the outside), fold the stack in half, and staple twice along the fold.',
  ];
}
