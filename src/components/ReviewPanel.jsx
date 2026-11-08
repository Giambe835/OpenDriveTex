/**
 * @fileoverview Collapsible "Review & Comments" Side Panel.
 *
 * Displays all active comments, additions, and deletions with author metadata,
 * jump-to-location in CodeMirror, Accept/Reject/Resolve actions, and Track Changes toggle.
 */

import React, { useState } from 'react';
import {
  MessageSquare,
  PlusCircle,
  MinusCircle,
  Check,
  X,
  RotateCcw,
  Sparkles,
  ChevronRight,
  Filter,
} from 'lucide-react';
import { reviewActionAnnotation } from '../extensions/reviewExtension';

/**
 * Formats a timestamp into a friendly human-readable date/time string.
 */
function formatTime(timestamp) {
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

export default function ReviewPanel({
  isOpen = false,
  onClose,
  items = [],
  editorView,
  isTrackingChanges = false,
  onToggleTrackChanges,
  onJumpToItem,
}) {
  const [filterType, setFilterType] = useState('all'); // 'all' | 'comment' | 'add' | 'del'

  if (!isOpen) return null;

  const filteredItems = items.filter((item) => {
    if (filterType === 'all') return true;
    return item.type === filterType;
  });

  const commentCount = items.filter((i) => i.type === 'comment').length;
  const addCount = items.filter((i) => i.type === 'add').length;
  const delCount = items.filter((i) => i.type === 'del').length;

  const handleResolveComment = (item, e) => {
    e.stopPropagation();
    if (!editorView) return;
    editorView.dispatch({
      changes: {
        from: item.fullFrom,
        to: item.fullTo,
        insert: item.content,
      },
      annotations: [reviewActionAnnotation.of(true)],
    });
    editorView.focus();
  };

  const handleAcceptAddition = (item, e) => {
    e.stopPropagation();
    if (!editorView) return;
    editorView.dispatch({
      changes: {
        from: item.fullFrom,
        to: item.fullTo,
        insert: item.content,
      },
      annotations: [reviewActionAnnotation.of(true)],
    });
    editorView.focus();
  };

  const handleRejectAddition = (item, e) => {
    e.stopPropagation();
    if (!editorView) return;
    editorView.dispatch({
      changes: {
        from: item.fullFrom,
        to: item.fullTo,
        insert: '',
      },
      annotations: [reviewActionAnnotation.of(true)],
    });
    editorView.focus();
  };

  const handleAcceptDeletion = (item, e) => {
    e.stopPropagation();
    if (!editorView) return;
    editorView.dispatch({
      changes: {
        from: item.fullFrom,
        to: item.fullTo,
        insert: '',
      },
      annotations: [reviewActionAnnotation.of(true)],
    });
    editorView.focus();
  };

  const handleRestoreDeletion = (item, e) => {
    e.stopPropagation();
    if (!editorView) return;
    editorView.dispatch({
      changes: {
        from: item.fullFrom,
        to: item.fullTo,
        insert: item.content,
      },
      annotations: [reviewActionAnnotation.of(true)],
    });
    editorView.focus();
  };

  const handleAcceptAllInEditor = () => {
    if (!editorView || items.length === 0) return;
    const sorted = [...items].sort((a, b) => b.fullFrom - a.fullFrom);
    const changes = sorted.map((item) => {
      let insert = '';
      if (item.type === 'comment' || item.type === 'add') {
        insert = item.content;
      } else if (item.type === 'del') {
        insert = '';
      }
      return {
        from: item.fullFrom,
        to: item.fullTo,
        insert,
      };
    });
    editorView.dispatch({
      changes,
      annotations: [reviewActionAnnotation.of(true)],
    });
    editorView.focus();
  };

  return (
    <aside
      className="w-80 h-full bg-slate-900/95 border-l border-slate-800 flex flex-col shrink-0 text-slate-200 select-none shadow-xl z-20"
      aria-label="Review and Comments Panel"
    >
      {/* Header */}
      <div className="p-3.5 border-b border-slate-800 flex items-center justify-between gap-2 shrink-0 bg-slate-950/40">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-indigo-400" />
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-100">
            Review & Comments
          </h2>
          <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
            {items.length}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
          title="Close review panel"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {/* Track Changes Switch Bar */}
      <div className="p-3 border-b border-slate-800/80 bg-slate-950/60 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5 text-amber-400" />
          <span className="text-xs font-semibold text-slate-200">Track Changes</span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={isTrackingChanges}
          onClick={onToggleTrackChanges}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
            isTrackingChanges ? 'bg-indigo-600' : 'bg-slate-700'
          }`}
        >
          <span
            className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${
              isTrackingChanges ? 'translate-x-4' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      {/* Filter Tabs */}
      <div className="p-2 border-b border-slate-800/80 flex items-center justify-between gap-1 text-[11px] bg-slate-900/60">
        <div className="flex items-center gap-1 overflow-x-auto">
          <button
            type="button"
            onClick={() => setFilterType('all')}
            className={`px-2 py-1 rounded font-medium transition-colors cursor-pointer ${
              filterType === 'all'
                ? 'bg-indigo-600 text-white'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            All ({items.length})
          </button>
          <button
            type="button"
            onClick={() => setFilterType('comment')}
            className={`px-2 py-1 rounded font-medium transition-colors cursor-pointer ${
              filterType === 'comment'
                ? 'bg-amber-600 text-white'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            💬 {commentCount}
          </button>
          <button
            type="button"
            onClick={() => setFilterType('add')}
            className={`px-2 py-1 rounded font-medium transition-colors cursor-pointer ${
              filterType === 'add'
                ? 'bg-emerald-600 text-white'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            ➕ {addCount}
          </button>
          <button
            type="button"
            onClick={() => setFilterType('del')}
            className={`px-2 py-1 rounded font-medium transition-colors cursor-pointer ${
              filterType === 'del'
                ? 'bg-rose-600 text-white'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            ➖ {delCount}
          </button>
        </div>

        {items.length > 0 && (
          <button
            type="button"
            onClick={handleAcceptAllInEditor}
            className="text-[10px] text-indigo-400 hover:text-indigo-300 font-semibold underline underline-offset-2 shrink-0 cursor-pointer"
            title="Accept all pending review items in document"
          >
            Accept All
          </button>
        )}
      </div>

      {/* Review Items List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
        {filteredItems.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-500">
            <MessageSquare className="w-8 h-8 mb-2 stroke-1 opacity-50" />
            <p className="text-xs font-medium text-slate-400">No review items found</p>
            <p className="text-[11px] text-slate-500 mt-1">
              Select text and click &ldquo;Add Comment&rdquo; or enable Track Changes to record edits.
            </p>
          </div>
        ) : (
          filteredItems.map((item) => (
            <div
              key={item.id}
              onClick={() => onJumpToItem && onJumpToItem(item)}
              className="p-2.5 rounded-lg bg-slate-950/60 hover:bg-slate-800/60 border border-slate-800/80 hover:border-slate-700 transition-all cursor-pointer group space-y-2 shadow-sm"
            >
              {/* Card Header */}
              <div className="flex items-center justify-between text-[11px] gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  {item.type === 'comment' && (
                    <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-semibold text-[10px]">
                      <MessageSquare className="w-2.5 h-2.5" /> Comment
                    </span>
                  )}
                  {item.type === 'add' && (
                    <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-semibold text-[10px]">
                      <PlusCircle className="w-2.5 h-2.5" /> Addition
                    </span>
                  )}
                  {item.type === 'del' && (
                    <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 font-semibold text-[10px]">
                      <MinusCircle className="w-2.5 h-2.5" /> Deletion
                    </span>
                  )}
                  <span className="font-semibold text-slate-200 truncate">{item.author}</span>
                </div>
                <span className="text-[10px] text-slate-500 shrink-0">
                  {formatTime(item.timestamp)}
                </span>
              </div>

              {/* Card Body */}
              {item.type === 'comment' && (
                <div className="space-y-1 text-xs">
                  <div className="text-amber-200/90 font-medium bg-amber-950/30 p-1.5 rounded border border-amber-900/40">
                    {item.comment}
                  </div>
                  <div className="text-[11px] text-slate-400 italic line-clamp-2 pl-1 border-l-2 border-slate-700">
                    &ldquo;{item.content}&rdquo;
                  </div>
                </div>
              )}

              {item.type === 'add' && (
                <div className="text-xs text-emerald-300/90 bg-emerald-950/25 p-1.5 rounded border border-emerald-900/30 line-clamp-3 font-mono">
                  +{item.content}
                </div>
              )}

              {item.type === 'del' && (
                <div className="text-xs text-rose-300/90 bg-rose-950/25 p-1.5 rounded border border-rose-900/30 line-clamp-3 font-mono line-through">
                  -{item.content}
                </div>
              )}

              {/* Card Actions */}
              <div className="flex items-center justify-end gap-1.5 pt-1">
                {item.type === 'comment' && (
                  <button
                    type="button"
                    onClick={(e) => handleResolveComment(item, e)}
                    className="px-2 py-0.5 rounded text-[11px] font-semibold bg-indigo-600 hover:bg-indigo-500 text-white flex items-center gap-1 transition-colors cursor-pointer"
                  >
                    <Check className="w-3 h-3" /> Resolve
                  </button>
                )}

                {item.type === 'add' && (
                  <>
                    <button
                      type="button"
                      onClick={(e) => handleAcceptAddition(item, e)}
                      className="px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-600 hover:bg-emerald-500 text-white flex items-center gap-1 transition-colors cursor-pointer"
                      title="Accept addition and keep text"
                    >
                      <Check className="w-3 h-3" /> Accept
                    </button>
                    <button
                      type="button"
                      onClick={(e) => handleRejectAddition(item, e)}
                      className="px-2 py-0.5 rounded text-[11px] font-semibold bg-slate-800 hover:bg-rose-900/60 text-slate-300 hover:text-rose-200 border border-slate-700 flex items-center gap-1 transition-colors cursor-pointer"
                      title="Reject and discard addition"
                    >
                      <X className="w-3 h-3" /> Reject
                    </button>
                  </>
                )}

                {item.type === 'del' && (
                  <>
                    <button
                      type="button"
                      onClick={(e) => handleAcceptDeletion(item, e)}
                      className="px-2 py-0.5 rounded text-[11px] font-semibold bg-rose-600 hover:bg-rose-500 text-white flex items-center gap-1 transition-colors cursor-pointer"
                      title="Accept deletion and remove text"
                    >
                      <Check className="w-3 h-3" /> Accept
                    </button>
                    <button
                      type="button"
                      onClick={(e) => handleRestoreDeletion(item, e)}
                      className="px-2 py-0.5 rounded text-[11px] font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 flex items-center gap-1 transition-colors cursor-pointer"
                      title="Restore deleted text"
                    >
                      <RotateCcw className="w-3 h-3" /> Restore
                    </button>
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

