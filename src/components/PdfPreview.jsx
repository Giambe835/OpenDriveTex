/**
 * @fileoverview Native `<iframe blob>` PDF Viewer & Compilation Log Inspector (`PdfPreview.jsx`).
 *
 * Responsibilities (Phase 2):
 * 1. Receives the compiled `Uint8Array` PDF buffer from the Web Worker.
 * 2. Converts it into a `Blob` (`application/pdf`) and generates an Object URL via `URL.createObjectURL`.
 * 3. Strictly revokes previous Object URLs via `URL.revokeObjectURL` to prevent browser memory leaks.
 * 4. Renders the PDF inside a full-height `<iframe src={pdfUrl} />`.
 * 5. Displays `stdout` / `stderr` compilation logs and structured LaTeX syntax errors.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  FileText,
  Terminal,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Download,
  ChevronUp,
  ChevronDown,
  Play,
  Clock,
  Cpu,
  XCircle,
} from 'lucide-react';

/**
 * PDF Preview & Compiler Diagnostics Pane.
 *
 * @param {Object} props
 * @param {Uint8Array | null} props.pdfBuffer - Compiled binary PDF buffer from `latex.worker.js`.
 * @param {'idle' | 'compiling' | 'success' | 'error'} props.compileStatus - Current compilation state.
 * @param {string} props.compileLogs - Combined `stdout`/`stderr` log transcript from the worker.
 * @param {string} props.compileStdout - Standard output stream from the worker.
 * @param {string} props.compileStderr - Standard error stream from the worker.
 * @param {Array<{ line: number | null, message: string, context: string }>} props.compileErrors - Structured LaTeX syntax errors.
 * @param {Array<{ line: number | null, message: string }>} props.compileWarnings - Structured LaTeX warnings.
 * @param {number | null} props.compileElapsedMs - Compilation duration in milliseconds.
 * @param {string} props.engineName - Active worker engine identifier.
 * @param {Function} props.onTriggerCompile - Callback to trigger compilation manually.
 */
export default function PdfPreview({
  pdfBuffer = null,
  compileStatus = 'idle',
  compileLogs = '',
  compileStdout = '',
  compileStderr = '',
  compileErrors = [],
  compileWarnings = [],
  compileElapsedMs = null,
  engineName = 'Wasm Worker Engine',
  onTriggerCompile,
  onFocusChange = null,
  iframeRef: externalIframeRef = null,
}) {
  const [pdfUrl, setPdfUrl] = useState(null);
  const [isLogDrawerOpen, setIsLogDrawerOpen] = useState(false);
  const [activeLogTab, setActiveLogTab] = useState('all'); // 'all' | 'stdout' | 'stderr'
  const internalIframeRef = useRef(null);

  /**
   * Tracks the active Blob Object URL so it is always revoked via `URL.revokeObjectURL`
   * before creating a new one or when the component unmounts.
   * @type {React.MutableRefObject<string | null>}
   */
  const previousObjectUrlRef = useRef(null);

  // Convert incoming Uint8Array PDF buffer to a Blob Object URL and revoke previous URLs
  useEffect(() => {
    if (!pdfBuffer || !(pdfBuffer instanceof Uint8Array) || pdfBuffer.byteLength === 0) {
      return undefined;
    }

    // Revoke the previous Object URL to prevent memory leaks
    if (previousObjectUrlRef.current) {
      URL.revokeObjectURL(previousObjectUrlRef.current);
      previousObjectUrlRef.current = null;
    }

    const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
    const nextObjectUrl = URL.createObjectURL(blob);

    previousObjectUrlRef.current = nextObjectUrl;
    setPdfUrl(nextObjectUrl);

    return () => {
      if (previousObjectUrlRef.current) {
        URL.revokeObjectURL(previousObjectUrlRef.current);
        previousObjectUrlRef.current = null;
      }
    };
  }, [pdfBuffer]);

  // Automatically open the diagnostics log drawer when compilation fails with a syntax error
  useEffect(() => {
    if (compileStatus === 'error') {
      setIsLogDrawerOpen(true);
    }
  }, [compileStatus]);

  const errorCount = compileErrors.length;
  const warningCount = compileWarnings.length;

  const displayedLogContent = () => {
    if (activeLogTab === 'stderr') {
      return compileStderr || 'No stderr output recorded.';
    }
    if (activeLogTab === 'stdout') {
      return compileStdout || 'No stdout output recorded.';
    }
    return compileLogs || 'No compilation logs recorded yet. Press Compile (Ctrl+Enter) to run.';
  };

  return (
    <section
      className="flex flex-col h-full w-full bg-slate-950 overflow-hidden select-none relative"
      aria-label="PDF Manuscript Preview and Compilation Logs"
    >
      {/* Top Preview Sub-Header */}
      <div className="flex items-center justify-between px-4 h-9 bg-slate-900/90 border-b border-slate-800/80 text-xs shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <FileText className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
          <span className="font-medium text-slate-200 truncate">Manuscript Output (PDF)</span>

          {compileStatus === 'compiling' && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 text-[10px] font-mono">
              <Loader2 className="w-3 h-3 animate-spin" />
              Compiling in Worker...
            </span>
          )}

          {compileStatus === 'success' && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[10px] font-mono">
              <CheckCircle2 className="w-3 h-3" />
              Ready {compileElapsedMs !== null ? `(${compileElapsedMs} ms)` : ''}
            </span>
          )}

          {compileStatus === 'error' && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-rose-500/15 text-rose-300 border border-rose-500/30 text-[10px] font-mono">
              <XCircle className="w-3 h-3" />
              {errorCount} {errorCount === 1 ? 'Syntax Error' : 'Syntax Errors'}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {pdfUrl && (
            <a
              href={pdfUrl}
              download="manuscript.pdf"
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors text-[11px]"
              title="Download compiled PDF"
            >
              <Download className="w-3 h-3 text-cyan-400" />
              <span className="hidden sm:inline">Download PDF</span>
            </a>
          )}

          <button
            type="button"
            onClick={() => setIsLogDrawerOpen((prev) => !prev)}
            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[11px] font-mono transition-colors ${
              isLogDrawerOpen
                ? 'bg-indigo-500/20 text-indigo-200 border-indigo-500/40'
                : errorCount > 0
                ? 'bg-rose-500/15 text-rose-300 border-rose-500/30 hover:bg-rose-500/25'
                : 'bg-slate-800/80 text-slate-300 border-slate-700/80 hover:bg-slate-800'
            }`}
            title="Toggle stdout/stderr compilation log viewer"
          >
            <Terminal className="w-3 h-3" />
            <span>Logs</span>
            {errorCount > 0 && (
              <span className="px-1 rounded bg-rose-500 text-white text-[10px] font-bold">
                {errorCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Main Content Area: Native PDF <iframe src={pdfUrl} /> or Initial Empty State */}
      <div className="flex-1 min-h-0 w-full relative bg-slate-900/50 flex flex-col">
        {/* Loading Overlay during compilation */}
        {compileStatus === 'compiling' && (
          <div className="absolute inset-0 z-10 bg-slate-950/60 backdrop-blur-[2px] flex flex-col items-center justify-center gap-3">
            <div className="px-5 py-4 rounded-xl bg-slate-900 border border-slate-800 shadow-2xl flex items-center gap-3">
              <Loader2 className="w-5 h-5 text-indigo-400 animate-spin" />
              <div className="text-left">
                <div className="text-xs font-semibold text-slate-100">
                  Compiling LaTeX in Web Worker...
                </div>
                <div className="text-[11px] text-slate-400 font-mono">
                  Main UI thread remains 100% non-blocking
                </div>
              </div>
            </div>
          </div>
        )}

        {pdfUrl ? (
          <iframe
            ref={(node) => {
              internalIframeRef.current = node;
              if (externalIframeRef) {
                externalIframeRef.current = node;
              }
            }}
            src={pdfUrl}
            title="Compiled LaTeX PDF Preview"
            className="w-full h-full flex-1 border-0 bg-slate-800"
            data-testid="pdf-preview-iframe"
            onMouseEnter={() => {
              if (onFocusChange) onFocusChange('pdf');
            }}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center overflow-y-auto">
            <div className="max-w-md w-full bg-slate-900/80 border border-slate-800/90 rounded-2xl p-6 shadow-xl space-y-4">
              <div className="w-12 h-12 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mx-auto text-indigo-400">
                <Cpu className="w-6 h-6" />
              </div>

              <div className="space-y-1.5">
                <h2 className="text-base font-semibold text-slate-100">
                  Web Worker LaTeX Engine Ready
                </h2>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Click <strong>Compile</strong> in the top bar or press{' '}
                  <kbd className="px-1.5 py-0.5 text-[10px] font-mono bg-slate-800 text-indigo-300 rounded border border-slate-700">
                    Ctrl+Enter
                  </kbd>{' '}
                  to compile your manuscript into a PDF inside the background Web Worker.
                </p>
              </div>

              {onTriggerCompile && (
                <button
                  type="button"
                  onClick={onTriggerCompile}
                  disabled={compileStatus === 'compiling'}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/25 transition-all cursor-pointer"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>Compile Manuscript Now</span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Collapsible Diagnostic Log Viewer Drawer (stdout / stderr & syntax errors) */}
      {isLogDrawerOpen && (
        <div
          className="h-64 bg-slate-950 border-t border-slate-800 flex flex-col shrink-0 z-20"
          data-testid="compiler-log-drawer"
        >
          {/* Drawer Toolbar */}
          <div className="flex items-center justify-between px-4 py-1.5 bg-slate-900 border-b border-slate-800 text-xs">
            <div className="flex items-center gap-3">
              <span className="font-semibold text-slate-200 flex items-center gap-1.5">
                <Terminal className="w-3.5 h-3.5 text-indigo-400" />
                <span>Worker Diagnostic Logs</span>
              </span>

              <div className="flex items-center gap-1 bg-slate-950 p-0.5 rounded-md border border-slate-800">
                {(['all', 'stdout', 'stderr']).map((tabKey) => (
                  <button
                    key={tabKey}
                    type="button"
                    onClick={() => setActiveLogTab(tabKey)}
                    className={`px-2 py-0.5 rounded text-[11px] font-mono uppercase transition-colors ${
                      activeLogTab === tabKey
                        ? 'bg-indigo-600 text-white font-semibold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {tabKey}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <span className="text-[11px] font-mono text-slate-400 hidden sm:inline">
                {engineName}
              </span>
              <button
                type="button"
                onClick={() => setIsLogDrawerOpen(false)}
                className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200"
                title="Minimize compiler logs"
              >
                <ChevronDown className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Structured Syntax Error Banner (if any errors occurred) */}
          {compileErrors.length > 0 && (
            <div className="bg-rose-950/50 border-b border-rose-900/60 px-4 py-2 space-y-1 max-h-24 overflow-y-auto">
              {compileErrors.map((err, index) => (
                <div
                  key={`${err.line || 0}-${index}`}
                  className="flex items-start gap-2 text-xs text-rose-200 font-mono"
                >
                  <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold text-rose-300">
                      {err.line ? `Line ${err.line}: ` : 'Error: '}
                    </span>
                    <span>{err.message}</span>
                    {err.context && (
                      <code className="ml-2 px-1.5 py-0.5 rounded bg-rose-950 text-rose-300 border border-rose-800/60 text-[11px]">
                        {err.context}
                      </code>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Raw Monospace Transcript Output */}
          <pre className="flex-1 p-3 overflow-auto font-mono text-[11px] leading-relaxed text-slate-300 select-text whitespace-pre-wrap">
            {displayedLogContent()}
          </pre>
        </div>
      )}

      {/* Bottom Compiler Status Bar */}
      <div className="h-9 px-4 bg-slate-900/90 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400 shrink-0">
        <button
          type="button"
          onClick={() => setIsLogDrawerOpen((prev) => !prev)}
          className="flex items-center gap-2 hover:text-slate-200 transition-colors"
        >
          <Terminal className="w-3.5 h-3.5 text-indigo-400" />
          <span>Compiler Output (`stdout` / `stderr`)</span>
          {isLogDrawerOpen ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronUp className="w-3.5 h-3.5" />
          )}
        </button>

        <div className="flex items-center gap-3 font-mono text-[11px]">
          {warningCount > 0 && (
            <span className="text-amber-400">
              {warningCount} {warningCount === 1 ? 'warning' : 'warnings'}
            </span>
          )}
          {errorCount > 0 && (
            <span className="text-rose-400 font-semibold">
              {errorCount} {errorCount === 1 ? 'error' : 'errors'}
            </span>
          )}
          {compileElapsedMs !== null && (
            <span className="flex items-center gap-1 text-slate-400">
              <Clock className="w-3 h-3" />
              {compileElapsedMs} ms
            </span>
          )}
          <span
            className={
              compileStatus === 'error'
                ? 'text-rose-400'
                : compileStatus === 'success'
                ? 'text-emerald-400'
                : compileStatus === 'compiling'
                ? 'text-indigo-400'
                : 'text-slate-500'
            }
          >
            {compileStatus.toUpperCase()}
          </span>
        </div>
      </div>
    </section>
  );
}
