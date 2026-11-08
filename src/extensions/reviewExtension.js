/**
 * @fileoverview CodeMirror 6 Review & Track Changes Extension.
 *
 * Implements:
 * 1. Visual decorations for comments (`\odtcomment`), additions (`\odtadd`), and deletions (`\odtdel`).
 * 2. Popovers with Resolve, Accept, Reject, and Restore action buttons.
 * 3. Track Changes ("Suggesting" mode) transactionFilter intercepting inserts and deletes.
 * 4. Helper functions to insert comments and resolve/accept/reject review items.
 */

import { Annotation, EditorState, Facet, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { ySyncAnnotation } from 'y-codemirror.next';
import {
  ensureReviewMacrosInPreamble,
  hasReviewMacrosInPreamble,
  scanReviewItems,
} from '../utils/reviewMacroUtils.js';

/**
 * Annotation used to tag transactions initiated by review actions
 * (Accept, Reject, Resolve, Restore) so they bypass the track changes filter.
 */
export const reviewActionAnnotation = Annotation.define();

/**
 * Facet controlling whether Track Changes ("Suggesting" mode) is active.
 */
export const trackChangesFacet = Facet.define({
  combine: (values) => values[values.length - 1] ?? false,
});

/**
 * Facet providing the current collaborator's user metadata `{ name: string, email?: string }`.
 */
export const reviewUserFacet = Facet.define({
  combine: (values) => values[values.length - 1] ?? { name: 'Google Researcher', email: '' },
});

/**
 * Facet controlling whether raw LaTeX review macros should be exposed without visual decoration.
 */
export const showRawReviewMacrosFacet = Facet.define({
  combine: (values) => values[values.length - 1] ?? false,
});

/**
 * Formats a timestamp into a friendly human-readable date/time string.
 */
function formatReviewTime(timestamp) {
  if (!timestamp) return '';
  const num = Number(timestamp);
  const date = Number.isFinite(num) && num > 0 ? new Date(num) : new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/* ==========================================================================
   REVIEW WIDGETS
   ========================================================================== */

/**
 * Widget placed at the end of a comment, rendering a clickable comment badge with an action popover.
 */
class CommentPillWidget extends WidgetType {
  constructor(item) {
    super();
    this.item = item;
  }

  eq(other) {
    return (
      other.item.id === this.item.id &&
      other.item.comment === this.item.comment &&
      other.item.author === this.item.author &&
      other.item.fullFrom === this.item.fullFrom &&
      other.item.fullTo === this.item.fullTo
    );
  }

  ignoreEvent() {
    return true;
  }

  toDOM(view) {
    const wrap = document.createElement('span');
    wrap.className = 'cm-review-pill-wrap cm-review-comment-wrap';

    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'cm-review-comment-pill';
    pill.title = `Comment by ${this.item.author}: "${this.item.comment}" (Click to view/resolve)`;
    pill.innerHTML = `💬 <span class="cm-review-pill-author">${this.item.author}</span>`;

    // Popover
    const popover = document.createElement('div');
    popover.className = 'cm-review-popover cm-review-comment-popover';
    popover.style.display = 'none';

    popover.innerHTML = `
      <div class="cm-review-popover-header">
        <span class="cm-review-popover-author">${this.item.author}</span>
        <span class="cm-review-popover-time">${formatReviewTime(this.item.timestamp)}</span>
      </div>
      <div class="cm-review-popover-body">${this.item.comment || '(No comment text)'}</div>
      <div class="cm-review-popover-actions">
        <button type="button" class="cm-review-btn cm-review-btn-resolve">✓ Resolve</button>
      </div>
    `;

    const resolveBtn = popover.querySelector('.cm-review-btn-resolve');
    resolveBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Resolve: unwrap the macro and keep only the highlighted text
      view.dispatch({
        changes: {
          from: this.item.fullFrom,
          to: this.item.fullTo,
          insert: this.item.content,
        },
        annotations: [reviewActionAnnotation.of(true)],
      });
      view.focus();
    });

    let isOpen = false;
    pill.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      isOpen = !isOpen;
      popover.style.display = isOpen ? 'block' : 'none';
      if (isOpen) {
        // Close other open popovers in document
        document.querySelectorAll('.cm-review-popover').forEach((p) => {
          if (p !== popover) p.style.display = 'none';
        });
      }
    });

    // Close on click outside
    const handleDocumentClick = (e) => {
      if (isOpen && !wrap.contains(e.target)) {
        isOpen = false;
        popover.style.display = 'none';
      }
    };
    document.addEventListener('click', handleDocumentClick);

    wrap.appendChild(pill);
    wrap.appendChild(popover);
    return wrap;
  }
}

/**
 * Widget placed at the end of an addition, rendering a clickable badge with Accept and Reject buttons.
 */
class AddPillWidget extends WidgetType {
  constructor(item) {
    super();
    this.item = item;
  }

  eq(other) {
    return (
      other.item.id === this.item.id &&
      other.item.author === this.item.author &&
      other.item.fullFrom === this.item.fullFrom &&
      other.item.fullTo === this.item.fullTo
    );
  }

  ignoreEvent() {
    return true;
  }

  toDOM(view) {
    const wrap = document.createElement('span');
    wrap.className = 'cm-review-pill-wrap cm-review-add-wrap';

    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'cm-review-add-pill';
    pill.title = `Addition by ${this.item.author} (Click to accept/reject)`;
    pill.innerHTML = `➕ <span class="cm-review-pill-author">${this.item.author}</span>`;

    const popover = document.createElement('div');
    popover.className = 'cm-review-popover cm-review-add-popover';
    popover.style.display = 'none';

    popover.innerHTML = `
      <div class="cm-review-popover-header">
        <span class="cm-review-popover-tag add">Tracked Addition</span>
        <span class="cm-review-popover-author">${this.item.author}</span>
        <span class="cm-review-popover-time">${formatReviewTime(this.item.timestamp)}</span>
      </div>
      <div class="cm-review-popover-body"><mark class="cm-review-add-preview">${this.item.content}</mark></div>
      <div class="cm-review-popover-actions">
        <button type="button" class="cm-review-btn cm-review-btn-accept">✓ Accept</button>
        <button type="button" class="cm-review-btn cm-review-btn-reject">✗ Reject</button>
      </div>
    `;

    const acceptBtn = popover.querySelector('.cm-review-btn-accept');
    acceptBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      view.dispatch({
        changes: {
          from: this.item.fullFrom,
          to: this.item.fullTo,
          insert: this.item.content,
        },
        annotations: [reviewActionAnnotation.of(true)],
      });
      view.focus();
    });

    const rejectBtn = popover.querySelector('.cm-review-btn-reject');
    rejectBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      view.dispatch({
        changes: {
          from: this.item.fullFrom,
          to: this.item.fullTo,
          insert: '',
        },
        annotations: [reviewActionAnnotation.of(true)],
      });
      view.focus();
    });

    let isOpen = false;
    pill.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      isOpen = !isOpen;
      popover.style.display = isOpen ? 'block' : 'none';
      if (isOpen) {
        document.querySelectorAll('.cm-review-popover').forEach((p) => {
          if (p !== popover) p.style.display = 'none';
        });
      }
    });

    const handleDocumentClick = (e) => {
      if (isOpen && !wrap.contains(e.target)) {
        isOpen = false;
        popover.style.display = 'none';
      }
    };
    document.addEventListener('click', handleDocumentClick);

    wrap.appendChild(pill);
    wrap.appendChild(popover);
    return wrap;
  }
}

/**
 * Widget replacing an `\odtdel{...}{...}` macro, rendering the deleted text with strikethrough styling
 * and an interactive popover with "Accept Deletion" and "Reject / Restore" actions.
 */
class DeletionWidget extends WidgetType {
  constructor(item) {
    super();
    this.item = item;
  }

  eq(other) {
    return (
      other.item.id === this.item.id &&
      other.item.content === this.item.content &&
      other.item.author === this.item.author &&
      other.item.fullFrom === this.item.fullFrom &&
      other.item.fullTo === this.item.fullTo
    );
  }

  ignoreEvent() {
    return true;
  }

  toDOM(view) {
    const wrap = document.createElement('span');
    wrap.className = 'cm-review-pill-wrap cm-review-del-wrap';

    const badge = document.createElement('span');
    badge.className = 'cm-review-del-badge';
    badge.title = `Deleted by ${this.item.author} (Click to accept/restore)`;
    badge.innerHTML = `<del class="cm-review-del-text">${this.item.content}</del> <span class="cm-review-del-author">(${this.item.author})</span>`;

    const popover = document.createElement('div');
    popover.className = 'cm-review-popover cm-review-del-popover';
    popover.style.display = 'none';

    popover.innerHTML = `
      <div class="cm-review-popover-header">
        <span class="cm-review-popover-tag del">Tracked Deletion</span>
        <span class="cm-review-popover-author">${this.item.author}</span>
        <span class="cm-review-popover-time">${formatReviewTime(this.item.timestamp)}</span>
      </div>
      <div class="cm-review-popover-body"><del class="cm-review-del-preview">${this.item.content}</del></div>
      <div class="cm-review-popover-actions">
        <button type="button" class="cm-review-btn cm-review-btn-accept-del">✓ Accept Deletion</button>
        <button type="button" class="cm-review-btn cm-review-btn-restore">↺ Restore</button>
      </div>
    `;

    const acceptDelBtn = popover.querySelector('.cm-review-btn-accept-del');
    acceptDelBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      view.dispatch({
        changes: {
          from: this.item.fullFrom,
          to: this.item.fullTo,
          insert: '',
        },
        annotations: [reviewActionAnnotation.of(true)],
      });
      view.focus();
    });

    const restoreBtn = popover.querySelector('.cm-review-btn-restore');
    restoreBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      view.dispatch({
        changes: {
          from: this.item.fullFrom,
          to: this.item.fullTo,
          insert: this.item.content,
        },
        annotations: [reviewActionAnnotation.of(true)],
      });
      view.focus();
    });

    let isOpen = false;
    badge.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      isOpen = !isOpen;
      popover.style.display = isOpen ? 'block' : 'none';
      if (isOpen) {
        document.querySelectorAll('.cm-review-popover').forEach((p) => {
          if (p !== popover) p.style.display = 'none';
        });
      }
    });

    const handleDocumentClick = (e) => {
      if (isOpen && !wrap.contains(e.target)) {
        isOpen = false;
        popover.style.display = 'none';
      }
    };
    document.addEventListener('click', handleDocumentClick);

    wrap.appendChild(badge);
    wrap.appendChild(popover);
    return wrap;
  }
}

/* ==========================================================================
   DECORATION BUILDER
   ========================================================================== */

/**
 * Builds the visual decorations for review macros.
 *
 * @param {import('@codemirror/state').EditorState} state
 * @returns {import('@codemirror/view').DecorationSet}
 */
function buildReviewDecorations(state) {
  if (state.facet(showRawReviewMacrosFacet)) {
    return Decoration.none;
  }

  const docText = state.doc.toString();
  if (!docText) return Decoration.none;

  const items = scanReviewItems(docText);
  if (items.length === 0) return Decoration.none;

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

  for (const item of items) {
    if (isOverlappingOccupied(item.fullFrom, item.fullTo)) {
      continue;
    }

    if (item.type === 'comment') {
      // 1. Hide prefix: \odtcomment{meta}{comment}{
      rawDecorations.push({
        from: item.fullFrom,
        to: item.contentFrom,
        deco: Decoration.replace({}),
      });
      markOccupied(item.fullFrom, item.contentFrom);

      // 2. Mark highlighted manuscript content
      if (item.contentTo > item.contentFrom) {
        rawDecorations.push({
          from: item.contentFrom,
          to: item.contentTo,
          deco: Decoration.mark({ class: 'cm-review-comment-highlight' }),
        });
      }

      // 3. Replace closing '}' with interactive CommentPillWidget
      rawDecorations.push({
        from: item.contentTo,
        to: item.fullTo,
        deco: Decoration.replace({
          widget: new CommentPillWidget(item),
        }),
      });
      markOccupied(item.contentTo, item.fullTo);
    } else if (item.type === 'add') {
      // 1. Hide prefix: \odtadd{meta}{
      rawDecorations.push({
        from: item.fullFrom,
        to: item.contentFrom,
        deco: Decoration.replace({}),
      });
      markOccupied(item.fullFrom, item.contentFrom);

      // 2. Mark addition content
      if (item.contentTo > item.contentFrom) {
        rawDecorations.push({
          from: item.contentFrom,
          to: item.contentTo,
          deco: Decoration.mark({ class: 'cm-review-add-highlight' }),
        });
      }

      // 3. Replace closing '}' with interactive AddPillWidget
      rawDecorations.push({
        from: item.contentTo,
        to: item.fullTo,
        deco: Decoration.replace({
          widget: new AddPillWidget(item),
        }),
      });
      markOccupied(item.contentTo, item.fullTo);
    } else if (item.type === 'del') {
      // Replace the entire deletion macro with the DeletionWidget
      rawDecorations.push({
        from: item.fullFrom,
        to: item.fullTo,
        deco: Decoration.replace({
          widget: new DeletionWidget(item),
        }),
      });
      markOccupied(item.fullFrom, item.fullTo);
    }
  }

  if (rawDecorations.length === 0) {
    return Decoration.none;
  }

  rawDecorations.sort((a, b) => a.from - b.from || a.to - b.to);
  const ranges = rawDecorations.map((d) => d.deco.range(d.from, d.to));
  return Decoration.set(ranges, true);
}

/**
 * StateField that manages review macro visual decorations.
 */
export const reviewStateField = StateField.define({
  create(state) {
    return buildReviewDecorations(state);
  },
  update(decorations, tr) {
    if (tr.docChanged || tr.selection) {
      return buildReviewDecorations(tr.state);
    }
    return decorations;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/* ==========================================================================
   TRACK CHANGES TRANSACTION FILTER ("SUGGESTING" MODE)
   ========================================================================== */

/**
 * Intercepts document transactions when Track Changes ("Suggesting" mode) is active:
 * - Typing wraps newly inserted text in `\odtadd{Author|Timestamp|ID}{text}`, or merges into
 *   an existing `\odtadd` block by the same author if typing inside one.
 * - Deletions wrap the deleted range in `\odtdel{Author|Timestamp|ID}{deletedText}`.
 */
export const trackChangesFilter = EditorState.transactionFilter.of((tr) => {
  // Allow review actions or transactions without changes
  if (!tr.docChanged || tr.annotation(reviewActionAnnotation)) {
    return tr;
  }

  // Do not intercept remote Yjs sync changes or undo/redo events
  if (
    tr.annotation(ySyncAnnotation) ||
    (typeof tr.isUserEvent === 'function' &&
      (tr.isUserEvent('undo') || tr.isUserEvent('redo')))
  ) {
    return tr;
  }

  // Check if Track Changes mode is enabled
  const isTracking = tr.state.facet(trackChangesFacet);
  if (!isTracking) {
    return tr;
  }

  const user = tr.state.facet(reviewUserFacet) || { name: 'Google Researcher', email: '' };
  const authorName = user.name || user.email || 'Google Researcher';
  const startDoc = tr.startState.doc;
  const startDocText = startDoc.toString();

  // Scan existing review items to detect if change is already inside an addition by the same author
  const existingItems = scanReviewItems(startDocText);

  // 1. Check if all changes are strictly inside an existing addition by the current author
  let allInsideEnclosing = true;
  let anyChange = false;

  tr.changes.iterChanges((fromA, toA) => {
    anyChange = true;
    const enclosingAdd = existingItems.find(
      (it) =>
        it.type === 'add' &&
        it.author === authorName &&
        fromA >= it.contentFrom &&
        toA <= it.contentTo
    );
    if (!enclosingAdd) {
      allInsideEnclosing = false;
    }
  });

  // If typing/editing naturally inside an existing addition, let the native transaction proceed!
  if (anyChange && allInsideEnclosing) {
    return tr;
  }

  const changes = [];
  let nextCursorPos = null;
  let preambleInjected = false;
  let preambleInsertPos = -1;
  let preambleInsertText = '';
  let firstChangeFrom = 0;

  const needPreamble = !hasReviewMacrosInPreamble(startDocText);

  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    firstChangeFrom = fromA;
    const insText = inserted.toString();

    // Check if this individual change is strictly inside an existing \odtadd by the same author
    const enclosingAdd = existingItems.find(
      (it) =>
        it.type === 'add' &&
        it.author === authorName &&
        fromA >= it.contentFrom &&
        toA <= it.contentTo
    );

    if (enclosingAdd) {
      // User is typing or backspacing directly inside their own addition; let it pass natively
      changes.push({ from: fromA, to: toA, insert: insText });
      nextCursorPos = fromA + insText.length;
      return;
    }

    const timestamp = Date.now();
    const id = `rev-${timestamp}-${Math.floor(Math.random() * 1000)}`;

    if (fromA === toA && insText.length > 0) {
      // Pure insertion -> wrap in \odtadd
      const macroPrefix = `\\odtadd{${authorName}|${timestamp}|${id}}{`;
      const macro = `${macroPrefix}${insText}}`;
      changes.push({ from: fromA, to: toA, insert: macro });
      // Keep cursor placed inside the braces, right after inserted text
      nextCursorPos = fromA + macroPrefix.length + insText.length;
    } else if (fromA < toA && insText.length === 0) {
      // Pure deletion -> prevent actual deletion, wrap in \odtdel
      const deletedContent = startDoc.sliceString(fromA, toA);
      // Skip if deleting empty spaces/newlines only
      if (!deletedContent.trim()) {
        changes.push({ from: fromA, to: toA, insert: '' });
        nextCursorPos = fromA;
      } else {
        const macro = `\\odtdel{${authorName}|${timestamp}|${id}}{${deletedContent}}`;
        changes.push({ from: fromA, to: toA, insert: macro });
        nextCursorPos = fromA;
      }
    } else if (fromA < toA && insText.length > 0) {
      // Replacement -> \odtdel + \odtadd
      const deletedContent = startDoc.sliceString(fromA, toA);
      const delMacro = deletedContent.trim()
        ? `\\odtdel{${authorName}|${timestamp}|${id}-del}{${deletedContent}}`
        : '';
      const addMacroPrefix = `\\odtadd{${authorName}|${timestamp}|${id}-add}{`;
      const addMacro = `${addMacroPrefix}${insText}}`;
      changes.push({ from: fromA, to: toA, insert: delMacro + addMacro });
      nextCursorPos = fromA + delMacro.length + addMacroPrefix.length + insText.length;
    }
  });

  if (changes.length === 0) {
    return tr;
  }

  if (needPreamble && !preambleInjected) {
    const preambleResult = ensureReviewMacrosInPreamble(startDocText);
    if (preambleResult.injected) {
      preambleInjected = true;
      preambleInsertPos = preambleResult.insertPos;
      preambleInsertText = preambleResult.insertText;
      changes.push({
        from: preambleInsertPos,
        to: preambleInsertPos,
        insert: preambleInsertText,
      });
      if (nextCursorPos !== null && preambleInsertPos <= firstChangeFrom) {
        nextCursorPos += preambleInsertText.length;
      }
    }
  }

  // Sort changes descending so positions remain valid
  changes.sort((a, b) => b.from - a.from);

  const spec = {
    changes,
    annotations: [reviewActionAnnotation.of(true)],
  };
  if (nextCursorPos !== null) {
    spec.selection = { anchor: nextCursorPos };
  }

  return spec;
});

/* ==========================================================================
   PUBLIC HELPER: INSERT COMMENT
   ========================================================================== */

/**
 * Inserts a comment on the currently selected text in the CodeMirror editor.
 *
 * @param {import('@codemirror/view').EditorView} view
 * @param {string} commentText The comment string entered by the user.
 * @param {{ name?: string }} [user] Current author info.
 * @returns {boolean} Whether the comment was successfully inserted.
 */
export function insertCommentInView(view, commentText, user = { name: 'Google Researcher', email: '' }) {
  if (!view || !commentText?.trim()) return false;

  const state = view.state;
  const docText = state.doc.toString();
  const selection = state.selection.main;
  let from = selection.from;
  let to = selection.to;

  // If selection is empty, select current word or default snippet
  if (from === to) {
    const word = state.wordAt(from);
    if (word) {
      from = word.from;
      to = word.to;
    } else {
      // Select 5 characters or place a placeholder
      to = Math.min(from + 1, docText.length);
    }
  }

  const selectedContent = docText.slice(from, to) || 'text';
  const authorName = user.name || user.email || 'Google Researcher';
  const timestamp = Date.now();
  const id = `c-${timestamp}`;

  const commentMacro = `\\odtcomment{${authorName}|${timestamp}|${id}}{${commentText.trim()}}{${selectedContent}}`;

  const changes = [{ from, to, insert: commentMacro }];

  // Auto-inject preamble if missing
  if (!hasReviewMacrosInPreamble(docText)) {
    const preambleResult = ensureReviewMacrosInPreamble(docText);
    if (preambleResult.injected) {
      changes.push({
        from: preambleResult.insertPos,
        to: preambleResult.insertPos,
        insert: preambleResult.insertText,
      });
    }
  }

  changes.sort((a, b) => b.from - a.from);

  view.dispatch({
    changes,
    annotations: [reviewActionAnnotation.of(true)],
  });
  view.focus();
  return true;
}

/**
 * Combined review extension bundle for CodeMirror 6.
 */
export const reviewExtension = [
  reviewStateField,
  trackChangesFilter,
];

