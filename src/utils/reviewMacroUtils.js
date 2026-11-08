/**
 * @fileoverview Utility functions for OpenDriveTeX Review Mode & Track Changes.
 *
 * Implements native LaTeX macro parsing, auto-preamble injection,
 * balanced-brace scanning, submission sanitization, and clean ZIP bundling.
 */

import JSZip from 'jszip';

export const REVIEW_MACROS_PREAMBLE = `% --- OPENDRIVETEX REVIEW MACROS ---
\\providecommand{\\odtcomment}[3]{#3}
\\providecommand{\\odtadd}[2]{#2}
\\providecommand{\\odtdel}[2]{}
% --- END OPENDRIVETEX REVIEW MACROS ---
`;

/**
 * Checks whether the review macros preamble block exists in the document text.
 *
 * @param {string} docText
 * @returns {boolean}
 */
export function hasReviewMacrosInPreamble(docText) {
  if (!docText) return false;
  return (
    docText.includes('% --- OPENDRIVETEX REVIEW MACROS ---') ||
    (docText.includes('\\providecommand{\\odtcomment}') &&
      docText.includes('\\providecommand{\\odtadd}') &&
      docText.includes('\\providecommand{\\odtdel}'))
  );
}

/**
 * Ensures the 3 silent review macro definitions are injected right before `\begin{document}`.
 *
 * @param {string} docText
 * @returns {{ docText: string, injected: boolean, insertPos: number, insertText: string }}
 */
export function ensureReviewMacrosInPreamble(docText) {
  if (!docText || hasReviewMacrosInPreamble(docText)) {
    return { docText: docText || '', injected: false, insertPos: -1, insertText: '' };
  }

  const beginDocMatch = /\\begin\{document\}/.exec(docText);
  if (beginDocMatch) {
    const insertPos = beginDocMatch.index;
    const insertText = REVIEW_MACROS_PREAMBLE + '\n';
    const updated = docText.slice(0, insertPos) + insertText + docText.slice(insertPos);
    return { docText: updated, injected: true, insertPos, insertText };
  }

  // Fallback: prepend to the top of the file
  const insertText = REVIEW_MACROS_PREAMBLE + '\n\n';
  return { docText: insertText + docText, injected: true, insertPos: 0, insertText };
}

/**
 * Robust balanced curly-brace scanner for LaTeX macros.
 *
 * @param {string} text
 * @param {number} startPos Position of opening '{'
 * @returns {{ inner: string, start: number, end: number } | null}
 */
export function parseBalancedBrace(text, startPos) {
  if (!text || startPos < 0 || startPos >= text.length || text[startPos] !== '{') {
    return null;
  }
  let depth = 1;
  let pos = startPos + 1;
  while (pos < text.length && depth > 0) {
    if (text[pos] === '\\') {
      pos += 2; // skip escaped character (e.g. \{ or \})
      continue;
    }
    if (text[pos] === '{') {
      depth++;
    } else if (text[pos] === '}') {
      depth--;
    }
    pos++;
  }
  if (depth !== 0) return null;
  return {
    inner: text.slice(startPos + 1, pos - 1),
    start: startPos,
    end: pos, // exclusive index right after closing '}'
  };
}

/**
 * Scans a LaTeX document for all OpenDriveTeX review items (`\odtcomment`, `\odtadd`, `\odtdel`).
 *
 * @param {string} text
 * @returns {Array<{
 *   id: string,
 *   type: 'comment' | 'add' | 'del',
 *   author: string,
 *   timestamp: number | string,
 *   fullFrom: number,
 *   fullTo: number,
 *   content: string,
 *   contentFrom: number,
 *   contentTo: number,
 *   comment?: string,
 *   meta: string,
 *   rawMacro: string
 * }>}
 */
export function scanReviewItems(text) {
  if (!text) return [];
  const items = [];
  const regex = /\\(odtcomment|odtadd|odtdel)\b/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const cmd = match[1];
    const fullFrom = match.index;
    let pos = fullFrom + match[0].length;
    while (pos < text.length && /\s/.test(text[pos])) pos++;

    if (cmd === 'odtcomment') {
      const arg1 = parseBalancedBrace(text, pos);
      if (!arg1) continue;
      pos = arg1.end;
      while (pos < text.length && /\s/.test(text[pos])) pos++;
      const arg2 = parseBalancedBrace(text, pos);
      if (!arg2) continue;
      pos = arg2.end;
      while (pos < text.length && /\s/.test(text[pos])) pos++;
      const arg3 = parseBalancedBrace(text, pos);
      if (!arg3) continue;

      const metaParts = (arg1.inner || '').split('|');
      const author = metaParts[0] || 'Guest';
      const timestamp = metaParts[1] || Date.now();
      const id = metaParts[2] || `c-${fullFrom}`;

      items.push({
        id,
        type: 'comment',
        author,
        timestamp,
        fullFrom,
        fullTo: arg3.end,
        content: arg3.inner,
        contentFrom: arg3.start + 1,
        contentTo: arg3.end - 1,
        comment: arg2.inner,
        meta: arg1.inner,
        rawMacro: text.slice(fullFrom, arg3.end),
      });
    } else {
      const arg1 = parseBalancedBrace(text, pos);
      if (!arg1) continue;
      pos = arg1.end;
      while (pos < text.length && /\s/.test(text[pos])) pos++;
      const arg2 = parseBalancedBrace(text, pos);
      if (!arg2) continue;

      const metaParts = (arg1.inner || '').split('|');
      const author = metaParts[0] || 'Guest';
      const timestamp = metaParts[1] || Date.now();
      const id = metaParts[2] || `${cmd === 'odtadd' ? 'a' : 'd'}-${fullFrom}`;

      items.push({
        id,
        type: cmd === 'odtadd' ? 'add' : 'del',
        author,
        timestamp,
        fullFrom,
        fullTo: arg2.end,
        content: arg2.inner,
        contentFrom: arg2.start + 1,
        contentTo: arg2.end - 1,
        meta: arg1.inner,
        rawMacro: text.slice(fullFrom, arg2.end),
      });
    }
  }

  return items;
}

/**
 * Counts the pending review items in a document.
 *
 * @param {string} text
 * @returns {{ comments: number, additions: number, deletions: number, total: number }}
 */
export function countReviewItems(text) {
  const items = scanReviewItems(text);
  let comments = 0;
  let additions = 0;
  let deletions = 0;
  for (const item of items) {
    if (item.type === 'comment') comments++;
    else if (item.type === 'add') additions++;
    else if (item.type === 'del') deletions++;
  }
  return {
    comments,
    additions,
    deletions,
    total: items.length,
  };
}

/**
 * Cleanly sanitizes a LaTeX document string for journal submission:
 * 1. Strips the `% --- OPENDRIVETEX REVIEW MACROS ---` preamble block.
 * 2. Unwraps `\odtcomment{meta}{comment}{content}` -> `content`.
 * 3. Unwraps `\odtadd{meta}{content}` -> `content`.
 * 4. Removes `\odtdel{meta}{content}` -> `""`.
 *
 * @param {string} text
 * @returns {string} Sanitized LaTeX code ready for journal submission.
 */
export function sanitizeTexForSubmission(text) {
  if (!text) return '';
  let result = text;

  // 1. Remove review macros preamble block and standalone declarations
  result = result.replace(
    /% --- OPENDRIVETEX REVIEW MACROS ---[\s\S]*?% --- END OPENDRIVETEX REVIEW MACROS ---[\r\n]*/g,
    ''
  );
  result = result.replace(
    /\\providecommand\{\\odt(comment|add|del)\}[^\r\n]*[\r\n]*/g,
    ''
  );

  // 2. Iteratively process review items from bottom to top until all macros are unpacked
  let changed = true;
  let passes = 0;

  while (changed && passes < 10) {
    changed = false;
    passes++;
    const items = scanReviewItems(result);

    if (items.length > 0) {
      changed = true;
      // Sort descending by position so edits do not shift earlier offsets
      items.sort((a, b) => b.fullFrom - a.fullFrom);

      for (const item of items) {
        let replacement = '';
        if (item.type === 'comment' || item.type === 'add') {
          replacement = item.content;
        } else if (item.type === 'del') {
          replacement = '';
        }
        result = result.slice(0, item.fullFrom) + replacement + result.slice(item.fullTo);
      }
    }
  }

  return result;
}

/**
 * Creates a clean submission ZIP archive containing all project files
 * with all `.tex` files sanitized and binary assets intact.
 *
 * @param {string} projectName Name of the project/folder.
 * @param {string} mainFileName The main LaTeX file name (e.g. main.tex).
 * @param {string} mainTexContent Content of the main LaTeX file.
 * @param {any} auxFilesMap Shared auxiliary files map.
 * @returns {Promise<Blob>} The generated ZIP Blob.
 */
export async function createCleanSubmissionZipBlob(
  projectName,
  mainFileName,
  mainTexContent,
  auxFilesMap
) {
  const zip = new JSZip();

  // 1. Add sanitized main .tex file
  const cleanMainTex = sanitizeTexForSubmission(mainTexContent);
  zip.file(mainFileName || 'main.tex', cleanMainTex);

  // 2. Add all auxiliary files
  if (auxFilesMap) {
    const iterate = (fn) => {
      if (typeof auxFilesMap.forEach === 'function') {
        auxFilesMap.forEach(fn);
      } else {
        Object.entries(auxFilesMap).forEach(([k, v]) => fn(v, k));
      }
    };

    iterate((entry, path) => {
      if (!path || path === '.' || path === mainFileName) return;
      const cleanPath = path.replace(/^\.?\//, '').trim();
      if (!entry) return;

      if (cleanPath.endsWith('.tex')) {
        let tex = '';
        if (typeof entry.content === 'string') {
          tex = entry.content;
        } else if (entry.content instanceof Uint8Array) {
          tex = new TextDecoder('utf-8').decode(entry.content);
        }
        zip.file(cleanPath, sanitizeTexForSubmission(tex));
      } else if (typeof entry.content === 'string') {
        zip.file(cleanPath, entry.content);
      } else if (entry.content instanceof Uint8Array || entry.content instanceof ArrayBuffer) {
        zip.file(cleanPath, entry.content);
      } else if (
        Array.isArray(entry.content) ||
        (typeof entry.content === 'object' && entry.content !== null)
      ) {
        zip.file(cleanPath, new Uint8Array(Object.values(entry.content)));
      }
    });
  }

  return await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

/**
 * Triggers a browser file download for a Blob or text.
 *
 * @param {Blob | string} content
 * @param {string} filename
 * @param {string} mimeType
 */
export function triggerFileDownload(content, filename, mimeType = 'text/plain') {
  const blob =
    content instanceof Blob ? content : new Blob([content], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
}

