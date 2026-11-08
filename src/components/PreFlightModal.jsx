/**
 * @fileoverview Pre-Flight Journal Submission Warning Modal.
 *
 * Scans for unresolved comments and tracked changes before exporting clean `.tex` or `.zip` files,
 * offering options to "Stop & Review Pending Items" or "Accept All & Download Clean".
 */

import React from 'react';
import {
  AlertTriangle,
  FileCheck2,
  X,
  FileText,
  Archive,
  ArrowRight,
  ShieldAlert,
} from 'lucide-react';

export default function PreFlightModal({
  isOpen = false,
  onClose,
  exportType = 'tex', // 'tex' | 'zip'
  counts = { comments: 0, additions: 0, deletions: 0, total: 0 },
  onStopAndReview,
  onAcceptAllAndDownload,
}) {
  if (!isOpen) return null;

  const isZip = exportType === 'zip';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="preflight-modal-title"
    >
      <div className="relative w-full max-w-lg bg-slate-900 border border-amber-500/40 rounded-2xl p-6 shadow-2xl shadow-black/70 space-y-5 text-slate-200">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-amber-500/15 text-amber-400 border border-amber-500/30">
              <ShieldAlert className="w-6 h-6" />
            </div>
            <div>
              <h3
                id="preflight-modal-title"
                className="text-base font-bold text-slate-100 tracking-tight"
              >
                Pre-Flight Submission Check
              </h3>
              <p className="text-xs text-amber-300/90 font-medium mt-0.5">
                Pending Review Items Detected
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Warning Body */}
        <div className="space-y-3 text-xs leading-relaxed text-slate-300">
          <p>
            Before preparing your manuscript for <strong>journal submission</strong> (
            {isZip ? 'Clean Project .zip' : 'Clean .tex'}
            ), we detected unreviewed items in your project:
          </p>

          {/* Counts Grid */}
          <div className="grid grid-cols-3 gap-2.5 py-1">
            <div className="p-2.5 rounded-xl bg-slate-950/70 border border-amber-500/30 text-center">
              <span className="text-lg font-bold text-amber-300">{counts.comments}</span>
              <div className="text-[11px] font-semibold text-slate-400 mt-0.5">Comments</div>
            </div>
            <div className="p-2.5 rounded-xl bg-slate-950/70 border border-emerald-500/30 text-center">
              <span className="text-lg font-bold text-emerald-400">+{counts.additions}</span>
              <div className="text-[11px] font-semibold text-slate-400 mt-0.5">Additions</div>
            </div>
            <div className="p-2.5 rounded-xl bg-slate-950/70 border border-rose-500/30 text-center">
              <span className="text-lg font-bold text-rose-400">-{counts.deletions}</span>
              <div className="text-[11px] font-semibold text-slate-400 mt-0.5">Deletions</div>
            </div>
          </div>

          <p className="text-[11px] text-slate-400 italic">
            Publishers (Elsevier, IEEE, Springer, Nature) require clean manuscripts without internal
            editorial review tags (<code className="text-slate-300 font-mono">\odtcomment</code>,{' '}
            <code className="text-slate-300 font-mono">\odtadd</code>,{' '}
            <code className="text-slate-300 font-mono">\odtdel</code>).
          </p>
        </div>

        {/* Action Buttons */}
        <div className="space-y-2 pt-1">
          <button
            type="button"
            onClick={onAcceptAllAndDownload}
            className="w-full py-2.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white font-semibold text-xs flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/30 transition-all cursor-pointer"
          >
            <FileCheck2 className="w-4 h-4 text-emerald-300" />
            <span>Accept All & Download Clean {isZip ? '.zip' : '.tex'}</span>
            <ArrowRight className="w-3.5 h-3.5 ml-auto opacity-75" />
          </button>

          <button
            type="button"
            onClick={onStopAndReview}
            className="w-full py-2 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer"
          >
            <span>Stop & Review Pending Items</span>
          </button>
        </div>
      </div>
    </div>
  );
}

