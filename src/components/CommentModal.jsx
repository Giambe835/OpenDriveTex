/**
 * @fileoverview In-Editor Comment Modal for adding review comments to manuscript text.
 * Displays over the editor with Google Account attribution and selected text preview.
 */

import React, { useState, useEffect, useRef } from 'react';
import { MessageSquarePlus, X, Send, CheckCircle2 } from 'lucide-react';

export default function CommentModal({
  isOpen,
  onClose,
  onSubmit,
  selectedText = '',
  user = { name: 'Google Researcher', email: '', picture: '' },
}) {
  const [commentText, setCommentText] = useState('');
  const textareaRef = useRef(null);

  useEffect(() => {
    if (isOpen) {
      setCommentText('');
      setTimeout(() => {
        textareaRef.current?.focus();
      }, 50);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = (e) => {
    if (e) e.preventDefault();
    if (!commentText.trim()) return;
    onSubmit(commentText.trim());
    onClose();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const displayName = user.name || user.email || 'Google Researcher';
  const initialLetter = displayName.charAt(0).toUpperCase();

  return (
    <div
      className="absolute inset-0 z-50 bg-slate-950/75 backdrop-blur-xs flex items-center justify-center p-4 select-none animate-in fade-in duration-150"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Add Review Comment"
      data-testid="comment-modal-backdrop"
    >
      <div
        className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col select-text"
        onClick={(e) => e.stopPropagation()}
        data-testid="comment-modal-content"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800 bg-slate-950/80">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400">
              <MessageSquarePlus className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-100">Add Review Comment</h3>
              <p className="text-[11px] text-slate-400">Attached directly to manuscript</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
            title="Close dialog (Esc)"
            data-testid="comment-modal-close-button"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-5 space-y-4">
          {/* Google Account Attribution Card */}
          <div className="flex items-center justify-between px-3.5 py-2.5 rounded-xl bg-slate-950/70 border border-slate-800 text-xs">
            <div className="flex items-center gap-2.5 min-w-0">
              {user.picture ? (
                <img
                  src={user.picture}
                  alt={displayName}
                  className="w-7 h-7 rounded-full object-cover border border-indigo-500/40 shrink-0"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="w-7 h-7 rounded-full bg-indigo-600/30 border border-indigo-500/40 text-indigo-300 font-semibold text-xs flex items-center justify-center shrink-0">
                  {initialLetter}
                </div>
              )}
              <div className="min-w-0">
                <div className="font-semibold text-slate-200 truncate text-xs">
                  {displayName}
                </div>
                {user.email && (
                  <div className="text-[10px] text-slate-400 font-mono truncate">
                    {user.email}
                  </div>
                )}
              </div>
            </div>
            <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-400 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 shrink-0">
              <CheckCircle2 className="w-2.5 h-2.5" />
              <span>Google Account</span>
            </span>
          </div>

          {/* Selected Text Preview */}
          <div className="space-y-1.5">
            <div className="text-[11px] font-medium text-slate-400 flex items-center justify-between">
              <span>Target Text:</span>
              <span className="text-[10px] text-slate-500 font-mono">
                {selectedText ? `${selectedText.length} chars` : 'Cursor line'}
              </span>
            </div>
            <div className="max-h-24 overflow-y-auto p-2.5 rounded-lg bg-amber-500/5 border-l-2 border-amber-500/70 border-r border-t border-b border-slate-800/80 text-xs text-amber-200/90 font-mono leading-relaxed break-words">
              {selectedText || (
                <span className="italic text-slate-500">
                  No text highlighted — comment will attach to the current line/cursor position.
                </span>
              )}
            </div>
          </div>

          {/* Comment Textarea */}
          <div className="space-y-1.5">
            <label htmlFor="review-comment-textarea" className="block text-xs font-medium text-slate-300">
              Comment Note:
            </label>
            <textarea
              id="review-comment-textarea"
              ref={textareaRef}
              rows={3}
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Write your review feedback, clarification request, or suggestion..."
              className="w-full px-3 py-2.5 rounded-xl bg-slate-950 border border-slate-800 focus:border-amber-500/70 focus:ring-1 focus:ring-amber-500/50 text-xs text-slate-200 placeholder-slate-500 resize-none outline-none transition-colors"
              data-testid="comment-modal-textarea"
            />
          </div>
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-slate-800 bg-slate-950/80 text-xs">
          <span className="text-[11px] text-slate-500 hidden sm:inline">
            <kbd className="px-1 py-0.5 rounded bg-slate-800 text-slate-400 font-mono text-[10px]">⌘</kbd> + <kbd className="px-1 py-0.5 rounded bg-slate-800 text-slate-400 font-mono text-[10px]">Enter</kbd> to submit
          </span>
          <div className="flex items-center gap-2 ml-auto">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
              data-testid="comment-modal-cancel-button"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!commentText.trim()}
              className="px-4 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed text-slate-950 font-semibold flex items-center gap-1.5 transition-colors cursor-pointer shadow-sm"
              data-testid="comment-modal-submit-button"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Comment</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

