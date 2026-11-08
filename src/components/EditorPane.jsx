/**
 * @fileoverview CodeMirror 6 LaTeX & BibTeX Editor Pane strictly bound to Yjs (`Y.Text`).
 *
 * CRITICAL ARCHITECTURAL INVARIANT (Rule #2):
 * Never store or mirror the editor text content in React `useState`.
 * `Y.Doc` and `Y.Text` are the single source of truth. React mounts the
 * CodeMirror `EditorView` once per active file session via `useRef`.
 */

import React, { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { Compartment, EditorState } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection,
  crosshairCursor,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  foldGutter,
  indentOnInput,
  syntaxHighlighting,
  defaultHighlightStyle,
} from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';
import { latex } from 'codemirror-lang-latex';
import { yCollab } from 'y-codemirror.next';
import {
  FileCode2,
  BookOpen,
  Image as ImageIcon,
  Copy,
  Check,
  ArrowLeft,
  FilePlus2,
  Eye,
  Code2,
  PanelRightClose,
  PanelRightOpen,
} from 'lucide-react';
import { inferImageMimeType, isImageAssetFile } from '../services/driveService';
import { visualEditorExtension } from '../utils/visualEditorExtension';

/**
 * Formats a byte size into a human-readable string (`B`, `KB`, `MB`).
 *
 * @param {number} bytes
 * @returns {string}
 */
function formatFileSize(bytes) {
  if (typeof bytes !== 'number' || Number.isNaN(bytes) || bytes <= 0) {
    return '0 B';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Dark theme for CodeMirror 6 and remote Yjs Awareness cursor carets/labels.
 */
const scientificDarkEditorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      fontSize: '14px',
      backgroundColor: '#090d16',
    },
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily:
        '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      lineHeight: '1.65',
      paddingTop: '8px',
      paddingBottom: '48px',
    },
    '.cm-content': {
      caretColor: '#818cf8',
      paddingRight: '24px',
    },
    '.cm-gutters': {
      backgroundColor: '#090d16',
      color: '#475569',
      borderRight: '1px solid #1e293b',
      userSelect: 'none',
    },
    '.cm-activeLineGutter': {
      backgroundColor: '#111827',
      color: '#cbd5e1',
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(30, 41, 59, 0.45)',
    },
    '.cm-ySelectionInfo': {
      fontFamily: 'Inter, system-ui, sans-serif',
      fontSize: '11px',
      fontWeight: '600',
      padding: '1px 6px',
      borderRadius: '4px 4px 4px 0',
      color: '#ffffff',
      boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
      opacity: '1 !important',
      transition: 'opacity 0.2s ease',
    },
    '.cm-ySelectionCaretDot': {
      display: 'none',
    },
  },
  { dark: true }
);

/**
 * High-contrast academic Light Theme for CodeMirror 6.
 */
const scientificLightEditorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      fontSize: '14px',
      backgroundColor: '#ffffff',
      color: '#0f172a',
    },
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily:
        '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      lineHeight: '1.65',
      paddingTop: '8px',
      paddingBottom: '48px',
    },
    '.cm-content': {
      caretColor: '#4f46e5',
      paddingRight: '24px',
      color: '#0f172a',
    },
    '.cm-gutters': {
      backgroundColor: '#f8fafc',
      color: '#64748b',
      borderRight: '1px solid #e2e8f0',
      userSelect: 'none',
    },
    '.cm-activeLineGutter': {
      backgroundColor: '#e2e8f0',
      color: '#0f172a',
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(226, 232, 240, 0.55)',
    },
    '.cm-ySelectionInfo': {
      fontFamily: 'Inter, system-ui, sans-serif',
      fontSize: '11px',
      fontWeight: '600',
      padding: '1px 6px',
      borderRadius: '4px 4px 4px 0',
      color: '#ffffff',
      boxShadow: '0 2px 6px rgba(0,0,0,0.2)',
      opacity: '1 !important',
      transition: 'opacity 0.2s ease',
    },
    '.cm-ySelectionCaretDot': {
      display: 'none',
    },
  },
  { dark: false }
);

/**
 * CodeMirror 6 Editor Pane bound directly to Yjs (`Y.Text` and `provider.awareness`).
 */
export default function EditorPane({
  collabSession,
  activeFileName = 'main.tex',
  onCompileShortcut,
  onSaveShortcut,
  activeImageAsset = null,
  onBackToMainTex,
  onInsertFigureSnippet,
  theme = 'dark',
  isPdfVisible = true,
  onTogglePdfVisible,
}) {
  const editorContainerRef = useRef(null);
  const editorViewRef = useRef(null);
  const visualCompartmentRef = useRef(new Compartment());
  const themeCompartmentRef = useRef(new Compartment());

  const onCompileShortcutRef = useRef(onCompileShortcut);
  onCompileShortcutRef.current = onCompileShortcut;

  const onSaveShortcutRef = useRef(onSaveShortcut);
  onSaveShortcutRef.current = onSaveShortcut;

  // Local Visual Editor vs Code Editor mode (local per user)
  const [editorMode, setEditorMode] = useState(() => {
    try {
      return localStorage.getItem('opendrivetex_editor_mode') || 'code';
    } catch {
      return 'code';
    }
  });

  const handleSetEditorMode = (nextMode) => {
    setEditorMode(nextMode);
    try {
      localStorage.setItem('opendrivetex_editor_mode', nextMode);
    } catch {
      // Ignore storage errors
    }
  };

  const isImageView = Boolean(
    activeImageAsset || isImageAssetFile(activeFileName, activeImageAsset?.mimeType)
  );

  // Image Preview View UI state (for image metadata only; NEVER used for CodeMirror text!)
  const [imageObjectUrl, setImageObjectUrl] = useState(null);
  const [imageDimensions, setImageDimensions] = useState(null);
  const [imageByteSize, setImageByteSize] = useState(0);
  const [copiedSnippet, setCopiedSnippet] = useState(false);

  // Construct an Object URL whenever an image file is selected in the sidebar
  useEffect(() => {
    if (!isImageView) {
      setImageObjectUrl(null);
      setImageDimensions(null);
      setImageByteSize(0);
      return undefined;
    }

    const asset =
      activeImageAsset || collabSession?.auxFilesMap?.get(activeFileName) || null;
    if (!asset || asset.content === undefined || asset.content === null) {
      setImageObjectUrl(null);
      setImageDimensions(null);
      setImageByteSize(0);
      return undefined;
    }

    const mimeType = inferImageMimeType(activeFileName, asset.mimeType);
    const rawContent = asset.content;
    let blob = null;
    let computedBytes = Number(asset.size) || 0;

    if (rawContent instanceof Uint8Array) {
      blob = new Blob([rawContent], { type: mimeType });
      computedBytes = computedBytes || rawContent.byteLength;
    } else if (rawContent instanceof ArrayBuffer) {
      const arr = new Uint8Array(rawContent);
      blob = new Blob([arr], { type: mimeType });
      computedBytes = computedBytes || arr.byteLength;
    } else if (ArrayBuffer.isView(rawContent)) {
      const arr = new Uint8Array(
        rawContent.buffer,
        rawContent.byteOffset,
        rawContent.byteLength
      );
      blob = new Blob([arr], { type: mimeType });
      computedBytes = computedBytes || arr.byteLength;
    } else if (Array.isArray(rawContent)) {
      const arr = new Uint8Array(rawContent);
      blob = new Blob([arr], { type: mimeType });
      computedBytes = computedBytes || arr.byteLength;
    } else if (typeof rawContent === 'object' && rawContent !== null) {
      const values = Object.values(rawContent);
      const arr = new Uint8Array(values);
      blob = new Blob([arr], { type: mimeType });
      computedBytes = computedBytes || arr.byteLength;
    } else if (typeof rawContent === 'string') {
      if (rawContent.startsWith('data:image/')) {
        setImageObjectUrl(rawContent);
        setImageByteSize(computedBytes || rawContent.length);
        return undefined;
      }
      if (mimeType === 'image/svg+xml' || rawContent.trim().startsWith('<svg')) {
        blob = new Blob([rawContent], { type: 'image/svg+xml' });
        computedBytes = computedBytes || rawContent.length;
      } else {
        const placeholderSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">
          <rect width="640" height="400" fill="#0f172a"/>
          <rect x="24" y="24" width="592" height="352" rx="12" fill="#1e293b" stroke="#6366f1" stroke-width="2" stroke-dasharray="8 6"/>
          <text x="320" y="185" fill="#e2e8f0" font-family="monospace" font-size="20" text-anchor="middle">${activeFileName}</text>
          <text x="320" y="220" fill="#94a3b8" font-family="sans-serif" font-size="14" text-anchor="middle">MEMFS Figure Asset</text>
        </svg>`;
        blob = new Blob([placeholderSvg], { type: 'image/svg+xml' });
        computedBytes = computedBytes || rawContent.length;
      }
    }

    if (!blob) {
      setImageObjectUrl(null);
      return undefined;
    }

    const url = URL.createObjectURL(blob);
    setImageObjectUrl(url);
    setImageByteSize(computedBytes || blob.size);
    setImageDimensions(null);

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [isImageView, activeFileName, activeImageAsset, collabSession]);

  // Mount CodeMirror 6 ONLY when viewing a text file (.tex, .bib, .cls, .sty, .txt)
  useEffect(() => {
    if (isImageView || !collabSession || !editorContainerRef.current) {
      return undefined;
    }

    const { ytext, getYTextForFile, provider } = collabSession;
    const targetYText = getYTextForFile ? getYTextForFile(activeFileName) : ytext;

    // Scoped Yjs UndoManager so each collaborator only undoes their own transactions
    const undoManager = new Y.UndoManager(targetYText);

    const isTexFile = activeFileName.endsWith('.tex');
    const initialVisualExt =
      editorMode === 'visual' && isTexFile ? visualEditorExtension : [];
    const initialThemeExt =
      theme === 'light'
        ? [scientificLightEditorTheme]
        : [oneDark, scientificDarkEditorTheme];

    const state = EditorState.create({
      doc: targetYText.toString(),
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        foldGutter(),
        drawSelection(),
        rectangularSelection(),
        crosshairCursor(),
        indentOnInput(),
        bracketMatching(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        latex(),
        themeCompartmentRef.current.of(initialThemeExt),
        visualCompartmentRef.current.of(initialVisualExt),
        EditorView.lineWrapping,
        keymap.of([
          {
            key: 'Mod-Enter',
            run: () => {
              if (onCompileShortcutRef.current) {
                onCompileShortcutRef.current();
                return true;
              }
              return false;
            },
          },
          {
            key: 'Mod-s',
            run: () => {
              if (onSaveShortcutRef.current) {
                onSaveShortcutRef.current();
                return true;
              }
              return false;
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        // Bind the active file's Y.Text and Yjs Awareness directly to CodeMirror 6
        yCollab(targetYText, provider.awareness, { undoManager }),
      ],
    });

    const view = new EditorView({
      state,
      parent: editorContainerRef.current,
    });

    editorViewRef.current = view;

    return () => {
      undoManager.destroy();
      view.destroy();
      editorViewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collabSession, activeFileName, isImageView]);

  // Dynamically reconfigure Visual Editor mode without remounting CodeMirror
  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) return;
    const isTexFile = activeFileName.endsWith('.tex');
    view.dispatch({
      effects: visualCompartmentRef.current.reconfigure(
        editorMode === 'visual' && isTexFile ? visualEditorExtension : []
      ),
    });
  }, [editorMode, activeFileName]);

  // Dynamically reconfigure Dark / Light theme in CodeMirror without remounting
  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartmentRef.current.reconfigure(
        theme === 'light'
          ? [scientificLightEditorTheme]
          : [oneDark, scientificDarkEditorTheme]
      ),
    });
  }, [theme]);

  const handleCopyIncludeGraphicsSnippet = async () => {
    const cleanLabel = activeFileName
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_');
    const snippet = `\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\textwidth]{${activeFileName}}\n  \\caption{${activeFileName}}\n  \\label{fig:${cleanLabel}}\n\\end{figure}`;
    try {
      await navigator.clipboard.writeText(snippet);
      setCopiedSnippet(true);
      window.setTimeout(() => setCopiedSnippet(false), 2000);
    } catch {
      // Ignore clipboard permission errors
    }
  };

  if (isImageView) {
    return (
      <section
        className="flex flex-col h-full w-full bg-[#090d16] overflow-hidden select-none"
        aria-label="Image Asset Preview"
        data-testid="image-preview-pane"
      >
        {/* Top Bar for Image Preview View */}
        <div className="flex items-center justify-between px-4 h-9 bg-slate-900/90 border-b border-slate-800/80 text-xs shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <ImageIcon className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
            <span className="font-mono font-medium text-slate-200 truncate">
              {activeFileName}
            </span>
            <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-cyan-500/10 text-cyan-300 border border-cyan-500/25 shrink-0">
              Image Preview
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onBackToMainTex && onBackToMainTex()}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-[11px] font-medium transition-colors cursor-pointer"
              data-testid="back-to-main-tex-button"
            >
              <ArrowLeft className="w-3 h-3 text-indigo-400" />
              <span>Back to main.tex</span>
            </button>
          </div>
        </div>

        {/* Center Checkerboard Stage */}
        <div
          className="flex-1 flex flex-col items-center justify-center p-6 overflow-auto relative"
          style={{
            backgroundColor: theme === 'light' ? '#f1f5f9' : '#0b1120',
            backgroundImage:
              theme === 'light'
                ? 'linear-gradient(45deg, #e2e8f0 25%, transparent 25%), linear-gradient(-45deg, #e2e8f0 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e2e8f0 75%), linear-gradient(-45deg, transparent 75%, #e2e8f0 75%)'
                : 'linear-gradient(45deg, #131c31 25%, transparent 25%), linear-gradient(-45deg, #131c31 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #131c31 75%), linear-gradient(-45deg, transparent 75%, #131c31 75%)',
            backgroundSize: '24px 24px',
            backgroundPosition: '0 0, 0 12px, 12px -12px, -12px 0',
          }}
        >
          {imageObjectUrl ? (
            <div className="max-w-full max-h-[65vh] p-3 rounded-xl bg-slate-950/75 border border-slate-800/90 shadow-2xl flex items-center justify-center">
              <img
                src={imageObjectUrl}
                alt={activeFileName}
                onLoad={(e) => {
                  const target = e.currentTarget;
                  if (target.naturalWidth && target.naturalHeight) {
                    setImageDimensions({
                      width: target.naturalWidth,
                      height: target.naturalHeight,
                    });
                  }
                }}
                className="max-w-full max-h-[58vh] object-contain rounded"
              />
            </div>
          ) : (
            <div className="p-6 rounded-xl bg-slate-900/90 border border-slate-800 text-xs text-slate-400">
              Unable to render image preview for <code className="font-mono">{activeFileName}</code>.
            </div>
          )}
        </div>

        {/* Bottom Metadata & Action Bar */}
        <div className="p-4 bg-slate-900/95 border-t border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs shrink-0">
          <div className="flex flex-wrap items-center gap-3 text-slate-300">
            <div>
              <span className="text-slate-500 mr-1">File:</span>
              <code className="font-mono text-slate-100">{activeFileName}</code>
            </div>
            <div className="h-3.5 w-px bg-slate-800" />
            <div>
              <span className="text-slate-500 mr-1">Dimensions:</span>
              <span className="font-mono text-cyan-300">
                {imageDimensions
                  ? `${imageDimensions.width} × ${imageDimensions.height} px`
                  : 'Loading...'}
              </span>
            </div>
            <div className="h-3.5 w-px bg-slate-800" />
            <div>
              <span className="text-slate-500 mr-1">Size:</span>
              <span className="font-mono text-slate-200">
                {formatFileSize(imageByteSize)}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleCopyIncludeGraphicsSnippet}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-semibold transition-colors cursor-pointer shadow-sm shadow-indigo-600/20"
              data-testid="copy-includegraphics-button"
            >
              {copiedSnippet ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-300" />
                  <span>Copied \includegraphics Snippet!</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copy \includegraphics snippet</span>
                </>
              )}
            </button>

            {onInsertFigureSnippet && (
              <button
                type="button"
                onClick={() => onInsertFigureSnippet(activeFileName)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-slate-700 font-medium transition-colors cursor-pointer"
                title="Insert figure snippet directly into main.tex and return to editor"
              >
                <FilePlus2 className="w-3.5 h-3.5" />
                <span>Insert in main.tex</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => onBackToMainTex && onBackToMainTex()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-medium transition-colors cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Back to main.tex</span>
            </button>
          </div>
        </div>
      </section>
    );
  }

  const isBibFile = activeFileName.endsWith('.bib');
  const isStyOrCls = activeFileName.endsWith('.sty') || activeFileName.endsWith('.cls');
  const isTexFile = activeFileName.endsWith('.tex');

  return (
    <section
      className="flex flex-col h-full w-full bg-[#090d16] overflow-hidden"
      aria-label="LaTeX Source Editor"
    >
      {/* Editor Sub-Header: Active File Title & Code / Visual Editor Mode Switcher */}
      <div className="flex items-center justify-between px-4 h-9 bg-slate-900/90 border-b border-slate-800/80 text-xs select-none shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {isBibFile ? (
            <BookOpen className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          ) : (
            <FileCode2 className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
          )}
          <span className="font-mono font-medium text-slate-200 truncate">{activeFileName}</span>
          <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 shrink-0">
            {isBibFile ? 'BibTeX' : isStyOrCls ? 'Package' : 'LaTeX'}
          </span>
        </div>

        {/* Right Controls: Overleaf-Style Code Editor / Visual Editor Toggle + PDF Pane Toggle */}
        <div className="flex items-center gap-2 shrink-0">
          {isTexFile && (
            <div
              className="inline-flex items-center bg-slate-950/90 border border-slate-800 rounded-lg p-0.5"
              role="group"
              aria-label="Editor View Mode"
            >
              <button
                type="button"
                onClick={() => handleSetEditorMode('code')}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                  editorMode === 'code'
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                title="Raw LaTeX source code editor"
                data-testid="code-editor-mode-btn"
              >
                <Code2 className="w-3 h-3" />
                <span>Code Editor</span>
              </button>
              <button
                type="button"
                onClick={() => handleSetEditorMode('visual')}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                  editorMode === 'visual'
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                title="Overleaf-style Visual Editor with live KaTeX math and formatted headings"
                data-testid="visual-editor-mode-btn"
              >
                <Eye className="w-3 h-3" />
                <span>Visual Editor</span>
              </button>
            </div>
          )}

          {onTogglePdfVisible && (
            <button
              type="button"
              onClick={onTogglePdfVisible}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-800/80 hover:bg-slate-700 text-slate-300 border border-slate-700 text-[11px] font-medium transition-colors cursor-pointer"
              title={isPdfVisible ? 'Hide PDF preview pane' : 'Show PDF preview pane'}
              data-testid="toggle-pdf-pane-button"
            >
              {isPdfVisible ? (
                <>
                  <PanelRightClose className="w-3 h-3 text-cyan-400" />
                  <span className="hidden sm:inline">Hide PDF</span>
                </>
              ) : (
                <>
                  <PanelRightOpen className="w-3 h-3 text-cyan-400" />
                  <span className="hidden sm:inline">Show PDF</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* CodeMirror 6 Mount Container (Managed strictly via useRef, zero React state) */}
      <div
        ref={editorContainerRef}
        className="flex-1 w-full overflow-hidden relative"
        data-testid="codemirror-container"
      />
    </section>
  );
}
