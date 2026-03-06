import React, { useState, useMemo } from 'react';

export default function PublishTab({ project, outline, chapters }) {
  const [fontFamily, setFontFamily] = useState('Georgia');
  const [fontSize, setFontSize] = useState(12);
  const [pageNumbers, setPageNumbers] = useState(true);
  const [includeTitle, setIncludeTitle] = useState(true);
  const [chapterBreaks, setChapterBreaks] = useState(true);
  const [lineSpacing, setLineSpacing] = useState(1.5);
  const [marginMm, setMarginMm] = useState(25);

  const fm = project.frontBackMatter || {};

  const fullText = useMemo(() => {
    let text = '';
    if (includeTitle) {
      text += `${project.title}\n\n`;
    }
    // Copyright notice (front)
    if (fm.copyrightNotice && project.copyrightText) {
      text += `${project.copyrightText}\n\n`;
    }
    // Table of contents (front)
    if (fm.tableOfContents) {
      text += `TABLE OF CONTENTS\n\n`;
      outline.forEach((ch, i) => {
        if (chapters[i]) text += `  Chapter ${i + 1}: ${ch.title}\n`;
      });
      text += '\n';
    }
    // Chapters
    for (let i = 0; i < outline.length; i++) {
      if (chapters[i]) {
        text += `\nChapter ${i + 1}: ${outline[i].title}\n\n`;
        text += chapters[i].text + '\n';
      }
    }
    // Acknowledgements (back)
    if (fm.acknowledgements && project.acknowledgementsText) {
      text += `\n\nACKNOWLEDGEMENTS\n\n${project.acknowledgementsText}\n`;
    }
    // Bibliography (back)
    if (fm.bibliography && project.bibliographyText) {
      text += `\n\nBIBLIOGRAPHY\n\n${project.bibliographyText}\n`;
    }
    // Index (back)
    if (fm.index && project.indexText) {
      text += `\n\nINDEX\n\n${project.indexText}\n`;
    }
    return text.trim();
  }, [outline, chapters, project, includeTitle, fm]);

  const totalWords = useMemo(() => fullText.split(/\s+/).filter(Boolean).length, [fullText]);

  const exportPlainText = () => {
    const blob = new Blob([fullText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project.title || 'novel'}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportPDF = async () => {
    const { default: jsPDF } = await import('jspdf');
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const pageWidth = 210;
    const pageHeight = 297;
    const margin = marginMm;
    const textWidth = pageWidth - margin * 2;
    const ptToMm = 0.3528;
    const baseLineHeight = fontSize * ptToMm * lineSpacing;
    let y = margin;
    let pageNum = 1;

    // Determine base font name for jsPDF
    let baseFontName = 'helvetica';
    if (fontFamily === 'Georgia' || fontFamily === 'Times New Roman') baseFontName = 'times';
    else if (fontFamily === 'Courier New') baseFontName = 'courier';

    const setFont = (style = 'normal', size = fontSize) => {
      doc.setFont(baseFontName, style);
      doc.setFontSize(size);
    };

    const addPageNum = () => {
      if (pageNumbers) {
        doc.setFontSize(9);
        doc.setTextColor(120);
        doc.text(String(pageNum), pageWidth / 2, pageHeight - 10, { align: 'center' });
        doc.setTextColor(0);
        setFont('normal');
      }
    };

    const checkPage = (needed = baseLineHeight) => {
      if (y + needed > pageHeight - margin) {
        addPageNum();
        doc.addPage();
        pageNum++;
        y = margin;
        return true;
      }
      return false;
    };

    // Renders a line of text with inline **bold** and *italic* markdown
    const renderInlineLine = (text, x, currentY) => {
      // Split the line into segments: bold, italic, or normal
      const segments = [];
      let remaining = text;

      while (remaining.length > 0) {
        // Match ***bold italic*** or ___bold italic___
        let match = remaining.match(/^(.*?)\*\*\*(.*?)\*\*\*/s);
        if (!match) match = remaining.match(/^(.*?)___(.*?)___/s);
        if (match) {
          if (match[1]) segments.push({ text: match[1], style: 'normal' });
          segments.push({ text: match[2], style: 'bolditalic' });
          remaining = remaining.slice(match[0].length);
          continue;
        }

        // Match **bold** or __bold__
        match = remaining.match(/^(.*?)\*\*(.*?)\*\*/s);
        if (!match) match = remaining.match(/^(.*?)__(.*?)__/s);
        if (match) {
          if (match[1]) segments.push({ text: match[1], style: 'normal' });
          segments.push({ text: match[2], style: 'bold' });
          remaining = remaining.slice(match[0].length);
          continue;
        }

        // Match *italic* or _italic_ (but not inside words for _)
        match = remaining.match(/^(.*?)\*(.*?)\*/s);
        if (!match) match = remaining.match(/^(.*?)(?<!\w)_(.*?)_(?!\w)/s);
        if (match) {
          if (match[1]) segments.push({ text: match[1], style: 'normal' });
          segments.push({ text: match[2], style: 'italic' });
          remaining = remaining.slice(match[0].length);
          continue;
        }

        // No more markdown, push rest as normal
        segments.push({ text: remaining, style: 'normal' });
        break;
      }

      // Now render each segment advancing x
      let cx = x;
      for (const seg of segments) {
        if (!seg.text) continue;
        setFont(seg.style);
        doc.text(seg.text, cx, currentY);
        cx += doc.getTextWidth(seg.text);
      }
      setFont('normal');
    };

    // Renders a full paragraph handling markdown and word-wrapping with inline styles
    const renderMarkdownParagraph = (text) => {
      // Strip inline markdown for measuring, but keep it for rendering
      const stripMd = (s) => s.replace(/\*\*\*(.*?)\*\*\*/g, '$1').replace(/___(.*?)___/g, '$1').replace(/\*\*(.*?)\*\*/g, '$1').replace(/__(.*?)__/g, '$1').replace(/\*(.*?)\*/g, '$1').replace(/(?<!\w)_(.*?)_(?!\w)/g, '$1');

      // Word-wrap using stripped text for width calculation, but keep original for rendering
      const stripped = stripMd(text);
      setFont('normal');
      const wrappedLines = doc.splitTextToSize(stripped, textWidth);

      // Now we need to map wrapped lines back to original markdown text
      // Strategy: consume characters from original text as we go through wrapped lines
      let origRemaining = text;
      for (const wrappedLine of wrappedLines) {
        checkPage();
        // Find how many stripped characters this line covers
        const strippedLen = wrappedLine.length;
        // Consume that many non-markdown characters from origRemaining
        let consumed = 0;
        let origIdx = 0;
        while (consumed < strippedLen && origIdx < origRemaining.length) {
          // Skip markdown syntax characters
          if (origRemaining.slice(origIdx).match(/^\*\*\*/) || origRemaining.slice(origIdx).match(/^___/)) {
            // Find closing
            const marker = origRemaining.slice(origIdx, origIdx + 3);
            const closeIdx = origRemaining.indexOf(marker, origIdx + 3);
            if (closeIdx > origIdx) {
              // Count inner text characters
              const inner = origRemaining.slice(origIdx + 3, closeIdx);
              if (consumed + inner.length <= strippedLen) {
                consumed += inner.length;
                origIdx = closeIdx + 3;
              } else {
                // Partial consume - take what we can
                const take = strippedLen - consumed;
                consumed += take;
                // Don't advance past the marker
                origIdx = origIdx + 3 + take;
              }
              continue;
            }
          }
          if (origRemaining.slice(origIdx).match(/^\*\*/) || origRemaining.slice(origIdx).match(/^__/)) {
            const marker = origRemaining.slice(origIdx, origIdx + 2);
            const closeIdx = origRemaining.indexOf(marker, origIdx + 2);
            if (closeIdx > origIdx) {
              const inner = origRemaining.slice(origIdx + 2, closeIdx);
              if (consumed + inner.length <= strippedLen) {
                consumed += inner.length;
                origIdx = closeIdx + 2;
              } else {
                const take = strippedLen - consumed;
                consumed += take;
                origIdx = origIdx + 2 + take;
              }
              continue;
            }
          }
          if (origRemaining[origIdx] === '*' || origRemaining[origIdx] === '_') {
            const marker = origRemaining[origIdx];
            const closeIdx = origRemaining.indexOf(marker, origIdx + 1);
            if (closeIdx > origIdx) {
              const inner = origRemaining.slice(origIdx + 1, closeIdx);
              if (consumed + inner.length <= strippedLen) {
                consumed += inner.length;
                origIdx = closeIdx + 1;
              } else {
                const take = strippedLen - consumed;
                consumed += take;
                origIdx = origIdx + 1 + take;
              }
              continue;
            }
          }
          consumed++;
          origIdx++;
        }

        const lineOriginal = origRemaining.slice(0, origIdx);
        origRemaining = origRemaining.slice(origIdx).replace(/^\s+/, '');
        renderInlineLine(lineOriginal, margin, y);
        y += baseLineHeight;
      }
    };

    setFont('normal');

    // Title page
    if (includeTitle && project.title) {
      setFont('bold', fontSize * 2.2);
      const titleY = pageHeight / 3;
      doc.text(project.title, pageWidth / 2, titleY, { align: 'center' });

      if (project.copyrightText && (project.frontBackMatter || {}).copyrightNotice) {
        setFont('normal', fontSize * 0.8);
        doc.setTextColor(100);
        const lines = doc.splitTextToSize(project.copyrightText, textWidth * 0.6);
        let cy = pageHeight - margin - (lines.length * fontSize * 0.8 * ptToMm * 1.3);
        for (const line of lines) {
          doc.text(line, pageWidth / 2, cy, { align: 'center' });
          cy += fontSize * 0.8 * ptToMm * 1.3;
        }
        doc.setTextColor(0);
      }

      setFont('normal');
      addPageNum();
      doc.addPage();
      pageNum++;
      y = margin;
    }

    // Table of Contents
    if (fm.tableOfContents) {
      setFont('bold', fontSize * 1.5);
      doc.text('Table of Contents', margin, y);
      y += baseLineHeight * 2;
      setFont('normal');

      for (let ti = 0; ti < outline.length; ti++) {
        if (chapters[ti]) {
          checkPage();
          doc.text(`Chapter ${ti + 1}: ${outline[ti].title}`, margin + 8, y);
          y += baseLineHeight;
        }
      }
      if (fm.acknowledgements && project.acknowledgementsText) {
        checkPage(); doc.text('Acknowledgements', margin + 8, y); y += baseLineHeight;
      }
      if (fm.bibliography && project.bibliographyText) {
        checkPage(); doc.text('Bibliography', margin + 8, y); y += baseLineHeight;
      }
      if (fm.index && project.indexText) {
        checkPage(); doc.text('Index', margin + 8, y); y += baseLineHeight;
      }

      addPageNum();
      doc.addPage();
      pageNum++;
      y = margin;
    }

    // Chapters
    for (let i = 0; i < outline.length; i++) {
      if (!chapters[i]) continue;

      if (chapterBreaks && i > 0) {
        addPageNum();
        doc.addPage();
        pageNum++;
        y = margin;
      }

      // Chapter heading
      setFont('bold', fontSize * 1.5);
      checkPage(baseLineHeight * 3);
      doc.text(`Chapter ${i + 1}`, margin, y);
      y += fontSize * 1.5 * ptToMm * 1.2;
      setFont('italic', fontSize * 1.2);
      const titleLines = doc.splitTextToSize(outline[i].title, textWidth);
      for (const tl of titleLines) {
        checkPage();
        doc.text(tl, margin, y);
        y += fontSize * 1.2 * ptToMm * 1.3;
      }
      y += baseLineHeight * 0.8;
      setFont('normal');

      // Chapter body — parse markdown per line
      const rawLines = chapters[i].text.split('\n');
      for (const line of rawLines) {
        const trimmed = line.trim();

        // Empty line = paragraph break
        if (!trimmed) {
          y += baseLineHeight * 0.5;
          checkPage();
          continue;
        }

        // Markdown headings
        const h1Match = trimmed.match(/^#\s+(.+)$/);
        const h2Match = trimmed.match(/^##\s+(.+)$/);
        const h3Match = trimmed.match(/^###\s+(.+)$/);

        if (h3Match) {
          y += baseLineHeight * 0.4;
          checkPage(baseLineHeight * 2);
          setFont('bold', fontSize * 1.1);
          doc.text(h3Match[1], margin, y);
          y += fontSize * 1.1 * ptToMm * lineSpacing + baseLineHeight * 0.3;
          setFont('normal');
          continue;
        }
        if (h2Match) {
          y += baseLineHeight * 0.5;
          checkPage(baseLineHeight * 2);
          setFont('bold', fontSize * 1.25);
          doc.text(h2Match[1], margin, y);
          y += fontSize * 1.25 * ptToMm * lineSpacing + baseLineHeight * 0.4;
          setFont('normal');
          continue;
        }
        if (h1Match) {
          y += baseLineHeight * 0.6;
          checkPage(baseLineHeight * 2.5);
          setFont('bold', fontSize * 1.5);
          doc.text(h1Match[1], margin, y);
          y += fontSize * 1.5 * ptToMm * lineSpacing + baseLineHeight * 0.5;
          setFont('normal');
          continue;
        }

        // Horizontal rule
        if (trimmed.match(/^(-{3,}|\*{3,}|_{3,})$/)) {
          y += baseLineHeight * 0.3;
          checkPage();
          doc.setDrawColor(180);
          doc.setLineWidth(0.3);
          doc.line(margin + textWidth * 0.2, y, margin + textWidth * 0.8, y);
          doc.setDrawColor(0);
          y += baseLineHeight * 0.6;
          continue;
        }

        // Regular paragraph with inline markdown
        renderMarkdownParagraph(trimmed);
        y += baseLineHeight * 0.3;
      }
    }

    // Helper to render a back matter section
    const renderBackMatterSection = (title, text) => {
      if (!text) return;
      addPageNum();
      doc.addPage();
      pageNum++;
      y = margin;

      setFont('bold', fontSize * 1.5);
      doc.text(title, margin, y);
      y += baseLineHeight * 2;
      setFont('normal');

      const paras = text.split('\n');
      for (const para of paras) {
        if (!para.trim()) { y += baseLineHeight * 0.5; checkPage(); continue; }
        const wLines = doc.splitTextToSize(para.trim(), textWidth);
        for (const wl of wLines) { checkPage(); doc.text(wl, margin, y); y += baseLineHeight; }
        y += baseLineHeight * 0.3;
      }
    };

    if (fm.acknowledgements && project.acknowledgementsText) renderBackMatterSection('Acknowledgements', project.acknowledgementsText);
    if (fm.bibliography && project.bibliographyText) renderBackMatterSection('Bibliography', project.bibliographyText);
    if (fm.index && project.indexText) renderBackMatterSection('Index', project.indexText);

    addPageNum();
    doc.save(`${project.title || 'novel'}.pdf`);
  };

  const writtenCount = Object.keys(chapters).length;

  return (
    <div>
      <div className="mb-md">
        <span className="text-muted">{writtenCount} of {outline.length} chapters written · {totalWords.toLocaleString()} words</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        {/* Plain Text */}
        <div className="publish-option">
          <h3 style={{ fontFamily: 'var(--font-display)', marginBottom: 14, color: 'var(--accent)' }}>Plain Text</h3>
          <p className="text-muted mb-md">Export as a .txt file with chapter headings.</p>
          <button className="btn btn-accent" onClick={exportPlainText} disabled={writtenCount === 0}>
            Export .txt
          </button>
        </div>

        {/* PDF */}
        <div className="publish-option">
          <h3 style={{ fontFamily: 'var(--font-display)', marginBottom: 14, color: 'var(--accent)' }}>PDF</h3>

          <div className="mb-sm">
            <label>Font</label>
            <select value={fontFamily} onChange={e => setFontFamily(e.target.value)}>
              <option value="Georgia">Georgia / Times</option>
              <option value="Times New Roman">Times New Roman</option>
              <option value="Helvetica">Helvetica / Sans</option>
              <option value="Courier New">Courier / Mono</option>
            </select>
          </div>

          <div className="mb-sm">
            <label>Font Size (pt)</label>
            <input type="number" value={fontSize} onChange={e => setFontSize(Number(e.target.value))} min={8} max={24} />
          </div>

          <div className="mb-sm">
            <label>Line Spacing</label>
            <select value={lineSpacing} onChange={e => setLineSpacing(Number(e.target.value))}>
              <option value={1}>Single</option>
              <option value={1.25}>1.25</option>
              <option value={1.5}>1.5</option>
              <option value={2}>Double</option>
            </select>
          </div>

          <div className="mb-sm">
            <label>Margins (mm)</label>
            <input type="number" value={marginMm} onChange={e => setMarginMm(Number(e.target.value))} min={10} max={50} />
          </div>

          <div className="mb-sm flex-row">
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={pageNumbers} onChange={e => setPageNumbers(e.target.checked)} />
              Page Numbers
            </label>
          </div>

          <div className="mb-sm flex-row">
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={includeTitle} onChange={e => setIncludeTitle(e.target.checked)} />
              Title Page
            </label>
          </div>

          <div className="mb-md flex-row">
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={chapterBreaks} onChange={e => setChapterBreaks(e.target.checked)} />
              Chapter Page Breaks
            </label>
          </div>

          <button className="btn btn-accent" onClick={exportPDF} disabled={writtenCount === 0}>
            Export PDF
          </button>
        </div>
      </div>
    </div>
  );
}
