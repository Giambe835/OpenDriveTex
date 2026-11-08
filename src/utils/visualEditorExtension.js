/**
 * @fileoverview Overleaf-Style "Visual Editor" (WYSIWYM) Mode for CodeMirror 6.
 *
 * Uses a CodeMirror 6 `StateField` decoration provider + `katex` so that:
 * 1. Real-time Yjs CRDT (`Y.Text`) collaboration and remote awareness cursors continue
 *    to work identically underneath without altering the document text.
 * 2. Cursor-Aware Unfolding: Any construct where the user's cursor or selection is placed
 *    automatically unfolds to reveal the raw LaTeX source for editing.
 * 3. Supports:
 *    - Preamble Collapsing (`\documentclass ... \begin{document}`) into a compact banner.
 *    - Inline & Display Math (`$...$`, `$$...$$`, `\[...\]`, `\begin{equation}...\end{equation}`)
 *      rendered live with KaTeX.
 *    - Section Headings (`\title{...}`, `\section{...}`, `\subsection{...}`, `\subsubsection{...}`).
 *    - Rich Text Formatting (`\textbf{...}`, `\textit{...}`, `\emph{...}`, `\underline{...}`).
 *    - Citations (`\cite{...}`, `\citep{...}`, `\citet{...}`) as compact `[key]` pills.
 *    - List items (`\item`) as clean bullet points (`•`).
 */

import { StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import katex from 'katex';
import 'katex/dist/katex.min.css';

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
    span.textContent = `Document Preamble (${this.lineCount} lines folded — Click to expand)`;
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
 * Builds the complete set of Overleaf-style Visual Editor decorations for the document.
 *
 * @param {import('@codemirror/state').EditorState} state
 * @returns {import('@codemirror/view').DecorationSet}
 */
function buildVisualDecorations(state) {
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

  // 1. Preamble Collapsing: \documentclass ... \begin{document}
  const beginDocMatch = /\\begin\{document\}/.exec(docText);
  const docClassMatch = /\\documentclass\b/.exec(docText);
  if (docClassMatch && beginDocMatch && beginDocMatch.index > docClassMatch.index) {
    const preambleFrom = docClassMatch.index;
    const preambleTo = beginDocMatch.index + beginDocMatch[0].length;
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
  }

  // Also hide \end{document} when cursor is not touching it
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

  // 2. Display Math Environments: \begin{equation*?}...\end{equation*?}, \begin{align*?}...\end{align*?}, $$...$$, \[...\]
  const displayMathRegex =
    /\\begin\{(equation\*?|align\*?|gather\*?)\}([\s\S]*?)\\end\{\1\}|\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]/g;
  let match;
  while ((match = displayMathRegex.exec(docText)) !== null) {
    const from = match.index;
    const to = from + match[0].length;
    if (isOverlappingOccupied(from, to) || isSelectionTouching(state, from, to)) {
      continue;
    }
    const mathInner = match[2] ?? match[3] ?? match[4] ?? '';
    rawDecorations.push({
      from,
      to,
      deco: Decoration.replace({
        widget: new KatexMathWidget(mathInner, true, from + 1),
      }),
    });
    markOccupied(from, to);
  }

  // 3. Inline Math: $...$ (single line, non-empty, avoiding escaped \$)
  const inlineMathRegex = /(?<!\\|\$)\$(?!\$)([^$\n]+?)(?<!\\)\$/g;
  while ((match = inlineMathRegex.exec(docText)) !== null) {
    const from = match.index;
    const to = from + match[0].length;
    if (isOverlappingOccupied(from, to) || isSelectionTouching(state, from, to)) {
      continue;
    }
    const mathInner = match[1];
    rawDecorations.push({
      from,
      to,
      deco: Decoration.replace({
        widget: new KatexMathWidget(mathInner, false, from + 1),
      }),
    });
    markOccupied(from, to);
  }

  // 4. Section Headings: \title{...}, \section*{...}, \section{...}, \subsection{...}, \subsubsection{...}
  const headingRegex = /\\(title|section\*?|subsection\*?|subsubsection\*?)\{([^{}\n]+)\}/g;
  while ((match = headingRegex.exec(docText)) !== null) {
    const fullFrom = match.index;
    const fullTo = fullFrom + match[0].length;
    if (isOverlappingOccupied(fullFrom, fullTo) || isSelectionTouching(state, fullFrom, fullTo)) {
      continue;
    }
    const cmd = match[1];
    const prefixLen = cmd.length + 2; // e.g. "\section{".length
    const textFrom = fullFrom + prefixLen;
    const textTo = fullTo - 1;
    if (textTo <= textFrom) continue;

    const headingClass =
      cmd === 'title'
        ? 'cm-visual-title'
        : cmd.startsWith('section')
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

  // 5. Text Formatting: \textbf{...}, \textit{...}, \emph{...}, \underline{...}
  const formatRegex = /\\(textbf|textit|emph|underline)\{([^{}\n]+)\}/g;
  while ((match = formatRegex.exec(docText)) !== null) {
    const fullFrom = match.index;
    const fullTo = fullFrom + match[0].length;
    if (isOverlappingOccupied(fullFrom, fullTo) || isSelectionTouching(state, fullFrom, fullTo)) {
      continue;
    }
    const cmd = match[1];
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

  // 6. Citations: \cite{...}, \citep{...}, \citet{...}
  const citeRegex = /\\cite[pt]?\{([^{}\n]+)\}/g;
  while ((match = citeRegex.exec(docText)) !== null) {
    const from = match.index;
    const to = from + match[0].length;
    if (isOverlappingOccupied(from, to) || isSelectionTouching(state, from, to)) {
      continue;
    }
    const keys = match[1].trim();
    rawDecorations.push({
      from,
      to,
      deco: Decoration.replace({
        widget: new CitationPillWidget(keys, from + 1),
      }),
    });
    markOccupied(from, to);
  }

  // 7. List Items: \item
  const itemRegex = /\\item\b/g;
  while ((match = itemRegex.exec(docText)) !== null) {
    const from = match.index;
    const to = from + match[0].length;
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

