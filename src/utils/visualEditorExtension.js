/**
 * @fileoverview Overleaf-Style "Visual Editor" (WYSIWYM) Mode for CodeMirror 6.
 *
 * Provides a rich, true WYSIWYG-style visual editing layout with two-way data binding:
 * 1. Preamble & Document Header: Collapsible preamble badge + two-way bound H1 Title & Author header.
 * 2. Abstract Environment: Replaces tags with visual subtitle + indented card container.
 * 3. Interactive Figure Cards: Real image previews from Drive/MEMFS, editable caption input, </> Code toggle.
 * 4. Bidirectional Table Widget: Interactive HTML table with cell-level two-way binding, Tab navigation,
 *    and +Row / +Col actions.
 * 5. Bibliography & References: Visual header, citation badges with inline editable prose, and linked .bib card.
 * 6. Live KaTeX Math, Headings, Text Formatting, Citations, and List Items.
 * 7. Real-time Yjs CRDT collaboration is strictly preserved.
 */

import { Facet, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { scanReviewItems } from './reviewMacroUtils';

/**
 * Facet providing access to the active project's auxiliary files map (`collabSession.auxFilesMap`).
 */
export const auxFilesFacet = Facet.define({
  combine: (values) => values[0] || null,
});

/**
 * Global cache for created Object URLs (Blob URLs) to prevent memory leaks and redundant allocations.
 * Key: `${filePath}:${updatedAtOrSize}` -> Value: `blob:http://...`
 */
const blobUrlCache = new Map();

/**
 * Strips raw LaTeX delimiters and formatting commands to display clean, readable visual text.
 *
 * @param {string} latexStr
 * @returns {string}
 */
export function stripFormatting(latexStr) {
  if (!latexStr || typeof latexStr !== 'string') return '';
  return latexStr
    .replace(/\\(textbf|textit|emph|underline|text|mathrm)\{([^{}]*)\}/g, '$2')
    .replace(/\\(textbf|textit|emph|underline|text|mathrm)\{([^{}]*)\}/g, '$2')
    .replace(/\\(Large|large|huge|Huge|small|normalsize|bfseries|itshape)\b/g, '')
    .replace(/\\\\/g, ' ')
    .replace(/\\and\b/g, ', ')
    .replace(/\\thanks\{[^{}]*\}/g, '')
    .replace(/~/g, ' ')
    .replace(/\\([&%$#_{}])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Robust scanner to find balanced curly-brace LaTeX commands like `\title{...}`, `\author{...}`, etc.
 *
 * @param {string} text Full document text.
 * @param {string} cmdName Command name without backslash (e.g. 'title', 'author', 'caption').
 * @param {number} from Start searching index.
 * @param {number} maxTo Maximum search bound.
 * @returns {{ fullFrom: number, fullTo: number, innerFrom: number, innerTo: number, innerText: string, optArg: string | null } | null}
 */
export function findBalancedCommand(text, cmdName, from = 0, maxTo = text.length) {
  const needle = '\\' + cmdName;
  const idx = text.indexOf(needle, from);
  if (idx === -1 || idx >= maxTo) return null;

  let pos = idx + needle.length;
  let optArg = null;

  // Optional bracket arguments, e.g. \bibitem[opt]{key} or \caption[short]{long}
  if (pos < maxTo && text[pos] === '[') {
    const closeBracket = text.indexOf(']', pos);
    if (closeBracket !== -1 && closeBracket < maxTo) {
      optArg = text.slice(pos + 1, closeBracket);
      pos = closeBracket + 1;
    }
  }

  // Skip whitespace between command and opening brace
  while (pos < maxTo && (text[pos] === ' ' || text[pos] === '\t' || text[pos] === '\n' || text[pos] === '\r')) {
    pos++;
  }

  if (pos >= maxTo || text[pos] !== '{') return null;

  const innerFrom = pos + 1;
  let depth = 1;
  let cur = innerFrom;

  while (cur < maxTo && depth > 0) {
    if (text[cur] === '\\') {
      cur += 2;
      continue;
    }
    if (text[cur] === '{') depth++;
    else if (text[cur] === '}') depth--;
    cur++;
  }

  if (depth !== 0) return null;

  const innerTo = cur - 1;
  const fullTo = cur;

  return {
    fullFrom: idx,
    fullTo,
    innerFrom,
    innerTo,
    innerText: text.slice(innerFrom, innerTo),
    optArg,
  };
}

/**
 * Retrieves a file entry from the auxiliary files map (supports Y.Map or standard Map/Object).
 */
function getAuxEntry(auxFiles, path) {
  if (!auxFiles || !path) return null;
  if (typeof auxFiles.get === 'function') {
    return auxFiles.get(path) || null;
  }
  return auxFiles[path] || null;
}

/**
 * Resolves an image path from `\includegraphics{...}` against project files in MEMFS/Drive.
 *
 * @param {string} imagePath Raw path from LaTeX.
 * @param {any} auxFiles The auxiliary files map from the facet.
 * @returns {{ src: string, name: string, isPdf: boolean } | null}
 */
export function resolveFigureImage(imagePath, auxFiles) {
  if (!imagePath || !auxFiles) return null;
  const clean = imagePath.replace(/^\.?\//, '').trim();
  if (!clean) return null;

  // 1. Direct path lookup
  let entry = getAuxEntry(auxFiles, clean);
  let resolvedKey = clean;

  // 2. Try common graphic file extensions
  if (!entry) {
    const exts = ['.png', '.jpg', '.jpeg', '.svg', '.pdf', '.webp'];
    for (const ext of exts) {
      entry = getAuxEntry(auxFiles, clean + ext);
      if (entry) {
        resolvedKey = clean + ext;
        break;
      }
    }
  }

  // 3. Basename fuzzy matching across all files in auxFiles
  if (!entry) {
    const targetBase = clean.split('/').pop().replace(/\.[^.]+$/, '').toLowerCase();
    const targetName = clean.split('/').pop().toLowerCase();
    const iterate = (fn) => {
      if (typeof auxFiles.forEach === 'function') {
        auxFiles.forEach(fn);
      } else {
        Object.entries(auxFiles).forEach(([k, v]) => fn(v, k));
      }
    };
    iterate((val, key) => {
      if (entry) return;
      const keyLower = key.toLowerCase();
      const keyBase = keyLower.split('/').pop().replace(/\.[^.]+$/, '');
      const keyName = keyLower.split('/').pop();
      if (
        keyLower === clean.toLowerCase() ||
        keyLower.endsWith('/' + clean.toLowerCase()) ||
        keyName === targetName ||
        keyBase === targetBase
      ) {
        entry = val;
        resolvedKey = key;
      }
    });
  }

  if (!entry || entry.content === undefined || entry.content === null) return null;

  const content = entry.content;
  const mimeType =
    entry.mimeType ||
    (resolvedKey.endsWith('.svg')
      ? 'image/svg+xml'
      : resolvedKey.endsWith('.pdf')
      ? 'application/pdf'
      : 'image/png');

  const cacheKey = `${resolvedKey}:${entry.updatedAt || entry.size || 0}`;
  if (blobUrlCache.has(cacheKey)) {
    return {
      src: blobUrlCache.get(cacheKey),
      name: entry.name || resolvedKey,
      isPdf: mimeType === 'application/pdf',
    };
  }

  // String data URLs or SVG markup
  if (typeof content === 'string') {
    if (content.startsWith('data:image/')) {
      return { src: content, name: entry.name || resolvedKey, isPdf: false };
    }
    if (content.trim().startsWith('<svg') || mimeType === 'image/svg+xml') {
      const blob = new Blob([content], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      blobUrlCache.set(cacheKey, url);
      return { src: url, name: entry.name || resolvedKey, isPdf: false };
    }
  }

  // Binary Uint8Array / ArrayBuffer
  let bytes = null;
  if (content instanceof Uint8Array) {
    bytes = content;
  } else if (content instanceof ArrayBuffer) {
    bytes = new Uint8Array(content);
  } else if (ArrayBuffer.isView(content)) {
    bytes = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  } else if (Array.isArray(content) || (typeof content === 'object' && content !== null)) {
    bytes = new Uint8Array(Object.values(content));
  }

  if (bytes && bytes.byteLength > 0) {
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    blobUrlCache.set(cacheKey, url);
    return {
      src: url,
      name: entry.name || resolvedKey,
      isPdf: mimeType === 'application/pdf',
    };
  }

  return null;
}

/**
 * Parses BibTeX text into an array of entries for display in bibliography cards.
 */
function parseBibtexEntries(bibText) {
  if (!bibText) return [];
  const entries = [];
  const regex = /@([a-zA-Z]+)\s*\{\s*([^,]+),([\s\S]*?)(?=\n@|\Z)/g;
  let m;
  while ((m = regex.exec(bibText)) !== null) {
    const type = m[1].toLowerCase();
    const key = m[2].trim();
    const body = m[3];
    const titleMatch = /title\s*=\s*[{"]([^}"]+)[}"]/i.exec(body);
    const authorMatch = /author\s*=\s*[{"]([^}"]+)[}"]/i.exec(body);
    const yearMatch = /year\s*=\s*[{"]?(\d{4})[}"]?/i.exec(body);
    entries.push({
      type,
      key,
      title: titleMatch ? titleMatch[1].replace(/[\n\r\t]+/g, ' ').trim() : '',
      author: authorMatch ? authorMatch[1].replace(/[\n\r\t]+/g, ' ').trim() : '',
      year: yearMatch ? yearMatch[1] : '',
    });
  }
  return entries;
}

/* ==========================================================================
   WIDGETS
   ========================================================================== */

/**
 * Widget that renders a collapsed LaTeX preamble banner (`\documentclass ... \begin{document}`).
 */
class PreambleBannerWidget extends WidgetType {
  constructor(targetPos, lineCount) {
    super();
    this.targetPos = targetPos;
    this.lineCount = lineCount;
  }

  eq(other) {
    return other.targetPos === this.targetPos && other.lineCount === this.lineCount;
  }

  toDOM(view) {
    const span = document.createElement('span');
    span.className = 'cm-visual-preamble-banner';
    span.title = 'Click to expand and edit the LaTeX preamble';
    span.innerHTML = `<span class="cm-preamble-icon">⚙️</span> Document Preamble (${this.lineCount} lines folded — Click to expand)`;
    span.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({
        selection: { anchor: this.targetPos },
        scrollIntoView: true,
      });
      view.focus();
    });
    return span;
  }

  ignoreEvent() {
    return false;
  }
}

/**
 * Two-way bound Document Header Widget rendering the manuscript H1 Title and Author subtitle.
 * Direct edits in the inputs dispatch CodeMirror transactions to `\title{...}` and `\author{...}`.
 */
class DocumentHeaderWidget extends WidgetType {
  constructor(titleInfo, authorInfo, dateInfo) {
    super();
    this.titleInfo = titleInfo;
    this.authorInfo = authorInfo;
    this.dateInfo = dateInfo;
  }

  eq(other) {
    return (
      other.titleInfo?.innerText === this.titleInfo?.innerText &&
      other.authorInfo?.innerText === this.authorInfo?.innerText &&
      other.dateInfo?.innerText === this.dateInfo?.innerText
    );
  }

  ignoreEvent() {
    return true; // Keep events inside input elements without CodeMirror stealing focus
  }

  toDOM(view) {
    const header = document.createElement('header');
    header.className = 'cm-visual-doc-header';

    // Title input
    const titleWrap = document.createElement('div');
    titleWrap.className = 'cm-visual-doc-title-wrap';

    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'cm-visual-doc-title-input';
    titleInput.placeholder = 'Click to edit manuscript title...';
    titleInput.value = stripFormatting(this.titleInfo?.innerText || '');

    titleInput.addEventListener('input', (e) => {
      e.stopPropagation();
      if (this.titleInfo) {
        view.dispatch({
          changes: {
            from: this.titleInfo.innerFrom,
            to: this.titleInfo.innerTo,
            insert: titleInput.value,
          },
        });
      }
    });
    titleWrap.appendChild(titleInput);
    header.appendChild(titleWrap);

    // Author input
    const authorWrap = document.createElement('div');
    authorWrap.className = 'cm-visual-doc-author-wrap';

    const authorInput = document.createElement('input');
    authorInput.type = 'text';
    authorInput.className = 'cm-visual-doc-author-input';
    authorInput.placeholder = 'Author name(s), affiliations...';
    authorInput.value = stripFormatting(this.authorInfo?.innerText || '');

    authorInput.addEventListener('input', (e) => {
      e.stopPropagation();
      if (this.authorInfo) {
        view.dispatch({
          changes: {
            from: this.authorInfo.innerFrom,
            to: this.authorInfo.innerTo,
            insert: authorInput.value,
          },
        });
      } else if (this.titleInfo) {
        view.dispatch({
          changes: {
            from: this.titleInfo.fullTo,
            to: this.titleInfo.fullTo,
            insert: `\n\\author{${authorInput.value}}`,
          },
        });
      }
    });
    authorWrap.appendChild(authorInput);
    header.appendChild(authorWrap);

    // Date
    if (this.dateInfo) {
      const dateEl = document.createElement('div');
      dateEl.className = 'cm-visual-doc-date';
      const cleanDate = stripFormatting(this.dateInfo.innerText);
      dateEl.textContent =
        cleanDate === '\\today'
          ? new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
          : cleanDate;
      header.appendChild(dateEl);
    }

    return header;
  }

  updateDOM(dom) {
    const activeEl = document.activeElement;
    const titleInput = dom.querySelector('.cm-visual-doc-title-input');
    if (titleInput && titleInput !== activeEl) {
      titleInput.value = stripFormatting(this.titleInfo?.innerText || '');
    }
    const authorInput = dom.querySelector('.cm-visual-doc-author-input');
    if (authorInput && authorInput !== activeEl) {
      authorInput.value = stripFormatting(this.authorInfo?.innerText || '');
    }
    return true;
  }
}

/**
 * Non-editable subtitle widget for `\begin{abstract}`.
 */
class AbstractHeaderWidget extends WidgetType {
  toDOM() {
    const div = document.createElement('div');
    div.className = 'cm-visual-abstract-header';
    div.textContent = 'Abstract';
    return div;
  }

  ignoreEvent() {
    return false;
  }
}

/**
 * Interactive Figure Card Widget replacing `\begin{figure}...\end{figure}`.
 * Features live image preview, two-way bound caption input, and optional `</> Code` toggle.
 */
class FigureCardWidget extends WidgetType {
  constructor(data) {
    super();
    this.data = data;
    // data: { blockFrom, blockTo, imagePath, captionInfo, rawLatex, figureNum }
  }

  eq(other) {
    return (
      other.data.blockFrom === this.data.blockFrom &&
      other.data.blockTo === this.data.blockTo &&
      other.data.imagePath === this.data.imagePath &&
      other.data.captionInfo?.innerText === this.data.captionInfo?.innerText &&
      other.data.rawLatex === this.data.rawLatex &&
      other.data.figureNum === this.data.figureNum
    );
  }

  ignoreEvent() {
    return true;
  }

  toDOM(view) {
    const container = document.createElement('div');
    container.className = 'cm-visual-figure-card';

    // Toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'cm-visual-figure-toolbar';
    const badge = document.createElement('span');
    badge.className = 'cm-visual-figure-badge';
    badge.textContent = `Figure ${this.data.figureNum}`;
    toolbar.appendChild(badge);

    const actions = document.createElement('div');
    actions.className = 'cm-visual-figure-actions';
    const codeBtn = document.createElement('button');
    codeBtn.type = 'button';
    codeBtn.className = 'cm-visual-figure-code-toggle';
    codeBtn.textContent = '</> Code';
    actions.appendChild(codeBtn);
    toolbar.appendChild(actions);
    container.appendChild(toolbar);

    // Visual Box
    const visualBox = document.createElement('div');
    visualBox.className = 'cm-visual-figure-visual-box';

    // Image container
    const imgWrap = document.createElement('div');
    imgWrap.className = 'cm-visual-figure-img-wrap';

    const auxFiles = view.state.facet(auxFilesFacet);
    const resolved = resolveFigureImage(this.data.imagePath, auxFiles);

    if (resolved && !resolved.isPdf) {
      const img = document.createElement('img');
      img.className = 'cm-visual-figure-img';
      img.src = resolved.src;
      img.alt = this.data.captionInfo?.innerText || this.data.imagePath;
      imgWrap.appendChild(img);
    } else if (resolved && resolved.isPdf) {
      const pdfBox = document.createElement('div');
      pdfBox.className = 'cm-visual-figure-pdf-preview';
      pdfBox.innerHTML = `<span class="cm-pdf-icon">📄</span> <span class="cm-pdf-name">${resolved.name}</span> <span class="cm-pdf-tag">Vector Graphic (PDF)</span>`;
      imgWrap.appendChild(pdfBox);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'cm-visual-figure-placeholder';
      placeholder.innerHTML = `
        <div class="cm-fig-ph-icon">🖼️</div>
        <div class="cm-fig-ph-text">${this.data.imagePath || 'No image specified'}</div>
        <div class="cm-fig-ph-sub">Figure Asset (Drive / MEMFS)</div>
      `;
      imgWrap.appendChild(placeholder);
    }
    visualBox.appendChild(imgWrap);

    // Caption row
    const captionRow = document.createElement('div');
    captionRow.className = 'cm-visual-figure-caption-row';

    const captionLabel = document.createElement('span');
    captionLabel.className = 'cm-visual-figure-caption-label';
    captionLabel.textContent = `Figure ${this.data.figureNum}:`;
    captionRow.appendChild(captionLabel);

    const captionInput = document.createElement('input');
    captionInput.type = 'text';
    captionInput.className = 'cm-visual-figure-caption-input';
    captionInput.placeholder = 'Click to edit figure caption...';
    captionInput.value = stripFormatting(this.data.captionInfo?.innerText || '');

    captionInput.addEventListener('input', (e) => {
      e.stopPropagation();
      const newCaption = captionInput.value;
      if (this.data.captionInfo) {
        view.dispatch({
          changes: {
            from: this.data.captionInfo.innerFrom,
            to: this.data.captionInfo.innerTo,
            insert: newCaption,
          },
        });
      } else {
        const docText = view.state.doc.toString();
        const endFigIdx = docText.lastIndexOf('\\end{figure', this.data.blockTo);
        if (endFigIdx >= this.data.blockFrom) {
          view.dispatch({
            changes: {
              from: endFigIdx,
              to: endFigIdx,
              insert: `  \\caption{${newCaption}}\n`,
            },
          });
        }
      }
    });

    captionRow.appendChild(captionInput);
    visualBox.appendChild(captionRow);
    container.appendChild(visualBox);

    // Raw Code Editor Box (hidden by default)
    const codeBox = document.createElement('div');
    codeBox.className = 'cm-visual-figure-code-box';
    codeBox.style.display = 'none';

    const rawTextarea = document.createElement('textarea');
    rawTextarea.className = 'cm-visual-figure-raw-code';
    rawTextarea.value = this.data.rawLatex;
    rawTextarea.rows = Math.min(10, Math.max(3, this.data.rawLatex.split('\n').length));

    rawTextarea.addEventListener('input', (e) => {
      e.stopPropagation();
      view.dispatch({
        changes: {
          from: this.data.blockFrom,
          to: this.data.blockTo,
          insert: rawTextarea.value,
        },
      });
    });

    codeBox.appendChild(rawTextarea);
    container.appendChild(codeBox);

    let isCodeVisible = false;
    codeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      isCodeVisible = !isCodeVisible;
      if (isCodeVisible) {
        visualBox.style.display = 'none';
        codeBox.style.display = 'block';
        codeBtn.textContent = '👁️ Visual';
        codeBtn.classList.add('active');
        rawTextarea.focus();
      } else {
        visualBox.style.display = 'block';
        codeBox.style.display = 'none';
        codeBtn.textContent = '</> Code';
        codeBtn.classList.remove('active');
      }
    });

    return container;
  }

  updateDOM(dom, view) {
    const captionInput = dom.querySelector('.cm-visual-figure-caption-input');
    if (captionInput && captionInput !== document.activeElement) {
      captionInput.value = stripFormatting(this.data.captionInfo?.innerText || '');
    }
    const rawTextarea = dom.querySelector('.cm-visual-figure-raw-code');
    if (rawTextarea && rawTextarea !== document.activeElement) {
      rawTextarea.value = this.data.rawLatex;
    }
    const auxFiles = view.state.facet(auxFilesFacet);
    const resolved = resolveFigureImage(this.data.imagePath, auxFiles);
    const img = dom.querySelector('.cm-visual-figure-img');
    if (img && resolved && !resolved.isPdf) {
      if (img.src !== resolved.src) img.src = resolved.src;
    }
    return true;
  }
}

/**
 * Interactive Bidirectional Table Widget replacing `\begin{table}` / `\begin{tabular}` blocks.
 * Provides cell-level two-way data binding, Tab navigation, and +Row / +Col micro-buttons.
 */
class TableWidget extends WidgetType {
  constructor(data) {
    super();
    this.data = data;
    // data: { blockFrom, blockTo, captionInfo, colSpec, rows, rawLatex, tableNum, tabularStart, tabularEnd }
  }

  eq(other) {
    return (
      other.data.blockFrom === this.data.blockFrom &&
      other.data.blockTo === this.data.blockTo &&
      other.data.captionInfo?.innerText === this.data.captionInfo?.innerText &&
      other.data.colSpec === this.data.colSpec &&
      other.data.rawLatex === this.data.rawLatex &&
      other.data.tableNum === this.data.tableNum
    );
  }

  ignoreEvent() {
    return true;
  }

  toDOM(view) {
    const container = document.createElement('div');
    container.className = 'cm-visual-table-card';

    // Toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'cm-visual-table-toolbar';

    const left = document.createElement('div');
    left.className = 'cm-visual-table-header-left';
    const badge = document.createElement('span');
    badge.className = 'cm-visual-table-badge';
    badge.textContent = `Table ${this.data.tableNum}`;
    left.appendChild(badge);

    const captionInput = document.createElement('input');
    captionInput.type = 'text';
    captionInput.className = 'cm-visual-table-caption-input';
    captionInput.placeholder = 'Click to edit table caption...';
    captionInput.value = stripFormatting(this.data.captionInfo?.innerText || '');

    captionInput.addEventListener('input', (e) => {
      e.stopPropagation();
      const newCaption = captionInput.value;
      if (this.data.captionInfo) {
        view.dispatch({
          changes: {
            from: this.data.captionInfo.innerFrom,
            to: this.data.captionInfo.innerTo,
            insert: newCaption,
          },
        });
      } else {
        view.dispatch({
          changes: {
            from: this.data.tabularStart,
            to: this.data.tabularStart,
            insert: `  \\caption{${newCaption}}\n`,
          },
        });
      }
    });
    left.appendChild(captionInput);
    toolbar.appendChild(left);

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'cm-visual-table-actions';

    const addRowBtn = document.createElement('button');
    addRowBtn.type = 'button';
    addRowBtn.className = 'cm-visual-tbl-btn';
    addRowBtn.textContent = '+ Row';
    addRowBtn.title = 'Add new row to table';

    const addColBtn = document.createElement('button');
    addColBtn.type = 'button';
    addColBtn.className = 'cm-visual-tbl-btn';
    addColBtn.textContent = '+ Col';
    addColBtn.title = 'Add new column to table';

    const codeBtn = document.createElement('button');
    codeBtn.type = 'button';
    codeBtn.className = 'cm-visual-tbl-btn cm-tbl-code-btn';
    codeBtn.textContent = '</> Code';
    codeBtn.title = 'Toggle raw LaTeX code';

    actions.appendChild(addRowBtn);
    actions.appendChild(addColBtn);
    actions.appendChild(codeBtn);
    toolbar.appendChild(actions);
    container.appendChild(toolbar);

    // Table DOM view
    const scrollWrap = document.createElement('div');
    scrollWrap.className = 'cm-visual-table-scroll';

    const table = document.createElement('table');
    table.className = 'cm-visual-table';

    const inputGrid = [];

    this.data.rows.forEach((row, rIdx) => {
      const tr = document.createElement('tr');
      const rowInputs = [];
      const isHeader = rIdx === 0 && this.data.rows.length > 1;

      row.cells.forEach((cell, cIdx) => {
        const cellElem = document.createElement(isHeader ? 'th' : 'td');
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'cm-visual-cell-input';
        if (isHeader) input.classList.add('header-cell');
        input.value = cell.text;

        input.addEventListener('input', (e) => {
          e.stopPropagation();
          view.dispatch({
            changes: {
              from: cell.from,
              to: cell.to,
              insert: input.value,
            },
          });
        });

        // Tab / Shift+Tab and Enter keyboard navigation
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Tab') {
            e.preventDefault();
            e.stopPropagation();
            if (e.shiftKey) {
              if (cIdx > 0) inputGrid[rIdx][cIdx - 1]?.focus();
              else if (rIdx > 0) inputGrid[rIdx - 1][inputGrid[rIdx - 1].length - 1]?.focus();
            } else {
              if (cIdx < rowInputs.length - 1) inputGrid[rIdx][cIdx + 1]?.focus();
              else if (rIdx < inputGrid.length - 1) inputGrid[rIdx + 1][0]?.focus();
            }
          } else if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            if (rIdx < inputGrid.length - 1) {
              inputGrid[rIdx + 1][cIdx]?.focus();
            }
          }
        });

        cellElem.appendChild(input);
        tr.appendChild(cellElem);
        rowInputs.push(input);
      });

      inputGrid.push(rowInputs);
      table.appendChild(tr);
    });

    scrollWrap.appendChild(table);
    container.appendChild(scrollWrap);

    // Raw Code Editor Box (hidden by default)
    const codeBox = document.createElement('div');
    codeBox.className = 'cm-visual-table-code-box';
    codeBox.style.display = 'none';

    const rawTextarea = document.createElement('textarea');
    rawTextarea.className = 'cm-visual-table-raw-code';
    rawTextarea.value = this.data.rawLatex;
    rawTextarea.rows = Math.min(12, Math.max(4, this.data.rawLatex.split('\n').length));

    rawTextarea.addEventListener('input', (e) => {
      e.stopPropagation();
      view.dispatch({
        changes: {
          from: this.data.blockFrom,
          to: this.data.blockTo,
          insert: rawTextarea.value,
        },
      });
    });

    codeBox.appendChild(rawTextarea);
    container.appendChild(codeBox);

    // Event Handlers for Toolbar
    addRowBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cols = this.data.rows[0]?.cells?.length || 2;
      const newRowStr = '\n    ' + Array(cols).fill(' ').join(' & ') + ' \\\\';
      const docText = view.state.doc.toString();
      const endTabularPos = docText.lastIndexOf('\\end{tabular', this.data.blockTo);
      if (endTabularPos >= this.data.tabularStart) {
        view.dispatch({
          changes: {
            from: endTabularPos,
            to: endTabularPos,
            insert: newRowStr + '\n',
          },
        });
      }
    });

    addColBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const changes = [];
      this.data.rows.forEach((r) => {
        changes.push({
          from: r.to,
          to: r.to,
          insert: ' & ',
        });
      });
      const docText = view.state.doc.toString();
      const colSpecFrom = docText.indexOf('{', this.data.tabularStart);
      const colSpecTo = docText.indexOf('}', colSpecFrom);
      if (colSpecFrom !== -1 && colSpecTo !== -1 && colSpecTo < this.data.tabularEnd) {
        changes.push({
          from: colSpecTo,
          to: colSpecTo,
          insert: ' c',
        });
      }
      if (changes.length > 0) {
        changes.sort((a, b) => b.from - a.from);
        view.dispatch({ changes });
      }
    });

    let isCodeVisible = false;
    codeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      isCodeVisible = !isCodeVisible;
      if (isCodeVisible) {
        scrollWrap.style.display = 'none';
        codeBox.style.display = 'block';
        codeBtn.textContent = '👁️ Visual';
        codeBtn.classList.add('active');
        rawTextarea.focus();
      } else {
        scrollWrap.style.display = 'block';
        codeBox.style.display = 'none';
        codeBtn.textContent = '</> Code';
        codeBtn.classList.remove('active');
      }
    });

    return container;
  }

  updateDOM(dom) {
    const activeEl = document.activeElement;
    const inputs = dom.querySelectorAll('.cm-visual-cell-input');
    let idx = 0;
    this.data.rows.forEach((row) => {
      row.cells.forEach((cell) => {
        const input = inputs[idx++];
        if (input && input !== activeEl) {
          if (input.value !== cell.text) input.value = cell.text;
        }
      });
    });
    const captionInput = dom.querySelector('.cm-visual-table-caption-input');
    if (captionInput && captionInput !== activeEl) {
      captionInput.value = stripFormatting(this.data.captionInfo?.innerText || '');
    }
    const rawTextarea = dom.querySelector('.cm-visual-table-raw-code');
    if (rawTextarea && rawTextarea !== activeEl) {
      rawTextarea.value = this.data.rawLatex;
    }
    return true;
  }
}

/**
 * References section header replacing `\begin{thebibliography}`.
 */
class ReferencesHeaderWidget extends WidgetType {
  toDOM() {
    const div = document.createElement('div');
    div.className = 'cm-visual-references-header';
    div.innerHTML = '<span class="cm-visual-ref-icon">📚</span> References';
    return div;
  }

  ignoreEvent() {
    return false;
  }
}

/**
 * Visual badge widget replacing `\bibitem[opt]{key}` with `[opt || index]`.
 */
class BibitemBadgeWidget extends WidgetType {
  constructor(badgeText, key) {
    super();
    this.badgeText = badgeText;
    this.key = key;
  }

  eq(other) {
    return other.badgeText === this.badgeText && other.key === this.key;
  }

  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-visual-bibitem-badge';
    span.textContent = `[${this.badgeText}]`;
    span.title = `Citation key: ${this.key}`;
    return span;
  }

  ignoreEvent() {
    return false;
  }
}

/**
 * Visual card widget representing `\bibliography{file}` or `\printbibliography`.
 */
class BibliographyCardWidget extends WidgetType {
  constructor(bibFileName) {
    super();
    this.bibFileName = bibFileName;
  }

  eq(other) {
    return other.bibFileName === this.bibFileName;
  }

  toDOM(view) {
    const card = document.createElement('div');
    card.className = 'cm-visual-bib-card';

    const auxFiles = view.state.facet(auxFilesFacet);
    let bibContent = null;
    let bibEntry = null;

    if (auxFiles) {
      const cleanName = this.bibFileName.replace(/\.bib$/i, '');
      const searchKeys = [this.bibFileName, cleanName + '.bib', cleanName];
      for (const k of searchKeys) {
        bibEntry = getAuxEntry(auxFiles, k);
        if (bibEntry) break;
      }
      if (!bibEntry && typeof auxFiles.forEach === 'function') {
        auxFiles.forEach((val, key) => {
          if (bibEntry) return;
          if (key.endsWith('.bib') && (key.includes(cleanName) || key.endsWith('/' + this.bibFileName))) {
            bibEntry = val;
          }
        });
      }
    }

    if (bibEntry && bibEntry.content) {
      if (typeof bibEntry.content === 'string') {
        bibContent = bibEntry.content;
      } else if (bibEntry.content instanceof Uint8Array) {
        bibContent = new TextDecoder('utf-8').decode(bibEntry.content);
      }
    }

    const entries = bibContent ? parseBibtexEntries(bibContent) : [];

    // Header
    const header = document.createElement('div');
    header.className = 'cm-visual-bib-header';
    header.innerHTML = `
      <div class="cm-visual-bib-title">
        <span class="cm-visual-bib-icon">📚</span>
        <span>References linked from: <strong>${this.bibFileName}</strong></span>
      </div>
      <span class="cm-visual-bib-badge ${bibEntry ? 'loaded' : 'unloaded'}">
        ${bibEntry ? `${entries.length} citations loaded` : 'Drive / Project File'}
      </span>
    `;
    card.appendChild(header);

    if (entries.length > 0) {
      const list = document.createElement('div');
      list.className = 'cm-visual-bib-list';
      entries.slice(0, 15).forEach((entry) => {
        const item = document.createElement('div');
        item.className = 'cm-visual-bib-entry';
        item.innerHTML = `
          <span class="cm-visual-bib-key">[${entry.key}]</span>
          <span class="cm-visual-bib-body">
            <span class="cm-visual-bib-title-text">${entry.title || 'Untitled'}</span>
            <span class="cm-visual-bib-meta">${entry.author ? `${entry.author}` : ''} ${entry.year ? `(${entry.year})` : ''}</span>
          </span>
        `;
        list.appendChild(item);
      });
      if (entries.length > 15) {
        const more = document.createElement('div');
        more.className = 'cm-visual-bib-more';
        more.textContent = `... and ${entries.length - 15} more references in ${this.bibFileName}`;
        list.appendChild(more);
      }
      card.appendChild(list);
    }

    return card;
  }

  ignoreEvent() {
    return false;
  }
}

/**
 * Widget that renders inline or display LaTeX math using KaTeX.
 */
class KatexMathWidget extends WidgetType {
  constructor(texMath, displayMode, targetPos) {
    super();
    this.texMath = texMath;
    this.displayMode = displayMode;
    this.targetPos = targetPos;
  }

  eq(other) {
    return (
      other.texMath === this.texMath &&
      other.displayMode === this.displayMode &&
      other.targetPos === this.targetPos
    );
  }

  toDOM(view) {
    const container = document.createElement('span');
    container.className = this.displayMode ? 'cm-visual-math-block' : 'cm-visual-math-inline';
    container.title = 'Click to edit LaTeX math source';

    try {
      katex.render(this.texMath.trim() || '\\;', container, {
        displayMode: this.displayMode,
        throwOnError: false,
        strict: false,
        trust: true,
      });
    } catch {
      container.textContent = this.texMath;
    }

    container.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({
        selection: { anchor: this.targetPos },
      });
      view.focus();
    });

    return container;
  }

  ignoreEvent() {
    return false;
  }
}

/**
 * Widget that renders `\cite{key}` as a compact `[key]` pill.
 */
class CitationPillWidget extends WidgetType {
  constructor(citeKeys, targetPos) {
    super();
    this.citeKeys = citeKeys;
    this.targetPos = targetPos;
  }

  eq(other) {
    return other.citeKeys === this.citeKeys && other.targetPos === this.targetPos;
  }

  toDOM(view) {
    const span = document.createElement('span');
    span.className = 'cm-visual-cite-pill';
    span.title = `Citation: ${this.citeKeys} (Click to edit)`;
    span.textContent = `[${this.citeKeys}]`;
    span.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({
        selection: { anchor: this.targetPos },
      });
      view.focus();
    });
    return span;
  }

  ignoreEvent() {
    return false;
  }
}

/**
 * Widget that renders `\item` as a clean bullet symbol `•`.
 */
class BulletItemWidget extends WidgetType {
  constructor(targetPos) {
    super();
    this.targetPos = targetPos;
  }

  eq(other) {
    return other.targetPos === this.targetPos;
  }

  toDOM(view) {
    const span = document.createElement('span');
    span.className = 'cm-visual-item-bullet';
    span.title = '\\item (Click to edit)';
    span.textContent = '•';
    span.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({
        selection: { anchor: this.targetPos },
      });
      view.focus();
    });
    return span;
  }

  ignoreEvent() {
    return false;
  }
}

/* ==========================================================================
   DECORATION BUILDER
   ========================================================================== */

/**
 * Checks if any cursor/selection range in `state` overlaps with `[from, to]`.
 */
function isSelectionTouching(state, from, to) {
  for (const range of state.selection.ranges) {
    if (range.from <= to && range.to >= from) {
      return true;
    }
  }
  return false;
}

/**
 * Parses rows and cells inside a LaTeX `\begin{tabular}` block.
 */
function parseTableRows(docText, tabularStart, tabularEnd) {
  const body = docText.slice(tabularStart, tabularEnd);
  const rowDelimRegex = /\\\\(?:\[[^\]]*\])?/g;
  let lastPos = 0;
  let match;
  const rows = [];

  while ((match = rowDelimRegex.exec(body)) !== null) {
    const rawRow = body.slice(lastPos, match.index);
    const rowDocStart = tabularStart + lastPos;
    const rowDocEnd = tabularStart + match.index;
    lastPos = match.index + match[0].length;

    const cleanedRow = rawRow.replace(/\\(hline|toprule|midrule|bottomrule)\b/g, '').trim();
    if (!cleanedRow) continue;

    const cellRegex = /&/g;
    let cellLast = 0;
    let cellMatch;
    const cells = [];

    while ((cellMatch = cellRegex.exec(rawRow)) !== null) {
      const rawCell = rawRow.slice(cellLast, cellMatch.index);
      const rawCellDocStart = rowDocStart + cellLast;
      const rawCellDocEnd = rowDocStart + cellMatch.index;
      cellLast = cellMatch.index + 1;

      const cellClean = rawCell.replace(/\\(hline|toprule|midrule|bottomrule)\b/g, '');
      const trimmed = cellClean.trim();
      const offsetInRaw = rawCell.indexOf(trimmed);
      const from = offsetInRaw >= 0 ? rawCellDocStart + offsetInRaw : rawCellDocStart;
      const to = offsetInRaw >= 0 ? from + trimmed.length : rawCellDocEnd;
      cells.push({ from, to, text: trimmed, raw: rawCell });
    }

    const rawCell = rawRow.slice(cellLast);
    const rawCellDocStart = rowDocStart + cellLast;
    const rawCellDocEnd = rowDocStart + rawRow.length;
    const cellClean = rawCell.replace(/\\(hline|toprule|midrule|bottomrule)\b/g, '');
    const trimmed = cellClean.trim();
    const offsetInRaw = rawCell.indexOf(trimmed);
    const from = offsetInRaw >= 0 ? rawCellDocStart + offsetInRaw : rawCellDocStart;
    const to = offsetInRaw >= 0 ? from + trimmed.length : rawCellDocEnd;
    cells.push({ from, to, text: trimmed, raw: rawCell });

    rows.push({ from: rowDocStart, to: rowDocEnd, cells });
  }

  return rows;
}

/**
 * Builds the complete set of Overleaf-style Visual Editor decorations for the document.
 *
 * @param {import('@codemirror/state').EditorState} state
 * @returns {import('@codemirror/view').DecorationSet}
 */
export function buildVisualDecorations(state) {
  const docText = state.doc.toString();
  if (!docText) return Decoration.none;

  /** @type {Array<{ from: number, to: number, deco: Decoration }>} */
  const rawDecorations = [];
  /** @type {Array<{ from: number, to: number }>} */
  const occupiedRanges = [];

  const isOverlappingOccupied = (from, to) => {
    for (const r of occupiedRanges) {
      if (from < r.to && to > r.from) {
        return true;
      }
    }
    return false;
  };

  const markOccupied = (from, to) => {
    occupiedRanges.push({ from, to });
  };

  // Pre-populate occupiedRanges with review items so visual decorations never collide with review macros
  try {
    const reviewItems = scanReviewItems(docText);
    for (const rItem of reviewItems) {
      markOccupied(rItem.fullFrom, rItem.fullTo);
    }
  } catch {
    // Graceful fallback
  }

  /* --------------------------------------------------------------------------
     1. Preamble & Document Header (Two-Way Bound Title & Author)
     -------------------------------------------------------------------------- */
  const beginDocMatch = /\\begin\{document\}/.exec(docText);
  const docClassMatch = /\\documentclass\b/.exec(docText);
  const titleInfo = findBalancedCommand(docText, 'title');
  const authorInfo = findBalancedCommand(docText, 'author');
  const dateInfo = findBalancedCommand(docText, 'date');
  const maketitleMatch = /\\maketitle\b/.exec(docText);

  // Hide \maketitle completely in visual mode
  if (maketitleMatch) {
    const mFrom = maketitleMatch.index;
    const mTo = mFrom + maketitleMatch[0].length;
    rawDecorations.push({
      from: mFrom,
      to: mTo,
      deco: Decoration.replace({}),
    });
    markOccupied(mFrom, mTo);
  }

  if (docClassMatch && beginDocMatch && beginDocMatch.index > docClassMatch.index) {
    const preambleFrom = docClassMatch.index;
    const preambleTo = beginDocMatch.index + beginDocMatch[0].length;

    // Check if title is inside preamble
    if (titleInfo && titleInfo.fullFrom < preambleTo) {
      // Chunk 1: from preambleFrom up to titleInfo.fullFrom
      if (titleInfo.fullFrom > preambleFrom) {
        const startLine = state.doc.lineAt(preambleFrom).number;
        const endLine = state.doc.lineAt(titleInfo.fullFrom).number;
        const lineCount = Math.max(1, endLine - startLine + 1);

        if (!isSelectionTouching(state, preambleFrom, titleInfo.fullFrom)) {
          rawDecorations.push({
            from: preambleFrom,
            to: titleInfo.fullFrom,
            deco: Decoration.replace({
              widget: new PreambleBannerWidget(preambleFrom + 1, lineCount),
            }),
          });
          markOccupied(preambleFrom, titleInfo.fullFrom);
        }
      }

      // Document Header Widget replacing \title{...}
      rawDecorations.push({
        from: titleInfo.fullFrom,
        to: titleInfo.fullTo,
        deco: Decoration.replace({
          widget: new DocumentHeaderWidget(titleInfo, authorInfo, dateInfo),
        }),
      });
      markOccupied(titleInfo.fullFrom, titleInfo.fullTo);

      // Hide \author{...} and \date{...} (now rendered in the Document Header)
      if (authorInfo && !isOverlappingOccupied(authorInfo.fullFrom, authorInfo.fullTo)) {
        rawDecorations.push({
          from: authorInfo.fullFrom,
          to: authorInfo.fullTo,
          deco: Decoration.replace({}),
        });
        markOccupied(authorInfo.fullFrom, authorInfo.fullTo);
      }
      if (dateInfo && !isOverlappingOccupied(dateInfo.fullFrom, dateInfo.fullTo)) {
        rawDecorations.push({
          from: dateInfo.fullFrom,
          to: dateInfo.fullTo,
          deco: Decoration.replace({}),
        });
        markOccupied(dateInfo.fullFrom, dateInfo.fullTo);
      }

      // Remainder of preamble up to \begin{document}
      const remainderFrom = Math.max(
        titleInfo.fullTo,
        authorInfo ? authorInfo.fullTo : 0,
        dateInfo ? dateInfo.fullTo : 0
      );
      if (preambleTo > remainderFrom && !isOverlappingOccupied(remainderFrom, preambleTo)) {
        rawDecorations.push({
          from: remainderFrom,
          to: preambleTo,
          deco: Decoration.replace({}),
        });
        markOccupied(remainderFrom, preambleTo);
      }
    } else {
      // Title is after \begin{document} or not present
      if (!isSelectionTouching(state, preambleFrom, preambleTo)) {
        const startLine = state.doc.lineAt(preambleFrom).number;
        const endLine = state.doc.lineAt(preambleTo).number;
        const lineCount = Math.max(1, endLine - startLine + 1);
        rawDecorations.push({
          from: preambleFrom,
          to: preambleTo,
          deco: Decoration.replace({
            widget: new PreambleBannerWidget(preambleFrom + 1, lineCount),
          }),
        });
        markOccupied(preambleFrom, preambleTo);
      }

      if (titleInfo && !isOverlappingOccupied(titleInfo.fullFrom, titleInfo.fullTo)) {
        rawDecorations.push({
          from: titleInfo.fullFrom,
          to: titleInfo.fullTo,
          deco: Decoration.replace({
            widget: new DocumentHeaderWidget(titleInfo, authorInfo, dateInfo),
          }),
        });
        markOccupied(titleInfo.fullFrom, titleInfo.fullTo);

        if (authorInfo && !isOverlappingOccupied(authorInfo.fullFrom, authorInfo.fullTo)) {
          rawDecorations.push({
            from: authorInfo.fullFrom,
            to: authorInfo.fullTo,
            deco: Decoration.replace({}),
          });
          markOccupied(authorInfo.fullFrom, authorInfo.fullTo);
        }
        if (dateInfo && !isOverlappingOccupied(dateInfo.fullFrom, dateInfo.fullTo)) {
          rawDecorations.push({
            from: dateInfo.fullFrom,
            to: dateInfo.fullTo,
            deco: Decoration.replace({}),
          });
          markOccupied(dateInfo.fullFrom, dateInfo.fullTo);
        }
      }
    }
  }

  // Hide \end{document}
  const endDocMatch = /\\end\{document\}/.exec(docText);
  if (endDocMatch) {
    const endFrom = endDocMatch.index;
    const endTo = endFrom + endDocMatch[0].length;
    if (!isOverlappingOccupied(endFrom, endTo) && !isSelectionTouching(state, endFrom, endTo)) {
      rawDecorations.push({
        from: endFrom,
        to: endTo,
        deco: Decoration.replace({}),
      });
      markOccupied(endFrom, endTo);
    }
  }

  /* --------------------------------------------------------------------------
     2. Interactive Figure Cards (\begin{figure}...\end{figure})
     -------------------------------------------------------------------------- */
  const figureRegex = /\\begin\{figure\*?\}([\s\S]*?)\\end\{figure\*?\}/g;
  let figMatch;
  let figureCounter = 1;
  while ((figMatch = figureRegex.exec(docText)) !== null) {
    const blockFrom = figMatch.index;
    const blockTo = blockFrom + figMatch[0].length;
    if (isOverlappingOccupied(blockFrom, blockTo)) continue;

    const body = figMatch[1];
    const includegraphicsMatch = /\\includegraphics(?:\[([^\]]*)\])?\{([^}]+)\}/.exec(body);
    const imagePath = includegraphicsMatch ? includegraphicsMatch[2].trim() : '';
    const captionInfo = findBalancedCommand(docText, 'caption', blockFrom, blockTo);

    rawDecorations.push({
      from: blockFrom,
      to: blockTo,
      deco: Decoration.replace({
        widget: new FigureCardWidget({
          blockFrom,
          blockTo,
          imagePath,
          captionInfo,
          rawLatex: figMatch[0],
          figureNum: figureCounter++,
        }),
      }),
    });
    markOccupied(blockFrom, blockTo);
  }

  /* --------------------------------------------------------------------------
     3. Bidirectional Table Widget (\begin{table} / \begin{tabular})
     -------------------------------------------------------------------------- */
  const tableRegex = /\\begin\{table\*?\}([\s\S]*?)\\end\{table\*?\}/g;
  let tblMatch;
  let tableCounter = 1;

  while ((tblMatch = tableRegex.exec(docText)) !== null) {
    const blockFrom = tblMatch.index;
    const blockTo = blockFrom + tblMatch[0].length;
    if (isOverlappingOccupied(blockFrom, blockTo)) continue;

    const body = tblMatch[1];
    const tabMatch = /\\begin\{tabular\*?\}\{([^}]+)\}([\s\S]*?)\\end\{tabular\*?\}/.exec(body);
    const captionInfo = findBalancedCommand(docText, 'caption', blockFrom, blockTo);

    if (tabMatch) {
      const colSpec = tabMatch[1];
      const tabInner = tabMatch[2];
      const tabularStart = blockFrom + body.indexOf(tabInner);
      const tabularEnd = tabularStart + tabInner.length;
      const rows = parseTableRows(docText, tabularStart, tabularEnd);

      if (rows.length > 0) {
        rawDecorations.push({
          from: blockFrom,
          to: blockTo,
          deco: Decoration.replace({
            widget: new TableWidget({
              blockFrom,
              blockTo,
              captionInfo,
              colSpec,
              rows,
              rawLatex: tblMatch[0],
              tableNum: tableCounter++,
              tabularStart,
              tabularEnd,
            }),
          }),
        });
        markOccupied(blockFrom, blockTo);
      }
    }
  }

  // Standalone tabular blocks not wrapped in \begin{table}
  const standaloneTabRegex = /\\begin\{tabular\*?\}\{([^}]+)\}([\s\S]*?)\\end\{tabular\*?\}/g;
  let stMatch;
  while ((stMatch = standaloneTabRegex.exec(docText)) !== null) {
    const blockFrom = stMatch.index;
    const blockTo = blockFrom + stMatch[0].length;
    if (isOverlappingOccupied(blockFrom, blockTo)) continue;

    const colSpec = stMatch[1];
    const tabInner = stMatch[2];
    const tabularStart = blockFrom + stMatch[0].indexOf(tabInner);
    const tabularEnd = tabularStart + tabInner.length;
    const rows = parseTableRows(docText, tabularStart, tabularEnd);

    if (rows.length > 0) {
      rawDecorations.push({
        from: blockFrom,
        to: blockTo,
        deco: Decoration.replace({
          widget: new TableWidget({
            blockFrom,
            blockTo,
            captionInfo: null,
            colSpec,
            rows,
            rawLatex: stMatch[0],
            tableNum: tableCounter++,
            tabularStart,
            tabularEnd,
          }),
        }),
      });
      markOccupied(blockFrom, blockTo);
    }
  }

  /* --------------------------------------------------------------------------
     4. Abstract Environment
     -------------------------------------------------------------------------- */
  const abstractRegex = /\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/g;
  let absMatch;
  while ((absMatch = abstractRegex.exec(docText)) !== null) {
    const beginFrom = absMatch.index;
    const beginTo = beginFrom + '\\begin{abstract}'.length;
    const endTo = beginFrom + absMatch[0].length;
    const endFrom = endTo - '\\end{abstract}'.length;

    if (isOverlappingOccupied(beginFrom, beginTo) || isOverlappingOccupied(endFrom, endTo)) {
      continue;
    }

    rawDecorations.push({
      from: beginFrom,
      to: beginTo,
      deco: Decoration.replace({
        widget: new AbstractHeaderWidget(),
      }),
    });
    markOccupied(beginFrom, beginTo);

    rawDecorations.push({
      from: endFrom,
      to: endTo,
      deco: Decoration.replace({}),
    });
    markOccupied(endFrom, endTo);

    // Style lines of the abstract with an indented visual card container
    const startLine = state.doc.lineAt(beginTo).number;
    const endLine = state.doc.lineAt(endFrom).number;
    for (let l = startLine; l <= endLine; l++) {
      const line = state.doc.line(l);
      rawDecorations.push({
        from: line.from,
        to: line.from,
        deco: Decoration.line({ class: 'cm-visual-abstract-line' }),
      });
    }
  }

  /* --------------------------------------------------------------------------
     5. Bibliography & References
     -------------------------------------------------------------------------- */
  // \begin{thebibliography}{...} -> References header
  const bibEnvRegex = /\\begin\{thebibliography\}(?:\{[^}]*\})?/g;
  let bibEnvMatch;
  while ((bibEnvMatch = bibEnvRegex.exec(docText)) !== null) {
    const from = bibEnvMatch.index;
    const to = from + bibEnvMatch[0].length;
    if (isOverlappingOccupied(from, to)) continue;
    rawDecorations.push({
      from,
      to,
      deco: Decoration.replace({
        widget: new ReferencesHeaderWidget(),
      }),
    });
    markOccupied(from, to);
  }

  // \end{thebibliography} -> hidden
  const endBibRegex = /\\end\{thebibliography\}/g;
  let endBibMatch;
  while ((endBibMatch = endBibRegex.exec(docText)) !== null) {
    const from = endBibMatch.index;
    const to = from + endBibMatch[0].length;
    if (isOverlappingOccupied(from, to)) continue;
    rawDecorations.push({
      from,
      to,
      deco: Decoration.replace({}),
    });
    markOccupied(from, to);
  }

  // \bibitem[opt]{key} -> clean reference badge [1] or [opt]
  const bibitemRegex = /\\bibitem(?:\[([^\]]*)\])?\{([^}]+)\}/g;
  let bibitemMatch;
  let bibitemCounter = 1;
  while ((bibitemMatch = bibitemRegex.exec(docText)) !== null) {
    const from = bibitemMatch.index;
    const to = from + bibitemMatch[0].length;
    if (isOverlappingOccupied(from, to)) continue;

    const opt = bibitemMatch[1];
    const key = bibitemMatch[2].trim();
    const badgeText = opt || String(bibitemCounter++);

    rawDecorations.push({
      from,
      to,
      deco: Decoration.replace({
        widget: new BibitemBadgeWidget(badgeText, key),
      }),
    });
    markOccupied(from, to);
  }

  // External BibTeX: \bibliography{file}, \addbibresource{file.bib}, \printbibliography
  const extBibRegex = /\\(?:bibliography|addbibresource)\{([^}]+)\}|\\printbibliography\b/g;
  let extBibMatch;
  while ((extBibMatch = extBibRegex.exec(docText)) !== null) {
    const from = extBibMatch.index;
    const to = from + extBibMatch[0].length;
    if (isOverlappingOccupied(from, to)) continue;

    const bibFile = extBibMatch[1] ? extBibMatch[1].trim() : 'references.bib';
    const cleanBibFile = bibFile.endsWith('.bib') ? bibFile : bibFile + '.bib';

    rawDecorations.push({
      from,
      to,
      deco: Decoration.replace({
        widget: new BibliographyCardWidget(cleanBibFile),
      }),
    });
    markOccupied(from, to);
  }

  /* --------------------------------------------------------------------------
     6. Display Math Environments
     -------------------------------------------------------------------------- */
  const displayMathRegex =
    /\\begin\{(equation\*?|align\*?|gather\*?)\}([\s\S]*?)\\end\{\1\}|\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]/g;
  let dMathMatch;
  while ((dMathMatch = displayMathRegex.exec(docText)) !== null) {
    const from = dMathMatch.index;
    const to = from + dMathMatch[0].length;
    if (isOverlappingOccupied(from, to) || isSelectionTouching(state, from, to)) {
      continue;
    }
    const mathInner = dMathMatch[2] ?? dMathMatch[3] ?? dMathMatch[4] ?? '';
    rawDecorations.push({
      from,
      to,
      deco: Decoration.replace({
        widget: new KatexMathWidget(mathInner, true, from + 1),
      }),
    });
    markOccupied(from, to);
  }

  /* --------------------------------------------------------------------------
     7. Inline Math: $...$
     -------------------------------------------------------------------------- */
  const inlineMathRegex = /(?<!\\|\$)\$(?!\$)([^$\n]+?)(?<!\\)\$/g;
  let iMathMatch;
  while ((iMathMatch = inlineMathRegex.exec(docText)) !== null) {
    const from = iMathMatch.index;
    const to = from + iMathMatch[0].length;
    if (isOverlappingOccupied(from, to) || isSelectionTouching(state, from, to)) {
      continue;
    }
    const mathInner = iMathMatch[1];
    rawDecorations.push({
      from,
      to,
      deco: Decoration.replace({
        widget: new KatexMathWidget(mathInner, false, from + 1),
      }),
    });
    markOccupied(from, to);
  }

  /* --------------------------------------------------------------------------
     8. Section Headings: \section*{...}, \subsection{...}, \subsubsection{...}
     -------------------------------------------------------------------------- */
  const headingRegex = /\\(section\*?|subsection\*?|subsubsection\*?)\{([^{}\n]+)\}/g;
  let hMatch;
  while ((hMatch = headingRegex.exec(docText)) !== null) {
    const fullFrom = hMatch.index;
    const fullTo = fullFrom + hMatch[0].length;
    if (isOverlappingOccupied(fullFrom, fullTo) || isSelectionTouching(state, fullFrom, fullTo)) {
      continue;
    }
    const cmd = hMatch[1];
    const prefixLen = cmd.length + 2;
    const textFrom = fullFrom + prefixLen;
    const textTo = fullTo - 1;
    if (textTo <= textFrom) continue;

    const headingClass = cmd.startsWith('section')
      ? 'cm-visual-h1'
      : cmd.startsWith('subsection')
      ? 'cm-visual-h2'
      : 'cm-visual-h3';

    rawDecorations.push({
      from: fullFrom,
      to: textFrom,
      deco: Decoration.replace({}),
    });
    rawDecorations.push({
      from: textFrom,
      to: textTo,
      deco: Decoration.mark({ class: headingClass }),
    });
    rawDecorations.push({
      from: textTo,
      to: fullTo,
      deco: Decoration.replace({}),
    });
    markOccupied(fullFrom, fullTo);
  }

  /* --------------------------------------------------------------------------
     9. Text Formatting: \textbf{...}, \textit{...}, \emph{...}, \underline{...}
     -------------------------------------------------------------------------- */
  const formatRegex = /\\(textbf|textit|emph|underline)\{([^{}\n]+)\}/g;
  let fmtMatch;
  while ((fmtMatch = formatRegex.exec(docText)) !== null) {
    const fullFrom = fmtMatch.index;
    const fullTo = fullFrom + fmtMatch[0].length;
    if (isOverlappingOccupied(fullFrom, fullTo) || isSelectionTouching(state, fullFrom, fullTo)) {
      continue;
    }
    const cmd = fmtMatch[1];
    const prefixLen = cmd.length + 2;
    const textFrom = fullFrom + prefixLen;
    const textTo = fullTo - 1;
    if (textTo <= textFrom) continue;

    const formatClass =
      cmd === 'textbf'
        ? 'cm-visual-bold'
        : cmd === 'underline'
        ? 'cm-visual-underline'
        : 'cm-visual-italic';

    rawDecorations.push({
      from: fullFrom,
      to: textFrom,
      deco: Decoration.replace({}),
    });
    rawDecorations.push({
      from: textFrom,
      to: textTo,
      deco: Decoration.mark({ class: formatClass }),
    });
    rawDecorations.push({
      from: textTo,
      to: fullTo,
      deco: Decoration.replace({}),
    });
    markOccupied(fullFrom, fullTo);
  }

  /* --------------------------------------------------------------------------
     10. Citations: \cite{...}, \citep{...}, \citet{...}
     -------------------------------------------------------------------------- */
  const citeRegex = /\\cite[pt]?\{([^{}\n]+)\}/g;
  let citeMatch;
  while ((citeMatch = citeRegex.exec(docText)) !== null) {
    const from = citeMatch.index;
    const to = from + citeMatch[0].length;
    if (isOverlappingOccupied(from, to) || isSelectionTouching(state, from, to)) {
      continue;
    }
    const keys = citeMatch[1].trim();
    rawDecorations.push({
      from,
      to,
      deco: Decoration.replace({
        widget: new CitationPillWidget(keys, from + 1),
      }),
    });
    markOccupied(from, to);
  }

  /* --------------------------------------------------------------------------
     11. List Items: \item
     -------------------------------------------------------------------------- */
  const itemRegex = /\\item\b/g;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(docText)) !== null) {
    const from = itemMatch.index;
    const to = from + itemMatch[0].length;
    if (isOverlappingOccupied(from, to) || isSelectionTouching(state, from, to)) {
      continue;
    }
    rawDecorations.push({
      from,
      to,
      deco: Decoration.replace({
        widget: new BulletItemWidget(from + 1),
      }),
    });
    markOccupied(from, to);
  }

  if (rawDecorations.length === 0) {
    return Decoration.none;
  }

  // Sort all decorations strictly by `from`, then `to` for CodeMirror 6 Decoration.set
  rawDecorations.sort((a, b) => a.from - b.from || a.to - b.to);

  const ranges = rawDecorations.map((d) => d.deco.range(d.from, d.to));
  return Decoration.set(ranges, true);
}

/**
 * CodeMirror 6 extension enabling Overleaf-style Visual Editor mode.
 */
export const visualEditorExtension = StateField.define({
  create(state) {
    return buildVisualDecorations(state);
  },
  update(decorations, tr) {
    if (tr.docChanged || tr.selection) {
      return buildVisualDecorations(tr.state);
    }
    return decorations;
  },
  provide: (f) => EditorView.decorations.from(f),
});
