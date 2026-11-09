/**
 * @fileoverview Top Navigation Bar component for OpenDriveTeX.
 * Displays brand identity, clean active project folder name, "Open from Drive"
 * button, connected collaborator pills powered by Yjs Awareness,
 * PDF pane visibility toggle, Google Drive manual Save (`Ctrl+S`), and Compile (`Ctrl+Enter`).
 */

import React, { useEffect, useState } from 'react';
import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Users,
  FolderOpen,
  FolderSearch,
  Play,
  Loader2,
  CloudUpload,
  CheckCircle2,
  Crown,
  Download,
  ChevronDown,
  FileText,
  Archive,
} from 'lucide-react';
import { electSaveLeader } from '../services/collabService';

/**
 * Top bar displaying brand identity, active project name, unified Open from Drive button,
 * Yjs Awareness peer badges, PDF toggle, and Drive/Compilation action controls.
 */
export default function Navbar({
  collabSession,
  isSidebarOpen,
  onToggleSidebar,
  isPdfVisible = true,
  onTogglePdfVisible,
  onCompile,
  isCompiling = false,
  isDriveAuthenticated = false,
  driveFileId = null,
  driveFolderId = null,
  driveFolderName = '',
  driveSaveStatus = 'idle',
  onManualSaveToDrive,
  onOpenFromDrive,
  onExportSubmissionTex,
  onExportSubmissionZip,
  onExportPdf,
}) {
  const [peers, setPeers] = useState([]);
  const [leaderClientId, setLeaderClientId] = useState(null);
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const exportMenuRef = React.useRef(null);

  // Close export menu on outside click
  useEffect(() => {
    const handleOutsideClick = (e) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target)) {
        setIsExportMenuOpen(false);
      }
    };
    if (isExportMenuOpen) {
      document.addEventListener('mousedown', handleOutsideClick);
    }
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
    };
  }, [isExportMenuOpen]);

  useEffect(() => {
    if (!collabSession) {
      setPeers([]);
      setLeaderClientId(null);
      return undefined;
    }

    const { awareness, ydoc } = collabSession;

    /**
     * Reads all active states from Yjs Awareness, evaluates Save Leader Election,
     * and transforms states into a sorted array of peer badge objects.
     */
    const syncAwarenessPeers = () => {
      const statesMap = awareness.getStates();
      const election = electSaveLeader(awareness, ydoc.clientID);
      setLeaderClientId(election.leaderClientId);

      const activePeers = [];

      statesMap.forEach((state, clientId) => {
        if (state && state.user) {
          activePeers.push({
            clientId,
            isLocal: clientId === ydoc.clientID,
            isLeader: clientId === election.leaderClientId,
            hasDriveToken: Boolean(state.user.hasDriveToken),
            name: state.user.name || `Collaborator #${clientId}`,
            email: state.user.email || '',
            picture: state.user.picture || '',
            color: state.user.color || '#6366f1',
            colorLight: state.user.colorLight || 'rgba(99, 102, 241, 0.25)',
            joinedAt: state.user.joinedAt || 0,
          });
        }
      });

      activePeers.sort((a, b) => {
        if (a.isLocal) return -1;
        if (b.isLocal) return 1;
        return a.clientId - b.clientId;
      });

      setPeers(activePeers);
    };

    syncAwarenessPeers();
    awareness.on('change', syncAwarenessPeers);

    return () => {
      awareness.off('change', syncAwarenessPeers);
    };
  }, [collabSession]);

  const cleanFolderLabel =
    driveFolderName && driveFolderName !== collabSession?.roomName
      ? driveFolderName
      : collabSession?.projectMeta?.get('folderName') ||
        collabSession?.projectMeta?.get('mainTexFileName') ||
        'Active Project';

  return (
    <header className="h-14 bg-slate-900/95 border-b border-slate-800 px-3 sm:px-4 flex items-center justify-between gap-2 sm:gap-3 select-none shrink-0 z-20">
      {/* Left Section: Sidebar Toggle, Brand Logo & Clean Project Folder Name */}
      <div className="flex items-center gap-2.5 min-w-0">
        <button
          type="button"
          onClick={onToggleSidebar}
          className="p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800/80 transition-colors cursor-pointer"
          title={isSidebarOpen ? 'Collapse project sidebar' : 'Expand project sidebar'}
          aria-label="Toggle project sidebar"
        >
          {isSidebarOpen ? (
            <PanelLeftClose className="w-4 h-4" />
          ) : (
            <PanelLeftOpen className="w-4 h-4" />
          )}
        </button>

        {/* Application Brand with Official SVG Icon */}
        <div className="flex items-center gap-2.5 pr-3 border-r border-slate-800">
          <img
            src="/icon.svg"
            alt="OpenDriveTeX"
            className="w-8 h-8 rounded-lg shadow-sm shrink-0"
          />
          <div className="hidden sm:flex flex-col">
            <span className="font-semibold text-sm text-slate-100 tracking-tight leading-tight">
              OpenDriveTeX
            </span>
            <span className="text-[11px] text-slate-400 leading-none mt-0.5">
              Collaborative LaTeX Editor
            </span>
          </div>
        </div>

        {/* Active Project Folder Name (Clean name only — no raw Drive ID hash) */}
        {collabSession ? (
          <div className="flex items-center gap-1.5 bg-slate-950/80 border border-slate-800 rounded-lg px-2.5 py-1.5">
            <FolderOpen className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
            <span
              className="text-xs font-medium text-slate-200 truncate max-w-[140px] sm:max-w-[200px]"
              data-testid="active-project-name"
            >
              {cleanFolderLabel}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 bg-slate-950/80 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-400">
            <span>No Project Loaded</span>
          </div>
        )}

        {/* "Open from Drive" Button */}
        {isDriveAuthenticated && onOpenFromDrive && (
          <div className="hidden md:flex items-center">
            <button
              type="button"
              onClick={onOpenFromDrive}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-slate-800/90 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors cursor-pointer"
              title="Open a project folder or .tex file from Google Drive"
              data-testid="open-from-drive-button"
            >
              <FolderSearch className="w-3.5 h-3.5 text-indigo-400" />
              <span>Open from Drive</span>
            </button>
          </div>
        )}
      </div>

      {/* Right Section: Connected Peers, PDF Toggle, Save to Drive (`Ctrl+S`) & Compile (`Ctrl+Enter`) */}
      <div className="flex items-center gap-2 sm:gap-2.5">
        {collabSession && (
          <div
            className="flex items-center gap-2 bg-slate-950/80 border border-slate-800 rounded-lg px-2.5 py-1"
            aria-label="Connected Peers"
          >
            <div className="flex items-center gap-1.5 pr-2 border-r border-slate-800">
              <Users className="w-3.5 h-3.5 text-slate-400" />
              <span className="text-xs font-semibold text-slate-200" data-testid="peer-count">
                {peers.length} {peers.length === 1 ? 'Peer' : 'Peers'}
              </span>
            </div>

            {/* Colored User Badges from Yjs Awareness */}
            <div className="flex items-center gap-1.5 overflow-x-auto max-w-[150px] sm:max-w-[260px] py-0.5">
              {peers.map((peer) => {
                const isElectedLeader = peer.clientId === leaderClientId;
                return (
                  <span
                    key={peer.clientId}
                    className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border transition-transform hover:scale-105 shrink-0"
                    style={{
                      backgroundColor: peer.colorLight,
                      borderColor: peer.color,
                      color: '#f8fafc',
                    }}
                    title={`${peer.name}${peer.email ? ` (${peer.email})` : ''}${
                      peer.isLocal ? ' [You]' : ''
                    }`}
                  >
                    {peer.picture ? (
                      <img
                        src={peer.picture}
                        alt=""
                        referrerPolicy="no-referrer"
                        className="w-3.5 h-3.5 rounded-full object-cover shrink-0"
                      />
                    ) : (
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: peer.color }}
                      />
                    )}
                    {isElectedLeader && (
                      <Crown
                        className="w-3 h-3 text-amber-300 shrink-0"
                        aria-label="Active Sync Host"
                      />
                    )}
                    <span className="truncate max-w-[110px]">{peer.name}</span>
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {/* Action Buttons: Hide/Show PDF, Save to Drive (`Ctrl+S`) & Compile (`Ctrl+Enter`) */}
        <div className="flex items-center gap-2">
          {collabSession && onTogglePdfVisible && (
            <button
              type="button"
              onClick={onTogglePdfVisible}
              className="hidden lg:inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-slate-800/80 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors cursor-pointer"
              title={isPdfVisible ? 'Hide PDF Preview Pane' : 'Show PDF Preview Pane'}
              data-testid="navbar-toggle-pdf-button"
            >
              {isPdfVisible ? (
                <>
                  <PanelRightClose className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Hide PDF</span>
                </>
              ) : (
                <>
                  <PanelRightOpen className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Show PDF</span>
                </>
              )}
            </button>
          )}

          <button
            type="button"
            onClick={onManualSaveToDrive}
            disabled={
              (!isDriveAuthenticated && !leaderClientId) ||
              !collabSession ||
              driveSaveStatus === 'saving'
            }
            className={`hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
              (!isDriveAuthenticated && !leaderClientId) || !collabSession
                ? 'bg-slate-800/60 text-slate-400 border-slate-700/60 cursor-not-allowed opacity-75'
                : driveSaveStatus === 'saving'
                ? 'bg-sky-600/40 text-sky-200 border-sky-500/40 cursor-wait'
                : driveSaveStatus === 'saved'
                ? 'bg-emerald-600/20 text-emerald-200 border-emerald-500/40 hover:bg-emerald-600/30 cursor-pointer'
                : 'bg-sky-600/25 hover:bg-sky-600/35 text-sky-100 border-sky-500/40 cursor-pointer'
            }`}
            title={
              (isDriveAuthenticated || leaderClientId) && collabSession
                ? 'Save changes immediately to Google Drive (Ctrl+S)'
                : 'Open a Google Drive project folder first to enable cloud saving'
            }
            data-testid="save-drive-button"
          >
            {driveSaveStatus === 'saving' ? (
              <>
                <Loader2 className="w-3.5 h-3.5 text-sky-300 animate-spin" />
                <span>Saving...</span>
              </>
            ) : driveSaveStatus === 'saved' ? (
              <>
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                <span>Saved</span>
                <kbd className="hidden xl:inline-block ml-1 px-1 py-0.5 text-[10px] font-mono bg-slate-900/80 text-emerald-300 rounded border border-emerald-500/30">
                  Ctrl+S
                </kbd>
              </>
            ) : (
              <>
                <CloudUpload className="w-3.5 h-3.5 text-sky-400" />
                <span>{driveFileId ? 'Save to Drive' : 'Save in Drive'}</span>
                <kbd className="hidden xl:inline-block ml-1 px-1 py-0.5 text-[10px] font-mono bg-slate-900/80 text-sky-300 rounded border border-sky-500/30">
                  Ctrl+S
                </kbd>
              </>
            )}
          </button>

          {/* Export for Submission Dropdown */}
          <div className="relative" ref={exportMenuRef}>
            <button
              type="button"
              onClick={() => setIsExportMenuOpen((prev) => !prev)}
              disabled={!collabSession}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                !collabSession
                  ? 'bg-slate-800/60 text-slate-500 border-slate-700/60 cursor-not-allowed'
                  : isExportMenuOpen
                  ? 'bg-slate-800 text-white border-slate-600 shadow-sm cursor-pointer'
                  : 'bg-slate-800/80 hover:bg-slate-700 text-slate-200 border-slate-700 cursor-pointer'
              }`}
              title="Export clean manuscript or project for journal submission"
              data-testid="export-submission-dropdown"
            >
              <Download className="w-3.5 h-3.5 text-indigo-400" />
              <span className="hidden sm:inline">Export</span>
              <ChevronDown className="w-3 h-3 text-slate-400" />
            </button>

            {isExportMenuOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-64 rounded-xl bg-slate-900 border border-slate-800 shadow-2xl p-1.5 z-50 text-xs space-y-1 animate-fade-in">
                <div className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  Journal Submission
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setIsExportMenuOpen(false);
                    onExportSubmissionTex && onExportSubmissionTex();
                  }}
                  className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-slate-800 flex items-center gap-2.5 text-slate-200 transition-colors cursor-pointer"
                >
                  <FileText className="w-4 h-4 text-emerald-400 shrink-0" />
                  <div>
                    <div className="font-semibold text-slate-100">Clean .tex File</div>
                    <div className="text-[10px] text-slate-400">
                      Current file without review tags
                    </div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsExportMenuOpen(false);
                    onExportSubmissionZip && onExportSubmissionZip();
                  }}
                  className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-slate-800 flex items-center gap-2.5 text-slate-200 transition-colors cursor-pointer"
                >
                  <Archive className="w-4 h-4 text-indigo-400 shrink-0" />
                  <div>
                    <div className="font-semibold text-slate-100">Clean Project .zip</div>
                    <div className="text-[10px] text-slate-400">
                      All figures, bib & sanitized .tex
                    </div>
                  </div>
                </button>
                <div className="h-px bg-slate-800 my-1" />
                <button
                  type="button"
                  onClick={() => {
                    setIsExportMenuOpen(false);
                    onExportPdf && onExportPdf();
                  }}
                  className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-slate-800 flex items-center gap-2.5 text-slate-200 transition-colors cursor-pointer"
                >
                  <Download className="w-4 h-4 text-cyan-400 shrink-0" />
                  <div>
                    <div className="font-semibold text-slate-100">Compiled PDF</div>
                    <div className="text-[10px] text-slate-400">Download current PDF build</div>
                  </div>
                </button>
              </div>
            )}
          </div>

          {/* Compile LaTeX via Web Worker */}
          <button
            type="button"
            onClick={onCompile}
            disabled={isCompiling || !collabSession}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
              !collabSession
                ? 'bg-slate-800/60 text-slate-500 border-slate-700/60 cursor-not-allowed'
                : isCompiling
                ? 'bg-indigo-600/60 text-indigo-100 border-indigo-400/50 cursor-wait'
                : 'bg-indigo-600 hover:bg-indigo-500 active:scale-[0.98] text-white border-indigo-500 shadow-md shadow-indigo-600/20 cursor-pointer'
            }`}
            title="Compile LaTeX document (Ctrl+Enter)"
            data-testid="compile-button"
          >
            {isCompiling ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Compiling...</span>
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>Compile</span>
                <kbd className="hidden xl:inline-block ml-1 px-1 py-0.5 text-[10px] font-mono bg-indigo-950/80 text-indigo-200 rounded border border-indigo-400/30">
                  Ctrl+↵
                </kbd>
              </>
            )}
          </button>
        </div>
      </div>
    </header>
  );
}
