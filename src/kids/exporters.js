// Browser exporters: all pictures as a .zip, and the book as an in-order PDF.
import { computePlan, safeName, MATTER_TYPES } from './model.js';
import { renderBookHTML } from './layout.js';
import { fontCssUrl } from './fonts.js';
import { PAPER } from './model.js';

// ---------------------------------------------------------------- zip (store, no compression)
// Images are already compressed, so storing them is as small as zipping and needs no library.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// files: [{ name, bytes: Uint8Array }]
export function makeZip(files) {
  const enc = new TextEncoder();
  const { time, date } = dosTime(new Date());
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.bytes);
    const size = f.bytes.length;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), name, f.bytes);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true);
    cen.setUint16(12, time, true);
    cen.setUint16(14, date, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, size, true);
    cen.setUint32(24, size, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + size;
  }
  const cenSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cenSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' };
const slug = s => (s || '').toString().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'untitled';
const pad = n => String(n).padStart(2, '0');

// Every picture in the book, with readable names. includeHistory adds older versions.
export async function exportPicturesZip(book, store, { includeHistory = false, onProgress } = {}) {
  const plan = computePlan(book);
  const wanted = []; // [{ id, path }]
  const seen = new Set();
  const add = (id, path) => { if (id && !seen.has(id)) { seen.add(id); wanted.push({ id, path }); } };

  add(book.cover.imageId, 'cover');
  if (book.backCover.imageId) add(book.backCover.imageId, 'back-cover');
  plan.pages.forEach(p => {
    if (p.kind === 'story' && p.part !== 'words') add(p.page.imageId, `pages/p${pad(p.n)}-story-${pad(p.storyIndex + 1)}`);
    if ((p.kind === 'front' || p.kind === 'back') && p.matter.imageId) add(p.matter.imageId, `pages/p${pad(p.n)}-${slug(MATTER_TYPES[p.matter.type] || p.matter.type)}`);
  });
  // Story pages that don't fit in the booklet still have pictures worth keeping.
  book.chapters.forEach(ch => ch.pages.forEach((pg, i) => add(pg.imageId, `pages/unprinted-${slug(ch.title || 'story')}-${pad(i + 1)}`)));
  book.cast.forEach(c => {
    const name = slug(c.name || c.kind);
    const sheets = [c.activeSheet, ...c.sheets.filter(s => s !== c.activeSheet)].filter(Boolean);
    sheets.forEach((id, i) => (i === 0 || includeHistory) && add(id, `sheets/${name}${i ? `-${i + 1}` : ''}`));
    c.refs.forEach((id, i) => add(id, `references/${name}-ref-${i + 1}`));
  });
  (book.styleRefs || []).forEach((id, i) => add(id, `references/style-${i + 1}`));
  if (includeHistory) {
    (book.cover.altImages || []).forEach((id, i) => add(id, `history/cover-v${i + 1}`));
    plan.pages.forEach(p => {
      if (p.kind === 'story' && p.part !== 'words') (p.page.altImages || []).forEach((id, i) => add(id, `history/p${pad(p.n)}-v${i + 1}`));
    });
  }

  const files = [];
  const used = new Set();
  for (let i = 0; i < wanted.length; i++) {
    const { id, path } = wanted[i];
    try {
      const blob = await store.getBlob(id);
      if (blob) {
        const ext = EXT[blob.type] || 'png';
        let name = `${path}.${ext}`;
        for (let k = 2; used.has(name); k++) name = `${path}-${k}.${ext}`;
        used.add(name);
        files.push({ name, bytes: new Uint8Array(await blob.arrayBuffer()) });
      }
    } catch (e) { /* missing image */ }
    onProgress?.(i + 1, wanted.length);
  }
  if (!files.length) throw new Error('This book has no pictures yet.');
  return { blob: makeZip(files), count: files.length, name: `${safeName(book.title)}-pictures.zip` };
}

// ---------------------------------------------------------------- PDF (pages in reading order)
const sleep = ms => new Promise(r => setTimeout(r, ms));

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// Inline the Google Fonts the book uses (latin subsets) so they render inside an SVG image.
async function embeddedFontCss(fontNames) {
  let out = '';
  for (const name of [...new Set(fontNames)]) {
    try {
      const css = await (await fetch(fontCssUrl(name))).text();
      const blocks = css.split(/(?=\/\*\s*[\w-]+\s*\*\/)/);
      const keep = blocks.filter(b => /\/\*\s*(latin|latin-ext)\s*\*\//.test(b));
      for (const block of (keep.length ? keep : blocks)) {
        let b = block;
        for (const m of block.matchAll(/url\((https:[^)]+)\)/g)) {
          const data = await blobToDataUrl(await (await fetch(m[1])).blob());
          b = b.replace(m[1], data);
        }
        out += b;
      }
    } catch (e) { /* fall back to system font for this family */ }
  }
  return out;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('Could not render a page (an image may be unreadable).'));
    im.src = src;
  });
}

async function imageDataUrls(book, store) {
  const { allImageIds } = await import('./model.js');
  const urls = {};
  for (const id of allImageIds(book)) {
    try {
      const b = await store.base64(id);
      urls[id] = `data:${b.mimeType};base64,${b.data}`;
    } catch (e) { /* missing */ }
  }
  return urls;
}

// Renders every page exactly as the browser lays it out (same HTML/CSS as the preview and print),
// draws each one to a canvas through an SVG <foreignObject>, and assembles a PDF with jsPDF.
export async function exportPdf(book, store, { dpi = 300, quality = 0.9, onProgress, onPageImage } = {}) {
  const paper = PAPER[book.paper] || PAPER.letter;
  onProgress?.('Collecting pictures…');
  const urls = await imageDataUrls(book, store);
  const html = renderBookHTML(book, { mode: 'pages', imageUrl: id => urls[id] });

  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;left:-20000px;top:0;width:900px;height:1200px;border:0;';
  document.body.appendChild(frame);
  try {
    const loaded = new Promise(res => { frame.onload = res; });
    frame.srcdoc = html;
    await loaded;
    onProgress?.('Laying out pages…');
    for (let i = 0; i < 200 && !frame.contentDocument.documentElement.getAttribute('data-ready'); i++) await sleep(100);
    const doc = frame.contentDocument;
    const css = [...doc.querySelectorAll('style')].map(s => s.textContent).join('\n')
      .replace(/:root\s*\{/g, '.kb-root {')
      .replace(/@media screen\s*\{[\s\S]*?\n\}\n/g, '');
    onProgress?.('Embedding fonts…');
    const fontCss = await embeddedFontCss([book.design.titleFont, book.design.bodyFont]);

    const { default: JsPDF } = await import('jspdf');
    const pdf = new JsPDF({ unit: paper.unit, format: [paper.pageW, paper.pageH], orientation: 'portrait', compress: true });
    const pages = [...doc.querySelectorAll('.page')];
    const ser = new XMLSerializer();
    for (let i = 0; i < pages.length; i++) {
      onProgress?.(`Rendering page ${i + 1} of ${pages.length}…`);
      const el = pages[i];
      const rect = el.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
        + `<foreignObject x="0" y="0" width="${w}" height="${h}">`
        + `<div xmlns="http://www.w3.org/1999/xhtml" class="kb-root" style="width:${w}px;height:${h}px;">`
        + `<style><![CDATA[${fontCss}\n${css}]]></style>${ser.serializeToString(el)}</div>`
        + '</foreignObject></svg>';
      const im = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      const scale = dpi / 96;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(im, 0, 0, canvas.width, canvas.height);
      const jpg = canvas.toDataURL('image/jpeg', quality);
      onPageImage?.(jpg, i);
      if (i > 0) pdf.addPage([paper.pageW, paper.pageH], 'portrait');
      pdf.addImage(jpg, 'JPEG', 0, 0, paper.pageW, paper.pageH, undefined, 'FAST');
      await sleep(0);
    }
    onProgress?.('Saving…');
    return { blob: pdf.output('blob'), name: `${safeName(book.title)}.pdf`, pages: pages.length };
  } finally {
    frame.remove();
  }
}

// Print the pages one after another (5.5 × 8.5 each) — "Save as PDF" here gives a sharp vector PDF.
export async function printPagesInOrder(book, store) {
  const urls = {};
  const { allImageIds } = await import('./model.js');
  for (const id of allImageIds(book)) { try { urls[id] = await store.url(id); } catch (e) { /* missing */ } }
  const html = renderBookHTML(book, { mode: 'pages', imageUrl: id => urls[id] });
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;left:-20000px;top:0;width:900px;height:1200px;border:0;';
  document.body.appendChild(f);
  const loaded = new Promise(res => { f.onload = res; });
  f.srcdoc = html;
  await loaded;
  for (let i = 0; i < 150 && !f.contentDocument.documentElement.getAttribute('data-ready'); i++) await sleep(100);
  await Promise.all([...f.contentDocument.images].map(im => (im.complete ? null : new Promise(r => { im.onload = r; im.onerror = r; }))));
  await sleep(150);
  f.contentWindow.focus();
  f.contentWindow.print();
  setTimeout(() => f.remove(), 2000);
}
